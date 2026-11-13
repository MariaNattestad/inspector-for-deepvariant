#!/bin/bash
# Builds DeepVariant for the browser and puts everything the app loads in public/deepvariant/<version>/:
#
#   ./wasm/build.sh
#
# Requires Docker. Steps (each skipped if its output already exists in ./build, which is gitignored;
# delete ./build to start over):
#   1. DeepVariant's C++ -> one Pyodide extension module, bundled with its Python  (./container-build.sh)
#   2. DeepVariant's models (WGS, WES, PacBio, ONT, hybrid, pangenome-aware WGS) -> ONNX (CNN) and .npz
#      (small model)  (./convert/models.sh)
#   3. Copy to public/deepvariant/<version>/, with the example BAMs if ./examples.sh made them
set -euo pipefail

VERSION=1.10.0
DIR_SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIR_REPO=$(cd "$DIR_SCRIPT/.." && pwd)
DIR_BUILD=$DIR_SCRIPT/build
DIR_OUT=$DIR_REPO/public/deepvariant/$VERSION
mkdir -p "$DIR_BUILD"

echo "=== 1. DeepVariant C++ + Python -> pysite.zip"
docker build -q -t inspector-for-deepvariant-build "$DIR_SCRIPT" > /dev/null
docker run --rm -v "$DIR_SCRIPT":/dv inspector-for-deepvariant-build bash /dv/container-build.sh

echo "=== 2. Models"
# In the official image, for its TensorFlow (x86-only: on Apple silicon it runs under emulation, a few minutes
# per model). models.sh skips models that are already converted.
docker run --rm --platform linux/amd64 -v "$DIR_SCRIPT/convert":/convert -v "$DIR_BUILD/models":/out \
	google/deepvariant:$VERSION bash /convert/models.sh

echo "=== 3. Copy to $DIR_OUT"
rm -rf "$DIR_OUT" && mkdir -p "$DIR_OUT/data" "$DIR_OUT/tools"
cp "$DIR_SCRIPT/web/worker.mjs" "$DIR_SCRIPT/web/pipeline.mjs" "$DIR_BUILD/pysite.zip" "$DIR_OUT/"
cp -R "$DIR_BUILD/models" "$DIR_OUT/"
[ -d "$DIR_BUILD/examples" ] && cp "$DIR_BUILD"/examples/*.bam* "$DIR_OUT/data/"
cp "$DIR_SCRIPT/tools/gbz_haplotypes_bam.py" "$DIR_OUT/tools/"
du -ah "$DIR_OUT" | sort -k2
