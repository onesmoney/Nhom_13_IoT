#include "StatusDisplay.h"

namespace {
// Baseline (chan chu) cua cac dong tren man hinh cao 64px, font 6x12
const int Y1 = 11, Y2 = 24, Y3 = 37, Y4 = 50, Y5 = 63;
const int MAX_CHARS = 21; // 128px / 6px moi ky tu
const unsigned long DOT_PHASE_MS = 400; // chu ky nhay cua dau "."
} // namespace

StatusDisplay::StatusDisplay(int sdaPin, int sclPin, uint8_t address)
    : _u8g2(U8G2_R0, U8X8_PIN_NONE), _sdaPin(sdaPin), _sclPin(sclPin),
      _address(address), _ready(false), _paused(false), _forceRedraw(false),
      _lastMode(WIFI_OFFLINE), _lastRssi(0),
      _lastDotPhase(0xFF), _lastRemainingSec(-1), _lastBlinkSec(-2) {}

bool StatusDisplay::begin() {
  Wire.begin(_sdaPin, _sclPin);

  // Thu ACK truoc: khong co thiet bi o dia chi nay thi bo qua phan con lai
  Wire.beginTransmission(_address);
  if (Wire.endTransmission() != 0) {
    Serial.printf("Khong tim thay OLED o dia chi 0x%02X tren bus I2C "
                  "(kiem tra SDA=GPIO %d, SCL=GPIO %d, VCC)\n",
                  _address, _sdaPin, _sclPin);
    return false;
  }

  _u8g2.setI2CAddress(_address << 1); // U8g2 nhan dia chi dang 8-bit
  _u8g2.begin();
  _u8g2.setFont(u8g2_font_6x12_tf);
  _ready = true;
  _forceRedraw = true;
  if (_paused) {
    _u8g2.setPowerSave(1);
  }
  Serial.printf(
      "Khoi tao OLED SH1106 128x64 OK: dia chi 0x%02X, SDA=GPIO %d, SCL=GPIO %d\n",
      _address, _sdaPin, _sclPin);
  return true;
}

void StatusDisplay::pause() {
  if (_paused) {
    return;
  }
  _paused = true;
  if (_ready) {
    _u8g2.setPowerSave(1);
  }
}

void StatusDisplay::resume() {
  if (!_paused) {
    return;
  }
  _paused = false;
  _forceRedraw = true;
  if (_ready) {
    _u8g2.setPowerSave(0);
  }
}

// Cot song 3 vach nho gon, goc trai tai (x, baselineY); vach dac = muc song.
// Quy doi RSSI (dBm) sang so vach theo nguong -75/-65/-55.
void StatusDisplay::drawSignalBarsAt(int x, int rssi, int baselineY) {
  uint8_t level = 0;
  if (rssi >= -75) level = 1;
  if (rssi >= -65) level = 2;
  if (rssi >= -55) level = 3;
  for (uint8_t i = 0; i < 3; i++) {
    int h = 3 + i * 3; // 3, 6, 9 px — nho hon, gon hon
    int bx = x + i * 4;
    int y = baselineY - h;
    if (i < level) {
      _u8g2.drawBox(bx, y, 3, h);
    } else {
      _u8g2.drawFrame(bx, y, 3, h);
    }
  }
}

// Ve 3 dong tren (phan WiFi / dong ho) vao buffer RAM — goi nhanh bao nhieu
// cung duoc, chi ton bang thong I2C khi sendBuffer() day len man hinh.
// remainingSeconds >= 0: hien so giay con lai (khi SmartConfig/cho ket noi).
// timeStr/dateStr: chi dung khi mode = WIFI_CLOCK.
void StatusDisplay::drawWifiSection(WifiMode mode, const String &ssid,
                                    int rssi, const String &ip,
                                    int remainingSeconds, const char *timeStr,
                                    const char *dateStr, int blinkSec) {
  uint8_t dots = (millis() / DOT_PHASE_MS) % 4;
  switch (mode) {
    case WIFI_ONLINE: {
      // 3 giay dau sau ket noi: chi hien IP to ở giua (bo SSID, song, RSSI).
      // Font 9x15: so ~9px rong, "192.168.100.45" (14 ky tu) ~126px -> vua.
      String ipText = ip.length() ? ip : "...";
      _u8g2.drawStr(0, Y1, "Da ket noi!");
      _u8g2.setFont(u8g2_font_9x15_tf);
      int iw = _u8g2.getStrWidth(ipText.c_str());
      int ix = (128 - iw) / 2;
      if (ix < 0) ix = 0;
      _u8g2.drawStr(ix, Y3, ipText.c_str());
      _u8g2.setFont(u8g2_font_6x12_tf); // tra lai font nho
      break;
    }
    case WIFI_CLOCK: {
      // Che do dong ho: ngay trai, gio giua, cot song phai — 1 dong tren.
      // Dau ":" trong gio nhay theo giay (blinkSec do caller truyen vao).
      if (dateStr) {
        _u8g2.drawStr(0, Y1, dateStr); // "14/10" sat le trai
      }
      if (timeStr) {
        // Ve HH, ":", MM o VI TRI CO DINH de phan phut khong bi dich khi ":"
        // nhay (font khong monospace: ":" hep hon so nen ve lien tuc se giat).
        String t = timeStr;
        int colonPos = t.indexOf(':');
        String hh = colonPos > 0 ? t.substring(0, colonPos) : t;
        String mm = colonPos > 0 ? t.substring(colonPos + 1) : "";
        int hhW = _u8g2.getStrWidth(hh.c_str());
        int colW = _u8g2.getStrWidth(":");
        int mmW = mm.length() ? _u8g2.getStrWidth(mm.c_str()) : 0;
        int totalW = hhW + colW + mmW;
        int tx = (128 - totalW) / 2; // can giua man hinh
        if (tx < 40) tx = 40;        // khong de de len ngay ben trai

        _u8g2.drawStr(tx, Y1, hh.c_str());
        // dau ":" nhay theo giay: giay chan hien, giay le an (de trong)
        int colonX = tx + hhW;
        if (blinkSec < 0 || blinkSec % 2 == 0) {
          _u8g2.drawStr(colonX, Y1, ":");
        }
        if (mm.length() > 0) {
          _u8g2.drawStr(colonX + colW, Y1, mm.c_str()); // MM o vi tri co dinh
        }
      }
      drawSignalBarsAt(114, rssi, Y1 + 1); // cot song goc phai, nho gon
      break;
    }
    case WIFI_PORTAL:
      _u8g2.drawStr(0, Y1, ">> Che do cau hinh <<");
      _u8g2.drawStr(0, Y2, ("AP: " + ssid).substring(0, MAX_CHARS).c_str());
      _u8g2.drawStr(0, Y3, ("Mo: " + ip).substring(0, MAX_CHARS).c_str());
      break;
    case WIFI_SMARTCONFIG: {
      String s = "SmartConfig";
      for (uint8_t i = 0; i < dots; i++) {
        s += ".";
      }
      _u8g2.drawStr(0, Y1, s.c_str());
      _u8g2.drawStr(0, Y2, "Gui WiFi tu ESP-Touch");
      if (remainingSeconds >= 0) {
        // dong 3: so giay con lai + thanh progress chay dan ve 0
        _u8g2.drawStr(0, Y3,
                      ("Con lai: " + String(remainingSeconds) + "s").c_str());
        int filled = (remainingSeconds * 128) / 30; // SmartConfig timeout 30s
        if (filled > 128) filled = 128;
        if (filled > 0) {
          _u8g2.drawBox(0, 39, filled, 3);
        }
      }
      break;
    }
    case WIFI_CONNECTING: {
      String s = "Dang ket noi WiFi";
      for (uint8_t i = 0; i < dots; i++) {
        s += ".";
      }
      _u8g2.drawStr(0, Y1, s.c_str());
      if (ssid.length() > 0) {
        _u8g2.drawStr(0, Y2, ssid.substring(0, MAX_CHARS).c_str());
      }
      if (remainingSeconds >= 0) {
        _u8g2.drawStr(0, Y3,
                      ("Con lai: " + String(remainingSeconds) + "s").c_str());
      }
      break;
    }
    case WIFI_OFFLINE:
      _u8g2.drawStr(0, Y1, "Mat ket noi WiFi!");
      break;
  }
}

// Ve 2 dong duoi (phan cam bien).
void StatusDisplay::drawSensorSection(const String &line1,
                                      const String &line2) {
  if (line1.length() > 0) {
    _u8g2.drawStr(0, Y4, line1.substring(0, MAX_CHARS).c_str());
  }
  if (line2.length() > 0) {
    _u8g2.drawStr(0, Y5, line2.substring(0, MAX_CHARS).c_str());
  }
}

void StatusDisplay::update(WifiMode mode, const String &ssid, int rssi,
                           const String &ip, const String *line1,
                           const String *line2, int remainingSeconds,
                           const char *timeStr, const char *dateStr,
                           int blinkSec, const String *pmLine1,
                           const String *pmLine2) {
  if (!_ready || _paused) {
    return;
  }

  // Caller khong truyen dong nao thi dong do giu nguyen noi dung cu —
  // tranh tinh trang mot cho goi chuoi rong lam nhay phan cam bien.
  if (line1 != nullptr) {
    _line1 = *line1;
  }
  if (line2 != nullptr) {
    _line2 = *line2;
  }
  if (pmLine1 != nullptr) {
    _pmLine1 = *pmLine1;
  }
  if (pmLine2 != nullptr) {
    _pmLine2 = *pmLine2;
  }
  String newTime = timeStr ? timeStr : "";
  String newDate = dateStr ? dateStr : "";

  uint8_t dots = (millis() / DOT_PHASE_MS) % 4;
  bool wifiDirty =
      (mode != _lastMode) || (ssid != _lastSsid) ||
      ((mode == WIFI_ONLINE || mode == WIFI_CLOCK) && rssi != _lastRssi) ||
      (mode == WIFI_ONLINE && ip != _lastIp) ||
      ((mode == WIFI_CONNECTING || mode == WIFI_SMARTCONFIG) &&
       dots != _lastDotPhase) ||
      (remainingSeconds != _lastRemainingSec) ||
      (mode == WIFI_CLOCK &&
       (newTime != _lastTime || newDate != _lastDate ||
        blinkSec != _lastBlinkSec));
  bool sensorDirty = (_line1 != _lastLine1) || (_line2 != _lastLine2) ||
      (mode == WIFI_CLOCK &&
       (_pmLine1 != _lastPmLine1 || _pmLine2 != _lastPmLine2));

  if (!_forceRedraw && !wifiDirty && !sensorDirty) {
    return; // khong co gi thay doi -> khong gui gi qua I2C ca
  }

  _u8g2.clearBuffer();
  drawWifiSection(mode, ssid, rssi, ip, remainingSeconds, timeStr, dateStr,
                  blinkSec);
  if (mode == WIFI_CLOCK) {
    _u8g2.drawStr(0, Y2, _pmLine1.substring(0, MAX_CHARS).c_str());
    _u8g2.drawStr(0, Y3, _pmLine2.substring(0, MAX_CHARS).c_str());
  }
  if (mode == WIFI_ONLINE || mode == WIFI_CLOCK) {
    drawSensorSection(_line1, _line2);
  }
  _u8g2.sendBuffer();
  _forceRedraw = false;

  _lastMode = mode;
  _lastSsid = ssid;
  _lastRssi = rssi;
  _lastIp = ip;
  _lastDotPhase = dots;
  _lastRemainingSec = remainingSeconds;
  _lastLine1 = _line1;
  _lastLine2 = _line2;
  _lastPmLine1 = _pmLine1;
  _lastPmLine2 = _pmLine2;
  _lastTime = newTime;
  _lastDate = newDate;
  _lastBlinkSec = blinkSec;
}
