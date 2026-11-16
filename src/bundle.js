// A locus as one file: a .zip of the reads at the locus, this run's calls and what DeepVariant made of them,
// to attach to an issue or send to someone, who can open it on this page. No server: it's made and read in the
// browser. Entries are stored, not compressed (BAMs, PNGs and bgzipped VCFs already are).

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
	return n >>> 0;
});
function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const FLAGS = 0x0800; // names are UTF-8
const DOS_DATE = 0x21; // 1980-01-01: the entries carry no dates

// [{name, data: Blob | Uint8Array | string}] -> a .zip as a Blob
export async function makeZip(entries) {
	const encoder = new TextEncoder();
	const parts = [],
		central = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const bytes =
			typeof data === "string" ? encoder.encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
		const nameBytes = encoder.encode(name);
		const crc = crc32(bytes);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, FLAGS, true);
		local.setUint16(12, DOS_DATE, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, bytes.length, true);
		local.setUint32(22, bytes.length, true);
		local.setUint16(26, nameBytes.length, true);
		parts.push(local, nameBytes, bytes);
		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, 20, true);
		entry.setUint16(6, 20, true);
		entry.setUint16(8, FLAGS, true);
		entry.setUint16(14, DOS_DATE, true);
		entry.setUint32(16, crc, true);
		entry.setUint32(20, bytes.length, true);
		entry.setUint32(24, bytes.length, true);
		entry.setUint16(28, nameBytes.length, true);
		entry.setUint32(42, offset, true);
		central.push(entry, nameBytes);
		offset += 30 + nameBytes.length + bytes.length;
	}
	const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// A .zip (File or Blob) -> Map of name -> Blob. Reads stored and deflated entries, so a bundle that was unpacked
// and zipped again still opens.
export async function readZip(file) {
	const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 66000)).arrayBuffer());
	let at = -1;
	for (let i = tail.length - 22; i >= 0; i--)
		if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
			at = i;
			break;
		}
	if (at < 0) throw new Error("That isn't a .zip file.");
	const end = new DataView(tail.buffer, at);
	const count = end.getUint16(10, true),
		size = end.getUint32(12, true),
		start = end.getUint32(16, true);
	const central = new DataView(await file.slice(start, start + size).arrayBuffer());
	const decoder = new TextDecoder();
	const files = new Map();
	let p = 0;
	for (let i = 0; i < count; i++) {
		const method = central.getUint16(p + 10, true),
			compressed = central.getUint32(p + 20, true),
			nameLength = central.getUint16(p + 28, true),
			skip = central.getUint16(p + 30, true) + central.getUint16(p + 32, true),
			offset = central.getUint32(p + 42, true);
		const name = decoder.decode(new Uint8Array(central.buffer, p + 46, nameLength));
		p += 46 + nameLength + skip;
		if (name.endsWith("/")) continue;
		const local = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
		const dataStart = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
		const data = file.slice(dataStart, dataStart + compressed);
		if (method === 0) files.set(name, data);
		else if (method === 8)
			files.set(name, await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob());
		else throw new Error(`Can't read ${name} from the .zip (compression method ${method}).`);
	}
	return files;
}
