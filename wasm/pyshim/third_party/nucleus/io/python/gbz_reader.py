"""Pangenome (GBZ) reader is not part of the browser build; fails only if used."""
from tensorflow._shim import Missing as _Missing

def __getattr__(name):
  return _Missing(f'gbz_reader.{name}')
