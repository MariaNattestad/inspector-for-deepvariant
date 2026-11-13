"""pandas isn't loaded in the browser build (4 MB). show_examples imports it but only uses it for
--curate and --filter_by_tsv; those fail if used."""
from tensorflow._shim import Missing as _Missing

def __getattr__(name):
  return _Missing(f'pandas.{name}')
