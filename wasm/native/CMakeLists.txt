# Builds DeepVariant + Nucleus C++ (and their pybind11 bindings) into ONE Pyodide extension module.
# Configured by ../container-build.sh with Pyodide's toolchain and -DBUILD_DIR (sources, deps and generated
# code downloaded/produced by the build; see ../build.sh).
cmake_minimum_required(VERSION 3.20)
project(dv_native LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(S ${CMAKE_CURRENT_SOURCE_DIR}/..)   # wasm: our shims
set(B ${BUILD_DIR})                     # wasm/build: DeepVariant source, deps, generated code
set(DV ${B}/dv-src)
set(DEPS ${B}/deps)
set(PREFIX ${DEPS}/wasm-prefix)

file(STRINGS ${CMAKE_BINARY_DIR}/lib_sources.txt LIB_SRCS)
file(STRINGS ${CMAKE_BINARY_DIR}/binding_sources.txt BIND_SRCS)
list(TRANSFORM LIB_SRCS PREPEND ${DV}/)
list(TRANSFORM BIND_SRCS PREPEND ${DV}/)
file(GLOB PB_SRCS ${B}/gen/deepvariant/protos/*.pb.cc ${B}/gen/third_party/nucleus/protos/*.pb.cc ${B}/gen/tensorflow/core/example/*.pb.cc)
# Nucleus vendors TensorFlow's Example/Feature protos in the same package; the C++ uses TensorFlow's copy
list(FILTER PB_SRCS EXCLUDE REGEX "nucleus/protos/(example|feature)\\.pb\\.cc$")
file(GLOB P11PB_SRCS ${DEPS}/src/pybind11_protobuf/pybind11_protobuf/*.cc)

# Pyodide's flags (pyodide config get cxxflags/ldflags) arrive via the environment; add our own on top.
set(COMMON_FLAGS -fPIC -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sUSE_ZLIB=1)
set(CXX_COMPAT -include ${CMAKE_CURRENT_SOURCE_DIR}/tf_transitive_includes.h)

add_library(ssw OBJECT ${DEPS}/src/libssw/src/ssw.c ${DEPS}/src/libssw/src/ssw_cpp.cpp)
target_compile_options(ssw PRIVATE ${COMMON_FLAGS} -msimd128 -msse2)

add_library(dvcore OBJECT ${LIB_SRCS} ${PB_SRCS} ${P11PB_SRCS} ${S}/tfshim/tf_shim.cc)
add_library(dvbind OBJECT ${BIND_SRCS} ${CMAKE_BINARY_DIR}/_dv_native.cc)
set_source_files_properties(${BIND_SRCS} PROPERTIES COMPILE_OPTIONS "-include;${CMAKE_CURRENT_SOURCE_DIR}/pybind_rename.h")

foreach(t ssw dvcore dvbind)
  target_include_directories(${t} PRIVATE
    ${DV} ${B}/gen ${S}/tfshim ${PREFIX}/include
    ${DEPS}/src/libssw ${DEPS}/src/boost ${DEPS}/src/pybind11/include ${DEPS}/src/pybind11_protobuf ${DEPS}/src/protobuf
    ${PYTHON_INCLUDE_DIR})
  target_compile_options(${t} PRIVATE ${COMMON_FLAGS} $<$<COMPILE_LANGUAGE:CXX>:${CXX_COMPAT}>)
  target_compile_definitions(${t} PRIVATE PYBIND11_PROTOBUF_ENABLE_PYPROTO_API=0)
endforeach()

add_executable(_dv_native $<TARGET_OBJECTS:ssw> $<TARGET_OBJECTS:dvcore> $<TARGET_OBJECTS:dvbind>)
file(GLOB DEP_LIBS ${PREFIX}/lib/*.a)
list(FILTER DEP_LIBS EXCLUDE REGEX "libprotobuf-lite\\.a$")  # subset of libprotobuf.a
target_link_libraries(_dv_native PRIVATE ${DEP_LIBS})
target_link_options(_dv_native PRIVATE ${COMMON_FLAGS} -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_PyInit__dv_native)  # only what Python needs: 2.7 MB less symbol tables, unused code dropped
set_target_properties(_dv_native PROPERTIES SUFFIX ".cpython-314-wasm32-emscripten.so")
