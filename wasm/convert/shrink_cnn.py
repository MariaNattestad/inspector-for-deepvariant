"""Stores the CNN's weights as float16 to halve the download (87 MB -> 44 MB).

Each large weight tensor becomes a float16 initializer plus a Cast back to float32. onnxruntime folds
those Casts once when the session starts, so the network still computes in float32; only the weights are
rounded. (Accuracy vs the float32 model: see the README.)

Usage: python3 shrink_cnn.py cnn_wgs.onnx cnn_wgs.fp16.onnx
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

MIN_SIZE = 1024  # smaller tensors (biases, batch-norm parameters) stay float32


def to_fp16(model):
  graph = model.graph
  kept, fp16, casts = [], [], []
  for init in graph.initializer:
    w = numpy_helper.to_array(init)
    if w.dtype != np.float32 or w.size < MIN_SIZE:
      kept.append(init)
      continue
    fp16.append(numpy_helper.from_array(w.astype(np.float16), init.name + "_fp16"))
    casts.append(helper.make_node("Cast", [init.name + "_fp16"], [init.name], to=TensorProto.FLOAT))
  del graph.initializer[:]
  graph.initializer.extend(kept + fp16)
  nodes = list(graph.node)
  del graph.node[:]
  graph.node.extend(casts + nodes)  # Casts first, so the graph stays topologically sorted
  return model


if __name__ == "__main__":
  onnx.save(to_fp16(onnx.load(sys.argv[1])), sys.argv[2])
