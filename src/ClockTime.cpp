#include "ClockTime.h"

ClockTime::ClockTime(long gmtOffsetSec)
    : _gmtOffsetSec(gmtOffsetSec), _lastSync(0), _begun(false) {}

void ClockTime::begin() {
  if (_begun) {
    return;
  }
  configTime(_gmtOffsetSec, 0, "pool.ntp.org", "time.nist.gov");
  _begun = true;
  _lastSync = millis();
  Serial.println("ClockTime: dang dong bo gio tu NTP...");
}

void ClockTime::handle() {
  // Sync lai moi 1 gio de bu troi lech
  if (_begun && millis() - _lastSync >= 3600000UL) {
    configTime(_gmtOffsetSec, 0, "pool.ntp.org", "time.nist.gov");
    _lastSync = millis();
  }
}

bool ClockTime::isSynced() const {
  if (!_begun) {
    return false;
  }
  time_t now = time(nullptr);
  return now > 1700000000; // > ~14/11/2023 thi coi nhu da co gio that
}

void ClockTime::getTime(char *buf, int n) {
  struct tm t;
  if (!getLocalTime(&t, 100)) { // timeout 100ms, khong chan lau
    snprintf(buf, n, "--:--");
    return;
  }
  snprintf(buf, n, "%02d:%02d", t.tm_hour, t.tm_min);
}

void ClockTime::getDate(char *buf, int n) {
  struct tm t;
  if (!getLocalTime(&t, 100)) {
    snprintf(buf, n, "--/--");
    return;
  }
  snprintf(buf, n, "%02d/%02d", t.tm_mday, t.tm_mon + 1);
}
