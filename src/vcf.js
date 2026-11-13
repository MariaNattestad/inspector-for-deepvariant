// Reads a DeepVariant VCF in the browser, without an index: one pass summarizes it (what vcf_stats_report
// shows, plus lists of calls worth a closer look), and a small index of where each block starts lets the
// page pull out the records around any position later.
//
// DeepVariant writes .vcf.gz as BGZF: a series of gzip blocks of at most 64 kB each. The browser's
// DecompressionStream reads a single gzip member, so each block is decompressed on its own. Plain .vcf files
// are read in 1 MB chunks the same way.

const CHUNK = 16 * 1024 * 1024; // bytes read from the file at a time
const TEXT_BLOCK = 1024 * 1024; // block size for uncompressed VCFs
export const LIST_MAX = 100000; // calls kept per list
export const GQ_LOW = 20;

// The blocks of a BGZF file: [{offset, size}] (compressed offsets), from each block's BSIZE field
async function bgzfBlocks(file, onProgress) {
	const blocks = [];
	let offset = 0;
	while (offset < file.size) {
		const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + CHUNK)).arrayBuffer());
		let o = 0;
		while (o + 18 <= bytes.length) {
			if (bytes[o] !== 31 || bytes[o + 1] !== 139) throw new Error("Not a bgzip-compressed VCF (as DeepVariant writes).");
			const xlen = bytes[o + 10] | (bytes[o + 11] << 8);
			let size = 0;
			for (let x = o + 12; x < o + 12 + xlen; ) {
				const slen = bytes[x + 2] | (bytes[x + 3] << 8);
				if (bytes[x] === 66 && bytes[x + 1] === 67) size = (bytes[x + 4] | (bytes[x + 5] << 8)) + 1;
				x += 4 + slen;
			}
			if (!size) throw new Error("Not a bgzip-compressed VCF: gzip it with bgzip, as DeepVariant does.");
			if (o + size > bytes.length) break; // the block continues in the next chunk
			blocks.push({ offset: offset + o, size });
			o += size;
		}
		if (o === 0) throw new Error("Couldn't read the VCF's compressed blocks.");
		offset += o;
		onProgress?.(offset / file.size / 2);
	}
	return blocks;
}

async function blockText(file, block, compressed) {
	const blob = file.slice(block.offset, block.offset + block.size);
	if (!compressed) return blob.text();
	if (block.size <= 28) return ""; // the empty end-of-file block
	return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

// Texts of blocks [from, to), decompressed a few at a time
async function blocksText(file, blocks, from, to, compressed) {
	const out = [];
	for (let i = from; i < to; i += 32) {
		const batch = blocks.slice(i, Math.min(to, i + 32));
		out.push(...(await Promise.all(batch.map((b) => blockText(file, b, compressed)))));
	}
	return out;
}

// One record's fields; FORMAT fields of the (single) sample by name
export function parseRecord(line) {
	const f = line.split("\t");
	const keys = f[8]?.split(":") ?? [];
	const vals = f[9]?.split(":") ?? [];
	const sample = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
	return {
		chrom: f[0],
		pos: Number(f[1]),
		ref: f[3],
		alt: f[4],
		qual: f[5],
		filter: f[6],
		GT: sample.GT,
		GQ: sample.GQ,
		DP: sample.DP,
		AD: sample.AD,
		VAF: sample.VAF,
		PL: sample.PL,
		PS: sample.PS,
		MID: sample.MID,
		line
	};
}

const isGvcfBlock = (alt) => alt === "<*>";
const alleles = (gt) => (gt ?? "").split(/[/|]/);

// Summarizes a DeepVariant VCF (or gVCF: only its variant records). Returns
// {sample, header, compressed, blocks, chroms, records, stats, lists, gvcf}, where blocks is the index used by
// recordsIn and lists hold up to LIST_MAX calls each: lowGq (PASS with GQ < 20), noCall (./.), hetAlt (1/2).
export async function scanVcf(file, onProgress) {
	const compressed = /\.gz$|\.bgz$/i.test(file.name);
	const blocks = compressed
		? await bgzfBlocks(file, onProgress)
		: Array.from({ length: Math.ceil(file.size / TEXT_BLOCK) }, (_, i) => ({ offset: i * TEXT_BLOCK, size: TEXT_BLOCK }));
	const header = [];
	const chroms = [];
	const stats = {
		records: 0,
		filter: {},
		pass: { snp: 0, indel: 0, multiallelic: 0, het: 0, homAlt: 0, hetAlt: 0, transitions: 0, transversions: 0 },
		mid: {},
		gqHistogram: Array(10).fill(0) // PASS calls by GQ, in tens
	};
	const lists = { lowGq: [], noCall: [], hetAlt: [] };
	let gvcf = false,
		rest = "";
	const TRANSITIONS = new Set(["AG", "GA", "CT", "TC"]);

	const handle = (line, blockIndex) => {
		if (!line) return;
		if (line[0] === "#") {
			header.push(line);
			return;
		}
		const tab1 = line.indexOf("\t"),
			tab2 = line.indexOf("\t", tab1 + 1);
		const chrom = line.slice(0, tab1),
			pos = Number(line.slice(tab1 + 1, tab2));
		const block = blocks[blockIndex];
		if (block.chrom === undefined) Object.assign(block, { chrom, pos });
		if (chroms.at(-1) !== chrom) chroms.push(chrom);
		const r = parseRecord(line);
		if (isGvcfBlock(r.alt)) {
			gvcf = true;
			return;
		}
		stats.records++;
		stats.filter[r.filter] = (stats.filter[r.filter] ?? 0) + 1;
		const gq = Number(r.GQ);
		if (r.filter === "PASS") {
			const alts = r.alt.split(",").filter((a) => a !== "<*>");
			const indel = alts.some((a) => a.length !== r.ref.length);
			stats.pass[indel ? "indel" : "snp"]++;
			if (alts.length > 1) stats.pass.multiallelic++;
			const [a, b] = alleles(r.GT);
			if (a !== b && a !== "0" && b !== "0") stats.pass.hetAlt++;
			else if (a === b) stats.pass.homAlt++;
			else stats.pass.het++;
			if (!indel && alts.length === 1 && r.ref.length === 1)
				stats.pass[TRANSITIONS.has(r.ref + alts[0]) ? "transitions" : "transversions"]++;
			if (r.MID) stats.mid[r.MID] = (stats.mid[r.MID] ?? 0) + 1;
			if (gq >= 0) stats.gqHistogram[Math.min(9, Math.floor(gq / 10))]++;
			if (gq < GQ_LOW && lists.lowGq.length < LIST_MAX) lists.lowGq.push(compact(r));
			if (a !== b && a !== "0" && b !== "0" && lists.hetAlt.length < LIST_MAX) lists.hetAlt.push(compact(r));
		} else if (r.filter === "NoCall" && lists.noCall.length < LIST_MAX) lists.noCall.push(compact(r));
	};

	for (let i = 0; i < blocks.length; i += 64) {
		const texts = await blocksText(file, blocks, i, Math.min(blocks.length, i + 64), compressed);
		texts.forEach((text, j) => {
			const lines = (rest + text).split("\n");
			rest = lines.pop();
			// Lines that start in this block (the first may have started in the previous one)
			for (const line of lines) handle(line, i + j);
		});
		onProgress?.((compressed ? 0.5 : 0) + ((i + 64) / blocks.length) * (compressed ? 0.5 : 1));
	}
	handle(rest, blocks.length - 1);
	if (!header.some((l) => l.startsWith("#CHROM"))) throw new Error("That doesn't look like a VCF: there's no #CHROM line.");
	const sample = header.find((l) => l.startsWith("#CHROM")).split("\t")[9] ?? "";
	return {
		sample,
		header,
		compressed,
		blocks,
		chroms,
		stats,
		lists,
		gvcf,
		isDeepVariant: header.some((l) => l.startsWith("##DeepVariant_version"))
	};
}

const compact = (r) => ({
	chrom: r.chrom,
	pos: r.pos,
	ref: r.ref,
	alt: r.alt,
	filter: r.filter,
	GT: r.GT,
	GQ: r.GQ,
	DP: r.DP,
	MID: r.MID
});

// Records of the scanned VCF on chrom between start and end (1-based, inclusive), as parseRecord objects
export async function recordsIn(file, scan, chrom, start, end) {
	const { blocks, chroms, compressed } = scan;
	const order = (c, p) => [chroms.indexOf(c), p];
	const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
	const target = order(chrom, start),
		targetEnd = order(chrom, end);
	// Last block whose first record is before the region, through the first block starting after it
	let from = 0,
		to = blocks.length;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.chrom === undefined) continue;
		const key = order(b.chrom, b.pos);
		if (before(key, target)) from = i;
		if (before(targetEnd, key)) {
			to = i + 1;
			break;
		}
	}
	const text = (await blocksText(file, blocks, from, to, compressed)).join("");
	return text
		.split("\n")
		.filter((l) => l && l[0] !== "#")
		.map(parseRecord)
		.filter((r) => r.chrom === chrom && r.pos >= start && r.pos <= end && !isGvcfBlock(r.alt));
}

// A small VCF (the scan's header plus some records) that IGV can load without an index
export const vcfFile = (scan, records, name) =>
	new File([[...scan.header, ...records.map((r) => r.line)].join("\n") + "\n"], name, { type: "text/plain" });
