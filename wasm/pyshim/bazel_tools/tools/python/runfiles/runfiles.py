"""Minimal Bazel runfiles: paths resolve to themselves (nothing is actually loaded from them)."""

class _Runfiles:
  def Rlocation(self, path):
    return path

def Create():
  return _Runfiles()
