"""Glue between DeepVariant's Python (in Pyodide) and the CNN (onnxruntime-web, in JavaScript).

call_variants normally runs the CNN through TensorFlow; here JS runs it, and these helpers
read make_examples' output for it and write its results with call_variants' own code.
"""
import importlib
import logging

from absl import flags
import numpy as np

from third_party.nucleus.io import tfrecord
from third_party.nucleus.protos import example_pb2


# DeepVariant's tools are separate programs that define some flags with the same name
# (e.g. --examples). Here they share one Python, so each tool gets its own set of absl flags,
# swapped in by use_tool().
_tool_flags = {}


def use_tool(module_name):
  """Imports a DeepVariant tool module with its own flag definitions active; returns the module."""
  fl = flags.FLAGS._flags()  # pylint: disable=protected-access
  logging.disable(logging.INFO)  # absl logs "unparse_flags() called" at INFO; it's expected here
  flags.FLAGS.unparse_flags()
  logging.disable(logging.NOTSET)
  if module_name in _tool_flags:
    fl.clear()
    fl.update(_tool_flags[module_name])
  else:
    for flag in fl.values():
      flag.allow_override = True  # let this tool's definitions replace another tool's
    importlib.import_module(module_name)
    _tool_flags[module_name] = dict(fl)
  return importlib.import_module(module_name)


def run_tool(module_name, argv):
  """Runs a tool's main() as its command line would."""
  tool = use_tool(module_name)
  tool.main(flags.FLAGS([module_name.rsplit('.', 1)[-1]] + list(argv)))


def read_examples(path):
  """Returns (images as one uint8 array [N, H, W, C], per-example metadata for write_calls)."""
  images, meta, shape = [], [], None
  for ex in tfrecord.read_tfrecords(path, proto=example_pb2.Example):
    f = ex.features.feature
    shape = tuple(f['image/shape'].int64_list.value)
    images.append(f['image/encoded'].bytes_list.value[0])
    meta.append((f['variant/encoded'].bytes_list.value[0],
                 f['alt_allele_indices/encoded'].bytes_list.value[0]))
  arr = np.frombuffer(b''.join(images), dtype=np.uint8).reshape((len(images),) + (shape or (0, 0, 0)))
  return arr, meta


def write_calls(meta, probabilities, path):
  """Writes CallVariantsOutput records exactly as call_variants does (same rounding)."""
  call_variants = use_tool('deepvariant.call_variants')
  probabilities = np.asarray(probabilities, dtype=np.float32).reshape(-1, 3)
  with tfrecord.Writer(path) as writer:
    for (variant, alt_allele_indices), probs in zip(meta, probabilities):
      call_variants.write_variant_call(
          writer, {'variant': variant, 'alt_allele_indices': alt_allele_indices, 'probabilities': probs},
          include_debug_info=False, debugging_true_label_mode=False)
  return len(probabilities)

