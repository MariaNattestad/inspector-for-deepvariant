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
// realignerDir: also write the reads after local realignment (what the pileup images are made from), one
// BAM per ~1 kb window: <realignerDir>/<window>/realigned_reads.bam. Only short-read models realign.
export function makeExamples(
	py,
	{ ref, reads, regions, checkpoint, smallModel, phaseReads, pangenome, out, phasedReads, realignerDir, verbose, log }
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
		...(smallModel ? ["--trained_small_model_path", smallModel] : []),
		...(phaseReads ? ["--output_phase_info"] : []),
		...(phasedReads ? ["--output_local_read_phasing", `${phasedReads}@1.bam`] : []),
		"--regions",
		regions,
		// DeepVariant's default 128 MB read buffer would make each BAM seek download up to 128 MB
		// over range requests; 0 keeps htslib's own small buffer.
		"--hts_block_size",
		"0",
		...(realignerDir ? ["--realigner_diagnostics", realignerDir, "--emit_realigned_reads"] : []),
		...(verbose ? [...VERBOSE, "--logging_every_n_candidates", "10"] : [])
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
