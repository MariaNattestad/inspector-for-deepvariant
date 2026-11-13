#!/bin/bash
# Packs DeepVariant for the browser (public/deepvariant/<version>/, from wasm/build.sh) into one tarball and
# uploads it as a GitHub release, where `npm run assets` and the Pages workflow get it:
#
#   ./scripts/package-assets.sh [release tag]   (default: assets-1.10.0; replaces that release's tarball)
#
# The worker (wasm/web/*.mjs) isn't included: it's served and built from source.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION=1.10.0
TAG=${1:-assets-$VERSION}
TAR=work/release/deepvariant-$VERSION.tar
mkdir -p work/release
tar -cf "$TAR" -C public/deepvariant --exclude '*.mjs' --exclude .DS_Store "$VERSION"
ls -la "$TAR"
if gh release view "$TAG" > /dev/null 2>&1; then
	gh release upload "$TAG" "$TAR" --clobber
else
	gh release create "$TAG" "$TAR" --title "DeepVariant $VERSION for the browser" \
		--notes "Built DeepVariant $VERSION for the browser (wasm/build.sh): Python + C++ module, the six models, example BAMs. Downloaded by \`npm run assets\` and the Pages workflow."
fi
