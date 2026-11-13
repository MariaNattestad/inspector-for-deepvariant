"""Exports a small model (Dense features->750->750->3) to .npz for the browser's numpy stand-in
and checks numpy against Keras. Run by models.sh."""
import sys
import numpy as np
import keras

src, dst = sys.argv[1], sys.argv[2]
model = keras.models.load_model(src, compile=False)
arrays, acts = {}, []
for i, layer in enumerate(l for l in model.layers if l.weights):
    w, b = layer.get_weights()
    arrays[f"w{i}"], arrays[f"b{i}"] = w.astype(np.float32), b.astype(np.float32)
    acts.append(layer.get_config()["activation"])
np.savez(dst, activations=np.array(acts), **arrays)

# Same math as pyshim/keras/_small_model.py
def numpy_predict(x):
    for i, a in enumerate(acts):
        x = x @ arrays[f"w{i}"] + arrays[f"b{i}"]
        if a == "relu": x = np.maximum(x, 0)
        elif a == "softmax": x = np.exp(x - x.max(1, keepdims=True)); x /= x.sum(1, keepdims=True)
    return x

# 70 features for WGS; the long-read models (PacBio, ONT) add haplotype features
x = np.random.default_rng(0).integers(0, 100, size=(1000, model.input_shape[-1])).astype(np.float32)
diff = np.abs(numpy_predict(x) - model.predict(x, verbose=0)).max()
print(f"layers: {acts}; max |numpy - keras| on 1000 random inputs: {diff:.2e}")
