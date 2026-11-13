#!/bin/bash
# Converts DeepVariant 1.10's models for the browser. Runs inside google/deepvariant:1.10.0 (started by
# ../build.sh), or anywhere with TensorFlow 2.16.1 (what DeepVariant 1.10 uses), tf2onnx, onnx and
# onnxruntime. Downloads each model from DeepVariant's bucket and writes to $OUT (default /out):
#   cnn_<key>.fp16.onnx             the CNN as ONNX, weights stored as float16 (43.7 MB instead of 87 MB; the
#                                   network still computes in float32, see shrink_cnn.py)
#   <key>/model.example_info.json   pileup shape, channels and the make_examples flags for this model
#   smallmodels_<key>/model.npz     the small model's weights, for the numpy stand-in of keras.models.load_model
# and checks each CNN against TensorFlow (verify_cnn.py). <key> is the model type in lower case, as the
# worker names them (worker.mjs: MODELS).
set -euo pipefail
OUT=${OUT:-/out}
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GCS=https://storage.googleapis.com/deepvariant/models/DeepVariant/1.10.0
TMP=$(mktemp -d)
python3 -c "import tf2onnx, onnxruntime" 2>/dev/null || pip install -q tf2onnx onnx onnxruntime 2>&1 | grep -v -i "warning\|notice" || true

# key:SavedModel under $GCS
CNN="wgs:savedmodels/deepvariant.wgs.savedmodel
wes:savedmodels/deepvariant.wes.savedmodel
pacbio:savedmodels/deepvariant.pacbio.savedmodel
ont_r104:savedmodels/deepvariant.ont.savedmodel
hybrid_pacbio_illumina:savedmodels/deepvariant.hybrid.savedmodel
wgs_pangenome:pangenome_aware_models/savedmodels/deepvariant.wgs.pangenome.savedmodel"
# key:small model (only these models have one)
SMALL="wgs:smallmodels/deepvariant.wgs.smallmodel
pacbio:smallmodels/deepvariant.pacbio.smallmodel
ont_r104:smallmodels/deepvariant.ont.smallmodel"

for entry in $CNN; do
	key=${entry%%:*} src=${entry#*:}
	[ -f "$OUT/cnn_$key.fp16.onnx" ] && continue
	echo "--- $key"
	saved=$TMP/$key.savedmodel
	mkdir -p "$saved/variables" "$OUT/$key"
	for f in saved_model.pb fingerprint.pb model.example_info.json variables/variables.index variables/variables.data-00000-of-00001; do
		curl -sSfL "$GCS/$src/$f" -o "$saved/$f"
	done
	# SavedModel -> ONNX (opset 17), then weights as float16
	python3 -m tf2onnx.convert --saved-model "$saved" --opset 17 --output "$TMP/cnn_$key.onnx" 2>&1 | tail -1
	python3 "$DIR/shrink_cnn.py" "$TMP/cnn_$key.onnx" "$OUT/cnn_$key.fp16.onnx"
	python3 "$DIR/verify_cnn.py" "$saved" "$OUT/cnn_$key.fp16.onnx"
	cp "$saved/model.example_info.json" "$OUT/$key/"
	rm -rf "$saved" "$TMP/cnn_$key.onnx"
done

for entry in $SMALL; do
	key=${entry%%:*} src=${entry#*:}
	[ -f "$OUT/smallmodels_$key/model.npz" ] && continue
	mkdir -p "$OUT/smallmodels_$key"
	curl -sSfL "$GCS/$src/model.keras" -o "$TMP/small_$key.keras"
	python3 "$DIR/export_small_model.py" "$TMP/small_$key.keras" "$OUT/smallmodels_$key/model.npz"
done
rm -rf "$TMP"
