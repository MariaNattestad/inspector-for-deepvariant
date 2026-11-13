#!/bin/bash
# Downloads DeepVariant for the browser (made by wasm/build.sh) from this repo's GitHub release into
# public/deepvariant/, so the app runs without building it:
#
#   npm run assets   [release tag; default assets-1.10.0]
#
# Uses the GitHub CLI if it's installed and signed in (needed while the repo is private), curl otherwise.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION=1.10.0
TAG=${1:-assets-$VERSION}
REPO=MariaNattestad/inspector-for-deepvariant
TAR=deepvariant-$VERSION.tar
mkdir -p work/release public/deepvariant
if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then
	gh release download "$TAG" --repo "$REPO" --pattern "$TAR" --dir work/release --clobber
else
	curl -fSL "https://github.com/$REPO/releases/download/$TAG/$TAR" -o "work/release/$TAR"
fi
tar -xf "work/release/$TAR" -C public/deepvariant
du -sh "public/deepvariant/$VERSION"
