#ifndef STATUS_DISPLAY_H
#define STATUS_DISPLAY_H

#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>

// Hien thi WiFi, dong ho va du lieu cam bien tren OLED SH1106 128x64.
// I2C mac dinh: SDA=21, SCL=22, dia chi 0x3C; chung bus voi BH1750.
class StatusDisplay {
public:
  enum WifiMode {
    WIFI_CONNECTING,
    WIFI_SMARTCONFIG,  // Cho nhan cau hinh WiFi tu ESP-Touch.
    WIFI_PORTAL,       // Hien thong tin AP va trang cau hinh.
    WIFI_ONLINE,       // Hien IP sau khi ket noi thanh cong.
    WIFI_OFFLINE,
    WIFI_CLOCK         // Hien ngay, gio, cot song va du lieu cam bien.
  };

  StatusDisplay(int sdaPin = 21, int sclPin = 22, uint8_t address = 0x3C);

  // Khoi tao OLED; tra ve false neu thiet bi khong phan hoi tren I2C.
  bool begin();
  bool isReady() const { return _ready; }

  // Tam tat man hinh va dung cap nhat; resume() bat lai va yeu cau ve lai.
  void pause();
  void resume();
  bool isPaused() const { return _paused; }

  // Goi trong loop(); chi ve lai khi noi dung hoac trang thai thay doi.
  // line1/line2 va pmLine1/pmLine2: nullptr = giu noi dung cu, chuoi rong = xoa.
  // remainingSeconds: >= 0 hien dem nguoc khi cho WiFi/SmartConfig, -1 de an.
  // timeStr/dateStr va dong PM chi hien o WIFI_CLOCK.
  // blinkSec (0-59): giay chan hien dau ':', giay le an; -1 luon hien.
  void update(WifiMode mode, const String &ssid, int rssi, const String &ip,
              const String *line1 = nullptr, const String *line2 = nullptr,
              int remainingSeconds = -1, const char *timeStr = nullptr,
              const char *dateStr = nullptr, int blinkSec = -1,
              const String *pmLine1 = nullptr, const String *pmLine2 = nullptr);

private:
  // Ve cot song, phan WiFi/dong ho va hai dong cam bien vao buffer.
  void drawSignalBarsAt(int x, int rssi, int baselineY);
  void drawWifiSection(WifiMode mode, const String &ssid, int rssi,
                       const String &ip, int remainingSeconds,
                       const char *timeStr, const char *dateStr,
                       int blinkSec);
  void drawSensorSection(const String &line1, const String &line2);

  U8G2_SH1106_128X64_NONAME_F_HW_I2C _u8g2;
  int _sdaPin;
  int _sclPin;
  uint8_t _address;
  bool _ready;
  bool _paused;
  bool _forceRedraw;

  // Noi dung cam bien duoc giu lai giua cac lan goi update().
  String _line1;
  String _line2;
  String _pmLine1;
  String _pmLine2;

  // Trang thai lan ve truoc, dung de phat hien thay doi va tranh gui lai qua I2C.
  WifiMode _lastMode;
  String _lastSsid;
  String _lastIp;
  int _lastRssi;
  uint8_t _lastDotPhase;
  int _lastRemainingSec;
  String _lastLine1;
  String _lastLine2;
  String _lastPmLine1;
  String _lastPmLine2;
  String _lastTime;
  String _lastDate;
  int _lastBlinkSec;
};

#endif // STATUS_DISPLAY_H
