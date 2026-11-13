# Build environment for DeepVariant's C++ as a Pyodide extension module.
# Must match the Pyodide release the page loads (314.0.7): same Emscripten (5.0.3) and Python (3.14),
# since a Pyodide extension module is only compatible with the exact Pyodide ABI it was built for.
FROM emscripten/emsdk:5.0.3

# pyodide-build provides `pyodide config get cflags/ldflags/cmake_toolchain_file` for Pyodide 314.0.7
RUN pip install -q --break-system-packages uv \
	&& uv python install 3.14 \
	&& uv venv -q --python 3.14 /opt/venv \
	&& . /opt/venv/bin/activate \
	&& uv pip install -q pyodide-build==0.39.1 \
	&& pyodide xbuildenv install 314.0.7

WORKDIR /dv
