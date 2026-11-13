"""Browser stand-in for `tensorflow` (see _shim.py)."""
import types as _types
from tensorflow._shim import Missing as _Missing, data, gfile as _gfile, TFRecordWriter as _TFRecordWriter, TFRecordOptions as _TFRecordOptions
from third_party.nucleus.protos import example_pb2 as _example_pb2, feature_pb2 as _feature_pb2

__version__ = '0.0-browser-shim'
train = _types.SimpleNamespace(
    Example=_example_pb2.Example, SequenceExample=_example_pb2.SequenceExample,
    Features=_feature_pb2.Features, Feature=_feature_pb2.Feature,
    BytesList=_feature_pb2.BytesList, Int64List=_feature_pb2.Int64List, FloatList=_feature_pb2.FloatList)
Example = _example_pb2.Example
io = _types.SimpleNamespace(gfile=_gfile, TFRecordWriter=_TFRecordWriter, TFRecordOptions=_TFRecordOptions)
compat = _types.SimpleNamespace(v1=_Missing('tf.compat.v1'), v2=_Missing('tf.compat.v2'))

def load_op_library(path):
  """Custom TF ops can't load; their functions fail only if called."""
  return _Missing(f'tf.load_op_library({path!r})')

def __getattr__(name):
  return _Missing(f'tf.{name}')
