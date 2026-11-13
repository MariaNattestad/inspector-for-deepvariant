"""Stand-in for psutil (not in Pyodide). Only used for DeepVariant's run metrics; reports zeros."""
import collections
_IO = collections.namedtuple("pio", "read_bytes write_bytes")
_Mem = collections.namedtuple("svmem", "total")
class Process:
    def io_counters(self):
        return _IO(0, 0)
def cpu_count(logical=True):
    return 1
def cpu_freq():
    return None
def virtual_memory():
    return _Mem(0)
