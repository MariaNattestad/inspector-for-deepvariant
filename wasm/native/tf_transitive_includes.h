// Force-included into all DeepVariant/Nucleus sources. In the real build these absl headers arrive
// transitively through TensorFlow's headers (e.g. nucleus/core/status.h uses LOG(FATAL) without
// including absl/log/log.h). Our TensorFlow stand-in doesn't drag them in, so include them here.
#pragma once
#ifdef __cplusplus
#include "absl/log/check.h"
#include "absl/log/log.h"
#include "absl/strings/str_cat.h"
#include "absl/strings/str_join.h"
#include "absl/strings/str_split.h"
#include "absl/strings/string_view.h"
#endif
#if defined(__cplusplus) && !defined(VLOG)
#define VLOG(level) LOG_IF(INFO, false)
#endif
