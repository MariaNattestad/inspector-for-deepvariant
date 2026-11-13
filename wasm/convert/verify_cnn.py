"""Checks a converted CNN against the TensorFlow SavedModel it came from, on the same random pileups
(preprocessed as call_variants does: (x - 128) / 128).

Usage: python3 verify_cnn.py SAVED_MODEL_DIR CNN.onnx
"""
import json
import sys

import numpy as np
import onnxruntime as ort
import tensorflow as tf

saved, onnx_path = sys.argv[1], sys.argv[2]
shape = json.load(open(f"{saved}/model.example_info.json"))["shape"]
x = (np.random.default_rng(0).integers(0, 256, size=[16] + shape).astype(np.float32) - 128) / 128
expected = list(tf.saved_model.load(saved).signatures["serving_default"](tf.constant(x)).values())[0].numpy()
session = ort.InferenceSession(onnx_path)
got = session.run(None, {session.get_inputs()[0].name: x})[0]
print(f"{onnx_path}: pileups {shape}, max |onnx - tf| {np.abs(got - expected).max():.1e}, "
      f"same top genotype {(got.argmax(1) == expected.argmax(1)).mean():.0%}")
