#!/bin/bash
# Runs inside the Docker image from ./Dockerfile (started by ./build.sh), with this folder at /dv.
# Produces build/pysite.zip: DeepVariant's Python + its C++ compiled to one Pyodide extension module.
set -euo pipefail
. /opt/venv/bin/activate

S=/dv                 # this folder: patches, shims, CMake project
B=/dv/build           # everything downloaded or generated (gitignored)
DEPS=$B/deps; SRC=$DEPS/src; PREFIX=$DEPS/wasm-prefix; HOST=$DEPS/host-prefix
mkdir -p $SRC $PREFIX $HOST
J=$(nproc)
fetch() { [ -d $SRC/$2 ] || (mkdir -p $SRC/$2 && curl -sSfL "$1" | tar -xz -C $SRC/$2 --strip-components=1); }

# ---- Sources --------------------------------------------------------------------------------------
echo "== Sources"
if [ ! -d $B/dv-src ]; then
	git clone -q --depth 1 --branch v1.10.0 https://github.com/google/deepvariant.git $B/dv-src
	git -C $B/dv-src apply $S/patches/deepvariant-v1.10.0.patch
fi
# Versions DeepVariant 1.10.0 pins (protobuf, htslib, libssw, pybind11_protobuf); absl/re2 are ones that
# work with that protobuf; pybind11 3 because DeepVariant uses py::classh; Boost Graph (headers) for the realigner
fetch https://github.com/abseil/abseil-cpp/archive/refs/tags/20230802.1.tar.gz abseil
fetch https://github.com/google/re2/archive/refs/tags/2023-11-01.tar.gz re2
fetch https://github.com/protocolbuffers/protobuf/archive/refs/tags/v21.9.tar.gz protobuf
fetch https://github.com/mengyao/Complete-Striped-Smith-Waterman-Library/archive/v1.2.5.tar.gz libssw
fetch https://github.com/pybind/pybind11/archive/refs/tags/v3.0.1.tar.gz pybind11
if [ ! -d $SRC/pybind11_protobuf ]; then
	fetch https://github.com/pybind/pybind11_protobuf/archive/a50899c2eb604fc5f25deeb8901eff6231b8b3c0.tar.gz pybind11_protobuf
	(cd $SRC/pybind11_protobuf && patch -s -p1 < $S/patches/pybind11_protobuf-a50899c.patch)
fi
[ -d $SRC/htslib ] || (cd $SRC && curl -sSfL https://github.com/samtools/htslib/releases/download/1.18/htslib-1.18.tar.bz2 | tar -xj && mv htslib-1.18 htslib)
[ -d $SRC/boost ] || (mkdir -p $SRC/boost && curl -sSfL https://archives.boost.io/release/1.86.0/source/boost_1_86_0.tar.bz2 \
	| tar -xj -C $SRC/boost --strip-components=1 boost_1_86_0/boost)
# protoc 34.1 writes _pb2.py files for Pyodide's protobuf 7 runtime (older generated code is rejected)
if [ ! -x $DEPS/protoc34/bin/protoc ]; then
	ARCH=$([ "$(uname -m)" = aarch64 ] && echo aarch_64 || echo x86_64)
	mkdir -p $DEPS/protoc34 && curl -sSfL -o $DEPS/protoc34/p.zip https://github.com/protocolbuffers/protobuf/releases/download/v34.1/protoc-34.1-linux-$ARCH.zip
	python3 -c "import zipfile; zipfile.ZipFile('$DEPS/protoc34/p.zip').extractall('$DEPS/protoc34')" && chmod +x $DEPS/protoc34/bin/protoc
fi

# ---- C++ dependencies for wasm ---------------------------------------------------------------------
# Must match Pyodide 314's ABI: position-independent side-module code, native wasm exceptions and
# longjmp (`pyodide config get cxxflags`). Mixing in -fexceptions (JS-based EH) objects breaks linking.
export CFLAGS="-O2 -fPIC -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"; export CXXFLAGS="$CFLAGS"

echo "== native protoc 21.9 (matches the C++ protobuf runtime)"
if [ ! -x $HOST/bin/protoc ]; then
	CFLAGS= CXXFLAGS= cmake -S $SRC/protobuf -B $SRC/protobuf/build-host -DCMAKE_BUILD_TYPE=Release -Dprotobuf_BUILD_TESTS=OFF > /dev/null
	cmake --build $SRC/protobuf/build-host -j$J --target protoc > /dev/null
	mkdir -p $HOST/bin && cp $SRC/protobuf/build-host/protoc $HOST/bin/
fi

if [ ! -f $PREFIX/lib/libhts.a ]; then
	echo "== abseil"
	emcmake cmake -S $SRC/abseil -B $SRC/abseil/build-wasm -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PREFIX \
		-DCMAKE_CXX_STANDARD=17 -DABSL_PROPAGATE_CXX_STD=ON -DABSL_BUILD_TESTING=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON > /dev/null
	cmake --build $SRC/abseil/build-wasm -j$J > /dev/null && cmake --install $SRC/abseil/build-wasm > /dev/null

	echo "== re2"
	emcmake cmake -S $SRC/re2 -B $SRC/re2/build-wasm -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PREFIX \
		-DCMAKE_PREFIX_PATH=$PREFIX -Dabsl_DIR=$PREFIX/lib/cmake/absl -DRE2_BUILD_TESTING=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON > /dev/null
	cmake --build $SRC/re2/build-wasm -j$J > /dev/null && cmake --install $SRC/re2/build-wasm > /dev/null

	echo "== protobuf 21.9 runtime"
	emcmake cmake -S $SRC/protobuf -B $SRC/protobuf/build-wasm -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$PREFIX \
		-Dprotobuf_BUILD_TESTS=OFF -Dprotobuf_BUILD_PROTOC_BINARIES=OFF -Dprotobuf_WITH_ZLIB=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON > /dev/null
	cmake --build $SRC/protobuf/build-wasm -j$J --target libprotobuf libprotobuf-lite > /dev/null && cmake --install $SRC/protobuf/build-wasm > /dev/null

	echo "== htslib 1.18"
	(cd $SRC/htslib \
		&& emconfigure ./configure --prefix=$PREFIX --disable-libcurl --disable-gcs --disable-s3 --disable-plugins \
			--disable-bz2 --disable-lzma --without-libdeflate CFLAGS="$CFLAGS -sUSE_ZLIB=1" LDFLAGS="-sUSE_ZLIB=1" > /dev/null \
		&& emmake make -j$J lib-static > /dev/null \
		&& mkdir -p $PREFIX/include/htslib && cp htslib/*.h $PREFIX/include/htslib/ && cp libhts.a $PREFIX/lib/)
fi

# ---- Protobuf code ----------------------------------------------------------------------------------
echo "== Protobuf code"
if [ ! -d $B/pygen ]; then
	# C++ with protoc 21.9 (matches the runtime) for DeepVariant's, Nucleus' and TensorFlow's Example protos
	mkdir -p $B/gen/tensorflow/core/example
	for f in example feature; do
		curl -sSfL https://raw.githubusercontent.com/tensorflow/tensorflow/v2.16.1/tensorflow/core/example/$f.proto -o $B/gen/tensorflow/core/example/$f.proto
	done
	PROTOS=$(cd $B/dv-src && find deepvariant/protos third_party/nucleus/protos -name "*.proto" | sort)
	(cd $B/dv-src && $HOST/bin/protoc -I. -I$B/gen --cpp_out=$B/gen $PROTOS)
	(cd $B/gen && $HOST/bin/protoc -I. --cpp_out=. tensorflow/core/example/example.proto tensorflow/core/example/feature.proto)
	# Python with protoc 34.1, for Pyodide's protobuf 7 (written last: its folder marks this step as done)
	mkdir -p $B/pygen.tmp && (cd $B/dv-src && $DEPS/protoc34/bin/protoc -I. --python_out=$B/pygen.tmp $PROTOS) && mv $B/pygen.tmp $B/pygen
fi

# ---- DeepVariant's C++ → one Pyodide extension module ----------------------------------------------
echo "== DeepVariant C++"
OUT=$B/native; mkdir -p $OUT
# Everything except tests, the streaming mode (needs shared memory between processes) and the
# pangenome reader (needs extra libraries; the Python side gets a placeholder)
EXCLUDE='_test\.cc$|/testing|stream_examples|gbz_reader|merge_phased_reads_main|fast_pipeline|testing_utils|clif_converters'
(cd $B/dv-src && find deepvariant third_party/nucleus -name '*.cc' -o -name '*.c' | grep -vE "$EXCLUDE" | sort) > $OUT/all.txt
(cd $B/dv-src && grep -l 'PYBIND11_MODULE' $(cat $OUT/all.txt) | sort) > $OUT/binding_sources.txt
comm -23 $OUT/all.txt $OUT/binding_sources.txt > $OUT/lib_sources.txt
echo "   $(wc -l < $OUT/lib_sources.txt) library files, $(wc -l < $OUT/binding_sources.txt) pybind11 modules"
python3 $S/native/gen_module.py $B/dv-src $OUT $OUT/binding_sources.txt
PYINC=$(pyodide config get cflags | grep -oE '\-I[^ ]*include/python3\.14' | sed 's/^-I//')
CFLAGS="$(pyodide config get cflags)" CXXFLAGS="$(pyodide config get cxxflags)" LDFLAGS="$(pyodide config get ldflags)" \
	emcmake cmake -S $S/native -B $OUT -DCMAKE_BUILD_TYPE=Release -DBUILD_DIR=$B -DPYTHON_INCLUDE_DIR=$PYINC \
	-DCMAKE_TOOLCHAIN_FILE=$(pyodide config get cmake_toolchain_file) > $OUT/configure.log 2>&1 || { tail -20 $OUT/configure.log; exit 1; }
(cd $OUT && make -j$J > make.log 2>&1) || { grep -E 'error' $OUT/make.log | head -20; exit 1; }
SO=$OUT/_dv_native.cpython-314-wasm32-emscripten.so
ls -lh $SO

# ---- pysite.zip: everything DeepVariant's Python needs on sys.path inside Pyodide -------------------
echo "== pysite.zip"
P=$B/pysite; rm -rf $P && mkdir -p $P
(cd $B/dv-src && find deepvariant third_party/nucleus -name '*.py' ! -name '*_test.py' ! -path '*/testing/*' \
	| xargs cp --parents -t $P)
cp -R $B/pygen/. $P/              # _pb2.py regenerated for protobuf 7
cp -R $S/pyshim/. $P/             # stand-ins: tensorflow, keras, pysam, ... (see README)
cp $S/browser/dv_browser.py $P/   # Python <-> JavaScript glue (CNN step, per-tool flags, Pillow)
cp $SO $OUT/submodules.json $P/
# Parent packages of the native modules (e.g. deepvariant/python/) hold no .py files
python3 -c "import json,os; [os.makedirs('$P/'+p.rpartition('.')[0].replace('.','/'),exist_ok=True) for p in json.load(open('$P/submodules.json')).values()]"
cat > $P/dv_bootstrap.py <<'PY'
"""Registers each pybind11 module of _dv_native under its original import path."""
import json, os, sys
import _dv_native
with open(os.path.join(os.path.dirname(__file__), "submodules.json")) as f:
    for name, path in json.load(f).items():
        sys.modules[path] = getattr(_dv_native, name)
PY
find $P -name __pycache__ -prune -exec rm -rf {} +
python3 - <<PY
import os, zipfile
with zipfile.ZipFile("$B/pysite.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk("$P"):
        if root != "$P":  # folders too: some (e.g. deepvariant/python/) only exist for the native modules
            z.write(root, os.path.relpath(root, "$P"))
        for f in sorted(files):
            z.write(os.path.join(root, f), os.path.relpath(os.path.join(root, f), "$P"))
PY
ls -lh $B/pysite.zip
