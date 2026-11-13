#ifndef FIREBASE_DIAGNOSTICS_H
#define FIREBASE_DIAGNOSTICS_H

#include <stdint.h>

// Pure, worker-owned bookkeeping. Explicit 32-bit arithmetic matches millis()
// on ESP32, including wraparound (durations must be less than one full wrap).
namespace FirebaseDiagnostics {
inline uint32_t elapsed(uint32_t now, uint32_t since) { return now - since; }

struct Interval {
  uint32_t last = 0;
  bool seen = false;
  bool due(uint32_t now, uint32_t period, bool immediate = false) {
    if (!seen) {
      seen = true;
      last = now;
      return immediate;
    }
    if (elapsed(now, last) < period) return false;
    last = now;
    return true;
  }
};

struct Recovery {
  uint32_t failures;
  uint32_t elapsedMs;
};

struct Counters {
  uint32_t successes = 0;
  uint32_t failures = 0;
  uint32_t streak = 0;
  uint32_t firstError = 0;
  uint32_t lastSuccess = 0;
  bool hasSuccess = false;

  Recovery record(bool ok, uint32_t now) {
    Recovery recovery{0, 0};
    if (!ok) {
      ++failures;
      if (streak == 0) firstError = now;
      ++streak;
    } else {
      ++successes;
      hasSuccess = true;
      lastSuccess = now;
      if (streak != 0) recovery = {streak, elapsed(now, firstError)};
      streak = 0;
    }
    return recovery;
  }
};
} // namespace FirebaseDiagnostics

#endif
