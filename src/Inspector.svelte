<script>
// Inspect DeepVariant calls: pick the model your data was called with, give it your reads (or use an example)
// and a position, and DeepVariant 1.10 runs again in the browser on that locus. For each call it shows what DeepVariant looked at: the reads after its local
// realignment (short reads) or with its own phasing (long reads), the pangenome haplotypes (pangenome-aware),
// the pileup images and the genotype probabilities. With your DeepVariant VCF, it also summarizes your calls,
// lists the ones worth a closer look, and compares each rerun call with the record in your VCF.
// How it's built: wasm/README.md
import { onDestroy, onMount, tick } from "svelte";
import Aioli from "@biowasm/aioli";
import {
	CHANNELS,
	MODELS,
	truthRecords,
	READ_TYPES,
	exampleRegion,
	modelByKey,
	partitionsAround,
	sameSiteElsewhere
} from "./models.js";
import { GQ_LOW, LIST_MAX, recordsIn, scanVcf, vcfFile } from "./vcf.js";
import { aliasFai, guessReference, locateReads } from "./bam.js";
import { makeZip, readZip } from "./bundle.js";
import { alleleView, referenceSequence, windowAround } from "./alleles.js";

// DeepVariant for the browser (wasm/build.sh or `npm run assets`), served with the app
const URL_DEEPVARIANT = new URL(`${import.meta.env.BASE_URL}deepvariant/1.10.0`, location.href).href;

// The references IGV uses (igv.js's hg19/hg38), read on demand: only the region's sequence is downloaded
const URL_IGV = "https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq";
const REFERENCES = {
	hg38: { name: "GRCh38 / hg38", fasta: `${URL_IGV}/hg38/hg38.fa`, fai: `${URL_IGV}/hg38/hg38.fa.fai` },
	hg19: { name: "GRCh37 / hg19", fasta: `${URL_IGV}/hg19/hg19.fasta`, fai: `${URL_IGV}/hg19/hg19.fasta.fai` }
};
const EXAMPLE_REFERENCE = "hg38"; // all examples are HG003 on GRCh38
const DV_VERSION = "1.10.0"; // what this page runs
// postprocess_variants --cnn_homref_call_min_gq: the CNN's reference calls with a lower GQ are written ./.
const HOMREF_MIN_GQ = 20;
const MAX_REGION = 200000; // bp: larger regions would take minutes in the browser
// Whole-genome BAMs from DeepVariant's case studies, to try reads by URL: 42basepairs serves DeepVariant's
// bucket with range requests and CORS (the bucket itself has no CORS)
const URL_42BP = "https://42basepairs.com/download/gs/deepvariant";
const BIG_BAMS = [
	{
		label: "Illumina WGS 35x",
		size: "46.8 GB",
		model: "wgs",
		url: `${URL_42BP}/case-study-testdata/HG003.novaseq.pcr-free.35x.dedup.grch38_no_alt.bam`,
		position: "chr20:31,460,620"
	},
	{
		label: "PacBio HiFi",
		size: "50.3 GB",
		model: "pacbio",
		url: `${URL_42BP}/pacbio-case-study-testdata/HG003.SPRQ.pacbio.GRCh38.nov2024.bam`,
		position: "chr20:9,156,819"
	}
];

// Inputs
let modelKey = $state("wgs");
// "example" | "upload": the examples (the home page), or your own data. App's "Inspect your own data" button
// switches with pickSource, below.
let { source = $bindable("example") } = $props();
let exampleIndex = $state(0);
let readsFrom = $state("url"); // "url" | "file"
let files = $state([]); // the reads, from your computer
let readsUrl = $state(""); // or from a URL
let indexUrl = $state(""); // its index ("" = the BAM's URL + .bai)
let pangenomeFiles = $state([]);
let captureText = $state(""); // WES capture BED, to run on whole capture intervals
let referenceKey = $state("hg38");
let regionText = $state(""); // "" = pick one where the reads are
let readsSpan = $state.raw(null); // where your reads are: {contigs, chrom, start, end} | {error}
let referenceDetected = $state(false);

// Your DeepVariant VCF
let vcfInput = $state(null); // File
let vcfScan = $state.raw(null); // read once and never changed: raw, so its 100,000s of records aren't made reactive
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
let yourRecords = $state.raw(null); // your VCF's records in the region (null: no VCF)
let selected = $state(null);
let pileupsForSelected = $state([]);
let pileupError = $state("");
let readsInfo = $state(null); // {kind: "realigned" | "phased", window?, changed?, total?, url}
let linkCopied = $state(false);
let tab = $state("calls"); // under the selected call: "calls" (all calls in the region) | "log"
let baseView = $state(null); // the selected call's alleles, base by base (alleles.js), or {error}
let pileupIndex = $state(0); // which of the selected call's pileup images is shown
let openModel = $state("wgs"); // the model open in the examples list
let hasRun = $state(false); // your data: a run has started (then the inputs fold into one line)
let editing = $state(true); // your data: the inputs are shown in full (else, after a run, as one line)
let queued = false; // an example picked while another runs: run it next
// What DeepVariant counted around the position you asked about: {rows, thresholds} (worker.mjs, watch)
let alleleCounts = $state.raw(null);
// No candidate where you asked: {chrom, pos, nearest: the closest calls, realigned: bool}
let noCandidate = $state.raw(null);
// How the last run differed from a normal one: {force?: [{chrom, pos, ref, alt}], cnnOnly?: bool,
// before?: the small model's call that the CNN was asked about}
let ranMode = $state.raw(null);
let bundling = $state(""); // what "Download this locus" is doing, "" when idle
let bundleError = $state("");
let listType = $state("all"); // your VCF's lists: "all" | "snp" | "indel"
let listSort = $state("pos"); // "pos" | "gq": lowest GQ first
// {model, reference, reads: {bam, index}, pangenome?, example?, position, realigned: [...], phased?: File,
//  vcfFile, yourVcf?: File, pileups: Promise}
let run = null;

let worker, igvBrowser, igvModule, samtools;
let divIgv = $state();

const model = $derived(modelByKey(modelKey));
const examples = $derived(model.examples);
const example = $derived(examples[Math.min(exampleIndex, examples.length - 1)]);
const reference = $derived(REFERENCES[source === "example" ? EXAMPLE_REFERENCE : referenceKey]);
// Your BAM's contigs named 1, 2, ... (b37, hs37d5, Ensembl) rather than chr1, chr2, ...
const bareContigs = $derived(
	Boolean(readsSpan?.contigs?.some((c) => c.name === "1" || c.name === "20") && !readsSpan.contigs.some((c) => c.name === "chr1"))
);
// The reference with its contigs named as your BAM's (see aliasFai): the same FASTA, read through a renamed .fai
const aliased = new Map();
async function referenceFor(key, contigs) {
	const base = REFERENCES[key];
	if (!contigs?.length) return base;
	const id = `${key} ${contigs
		.slice(0, 30)
		.map((c) => c.name)
		.join(",")}`;
	if (!aliased.has(id)) {
		const response = await fetch(base.fai);
		if (!response.ok) throw new Error(`Couldn't read the reference's index: HTTP ${response.status}`);
		const { text, renamed } = aliasFai(await response.text(), contigs);
		aliased.set(id, renamed ? { ...base, fai: URL.createObjectURL(new Blob([text], { type: "text/plain" })) } : base);
	}
	return aliased.get(id);
}
const reads = $derived(readsFrom === "url" ? pickUrl(readsUrl, indexUrl) : pickBam(files, "reads"));
const pangenomeReads = $derived(pickBam(pangenomeFiles, "pangenome"));
const capture = $derived(parseBed(captureText));
// The model, guessed from the reads' file name (HG003.novaseq..., HG003_R104_sup..., *.pacbio.*): sets the
// model when the reads change; pick another and it stays
const MODEL_WORDS = [
	["wes", ["wes", "exome", "wxs"]],
	["hybrid_pacbio_illumina", ["hybrid"]],
	["pacbio", ["pacbio", "hifi", "ccs", "sprq", "revio", "sequel"]],
	["ont_r104", ["ont", "nanopore", "r104", "r10", "promethion", "minion", "dorado"]],
	["wgs", ["wgs", "illumina", "novaseq", "hiseq", "nextseq"]]
];
function guessModel(name) {
	const words = name.toLowerCase().split(/[^a-z0-9]+/);
	for (const [key, list] of MODEL_WORDS) {
		const word = list.find((w) => words.includes(w));
		if (word) return { key, word };
	}
	return null;
}
let modelGuess = $state(null);
$effect(() => {
	const name = reads.url ? reads.url.split("/").pop().split("?")[0] : reads.alignments?.name;
	const guess = name ? guessModel(name) : null;
	modelGuess = guess;
	if (guess && source === "upload") modelKey = guess.key;
});

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
// CRAM needs the reference's sequence to decode, whole chromosomes of it: too much for the browser
const CRAM_HELP =
	"CRAM isn't read here: decoding it needs the reference's sequence. Make a BAM of the locus instead: samtools view -b -T reference.fa sample.cram chr20:1000000-1100000 > locus.bam";
function pickBam(list, what) {
	const cram = list.find((f) => /\.cram$/i.test(f.name));
	if (cram) return { error: CRAM_HELP };
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
	if (/\.cram$/i.test(parsed.pathname)) return { error: CRAM_HELP };
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
// Only the latest load counts: picking another VCF while one is read drops the first
let vcfLoad = 0;
async function loadVcf(file) {
	const load = ++vcfLoad;
	vcfInput = file;
	vcfScan = null;
	vcfError = "";
	vcfProgress = 0;
	if (!file) return;
	try {
		const scan = await scanVcf(file, (p) => load === vcfLoad && (vcfProgress = p));
		if (load === vcfLoad) vcfScan = scan;
	} catch (e) {
		if (load === vcfLoad) vcfError = e.message ?? String(e);
	}
}

const LISTS = {
	lowGq: { name: `PASS with GQ < ${GQ_LOW}`, about: "Called, but not confidently" },
	noCall: {
		name: "No-calls (./.)",
		about: `Mostly candidates the CNN thinks are reference, but with GQ under ${HOMREF_MIN_GQ}: written ./. instead of 0/0`
	},
	hetAlt: { name: "Two alternate alleles (1/2)", about: "Multiallelic calls, often in repeats" }
};
const listShown = $derived.by(() => {
	if (!vcfScan) return { total: 0, rows: [] };
	const q = listFilter.replace(/[,\s]/g, "").toLowerCase();
	let list = vcfScan.lists[listKey];
	if (q) list = list.filter((r) => `${r.chrom}:${r.pos}`.toLowerCase().includes(q));
	if (listType !== "all") list = list.filter((r) => isIndel(r) === (listType === "indel"));
	if (listSort === "gq") list = list.toSorted((a, b) => Number(a.GQ) - Number(b.GQ));
	return { total: list.length, rows: list.slice(0, 300) };
});
const isIndel = (r) => r.alt.split(",").some((a) => a !== "<*>" && a.length !== r.ref.length);
// Your VCF's DeepVariant version, when it isn't the one this page runs (1.10.x)
const otherVersion = $derived(
	vcfScan?.version && vcfScan.version.split(".").slice(0, 2).join(".") !== DV_VERSION.split(".").slice(0, 2).join(".")
		? vcfScan.version
		: null
);

function inspectRecord(r) {
	regionText = `${r.chrom}:${r.pos.toLocaleString("en-US")}`;
	if (source === "example") source = "upload";
	if (canRun) runDeepVariant();
	else {
		editing = true;
		tick().then(() => document.getElementById("dvi-setup")?.scrollIntoView({ behavior: "smooth" }));
	}
}

// ---------------------------------------------------------------------------------------------------------
// Running DeepVariant
// ---------------------------------------------------------------------------------------------------------
// force: consider only these candidates ([{chrom, pos, ref, alt}]), whatever the reads show; cnnOnly: no small
// model, so the CNN calls every candidate; before: the small model's call the CNN is asked about
async function runDeepVariant({ force = null, cnnOnly = false, before = null } = {}) {
	if (busy) {
		queued = true;
		return;
	}
	error = "";
	editing = false;
	hasRun = source === "upload";
	finished = false;
	calls = [];
	selected = null;
	yourRecords = null;
	alleleCounts = null;
	noCandidate = null;
	bundleError = "";
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
		// The BAM's contigs, for the position (if none was given) and the reference's contig names
		if (source === "upload" && !readsSpan?.contigs) {
			busy = "Finding where your reads are…";
			try {
				found(await locateReads(input.bam, input.index));
			} catch (e) {
				if (region.pending) throw e;
			}
		}
		if (region.error) throw new Error(region.error);
		const ref = source === "upload" ? await referenceFor(referenceKey, readsSpan?.contigs) : reference;
		busy = `Running DeepVariant (${model.modelType} model)…`;
		ranRegion = region.text;
		ranModel = model;
		ranMode = force || cnnOnly ? { force, cnnOnly, before } : null;
		// The position asked about: a forced candidate's, the example's, or the one you entered
		const target = force?.[0].pos ?? before?.pos ?? (source === "example" ? example.pos : region.position ? region.start : null);
		run = {
			model,
			reference: ref,
			referenceKey: source === "example" ? EXAMPLE_REFERENCE : referenceKey,
			reads: input,
			pangenome,
			example: source === "example" ? example : null,
			position: region,
			target,
			force,
			asked: Boolean(force || before) // a call or allele you asked about, even among the examples
		};
		updateUrl();
		worker.postMessage({
			cmd: "run",
			region: region.text,
			bam: input.bam,
			index: input.index,
			reference: { fasta: ref.fasta, fai: ref.fai },
			realigned: true,
			model: model.key,
			pangenome: pangenome?.bam,
			pangenomeIndex: pangenome?.index,
			watch: target ? { chrom: region.chrom, pos: target } : undefined,
			cnnOnly,
			force: force ?? undefined
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

function onDone({ vcfLines, vcfText, realignedReads, phasedReads, alleleCounts: counts }) {
	// Another example was picked meanwhile: run that instead
	if (queued) {
		queued = false;
		busy = "";
		runDeepVariant();
		return;
	}
	// You switched between the examples and your data while it ran: its results aren't for this view
	if (Boolean(run?.example) !== (source === "example")) {
		busy = "";
		return;
	}
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
	alleleCounts = counts ?? null;
	const target = run.target;
	const near = (call) => Math.abs(call.pos - target);
	const closest = target ? calls.toSorted((a, b) => near(a) - near(b))[0] : null;
	const any = calls.find((c) => c.filter === "PASS") || calls[0];
	// An example: the call closest to it (an indel may be placed a few bp off)
	if (run.example && !run.asked) {
		if (calls.length) select(closest && near(closest) <= 50 ? closest : any);
	} else if (target) {
		// A position you asked about: the call there (an insertion is at the base before it), or else what
		// DeepVariant counted there and why that made no candidate. Never some other call, unasked.
		const there = calls.filter((c) => c.pos - 1 <= target && target <= c.pos + c.ref.length);
		if (there.length) select(there.toSorted((a, b) => near(a) - near(b))[0]);
		else showNoCandidate(target);
	} else if (calls.length) select(any);
}

// Nothing was called where you asked: show the reads there, and (in the page) what DeepVariant counted
async function showNoCandidate(pos) {
	const chrom = run.position.chrom;
	const near = (call) => Math.abs(call.pos - pos);
	const realigned = run.model.realigns ? windowFor({ chrom, pos }) : null;
	selected = null;
	pileupsForSelected = [];
	baseView = null;
	readsInfo = null;
	noCandidate = { chrom, pos, nearest: calls.toSorted((a, b) => near(a) - near(b)).slice(0, 3), realigned: Boolean(realigned) };
	await tick();
	const halfWidth = Math.max(15, Math.floor((divIgv?.clientWidth || 900) / 24));
	await showInIgv(`${chrom}:${pos - halfWidth}-${pos + halfWidth}`, realigned);
}

// The alleles DeepVariant counted at and around the position with no candidate, each against the thresholds a
// candidate has to pass (make_examples' --vsc_min_count_* and --vsc_min_fraction_*, as this model sets them)
const counted = $derived.by(() => {
	if (!noCandidate || !alleleCounts) return null;
	const t = alleleCounts.thresholds;
	const { chrom, pos } = noCandidate;
	const alleles = [];
	for (const row of alleleCounts.rows) {
		const total = row.refCount + row.alleles.reduce((n, a) => n + a.count, 0);
		for (const a of row.alleles) {
			if (!["SUBSTITUTION", "INSERTION", "DELETION"].includes(a.type)) continue;
			const indel = a.type !== "SUBSTITUTION";
			// At the position (or, for an indel, the base before it, where VCF puts it); nearby, only what 2+ reads show
			const here = row.pos === pos || (indel && row.pos === pos - 1);
			if (!here && a.count < 2) continue;
			const minCount = indel ? t.minCountIndels : t.minCountSnps,
				minFraction = Math.round((indel ? t.minFractionIndels : t.minFractionSnps) * 1000) / 1000;
			const fraction = total ? a.count / total : 0;
			const record = a.type === "DELETION" ? { ref: a.bases, alt: a.bases[0] } : { ref: row.ref, alt: a.bases };
			const call = calls.find((c) => c.pos === row.pos);
			alleles.push({
				chrom,
				pos: row.pos,
				...record,
				here,
				count: a.count,
				total,
				fraction,
				minFraction,
				call,
				why:
					a.count < minCount
						? `${a.count} read: a candidate needs ${minCount}`
						: fraction < minFraction
							? `under the ${+(minFraction * 100).toFixed(1)}% a candidate needs`
							: call
								? "a candidate: it's one of this run's calls"
								: "enough reads, yet no candidate"
			});
		}
	}
	alleles.sort((a, b) => Number(b.here) - Number(a.here) || b.count - a.count);
	const at = alleleCounts.rows.find((r) => r.pos === pos);
	return {
		alleles: alleles.slice(0, 8),
		at: at && { ref: at.ref, refCount: at.refCount, total: at.refCount + at.alleles.reduce((n, a) => n + a.count, 0) },
		thresholds: {
			minCountSnps: t.minCountSnps,
			minCountIndels: t.minCountIndels,
			snps: +(t.minFractionSnps * 100).toFixed(1),
			indels: +(t.minFractionIndels * 100).toFixed(1)
		}
	};
});
// Your VCF's record at the position with no candidate, if it has one: it can be forced too
const yoursAtPosition = $derived(
	noCandidate && yourRecords
		? (yourRecords.find(
				(r) => r.chrom === noCandidate.chrom && r.pos - 1 <= noCandidate.pos && noCandidate.pos <= r.pos + r.ref.length
			) ?? null)
		: null
);

// Make DeepVariant consider a candidate it didn't (too few reads show it), to see the pileup image and what the
// CNN makes of it. DeepVariant's own route for genotyping given alleles: --variant_caller=vcf_candidate_importer.
function forceCandidate({ chrom, pos, ref, alt }) {
	const forced = alt.split(",").map((a) => ({ chrom, pos, ref, alt: a }));
	if (source === "upload") regionText = `${chrom}:${pos.toLocaleString("en-US")}`;
	runDeepVariant({ force: forced });
}
// A small-model call, by the CNN instead: the same region with the small model off
function askCnn(call) {
	if (source === "upload") regionText = `${call.chrom}:${call.pos.toLocaleString("en-US")}`;
	runDeepVariant({ cnnOnly: true, before: { pos: call.pos, GT: call.GT, GQ: call.GQ, filter: call.filter } });
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

// Scroll the bases so the call's position is in view (on a narrow screen, the window is wider than it)
function centerOnCall(node) {
	const center = () => {
		const at = node.querySelector(".at");
		if (at) node.scrollLeft = at.offsetLeft - node.clientWidth / 2;
	};
	center();
	return { update: () => tick().then(center) };
}

// The alleles around a call, base by base: GIAB's truth (examples), DeepVariant's calls (this run) and your
// VCF's, each as two haplotypes against the reference
async function showBases(call) {
	baseView = null;
	const rec = (c) => ({ pos: c.pos, ref: c.ref, alt: c.alt, gt: c.GT ?? c.gt });
	const near = (r) => r.chrom === call.chrom && Math.abs(r.pos - call.pos) <= 30;
	const truth = run.example ? truthRecords(run.example)?.filter(near) : null;
	const seed = windowAround([rec(call), ...(truth ?? [])]);
	const overlaps = (r) => r.chrom === call.chrom && r.pos <= seed.end && r.pos + r.ref.length - 1 >= seed.start;
	// DeepVariant's: what it called around here (PASS), and the selected call whatever its filter
	const dv = calls.filter((c) => overlaps(c) && (c === call || c.filter === "PASS")).map(rec);
	const yoursHere = yourRecords?.filter((r) => overlaps(r) && r.filter === "PASS").map(rec);
	const w = windowAround([...dv, ...(truth ?? []), ...(yoursHere ?? [])]);
	try {
		const window = await referenceSequence(run.reference, call.chrom, w.start, w.end);
		if (selected !== call) return;
		const sets = [
			...(truth?.length ? [{ label: "Truth (GIAB v4.2.1)", short: "the truth", records: truth }] : []),
			{ label: "DeepVariant", short: "DeepVariant", records: dv },
			...(yoursHere ? [{ label: "Your VCF", short: "your VCF", records: yoursHere }] : [])
		];
		const view = alleleView(window, sets);
		view.sets.forEach((v, i) => (v.short = sets[i].short));
		baseView = view;
	} catch (e) {
		if (selected === call) baseView = { error: e.message ?? String(e) };
	}
}

async function select(call) {
	selected = call;
	noCandidate = null;
	pileupsForSelected = [];
	pileupIndex = 0;
	pileupError = "";
	showBases(call);
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
	// As many bases as fit at ~12 px each, so IGV can draw them as letters
	const halfWidth = Math.max(15, Math.floor((divIgv?.clientWidth || 900) / 24));
	await showInIgv(`${call.chrom}:${call.pos - halfWidth}-${call.pos + halfWidth}`, realigned);
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
// Read tracks with mismatched bases as letters: IGV draws letters at 10+ px per base, in rows 10+ px tall, so the
// view is zoomed in and rows are 11 px. Insertions show their length on the marker.
const IGV_READS = { height: 230, coverageTrackHeight: 24, alignmentRowHeight: 11, showInsertionText: true };
async function showInIgv(locus, realigned) {
	const realignedTrack = realigned && {
		name: NAME_REALIGNED,
		type: "alignment",
		format: "bam",
		...IGV_READS,
		url: realigned.file,
		indexed: false
	};
	if (!igvBrowser) {
		igvModule ??= (await import("igv")).default;
		const tracks = [
			{
				name: "This run (DeepVariant 1.10 in your browser)",
				type: "variant",
				format: "vcf",
				url: run.vcfFile,
				indexed: false,
				height: 30
			},
			...(run.yourVcf
				? [{ name: "Your DeepVariant VCF", type: "variant", format: "vcf", url: run.yourVcf, indexed: false }]
				: []),
			{
				name: "Your reads (as aligned, what IGV shows)",
				type: "alignment",
				format: "bam",
				...IGV_READS,
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
							...IGV_READS,
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
// From the examples list: an example of any model, run right away (or once DeepVariant has loaded)
function inspectExample(key, i) {
	modelKey = key;
	openModel = key;
	pickExample(i);
	updateUrl();
	if (ready) runDeepVariant();
}
function clearResults() {
	calls = [];
	selected = null;
	alleleCounts = null;
	noCandidate = null;
	ranMode = null;
	finished = false;
	yourRecords = null;
	error = "";
	steps = { python: steps.python, models: steps.models };
	if (igvBrowser) igvModule.removeBrowser(igvBrowser);
	igvBrowser = null;
}
// DeepVariant's own calls for those BAMs (the official 1.10 case-study VCFs, chr20), served with the app
const EXAMPLE_VCFS = [
	{ label: "Illumina WGS", size: "3.6 MB", path: "data/HG003.wgs.chr20.deepvariant.vcf.bgz" },
	{ label: "PacBio HiFi", size: "4.1 MB", path: "data/HG003.pacbio.chr20.deepvariant.vcf.bgz" }
];
async function tryVcf(v) {
	// Shown at once, while it downloads
	const name = v.path.split("/").pop();
	vcfInput = { name };
	vcfScan = null;
	vcfError = "";
	vcfProgress = 0;
	try {
		const file = await fetchFile(v.path);
		setInputFiles("dvi-vcf", [file]); // so the file input shows it, not "No file chosen"
		await loadVcf(file);
	} catch (e) {
		vcfError = e.message ?? String(e);
	}
}
const vcfBusy = $derived(Boolean(vcfInput && !vcfScan && !vcfError));
// Puts files in a file input, as if they'd been picked (without firing its change event)
function setInputFiles(id, list) {
	const input = document.getElementById(id);
	if (!input) return;
	const transfer = new DataTransfer();
	for (const f of list) transfer.items.add(f);
	input.files = transfer.files;
}

// ---------------------------------------------------------------------------------------------------------
// A locus as one file (bundle.js): the reads at the locus, this run's calls, what DeepVariant made of the reads
// and the pileup images, to attach to an issue or send to someone, who can open it here. No server involved.
// ---------------------------------------------------------------------------------------------------------
// The reads overlapping a region, cut from a local BAM with samtools (the records as they are, with its index)
async function cutReads({ bam, index }, regionText) {
	samtools ??= new Aioli(["samtools/1.21"], { printInterleaved: false });
	const CLI = await samtools;
	const ext = index.name.toLowerCase().endsWith(".csi") ? "csi" : "bai";
	const [input] = await CLI.mount([
		{ name: "bundle_in.bam", data: bam },
		{ name: `bundle_in.bam.${ext}`, data: index }
	]);
	for (const cmd of [`samtools view -b -o locus.bam ${input} ${regionText}`, "samtools index locus.bam"]) {
		const { stderr } = await CLI.exec(cmd);
		if (stderr.trim()) logText += `${cmd}\n${stderr}`;
	}
	const read = async (path) => {
		const stat = await CLI.ls(path);
		if (!stat) throw new Error("samtools couldn't cut the reads at the locus; see the log.");
		return CLI.read({ path, length: stat.size });
	};
	return { bam: await read("locus.bam"), index: await read("locus.bam.bai") };
}
async function downloadBundle() {
	if (bundling || !run || !finished) return;
	bundleError = "";
	try {
		const { position } = run;
		const at = selected?.pos ?? noCandidate?.pos ?? position.start;
		// The reads DeepVariant read (the run's partitions) and a little more, for context in IGV
		const locus = `${position.chrom}:${Math.max(1, position.runStart - 1000)}-${position.runEnd + 1000}`;
		const entries = [];
		const manifest = {
			app: "inspector-for-deepvariant",
			deepvariant: DV_VERSION,
			model: run.model.key,
			modelType: run.model.modelType,
			reference: run.referenceKey,
			position: `${position.chrom}:${at}`,
			ran: ranRegion,
			readsCut: locus,
			force: run.force ?? undefined,
			yourVcfVersion: run.yourVcf ? (vcfScan?.version ?? undefined) : undefined
		};
		bundling = "Cutting the reads at the locus…";
		for (const [what, from] of [
			["reads", run.reads],
			["pangenome", run.pangenome]
		]) {
			if (!from) continue;
			if (typeof from.bam === "string") manifest[what] = { url: from.bam, index: from.index };
			else {
				const cut = await cutReads(from, locus);
				entries.push({ name: `${what}.bam`, data: cut.bam }, { name: `${what}.bam.bai`, data: cut.index });
				manifest[what] = { file: `${what}.bam` };
			}
		}
		bundling = "Packing…";
		entries.push({ name: "deepvariant.vcf", data: run.vcfFile });
		if (run.yourVcf) {
			entries.push({ name: "your_deepvariant.vcf", data: run.yourVcf });
			manifest.yourVcf = "your_deepvariant.vcf";
		}
		for (const r of run.realigned) entries.push({ name: `seen_by_deepvariant/${r.file.name}`, data: r.file });
		if (run.phased) entries.push({ name: "seen_by_deepvariant/phased_by_deepvariant.bam", data: run.phased });
		for (const p of await run.pileups.catch(() => []))
			entries.push({ name: `pileups/${p.name.replace(/[^\w.>|-]+/g, "_")}.png`, data: await (await fetch(p.url)).blob() });
		const readme = [
			`Inspector for DeepVariant: ${manifest.position}`,
			"",
			`DeepVariant ${DV_VERSION}, ${run.model.modelType} model, on ${ranRegion} (${REFERENCES[run.referenceKey].name}).`,
			`Open this .zip at ${location.origin}${location.pathname} ("Inspect your own data", then pick it as the reads)`,
			"to rerun DeepVariant on these reads and see the call.",
			"",
			manifest.reads?.file ? `reads.bam: the reads overlapping ${locus}, as aligned` : `reads: ${manifest.reads?.url}`,
			"deepvariant.vcf: this run's calls",
			...(run.yourVcf ? ["your_deepvariant.vcf: the same region of the VCF this was compared with"] : []),
			"seen_by_deepvariant/: the reads after DeepVariant's local realignment, or with its own phasing",
			"pileups/: the pileup images the CNN classified",
			"manifest.json: the model, reference and position, for the page"
		].join("\n");
		entries.unshift({ name: "README.txt", data: readme }, { name: "manifest.json", data: JSON.stringify(manifest, null, "\t") });
		const url = URL.createObjectURL(await makeZip(entries));
		const a = Object.assign(document.createElement("a"), { href: url, download: `deepvariant_${position.chrom}_${at}.zip` });
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	} catch (e) {
		bundleError = e.message ?? String(e);
	}
	bundling = "";
}
// A bundle picked as the reads: fills in the inputs from it and runs
let openWhenReady = false;
async function openBundle(file) {
	error = "";
	try {
		const entries = await readZip(file);
		const manifest = JSON.parse((await entries.get("manifest.json")?.text()) ?? "null");
		if (manifest?.app !== "inspector-for-deepvariant")
			throw new Error(`${file.name} isn't a locus saved from this page (no manifest.json).`);
		const asFile = (name) => entries.get(name) && new File([entries.get(name)], name);
		const pair = (what) => [asFile(`${what}.bam`), asFile(`${what}.bam.bai`)].filter(Boolean);
		clearResults();
		if (modelByKey(manifest.model)) modelKey = manifest.model;
		if (REFERENCES[manifest.reference]) referenceKey = manifest.reference;
		regionText = manifest.position ?? "";
		if (manifest.reads?.url) {
			readsFrom = "url";
			readsUrl = manifest.reads.url;
			indexUrl = manifest.reads.index ?? "";
		} else {
			readsFrom = "file";
			files = pair("reads");
		}
		pangenomeFiles = pair("pangenome");
		const yourVcf = manifest.yourVcf && asFile(manifest.yourVcf);
		await tick();
		if (readsFrom === "file") setInputFiles("dvi-reads", files);
		if (yourVcf) {
			setInputFiles("dvi-vcf", [yourVcf]);
			await loadVcf(yourVcf);
		}
		await tick();
		if (canRun) runDeepVariant(manifest.force ? { force: manifest.force } : {});
		else openWhenReady = manifest.force ? { force: manifest.force } : {};
	} catch (e) {
		error = e.message ?? String(e);
	}
}
function pickReads(list) {
	const bundle = list.find((f) => /\.zip$/i.test(f.name));
	if (bundle) openBundle(bundle);
	else files = list;
}

// A whole-genome BAM by URL, with its model and a position worth a look
function tryBigBam(b) {
	modelKey = b.model;
	readsFrom = "url";
	readsUrl = b.url;
	indexUrl = "";
	regionText = b.position;
}
export function pickSource(value) {
	// The example's position isn't yours: leave it empty, to use where your reads are
	if (value === "upload" && regionText === exampleRegion(model, example)) regionText = "";
	// The other mode's results don't carry over
	if (value !== source) clearResults();
	source = value;
	editing = true;
	if (value === "example") {
		pickExample(exampleIndex);
		if (ready && !finished) runDeepVariant();
	}
	updateUrl();
	window.scrollTo({ top: 0 });
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
	openModel = modelKey;

	worker = new Worker(`${URL_DEEPVARIANT}/worker.mjs`, { type: "module" });
	worker.onmessage = ({ data: m }) => {
		// (htslib looks for an index next to the realigned reads DeepVariant writes, which need none)
		if (m.type === "log") logText += m.text.replace(/^\[E::idx_find_and_load\].*\n?/gm, "") + "\n";
		else if (m.type === "step") steps = { ...steps, [m.step]: m.state };
		else if (m.type === "ready") {
			ready = true;
			if (source === "example")
				runDeepVariant(); // the home page shows an example, run as soon as it can be
			else if (openWhenReady) {
				const options = openWhenReady;
				openWhenReady = false;
				tick().then(() => canRun && runDeepVariant(options));
			}
		} else if (m.type === "done") onDone(m);
		else if (m.type === "pileups") {
			const { pileupsPending, model: ranWith } = run;
			Promise.all(
				m.images.map(async ({ name, bytes }) => {
					const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
					const panels = await channelPanels(url, ranWith.channels.length).catch(() => null);
					return { name: name.replace(/\.png$/, ""), url, panels };
				})
			).then(pileupsPending.resolve, pileupsPending.reject);
		} else if (m.type === "error") {
			if (run?.pileupsPending && calls.length) run.pileupsPending.reject(new Error(m.text));
			else error = m.text;
			busy = "";
			if (queued) {
				queued = false;
				runDeepVariant();
			}
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
// (a run without the small model writes no MID: every call is the CNN's)
const modelName = (mid) => ({ small_model: "small model", deepvariant: "CNN" })[mid] ?? mid ?? "CNN";
const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");

// The examples list: the models as tiles, short reads first, and what each does, in a few words
const TILE_ORDER = READ_TYPES.flatMap((rt) => MODELS.filter((m) => m.reads === rt.key));
const facts = (m) => [
	m.realigns ? "Realigns reads" : "Phases reads",
	m.smallModel ? "Small model + CNN" : "CNN only",
	m.captureRegions ? "Capture intervals" : `${m.partitionSize / 1000} kb partitions`,
	`${m.channels.length} channels`,
	...(m.pangenome ? ["+ HPRC haplotypes"] : [])
];
const KIND_TAGS = {
	missed: "missed",
	"wrong genotype": "wrong GT",
	"extra allele": "extra allele",
	"low confidence": "low GQ",
	called: "called"
};
const kindClass = (kind) => `kind-${kind.split(" ")[0]}`;
// Long alleles, shortened for titles: CCCCCACCCC...AGCT (+35 bp); the full ones are in a tooltip
const shortAllele = (allele, ref) => {
	if (allele.length <= 12) return allele;
	const d = allele.length - ref.length;
	return `${allele.slice(0, 5)}…${allele.slice(-4)} (${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d)} bp)`;
};
const alleles = (c) =>
	`${shortAllele(c.ref, c.ref)} → ${c.alt
		.split(",")
		.map((a) => shortAllele(a, c.ref))
		.join(", ")}`;
const elsewhere = $derived(source === "example" ? sameSiteElsewhere(model, example) : []);
// DeepVariant's pileup PNG (show_examples, nucleus vis.draw_deepvariant_pileup) is its channels side by side
// under a 20 px row of labels, at 1 px per cell: cut it into one image per channel, to show them larger, labelled
async function channelPanels(url, n) {
	const img = await createImageBitmap(await (await fetch(url)).blob());
	const HEADER = 20,
		width = img.width / n,
		height = img.height - HEADER;
	if (!Number.isInteger(width) || height <= 0) return null;
	return Promise.all(
		Array.from({ length: n }, async (_, i) => {
			const canvas = new OffscreenCanvas(width, height);
			canvas.getContext("2d").drawImage(img, i * width, HEADER, width, height, 0, 0, width, height);
			return URL.createObjectURL(await canvas.convertToBlob());
		})
	);
}

// A pileup image's name, chr20:25027778_C->AA|CA, as the alleles it shows: "C → AA and CA together"
// (or, for long alleles, chr20:62491855_alt0INS5bp|alt1INS35bp: "+5 bp and +35 bp together")
const pileupAlleles = (name) => {
	const alleles = name.slice(name.lastIndexOf("_") + 1);
	const short = alleles.match(/^(.+)->(.+)$/);
	const alts = short
		? short[2].split("|")
		: alleles.split("|").map((a) => {
				const m = a.match(/^alt\d+(INS|DEL)(\d+)bp$/);
				return m ? `${m[1] === "INS" ? "+" : "−"}${m[2]} bp (alt ${Number(a.match(/^alt(\d+)/)[1]) + 1})` : a;
			});
	return `${short ? `${short[1]} → ` : ""}${alts.join(" and ")}${alts.length > 1 ? " together" : ""}`;
};
const fileName = (r) => (r.url ? r.url.split("/").pop().split("?")[0] : r.alignments?.name);
const best = (probs) => probs.reduce((a, b) => (b.p > a.p ? b : a));
</script>

<!-- Sharing a locus: a link (the model and position; reads only if they're at a URL), or the locus as a file -->
{#snippet share()}
	<div class="share">
		<button
			class="secondary"
			onclick={copyLink}
			title={readsFrom === "url"
				? "A link to this locus of the reads at that URL"
				: "A link with the model and position. Your files aren't in it: to share the reads too, download the locus."}
			>{linkCopied ? "Link copied" : "Copy link"}</button
		>
		<button
			class="secondary"
			onclick={downloadBundle}
			disabled={Boolean(bundling)}
			title="One .zip with the reads at this locus, the calls, the reads as DeepVariant saw them and the pileup images: to attach to an issue or send to someone, who can open it on this page. Made in your browser; nothing is uploaded."
			>{bundling || "Download this locus"}</button
		>
	</div>
{/snippet}

<!-- A run that isn't a normal one: a forced candidate, or the small model turned off -->
{#snippet mode()}
	{#if ranMode}
		<p class="mode">
			{#if ranMode.force}
				<b>Forced candidate.</b> DeepVariant wouldn't have looked at
				<span class="mono">{ranMode.force.map((f) => alleles(f)).join(", ")}</span> on its own. This run gave it that candidate (<span
					class="mono">--variant_caller=vcf_candidate_importer</span
				>) and let the CNN genotype it.
			{:else}
				<b>Small model off.</b> This run sent every candidate to the CNN (<span class="mono"
					>--call_small_model_examples=false</span
				>){#if ranMode.before && selected?.pos === ranMode.before.pos}: the small model had called this {ranMode.before.GT} ({ranMode
						.before.filter}, GQ {ranMode.before.GQ}), the CNN calls it {selected.GT} ({selected.filter}, GQ {selected.GQ}){/if}.
			{/if}
			<button class="link inline" disabled={Boolean(busy)} onclick={() => runDeepVariant()}>Back to the normal run →</button>
		</p>
	{/if}
{/snippet}

<div class="dvi">
	<!-- Your own data: the inputs, in full until a run, then as one line -->
	{#if source === "upload"}
		{#if editing || !hasRun}
			<section class="card setup" id="dvi-setup">
				<button class="back" onclick={() => pickSource("example")}>← Back to the examples</button>
				<h1>Inspect your own data</h1>
				<p class="lead">
					Rerun DeepVariant on one locus of your reads, with the model you used. Only the reads are required. Your files stay on
					your computer: only the locus is read from disk.
				</p>

				<div class="field-row">
					<div class="field-label">
						<h2><span class="step-num">1</span> Reads</h2>
						<p class="hint">A BAM with its index (or a small BAM or SAM without one). The only required input.</p>
					</div>
					<div class="field-body">
						<div class="segmented" role="radiogroup" aria-label="Reads from">
							<button
								role="radio"
								aria-checked={readsFrom === "url"}
								class:on={readsFrom === "url"}
								onclick={() => (readsFrom = "url")}>From a URL</button
							>
							<button
								role="radio"
								aria-checked={readsFrom === "file"}
								class:on={readsFrom === "file"}
								onclick={() => (readsFrom = "file")}>From your computer</button
							>
						</div>
						{#if readsFrom === "file"}
							<input
								id="dvi-reads"
								type="file"
								multiple
								accept=".bam,.sam,.bai,.csi,.cram,.crai,.zip"
								aria-label="Reads (.bam and .bai)"
								onchange={(e) => pickReads([...e.target.files])}
							/>
							<div class="hint" class:bad={files.length && reads.error}>
								{#if files.length && reads.error}{reads.error}
								{:else if reads.index}<span class="ok">✓</span>
									{reads.alignments.name} + {reads.index.name}: only the locus is read from disk
								{:else if files.length}{reads.alignments.name}: will be sorted and indexed in your browser (samtools)
								{:else}The BAM you gave DeepVariant and its .bai, any size. Or a snippet made with <code>samtools view -b</code>;
									small files don't need an index. Or a locus saved from this page (.zip).{/if}
							</div>
						{:else}
							<input type="text" class="url" placeholder="https://…/sample.bam" aria-label="BAM URL" bind:value={readsUrl} />
							<input
								type="text"
								class="url"
								placeholder="Index URL (default: the BAM's URL + .bai)"
								aria-label="Index URL"
								bind:value={indexUrl}
							/>
							<div class="hint" class:bad={readsUrl && reads.error}>
								{#if readsUrl && reads.error}{reads.error}
								{:else}Read with range requests, so only the locus is downloaded. The server must allow requests from other sites
									(CORS): see the README for S3 and GCS.{/if}
							</div>
							<div class="try-urls">
								<span class="hint">Try HG003, whole genome (DeepVariant's case studies, via 42basepairs):</span>
								{#each BIG_BAMS as b (b.url)}
									<button class="chip" class:on={readsUrl === b.url} onclick={() => tryBigBam(b)}
										>{b.label} <span class="count">{b.size}</span></button
									>
								{/each}
							</div>
						{/if}
						{#if readsSpan?.error}
							<div class="hint bad">
								Couldn't read the BAM's header and index: {readsSpan.error}{readsFrom === "url" && /fetch/i.test(readsSpan.error)
									? " (does the server allow requests from other sites, CORS?)"
									: ""}
							</div>
						{:else if readsSpan?.chrom}
							<div class="hint">Reads start at <span class="mono">{readsSpan.chrom}:{fmt(readsSpan.start)}</span>.</div>
						{/if}
						{#if model.pangenome}
							<label class="sublabel" for="dvi-pangenome">Pangenome haplotypes <span class="hint">(.bam + .bai)</span></label>
							<input
								id="dvi-pangenome"
								type="file"
								multiple
								accept=".bam,.bai,.csi"
								onchange={(e) => (pangenomeFiles = [...e.target.files])}
							/>
							<div class="hint" class:bad={pangenomeFiles.length && pangenomeReads.error}>
								{#if pangenomeFiles.length && pangenomeReads.error}{pangenomeReads.error}
								{:else if pangenomeReads.index}<span class="ok">✓</span>
									{pangenomeReads.alignments.name} + {pangenomeReads.index.name}
								{:else}A GBZ is too big for the browser, but pangenome-aware DeepVariant also takes the haplotypes as a BAM. Make
									one for your locus with <a href="https://github.com/jltsiren/gbz-base">gbz-base</a> and
									<a href="{URL_DEEPVARIANT}/tools/gbz_haplotypes_bam.py" download>this script</a>.{/if}
							</div>
						{/if}
					</div>
				</div>

				<div class="field-row">
					<div class="field-label">
						<h2><span class="step-num">2</span> Model</h2>
						<p class="hint">The <code>--model_type</code> you ran</p>
					</div>
					<div class="field-body">
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
						{#if modelGuess?.key === modelKey}
							<p class="hint">
								<span class="ok">✓</span> Guessed from the file name (<span class="mono">{modelGuess.word}</span>): pick another
								if that's wrong.
							</p>
						{/if}
						<p class="hint">{model.about} <a href={model.caseStudy}>Case study</a></p>
					</div>
				</div>

				<div class="field-row">
					<div class="field-label">
						<h2><span class="step-num">3</span> Where to look</h2>
						<p class="hint">Filled in from your files where possible</p>
					</div>
					<div class="field-body two">
						<div>
							<label class="sublabel" for="dvi-reference">Reference</label>
							<select id="dvi-reference" value={referenceKey} onchange={(e) => (referenceKey = e.target.value)}>
								{#each Object.entries(REFERENCES) as [key, ref] (key)}
									<option value={key}>{ref.name}</option>
								{/each}
							</select>
							<div class="hint">
								{#if referenceDetected && readsSpan?.contigs}<span class="ok">✓</span> Detected from your BAM's header{bareContigs
										? ": its contigs are named 1, 2, …, and the reference is read under those names"
										: ""}.{:else}Human GRCh38 or GRCh37, with contigs named chr1 or 1. Other references aren't supported yet.{/if}
							</div>
						</div>
						<div>
							<label class="sublabel" for="dvi-region">Position <span class="hint">(optional)</span></label>
							<input
								id="dvi-region"
								type="text"
								bind:value={regionText}
								placeholder={autoPosition
									? autoPosition.text.replace(/\d+/g, (n) => fmt(Number(n)))
									: "Empty: where your reads are"}
							/>
							<div class="hint" class:bad={region.error}>
								{#if region.error}{region.error}
								{:else if region.pending}Leave it empty to run where your reads are.
								{:else if region.auto}None given, so {region.auto}.{:else}Runs on {region.text}.{/if}
							</div>
						</div>
					</div>
				</div>

				<div class="field-row">
					<div class="field-label">
						<h2><span class="step-num optional">4</span> Your VCF</h2>
						<p class="hint">Optional. Finds the calls worth a closer look, and compares each with this run</p>
					</div>
					<div class="field-body">
						<input
							id="dvi-vcf"
							type="file"
							accept=".vcf,.gz,.bgz"
							aria-label="Your DeepVariant VCF"
							onchange={(e) => loadVcf(e.target.files[0])}
						/>
						<div class="hint" class:bad={vcfError}>
							{#if vcfError}{vcfError}
							{:else if vcfInput && !vcfScan}Reading {vcfInput.name}… {Math.round(vcfProgress * 100)}%
							{:else if vcfScan}<span class="ok">✓</span>
								{vcfInput.name}: {fmt(vcfScan.stats.records)} calls{vcfScan.gvcf
									? " (gVCF: variant records only)"
									: ""}{vcfScan.sample ? ` · ${vcfScan.sample}` : ""}{vcfScan.version ? ` · DeepVariant ${vcfScan.version}` : ""}
								{#if otherVersion}<br /><span class="warn"
										>Made with DeepVariant {otherVersion}; this page reruns {DV_VERSION}, so some calls will differ for that
										reason alone.</span
									>{/if}
							{:else}A .vcf or .vcf.gz from DeepVariant.{/if}
						</div>
						<div class="try-urls">
							<span class="hint">Try DeepVariant 1.10's official calls for those BAMs (HG003, chr20):</span>
							{#each EXAMPLE_VCFS as v (v.path)}
								<button
									class="chip"
									class:on={vcfInput?.name === v.path.split("/").pop()}
									disabled={vcfBusy}
									onclick={() => tryVcf(v)}>{v.label} <span class="count">{v.size}</span></button
								>
							{/each}
						</div>
						{#if model.captureRegions}
							<label class="sublabel" for="dvi-capture"
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
									: "WES runs process each capture interval on its own; give the BED to reproduce your run exactly."}
							</div>
						{/if}
					</div>
				</div>

				<div class="run-row">
					<div class="run-about">
						{#if region.text}<span class="hint"
								>Runs on <span class="mono">{region.text}</span>: {region.why}, so the calls match a real run's.</span
							>{/if}
						<div class="steps">
							{#each Object.entries(STEP_NAMES) as [key, label] (key)}
								<span class="step {steps[key] ?? 'pending'}"
									>{Array.isArray(label) ? label[steps[key] === "done" ? 1 : 0] : label}</span
								>
							{/each}
						</div>
						{#if busy}<p class="hint">{busy}</p>{/if}
						{#if error}<p class="bad">Failed: {error.replace(/^Error: /, "")}</p>{/if}
					</div>
					<button class="run" onclick={runDeepVariant} disabled={!canRun}
						>{!ready ? "Loading DeepVariant…" : busy ? "Running…" : "Run DeepVariant"}</button
					>
				</div>
			</section>
		{:else}
			<div class="summary-bar">
				{#if busy}
					<div class="steps">
						{#each Object.entries(STEP_NAMES) as [key, label] (key)}
							<span class="step {steps[key] ?? 'pending'}"
								>{Array.isArray(label) ? label[steps[key] === "done" ? 1 : 0] : label}</span
							>
						{/each}
						<span class="hint">{busy}</span>
					</div>
				{:else if error}
					<span class="bad">Failed: {error.replace(/^Error: /, "")}</span>
				{:else}
					<span class="ok">✓ DeepVariant 1.10 ran</span>
					{#if ranMode?.force}<span class="warn">forced candidate</span>{:else if ranMode?.cnnOnly}<span class="warn"
							>small model off</span
						>{/if}
				{/if}
				<span><span class="muted">Model</span> {(ranModel ?? model).name}</span>
				<span><span class="muted">Reads</span> <span class="mono">{fileName(reads)}</span></span>
				<span><span class="muted">Ref</span> {reference.name}{bareContigs ? " (contigs 1, 2, …)" : ""}</span>
				<span><span class="muted">Region</span> <span class="mono">{ranRegion || region.text || "–"}</span></span>
				{#if vcfScan}<span><span class="muted">VCF</span> <span class="mono">{vcfInput.name}</span></span>{/if}
				<button class="link push" onclick={() => (editing = true)}>Change inputs</button>
			</div>
		{/if}
	{/if}

	<div class="workspace">
		<!-- Left: the examples, by model; or with your data, your VCF's calls worth a look -->
		{#if source === "example"}
			{@const shown = modelByKey(openModel) ?? model}
			<aside class="card side" aria-label="Examples by model">
				<div class="side-head">
					<h2>Examples</h2>
					<span class="hint">HG003 · GRCh38 · chr20</span>
				</div>
				<div class="tiles-models" role="radiogroup" aria-label="Model">
					{#each TILE_ORDER as m (m.key)}
						<button
							class="tile-model"
							class:active={m.key === shown.key}
							role="radio"
							aria-checked={m.key === shown.key}
							onclick={() => (openModel = m.key)}
						>
							<span class="tile-top">
								<svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
									{#if m.reads === "short"}
										<rect class="sr" x="0" y="1" width="7" height="3" rx="1" /><rect
											class="sr"
											x="9"
											y="1"
											width="7"
											height="3"
											rx="1"
										/><rect class="sr" x="4" y="7" width="7" height="3" rx="1" /><rect
											class="sr"
											x="14"
											y="7"
											width="7"
											height="3"
											rx="1"
										/>
									{:else if m.reads === "long"}
										<rect class="lr" x="0" y="1" width="24" height="3" rx="1" /><rect
											class="lr"
											x="3"
											y="7"
											width="23"
											height="3"
											rx="1"
										/>
									{:else}
										<rect class="lr" x="0" y="1" width="24" height="3" rx="1" /><rect
											class="sr"
											x="2"
											y="7"
											width="7"
											height="3"
											rx="1"
										/><rect class="sr" x="12" y="7" width="7" height="3" rx="1" />
									{/if}
								</svg>
								<span class="hint">{m.examples.length}</span>
							</span>
							<span class="tile-name">{m.short}</span>
						</button>
					{/each}
				</div>
				<div class="model-card" title={shown.about}>
					<span class="model-card-name">{shown.name}</span>
					<div class="facts">
						{#each facts(shown) as f (f)}<span class="fact">{f}</span>{/each}
					</div>
					<a class="hint" href={shown.caseStudy}>Case study</a>
				</div>
				<div class="ex-list">
					{#each shown.examples as ex, i (ex.pos)}
						{@const active = shown.key === modelKey && i === exampleIndex}
						<button class="ex" class:active aria-current={active} onclick={() => inspectExample(shown.key, i)}>
							<span class="ex-label">{ex.label}</span>
							<span class="kind {kindClass(ex.kind)}">{KIND_TAGS[ex.kind]}</span>
							<span class="mono ex-pos">{fmt(ex.pos)}</span>
						</button>
					{/each}
				</div>
				<p class="hint side-foot">
					Sites where DeepVariant 1.10's official case-study run disagrees with GIAB v4.2.1 or isn't sure, and hard ones it gets
					right. Short reads
					<span class="key sr-key"></span> · long reads <span class="key lr-key"></span>
				</p>
			</aside>
		{:else if vcfScan}
			{@const s = vcfScan.stats}
			{@const pass = s.filter.PASS ?? 0}
			<aside class="card side" aria-label="Your calls">
				<div class="side-head stack">
					<h2>Worth a closer look</h2>
					<span class="hint file-name" title={vcfInput.name}>{vcfInput.name}</span>
				</div>
				{#if !vcfScan.isDeepVariant}<p class="bad">
						This VCF has no ##DeepVariant_version line: it may not come from DeepVariant.
					</p>{:else if otherVersion}<p class="warn">
						Made with DeepVariant {otherVersion}. This page reruns {DV_VERSION}: expect some calls to differ.
					</p>{/if}
				<div class="chips" role="tablist">
					{#each Object.entries(LISTS) as [key, l] (key)}
						<button
							role="tab"
							class="chip"
							class:on={key === listKey}
							aria-selected={key === listKey}
							onclick={() => (listKey = key)}
							>{l.name}
							<span class="count">{fmt(vcfScan.lists[key].length)}{vcfScan.lists[key].length === LIST_MAX ? "+" : ""}</span
							></button
						>
					{/each}
				</div>
				<p class="hint">{LISTS[listKey].about}. Click one to rerun DeepVariant there.</p>
				<input
					type="text"
					class="filter"
					placeholder="Filter by position, e.g. chr20:25,3"
					aria-label="Filter by position"
					bind:value={listFilter}
				/>
				<div class="list-controls">
					<select aria-label="Variant type" bind:value={listType}>
						<option value="all">SNPs and indels</option>
						<option value="snp">SNPs only</option>
						<option value="indel">Indels only</option>
					</select>
					<select aria-label="Order" bind:value={listSort}>
						<option value="pos">By position</option>
						<option value="gq">Lowest GQ first</option>
					</select>
				</div>
				{#if listShown.total > listShown.rows.length}
					<p class="hint">Showing {fmt(listShown.rows.length)} of {fmt(listShown.total)}.</p>
				{/if}
				<div class="list">
					{#each listShown.rows as r (`${r.chrom}:${r.pos}:${r.alt}`)}
						<button
							class="call-row"
							class:active={selected && selected.pos === r.pos && selected.chrom === r.chrom}
							onclick={() => inspectRecord(r)}
						>
							<span class="mono">{r.chrom}:{fmt(r.pos)}</span>
							<span class="mono allele">{r.ref} → {r.alt}</span>
							<span class="mono gt">{r.GT}</span>
							<span class="mono num" class:low={Number(r.GQ) < GQ_LOW}>{r.GQ}</span>
						</button>
					{:else}
						<p class="hint">None.</p>
					{/each}
				</div>
				<details class="vcf-summary">
					<summary
						>Summary · {fmt(pass)} PASS · Ti/Tv {s.pass.transversions
							? (s.pass.transitions / s.pass.transversions).toFixed(2)
							: "–"}</summary
					>
					<div class="tiles">
						<div class="tile"><b>{fmt(s.pass.snp)}</b>SNPs</div>
						<div class="tile"><b>{fmt(s.pass.indel)}</b>indels</div>
						<div class="tile"><b>{s.pass.homAlt ? (s.pass.het / s.pass.homAlt).toFixed(2) : "–"}</b>het / hom-alt</div>
						<div class="tile"><b>{pct(s.mid.small_model ?? 0, pass)}</b>small model</div>
						<div class="tile"><b>{fmt(s.filter.RefCall ?? 0)}</b>RefCall</div>
						<div class="tile"><b>{fmt(s.filter.NoCall ?? 0)}</b>NoCall</div>
					</div>
					<span class="hint">GQ of PASS calls</span>
					<div class="bars" role="img" aria-label="Histogram of GQ for PASS calls">
						{#each s.gqHistogram as n, i (i)}
							<div class="bar-col" title="GQ {i * 10}–{i * 10 + 9}: {fmt(n)} calls">
								<div class="bar" class:low={i < GQ_LOW / 10} style="height: {(100 * n) / Math.max(...s.gqHistogram, 1)}%"></div>
								<span>{i * 10}</span>
							</div>
						{/each}
					</div>
				</details>
			</aside>
		{/if}

		<section class="main" aria-label="Selected call">
			<!-- The example: what's hard about it -->
			{#if source === "example"}
				<div class="card">
					<div class="head-row">
						<div>
							<span class="hint">{model.name} example · chr20:{fmt(example.pos)}</span>
							<h1>{example.what.charAt(0).toUpperCase() + example.what.slice(1)}</h1>
							{#if example.note}<p class="ex-note">{example.note}</p>{/if}
							<p class="hint">
								Official case-study run: <span class="mono">{example.official}</span>.
								{#each elsewhere as o (o.model.key)}
									<button class="link" onclick={() => inspectExample(o.model.key, o.index)}
										>Same site with {o.model.name} →</button
									>
								{/each}
							</p>
						</div>
						<button class="secondary" onclick={copyLink}>{linkCopied ? "Link copied" : "Copy link"}</button>
					</div>
					{#if busy || !finished}
						<div class="steps">
							{#each Object.entries(STEP_NAMES) as [key, label] (key)}
								<span class="step {steps[key] ?? 'pending'}"
									>{Array.isArray(label) ? label[steps[key] === "done" ? 1 : 0] : label}</span
								>
							{/each}
							{#if busy}<span class="hint">{busy}</span>{/if}
						</div>
					{/if}
					{#if error}<p class="bad">Failed: {error.replace(/^Error: /, "")}</p>{/if}
				</div>
			{/if}

			{#if selected}
				{@const probs = genotypeProbabilities(selected)}
				{@const yours = yourRecords ? yoursFor(selected) : null}
				<div class="card call-card">
					<div class="call-top">
						<div>
							<span class="hint"
								>{source === "upload" ? `${ranModel.name} · ${ranRegion}` : "DeepVariant's call, rerun in your browser"}</span
							>
							<h2 class="call-title mono">
								{selected.chrom}:{fmt(selected.pos)}
								<span class="muted" title="{selected.ref} → {selected.alt}">{alleles(selected)}</span>
							</h2>
						</div>
						{#if source === "upload"}{@render share()}{/if}
					</div>
					{#if bundleError}<p class="bad">Couldn't save the locus: {bundleError}</p>{/if}
					{@render mode()}

					<!-- The alleles, base by base -->
					{#if baseView?.error}
						<p class="hint">Couldn't show the bases: {baseView.error}</p>
					{:else if baseView}
						<div class="bases" use:centerOnCall={baseView}>
							<div class="b-row">
								<span class="b-label">Reference</span>
								<span class="b-seq"
									>{#each baseView.ref as c, i (i)}<span class="b {c.kind}" class:at={c.pos === selected.pos}>{c.ch}</span
										>{/each}</span
								>
							</div>
							{#each baseView.sets as set (set.label)}
								<div class="b-set">
									{#each set.rows as row, k (k)}
										<div class="b-row">
											<span class="b-label"
												>{#if k === 0}<b>{set.label}</b>{:else if set.same === true}<span class="ok"
														>✓ same as {baseView.sets[0].short}</span
													>{:else if set.same === false}<span class="bad">✗ differs from {baseView.sets[0].short}</span
													>{/if}</span
											>
											<span class="b-seq"
												>{#each row as c, i (i)}<span class="b {c.kind}">{c.ch}</span>{/each}</span
											>
										</div>
									{/each}
									{#each set.unknown as u (u.pos)}
										<p class="hint b-note">
											No genotype at {fmt(u.pos)} ({alleles(u)}): DeepVariant saw this candidate but called ./., so it's left out
											above.
										</p>
									{/each}
								</div>
							{/each}
						</div>
						<p class="hint b-legend">
							Each pair of rows is one genotype's two haplotypes (in genotype order, not phased):
							<span class="b ins">A</span> inserted, <span class="b del">–</span> deleted, <span class="b sub">A</span>
							substituted,
							<span class="b match">A</span> as the reference.
						</p>
					{:else}
						<p class="hint">Reading the reference…</p>
					{/if}

					<div class="call-cols">
						<dl class="facts-dl">
							<dt>Genotype</dt>
							<dd class="mono"><b>{selected.GT}</b></dd>
							<dt>GQ</dt>
							<dd>
								<b>{selected.GQ}</b>
								{#if selected.GT.includes(".")}
									<span class="hint">of the most likely genotype{probs.length ? `, ${best(probs).gt}` : ""}</span>
								{:else}
									<span class="hint">{(10 ** (-Number(selected.GQ) / 10) * 100).toPrecision(2)}% chance it's wrong</span>
								{/if}
							</dd>
							<dt>Filter</dt>
							<dd><b>{selected.filter}</b> <span class="hint">QUAL {selected.qual}</span></dd>
							<dt>Depth</dt>
							<dd>
								<b>{selected.DP}</b>
								<span class="hint"
									>reads per allele: {selected.AD?.split(",").join(" · ")}{selected.VAF
										? ` · alt fraction ${selected.VAF.split(",")
												.map((v) => `${+(Number(v) * 100).toFixed(0)}%`)
												.join(", ")}`
										: ""}</span
								>
							</dd>
							<dt>Called by</dt>
							<dd><b>{modelName(selected.MID)}</b></dd>
						</dl>
						<div class="call-probs">
							<h3>Genotype probabilities <span class="hint">from PL</span></h3>
							<div class="probs">
								{#each probs.filter((x) => x.p >= 0.001 || probs.length <= 3) as { gt, p } (gt)}
									<div class="prob" title="{gt}: {p.toPrecision(3)}">
										<span class="gt">{gt}</span>
										<div class="prob-bar"><div style="width: {Math.max(0.5, p * 100)}%"></div></div>
										<span class="p">{p >= 0.001 ? `${(p * 100).toFixed(1)}%` : p.toExponential(0)}</span>
									</div>
								{/each}
							</div>
							{#if probs.length > 3 && probs.some((x) => x.p < 0.001)}
								<p class="hint">{probs.filter((x) => x.p < 0.001).length} other genotypes: under 0.1% each.</p>
							{/if}
							{#if selected.filter === "NoCall"}
								{#if probs.length && best(probs).gt === "0/0"}
									<p class="hint">
										Why ./.: the most likely genotype is <b>0/0</b> ({(best(probs).p * 100).toFixed(0)}%), reference, but with GQ {selected.GQ}.
										DeepVariant writes the CNN's reference calls with GQ under {HOMREF_MIN_GQ} as ./. instead of 0/0 (<span
											class="mono">--cnn_homref_call_min_gq</span
										>): "probably not a variant, but not sure".
									</p>
								{:else}
									<p class="hint">NoCall (./.): no genotype was likely enough to call.</p>
								{/if}
							{/if}
							{#if selected.filter === "RefCall"}<p class="hint">
									{#if ranMode?.force}RefCall: made to look at this allele, the CNN classified it as reference, with GQ {selected.GQ}.
									{:else}RefCall: enough reads show this allele to make it a candidate ({selected.AD?.split(",")
											.slice(1)
											.join(", ")} of
										{selected.DP}), and DeepVariant classified it as reference with GQ {selected.GQ}, at least the {HOMREF_MIN_GQ}
										it takes to write 0/0.{/if}
								</p>{/if}
						</div>
						<div class="call-how">
							<h3>How it was called</h3>
							<ul class="how">
								<li>
									{#if selected.MID === "small_model"}
										By the <b>small model</b>, from summary features (allele counts, base and mapping qualities): no pileup image.
										<button class="link inline" disabled={Boolean(busy)} onclick={() => askCnn(selected)}
											>Ask the CNN instead →</button
										>
									{:else}
										By the <b>CNN</b>, from the pileup images below.
									{/if}
								</li>
								{#if readsInfo?.kind === "realigned"}
									<li>
										Local realignment changed <b
											>{readsInfo.changed ? `${readsInfo.changed} of ${readsInfo.total}` : `none of the ${readsInfo.total}`}</b
										>
										reads in <span class="mono">{readsInfo.window}</span>.
										<a href={readsInfo.url} download="realigned_reads.bam">Download them</a>
									</li>
								{:else if readsInfo?.kind === "phased"}
									<li>
										Not realigned: DeepVariant phases long reads itself and sorts the pileup rows by haplotype.
										<a href={readsInfo.url} download="phased_by_deepvariant.bam">Download the phased reads</a>
									</li>
								{/if}
								{#if ranModel.pangenome}
									<li>
										Pangenome-aware: the top half of each pileup image is the pangenome's haplotypes, the bottom half the reads.
									</li>
								{/if}
								{#if yourRecords}
									<li class:ok={yours && agrees(selected)} class:differs={yours && !agrees(selected)}>
										{#if !yours}Your VCF has no record here.
										{:else if agrees(selected)}Your VCF agrees: {yours.GT}, {yours.filter}, GQ {yours.GQ}.
										{:else if ranMode}Your VCF says {yours.GT}, {yours.filter}, GQ {yours.GQ}: this run isn't a normal one (see
											above), so they needn't agree.
										{:else if otherVersion}Your VCF says {yours.GT}, {yours.filter}, GQ {yours.GQ}. It was made with DeepVariant {otherVersion};
											this is {DV_VERSION}, which alone can explain the difference.
										{:else}Your VCF says {yours.GT}, {yours.filter}, GQ {yours.GQ}: another model or flags, or (where more reads
											cover a site than fit in a pileup image) other sampled reads.{/if}
									</li>
								{/if}
							</ul>
						</div>
					</div>
				</div>
			{:else if noCandidate}
				{@const nc = noCandidate}
				<div class="card call-card">
					<div class="call-top">
						<div>
							<span class="hint">{ranModel.name} · {ranRegion}</span>
							<h2 class="call-title mono">{nc.chrom}:{fmt(nc.pos)} <span class="muted">no candidate here</span></h2>
						</div>
						{#if source === "upload"}{@render share()}{/if}
					</div>
					{#if bundleError}<p class="bad">Couldn't save the locus: {bundleError}</p>{/if}
					{@render mode()}
					<p class="nc-lead">
						DeepVariant made no call at this position because it never became a <b>candidate</b>: its models only see sites where
						enough reads show the same non-reference allele. Below is what it counted here, in the reads
						{nc.realigned ? "after its local realignment" : "as it used them"} (bases and reads under its quality thresholds aren't
						counted).
					</p>
					{#if counted?.alleles.length}
						<div class="nc-table">
							{#each counted.alleles as a (`${a.pos}:${a.ref}:${a.alt}`)}
								{@const passes = a.fraction >= a.minFraction}
								<div class="nc-row" class:near={!a.here}>
									<span class="mono nc-pos">{fmt(a.pos)}</span>
									<span class="mono nc-allele" title="{a.ref} → {a.alt}">{alleles(a)}</span>
									<span class="nc-bar" title="{a.count} of {a.total} reads">
										<span class="nc-fill" class:passes style="width: {Math.min(100, a.fraction * 100)}%"></span>
										<span class="nc-tick" style="left: {a.minFraction * 100}%"></span>
									</span>
									<span class="mono nc-count">{a.count} of {a.total} · {(a.fraction * 100).toFixed(1)}%</span>
									<span class="hint nc-why">{a.why}</span>
									{#if a.call}
										<button class="link" onclick={() => select(a.call)}>Inspect it →</button>
									{:else}
										<button class="link" disabled={Boolean(busy)} onclick={() => forceCandidate(a)}>Force this candidate →</button
										>
									{/if}
								</div>
							{/each}
						</div>
						<p class="hint">
							The tick is the fraction of reads a candidate needs with this model: {counted.thresholds.snps}% for SNPs, {counted
								.thresholds.indels}% for indels, and at least {counted.thresholds.minCountSnps} reads (<span class="mono"
								>--vsc_min_fraction_snps</span
							>, <span class="mono">--vsc_min_fraction_indels</span>,
							<span class="mono">--vsc_min_count_snps</span>). Forcing a candidate makes DeepVariant draw its pileup image and
							genotype it anyway.
						</p>
					{:else if counted?.at}
						<p>
							<b>All {counted.at.refCount} reads</b> it counted at {fmt(nc.pos)} show the reference base
							<span class="mono">{counted.at.ref}</span>, and no other allele is seen in 2 or more reads within 10 bp.
						</p>
					{:else}
						<p>
							DeepVariant counted <b>no reads</b> at this position: none cover it, or none pass its filters (mapping quality, duplicates).
						</p>
					{/if}
					{#if yourRecords}
						<p class="nc-yours">
							{#if yoursAtPosition}
								Your VCF has <span class="mono">{alleles(yoursAtPosition)}</span> here ({yoursAtPosition.GT}, {yoursAtPosition.filter},
								GQ {yoursAtPosition.GQ}){otherVersion ? `, made with DeepVariant ${otherVersion}` : ""}.
								<button class="link" disabled={Boolean(busy)} onclick={() => forceCandidate(yoursAtPosition)}
									>Force that candidate →</button
								>
							{:else}
								Your VCF has no record here either.
							{/if}
						</p>
					{/if}
					{#if nc.nearest.length}
						<p class="hint">
							Nearest calls in this run:
							{#each nc.nearest as c (`${c.pos}:${c.alt}`)}
								<button class="link nc-near" onclick={() => select(c)}
									><span class="mono">{fmt(c.pos)}</span> {c.GT} ({Math.abs(c.pos - nc.pos)} bp away)</button
								>
							{/each}
						</p>
					{:else}
						<p class="hint">No candidates anywhere in {ranRegion}.</p>
					{/if}
				</div>
			{:else if finished && !calls.length}
				<div class="card"><p class="hint">No candidate variants in {ranRegion}.</p></div>
			{:else if source === "upload" && !busy && !finished && !editing}
				<div class="card"><p class="hint">Pick a call on the left, or run DeepVariant above.</p></div>
			{/if}

			{#if selected}
				<!-- The pileup images the CNN classified, one panel per channel -->
				<div class="card view-card">
					<div class="view-head">
						<h3>Pileup images</h3>
						{#if selected?.MID === "small_model"}
							<span class="hint"
								>None: the small model called this from summary features, so the CNN never saw a pileup image.</span
							>
						{:else if pileupError}
							<span class="bad">Couldn't draw the pileup images: {pileupError}</span>
						{:else if !pileupsForSelected.length}
							<span class="hint">Drawing pileup images…</span>
						{:else}
							<span class="hint"
								>What the CNN classified: rows are {ranModel.pangenome ? "pangenome haplotypes, then reads" : "reads"}, columns
								positions; the tick marks the candidate. Hover a panel for what it encodes.</span
							>
						{/if}
					</div>
					{#if selected?.MID !== "small_model" && pileupsForSelected.length}
						{@const shown = pileupsForSelected[Math.min(pileupIndex, pileupsForSelected.length - 1)]}
						{#if pileupsForSelected.length > 1}
							<div class="pileup-picker" role="tablist" aria-label="Pileup image">
								{#each pileupsForSelected as p, i (p.name)}
									<button role="tab" class:on={p === shown} aria-selected={p === shown} onclick={() => (pileupIndex = i)}
										>{pileupAlleles(p.name)}</button
									>
								{/each}
							</div>
						{:else}
							<p class="hint mono">{pileupAlleles(shown.name)}</p>
						{/if}
						{#if shown.panels}
							<div class="channel-grid" style="--cols: {Math.ceil(shown.panels.length / 2)}">
								{#each shown.panels as src, i (i)}
									{@const ch = CHANNELS[ranModel.channels[i]]}
									<figure class="channel" title={ch?.about ?? ""}>
										<figcaption>{ch?.name ?? `channel ${ranModel.channels[i]}`}</figcaption>
										<div class="channel-img"><img {src} alt="{ch?.name ?? 'channel'} channel of {shown.name}" /></div>
									</figure>
								{/each}
							</div>
						{:else}
							<img class="pileup-whole" src={shown.url} alt="pileup image {shown.name}" />
						{/if}
						<a class="hint" href={shown.url} download="{shown.name}.png">Download DeepVariant's PNG</a>
					{/if}
				</div>
			{/if}

			{#if selected || noCandidate}
				<!-- The reads, as aligned and as DeepVariant saw them -->
				<div class="card view-card">
					<div class="view-head">
						<h3>{ranModel?.realigns ? "Reads before and after realignment" : "Reads as aligned and as phased"}</h3>
						<span class="hint"
							>{#if ranModel?.realigns}Your reads as IGV shows them, then after DeepVariant's local realignment: what it saw.{:else}Your
								reads as aligned, then grouped by DeepVariant's own phasing (as the pileup rows are).{/if}</span
						>
					</div>
					<div class="igv" bind:this={divIgv}></div>
				</div>
			{/if}

			<!-- Every call in the region, and the log -->
			{#if calls.length || busy || error || finished}
				<div class="card tabs-card">
					<div class="tabs" role="tablist">
						{#if calls.length}
							<button role="tab" class:on={tab === "calls"} aria-selected={tab === "calls"} onclick={() => (tab = "calls")}
								>All calls in this region <span class="count">{calls.length}</span></button
							>
						{/if}
						<button
							role="tab"
							class:on={tab === "log" || !calls.length}
							aria-selected={tab === "log" || !calls.length}
							onclick={() => (tab = "log")}>Log</button
						>
					</div>

					{#if calls.length}
						<div class="panel" hidden={tab !== "calls"}>
							<p class="hint">
								{#if ranMode?.force}Only the forced candidate: with candidates given, DeepVariant looks for no others.
								{:else}Every call in {ranRegion} ({ranModel.modelType} model{ranMode?.cnnOnly ? ", small model off" : ""}). Click
									one to inspect it.{/if}
							</p>
							<div class="tablewrap">
								<table>
									<thead>
										<tr
											><th>position</th><th>ref</th><th>alt</th><th>genotype</th><th class="num">GQ</th><th class="num">QUAL</th
											><th>filter</th><th class="num">depth</th><th>allele depths</th><th>called by</th>{#if yourRecords}<th
													>your VCF</th
												>{/if}</tr
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
												<td>{call.chrom}:{fmt(call.pos)}</td><td class="allele" title={call.ref}>{call.ref}</td><td
													class="allele"
													title={call.alt}>{call.alt}</td
												><td>{call.GT}</td><td class="num">{call.GQ}</td><td class="num">{call.qual}</td><td>{call.filter}</td><td
													class="num">{call.DP}</td
												><td>{call.AD}</td><td>{modelName(call.MID)}</td>
												{#if yourRecords}
													<td class:differs={yours && !agrees(call)}
														>{#if !yours}<span class="hint">not in your VCF</span>{:else}{yours.GT}
															{yours.filter} GQ {yours.GQ}{/if}</td
													>
												{/if}
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					<div class="panel" hidden={calls.length && tab !== "log"}>
						<pre>{logText || "Nothing yet."}</pre>
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>

<style>
.dvi {
	--line: var(--border);
	--muted: var(--fg-muted);
	--done: var(--ok);
	--error: var(--danger);
	max-width: 1360px;
	margin: 0 auto;
	padding: 24px 16px 48px;
	font:
		14px/1.45 system-ui,
		-apple-system,
		sans-serif;
}
h1 {
	font-size: 19px;
	line-height: 1.25;
	margin: 2px 0 4px;
}
h2 {
	font-size: 15px;
	font-weight: 600;
	margin: 0;
}
h3 {
	font-size: 13px;
	font-weight: 600;
	margin: 0 0 8px;
}
p {
	margin: 0;
}
.mono {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
	color: var(--muted);
}
.hint {
	color: var(--muted);
	font-size: 12px;
	font-weight: 400;
}
.bad,
.differs {
	color: var(--error);
}
.ok {
	color: var(--done);
}
.card {
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 12px;
	padding: 16px 18px;
}
button {
	font: inherit;
	color: inherit;
}
button.link {
	border: 0;
	padding: 4px 0;
	background: none;
	color: var(--accent);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	text-align: left;
}
.warn {
	color: var(--warning);
}
.share {
	display: flex;
	gap: 8px;
}
.mode {
	margin: 0 0 12px;
	padding: 8px 12px;
	border: 1px solid var(--line);
	border-left: 3px solid var(--warning);
	background: var(--bg-subtle);
	font-size: 13px;
}
button.link.inline {
	padding: 0;
	margin-left: 4px;
}
button.link:disabled {
	opacity: 0.5;
	cursor: default;
}
.list-controls {
	display: flex;
	gap: 6px;
	margin: 6px 0;
}
.list-controls select {
	flex: 1;
	min-width: 0;
	font: inherit;
	font-size: 12px;
	padding: 4px 6px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--bg);
	color: inherit;
}
.nc-lead {
	max-width: 760px;
	margin-bottom: 12px;
}
.nc-table {
	display: grid;
	grid-template-columns: auto minmax(60px, auto) minmax(80px, 180px) auto 1fr auto;
	gap: 6px 14px;
	align-items: center;
	margin-bottom: 8px;
	font-size: 13px;
}
.nc-row {
	display: contents;
}
.nc-row.near > * {
	opacity: 0.75;
}
.nc-allele {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 220px;
}
.nc-bar {
	position: relative;
	height: 10px;
	border-radius: 3px;
	background: var(--line);
}
.nc-fill {
	position: absolute;
	inset: 0 auto 0 0;
	border-radius: 3px;
	background: var(--warning);
}
.nc-fill.passes {
	background: var(--done);
}
.nc-tick {
	position: absolute;
	top: -4px;
	bottom: -4px;
	border-left: 2px solid var(--fg);
}
.nc-count {
	white-space: nowrap;
}
.nc-yours {
	margin: 10px 0 6px;
}
.nc-near {
	margin-right: 12px;
}
@media (max-width: 800px) {
	.nc-table {
		grid-template-columns: auto 1fr auto;
	}
	.nc-why {
		grid-column: 1 / 3;
	}
}
button.secondary {
	padding: 8px 12px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	white-space: nowrap;
}
button:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 2px;
}

/* Your data: the inputs */
.setup {
	margin: 0 0 20px;
	padding: 24px 28px;
}
.back {
	border: 0;
	padding: 4px 0;
	background: none;
	color: var(--accent);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
}
.lead {
	color: var(--muted);
	font-size: 15px;
	max-width: 680px;
	margin-bottom: 8px;
}
.field-row {
	display: flex;
	flex-wrap: wrap;
	gap: 10px 32px;
	padding: 20px 0;
	border-top: 1px solid var(--line);
}
.field-label {
	flex: 1 1 180px;
}
.field-label .hint {
	margin: 4px 0 0 28px;
}
.field-body {
	flex: 999 1 460px;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.field-body.two {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 16px;
}
.step-num {
	display: inline-grid;
	place-items: center;
	width: 20px;
	height: 20px;
	margin-right: 6px;
	border-radius: 50%;
	background: var(--fg);
	color: var(--bg);
	font-size: 11px;
}
.step-num.optional {
	background: none;
	color: var(--muted);
	border: 1.5px dashed var(--muted);
}
.try-urls {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
}
.try-urls > .hint {
	flex: 1 0 100%;
}
.sublabel {
	display: block;
	font-size: 13px;
	font-weight: 500;
	margin: 6px 0 6px;
}
.models {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
	gap: 8px;
}
.model {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 3px;
	padding: 10px 12px;
	border: 1px solid var(--line);
	border-radius: 9px;
	background: var(--bg);
	text-align: left;
	cursor: pointer;
}
.model.active {
	border-color: var(--accent);
	background: var(--accent-subtle);
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
.segmented {
	display: inline-flex;
	align-self: flex-start;
	gap: 2px;
	padding: 3px;
	background: var(--bg-subtle);
	border-radius: 9px;
}
.segmented button {
	border: 0;
	padding: 6px 12px;
	border-radius: 7px;
	background: none;
	color: var(--muted);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
}
.segmented button.on {
	background: var(--bg);
	color: var(--fg);
	box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
}
input[type="text"],
select {
	width: 100%;
	padding: 8px 10px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg);
	color: var(--fg);
	font:
		13px ui-monospace,
		monospace;
}
input[type="file"] {
	font-size: 12px;
	max-width: 100%;
	color: var(--muted);
}
input[type="file"]::file-selector-button {
	margin-right: 10px;
	padding: 6px 12px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg);
	color: var(--fg);
	font:
		500 13px system-ui,
		sans-serif;
	cursor: pointer;
}
input[type="file"]::file-selector-button:hover {
	background: var(--bg-subtle);
}
.run-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 12px 20px;
	margin: 0 -28px -24px;
	padding: 16px 28px;
	background: var(--bg-subtle);
	border-top: 1px solid var(--line);
	border-radius: 0 0 12px 12px;
}
.run-about {
	display: flex;
	flex-direction: column;
	gap: 8px;
	flex: 1 1 360px;
}
button.run {
	padding: 11px 24px;
	border: 0;
	border-radius: 9px;
	background: var(--accent);
	color: #fff;
	font-weight: 600;
	cursor: pointer;
}
button.run:disabled {
	opacity: 0.45;
	cursor: default;
}
.steps {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
}
.step {
	font:
		11.5px ui-monospace,
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
/* Pinned to the top, so a run's progress stays in view while you pick calls further down */
.summary-bar {
	position: sticky;
	top: 8px;
	z-index: 5;
	box-shadow: 0 2px 8px rgb(0 0 0 / 0.08);
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 20px;
	margin-bottom: 20px;
	padding: 10px 16px;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--bg);
	font-size: 13px;
}
.push {
	margin-left: auto;
}

/* The workspace: a list on the left, the selected call on the right */
.workspace {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	gap: 20px;
}
.side {
	flex: 1 1 340px;
	max-width: 100%;
	padding: 16px 10px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.main {
	flex: 999 1 620px;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 16px;
}
.side-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 8px;
	padding: 0 8px 6px;
}
.tiles-models {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 6px;
	padding: 4px 8px 0;
}
.tile-model {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 9px 10px;
	border: 1px solid var(--line);
	border-radius: 9px;
	background: var(--bg);
	text-align: left;
	cursor: pointer;
}
.tile-model:hover {
	border-color: var(--muted);
}
.tile-model.active {
	border-color: var(--accent);
	background: var(--accent-subtle);
	box-shadow: inset 0 0 0 1px var(--accent);
}
.tile-top {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.tile-name {
	font-size: 13px;
	font-weight: 600;
}
.sr {
	fill: var(--short-reads);
}
.lr {
	fill: var(--long-reads);
}
.key {
	display: inline-block;
	width: 14px;
	height: 4px;
	border-radius: 1px;
	vertical-align: middle;
}
.sr-key {
	background: var(--short-reads);
}
.lr-key {
	background: var(--long-reads);
}
.model-card {
	margin: 10px 8px 4px;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	align-items: flex-start;
	background: var(--bg-subtle);
	border-radius: 10px;
}
.model-card-name {
	font-weight: 600;
}
.facts {
	display: flex;
	flex-wrap: wrap;
	gap: 5px;
}
.fact {
	font-size: 12px;
	padding: 3px 8px;
	border-radius: 6px;
	background: var(--bg);
	border: 1px solid var(--line);
}
.ex-list {
	display: flex;
	flex-direction: column;
	gap: 1px;
	padding: 4px 0;
}
.ex {
	width: 100%;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 7px 10px;
	border: 0;
	border-radius: 7px;
	background: none;
	text-align: left;
	cursor: pointer;
}
.ex:hover {
	background: var(--bg-subtle);
}
.ex.active {
	background: var(--accent-subtle);
	box-shadow: inset 3px 0 0 var(--accent);
}
.ex-label {
	flex: 1;
	min-width: 0;
	font-size: 13px;
}
.ex-pos {
	width: 80px;
	text-align: right;
	font-size: 11px;
	color: var(--muted);
}
.kind {
	font-size: 10.5px;
	font-weight: 600;
	padding: 2px 6px;
	border-radius: 4px;
	white-space: nowrap;
}
.kind-missed {
	background: var(--tag-missed-bg);
	color: var(--tag-missed);
}
.kind-wrong {
	background: var(--tag-gt-bg);
	color: var(--tag-gt);
}
.kind-extra {
	background: var(--tag-extra-bg);
	color: var(--tag-extra);
}
.kind-low {
	background: var(--bg-subtle);
	color: var(--muted);
}
.kind-called {
	background: var(--tag-ok-bg);
	color: var(--tag-ok);
}
.side-foot {
	padding: 10px 8px 0;
	line-height: 1.5;
}

/* Your VCF's lists */
.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	padding: 0 8px;
}
.chip {
	padding: 5px 10px;
	border: 1px solid var(--line);
	border-radius: 999px;
	background: var(--bg);
	font-size: 12px;
	cursor: pointer;
}
.chip.on {
	background: var(--fg);
	border-color: var(--fg);
	color: var(--bg);
}
.chip:disabled {
	opacity: 0.55;
	cursor: progress;
}
.chip .count {
	margin-left: 4px;
	opacity: 0.7;
	font-variant-numeric: tabular-nums;
}
.side-head.stack {
	flex-direction: column;
	align-items: stretch;
	gap: 2px;
}
.file-name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.side > .hint,
.side > .bad {
	padding: 0 8px;
}
.filter {
	margin: 4px 8px;
	width: calc(100% - 16px) !important;
}
.list {
	max-height: 520px;
	overflow: auto;
	display: flex;
	flex-direction: column;
}
.call-row {
	display: grid;
	grid-template-columns: 1.3fr 1fr 34px 30px;
	gap: 8px;
	align-items: center;
	padding: 7px 8px;
	border: 0;
	border-bottom: 1px solid var(--line);
	background: none;
	font-size: 12px;
	text-align: left;
	cursor: pointer;
}
.call-row:hover {
	background: var(--bg-subtle);
}
.call-row.active {
	background: var(--accent-subtle);
}
.call-row .allele {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--muted);
}
.call-row .num {
	text-align: right;
}
.low {
	color: var(--warning);
	font-weight: 600;
}
.vcf-summary {
	padding: 8px;
	font-size: 13px;
}
.vcf-summary summary {
	cursor: pointer;
	font-weight: 500;
}
.tiles {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
	margin: 10px 0;
}
.tile {
	display: flex;
	flex-direction: column;
	font-size: 11px;
	color: var(--muted);
}
.tile b {
	color: var(--fg);
	font-size: 16px;
	font-variant-numeric: tabular-nums;
}
.bars {
	display: flex;
	align-items: flex-end;
	gap: 3px;
	height: 60px;
	margin-top: 4px;
}
.bar-col {
	flex: 1;
	height: 100%;
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
	align-items: center;
	font-size: 9px;
	color: var(--muted);
}
.bar {
	width: 100%;
	min-height: 1px;
	background: var(--accent);
	border-radius: 2px 2px 0 0;
}
.bar.low {
	background: var(--warning);
}

/* The example and the selected call */
.head-row {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 10px;
}
.head-row > div {
	flex: 1 1 0;
	min-width: 0;
}
.sub {
	font-size: 13px;
	color: var(--muted);
}
.call-title {
	font-size: 16px;
	margin-top: 2px;
}
.ex-note {
	margin-top: 6px;
	font-size: 13px;
}
.ex-note .link {
	margin-left: 8px;
}
.card > .steps,
.card > .bad {
	margin-top: 14px;
}
.detail {
	display: grid;
	grid-template-columns: minmax(220px, 1fr) 1.4fr;
	gap: 12px 28px;
	margin-top: 12px;
}
@media (max-width: 760px) {
	.detail {
		grid-template-columns: 1fr;
	}
}
.how {
	margin: 0;
	padding-left: 18px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 13px;
}
.probs {
	display: grid;
	gap: 5px;
	margin-bottom: 6px;
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

/* The selected call: a compact header, then what DeepVariant looked at */
/* The selected call: its alleles base by base, then the facts, genotype probabilities and how it was called */
.call-card {
	padding: 14px 18px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.call-top {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
}
.call-cols {
	display: flex;
	flex-wrap: wrap;
	gap: 12px 32px;
}
.facts-dl {
	flex: 1 1 230px;
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 3px 12px;
	margin: 0;
	font-size: 13px;
}
.facts-dl dt {
	color: var(--muted);
}
.facts-dl dd {
	margin: 0;
}
.call-probs {
	flex: 1 1 220px;
}
.call-how {
	flex: 1.3 1 260px;
}
/* Bases: one column per base (or inserted base), rows lined up */
.bases {
	overflow-x: auto;
	padding: 10px 12px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--bg-subtle);
}
.b-row {
	display: flex;
	align-items: center;
	gap: 12px;
	white-space: nowrap;
}
.b-label {
	position: sticky;
	left: -12px;
	z-index: 1;
	margin-left: -12px;
	padding-left: 12px;
	background: var(--bg-subtle);
	flex: 0 0 162px;
	font-size: 12px;
	color: var(--muted);
	overflow: hidden;
	text-overflow: ellipsis;
}
.b-label b {
	color: var(--fg);
	font-weight: 600;
}
.b-set {
	margin-top: 6px;
	padding-top: 6px;
	border-top: 1px dashed var(--line);
}
.b-seq {
	display: inline-flex;
}
.b {
	display: inline-block;
	width: 1.05em;
	text-align: center;
	font:
		600 14px/1.5 ui-monospace,
		SFMono-Regular,
		Menlo,
		monospace;
	border-radius: 2px;
}
.b.ref {
	color: var(--fg);
}
.b.ref.at {
	box-shadow: inset 0 -2px 0 var(--accent);
}
.b.match {
	color: var(--muted);
	font-weight: 400;
	opacity: 0.55;
}
.b.gap {
	color: var(--muted);
	font-weight: 400;
	opacity: 0.35;
}
.b.ins {
	color: var(--tag-ok);
	background: var(--tag-ok-bg);
}
.b.del {
	color: var(--tag-missed);
	background: var(--tag-missed-bg);
}
.b.sub {
	color: var(--tag-gt);
	background: var(--tag-gt-bg);
}
.b-note {
	margin: 4px 0 0 162px;
}
@media (max-width: 600px) {
	.b-row {
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
	}
	.b-label {
		flex: none;
		padding-right: 8px;
	}
	.b-note {
		margin-left: 0;
	}
}
.b-legend {
	margin-top: -4px;
}
.b-legend .b {
	font-size: 12px;
}
.view-card {
	padding: 14px 18px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.view-head {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 4px 12px;
}
.view-head h3 {
	margin: 0;
}
.pileup-picker {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.pileup-picker button {
	padding: 4px 10px;
	border: 1px solid var(--line);
	border-radius: 999px;
	background: var(--bg);
	font:
		12px ui-monospace,
		monospace;
	cursor: pointer;
}
.pileup-picker button.on {
	border-color: var(--accent);
	background: var(--accent-subtle);
	color: var(--accent);
}
/* Channels in two rows, each pixel a cell */
.channel-grid {
	display: grid;
	grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
	gap: 10px 8px;
}
@media (max-width: 760px) {
	.channel-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}
.channel {
	margin: 0;
}
.channel figcaption {
	font-size: 12px;
	font-weight: 500;
	margin-bottom: 3px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.channel-img {
	position: relative;
	padding-top: 5px;
}
/* The candidate: the center column */
.channel-img::before {
	content: "";
	position: absolute;
	top: 0;
	left: 50%;
	height: 5px;
	border-left: 2px solid var(--danger);
	transform: translateX(-1px);
}
.channel img,
.pileup-whole {
	display: block;
	width: 100%;
	image-rendering: pixelated;
	border-radius: 3px;
	background: #000;
}

/* All calls, and the log */
.tabs-card {
	padding: 0;
	overflow: hidden;
}
.tabs {
	display: flex;
	flex-wrap: wrap;
	gap: 0 22px;
	padding: 0 18px;
	border-bottom: 1px solid var(--line);
}
.tabs button {
	padding: 10px 2px;
	margin-bottom: -1px;
	border: 0;
	border-bottom: 2px solid transparent;
	background: none;
	color: var(--muted);
	font-size: 14px;
	font-weight: 500;
	cursor: pointer;
}
.tabs button.on {
	color: var(--fg);
	border-bottom-color: var(--accent);
}
.tabs .count {
	color: var(--muted);
	font-weight: 400;
}
.panel {
	padding: 12px 18px 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.panel[hidden] {
	display: none;
}
.igv {
	border: 1px solid var(--line);
	border-radius: 8px;
	min-height: 200px;
	background: #fff;
	overflow: hidden;
}
.tablewrap {
	overflow: auto;
	max-height: 420px;
	border: 1px solid var(--line);
	border-radius: 8px;
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
	padding: 6px 10px;
	text-align: left;
	white-space: nowrap;
	border-bottom: 1px solid var(--line);
}
th {
	position: sticky;
	top: 0;
	background: var(--bg-subtle);
}
td.num,
th.num {
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
pre {
	max-height: 360px;
	overflow: auto;
	font-size: 12px;
	background: var(--bg-subtle);
	padding: 10px;
	margin: 0;
	border-radius: 8px;
}
code {
	font-size: 0.92em;
}
</style>
