// DeepVariant's steps, as the worker (worker.mjs) runs them. The caller loads Pyodide, puts pysite/ at
// /pysite and the inputs into Pyodide's filesystem.

// Python packages DeepVariant imports that aren't part of the Pyodide core
const PY_DEPS = ["absl-py", "ml_collections", "six", "etils", "intervaltree", "typing-extensions"];

// Python packages from Pyodide's distribution and PyPI. Pillow: Nucleus' vis.py (imported by call_variants,
// used by show_examples) draws the pileup images with it.
export async function installPackages(py) {
	await py.loadPackage(["protobuf", "numpy", "pillow", "micropip"], { messageCallback: () => {} });
	await py.runPythonAsync(`import micropip; await micropip.install(${JSON.stringify(PY_DEPS)})`);
}

// DeepVariant's Python and C++ module (pysite/ must be at /pysite)
export function importDeepVariant(py) {
	py.runPython(`
import sys; sys.path.insert(0, "/pysite")
import dv_bootstrap
from absl import logging
logging.use_python_logging()
`);
	py.globals.set("_dv_inspect_src", INSPECT_PY);
	py.runPython(`
import sys, types
_m = types.ModuleType("dv_inspect")
exec(_dv_inspect_src, _m.__dict__)
sys.modules["dv_inspect"] = _m
`);
}

// For the page's "why is there no call here?": what DeepVariant counted at a position, and how to make it
// consider a candidate anyway. Python, loaded as the module dv_inspect.
//   watch(chrom, pos): the next make_examples records the allele counts (of the reads as DeepVariant used them:
//     after realignment) at pos ± 10 bp, with the candidate thresholds in force; counts() returns them
//   write_proposed(path, ref, records): a bgzipped, tabix-indexed VCF of [chrom, pos, ref, alt] records, for
//     make_examples --variant_caller=vcf_candidate_importer --proposed_variants
const INSPECT_PY = `
from deepvariant import very_sensitive_caller, vcf_candidate_importer
from deepvariant.protos import deepvariant_pb2

_watch = None
_seen = None
FLANK = 10

def watch(chrom=None, pos=None):
  global _watch, _seen
  _watch = (chrom, pos) if chrom else None
  _seen = None

def _record(caller, allele_counters, sample_name):
  global _seen
  if _watch is None or _seen is not None:
    return
  chrom, pos = _watch
  rows = []
  for c in allele_counters[sample_name].counts():
    p = c.position.position + 1
    if c.position.reference_name != chrom or abs(p - pos) > FLANK:
      continue
    alleles = {}
    for a in c.read_alleles.values():
      if a.is_low_quality or a.type in (deepvariant_pb2.REFERENCE, deepvariant_pb2.UNSPECIFIED):
        continue
      key = (deepvariant_pb2.AlleleType.Name(a.type), a.bases)
      alleles[key] = alleles.get(key, 0) + a.count
    rows.append({
        "pos": p, "ref": c.ref_base, "refCount": c.ref_supporting_read_count,
        "alleles": [{"type": t, "bases": b, "count": n} for (t, b), n in sorted(alleles.items(), key=lambda kv: -kv[1])],
    })
  if not rows:
    return
  o = caller.options
  _seen = {
      "rows": rows,
      "thresholds": {
          "minCountSnps": o.min_count_snps, "minCountIndels": o.min_count_indels,
          "minFractionSnps": o.min_fraction_snps, "minFractionIndels": o.min_fraction_indels,
      },
  }

def _wrap(cls):
  original = cls.get_candidates
  def get_candidates(self, allele_counters, sample_name, sample_role=""):
    try:
      _record(self, allele_counters, sample_name)
    except Exception as e:  # never break a run over this
      print(f"dv_inspect: couldn't read the allele counts: {e!r}")
    return original(self, allele_counters, sample_name, sample_role)
  cls.get_candidates = get_candidates
_wrap(very_sensitive_caller.VerySensitiveCaller)
_wrap(vcf_candidate_importer.VcfCandidateImporter)

def counts():
  return _seen

def write_proposed(path, ref, records):
  from third_party.nucleus.io import fasta, tabix, vcf
  from third_party.nucleus.protos import variants_pb2
  from third_party.nucleus.util import ranges
  with fasta.IndexedFastaReader(ref) as reader:
    contigs = list(reader.header.contigs)
    # DeepVariant aborts on a record whose REF isn't the reference's
    for chrom, pos, ref_bases, alt in records:
      there = reader.query(ranges.make_range(chrom, pos - 1, pos - 1 + len(ref_bases))).upper()
      if there != ref_bases.upper():
        raise ValueError(f"Can't force {ref_bases}>{alt} at {chrom}:{pos}: the reference there is {there}, not {ref_bases}.")
  header = variants_pb2.VcfHeader(fileformat="VCFv4.2", contigs=contigs)
  with vcf.VcfWriter(path, header=header) as writer:
    for chrom, pos, ref_bases, alt in sorted(records, key=lambda r: r[1]):
      writer.write(variants_pb2.Variant(
          reference_name=chrom, start=pos - 1, end=pos - 1 + len(ref_bases),
          reference_bases=ref_bases, alternate_bases=[alt]))
  tabix.build_index(path)
`;

// Allele counts recorded by the last make_examples (see INSPECT_PY), or null
export const watchPosition = (py, chrom, pos) =>
	py.runPython(`import dv_inspect; dv_inspect.watch(${chrom ? `${JSON.stringify(chrom)}, ${Number(pos)}` : ""})`);
export function alleleCounts(py) {
	const seen = py.runPython("import dv_inspect; dv_inspect.counts()");
	return seen ? seen.toJs({ dict_converter: Object.fromEntries }) : null;
}
export function writeProposed(py, path, ref, records) {
	py.globals.set("_proposed", py.toPy(records.map((r) => [r.chrom, r.pos, r.ref, r.alt])));
	py.runPython(`import dv_inspect; dv_inspect.write_proposed(${JSON.stringify(path)}, ${JSON.stringify(ref)}, _proposed)`);
}

// Extra flags for verbose output: DEBUG/vlog messages and a progress line every 10 candidates
// (the default is every 2,000, so tutorial-sized regions print none).
const VERBOSE = ["--logging_level", "DEBUG", "--verbosity", "3"];

// Runs one DeepVariant tool with the given command-line arguments; in verbose mode, prints the command first
function runTool(py, tool, argv, { verbose = false, log = () => {} } = {}) {
	if (verbose) log(`$ ${tool} ${argv.map((a) => (/[\s,]/.test(a) ? `"${a}"` : a)).join(" ")}`);
	py.globals.set("argv", py.toPy(argv));
	py.runPython(`import dv_browser; dv_browser.run_tool("deepvariant.${tool}", argv)`);
}

// 1. make_examples: candidates → small model calls (CVOs) + pileup images for the CNN.
// The model's own flags (pileup size, realignment, phasing, small model thresholds, ...) come from
// <checkpoint dir>/model.example_info.json, as with run_deepvariant since 1.10.
// smallModel: the small model's path, for models that have one (WGS, PacBio, ONT)
// phaseReads: also output phasing (PacBio and ONT, as run_deepvariant does)
// pangenome: pangenome-aware DeepVariant (make_examples_pangenome_aware_dv): a BAM of pangenome haplotypes
//   aligned to the reference, which it reads like the GBZ run_pangenome_aware_deepvariant uses
//   (see README: "Pangenome-aware DeepVariant")
// phasedReads: a path prefix: also write the reads with DeepVariant's own phasing, which it sorts the pileup
//   rows by (long-read models; --output_local_read_phasing), to <phasedReads>-00000-of-00001.bam
// proposed: a VCF (writeProposed) of the only candidates to consider, instead of finding them in the reads:
//   --variant_caller=vcf_candidate_importer, DeepVariant's own way to genotype given alleles
// extraFlags: more make_examples flags (e.g. --runtime_by_region for timings)
// realignerDir: also write the reads after local realignment (what the pileup images are made from), one
// BAM per ~1 kb window: <realignerDir>/<window>/realigned_reads.bam. Only short-read models realign.
export function makeExamples(
	py,
	{
		ref,
		reads,
		regions,
		checkpoint,
		smallModel,
		phaseReads,
		pangenome,
		out,
		phasedReads,
		realignerDir,
		verbose,
		log,
		extraFlags,
		proposed
	}
) {
	const argv = [
		"--mode",
		"calling",
		"--ref",
		ref,
		"--reads",
		reads,
		...(pangenome ? ["--pangenome", pangenome, "--sample_name_pangenome", "hprc_v1.1"] : []),
		"--examples",
		`${out}/make_examples.tfrecord@1.gz`,
		"--task",
		"0",
		"--checkpoint",
		checkpoint,
		// Without a small model path, every candidate goes to the CNN (the command line wins over the model's flags)
		...(smallModel ? ["--trained_small_model_path", smallModel] : ["--call_small_model_examples=false"]),
		...(proposed ? ["--variant_caller", "vcf_candidate_importer", "--proposed_variants", proposed] : []),
		...(phaseReads ? ["--output_phase_info"] : []),
		...(phasedReads ? ["--output_local_read_phasing", `${phasedReads}@1.bam`] : []),
		"--regions",
		regions,
		// DeepVariant's default 128 MB read buffer would make each BAM seek download up to 128 MB
		// over range requests; 0 keeps htslib's own small buffer.
		"--hts_block_size",
		"0",
		...(realignerDir ? ["--realigner_diagnostics", realignerDir, "--emit_realigned_reads"] : []),
		...(verbose ? [...VERBOSE, "--logging_every_n_candidates", "10"] : []),
		...(extraFlags ?? [])
	];
	runTool(py, pangenome ? "make_examples_pangenome_aware_dv" : "make_examples", argv, { verbose, log });
}

// 2. call_variants: the CNN (onnxruntime-web) on every pileup image, written as DeepVariant's
// CallVariantsOutput records. Returns the number of examples.
export async function callVariants(py, session, ort, { out, batchSize = 8, log = () => {} }) {
	const [images, meta] = py
		.runPython(
			`
import dv_browser
images, meta = dv_browser.read_examples("${out}/make_examples.tfrecord-00000-of-00001.gz")
images, meta`
		)
		.toJs({ depth: 1 });
	const u8 = images.getBuffer("u8").data,
		[n, h, w, c] = images.shape,
		per = h * w * c;
	images.destroy();
	const probs = new Float32Array(n * 3);
	for (let i = 0; i < n; i += batchSize) {
		const m = Math.min(batchSize, n - i),
			x = new Float32Array(m * per);
		for (let j = 0; j < m * per; j++) x[j] = (u8[i * per + j] - 128) / 128; // dv_utils.preprocess_images
		const r = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", x, [m, h, w, c]) });
		probs.set(r[session.outputNames[0]].data, i * 3);
		log(`CNN: ${i + m}/${n} examples`);
	}
	py.globals.set("probs", probs);
	py.globals.set("meta", meta);
	py.runPython(`dv_browser.write_calls(meta, probs.to_py(), "${out}/call_variants_output-00000-of-00001.tfrecord.gz")`);
	meta.destroy();
	return n;
}

// 3. postprocess_variants: small-model and CNN calls → genotypes, GQ, QUAL, filters → VCF.
// smallModel: whether make_examples ran the small model (its calls are merged in here)
export function postprocessVariants(py, { ref, regions, checkpointJson, smallModel, out, verbose, log }) {
	const argv = [
		"--ref",
		ref,
		"--infile",
		`${out}/call_variants_output.tfrecord.gz`,
		"--outfile",
		`${out}/output.vcf.gz`,
		"--cpus",
		"1",
		"--checkpoint_json",
		checkpointJson,
		...(smallModel ? ["--small_model_cvo_records", `${out}/make_examples_call_variant_outputs.tfrecord@1.gz`] : []),
		"--regions",
		regions,
		...(verbose ? VERBOSE : [])
	];
	runTool(py, "postprocess_variants", argv, { verbose, log });
}

// show_examples: DeepVariant's own script that draws make_examples' pileup images as PNGs (one panel per
// channel). Returns [{name, bytes}] for the images it wrote.
export function showExamples(py, { out, verbose, log }) {
	const dir = `${out}/pileups`;
	runTool(
		py,
		"show_examples",
		["--examples", `${out}/make_examples.tfrecord@1.gz`, "--output", `${dir}/pileup`, ...(verbose ? ["--verbose"] : [])],
		{ verbose, log }
	);
	return py.FS.readdir(dir)
		.filter((f) => f.endsWith(".png"))
		.sort()
		.map((name) => ({ name: name.replace(/^pileup_/, ""), bytes: py.FS.readFile(`${dir}/${name}`) }));
}
