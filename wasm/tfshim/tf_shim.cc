// Implementation of the TensorFlow stand-in (see tensorflow/core/platform/tf_shim.h).
// TFRecord framing matches TensorFlow exactly:
//   uint64 length | uint32 masked_crc32c(length) | data | uint32 masked_crc32c(data)
// with optional gzip compression of the whole stream.
#include "tensorflow/core/platform/tf_shim.h"

#include <glob.h>
#include <sys/stat.h>
#include <zlib.h>

#include <cstring>

namespace tensorflow {
namespace {

// CRC32C (Castagnoli), table-driven
uint32_t Crc32c(const char* data, size_t n) {
  static uint32_t table[256];
  static bool init = false;
  if (!init) {
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int k = 0; k < 8; k++) c = (c & 1) ? (c >> 1) ^ 0x82F63B78u : c >> 1;
      table[i] = c;
    }
    init = true;
  }
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < n; i++) crc = table[(crc ^ static_cast<uint8_t>(data[i])) & 0xFF] ^ (crc >> 8);
  return crc ^ 0xFFFFFFFFu;
}
uint32_t MaskedCrc(const char* data, size_t n) {
  uint32_t crc = Crc32c(data, n);
  return ((crc >> 15) | (crc << 17)) + 0xa282ead8u;
}
void PutU64(std::string* s, uint64_t v) { for (int i = 0; i < 8; i++) s->push_back(static_cast<char>(v >> (8 * i))); }
void PutU32(std::string* s, uint32_t v) { for (int i = 0; i < 4; i++) s->push_back(static_cast<char>(v >> (8 * i))); }
uint64_t GetU64(const char* p) { uint64_t v = 0; for (int i = 7; i >= 0; i--) v = (v << 8) | static_cast<uint8_t>(p[i]); return v; }
uint32_t GetU32(const char* p) { uint32_t v = 0; for (int i = 3; i >= 0; i--) v = (v << 8) | static_cast<uint8_t>(p[i]); return v; }
bool IsGzip(const std::string& c) { return c == io::compression::kGzip; }

}  // namespace

// ---- Files -------------------------------------------------------------------

absl::Status RandomAccessFile::Read(uint64 offset, size_t n, std::string_view* result, char* scratch) const {
  if (fseeko(f_, static_cast<off_t>(offset), SEEK_SET) != 0) return absl::OutOfRangeError("seek past end");
  size_t got = fread(scratch, 1, n, f_);
  *result = std::string_view(scratch, got);
  if (got < n) return absl::OutOfRangeError("read fewer bytes than requested");
  return absl::OkStatus();
}

absl::Status WritableFile::Append(std::string_view data) {
  if (!f_) return absl::FailedPreconditionError("file closed");
  if (fwrite(data.data(), 1, data.size(), f_) != data.size()) return absl::InternalError("write failed");
  return absl::OkStatus();
}
absl::Status WritableFile::Flush() { return (f_ && fflush(f_) == 0) ? absl::OkStatus() : absl::InternalError("flush failed"); }
absl::Status WritableFile::Close() {
  if (!f_) return absl::OkStatus();
  int r = fclose(f_);
  f_ = nullptr;
  return r == 0 ? absl::OkStatus() : absl::InternalError("close failed");
}

Env* Env::Default() { static Env env; return &env; }

absl::Status Env::NewRandomAccessFile(const std::string& fname, std::unique_ptr<RandomAccessFile>* result) {
  FILE* f = fopen(fname.c_str(), "rb");
  if (!f) return absl::NotFoundError(fname + " not found");
  result->reset(new RandomAccessFile(f));
  return absl::OkStatus();
}
absl::Status Env::NewWritableFile(const std::string& fname, std::unique_ptr<WritableFile>* result) {
  FILE* f = fopen(fname.c_str(), "wb");
  if (!f) return absl::InternalError("cannot open " + fname + " for writing");
  result->reset(new WritableFile(f));
  return absl::OkStatus();
}
absl::Status Env::FileExists(const std::string& fname) {
  struct stat st;
  return stat(fname.c_str(), &st) == 0 ? absl::OkStatus() : absl::NotFoundError(fname + " not found");
}
absl::Status Env::GetMatchingPaths(const std::string& pattern, std::vector<std::string>* results) {
  results->clear();
  glob_t g;
  if (glob(pattern.c_str(), 0, nullptr, &g) == 0)
    for (size_t i = 0; i < g.gl_pathc; i++) results->push_back(g.gl_pathv[i]);
  globfree(&g);
  return absl::OkStatus();
}

namespace io {

// ---- TFRecord reading ----------------------------------------------------------

RecordReaderOptions RecordReaderOptions::CreateRecordReaderOptions(const std::string& compression_type) {
  RecordReaderOptions o;
  o.gzip = IsGzip(compression_type);
  return o;
}

RecordReader::RecordReader(RandomAccessFile* file, const RecordReaderOptions& options)
    : file_(file), options_(options) {}

// Reads the whole file (inflating if gzipped) on first use. Fine for the small files DeepVariant
// writes per region; the browser POC never sees large ones.
absl::Status RecordReader::Load() {
  loaded_ = true;
  std::string raw;
  std::vector<char> scratch(1 << 20);
  for (uint64 off = 0;;) {
    std::string_view chunk;
    absl::Status s = file_->Read(off, scratch.size(), &chunk, scratch.data());
    raw.append(chunk.data(), chunk.size());
    off += chunk.size();
    if (!s.ok() || chunk.empty()) break;
  }
  if (!options_.gzip) { data_ = std::move(raw); return absl::OkStatus(); }
  // Inflate, including concatenated gzip members
  size_t in_pos = 0;
  std::vector<char> out(1 << 16);
  while (in_pos < raw.size()) {
    z_stream zs{};
    if (inflateInit2(&zs, 16 + MAX_WBITS) != Z_OK) return absl::InternalError("inflateInit2 failed");
    zs.next_in = reinterpret_cast<Bytef*>(raw.data() + in_pos);
    zs.avail_in = static_cast<uInt>(raw.size() - in_pos);
    int r;
    do {
      zs.next_out = reinterpret_cast<Bytef*>(out.data());
      zs.avail_out = static_cast<uInt>(out.size());
      r = inflate(&zs, Z_NO_FLUSH);
      if (r != Z_OK && r != Z_STREAM_END) { inflateEnd(&zs); return absl::DataLossError("corrupt gzip TFRecord"); }
      data_.append(out.data(), out.size() - zs.avail_out);
    } while (r != Z_STREAM_END && zs.avail_in > 0);
    in_pos = raw.size() - zs.avail_in;
    inflateEnd(&zs);
    if (r != Z_STREAM_END) break;
  }
  return absl::OkStatus();
}

absl::Status RecordReader::ReadRecord(uint64* offset, tstring* record) {
  if (!loaded_) load_status_ = Load();
  if (!load_status_.ok()) return load_status_;
  if (*offset >= data_.size()) return absl::OutOfRangeError("end of records");
  if (*offset + 12 > data_.size()) return absl::DataLossError("truncated record header");
  const char* p = data_.data() + *offset;
  uint64_t len = GetU64(p);
  if (GetU32(p + 8) != MaskedCrc(p, 8)) return absl::DataLossError("corrupted record length");
  if (*offset + 12 + len + 4 > data_.size()) return absl::DataLossError("truncated record");
  const char* d = p + 12;
  if (GetU32(d + len) != MaskedCrc(d, len)) return absl::DataLossError("corrupted record data");
  record->assign(d, len);
  *offset += 12 + len + 4;
  return absl::OkStatus();
}

// ---- TFRecord writing ----------------------------------------------------------

RecordWriterOptions RecordWriterOptions::CreateRecordWriterOptions(const std::string& compression_type) {
  RecordWriterOptions o;
  o.gzip = IsGzip(compression_type);
  return o;
}

RecordWriter::RecordWriter(WritableFile* dest, const RecordWriterOptions& options) : dest_(dest), options_(options) {
  if (options_.gzip) {
    auto* zs = new z_stream{};
    deflateInit2(zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 16 + MAX_WBITS, 8, Z_DEFAULT_STRATEGY);
    zstream_ = zs;
  }
}
RecordWriter::~RecordWriter() { Close().IgnoreError(); }

absl::Status RecordWriter::Emit(std::string_view bytes, bool finish) {
  if (!options_.gzip) return dest_->Append(bytes);
  auto* zs = static_cast<z_stream*>(zstream_);
  zs->next_in = reinterpret_cast<Bytef*>(const_cast<char*>(bytes.data()));
  zs->avail_in = static_cast<uInt>(bytes.size());
  char out[1 << 15];
  int r;
  do {
    zs->next_out = reinterpret_cast<Bytef*>(out);
    zs->avail_out = sizeof(out);
    r = deflate(zs, finish ? Z_FINISH : Z_NO_FLUSH);
    if (r == Z_STREAM_ERROR) return absl::InternalError("deflate failed");
    absl::Status s = dest_->Append(std::string_view(out, sizeof(out) - zs->avail_out));
    if (!s.ok()) return s;
  } while (zs->avail_out == 0 || (finish && r != Z_STREAM_END));
  return absl::OkStatus();
}

absl::Status RecordWriter::WriteRecord(std::string_view data) {
  if (closed_) return absl::FailedPreconditionError("writer closed");
  std::string header;
  PutU64(&header, data.size());
  PutU32(&header, MaskedCrc(header.data(), 8));
  std::string footer;
  PutU32(&footer, MaskedCrc(data.data(), data.size()));
  for (auto part : {std::string_view(header), data, std::string_view(footer)}) {
    absl::Status s = Emit(part, false);
    if (!s.ok()) return s;
  }
  return absl::OkStatus();
}

absl::Status RecordWriter::Flush() { return closed_ ? absl::OkStatus() : dest_->Flush(); }

absl::Status RecordWriter::Close() {
  if (closed_) return absl::OkStatus();
  closed_ = true;
  absl::Status s = absl::OkStatus();
  if (options_.gzip) {
    auto* zs = static_cast<z_stream*>(zstream_);
    s = Emit(std::string_view(), true);
    deflateEnd(zs);
    delete zs;
    zstream_ = nullptr;
  }
  if (s.ok()) s = dest_->Flush();
  return s;
}

// ---- Line reading --------------------------------------------------------------

BufferedInputStream::BufferedInputStream(InputStreamInterface* input, size_t buffer_bytes, bool owns_input_stream)
    : input_(input), owns_(owns_input_stream) {
  (void)buffer_bytes;
}

std::string BufferedInputStream::ReadLineAsString() {
  auto* ras = dynamic_cast<RandomAccessInputStream*>(input_);
  std::string line;
  while (true) {
    if (buf_pos_ >= buf_.size()) {
      if (eof_ || !ras) break;
      std::vector<char> scratch(1 << 16);
      std::string_view chunk;
      absl::Status s = ras->file()->Read(pos_, scratch.size(), &chunk, scratch.data());
      buf_.assign(chunk.data(), chunk.size());
      buf_pos_ = 0;
      pos_ += chunk.size();
      if (!s.ok()) eof_ = true;
      if (buf_.empty()) break;
    }
    char c = buf_[buf_pos_++];
    line.push_back(c);
    if (c == '\n') break;
  }
  return line;
}

}  // namespace io
}  // namespace tensorflow
