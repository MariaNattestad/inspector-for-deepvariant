// Runs DeepVariant (Pyodide + onnxruntime-web) off the main thread. Loads once on start, then
// handles any number of runs.
//
// Lives in public/deepvariant/<version>/ next to everything it loads (see wasm/build.sh).
//
// To the worker:   {cmd: "run", region: "chr:start-end", bam: File | URL, index: File | URL,
//                   reference: {fasta: URL, fai: URL}, verbose?: bool, realigned?: bool,
//                   model?: "wgs" | "wes" | "pacbio" | ..., pangenome?: File, pangenomeIndex?: File,
//                   watch?: {chrom, pos}, cnnOnly?: bool, force?: [{chrom, pos, ref, alt}]}
//                  (bam: a local file, read from disk on demand, or a URL, read with range requests (the server
//                   must allow both: CORS and Accept-Ranges), so only the locus is read, whatever the BAM's size;
//                   reference: read on demand with range requests; realigned: also return the reads DeepVariant used: after local realignment for short-read
//                   models, with its own phasing (HP tag) for long-read ones, which don't realign;
//                   model: see MODELS, default "wgs"; pangenome: a BAM of pangenome haplotypes, for "wgs_pangenome")
//                   watch: also return what DeepVariant counted at pos ± 10 bp (alleleCounts), to explain why
//                   there is or isn't a candidate; cnnOnly: no small model, so the CNN calls every candidate;
//                   force: consider only these candidates, whatever the reads show (make_examples
//                   --variant_caller=vcf_candidate_importer), called by the CNN)
//                  {cmd: "show_examples", verbose?: bool}   (after a run)
// From the worker: {type: "log", text}
//                  {type: "step", step: "python" | "models"                                     (setup, once)
//                                   | "make_examples" | "call_variants" | "postprocess_variants", (each run)
//                   state: "running" | "done" | "error", secs?, bytes?}       bytes: downloaded during the step
//                  {type: "ready"}                       loading finished, runs can be sent
//                  {type: "done", model, realigns, vcfLines, vcfText, vcfBytes, lazy,
//                   realignedReads: [{window, bytes, changed, total}], phasedReads?: bytes,
//                   alleleCounts?: {rows: [{pos, ref, refCount, alleles: [{type, bases, count}]}], thresholds}}
//                  (realigns: whether the model realigns reads; phasedReads: long-read models' phased reads)
//                  (changed: how many of the window's total reads realignment moved)
//                  {type: "pileups", images: [{name, bytes}], secs}       show_examples' PNGs
//                  {type: "error", text}
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs"; // CPU-only build
import * as dv from "./pipeline.mjs";

const log = (text) => postMessage({ type: "log", text });
const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const url = (path) => new URL(path, import.meta.url).href;

// DeepVariant's models, as run_deepvariant --model_type names them. Each has, under models/:
//   cnn_<key>.fp16.onnx                 the CNN, weights stored as float16 (44 MB instead of 87 MB; see
//                                       convert/shrink_cnn.py)
//   <key>/model.example_info.json       pileup shape, channels and make_examples flags for this model
//   smallmodels_<key>/model.npz         the small model, for the models that have one
// WGS is loaded on start; the others when first used.
const MODELS = {
	wgs: { smallModel: true },
	wes: { smallModel: false },
	pacbio: { smallModel: true, phaseReads: true },
	ont_r104: { smallModel: true, phaseReads: true },
	hybrid_pacbio_illumina: { smallModel: false },
	// Pangenome-aware DeepVariant: also needs a pangenome (see run's pangenome)
	wgs_pangenome: { smallModel: false, pangenome: true }
};
const lazyFiles = {}; // path in Pyodide's filesystem -> {url, size}

// Bytes actually transferred for the lazy files so far (range requests show up in resource timing)
function lazyBytes() {
	const got = {};
	for (const e of performance.getEntriesByType("resource")) got[e.name] = (got[e.name] ?? 0) + e.transferSize;
	return Object.entries(lazyFiles).map(([dst, { url, size }]) => ({ file: dst.split("/").pop(), fetched: got[url] ?? 0, size }));
}
const isLazyUrl = { test: (u) => Object.values(lazyFiles).some((f) => f.url === u) };

// Bytes downloaded so far from URLs matching a pattern: transferSize, i.e. what came over the network
// (0 for responses from the browser cache). Cross-origin hosts must send Timing-Allow-Origin for it to
// be reported: jsDelivr does, PyPI doesn't, so micropip's few small packages aren't counted.
performance.setResourceTimingBufferSize(100000);
const downloaded = (pattern) =>
	performance
		.getEntriesByType("resource")
		.filter((e) => pattern.test(e.name))
		.reduce((n, e) => n + e.transferSize, 0);
const STEP_URLS = {
	python: /\/pyodide\/|pythonhosted|pypi|pysite\.zip/,
	models: /\/models\/|onnxruntime-web/,
	make_examples: isLazyUrl,
	call_variants: /^$/,
	postprocess_variants: isLazyUrl
};

// Runs fn as one step, reporting its state, duration and how much it downloaded
async function step(name, fn) {
	postMessage({ type: "step", step: name, state: "running" });
	// Setup steps run once and their downloads may start before the step does, so count from page load
	const setup = ["python", "models"].includes(name);
	const t = performance.now(),
		before = setup ? 0 : downloaded(STEP_URLS[name]);
	try {
		const result = await fn();
		postMessage({
			type: "step",
			step: name,
			state: "done",
			secs: (performance.now() - t) / 1000,
			bytes: downloaded(STEP_URLS[name]) - before
		});
		return result;
	} catch (e) {
		postMessage({ type: "step", step: name, state: "error", secs: (performance.now() - t) / 1000 });
		throw e;
	}
}

// Setup, once. Downloads start right away; steps that need Python wait for it.
ort.env.wasm.numThreads = 1; // no SharedArrayBuffer without cross-origin isolation
const pysiteZip = fetch(url("pysite.zip")).then((r) => r.arrayBuffer());

// Python, its packages and DeepVariant's code
const python = step("python", async () => {
	const py = await loadPyodide({ stdout: log, stderr: log });
	for (const dir of ["/models", "/user"]) py.FS.mkdir(dir);
	await dv.installPackages(py);
	py.unpackArchive(await pysiteZip, "zip", { extractDir: "/pysite" });
	dv.importDeepVariant(py);
	return py;
});

// A model's CNN (as an onnxruntime session) and files, loaded once: {session, info, checkpoint, smallModel, ...}
const loadedModels = {};
function loadModel(key) {
	const model = MODELS[key];
	if (!model) return Promise.reject(new Error(`Unknown model "${key}". Models: ${Object.keys(MODELS).join(", ")}`));
	loadedModels[key] ??= step("models", async () => {
		const files = {
			[`/models/${key}/model.example_info.json`]: `models/${key}/model.example_info.json`,
			...(model.smallModel ? { [`/models/smallmodels_${key}/model.npz`]: `models/smallmodels_${key}/model.npz` } : {})
		};
		const [session, bytes] = await Promise.all([
			ort.InferenceSession.create(url(`models/cnn_${key}.fp16.onnx`), { executionProviders: ["wasm"] }),
			Promise.all(Object.values(files).map((src) => fetchBytes(url(src))))
		]);
		const py = await python;
		Object.keys(files).forEach((dst, i) => {
			py.FS.mkdirTree(dst.split("/").slice(0, -1).join("/"));
			py.FS.writeFile(dst, bytes[i]);
		});
		const info = JSON.parse(new TextDecoder().decode(bytes[0]));
		return {
			...model,
			session,
			info,
			checkpoint: `/models/${key}/model`,
			checkpointJson: `/models/${key}/model.example_info.json`,
			smallModelPath: model.smallModel ? `/models/smallmodels_${key}/model.keras` : undefined,
			realigns: info.flags_for_calling?.realign_reads !== false
		};
	}).catch((e) => {
		delete loadedModels[key]; // so a later run can try again
		throw e;
	});
	return loadedModels[key];
}
const models = loadModel("wgs");

// Pyodide's lazy files only use range requests if a HEAD response shows "Accept-Ranges: bytes". Servers
// can support ranges without that: Vite's dev server leaves it out of HEAD responses, and cross-origin
// the browser hides it unless the server lists it in Access-Control-Expose-Headers. So test
// range support directly (a tiny range request must come back as 206) and answer Pyodide's check for it.
const rangeOk = new Set();
const getResponseHeader = XMLHttpRequest.prototype.getResponseHeader;
XMLHttpRequest.prototype.getResponseHeader = function (name) {
	const value = getResponseHeader.call(this, name);
	return value == null && /^accept-ranges$/i.test(name) && rangeOk.has(this.responseURL) ? "bytes" : value;
};

// Fetches url, explaining the usual reason a fetch fails outright: the server doesn't allow other sites
async function fetchOrExplain(url, options) {
	try {
		const response = await fetch(url, options);
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		return response;
	} catch (e) {
		if (e instanceof TypeError)
			throw new Error(
				`Couldn't read ${url}. The server must allow requests from other sites (CORS), e.g. for a bucket: allow GET and HEAD from any origin, and expose Content-Length, Content-Range and Accept-Ranges.`
			);
		throw e;
	}
}

// Creates a file in Pyodide's filesystem whose contents are fetched on demand from url (1 MB at a time)
async function addLazyFile(py, dst, url) {
	const parts = dst.split("/"),
		name = parts.pop();
	// Size from HEAD (Content-Length is always visible; Content-Range isn't, cross-origin)
	const size = Number((await fetchOrExplain(url, { method: "HEAD" })).headers.get("Content-Length"));
	if (!size) throw new Error(`Couldn't get the size of ${url} (no Content-Length).`);
	// 2 bytes, not "bytes=0-0": Vite's dev server answers that with the whole file
	const probe = await fetch(url, { headers: { Range: "bytes=0-1" } });
	await probe.arrayBuffer();
	if (probe.status === 206) rangeOk.add(url);
	// Without range support, createLazyFile downloads the whole file instead
	else
		log(
			`WARNING: the server doesn't support range requests, so all of ${name} (${(size / 1e6).toFixed(0)} MB) will be downloaded.`
		);
	py.FS.mkdirTree(parts.join("/"));
	py.FS.createLazyFile(parts.join("/"), name, url, true, false);
	lazyFiles[dst] = { url, size };
}

// A BAM and its index from the page; htslib finds the index next to the BAM (<name>.bai or <name>.csi).
// Files are read straight from disk (WORKERFS: nothing is copied); a URL is read with range requests, and its
// index downloaded (written after the BAM, so htslib doesn't warn that the index is older). Either way only
// what the locus needs is read. Returns the BAM's path.
const remoteBams = {}; // BAM URL -> path in Pyodide's filesystem
async function useBam(py, dir, bam, index) {
	if (typeof bam !== "string") {
		py.FS.mkdir(dir);
		const ext = index.name.endsWith(".csi") ? ".csi" : ".bai";
		const blobs = [
			{ name: bam.name, data: bam },
			{ name: bam.name + ext, data: index }
		];
		py.FS.mount(py.FS.filesystems.WORKERFS, { blobs }, dir);
		return `${dir}/${bam.name}`;
	}
	if (!remoteBams[bam]) {
		const name = new URL(bam).pathname.split("/").pop() || "reads.bam";
		const path = `/remote/${Object.keys(remoteBams).length}/${name}`;
		await addLazyFile(py, path, bam);
		const ext = new URL(index).pathname.endsWith(".csi") ? ".csi" : ".bai";
		py.FS.writeFile(path + ext, new Uint8Array(await (await fetchOrExplain(index)).arrayBuffer()));
		remoteBams[bam] = path;
	}
	return remoteBams[bam];
}

// A reference picked on the page: the FASTA is read on demand, its .fai downloaded (written after the
// FASTA, so htslib doesn't warn that the index is older). Set up once per URL.
const references = {}; // FASTA URL -> path in Pyodide's filesystem
async function useReference(py, { fasta, fai }) {
	// (the same FASTA can come with another index: one whose contigs are named as the reads', 1 for chr1)
	const key = `${fasta} ${fai}`;
	if (!references[key]) {
		const path = `/refs/${Object.keys(references).length}/${fasta.split("/").pop()}`;
		await addLazyFile(py, path, fasta);
		py.FS.writeFile(`${path}.fai`, await fetchBytes(fai));
		references[key] = path;
	}
	return references[key];
}

const loaded = Promise.all([python, models]).then(([py]) => {
	postMessage({ type: "ready" });
	return { py };
});

let runs = 0,
	lastOut = null;
async function run({
	region,
	bam,
	index,
	verbose,
	reference,
	realigned,
	model: modelKey = "wgs",
	pangenome,
	pangenomeIndex,
	watch,
	cnnOnly,
	force
}) {
	const { py } = await loaded;
	const model = await loadModel(modelKey);
	if (model.pangenome && !pangenome) throw new Error("Pangenome-aware DeepVariant needs a pangenome: a BAM of haplotypes.");
	if (!bam || !index || !reference) throw new Error("A run needs reads (a BAM and its index) and a reference.");
	const ref = await useReference(py, reference);
	const out = `/out${++runs}`; // fresh output directory per run
	py.FS.mkdir(out);
	const reads = await useBam(py, `/user/${runs}`, bam, index);
	const pangenomePath = model.pangenome ? await useBam(py, `/user/${runs}-pangenome`, pangenome, pangenomeIndex) : undefined;
	log(`\n=== DeepVariant (${modelKey.toUpperCase()} model) on ${region} (${typeof bam === "string" ? bam : bam.name}) ===`);

	// Forced candidates are for the CNN: the point is to see its pileup image and what it makes of it
	const smallModel = model.smallModel && !cnnOnly && !force?.length;
	let proposed;
	if (force?.length) {
		proposed = `${out}/proposed.vcf.gz`;
		dv.writeProposed(py, proposed, ref, force);
		log(`Forced candidates: ${force.map((f) => `${f.chrom}:${f.pos} ${f.ref}>${f.alt}`).join(", ")}`);
	}
	dv.watchPosition(py, watch?.chrom, watch?.pos);
	await step("make_examples", () =>
		dv.makeExamples(py, {
			ref,
			reads,
			regions: region,
			checkpoint: model.checkpoint,
			smallModel: smallModel ? model.smallModelPath : undefined,
			proposed,
			phaseReads: model.phaseReads,
			pangenome: pangenomePath,
			out,
			phasedReads: realigned && model.phaseReads ? `${out}/phased` : undefined,
			realignerDir: realigned && model.realigns ? `${out}/realigner` : undefined,
			verbose,
			log
		})
	);
	const alleleCounts = watch ? dv.alleleCounts(py) : null;
	dv.watchPosition(py);
	await step("call_variants", () => dv.callVariants(py, model.session, ort, { out, log }));
	await step("postprocess_variants", () =>
		dv.postprocessVariants(py, {
			ref,
			regions: region,
			checkpointJson: model.checkpointJson,
			smallModel,
			out,
			verbose,
			log
		})
	);

	const vcfLines = py
		.runPython(
			`
import gzip
[l.rstrip("\\n") for l in gzip.open("${out}/output.vcf.gz", "rt") if not l.startswith("##")]`
		)
		.toJs();
	const vcfText = py.runPython(`gzip.open("${out}/output.vcf.gz", "rt").read()`);
	const vcfBytes = py.FS.readFile(`${out}/output.vcf.gz`).slice(); // own buffer, so it can be transferred
	// One BAM per ~1 kb window, named like chr20:10002000-10002999 (1-based, inclusive)
	const dirRealigned = `${out}/realigner`;
	const windows = !py.FS.analyzePath(dirRealigned).exists
		? []
		: py.FS.readdir(dirRealigned).filter((window) => py.FS.analyzePath(`${dirRealigned}/${window}/realigned_reads.bam`).exists);
	// How many of each window's reads realignment moved: same read (name + mate) whose start or CIGAR differs
	// from the input alignment. Shown on the page so two identical-looking IGV tracks aren't confusing.
	const realignedStats = py
		.runPython(
			`
from third_party.nucleus.io import sam
from third_party.nucleus.util import ranges
def _aln(r):
    return (r.alignment.position.position, tuple((c.operation, c.operation_length) for c in r.alignment.cigar))
def _realigned_stats(reads, windows):
    stats = []
    with sam.SamReader(reads) as original:
        for window in windows:
            before = {(r.fragment_name, r.read_number): _aln(r) for r in original.query(ranges.parse_literal(window))}
            changed = total = 0
            with sam.SamReader(f"${dirRealigned}/{window}/realigned_reads.bam") as after:
                for r in after:
                    total += 1
                    changed += before.get((r.fragment_name, r.read_number), _aln(r)) != _aln(r)
            stats.append({"changed": changed, "total": total})
    return stats
_realigned_stats`
		)(reads, windows)
		.toJs({ dict_converter: Object.fromEntries });
	const realignedReads = windows.map((window, i) => ({
		window,
		...realignedStats[i],
		bytes: py.FS.readFile(`${dirRealigned}/${window}/realigned_reads.bam`).slice()
	}));
	const pathPhased = `${out}/phased-00000-of-00001.bam`;
	const phasedReads = py.FS.analyzePath(pathPhased).exists ? py.FS.readFile(pathPhased).slice() : undefined;
	lastOut = out;
	postMessage(
		{
			type: "done",
			model: modelKey,
			realigns: model.realigns,
			vcfLines,
			vcfText,
			vcfBytes,
			lazy: lazyBytes(),
			realignedReads,
			phasedReads,
			alleleCounts
		},
		[vcfBytes.buffer, ...realignedReads.map((r) => r.bytes.buffer), ...(phasedReads ? [phasedReads.buffer] : [])]
	);
}

// Python errors carry the whole traceback (already in the log); keep the exception itself
function errorText(e) {
	const lines = String(e).trim().split("\n");
	const i = lines.findLastIndex((l) => /^[\w.]+(Error|Exception)\b/.test(l));
	return (i >= 0 ? lines.slice(i) : lines.slice(-6)).join("\n");
}
loaded.catch((e) => postMessage({ type: "error", text: errorText(e) }));
let queue = Promise.resolve();
async function showExamples({ verbose }) {
	const { py } = await loaded;
	if (!lastOut) throw new Error("Run DeepVariant first: show_examples draws the pileup images make_examples wrote.");
	log("\n=== show_examples ===");
	const t = performance.now();
	const images = dv.showExamples(py, { out: lastOut, verbose, log });
	const out = images.map(({ name, bytes }) => ({ name, bytes: bytes.slice() }));
	postMessage(
		{ type: "pileups", images: out, secs: (performance.now() - t) / 1000 },
		out.map((i) => i.bytes.buffer)
	);
}

onmessage = ({ data }) => {
	const task = { run, show_examples: showExamples }[data.cmd];
	if (task) queue = queue.then(() => task(data)).catch((e) => postMessage({ type: "error", text: errorText(e) }));
};
