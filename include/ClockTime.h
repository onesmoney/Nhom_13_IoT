#ifndef CLOCK_TIME_H
#define CLOCK_TIME_H

#include <Arduino.h>
#include <time.h>

// Lay gio tu NTP qua WiFi, giu chay bang RTC ben trong ESP32.
// Chi hoat dong khi da co WiFi; mat mang thi van dem tiep tu lan sync cuoi.
// begin() la khong chan (chi cau hinh), goi isSynced() sau vai giay de biet
// da nhan duoc gio chua; sync lai dinh ky moi 1 gio.
class ClockTime {
public:
  // gmtOffsetSec: GMT+7 = 25200 cho Viet Nam
  explicit ClockTime(long gmtOffsetSec = 7 * 3600);

  void begin();           // cau hinh NTP, khong chan
  void handle();          // goi trong loop(): tu dong sync lai moi 1 gio

  bool isSynced() const;            // da co gio dung chua
  void getTime(char *buf, int n);   // "HH:MM"
  void getDate(char *buf, int n);   // "DD/MM"

private:
  long _gmtOffsetSec;
  unsigned long _lastSync;
  bool _begun;
};

#endif // CLOCK_TIME_H
