<script>
// Inspect DeepVariant calls: pick the model your data was called with, give it your reads (or use an example)
// and a position, and DeepVariant 1.10 runs again in the browser on that locus. For each call it shows what DeepVariant looked at: the reads after its local
// realignment (short reads) or with its own phasing (long reads), the pangenome haplotypes (pangenome-aware),
// the pileup images and the genotype probabilities. With your DeepVariant VCF, it also summarizes your calls,
// lists the ones worth a closer look, and compares each rerun call with the record in your VCF.
// How it's built: wasm/README.md
import { onDestroy, onMount, tick } from "svelte";
import Aioli from "@biowasm/aioli";
import { CHANNELS, MODELS, exampleRegion, modelByKey, partitionsAround } from "./models.js";
import { GQ_LOW, LIST_MAX, recordsIn, scanVcf, vcfFile } from "./vcf.js";
import { guessReference, locateReads } from "./bam.js";

// DeepVariant for the browser (wasm/build.sh or `npm run assets`), served with the app
const URL_DEEPVARIANT = new URL(`${import.meta.env.BASE_URL}deepvariant/1.10.0`, location.href).href;

// The references IGV uses (igv.js's hg19/hg38), read on demand: only the region's sequence is downloaded
const URL_IGV = "https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq";
const REFERENCES = {
	hg38: { name: "GRCh38 / hg38", fasta: `${URL_IGV}/hg38/hg38.fa`, fai: `${URL_IGV}/hg38/hg38.fa.fai` },
	hg19: { name: "GRCh37 / hg19", fasta: `${URL_IGV}/hg19/hg19.fasta`, fai: `${URL_IGV}/hg19/hg19.fasta.fai` }
};
const EXAMPLE_REFERENCE = "hg38"; // all examples are HG003 on GRCh38
const PILEUP_HALF_WIDTH = 110; // what IGV shows around a call: about the width of a short-read pileup image
const MAX_REGION = 200000; // bp: larger regions would take minutes in the browser

// Inputs
let modelKey = $state("wgs");
let source = $state("example"); // "example" | "upload"
let exampleIndex = $state(0);
let readsFrom = $state("file"); // "file" | "url"
let files = $state([]); // the reads, from your computer
let readsUrl = $state(""); // or from a URL
let indexUrl = $state(""); // its index ("" = the BAM's URL + .bai)
let pangenomeFiles = $state([]);
let captureText = $state(""); // WES capture BED, to run on whole capture intervals
let referenceKey = $state("hg38");
let regionText = $state(""); // "" = pick one where the reads are
let readsSpan = $state(null); // where your reads are: {contigs, chrom, start, end} | {error}
let referenceDetected = $state(false);

// Your DeepVariant VCF
let vcfInput = $state(null); // File
let vcfScan = $state(null);
let vcfProgress = $state(0);
let vcfError = $state("");
let listKey = $state("lowGq");
let listFilter = $state("");

// Worker state
let ready = $state(false);
let busy = $state(""); // what's running right now, "" when idle
let steps = $state({}); // step name -> "running" | "done" | "error"
let error = $state("");
let logText = $state("");

// Results of the last run
let finished = $state(false);
let ranRegion = $state("");
let ranModel = $state(null);
let calls = $state([]); // VCF records of this run, each with .yours: the matching record of your VCF, if any
let yourRecords = $state(null); // your VCF's records in the region (null: no VCF)
let selected = $state(null);
let pileupsForSelected = $state([]);
let pileupError = $state("");
let readsInfo = $state(null); // {kind: "realigned" | "phased", window?, changed?, total?, url}
let linkCopied = $state(false);
// {model, reference, reads: {bam, index}, pangenome?, example?, position, realigned: [...], phased?: File,
//  vcfFile, yourVcf?: File, pileups: Promise}
let run = null;

let worker, igvBrowser, igvModule, samtools;
let divIgv = $state();

const model = $derived(modelByKey(modelKey));
const examples = $derived(model.examples);
const example = $derived(examples[Math.min(exampleIndex, examples.length - 1)]);
const reference = $derived(REFERENCES[source === "example" ? EXAMPLE_REFERENCE : referenceKey]);
const reads = $derived(readsFrom === "url" ? pickUrl(readsUrl, indexUrl) : pickBam(files, "reads"));
const pangenomeReads = $derived(pickBam(pangenomeFiles, "pangenome"));
const capture = $derived(parseBed(captureText));
// No position given: one where your reads are (and, with your VCF, a call worth a look)
const autoPosition = $derived.by(() => {
	if (source !== "upload" || !readsSpan?.chrom) return null;
	const { chrom, start, end } = readsSpan;
	if (vcfScan)
		for (const key of ["lowGq", "noCall", "hetAlt"]) {
			const r = vcfScan.lists[key].find((r) => r.chrom === chrom && r.pos >= start && r.pos <= end);
			if (r) return { text: `${chrom}:${r.pos}`, about: `the first of your VCF's ${LISTS[key].name} among your reads` };
		}
	const small = end - start < 10e6; // a snippet: its middle; a whole genome: where its reads start
	const at = small ? Math.round((start + end) / 2) : start;
	// Short reads: about 10 kb, so there's likely something to call; long reads' 25 kb partition is enough
	const text = model.partitionSize < 10000 ? `${chrom}:${Math.max(1, at - 5000)}-${at + 5000}` : `${chrom}:${at}`;
	return { text, about: small ? "the middle of your reads" : "where your reads start" };
});
const region = $derived.by(() => {
	if (regionText.trim() || source === "example") return regionToRun(regionText, model, source === "upload" ? capture : []);
	if (autoPosition) return { ...regionToRun(autoPosition.text, model, capture), auto: autoPosition.about };
	if (readsSpan?.error || readsSpan?.contigs) return { error: "Enter a position: couldn't find where your reads are." };
	return { pending: true }; // found when you run (a small BAM without an index is sorted and indexed first)
});

// Where your reads are, read from the BAM's header and index as soon as you pick them
$effect(() => {
	const r = reads;
	readsSpan = null;
	const bam = r.url ?? r.alignments;
	if (source !== "upload" || r.error || !bam || !r.index) return;
	let current = true;
	locateReads(bam, r.index).then(
		(span) => current && found(span),
		(e) => current && (readsSpan = { error: e.message ?? String(e) })
	);
	return () => (current = false);
});
function found(span) {
	readsSpan = span;
	const guess = guessReference(span.contigs);
	referenceDetected = Boolean(guess);
	if (guess) referenceKey = guess;
}
const canRun = $derived(
	ready &&
		!busy &&
		!region.error &&
		(source === "example" || (!reads.error && (!model.pangenome || (pangenomeReads.alignments && pangenomeReads.index))))
);

// "chr1:1,000-2,000" or "chr1:1,500", then extended the way DeepVariant would have processed it in a whole-genome
// run: to whole partitions of the model (or, for WES with a capture BED, to the capture interval), so the
// rerun reproduces it (see partitionsAround in models.js)
function regionToRun(text, model, capture) {
	const m = text.replace(/[,\s]/g, "").match(/^([^:]+):(\d+)(?:-(\d+))?$/);
	if (!m) return { error: "Enter a position like chr20:26,263,468 or a region like chr20:26,263,001-26,264,000." };
	const chrom = m[1],
		start = Number(m[2]),
		end = m[3] ? Number(m[3]) : start;
	if (start > end) return { error: "The region's start must be before its end." };
	const interval = capture.find((c) => c.chrom === chrom && c.start <= start && c.end >= end);
	const run = interval ?? { chrom, ...partitionsAround(start, end, model.partitionSize) };
	if (run.end - run.start + 1 > MAX_REGION)
		return { error: `That's over ${MAX_REGION / 1000} kb; a position or a few kb around it is plenty.` };
	const size = model.partitionSize === 1000 ? "1 kb" : `${model.partitionSize / 1000} kb`;
	const why = interval
		? "the capture interval around it, as in a WES run with your capture BED"
		: `whole ${size} partitions of ${chrom}, as in a whole-genome run`;
	return {
		chrom,
		start,
		end,
		text: `${chrom}:${run.start}-${run.end}`,
		runStart: run.start,
		runEnd: run.end,
		why,
		position: !m[3],
		input: text.replace(/\s/g, "")
	};
}

// BED intervals (0-based, half-open) as 1-based inclusive {chrom, start, end}
function parseBed(text) {
	return text
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.filter((f) => f.length >= 3 && /^\d+$/.test(f[1]))
		.map(([chrom, s, e]) => ({ chrom, start: Number(s) + 1, end: Number(e) }));
}

// A BAM with its index can be used as is, at any size: DeepVariant and IGV only read the locus. A small file
// without an index (SAM, unsorted) is sorted and indexed first, in the browser; a large one needs its index.
const MAX_UNINDEXED = 200e6; // bytes
function pickBam(list, what) {
	const alignments = list.find((f) => /\.(bam|sam)$/i.test(f.name));
	const index = list.find((f) => /\.(bai|csi)$/i.test(f.name));
	if (!alignments) return { error: `Pick the ${what} as a .bam or .sam file (and its .bai, if you have one).` };
	const bam = alignments.name.toLowerCase().endsWith(".bam");
	if (!(bam && index) && alignments.size > MAX_UNINDEXED)
		return {
			error: `${alignments.name} is ${(alignments.size / 1e9).toFixed(1)} GB: select its index too (.bai or .csi, from samtools index), so only the locus is read.`
		};
	return { alignments, index: bam ? index : undefined };
}

// A BAM at a URL, read with range requests; its index at indexUrl, or by default the BAM's URL + .bai (before
// any query string, as in a signed URL)
function pickUrl(url, indexUrl) {
	let parsed;
	try {
		parsed = new URL(url.trim());
	} catch {
		return { error: "Enter the BAM's URL (https://…/sample.bam)." };
	}
	const index = indexUrl.trim() || `${parsed.origin}${parsed.pathname}.bai${parsed.search}`;
	return { url: parsed.href, index };
}

// samtools (biowasm), in its own worker: sort + index an upload so DeepVariant and IGV can jump to the region
async function sortAndIndex(alignments) {
	samtools ??= new Aioli(["samtools/1.21"], { printInterleaved: false });
	const CLI = await samtools;
	const ext = alignments.name.toLowerCase().endsWith(".sam") ? "sam" : "bam";
	const [input] = await CLI.mount([{ name: `input.${ext}`, data: alignments }]);
	for (const cmd of [`samtools sort -o snippet.bam ${input}`, "samtools index snippet.bam"]) {
		const { stderr } = await CLI.exec(cmd);
		if (stderr.trim()) logText += `${cmd}\n${stderr}`;
	}
	// read() returns bytes; cat()/download() would decode the BAM as text
	const read = async (path) => {
		const stat = await CLI.ls(path);
		if (!stat) throw new Error(`samtools couldn't sort or index ${alignments.name}; see the log below.`);
		return CLI.read({ path, length: stat.size });
	};
	return {
		bam: new File([await read("snippet.bam")], "snippet.bam"),
		index: new File([await read("snippet.bam.bai")], "snippet.bam.bai")
	};
}

// The examples' BAMs are small (35 kB to 5 MB), so they're passed to the worker as files, just like uploads
async function fetchFile(path) {
	const response = await fetch(`${URL_DEEPVARIANT}/${path}`);
	if (!response.ok) throw new Error(`Couldn't download the example (${path}): HTTP ${response.status}`);
	return new File([await response.blob()], path.split("/").pop());
}
const fetchBam = async (path) => {
	const [bam, index] = await Promise.all([fetchFile(path), fetchFile(`${path}.bai`)]);
	return { bam, index };
};

// ---------------------------------------------------------------------------------------------------------
// Your DeepVariant VCF
// ---------------------------------------------------------------------------------------------------------
async function loadVcf(file) {
	vcfInput = file;
	vcfScan = null;
	vcfError = "";
	vcfProgress = 0;
	if (!file) return;
	try {
		vcfScan = await scanVcf(file, (p) => (vcfProgress = p));
	} catch (e) {
		vcfError = e.message ?? String(e);
	}
}

const LISTS = {
	lowGq: { name: `PASS with GQ < ${GQ_LOW}`, about: "Called, but not confidently" },
	noCall: { name: "No-calls (./.)", about: "DeepVariant saw a candidate but couldn't decide the genotype" },
	hetAlt: { name: "Two alternate alleles (1/2)", about: "Multiallelic calls, often in repeats" }
};
const listShown = $derived.by(() => {
	if (!vcfScan) return [];
	const q = listFilter.replace(/[,\s]/g, "").toLowerCase();
	const list = vcfScan.lists[listKey];
	return (q ? list.filter((r) => `${r.chrom}:${r.pos}`.toLowerCase().includes(q)) : list).slice(0, 300);
});

function inspectRecord(r) {
	regionText = `${r.chrom}:${r.pos.toLocaleString("en-US")}`;
	if (source === "example") source = "upload";
	if (canRun) runDeepVariant();
	else document.getElementById("dvi-setup")?.scrollIntoView({ behavior: "smooth" });
}

// ---------------------------------------------------------------------------------------------------------
// Running DeepVariant
// ---------------------------------------------------------------------------------------------------------
async function runDeepVariant() {
	error = "";
	finished = false;
	calls = [];
	selected = null;
	yourRecords = null;
	steps = { python: steps.python, models: steps.models }; // keep the setup steps' state
	if (igvBrowser) igvModule.removeBrowser(igvBrowser);
	igvBrowser = null;
	try {
		let input, pangenome;
		if (source === "upload") {
			busy = "Sorting and indexing your reads with samtools…";
			if (reads.url) input = { bam: reads.url, index: reads.index };
			else input = reads.index ? { bam: reads.alignments, index: reads.index } : await sortAndIndex(reads.alignments);
			if (model.pangenome) pangenome = { bam: pangenomeReads.alignments, index: pangenomeReads.index };
		} else {
			busy = "Downloading the example reads…";
			[input, pangenome] = await Promise.all([fetchBam(model.bam), model.pangenome ? fetchBam(model.pangenomeBam) : null]);
		}
		if (region.pending) {
			busy = "Finding where your reads are…";
			found(await locateReads(input.bam, input.index));
			if (region.error) throw new Error(region.error);
		}
		busy = `Running DeepVariant (${model.modelType} model)…`;
		ranRegion = region.text;
		ranModel = model;
		run = { model, reference, reads: input, pangenome, example: source === "example" ? example : null, position: region };
		updateUrl();
		worker.postMessage({
			cmd: "run",
			region: region.text,
			bam: input.bam,
			index: input.index,
			reference: { fasta: reference.fasta, fai: reference.fai },
			realigned: true,
			model: model.key,
			pangenome: pangenome?.bam,
			pangenomeIndex: pangenome?.index
		});
		// Meanwhile, your VCF's records in the same region (a little wider, for IGV)
		if (vcfScan && source === "upload") {
			const r = await recordsIn(vcfInput, vcfScan, region.chrom, region.runStart - 2000, region.runEnd + 2000);
			run.yourVcf = vcfFile(vcfScan, r, "your_deepvariant.vcf");
			yourRecords = r;
		}
	} catch (e) {
		error = e.message ?? String(e);
		busy = "";
	}
}

function onDone({ vcfLines, vcfText, realignedReads, phasedReads }) {
	const header = vcfLines[0].replace(/^#/, "").split("\t");
	const col = (name) => header.indexOf(name);
	calls = vcfLines.slice(1).map((line) => {
		const r = line.split("\t");
		const fmt = r[col("FORMAT")].split(":"),
			vals = r[col("FORMAT") + 1].split(":");
		const sample = Object.fromEntries(fmt.map((k, i) => [k, vals[i]]));
		return {
			chrom: r[col("CHROM")],
			pos: Number(r[col("POS")]),
			ref: r[col("REF")],
			alt: r[col("ALT")],
			qual: r[col("QUAL")],
			filter: r[col("FILTER")],
			...sample
		};
	});
	run.vcfFile = new File([vcfText], "deepvariant.vcf");
	run.realigned = realignedReads.map(({ window, bytes, changed, total }) => ({
		window,
		changed,
		total,
		file: new File([bytes], `realigned_${window.replace(/[:]/g, "_")}.bam`)
	}));
	run.phased = phasedReads ? new File([phasedReads], "phased_by_deepvariant.bam") : null;
	// Pileup images (DeepVariant's show_examples) are drawn right away, so clicking a call shows them at once.
	// Only CNN calls have one: the small model's calls never become pileup images.
	run.pileups = new Promise((resolve, reject) => (run.pileupsPending = { resolve, reject }));
	run.pileups.catch(() => {});
	if (calls.some((c) => c.MID !== "small_model")) worker.postMessage({ cmd: "show_examples" });
	else run.pileupsPending.resolve([]);
	busy = "";
	finished = true;
	// An example, or a position you entered: the call closest to it (an indel may be placed a few bp off)
	const target = run.example?.pos ?? (run.position.position ? run.position.start : null);
	const near = (call) => Math.abs(call.pos - target);
	const closest = target ? calls.toSorted((a, b) => near(a) - near(b))[0] : null;
	if (calls.length) select(closest && near(closest) <= 50 ? closest : calls.find((c) => c.filter === "PASS") || calls[0]);
}

// Each call's record in your VCF: same position and alleles (or, failing that, same position)
const yoursFor = (call) => {
	const same = (yourRecords ?? []).filter((r) => r.chrom === call.chrom && r.pos === call.pos);
	return same.find((r) => r.ref === call.ref && r.alt === call.alt) ?? same[0] ?? null;
};
const agrees = (call) => {
	const yours = yoursFor(call);
	return yours && yours.GT === call.GT && yours.filter === call.filter;
};

// The realigner works in ~1 kb windows named like chr20:10002000-10002999 (1-based, inclusive)
function windowFor(call) {
	return run.realigned.find(({ window }) => {
		const m = window.match(/^(.+):(\d+)-(\d+)$/);
		return m && m[1] === call.chrom && call.pos >= Number(m[2]) && call.pos <= Number(m[3]);
	});
}

async function select(call) {
	selected = call;
	pileupsForSelected = [];
	pileupError = "";
	const halfWidth = run.model.realigns ? PILEUP_HALF_WIDTH : 600; // long reads: a wider view
	const locus = `${call.chrom}:${call.pos - halfWidth}-${call.pos + halfWidth}`;
	const realigned = run.model.realigns ? windowFor(call) : null;
	readsInfo = realigned
		? {
				kind: "realigned",
				window: realigned.window,
				changed: realigned.changed,
				total: realigned.total,
				url: URL.createObjectURL(realigned.file)
			}
		: run.phased
			? { kind: "phased", url: URL.createObjectURL(run.phased) }
			: null;
	await tick(); // IGV's container is rendered once something is selected
	await showInIgv(locus, realigned);
	if (call.MID !== "small_model") {
		try {
			// show_examples names images by the 0-based start (POS - 1)
			const prefix = `${call.chrom}:${call.pos - 1}_`;
			pileupsForSelected = (await run.pileups).filter((p) => p.name.startsWith(prefix));
		} catch (e) {
			pileupError = e.message;
		}
	}
}

// IGV: DeepVariant's calls (this run, and yours), the reads as aligned (what IGV normally shows), and what
// DeepVariant used: the reads after its local realignment (short reads), the reads with its own phasing,
// grouped by haplotype (long reads), and the pangenome's haplotypes (pangenome-aware)
const NAME_REALIGNED = "Realigned by DeepVariant (what it saw)";
async function showInIgv(locus, realigned) {
	const realignedTrack = realigned && {
		name: NAME_REALIGNED,
		type: "alignment",
		format: "bam",
		url: realigned.file,
		indexed: false
	};
	if (!igvBrowser) {
		igvModule ??= (await import("igv")).default;
		const tracks = [
			{ name: "This run (DeepVariant 1.10 in your browser)", type: "variant", format: "vcf", url: run.vcfFile, indexed: false },
			...(run.yourVcf
				? [{ name: "Your DeepVariant VCF", type: "variant", format: "vcf", url: run.yourVcf, indexed: false }]
				: []),
			{
				name: "Your reads (as aligned, what IGV shows)",
				type: "alignment",
				format: "bam",
				url: run.reads.bam,
				indexURL: run.reads.index
			},
			...(realignedTrack ? [realignedTrack] : []),
			...(run.phased
				? [
						{
							name: "Phased by DeepVariant (pileup rows are sorted by this)",
							type: "alignment",
							format: "bam",
							url: run.phased,
							indexed: false,
							groupBy: "tag:HP"
						}
					]
				: []),
			...(run.pangenome
				? [
						{
							name: "Pangenome haplotypes (HPRC v1.1)",
							type: "alignment",
							format: "bam",
							url: run.pangenome.bam,
							indexURL: run.pangenome.index,
							displayMode: "SQUISHED"
						}
					]
				: [])
		];
		igvBrowser = await igvModule.createBrowser(divIgv, {
			reference: { id: run.reference.name, name: run.reference.name, fastaURL: run.reference.fasta, indexURL: run.reference.fai },
			locus,
			tracks
		});
		igvBrowser.realignedWindow = realigned?.window;
		return;
	}
	if (run.model.realigns && igvBrowser.realignedWindow !== realigned?.window) {
		igvBrowser.removeTrackByName(NAME_REALIGNED);
		if (realignedTrack) await igvBrowser.loadTrack(realignedTrack);
		igvBrowser.realignedWindow = realigned?.window;
	}
	await igvBrowser.search(locus);
}

// Genotype probabilities from PL (phred-scaled, as postprocess_variants writes them), in VCF genotype order
function genotypeProbabilities(call) {
	const pl = (call.PL ?? "").split(",").map(Number);
	if (!pl.length || pl.some(Number.isNaN)) return [];
	const nAlleles = Math.round((Math.sqrt(8 * pl.length + 1) - 1) / 2);
	const names = [];
	for (let b = 0; b < nAlleles; b++) for (let a = 0; a <= b; a++) names.push(`${a}/${b}`);
	const p = pl.map((x) => 10 ** (-x / 10));
	const sum = p.reduce((s, x) => s + x, 0);
	return names.map((gt, i) => ({ gt, p: p[i] / sum }));
}

// ---------------------------------------------------------------------------------------------------------
// Links: the model, example or region are in the URL, so a locus can be shared (your files stay with you, but
// reads from a URL are part of the link)
// ---------------------------------------------------------------------------------------------------------
function updateUrl() {
	const params = new URLSearchParams({ model: model.key });
	if (source === "example") params.set("example", String(exampleIndex + 1));
	else {
		if (region.input) params.set("region", region.input);
		if (readsFrom === "url" && reads.url) {
			params.set("reads", reads.url);
			if (indexUrl.trim()) params.set("index", indexUrl.trim());
			if (referenceKey !== "hg38") params.set("reference", referenceKey);
		}
	}
	history.replaceState(history.state, "", `${location.pathname}?${params}`);
}
async function copyLink() {
	updateUrl();
	await navigator.clipboard.writeText(location.href);
	linkCopied = true;
	setTimeout(() => (linkCopied = false), 2000);
}

function pickModel(key) {
	modelKey = key;
	exampleIndex = 0;
	if (source === "example") regionText = exampleRegion(modelByKey(key), modelByKey(key).examples[0]);
}
function pickExample(i) {
	exampleIndex = i;
	regionText = exampleRegion(model, model.examples[i]);
}
function pickSource(value) {
	// The example's position isn't yours: leave it empty, to use where your reads are
	if (value === "upload" && regionText === exampleRegion(model, example)) regionText = "";
	source = value;
	if (value === "example") pickExample(exampleIndex);
}

onMount(() => {
	const params = new URLSearchParams(location.search);
	if (modelByKey(params.get("model"))) modelKey = params.get("model");
	if (params.has("region") || params.has("reads")) {
		source = "upload";
		regionText = params.get("region") ?? "";
		if (params.get("reads")) {
			readsFrom = "url";
			readsUrl = params.get("reads");
			indexUrl = params.get("index") ?? "";
		}
		if (REFERENCES[params.get("reference")]) referenceKey = params.get("reference");
	} else pickExample(Math.max(0, Math.min(model.examples.length - 1, Number(params.get("example") ?? 1) - 1)));

	worker = new Worker(`${URL_DEEPVARIANT}/worker.mjs`, { type: "module" });
	worker.onmessage = ({ data: m }) => {
		if (m.type === "log") logText += m.text + "\n";
		else if (m.type === "step") steps = { ...steps, [m.step]: m.state };
		else if (m.type === "ready") ready = true;
		else if (m.type === "done") onDone(m);
		else if (m.type === "pileups") {
			run.pileupsPending.resolve(
				m.images.map(({ name, bytes }) => ({
					name: name.replace(/\.png$/, ""),
					url: URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
				}))
			);
		} else if (m.type === "error") {
			if (run?.pileupsPending && calls.length) run.pileupsPending.reject(new Error(m.text));
			else error = m.text;
			busy = "";
		}
	};
});

onDestroy(() => {
	worker?.terminate();
	if (igvBrowser) igvModule.removeBrowser(igvBrowser);
});

// Names while waiting or running, and once done
const STEP_NAMES = {
	python: ["Loading Python", "Loaded Python"],
	models: ["Downloading model", "Downloaded model"],
	make_examples: "make_examples",
	call_variants: "call_variants",
	postprocess_variants: "postprocess_variants"
};
const modelName = (mid) => ({ small_model: "small model", deepvariant: "CNN" })[mid] ?? mid ?? "";
const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
</script>

<div class="dvi">
	<h1>Inspect a DeepVariant call</h1>
	<p class="sub">
		Why did DeepVariant call a variant this way, when IGV shows something else? Pick the model you ran, give it your reads and a
		position, and DeepVariant 1.10.0 runs again on that locus, in this tab. For each call you see what it actually looked at: the
		reads after its <a
			href="https://github.com/google/deepvariant/blob/r1.10/docs/FAQ.md#what-is-the-realigner-and-how-does-it-work"
			>local realignment</a
		> (short reads) or with its own phasing (long reads), the pangenome haplotypes (pangenome-aware), the pileup images its CNN classified
		and the genotype probabilities. Add your DeepVariant VCF to find the calls worth a closer look and compare each call with yours.
		Your files stay on your computer.
	</p>

	<!-- 1. Model, 2. data, 3. position -->
	<section class="card-dvi" id="dvi-setup">
		<h2><span class="step-num">1</span> Model: what <code>--model_type</code> did you run?</h2>
		<div class="models" role="radiogroup" aria-label="Model">
			{#each MODELS as m (m.key)}
				<button
					class="model"
					class:active={m.key === modelKey}
					role="radio"
					aria-checked={m.key === modelKey}
					onclick={() => pickModel(m.key)}
				>
					<span class="model-name">{m.name}</span>
					<span class="model-type">{m.modelType}</span>
				</button>
			{/each}
		</div>
		<p class="hint model-notes">
			{#if model.realigns}Realigns reads locally before making pileup images.{:else}Doesn't realign reads: phases them instead,
				and sorts pileup rows by haplotype.{/if}
			{model.smallModel
				? "Easy candidates are called by the small model, without a pileup image."
				: "Every candidate goes to the CNN."}
			{#if model.pangenome}Also needs the pangenome's haplotypes, as a BAM.{/if}
			<a href={model.caseStudy}>Case study</a>
		</p>

		<h2 class="mt"><span class="step-num">2</span> Data</h2>
		<div class="inputs">
			<div>
				<label
					><input type="radio" name="dvi-source" checked={source === "example"} onchange={() => pickSource("example")} /> Example:
					a hard call in HG003 (chr20)</label
				>
				{#if source === "example"}
					<select class="indent" aria-label="Example" value={exampleIndex} onchange={(e) => pickExample(Number(e.target.value))}>
						{#each examples as ex, i (ex.pos)}
							<option value={i}>chr20:{fmt(ex.pos)}: {ex.what}</option>
						{/each}
					</select>
					<div class="hint indent">
						Truth (GIAB): {example.truth}. DeepVariant 1.10's official run: {example.official}.
						{#if example.note}{example.note}{/if}
					</div>
				{/if}
				<label
					><input type="radio" name="dvi-source" checked={source === "upload"} onchange={() => pickSource("upload")} /> Your data</label
				>
				{#if source === "upload"}
					<div class="indent uploads">
						<p class="hint only-reads">Only the reads are needed. Everything else, position included, is optional.</p>
						<span class="field">Reads</span>
						<div class="choice">
							<label><input type="radio" name="dvi-reads-from" value="file" bind:group={readsFrom} /> From your computer</label>
							<label><input type="radio" name="dvi-reads-from" value="url" bind:group={readsFrom} /> From a URL</label>
						</div>
						{#if readsFrom === "file"}
							<input
								id="dvi-reads"
								type="file"
								multiple
								accept=".bam,.sam,.bai,.csi"
								aria-label="Reads (.bam and .bai)"
								onchange={(e) => (files = [...e.target.files])}
							/>
							<div class="hint" class:bad={files.length && reads.error}>
								{#if files.length && reads.error}{reads.error}
								{:else if reads.index}{reads.alignments.name} + {reads.index.name}: only the locus is read from disk
								{:else if files.length}{reads.alignments.name}: will be sorted and indexed in your browser (samtools)
								{:else}The BAM you gave DeepVariant and its .bai: any size, since only the locus is read. Or a snippet made with
									<code>samtools view -b</code> (keeps the full header); small files don't need an index.{/if}
							</div>
						{:else}
							<input type="text" class="url" placeholder="https://…/sample.bam" aria-label="BAM URL" bind:value={readsUrl} />
							<input
								type="text"
								class="url mt-xs"
								placeholder="Index URL (default: the BAM's URL + .bai)"
								aria-label="Index URL"
								bind:value={indexUrl}
							/>
							<div class="hint" class:bad={readsUrl && reads.error}>
								{#if readsUrl && reads.error}{reads.error}
								{:else}Read with range requests, so only the locus is downloaded, whatever the BAM's size. The server must allow
									range requests and requests from other sites (CORS): S3 and GCS buckets need a CORS rule allowing GET and HEAD.{/if}
							</div>
						{/if}
						{#if readsSpan?.error}
							<div class="hint bad">
								Couldn't read the BAM's header and index: {readsSpan.error}{readsFrom === "url" && /fetch/i.test(readsSpan.error)
									? " (does the server allow requests from other sites, CORS?)"
									: ""}
							</div>
						{:else if readsSpan?.chrom}
							<div class="hint">Reads start at {readsSpan.chrom}:{fmt(readsSpan.start)}.</div>
						{/if}
						{#if model.pangenome}
							<label class="field mt-s" for="dvi-pangenome">Pangenome haplotypes <span class="hint">(.bam + .bai)</span></label>
							<input
								id="dvi-pangenome"
								type="file"
								multiple
								accept=".bam,.bai,.csi"
								onchange={(e) => (pangenomeFiles = [...e.target.files])}
							/>
							<div class="hint" class:bad={pangenomeFiles.length && pangenomeReads.error}>
								{#if pangenomeFiles.length && pangenomeReads.error}{pangenomeReads.error}
								{:else if pangenomeReads.index}{pangenomeReads.alignments.name} + {pangenomeReads.index.name}
								{:else}A GBZ is too big for the browser, but pangenome-aware DeepVariant also takes the haplotypes as a BAM. Make
									one for your locus from the GBZ with <a href="https://github.com/jltsiren/gbz-base">gbz-base</a> and
									<a href="{URL_DEEPVARIANT}/tools/gbz_haplotypes_bam.py" download>this script</a>.{/if}
							</div>
						{/if}
						<label class="field mt-s" for="dvi-vcf">Your DeepVariant VCF <span class="hint">(optional, .vcf.gz)</span></label>
						<input id="dvi-vcf" type="file" accept=".vcf,.gz,.bgz" onchange={(e) => loadVcf(e.target.files[0])} />
						<div class="hint" class:bad={vcfError}>
							{#if vcfError}{vcfError}
							{:else if vcfInput && !vcfScan}Reading {vcfInput.name}… {Math.round(vcfProgress * 100)}%
							{:else if vcfScan}{vcfInput.name}: {fmt(vcfScan.stats.records)} calls{vcfScan.gvcf
									? " (gVCF: variant records only)"
									: ""}. Summary below.
							{:else}Summarizes your calls, lists the ones worth a look, and compares each rerun call with yours.{/if}
						</div>
						{#if model.captureRegions}
							<label class="field mt-s" for="dvi-capture"
								>Capture BED <span class="hint">(optional, as given to --regions)</span></label
							>
							<input
								id="dvi-capture"
								type="file"
								accept=".bed,.txt"
								onchange={async (e) => (captureText = (await e.target.files[0]?.text()) ?? "")}
							/>
							<div class="hint">
								{capture.length
									? `${fmt(capture.length)} intervals: each run uses the one around your position, as your WES run did.`
									: "WES runs process each capture interval on its own, so give the BED to reproduce your run exactly."}
							</div>
						{/if}
					</div>
				{/if}
			</div>
			<div>
				<label class="field" for="dvi-reference">Reference</label>
				<!-- The examples run on hg38, so show that while one is picked -->
				<select
					id="dvi-reference"
					value={source === "example" ? EXAMPLE_REFERENCE : referenceKey}
					onchange={(e) => (referenceKey = e.target.value)}
					disabled={source === "example"}
				>
					{#each Object.entries(REFERENCES) as [key, ref] (key)}
						<option value={key}>{ref.name}</option>
					{/each}
				</select>
				<div class="hint">
					{#if source === "upload" && referenceDetected && readsSpan?.contigs}Detected from your BAM's header.{:else}Contig names
						must match your BAM (chr1, not 1).{/if} Only the region's sequence is downloaded.
				</div>

				<label class="field mt" for="dvi-region"
					>Position{#if source === "upload"}&nbsp;<span class="hint">(optional)</span>{/if}</label
				>
				<input
					id="dvi-region"
					type="text"
					bind:value={regionText}
					disabled={source === "example"}
					placeholder={autoPosition ? autoPosition.text.replace(/\d+/g, (n) => fmt(Number(n))) : "Empty: where your reads are"}
				/>
				<div class="hint" class:bad={region.error}>
					{#if region.error}{region.error}
					{:else if region.pending}Leave it empty to run where your reads are, or enter a position like chr20:26,263,468.
					{:else}{#if region.auto}No position given, so {region.auto}.{/if} Runs on {region.text}: {region.why}, so the
						calls match a real run's.{/if}
				</div>
			</div>
		</div>
		<div class="run-row">
			<button class="run" onclick={runDeepVariant} disabled={!canRun}
				>{!ready ? "Loading DeepVariant…" : busy ? "Running…" : "Run DeepVariant"}</button
			>
			<div class="steps">
				{#each Object.entries(STEP_NAMES) as [key, label] (key)}
					<span class="step {steps[key] ?? 'pending'}">{Array.isArray(label) ? label[steps[key] === "done" ? 1 : 0] : label}</span>
				{/each}
				{#if busy}<span class="hint">{busy}</span>{/if}
			</div>
		</div>
		{#if error}<div class="bad">Failed: {error.replace(/^Error: /, "")}</div>{/if}
	</section>

	<!-- Your VCF -->
	{#if vcfScan}
		{@const s = vcfScan.stats}
		{@const pass = s.filter.PASS ?? 0}
		<section class="card-dvi">
			<h2>Your calls: {vcfInput.name}{vcfScan.sample ? ` (${vcfScan.sample})` : ""}</h2>
			{#if !vcfScan.isDeepVariant}<p class="bad">
					This VCF has no ##DeepVariant_version line: it may not come from DeepVariant.
				</p>{/if}
			<div class="tiles">
				<div class="tile"><b>{fmt(pass)}</b>PASS calls</div>
				<div class="tile"><b>{fmt(s.pass.snp)}</b>SNPs</div>
				<div class="tile"><b>{fmt(s.pass.indel)}</b>indels</div>
				<div class="tile">
					<b>{s.pass.transversions ? (s.pass.transitions / s.pass.transversions).toFixed(2) : "–"}</b>Ti/Tv (SNPs)
				</div>
				<div class="tile"><b>{s.pass.homAlt ? (s.pass.het / s.pass.homAlt).toFixed(2) : "–"}</b>het / hom-alt</div>
				<div class="tile"><b>{pct(s.mid.small_model ?? 0, pass)}</b>called by the small model</div>
				<div class="tile"><b>{fmt(s.filter.RefCall ?? 0)}</b>RefCall</div>
				<div class="tile"><b>{fmt(s.filter.NoCall ?? 0)}</b>NoCall</div>
			</div>
			<div class="gq">
				<span class="hint">GQ of PASS calls</span>
				<div class="bars" role="img" aria-label="Histogram of GQ for PASS calls">
					{#each s.gqHistogram as n, i (i)}
						<div class="bar-col" title="GQ {i * 10}–{i * 10 + 9}: {fmt(n)} calls">
							<div class="bar" class:low={i < GQ_LOW / 10} style="height: {(100 * n) / Math.max(...s.gqHistogram, 1)}%"></div>
							<span>{i * 10}</span>
						</div>
					{/each}
				</div>
			</div>
			<h2 class="mt">Calls worth a closer look: click one to rerun DeepVariant there</h2>
			<div class="tabs" role="tablist">
				{#each Object.entries(LISTS) as [key, l] (key)}
					<button role="tab" class:active={key === listKey} aria-selected={key === listKey} onclick={() => (listKey = key)}
						>{l.name}
						<span class="count">{fmt(vcfScan.lists[key].length)}{vcfScan.lists[key].length === LIST_MAX ? "+" : ""}</span></button
					>
				{/each}
				<input
					type="text"
					class="filter"
					placeholder="Filter: chr20:12,3"
					aria-label="Filter by position"
					bind:value={listFilter}
				/>
			</div>
			<p class="hint">
				{LISTS[listKey].about}.{source === "example" || reads.error ? " Add your reads above to rerun DeepVariant on these." : ""}
			</p>
			<div class="tablewrap short">
				<table>
					<thead>
						<tr
							><th>position</th><th>ref</th><th>alt</th><th>filter</th><th>genotype</th><th>GQ</th><th>depth</th><th>called by</th
							></tr
						>
					</thead>
					<tbody>
						{#each listShown as r (`${r.chrom}:${r.pos}:${r.alt}`)}
							<tr tabindex="0" onclick={() => inspectRecord(r)} onkeydown={(e) => e.key === "Enter" && inspectRecord(r)}>
								<td>{r.chrom}:{fmt(r.pos)}</td><td class="allele">{r.ref}</td><td class="allele">{r.alt}</td><td>{r.filter}</td
								><td>{r.GT}</td><td class="num">{r.GQ}</td><td class="num">{r.DP}</td><td>{modelName(r.MID)}</td>
							</tr>
						{:else}
							<tr><td colspan="8" class="hint">None.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Calls of this run -->
	{#if calls.length}
		<section class="card-dvi">
			<div class="title-row">
				<h2>DeepVariant's calls in {ranRegion} ({ranModel.modelType} model): click one to inspect it</h2>
				<button class="link" onclick={copyLink}>{linkCopied ? "Link copied" : "Copy link to this locus"}</button>
			</div>
			<div class="tablewrap">
				<table>
					<thead>
						<tr
							><th>position</th><th>ref</th><th>alt</th><th>genotype</th><th>GQ</th><th>QUAL</th><th>filter</th><th>depth</th><th
								>allele depths</th
							><th>called by</th>{#if yourRecords}<th>your VCF</th>{/if}</tr
						>
					</thead>
					<tbody>
						{#each calls as call (`${call.pos}:${call.alt}`)}
							{@const yours = yourRecords ? yoursFor(call) : null}
							<tr
								class:active={call === selected}
								class:filtered={call.filter !== "PASS"}
								tabindex="0"
								onclick={() => select(call)}
								onkeydown={(e) => e.key === "Enter" && select(call)}
							>
								<td>{call.chrom}:{fmt(call.pos)}</td><td class="allele">{call.ref}</td><td class="allele">{call.alt}</td><td
									>{call.GT}</td
								><td class="num">{call.GQ}</td><td class="num">{call.qual}</td><td>{call.filter}</td><td class="num">{call.DP}</td
								><td>{call.AD}</td><td>{modelName(call.MID)}</td>
								{#if yourRecords}
									<td class:differs={yours && !agrees(call)}
										>{#if !yours}<span class="hint">not in your VCF</span>{:else}{yours.GT} {yours.filter} GQ {yours.GQ}{/if}</td
									>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{:else if finished}
		<section class="card-dvi"><p class="hint">No candidate variants in {ranRegion}.</p></section>
	{/if}

	<!-- The selected call -->
	{#if selected}
		{@const probs = genotypeProbabilities(selected)}
		{@const yours = yourRecords ? yoursFor(selected) : null}
		<section class="card-dvi">
			<h2>
				{selected.chrom}:{fmt(selected.pos)}
				{selected.ref} → {selected.alt} · {selected.GT} · GQ {selected.GQ} · {selected.filter} · called by the {modelName(
					selected.MID
				)}
			</h2>
			<div class="detail">
				<div>
					<h3>Genotype probabilities</h3>
					<div class="probs">
						{#each probs as { gt, p } (gt)}
							<div class="prob" title="{gt}: {p.toPrecision(3)}">
								<span class="gt">{gt}</span>
								<div class="prob-bar"><div style="width: {Math.max(0.5, p * 100)}%"></div></div>
								<span class="p">{p >= 0.001 ? `${(p * 100).toFixed(1)}%` : p.toExponential(0)}</span>
							</div>
						{/each}
					</div>
					<p class="hint">
						From PL. GQ {selected.GQ} means a {(10 ** (-Number(selected.GQ) / 10) * 100).toPrecision(2)}% chance the top genotype
						is wrong.
						{#if selected.filter === "NoCall"}NoCall (./.): no genotype was likely enough to call.{/if}
						{#if selected.filter === "RefCall"}RefCall: DeepVariant thinks this candidate is reference.{/if}
					</p>
				</div>
				<div>
					<h3>How it was called</h3>
					<p>
						{#if selected.MID === "small_model"}
							By the <b>small model</b>, from summary features (allele counts, base and mapping qualities) instead of a pileup
							image: DeepVariant uses it for candidates it can call confidently and sends the rest to the CNN.
						{:else}
							By the <b>CNN</b>, from the pileup images below (one per alternate allele, or pair of them).
						{/if}
					</p>
					{#if readsInfo?.kind === "realigned"}
						<p>
							{#if readsInfo.changed}
								Local realignment changed <b>{readsInfo.changed} of {readsInfo.total}</b> reads in {readsInfo.window}: compare the
								two read tracks in IGV to see how.
							{:else}
								Local realignment changed <b>none of the {readsInfo.total}</b> reads in {readsInfo.window}: DeepVariant saw them
								as IGV shows them.
							{/if}
							<a href={readsInfo.url} download="realigned_reads.bam">Download the realigned reads</a>.
						</p>
					{:else if readsInfo?.kind === "phased"}
						<p>
							Long reads aren't realigned. DeepVariant phases them itself and sorts the pileup rows by haplotype; IGV groups them
							the same way (HP tag). <a href={readsInfo.url} download="phased_by_deepvariant.bam">Download the phased reads</a>.
						</p>
					{/if}
					{#if run.model.pangenome}
						<p>
							Pangenome-aware: the top half of each pileup image is the pangenome's haplotypes here, the bottom half your reads.
						</p>
					{/if}
					{#if yourRecords}
						<h3>Your VCF</h3>
						{#if !yours}
							<p>Your VCF has no record here.</p>
						{:else if agrees(selected)}
							<p class="ok">Same call: {yours.GT}, {yours.filter}, GQ {yours.GQ}.</p>
						{:else}
							<p class="differs">
								Your VCF says {yours.GT}, {yours.filter}, GQ {yours.GQ}. Differences can come from another DeepVariant version,
								model or flags; and where more reads cover a site than fit in a pileup image, from which reads DeepVariant
								sampled.
							</p>
						{/if}
					{/if}
				</div>
			</div>

			<h3 class="mt">Pileup images</h3>
			{#if selected.MID === "small_model"}
				<p class="hint">None: the small model called this from summary features, so the CNN never looked at a pileup image.</p>
			{:else if pileupError}
				<p class="bad">Couldn't draw the pileup images: {pileupError}</p>
			{:else if pileupsForSelected.length}
				<p class="hint">
					What the CNN classified (DeepVariant's show_examples): rows are {run.model.pangenome
						? "pangenome haplotypes, then your reads"
						: "reads"}, columns are positions centered on the candidate, and each panel is one channel:
				</p>
				<ol class="channels">
					{#each run.model.channels as ch (ch)}
						<li><b>{CHANNELS[ch]?.name ?? `channel ${ch}`}</b>: {CHANNELS[ch]?.about ?? ""}</li>
					{/each}
				</ol>
				{#each pileupsForSelected as p (p.name)}
					<figure>
						<a href={p.url} download="{p.name}.png"><img src={p.url} alt="pileup image {p.name}" /></a>
						<figcaption>{p.name}</figcaption>
					</figure>
				{/each}
			{:else}
				<p class="hint">Drawing pileup images…</p>
			{/if}

			<h3 class="mt">In IGV</h3>
			<div class="igv" bind:this={divIgv}></div>
		</section>
	{/if}

	<details class="card-dvi">
		<summary>Log</summary>
		<pre>{logText}</pre>
	</details>
</div>

<style>
.dvi {
	--line: var(--border);
	--muted: var(--fg-muted);
	--done: var(--ok);
	--error: var(--danger);
	max-width: 1100px;
	margin: 0 auto;
	padding: 24px 16px 48px;
	font:
		14px/1.45 system-ui,
		-apple-system,
		sans-serif;
}
h1 {
	font-size: 20px;
	margin: 0 0 4px;
}
h2 {
	font-size: 14px;
	font-weight: 600;
	margin: 0 0 10px;
}
h3 {
	font-size: 13px;
	font-weight: 600;
	margin: 0 0 6px;
}
.mt {
	margin-top: 18px;
}
.mt-s {
	margin-top: 10px;
}
.sub {
	color: var(--muted);
	margin: 0 0 20px;
}
.step-num {
	display: inline-grid;
	place-items: center;
	width: 18px;
	height: 18px;
	margin-right: 4px;
	border-radius: 50%;
	background: var(--accent);
	color: #fff;
	font-size: 11px;
}
.card-dvi {
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 10px;
	padding: 16px;
	margin-bottom: 16px;
}
.models {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
	gap: 8px;
}
.model {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
	padding: 8px 10px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg);
	color: var(--fg);
	text-align: left;
	cursor: pointer;
}
.model.active {
	border-color: var(--accent);
	box-shadow: inset 0 0 0 1px var(--accent);
}
.model-name {
	font-weight: 600;
}
.model-type {
	font:
		11px ui-monospace,
		monospace;
	color: var(--muted);
}
.model-notes {
	margin-top: 8px;
}
.inputs {
	display: grid;
	grid-template-columns: 1.5fr 1fr;
	gap: 16px 32px;
	align-items: start;
}
@media (max-width: 860px) {
	.inputs {
		grid-template-columns: 1fr;
	}
}
.inputs label:not(.field) {
	display: block;
}
.indent {
	margin: 4px 0 10px 22px;
}
select.indent {
	width: calc(100% - 22px);
}
.choice {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 16px;
	margin-bottom: 6px;
}
input.url {
	font-size: 12px;
}
.mt-xs {
	margin-top: 4px;
}
.uploads input[type="file"] {
	font-size: 12px;
	max-width: 100%;
}
.field {
	display: block;
	font-weight: 600;
	margin-bottom: 6px;
}
input[type="text"],
select {
	width: 100%;
	padding: 7px 9px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--bg);
	color: var(--fg);
	font:
		14px ui-monospace,
		monospace;
}
input:disabled,
select:disabled {
	opacity: 0.7;
}
.only-reads {
	margin: 0 0 0.5rem;
}
.hint {
	color: var(--muted);
	font-size: 12px;
	margin-top: 6px;
}
.bad,
.differs {
	color: var(--error);
}
.ok {
	color: var(--done);
}
.run-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 12px 16px;
	margin-top: 16px;
}
button.run {
	padding: 9px 22px;
	border: 0;
	border-radius: 6px;
	background: var(--accent);
	color: #fff;
	font: 600 14px system-ui;
	cursor: pointer;
}
button.run:disabled {
	opacity: 0.45;
	cursor: default;
}
button.link {
	border: 0;
	background: none;
	color: var(--accent);
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}
.steps {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
}
.step {
	font:
		12px ui-monospace,
		monospace;
	padding: 2px 8px;
	border-radius: 10px;
	border: 1px solid var(--line);
	color: var(--muted);
}
.step.running {
	border-color: var(--accent);
	color: var(--accent);
}
.step.done {
	border-color: var(--done);
	color: var(--done);
}
.step.error {
	border-color: var(--error);
	color: var(--error);
}
.title-row {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 12px;
}
.tiles {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
	gap: 8px;
}
.tile {
	display: flex;
	flex-direction: column;
	padding: 8px 10px;
	border: 1px solid var(--line);
	border-radius: 8px;
	color: var(--muted);
	font-size: 12px;
}
.tile b {
	color: var(--fg);
	font-size: 18px;
	font-variant-numeric: tabular-nums;
}
.gq {
	margin-top: 12px;
}
.bars {
	display: flex;
	align-items: flex-end;
	gap: 4px;
	height: 80px;
	margin-top: 4px;
}
.bar-col {
	flex: 1;
	height: 100%;
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
	align-items: center;
	font-size: 10px;
	color: var(--muted);
}
.bar {
	width: 100%;
	min-height: 1px;
	background: var(--accent);
	border-radius: 3px 3px 0 0;
}
.bar.low {
	background: var(--warning);
}
.tabs {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
}
.tabs button {
	padding: 4px 10px;
	border: 1px solid var(--line);
	border-radius: 14px;
	background: var(--bg);
	color: var(--fg);
	font-size: 12px;
	cursor: pointer;
}
.tabs button.active {
	border-color: var(--accent);
	color: var(--accent);
}
.count {
	color: var(--muted);
}
.tabs .filter {
	width: 200px;
	margin-left: auto;
	padding: 4px 8px;
	font-size: 12px;
}
.tablewrap {
	overflow: auto;
	max-height: 320px;
	border: 1px solid var(--line);
	border-radius: 6px;
}
.tablewrap.short {
	max-height: 260px;
}
table {
	border-collapse: collapse;
	width: 100%;
	font:
		12.5px ui-monospace,
		monospace;
}
th,
td {
	padding: 5px 10px;
	text-align: left;
	white-space: nowrap;
	border-bottom: 1px solid var(--line);
}
th {
	position: sticky;
	top: 0;
	background: var(--bg-subtle);
}
td.num {
	text-align: right;
}
td.allele {
	max-width: 160px;
	overflow: hidden;
	text-overflow: ellipsis;
}
tbody tr {
	cursor: pointer;
}
tbody tr:hover td,
tr.active td {
	background: var(--accent-subtle);
}
tr.filtered td {
	color: var(--muted);
}
.detail {
	display: grid;
	grid-template-columns: minmax(220px, 1fr) 2fr;
	gap: 16px 28px;
}
@media (max-width: 760px) {
	.detail {
		grid-template-columns: 1fr;
	}
}
.detail p {
	margin: 0 0 8px;
}
.probs {
	display: grid;
	gap: 4px;
}
.prob {
	display: grid;
	grid-template-columns: 36px 1fr 56px;
	align-items: center;
	gap: 8px;
	font:
		12px ui-monospace,
		monospace;
}
.prob-bar {
	height: 10px;
	background: var(--bg-subtle);
	border-radius: 5px;
	overflow: hidden;
}
.prob-bar div {
	height: 100%;
	background: var(--accent);
}
.prob .p {
	text-align: right;
	color: var(--muted);
}
.igv {
	border: 1px solid var(--line);
	border-radius: 6px;
	min-height: 200px;
	background: #fff;
}
.channels {
	columns: 2 280px;
	font-size: 12px;
	color: var(--muted);
	margin: 0 0 10px;
	padding-left: 20px;
}
.channels b {
	color: var(--fg);
	font-weight: 600;
}
figure {
	margin: 0 0 12px;
}
figure img {
	display: block;
	width: 100%;
	max-width: 1547px;
	image-rendering: pixelated;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: #000;
}
figcaption {
	font:
		12px ui-monospace,
		monospace;
	color: var(--muted);
	margin-top: 4px;
}
pre {
	max-height: 300px;
	overflow: auto;
	font-size: 12px;
	background: var(--bg-subtle);
	padding: 8px;
	margin: 10px 0 0;
}
summary {
	cursor: pointer;
	font-weight: 600;
}
</style>
