// DeepVariant 1.10's models, as run_deepvariant names them (--model_type), with what the inspect page needs to
// know about each, and hard examples for each from DeepVariant's own case studies. The browser runs these
// models through wasm/deepvariant/web/worker.mjs; model files: wasm/deepvariant/README.md ("Models").

const DOCS = "https://github.com/google/deepvariant/blob/r1.10/docs";

// Pileup image channels (DeepVariantChannelEnum in deepvariant/protos/deepvariant.proto)
export const CHANNELS = {
	1: { name: "read base", about: "the base each read has at each position" },
	2: { name: "base quality", about: "its base quality" },
	3: { name: "mapping quality", about: "the read's mapping quality" },
	4: { name: "strand", about: "forward or reverse strand" },
	5: { name: "read supports variant", about: "whether the read supports the candidate's alternate allele" },
	6: { name: "base differs from ref", about: "bases that differ from the reference" },
	7: { name: "haplotype", about: "the read's haplotype from DeepVariant's own phasing (rows are sorted by it)" },
	9: { name: "alt allele 1", about: "difference between the reads and the first alternate allele's haplotype" },
	10: { name: "alt allele 2", about: "the same for the second alternate allele (multiallelic sites)" },
	19: { name: "insert size", about: "the read pair's insert size" },
	25: { name: "read supports variant (fuzzy)", about: "like read supports variant, tolerant of nearby indel errors" },
	26: { name: "supplementary alignment", about: "whether the alignment is supplementary" }
};

// The examples are HG003 on GRCh38, chr20: the sample DeepVariant's case studies evaluate on (chr20 is held out
// of training). Each is a site where the official DeepVariant 1.10 run disagrees with GIAB v4.2.1 (its hap.py
// output, gs://deepvariant/case-study-outputs/1.10.0/), a low-confidence call, or a hard site it gets right
// where another model doesn't, cut from the case study's own BAM. How they were picked and made: wasm/deepvariant/README.md ("Examples").
const WGS_EXAMPLES_BAM = "data/HG003.chr20.inspect_examples.bam";

// Each example also has a short label and its kind (missed, wrong genotype, extra allele, low confidence,
// or called: a site another model misses), for the list of examples.
export const MODELS = [
	{
		key: "wgs",
		short: "WGS", // on the examples list's tiles
		reads: "short", // "short" | "long" | "both"
		about: "Realigns reads around each candidate. A small model calls the easy candidates, the CNN the rest.",
		modelType: "WGS",
		name: "Illumina WGS",
		caseStudy: `${DOCS}/deepvariant-case-study.md`,
		partitionSize: 1000,
		realigns: true,
		smallModel: true,
		channels: [1, 2, 3, 4, 5, 6, 19],
		bam: WGS_EXAMPLES_BAM,
		examples: [
			{
				pos: 26263468,
				what: "a missed 3 bp insertion",
				label: "3 bp insertion",
				kind: "missed",
				truth: "T>TATC, 0/1",
				official: "no-call (./., GQ 7)",
				note: "Realignment gives the insertion to reads that, as aligned, show it as mismatches. Pangenome-aware DeepVariant calls it."
			},
			{
				pos: 35438863,
				what: "a missed 2 bp insertion",
				label: "2 bp insertion",
				kind: "missed",
				truth: "A>ATG, 1/1",
				official: "no-call (./., GQ 6)",
				note: "Pangenome-aware DeepVariant calls it."
			},
			{
				pos: 9156819,
				what: "a CCTC repeat, wrong genotype",
				label: "CCTC repeat",
				kind: "wrong genotype",
				truth: "G>GCCTC and a longer CCTC expansion, 1/2",
				official: "0/1 G>GCCTC (GQ 7): the longer allele is missed"
			},
			{
				pos: 12442385,
				what: "a TG repeat, wrong genotype",
				label: "TG repeat",
				kind: "wrong genotype",
				truth: "TTG>T and a TG expansion, 1/2",
				official: "0/1 TTG>T (GQ 21): the expansion is missed"
			},
			{
				pos: 51726889,
				what: "a poly-T run, extra false allele",
				label: "Poly-T run",
				kind: "extra allele",
				truth: "CTTTTTTTTTT>C (a 10 bp poly-T deletion), 0/1",
				official: "1/2 (GQ 29): the deletion plus an extra T that isn't there"
			},
			{
				pos: 31460620,
				what: "a 6 bp poly-A insertion, called",
				label: "Poly-A insertion",
				kind: "called",
				truth: "C>CAAAAAA, 0/1",
				official: "0/1 (GQ 16), by the small model",
				note: "Only 2 of 32 reads support the full 6 bp insertion, and it's right. PacBio and ONT get its length wrong."
			},
			{
				pos: 62491856,
				what: "two 35 bp insertions, called",
				label: "Two 35 bp insertions",
				kind: "called",
				truth: "C>C+35 bp and another 35 bp allele, 1/2",
				official: "1/2 (GQ 5)",
				note: "Right, though barely confident: pangenome-aware WGS calls it 1/1."
			}
		]
	},
	{
		key: "wes",
		short: "WES", // on the examples list's tiles
		reads: "short", // "short" | "long" | "both"
		about: "Short reads in capture regions. Realigns reads around each candidate; the CNN calls every one.",
		modelType: "WES",
		name: "Illumina WES (exome)",
		caseStudy: `${DOCS}/deepvariant-exome-case-study.md`,
		partitionSize: 1000,
		realigns: true,
		smallModel: false,
		// run_deepvariant gets the capture BED as --regions, so partitions start at each capture interval
		captureRegions: true,
		channels: [1, 2, 3, 4, 5, 6, 19],
		bam: "data/HG003.wes.chr20.inspect_examples.bam",
		examples: [
			{
				pos: 62065249,
				region: "chr20:62064451-62065810", // the IDT capture interval around it (idt_capture_novogene.grch38.bed)
				what: "a low-confidence 6 bp deletion",
				label: "6 bp deletion",
				kind: "low confidence",
				truth: "outside GIAB's confident regions",
				official: "1/1 TGCCAGG>T (GQ 9)",
				note: "All 29 reads support the deletion, yet GQ is 9."
			}
		]
	},
	{
		key: "pacbio",
		short: "HiFi", // on the examples list's tiles
		reads: "long", // "short" | "long" | "both"
		about:
			"Long reads aren't realigned: DeepVariant phases them itself and sorts pileup rows by haplotype. A small model calls the easy candidates.",
		modelType: "PACBIO",
		name: "PacBio HiFi",
		caseStudy: `${DOCS}/deepvariant-pacbio-model-case-study.md`,
		partitionSize: 25000,
		realigns: false,
		smallModel: true,
		phases: true,
		channels: [1, 2, 3, 4, 5, 6, 7, 26, 9, 10],
		bam: "data/HG003.pacbio.chr20.inspect_examples.bam",
		examples: [
			{
				pos: 818488,
				what: "a homopolymer, wrong genotype",
				label: "Homopolymer",
				kind: "wrong genotype",
				truth: "A>AT and A>ATT, 1/2",
				official: "1/1 A>AT (GQ 13): the ATT allele is missed",
				note: "Only 7 reads cover it."
			},
			{
				pos: 348853,
				what: "a missed 1 bp deletion",
				label: "1 bp deletion",
				kind: "missed",
				truth: "GA>G, 0/1",
				official: "no-call (./., GQ 6)",
				note: "Oxford Nanopore misses it too (see the ONT examples)."
			},
			{
				pos: 9156819,
				what: "a CCTC repeat expansion, called",
				label: "CCTC repeat",
				kind: "called",
				truth: "G>GCCTC and a longer CCTC expansion, 1/2",
				official: "2|1 (GQ 58), by the small model",
				note: "Long reads span the 20 bp expansion that short reads can't; Illumina WGS misses that allele."
			},
			{
				pos: 8643753,
				what: "a 30 bp insertion in a TC repeat, called",
				label: "30 bp insertion",
				kind: "called",
				truth: "C>C+30 bp, 0/1",
				official: "1|0 (GQ 26), by the small model",
				note: "Illumina WGS and pangenome-aware WGS miss it."
			}
		]
	},
	{
		key: "ont_r104",
		short: "ONT", // on the examples list's tiles
		reads: "long", // "short" | "long" | "both"
		about:
			"Phased like PacBio, with a read-support channel that tolerates nearby indel errors. A small model calls the easy candidates.",
		modelType: "ONT_R104",
		name: "Oxford Nanopore R10.4.1",
		caseStudy: `${DOCS}/deepvariant-ont-r104-simplex-case-study.md`,
		partitionSize: 25000,
		realigns: false,
		smallModel: true,
		phases: true,
		channels: [1, 2, 3, 4, 5, 6, 7, 25, 9, 10],
		bam: "data/HG003.ont_r104.chr20.inspect_examples.bam",
		examples: [
			{
				pos: 238845,
				what: "a homopolymer insertion, wrong genotype",
				label: "Homopolymer insertion",
				kind: "wrong genotype",
				truth: "G>GA, 1/1",
				official: "0/1 (GQ 4)"
			},
			{
				pos: 348853,
				what: "a missed 1 bp deletion",
				label: "1 bp deletion",
				kind: "missed",
				truth: "GA>G, 0/1",
				official: "no-call (./., GQ 16)",
				note: "PacBio misses it too (see the PacBio examples)."
			},
			{
				pos: 9156819,
				what: "a CCTC repeat expansion, called",
				label: "CCTC repeat",
				kind: "called",
				truth: "G>GCCTC and a longer CCTC expansion, 1/2",
				official: "1|2 (GQ 64), by the small model",
				note: "Long reads span the 20 bp expansion that short reads can't; Illumina WGS misses that allele."
			},
			{
				pos: 60029408,
				what: "a 21 bp insertion, called",
				label: "21 bp insertion",
				kind: "called",
				truth: "G>G+21 bp, 0/1",
				official: "0|1 (GQ 21), by the small model",
				note: "Illumina WGS and pangenome-aware WGS miss it."
			}
		]
	},
	{
		key: "hybrid_pacbio_illumina",
		short: "Hybrid", // on the examples list's tiles
		reads: "both", // "short" | "long" | "both"
		about:
			"PacBio HiFi and Illumina reads of one sample in the same pileup. Realigns reads around each candidate; the CNN calls every one.",
		modelType: "HYBRID_PACBIO_ILLUMINA",
		name: "Hybrid PacBio HiFi + Illumina",
		caseStudy: `${DOCS}/deepvariant-hybrid-case-study.md`,
		partitionSize: 1000,
		realigns: true,
		smallModel: false,
		channels: [1, 2, 3, 4, 5, 6],
		bam: "data/HG003.hybrid_pacbio_illumina.chr20.inspect_examples.bam",
		examples: [
			{
				pos: 4761753,
				what: "a homozygous SNP called heterozygous",
				label: "Homozygous SNP",
				kind: "wrong genotype",
				truth: "A>G, 1/1",
				official: "0/1 (GQ 4)",
				note: "All 63 reads support G. Next to it, DeepVariant also calls a false 2 bp insertion."
			},
			{
				pos: 9156819,
				what: "a CCTC repeat expansion, called",
				label: "CCTC repeat",
				kind: "called",
				truth: "G>GCCTC and a longer CCTC expansion, 1/2",
				official: "1/2 (GQ 61)",
				note: "The PacBio reads span the expansion that the Illumina reads alone miss."
			},
			{
				pos: 8643753,
				what: "a 30 bp insertion in a TC repeat, called",
				label: "30 bp insertion",
				kind: "called",
				truth: "C>C+30 bp, 0/1",
				official: "0/1 (GQ 18)",
				note: "Illumina WGS alone misses it."
			}
		]
	},
	{
		key: "wgs_pangenome",
		short: "Pangenome", // on the examples list's tiles
		reads: "short", // "short" | "long" | "both"
		about: "The WGS reads plus pangenome haplotypes (HPRC) as extra rows in each pileup image. The CNN calls every candidate.",
		modelType: "WGS, pangenome-aware",
		name: "Pangenome-aware WGS",
		caseStudy: `${DOCS}/pangenome-aware-wgs-bwa-case-study.md`,
		partitionSize: 1000,
		realigns: true,
		smallModel: false,
		pangenome: true,
		// 200 rows: the pangenome's haplotypes on top, the sample's reads below
		channels: [1, 2, 3, 4, 5, 6, 19],
		bam: WGS_EXAMPLES_BAM,
		pangenomeBam: "data/HG003.pangenome.chr20.inspect_examples.hprc_v1.1.bam",
		examples: [
			{
				pos: 26263468,
				what: "the insertion WGS misses, called",
				label: "3 bp insertion",
				kind: "called",
				truth: "T>TATC, 0/1",
				official: "0/1 (GQ 18), as T>C next to a T>TTTAC insertion; the WGS model's no-call",
				note: "Same reads as the first Illumina WGS example."
			},
			{
				pos: 35438863,
				what: "the 2 bp insertion WGS misses, called",
				label: "2 bp insertion",
				kind: "called",
				truth: "A>ATG, 1/1",
				official: "1/1 (GQ 13); the WGS model's no-call",
				note: "Same reads as the second Illumina WGS example."
			}
		]
	}
];

export const modelByKey = (key) => MODELS.find((m) => m.key === key);

// make_examples splits regions into partitions of partition_size, starting at each region's start. A
// whole-genome run (no --regions, or a whole chromosome) starts at the contig's start, so to reproduce it,
// use whole partitions of that grid. This matters most for long reads, whose phasing only sees one 25 kb
// partition. Returns 1-based inclusive {start, end}.
export function partitionsAround(start, end, partitionSize) {
	return {
		start: Math.floor((start - 1) / partitionSize) * partitionSize + 1,
		end: Math.ceil(end / partitionSize) * partitionSize
	};
}

// An example's region: its capture interval (WES) or the partition around it
export function exampleRegion(model, example) {
	if (example.region) return example.region;
	const { start, end } = partitionsAround(example.pos, example.pos, model.partitionSize);
	return `chr20:${start}-${end}`;
}

// Read types, in the order the examples list shows them
export const READ_TYPES = [
	{ key: "short", name: "Short reads" },
	{ key: "long", name: "Long reads" },
	{ key: "both", name: "Short + long reads" }
];

// The same site as an example in other models (e.g. WGS's missed insertion, called by pangenome-aware WGS)
export function sameSiteElsewhere(model, example) {
	return MODELS.filter((m) => m !== model).flatMap((m) =>
		m.examples.map((ex, i) => ({ model: m, index: i, ex })).filter(({ ex }) => ex.pos === example.pos)
	);
}
