"""numpy version of DeepVariant's small model (Dense layers only), loaded from the .npz written
by convert/export_small_model.py. Same math as Keras' Dense + relu/softmax."""
import os
import numpy as np


class DenseModel:
  def __init__(self, npz_path):
    with np.load(npz_path) as f:
      self.activations = [str(a) for a in f["activations"]]
      self.layers = [(f[f"w{i}"], f[f"b{i}"]) for i in range(len(self.activations))]

  def predict(self, x, batch_size=None, verbose=0):
    x = np.asarray(x, dtype=np.float32)
    for (w, b), act in zip(self.layers, self.activations):
      x = x @ w + b
      if act == "relu":
        x = np.maximum(x, 0)
      elif act == "softmax":
        x = np.exp(x - x.max(axis=1, keepdims=True))
        x /= x.sum(axis=1, keepdims=True)
      elif act != "linear":
        raise NotImplementedError(f"activation {act}")
    return x


def load_model(path, compile=True, **kwargs):
  # model.keras -> model.npz next to it
  return DenseModel(os.path.splitext(path)[0] + ".npz")
