#pragma once

#include <Arduino.h>
#include <stdio.h>
#include <time.h>

// Dung gio dia phuong do ClockTime cau hinh; khong cho NTP trong luc log.
class LogTimestamp {
public:
  LogTimestamp(time_t now = time(nullptr), unsigned long uptimeMs = millis()) {
    struct tm local = {};
#ifdef _WIN32
    const bool valid = now > 1700000000 && localtime_s(&local, &now) == 0;
#else
    const bool valid = now > 1700000000 && localtime_r(&now, &local) != nullptr;
#endif
    if (valid && strftime(_text, sizeof(_text), "[%Y-%m-%d %H:%M:%S]", &local) > 0) {
      return;
    }
    snprintf(_text, sizeof(_text), "[chua dong bo gio; uptime=%lums]", uptimeMs);
  }

  const char *c_str() const { return _text; }

private:
  // Moi lan log co buffer rieng, khong dung chung giua loop va task Firebase.
  char _text[64];
};
