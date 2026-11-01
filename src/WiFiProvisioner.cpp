#include "WiFiProvisioner.h"
#include "wifi/PortalPages.h"
#include "wifi/vendor/PicoCss.h"

#include <cstring>
#include <esp_wifi.h>

namespace {
const unsigned long kScanTimeoutMs = 15000;

String jsonEscape(const String &value) {
  const char hex[] = "0123456789abcdef";
  String escaped;
  for (unsigned int i = 0; i < value.length(); ++i) {
    unsigned char c = static_cast<unsigned char>(value[i]);
    if (c == '"' || c == '\\') {
      escaped += '\\';
      escaped += static_cast<char>(c);
    } else if (c < 0x20) {
      escaped += "\\u00";
      escaped += hex[c >> 4];
      escaped += hex[c & 0x0f];
    } else {
      escaped += static_cast<char>(c);
    }
  }
  return escaped;
}

bool readStationConfig(String &ssid, String &pass) {
  wifi_config_t config = {};
  if (esp_wifi_get_config(WIFI_IF_STA, &config) != ESP_OK) {
    ssid = "";
    pass = "";
    return false;
  }

  char ssidBuffer[sizeof(config.sta.ssid) + 1] = {};
  char passBuffer[sizeof(config.sta.password) + 1] = {};
  std::memcpy(ssidBuffer, config.sta.ssid, sizeof(config.sta.ssid));
  std::memcpy(passBuffer, config.sta.password, sizeof(config.sta.password));
  ssid = String(ssidBuffer);
  pass = String(passBuffer);
  return ssid.length() > 0;
}
}  // namespace

WiFiProvisioner::WiFiProvisioner(const char *apSsid, const char *apPass,
                                 unsigned long wifiTimeoutMs,
                                 unsigned long smartConfigTimeoutMs,
                                 unsigned long smartConfigConnectTimeoutMs,
                                 unsigned long portalConnectTimeoutMs,
                                 int statusLedPin)
    : _apSsid(apSsid), _apPass(apPass),
      _wifiTimeoutMs(wifiTimeoutMs),
      _smartConfigTimeoutMs(smartConfigTimeoutMs),
      _smartConfigConnectTimeoutMs(smartConfigConnectTimeoutMs),
      _portalConnectTimeoutMs(portalConnectTimeoutMs),
      _server(80), _portalActive(false), _smartConfigActive(false),
      _scanActive(false), _scanStartedMs(0), _portalAutoReconnect(true),
      _led(statusLedPin), _onProgress(nullptr) {}

// Goi callback ngoai dinh ky (~100ms) de OLED/tien ich khac cap nhat trang
// thai ke ca khi dang o giua cac vong cho cua begin(). remainingSeconds la
// so giay con lai cua vong dem nguoc dang chay (-1 = khong dem nguoc).
void WiFiProvisioner::progressTick(int remainingSeconds) {
  if (!_onProgress) {
    return;
  }
  static unsigned long lastCall = 0;
  if (millis() - lastCall >= 100) {
    lastCall = millis();
    _onProgress(remainingSeconds);
  }
}

// Cho WiFi ket noi trong timeoutMs, in dau "." lam tien do
bool WiFiProvisioner::waitConnected(unsigned long timeoutMs) {
  unsigned long start = millis();
  unsigned long lastDot = 0;
  bool printed = false;
  while (millis() - start < timeoutMs) {
    _led.update();
    int remaining = (int)((timeoutMs - (millis() - start)) / 1000UL);
    progressTick(remaining);
    if (WiFi.status() == WL_CONNECTED) {
      return true;
    }
    if (millis() - lastDot >= 500) {
      Serial.print(".");
      lastDot = millis();
      printed = true;
    }
    delay(50);
  }
  if (printed) {
    Serial.println();
  }
  return false;
}

String WiFiProvisioner::htmlEscape(const String &s) {
  String r;
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '&') r += "&amp;";
    else if (c == '<') r += "&lt;";
    else if (c == '>') r += "&gt;";
    else if (c == '"') r += "&quot;";
    else r += c;
  }
  return r;
}

// Trang chu: tra ve NGAY, khong chan quet WiFi. JavaScript trong trang se goi
// /scan de lay danh sach (async) -> nguoi dung thay "Dang quet..." ngay lap
// tuc, tranh man hinh trang 2-3 giay khi mo trang trong captive popup.
void WiFiProvisioner::handleRoot() {
  Serial.println("Co client mo trang cau hinh.");
  _server.send_P(200, "text/html; charset=utf-8", WifiPortal::kSetupPage);
}

// API quet WiFi theo kieu async: lan goi dau bat dau quet nen (non-blocking),
// cac lan sau tra ket qua khi xong. Tra JSON de JS trong trang hien thi.
void WiFiProvisioner::handleScan() {
  int16_t n = WiFi.scanComplete();
  if (!_scanActive && n == WIFI_SCAN_FAILED) {
    Serial.println("Bat dau quet WiFi (async)...");
    _scanStartedMs = millis();
    n = WiFi.scanNetworks(true);
    if (n == WIFI_SCAN_FAILED) {
      Serial.printf("Khong the bat dau quet WiFi: %d\n", n);
      WiFi.scanDelete();
      _server.send(503, "application/json",
                   "{\"status\":\"error\",\"error\":\"scan_start_failed\",\"networks\":[]}");
      return;
    }
    _scanActive = true;
  }
  if (n == WIFI_SCAN_FAILED) {
    Serial.printf("Quet WiFi that bai: %d\n", n);
    stopScan();
    _server.send(503, "application/json",
                 "{\"status\":\"error\",\"error\":\"scan_failed\",\"networks\":[]}");
    return;
  }
  if (n == WIFI_SCAN_RUNNING) {
    if (!_scanActive) {
      _scanActive = true;
      _scanStartedMs = millis();
    }
    if (millis() - _scanStartedMs >= kScanTimeoutMs) {
      Serial.println("Quet WiFi qua thoi gian cho.");
      stopScan();
      _server.send(504, "application/json",
                   "{\"status\":\"error\",\"error\":\"scan_timeout\",\"networks\":[]}");
      return;
    }
    _server.send(202, "application/json", "{\"status\":\"scanning\",\"networks\":[]}");
    return;
  }
  // n >= 0: quet xong -> tra danh sach SSID + RSSI
  String json = "{\"status\":\"done\",\"networks\":[";
  for (int i = 0; i < n; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + jsonEscape(WiFi.SSID(i)) +
            "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
  }
  json += "]}";
  WiFi.scanDelete();
  _scanActive = false;
  _server.send(200, "application/json", json);
  Serial.printf("Tra danh sach %d mang WiFi cho client.\n", n);
}

void WiFiProvisioner::stopScan() {
  if (_scanActive || WiFi.scanComplete() == WIFI_SCAN_RUNNING) {
    esp_wifi_scan_stop();
  }
  WiFi.scanDelete();
  _scanActive = false;
}

// Nhan thong tin WiFi tu form, thu ket noi ngay trong che do AP+STA
void WiFiProvisioner::handleSave() {
  // Uu tien o nhap tay (ssidManual) neu co, khong thi lay tu select (ssid).
  String ssid = _server.arg("ssidManual");
  if (ssid.length() == 0) {
    ssid = _server.arg("ssid");
  }
  String pass = _server.arg("pass");

  if (ssid.length() == 0) {
    _server.send_P(400, "text/html; charset=utf-8", WifiPortal::kMissingSsidPage);
    return;
  }

  Serial.println("Nhan cau hinh WiFi tu web: SSID=" + ssid + " | PASS=" + pass);
  stopScan();
  WiFi.begin(ssid.c_str(), pass.c_str());

  if (waitConnected(_portalConnectTimeoutMs)) {
    Serial.println("Ket noi thanh cong! IP: " + WiFi.localIP().toString());
    _server.send_P(200, "text/html; charset=utf-8", WifiPortal::kSuccessPage);
    stopPortal();
    _led.setState(StatusLed::CONNECTED);
  } else {
    Serial.println("Ket noi that bai (sai SSID/mat khau?), quay lai trang cau hinh.");
    WiFi.disconnect();           // xoa ket noi that bai, giu nguyen AP
    WiFi.softAP(_apSsid, _apPass); // dam bao AP van song de thu lai
    _server.send_P(200, "text/html; charset=utf-8", WifiPortal::kFailurePage);
  }
}

// Tra loi URL "kiem tra mang" cua he dieu hanh bang redirect ve trang chu
// — de dien thoai hieu day la captive portal va tu mo trang cau hinh.
void WiFiProvisioner::handleCaptive() {
  String url = "http://" + WiFi.softAPIP().toString() + "/";
  _server.sendHeader("Location", url, true);
  _server.send(302, "text/plain", "");
}

// Mo AP + trang web cau hinh + captive portal (tu bat trang khi dien thoai
// noi WiFi). DNS tra loi MOI ten mien ve IP cua AP nen cac URL "kiem tra
// mang" cua Android/iOS/Windows deu dan ve trang cau hinh.
void WiFiProvisioner::startPortal() {
  Serial.println("Bat che do AP: SSID=" + String(_apSsid) + " | mat khau=" + _apPass);
  WiFi.mode(WIFI_AP_STA);
  _portalAutoReconnect = WiFi.getAutoReconnect();
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false, false); // dung ket noi cu, khong xoa thong tin NVS
  stopScan();
  WiFi.softAP(_apSsid, _apPass);
  Serial.print("IP cua AP: ");
  Serial.println(WiFi.softAPIP());
  Serial.println("Ket noi dien thoai vao WiFi nay, trang cau hinh se tu bat (captive portal)");
  _led.setState(StatusLed::AP_PORTAL);

  // DNS: tra loi moi query ve dia chi AP -> bat buc mo trang cau hinh
  _dnsServer.start(53, "*", WiFi.softAPIP());

  _server.on("/", [this] { handleRoot(); });
  _server.on("/save", HTTP_POST, [this] { handleSave(); });
  _server.on("/scan", [this] { handleScan(); });
  _server.on("/wifi/pico.min.css", HTTP_GET, [this] {
    _server.send_P(200, "text/css; charset=utf-8", WifiPortal::kPicoCss);
  });
  _server.on("/wifi/portal.css", HTTP_GET, [this] {
    _server.send_P(200, "text/css; charset=utf-8", WifiPortal::kPortalCss);
  });
  _server.on("/wifi/portal.js", HTTP_GET, [this] {
    _server.send_P(200, "application/javascript; charset=utf-8", WifiPortal::kPortalScript);
  });
  // Cac URL ma he dieu hanh dung de phat hien captive portal
  _server.on("/generate_204", [this] { handleCaptive(); });         // Android
  _server.on("/gen_204", [this] { handleCaptive(); });              // Android
  _server.on("/hotspot-detect.html", [this] { handleCaptive(); });  // iOS/macOS
  _server.on("/library/test/success.html", [this] { handleCaptive(); }); // iOS
  _server.on("/ncsi.txt", [this] { handleCaptive(); });             // Windows
  _server.on("/connecttest.txt", [this] { handleCaptive(); });      // Windows 10/11
  _server.on("/fwlink", [this] { handleCaptive(); });               // Windows
  _server.on("/redirect", [this] { handleCaptive(); });             // khac
  _server.onNotFound([this] { handleCaptive(); });                  // moi URL con lai
  _server.begin();
  _portalActive = true;
}

// Tat AP, ve che do STA binh thuong
void WiFiProvisioner::stopPortal() {
  stopScan();
  _server.stop();
  _dnsServer.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(_portalAutoReconnect);
  _portalActive = false;
}

bool WiFiProvisioner::begin(bool allowSmartConfig, int smartConfigPin) {
  WiFi.persistent(true); // thong tin WiFi duoc ghi vao flash (NVS), giu lai sau reboot

  // Buoc 1: trong 30 giay dau kho dong, thu ket noi WiFi da luu trong NVS
  _led.setState(StatusLed::WIFI_CONNECTING);
  WiFi.mode(WIFI_STA);

  String savedSsid;
  String savedPass;
  if (readStationConfig(savedSsid, savedPass)) {
    Serial.println("Buoc 1/3: tim thay WiFi da luu: SSID=" + savedSsid +
                   " | PASS=" + savedPass +
                   ", cho ket noi toi da 30 giay...");
    WiFi.begin();
    if (waitConnected(_wifiTimeoutMs)) {
      Serial.println("Da ket noi WiFi: " + WiFi.SSID() + " | IP: " + WiFi.localIP().toString());
      _led.setState(StatusLed::CONNECTED);
      return true;
    }
    Serial.println("Khong ket noi duoc WiFi da luu.");
  } else {
    Serial.println("Buoc 1/3: chua co WiFi nao duoc luu -> bo qua.");
  }

  if (!allowSmartConfig) {
    Serial.println("Buoc 2/3: GPIO kich hoat dang LOW -> bo qua SmartConfig.");
    Serial.println("Buoc 3/3: bat che do AP de cau hinh WiFi.");
    startPortal();
    return false;
  }

  // Buoc 2: WiFi cu that bai va chan kich hoat HIGH -> SmartConfig
  Serial.println("Buoc 2/3: GPIO kich hoat dang HIGH -> bat SmartConfig trong 30 giay.");
  Serial.println("Mo app ESP-Touch de gui thong tin WiFi...");
  _led.setState(StatusLed::SMARTCONFIG);
  _smartConfigActive = true;
  WiFi.beginSmartConfig();
  unsigned long scStart = millis();
  unsigned long lastDot = 0;
  bool gotConfig = false;
  while (millis() - scStart < _smartConfigTimeoutMs) {
    _led.update();
    // Rut GPIO32 xuong LOW -> huy SmartConfig ngay, khong cho het timeout
    if (smartConfigPin >= 0 && digitalRead(smartConfigPin) == LOW) {
      Serial.println("\nGPIO32 ha xuong LOW -> huy SmartConfig giua chung.");
      break;
    }
    int remaining = (int)((_smartConfigTimeoutMs - (millis() - scStart)) / 1000UL);
    progressTick(remaining);
    if (WiFi.smartConfigDone()) {
      gotConfig = true;
      break;
    }
    if (millis() - lastDot >= 500) {
      Serial.print(".");
      lastDot = millis();
    }
    delay(50);
  }
  Serial.println();
  WiFi.stopSmartConfig();
  _smartConfigActive = false;

  if (gotConfig) {
    // Driver da nhan thong tin tu SmartConfig, nhung de chac chan duoc luu vao
    // NVS (va xoa BSSID bi "ghim" tu dien thoai gui den), ta doc lai va begin()
    // tuyen minh voi SSID/pass vua nhan.
    String scSsid = WiFi.SSID();
    String scPass = WiFi.psk();
    Serial.println("Nhan duoc thong tin WiFi tu SmartConfig: SSID=" + scSsid +
                   " | PASS=" + scPass);
    if (scSsid.length() > 0) {
      Serial.println("Dang luu WiFi vao NVS: SSID=" + scSsid + " | PASS=" + scPass);
      WiFi.begin(scSsid.c_str(), scPass.c_str());
    }
    if (waitConnected(_smartConfigConnectTimeoutMs)) {
      Serial.println("Da ket noi WiFi: " + WiFi.SSID() + " | IP: " + WiFi.localIP().toString());
      _led.setState(StatusLed::CONNECTED);
      return true;
    }
    Serial.println("Ket noi that bai voi thong tin tu SmartConfig.");
  } else {
    Serial.println("Het 30 giay, khong nhan duoc thong tin SmartConfig.");
  }

  // Buoc 3: van chua co WiFi -> mo AP de cau hinh bang trinh duyet
  Serial.println("Buoc 3/3: bat che do AP de cau hinh WiFi.");
  startPortal();
  return false;
}

void WiFiProvisioner::handle() {
  _led.update();
  progressTick(-1); // trong loop binh thuong / portal mo: khong dem nguoc
  if (_portalActive) {
    _dnsServer.processNextRequest(); // phuc vu DNS cho captive portal
    _server.handleClient();
  }
}

bool WiFiProvisioner::isConnected() const {
  return WiFi.status() == WL_CONNECTED;
}
