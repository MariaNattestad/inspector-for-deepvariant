"""Browser stand-in for tensorflow.python.platform.gfile."""
from tensorflow._shim import gfile as _g
Exists = _g.Exists; Glob = _g.Glob; MakeDirs = _g.MakeDirs; IsDirectory = _g.IsDirectory
Remove = _g.Remove; ListDirectory = _g.ListDirectory; GFile = Open = _g.GFile
