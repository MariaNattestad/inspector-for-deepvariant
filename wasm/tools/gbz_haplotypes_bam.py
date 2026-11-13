"""Pangenome haplotypes around a locus as a BAM, for pangenome-aware DeepVariant's --pangenome.

run_pangenome_aware_deepvariant takes the pangenome as a GBZ (e.g. hprc-v1.1-mc-grch38.gbz) or as a BAM of
haplotypes aligned to the reference. A GBZ is too big for the browser, so the inspect page takes the BAM:
this script makes one for a locus, the way DeepVariant's own GBZ reader turns the graph into reads
(third_party/nucleus/io/gbz_reader.cc): the subgraph around the locus with 1 kb of context, and each
haplotype walk in it as a read named haplotype_<n>, placed at the reference walk's start, with the walk's
CIGAR relative to the reference, mapping quality 90 and base qualities 30.

Needs gbz-base's `query` (https://github.com/jltsiren/gbz-base) with a GBZ-base database of the graph
(`gbz2db graph.gbz`; for HPRC v1.1 there's one at
gs://deepvariant/pangenome-case-study-testdata/hprc-v1.1-mc-grch38.gbz.db), and samtools.

Usage: python3 gbz_haplotypes_bam.py GRAPH.gbz.db chr20:26263001-26264000 READS.bam OUT.bam
  READS.bam: your reads, for the BAM header (contig names and lengths)
  The locus should be what the inspect page runs on: whole 1 kb partitions (shown under "Position").
"""
import re
import subprocess
import sys

COMPLEMENT = str.maketrans("ACGTNacgtn", "TGCANtgcan")


def haplotype_reads(gfa, sample="GRCh38"):
  """SAM records (no header) for the haplotype walks of a GFA subgraph from `query --cigar`."""
  segments, walks = {}, []
  for line in gfa.splitlines():
    f = line.split("\t")
    if f[0] == "S":
      segments[f[1]] = f[2]
    elif f[0] == "W":
      walks.append(f)

  def sequence(walk):
    parts = []
    for orientation, node in re.findall(r"([<>])([^<>]+)", walk):
      seq = segments[node]
      parts.append(seq if orientation == ">" else seq.translate(COMPLEMENT)[::-1])
    return "".join(parts)

  ref = next(w for w in walks if w[1] == sample)
  contig, start = ref[3], int(ref[4])
  records, n = [], 0
  for w in walks:
    if w is ref:
      continue
    n += 1
    cigar = next((t[5:] for t in w[7:] if t.startswith("CG:Z:")), None)
    if not cigar:
      sys.exit(f"Walk {n} has no CIGAR: was the subgraph made with `query --cigar`?")
    seq = sequence(w[6])
    # 67: paired, properly placed, first of pair, as gbz_reader's reads (number_reads 2, proper_placement)
    records.append("\t".join([f"haplotype_{n}", "67", contig, str(start + 1), "90", cigar, "*", "0", "0", seq, "?" * len(seq)]))
  return records


def main():
  if len(sys.argv) != 5:
    sys.exit(__doc__)
  db, locus, reads, out = sys.argv[1:]
  m = re.fullmatch(r"(.+):(\d+)-(\d+)", locus.replace(",", ""))
  if not m:
    sys.exit(f"Locus {locus}: expected chrom:start-end")
  contig, start, end = m[1], int(m[2]), int(m[3])
  gfa = subprocess.run(
      ["query", "--sample", "GRCh38", "--contig", contig, "--interval", f"{start - 1}..{end}", "--context", "1000", "--cigar", db],
      check=True, capture_output=True, text=True).stdout
  header = subprocess.run(["samtools", "view", "-H", reads], check=True, capture_output=True, text=True).stdout
  sq = [l for l in header.splitlines() if l.startswith("@SQ")]
  sam = "\n".join(sq + ["@RG\tID:pangenome\tSM:hprc_v1.1"] + haplotype_reads(gfa)) + "\n"
  subprocess.run(["samtools", "sort", "-o", out, "-"], input=sam, text=True, check=True)
  subprocess.run(["samtools", "index", out], check=True)
  print(f"Wrote {out}")


if __name__ == "__main__":
  main()
