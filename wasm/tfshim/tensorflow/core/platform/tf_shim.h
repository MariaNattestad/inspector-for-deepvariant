// Minimal stand-in for the TensorFlow C++ APIs DeepVariant/Nucleus use (file I/O + TFRecords),
// so they can be built for WebAssembly without TensorFlow. Behavior follows TensorFlow's.
#ifndef DV_TF_SHIM_H_
#define DV_TF_SHIM_H_
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <string_view>
#include <vector>
#include "absl/base/optimization.h"
#include "absl/log/check.h"
#include "absl/status/status.h"

#define TF_CHECK_OK(val) CHECK((val).ok())
#define TF_PREDICT_FALSE(x) ABSL_PREDICT_FALSE(x)

namespace tsl { using tstring = std::string; }
namespace tensorflow {
using tstring = std::string;
using string = std::string;
using Status = absl::Status;
using int64 = int64_t; using uint64 = uint64_t; using int32 = int32_t; using uint32 = uint32_t;
namespace error { using Code = absl::StatusCode; constexpr Code NOT_FOUND = absl::StatusCode::kNotFound; constexpr Code OK = absl::StatusCode::kOk; }
namespace errors {
template <typename... A> absl::Status NotFound(A... a) { return absl::NotFoundError((std::string() + ... + std::string(a))); }
template <typename... A> absl::Status Internal(A... a) { return absl::InternalError((std::string() + ... + std::string(a))); }
template <typename... A> absl::Status InvalidArgument(A... a) { return absl::InvalidArgumentError((std::string() + ... + std::string(a))); }
}

class RandomAccessFile {
 public:
  explicit RandomAccessFile(FILE* f) : f_(f) {}
  ~RandomAccessFile() { if (f_) fclose(f_); }
  // Reads up to n bytes at offset into scratch; *result points at the bytes read. OutOfRange at EOF.
  absl::Status Read(uint64 offset, size_t n, std::string_view* result, char* scratch) const;
 private:
  FILE* f_;
};

class WritableFile {
 public:
  explicit WritableFile(FILE* f) : f_(f) {}
  ~WritableFile() { if (f_) fclose(f_); }
  absl::Status Append(std::string_view data);
  absl::Status Flush();
  absl::Status Close();
 private:
  FILE* f_;
};

class Env {
 public:
  static Env* Default();
  absl::Status NewRandomAccessFile(const std::string& fname, std::unique_ptr<RandomAccessFile>* result);
  absl::Status NewWritableFile(const std::string& fname, std::unique_ptr<WritableFile>* result);
  absl::Status FileExists(const std::string& fname);
  absl::Status GetMatchingPaths(const std::string& pattern, std::vector<std::string>* results);
};

namespace io {
namespace compression { inline constexpr char kNone[] = ""; inline constexpr char kGzip[] = "GZIP"; inline constexpr char kZlib[] = "ZLIB"; }

struct RecordReaderOptions {
  bool gzip = false;
  size_t buffer_size = 0;  // ignored: the reader loads the whole file
  static RecordReaderOptions CreateRecordReaderOptions(const std::string& compression_type);
};
class RecordReader {
 public:
  RecordReader(RandomAccessFile* file, const RecordReaderOptions& options = RecordReaderOptions());
  // Reads the record at *offset (an offset into the uncompressed stream) and advances it.
  absl::Status ReadRecord(uint64* offset, tstring* record);
 private:
  absl::Status Load();
  RandomAccessFile* file_; RecordReaderOptions options_; bool loaded_ = false; std::string data_; absl::Status load_status_;
};

struct RecordWriterOptions {
  bool gzip = false;
  static RecordWriterOptions CreateRecordWriterOptions(const std::string& compression_type);
};
class RecordWriter {
 public:
  RecordWriter(WritableFile* dest, const RecordWriterOptions& options = RecordWriterOptions());
  ~RecordWriter();
  absl::Status WriteRecord(std::string_view data);
  absl::Status Flush();
  absl::Status Close();
 private:
  absl::Status Emit(std::string_view bytes, bool finish);
  WritableFile* dest_; RecordWriterOptions options_; void* zstream_ = nullptr; bool closed_ = false;
};

class InputStreamInterface { public: virtual ~InputStreamInterface() = default; };
class RandomAccessInputStream : public InputStreamInterface {
 public:
  RandomAccessInputStream(RandomAccessFile* file, bool owns_file = false) : file_(file), owns_(owns_file) {}
  ~RandomAccessInputStream() override { if (owns_) delete file_; }
  RandomAccessFile* file() { return file_; }
 private:
  RandomAccessFile* file_; bool owns_;
};
class BufferedInputStream {
 public:
  BufferedInputStream(InputStreamInterface* input, size_t buffer_bytes, bool owns_input_stream = false);
  ~BufferedInputStream() { if (owns_) delete input_; }
  // Returns the next line including its trailing '\n'; empty string at EOF (as TensorFlow does).
  std::string ReadLineAsString();
 private:
  InputStreamInterface* input_; bool owns_; uint64 pos_ = 0; std::string buf_; size_t buf_pos_ = 0; bool eof_ = false;
};
}  // namespace io
}  // namespace tensorflow
#endif
