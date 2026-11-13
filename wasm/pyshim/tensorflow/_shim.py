"""Stand-in for the small part of TensorFlow that DeepVariant's make_examples/postprocess use in Python.

Real implementations: gfile (plain file I/O), TFRecord writing (same framing and CRC as TensorFlow),
and the Example/Feature protos (Nucleus ships the same messages, package `tensorflow`).
Everything else resolves to a placeholder that only fails if actually called, so module-level code
such as type annotations (`tf.Tensor`) still imports.
"""
import glob as _glob, gzip as _gzip, os as _os, struct as _struct


class Missing:
  """Placeholder for TensorFlow APIs that aren't available in the browser build."""
  def __init__(self, path): self._path = path
  def __getattr__(self, name): return Missing(f'{self._path}.{name}')
  def __call__(self, *a, **k): raise NotImplementedError(f'{self._path} is not available in the browser build')
  def __repr__(self): return f'<missing {self._path}>'
  def __getitem__(self, k): return Missing(f'{self._path}[{k}]')
  def __mro_entries__(self, bases): return (object,)


# --- gfile ---------------------------------------------------------------------
class gfile:
  Exists = exists = staticmethod(_os.path.exists)
  Glob = glob = staticmethod(lambda p: sorted(_glob.glob(p)))
  MakeDirs = makedirs = staticmethod(lambda p: _os.makedirs(p, exist_ok=True))
  IsDirectory = isdir = staticmethod(_os.path.isdir)
  Remove = remove = staticmethod(_os.remove)
  ListDirectory = listdir = staticmethod(_os.listdir)
  @staticmethod
  def GFile(name, mode='r'):
    return open(name, mode)
  Open = GFile


# --- TFRecords -------------------------------------------------------------------
def _crc32c(data: bytes) -> int:
  crc = 0xFFFFFFFF
  for b in data:
    crc ^= b
    for _ in range(8):
      crc = (crc >> 1) ^ 0x82F63B78 if crc & 1 else crc >> 1
  return crc ^ 0xFFFFFFFF

def _masked_crc(data: bytes) -> int:
  crc = _crc32c(data)
  return (((crc >> 15) | (crc << 17)) + 0xA282EAD8) & 0xFFFFFFFF


class TFRecordOptions:
  def __init__(self, compression_type=None, **_):
    self.compression_type = compression_type or ''
  @staticmethod
  def get_compression_type_string(options):
    return '' if options is None else (options if isinstance(options, str) else options.compression_type)


class TFRecordWriter:
  """Same on-disk format as tf.io.TFRecordWriter (gzip when compression is 'GZIP')."""
  def __init__(self, path, options=None):
    ctype = TFRecordOptions.get_compression_type_string(options)
    if not ctype and str(path).endswith('.gz'): ctype = 'GZIP'
    self._f = _gzip.open(path, 'wb') if ctype == 'GZIP' else open(path, 'wb')
  def write(self, record):
    if isinstance(record, str): record = record.encode()
    header = _struct.pack('<Q', len(record))
    self._f.write(header + _struct.pack('<I', _masked_crc(header)) + record + _struct.pack('<I', _masked_crc(record)))
  def flush(self): self._f.flush()
  def close(self): self._f.close()
  def __enter__(self): return self
  def __exit__(self, *a): self.close()


# --- tf.data (only what DeepVariant's postprocess uses: read records, take(n)) -------
class _Bytes(bytes):
  def numpy(self): return bytes(self)


class TFRecordDataset:
  def __init__(self, filenames, compression_type=None, **_):
    self._files = [filenames] if isinstance(filenames, (str, bytes)) else list(filenames)
    self._gzip = (compression_type or '').upper() == 'GZIP'
    self._limit = None
  def take(self, n):
    d = TFRecordDataset(self._files, 'GZIP' if self._gzip else None)
    d._limit = n
    return d
  def __iter__(self):
    count = 0
    for path in self._files:
      with (_gzip.open(path, 'rb') if self._gzip else open(path, 'rb')) as f:
        while self._limit is None or count < self._limit:
          header = f.read(12)
          if len(header) < 12: break
          (n,) = _struct.unpack('<Q', header[:8])
          record = f.read(n); f.read(4)
          count += 1
          yield _Bytes(record)


class data:
  TFRecordDataset = TFRecordDataset
  AUTOTUNE = -1
  Dataset = Missing('tf.data.Dataset')
