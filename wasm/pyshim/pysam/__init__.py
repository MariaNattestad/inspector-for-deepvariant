"""Stand-in for pysam (a 7 MB download in Pyodide). postprocess_variants only uses
pysam.FastaFile to list the reference's contig names and lengths; this provides exactly that,
read with Nucleus' FASTA reader (htslib faidx, the same code pysam wraps). Anything else fails if used.
"""
from tensorflow._shim import Missing as _Missing


class FastaFile:
  def __init__(self, filename):
    from third_party.nucleus.io import fasta
    with fasta.IndexedFastaReader(filename) as reader:
      contigs = sorted(reader.header.contigs, key=lambda c: c.pos_in_fasta)
    self.references = tuple(c.name for c in contigs)
    self.lengths = tuple(c.n_bases for c in contigs)
    self.nreferences = len(contigs)

  def __getattr__(self, name):
    return _Missing(f'pysam.FastaFile.{name}')


def __getattr__(name):
  return _Missing(f'pysam.{name}')
