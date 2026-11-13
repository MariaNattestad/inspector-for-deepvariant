"""IPython isn't loaded in the browser build (only Nucleus' notebook visualisation uses it); fails only if used."""
from tensorflow._shim import Missing as _Missing

def __getattr__(name):
  return _Missing(f'IPython.{name}')
