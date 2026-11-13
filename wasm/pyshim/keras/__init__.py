"""Browser stand-in for `keras`: lets DeepVariant's small-model modules import.

The small model itself runs as numpy (keras/_small_model.py), not through Keras.
"""
from tensorflow._shim import Missing as _Missing
import types as _types

def _register_keras_serializable(*a, **k):
  return lambda obj: obj
utils = _types.SimpleNamespace(register_keras_serializable=_register_keras_serializable)
saving = _types.SimpleNamespace(register_keras_serializable=_register_keras_serializable)

from keras import _small_model as _sm
models = _types.SimpleNamespace(load_model=_sm.load_model)

class Model:
  """Placeholder type, used in annotations."""

def __getattr__(name):
  return _Missing(f'keras.{name}')
