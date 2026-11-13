// Alleles, base by base: the reference around a call, and each haplotype of a genotype (the truth's,
// DeepVariant's, your VCF's) lined up against it, with insertions in their own columns, deletions as gaps
// and indels left-aligned, so the same variant written two ways (CT>CTTTT and C>CTTT) looks the same.

// The reference's sequence, read with range requests through its .fai: [start, end], 1-based inclusive
const fais = new Map();
async function fai(url) {
	if (!fais.has(url))
		fais.set(
			url,
			fetch(url)
				.then((r) => {
					if (!r.ok) throw new Error(`HTTP ${r.status} for the reference index`);
					return r.text();
				})
				.then((text) => {
					const index = new Map();
					for (const line of text.split("\n")) {
						const [name, length, offset, lineBases, lineWidth] = line.split("\t");
						if (name) index.set(name, { length: +length, offset: +offset, lineBases: +lineBases, lineWidth: +lineWidth });
					}
					return index;
				})
		);
	return fais.get(url);
}
export async function referenceSequence(reference, chrom, start, end) {
	const contig = (await fai(reference.fai)).get(chrom);
	if (!contig) throw new Error(`${chrom} isn't in the reference`);
	start = Math.max(1, start);
	end = Math.min(contig.length, end);
	const byte = (pos) =>
		contig.offset + Math.floor((pos - 1) / contig.lineBases) * contig.lineWidth + ((pos - 1) % contig.lineBases);
	const response = await fetch(reference.fasta, { headers: { Range: `bytes=${byte(start)}-${byte(end)}` } });
	if (response.status !== 206) throw new Error(`The reference server didn't send a range (HTTP ${response.status})`);
	return { start, seq: (await response.text()).replace(/\s/g, "").toUpperCase() };
}

// One allele's edits against the reference window R (starting at 1-based position W0): substitutions,
// an insertion after a window offset, or deleted offsets. Indels are moved left while the bases allow.
function edits(R, W0, pos, ref, alt) {
	let p = 0;
	while (p < ref.length && p < alt.length && ref[p] === alt[p]) p++;
	let s = 0;
	while (s < ref.length - p && s < alt.length - p && ref[ref.length - 1 - s] === alt[alt.length - 1 - s]) s++;
	const r = ref.slice(p, ref.length - s),
		a = alt.slice(p, alt.length - s);
	const at = pos - W0 + p;
	const n = Math.min(r.length, a.length);
	const out = [];
	for (let i = 0; i < n; i++) if (r[i] !== a[i]) out.push({ type: "sub", at: at + i, base: a[i] });
	if (a.length > r.length) {
		let seq = a.slice(n),
			before = at + n; // inserted before this offset
		if (!n)
			while (before > 0 && R[before - 1] === seq[seq.length - 1]) {
				seq = seq[seq.length - 1] + seq.slice(0, -1);
				before--;
			}
		out.push({ type: "ins", after: before - 1, seq });
	} else if (r.length > a.length) {
		let start = at + n;
		const length = r.length - n;
		if (!n) while (start > 0 && R[start - 1] === R[start + length - 1]) start--;
		for (let i = 0; i < length; i++) out.push({ type: "del", at: start + i });
	}
	return out;
}

// A genotype's haplotypes from VCF-like records ({pos, ref, alt: "A,B", gt: "1/2"}), in genotype order (not
// phased, unless the genotypes are): [{edits}] for each, or {unknown} where a genotype is ./.
function haplotypes(R, W0, records) {
	const haps = [[], []];
	const unknown = [];
	for (const rec of records) {
		const gt = rec.gt.split(/[/|]/);
		if (gt.includes(".")) {
			unknown.push(rec);
			continue;
		}
		const alts = rec.alt.split(",");
		gt.slice(0, 2).forEach((g, k) => {
			if (g !== "0") haps[k].push(...edits(R, W0, rec.pos, rec.ref, alts[Number(g) - 1]));
		});
	}
	return { haps, unknown };
}

const sequenceOf = (R, hap) => {
	const del = new Set(hap.filter((e) => e.type === "del").map((e) => e.at));
	const sub = new Map(hap.filter((e) => e.type === "sub").map((e) => [e.at, e.base]));
	const ins = new Map(hap.filter((e) => e.type === "ins").map((e) => [e.after, e.seq]));
	let s = ins.get(-1) ?? "";
	for (let i = 0; i < R.length; i++) s += (del.has(i) ? "" : (sub.get(i) ?? R[i])) + (ins.get(i) ?? "");
	return s;
};

// The view: {columns, rows: [{label, sub, cells: [{ch, kind}]}], groups} for the reference and each set of
// records ({label, records}); kind is ref | match | sub | ins | del | gap. Each set also gets `same`: whether
// its two haplotypes equal the first set's (the truth), as sequences.
export function alleleView(window, sets) {
	const { start: W0, seq: R } = window;
	const built = sets.map((set) => ({ ...set, ...haplotypes(R, W0, set.records) }));
	const width = new Map(); // insertion slot (after offset) -> columns
	for (const set of built)
		for (const hap of set.haps)
			for (const e of hap) if (e.type === "ins") width.set(e.after, Math.max(width.get(e.after) ?? 0, e.seq.length));
	const slot = (after, ins, kind) => {
		const w = width.get(after) ?? 0;
		return Array.from({ length: w }, (_, j) => (ins && j < ins.length ? { ch: ins[j], kind } : { ch: "-", kind: "gap" }));
	};
	const refCells = [...slot(-1, "", "gap")];
	for (let i = 0; i < R.length; i++) refCells.push({ ch: R[i], kind: "ref", pos: W0 + i }, ...slot(i, "", "gap"));
	const rowFor = (hap) => {
		const del = new Set(hap.filter((e) => e.type === "del").map((e) => e.at));
		const sub = new Map(hap.filter((e) => e.type === "sub").map((e) => [e.at, e.base]));
		const ins = new Map(hap.filter((e) => e.type === "ins").map((e) => [e.after, e.seq]));
		const cells = [...slot(-1, ins.get(-1), "ins")];
		for (let i = 0; i < R.length; i++) {
			if (del.has(i)) cells.push({ ch: "–", kind: "del" });
			else if (sub.has(i)) cells.push({ ch: sub.get(i), kind: "sub" });
			else cells.push({ ch: R[i], kind: "match" });
			cells.push(...slot(i, ins.get(i), "ins"));
		}
		return cells;
	};
	const key = (set) =>
		set.haps
			.map((h) => sequenceOf(R, h))
			.sort()
			.join("|");
	const truthKey = built.length && !built[0].unknown.length ? key(built[0]) : null;
	return {
		ref: refCells,
		sets: built.map((set, i) => ({
			label: set.label,
			note: set.note,
			unknown: set.unknown,
			rows: set.haps.map(rowFor),
			same: i > 0 && truthKey !== null && !set.unknown.length ? key(set) === truthKey : null
		}))
	};
}

// The window to show: the records' spans and a few bases either side, at most ~80 bp of reference
export function windowAround(records, pad = 10) {
	const starts = records.map((r) => r.pos),
		ends = records.map((r) => r.pos + r.ref.length - 1);
	let start = Math.min(...starts) - pad,
		end = Math.max(...ends) + pad;
	if (end - start > 80) end = start + 80;
	return { start, end };
}
