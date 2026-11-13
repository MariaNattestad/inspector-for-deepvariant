#!/bin/bash
# Runs fullrun.mjs on a region and compares every record with an official DeepVariant VCF:
#
#   ./compare.sh <model key> <reads BAM> <region> <official VCF.gz> <reference FASTA> [pangenome BAM]
#
# e.g. official case-study VCFs: gs://deepvariant/case-study-outputs/1.10.0/ (see wasm/README.md, "Reproducing
# a real run"). Use the inspector's region for the locus (whole partitions; WES: the capture interval).
# Needs bcftools and tabix.
set -euo pipefail
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
key=$1 bam=$(realpath "$2") region=$3 official=$(realpath "$4") ref=$(realpath "$5") pangenome=${6:+$(realpath "$6")}
tmp=$(mktemp -d)
# fullrun.mjs reads its inputs from one folder (Pyodide's Node filesystem doesn't follow symlinks, so hard links,
# or copies across filesystems)
put() { ln "$1" "$tmp/$2" 2>/dev/null || cp "$1" "$tmp/$2"; }
put "$bam" reads.bam && put "$bam.bai" reads.bam.bai
put "$ref" ref.fa && put "$ref.fai" ref.fa.fai
if [ -n "$pangenome" ]; then put "$pangenome" pangenome.bam && put "$pangenome.bai" pangenome.bam.bai; fi
(cd "$DIR" && node fullrun.mjs "$key" "$tmp" reads.bam "$region" ref.fa "$tmp/out.vcf.gz" ${pangenome:+pangenome.bam} | grep -v "^wrote")
zcat < "$tmp/out.vcf.gz" | bgzip > "$tmp/ours.vcf.gz" && tabix -p vcf "$tmp/ours.vcf.gz"
f='%POS %REF %ALT %FILTER [%GT %GQ]\n'
diff <(bcftools query -r "$region" -f "$f" "$official") <(bcftools query -f "$f" "$tmp/ours.vcf.gz") > "$tmp/diff" || true
echo "official: $(bcftools query -r "$region" -f "$f" "$official" | wc -l | tr -d ' ') records, ours: $(bcftools query -f "$f" "$tmp/ours.vcf.gz" | wc -l | tr -d ' '); lines differing (POS REF ALT FILTER GT GQ):"
cat "$tmp/diff"
rm -rf "$tmp"
