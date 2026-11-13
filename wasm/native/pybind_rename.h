// Force-included into each DeepVariant/Nucleus binding file. Turns every
//   PYBIND11_MODULE(name, m) { ... }
// into a plain function `void dv_pybind_init_name(pybind11::module_& m)`, so all bindings can be
// compiled into one extension module (_dv_native) instead of ~36 separate .so files.
#pragma once
#include <pybind11/pybind11.h>
#undef PYBIND11_MODULE
#define PYBIND11_MODULE(name, variable, ...) void dv_pybind_init_##name(::pybind11::module_& variable)
