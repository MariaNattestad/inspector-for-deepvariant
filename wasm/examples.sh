#!/bin/bash
# Makes the inspector's example BAMs (src/models.js): reads of
# HG003 (GRCh38, chr20) from each of DeepVariant's case studies, around hard calls. Read over HTTP from
# DeepVariant's bucket, so only the slices are downloaded. ./build.sh copies them to data/.
#
#   ./wasm/examples.sh [GBZ_DB]
#
# Needs samtools. The pangenome example also needs gbz-base's `query` on PATH and the HPRC v1.1 graph as a
# GBZ-base database (GBZ_DB; 6.3 GB, from the URL below); without it, that BAM is skipped.
# Regions: whole partitions of each model around each site (25 kb for long reads, whose phasing sees one
# partition; 1 kb otherwise), or for WES the capture interval, so runs reproduce the case studies' (README).
set -euo pipefail
DIR_SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=$DIR_SCRIPT/build/examples
GCS=https://storage.googleapis.com/deepvariant
mkdir -p "$OUT" && cd "$OUT"

# slice <out name> <BAM under $GCS> <BED intervals (0-based) as start end start end ...>
slice() {
	local name=$1 bam=$2
	shift 2
	printf 'chr20\t%s\t%s\n' "$@" > "$name.bed"
	samtools view -b -M -L "$name.bed" "$GCS/$bam" 2>/dev/null > "$name.bam"
	samtools index "$name.bam"
	rm "$name.bed"
	echo "$name.bam: $(samtools view -c "$name.bam") reads"
}

# Illumina WGS (also the reads for pangenome-aware): 1 kb around 5 sites (partitions + some context)
slice HG003.chr20.inspect_examples case-study-testdata/HG003.novaseq.pcr-free.35x.dedup.grch38_no_alt.chr20.bam \
	9155818 9157819 12441384 12443385 26262467 26264468 35437862 35439863 51725888 51727889
# Illumina WES: the IDT capture interval around chr20:62,065,249 (idt_capture_novogene.grch38.bed)
slice HG003.wes.chr20.inspect_examples exome-case-study-testdata/HG003.novaseq.wes_idt.100x.dedup.bam 62064450 62065810
# PacBio HiFi and ONT R10.4.1: whole 25 kb partitions. The ONT BAM is the one the official 1.10 output came
# from (its read depths match): not the 80x BAM the ONT case study names.
slice HG003.pacbio.chr20.inspect_examples pacbio-case-study-testdata/HG003.SPRQ.pacbio.GRCh38.nov2024.chr20.bam \
	325000 350000 800000 825000
slice HG003.ont_r104.chr20.inspect_examples ont-case-study-testdata/HG003_PAY87794.calls.sorted.bam \
	225000 250000 325000 350000
# Hybrid PacBio HiFi + Illumina
slice HG003.hybrid_pacbio_illumina.chr20.inspect_examples \
	hybrid-case-study-testdata/HG003_hybrid_35x_ilmn_35x_pacb.grch38.phased.chr20.bam 4760752 4762753

# Pangenome-aware: HPRC v1.1's haplotypes around the two WGS sites it gets right, as a BAM
# (tools/gbz_haplotypes_bam.py; graph: $GCS/pangenome-case-study-testdata/hprc-v1.1-mc-grch38.gbz.db)
DB=${1:-}
if [ -n "$DB" ]; then
	for locus in chr20:26263001-26264000 chr20:35438001-35439000; do
		python3 "$DIR_SCRIPT/tools/gbz_haplotypes_bam.py" "$DB" "$locus" HG003.chr20.inspect_examples.bam "pangenome.$locus.bam"
	done
	samtools merge -f HG003.pangenome.chr20.inspect_examples.hprc_v1.1.bam pangenome.chr20:*.bam
	samtools index HG003.pangenome.chr20.inspect_examples.hprc_v1.1.bam
	rm pangenome.chr20:*.bam*
else
	echo "No GBZ-base database given: skipping the pangenome example's BAM"
fi
