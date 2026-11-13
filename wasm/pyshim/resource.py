"""Stand-in for the `resource` module (not in Pyodide). Only used for DeepVariant's run metrics."""
import collections
RUSAGE_SELF = 0
error = OSError
_RUsage = collections.namedtuple("struct_rusage", "ru_utime ru_stime ru_maxrss")
def getrusage(who):
    return _RUsage(0.0, 0.0, 0)
