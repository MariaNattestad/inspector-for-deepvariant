// Where a BAM's reads are, from its header and index alone (a few small reads, whatever the BAM's size), so a
// run can start without a position. Works on a File or a URL (range requests).

const decoder = new TextDecoder();

// Bytes [start, start + length) of a File or URL (fewer at the end of the file)
async function readRange(src, start, length) {
	if (typeof src !== "string") return new Uint8Array(await src.slice(start, start + length).arrayBuffer());
	const response = await fetch(src, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (response.status === 206) return new Uint8Array(await response.arrayBuffer());
	// The server ignored the range: read only what's needed of the whole file, then stop
	const reader = response.body.getReader();
	const out = new Uint8Array(start + length);
	let n = 0;
	while (n < out.length) {
		const { done, value } = await reader.read();
		if (done) break;
		out.set(value.subarray(0, out.length - n), n);
		n += value.length;
	}
	reader.cancel();
	return out.subarray(start, Math.min(n, out.length));
}

async function readAll(src) {
	if (typeof src !== "string") return new Uint8Array(await src.arrayBuffer());
	const response = await fetch(src);
	if (!response.ok) throw new Error(`HTTP ${response.status} for the index`);
	return new Uint8Array(await response.arrayBuffer());
}

const gunzip = async (bytes) =>
	new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

// Decompress the BGZF blocks in `bytes` (which start at a block), until `want` bytes are out or the blocks run out
async function inflate(bytes, want) {
	const parts = [];
	let offset = 0,
		total = 0;
	while (offset + 18 <= bytes.length && total < want) {
		const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
		const blockSize = view.getUint16(16, true) + 1; // BSIZE: the BGZF extra field
		if (offset + blockSize > bytes.length) break;
		const block = await gunzip(bytes.subarray(offset, offset + blockSize));
		parts.push(block);
		total += block.length;
		offset += blockSize;
	}
	const out = new Uint8Array(total);
	let n = 0;
	for (const p of parts) out.set(p, (n += p.length) - p.length);
	return out;
}

// The BAM header: contig names and lengths
async function readHeader(bam) {
	for (let size = 1 << 18; ; size *= 4) {
		const data = await inflate(await readRange(bam, 0, size), Infinity);
		const view = new DataView(data.buffer);
		if (decoder.decode(data.subarray(0, 4)) !== "BAM\x01") throw new Error("That's not a BAM file.");
		try {
			let p = 8 + view.getInt32(4, true);
			const nRef = view.getInt32(p, true);
			p += 4;
			const contigs = [];
			for (let i = 0; i < nRef; i++) {
				const nameLength = view.getInt32(p, true);
				contigs.push({
					name: decoder.decode(data.subarray(p + 4, p + 4 + nameLength - 1)),
					length: view.getInt32(p + 4 + nameLength, true)
				});
				p += 8 + nameLength;
			}
			return contigs;
		} catch (e) {
			if (!(e instanceof RangeError) || size > 1 << 26) throw e; // header longer than what was read: read more
		}
	}
}

// From a .bai or .csi: per contig, the smallest virtual offset of its reads and roughly where they end
function parseIndex(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset);
	const magic = decoder.decode(bytes.subarray(0, 4));
	let p, minShift, depth;
	if (magic === "BAI\x01") [p, minShift, depth] = [4, 14, 5];
	else if (magic === "CSI\x01") {
		[minShift, depth] = [view.getInt32(4, true), view.getInt32(8, true)];
		p = 16 + view.getInt32(12, true);
	} else throw new Error("The index isn't a .bai or .csi file.");
	const csi = magic === "CSI\x01";
	const pseudoBin = ((1 << ((depth + 1) * 3)) - 1) / 7 + 1;
	const u64 = (at) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
	// A bin's level and start
	const binStart = (bin) => {
		let level = 0,
			first = 0;
		while (bin >= first + (1 << (3 * level))) first += 1 << (3 * level++);
		return (bin - first) * 2 ** (minShift + 3 * (depth - level));
	};
	const nRef = view.getInt32(p, true);
	p += 4;
	const refs = [];
	for (let r = 0; r < nRef; r++) {
		const nBin = view.getInt32(p, true);
		p += 4;
		let first = Infinity,
			lastStart = -1;
		for (let b = 0; b < nBin; b++) {
			const bin = view.getUint32(p, true);
			p += csi ? 12 : 4; // CSI: + loffset
			const nChunk = view.getInt32(p, true);
			p += 4;
			if (bin !== pseudoBin && nChunk) {
				first = Math.min(first, u64(p));
				lastStart = Math.max(lastStart, binStart(bin));
			}
			p += 16 * nChunk;
		}
		if (!csi) p += 4 + 8 * view.getInt32(p, true); // linear index
		refs.push(lastStart < 0 ? null : { first, end: lastStart + 2 ** minShift });
	}
	return refs;
}

// {contigs, chrom, start, end}: the first contig with reads, its first read's position (1-based) and about where
// its reads end (to 16 kb)
export async function locateReads(bam, index) {
	const [contigs, refs] = await Promise.all([readHeader(bam), readAll(index).then(parseIndex)]);
	const r = refs.findIndex((x) => x);
	if (r < 0) return { contigs };
	const { first, end } = refs[r];
	const coffset = Math.floor(first / 65536),
		uoffset = first % 65536;
	const data = await inflate(await readRange(bam, coffset, 3 * 65536), uoffset + 12);
	const view = new DataView(data.buffer);
	const ref = view.getInt32(uoffset + 4, true),
		pos = view.getInt32(uoffset + 8, true) + 1;
	return {
		contigs,
		chrom: contigs[ref]?.name ?? contigs[r].name,
		start: pos,
		end: Math.min(Math.max(end, pos), contigs[r].length)
	};
}

// The reference a BAM was aligned to, from its contig lengths (chr1 or 1)
export function guessReference(contigs) {
	const chr1 = contigs.find((c) => c.name === "chr1" || c.name === "1");
	if (chr1?.length === 248956422) return "hg38";
	if (chr1?.length === 249250621) return "hg19";
	const chr20 = contigs.find((c) => c.name === "chr20" || c.name === "20");
	if (chr20?.length === 64444167) return "hg38";
	if (chr20?.length === 63025520) return "hg19";
	return null;
}
