#include "FirebaseUploader.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>

// REST API cua Identity Toolkit: dang nhap an danh -> tra ve idToken JWT.
// idToken dung lam ?auth=... tren Realtime Database REST, het han sau 1h
// thi dang nhap lai (refresh token khong can thiet cho do an - chi can
// sign-in lai khi 401/403).
static const char *AUTH_HOST = "identitytoolkit.googleapis.com";

FirebaseUploader::FirebaseUploader(const char *apiKey, const char *databaseUrl,
                                   const char *deviceName, const char *location,
                                   unsigned long pushIntervalMs)
    : _apiKey(apiKey), _databaseUrl(databaseUrl),
      _deviceName(deviceName), _location(location),
      _pushIntervalMs(pushIntervalMs), _hasQueued(false), _lastQueuedValidity(0),
      _lastPush(0), _okCount(0), _failCount(0),
      _begun(false), _authed(false), _hasPending(false), _mutex(nullptr),
      _dbClient(nullptr) {}

void FirebaseUploader::begin() {
  // Tach host tu "https://host" bo phan protocol.
  String url(_databaseUrl);
  int p = url.indexOf("://");
  _host = (p >= 0) ? url.substring(p + 3) : url;
  int slash = _host.indexOf('/');
  if (slash >= 0) {
    _host = _host.substring(0, slash);
  }

  _mutex = xSemaphoreCreateMutex();
  // Tao mot client TLS duy nhat va giu lai de tai su dung ket noi keep-alive.
  // Client chi duoc truy cap boi networkTask, tranh dung dong thoi.
  _dbClient = new WiFiClientSecure();
  if (_dbClient != nullptr) {
    _dbClient->setInsecure(); // TODO: thay bang CA certificate khi chot production.
  }

  // Core 0 = core phu (core 1 chay Arduino loop). Stack 8KB du cho TLS
  // handshake + payload nho; uu tien thap de khong an CPU cua loop.
  xTaskCreatePinnedToCore(networkTask, "fb_net", 8192, this, 1, nullptr, 0);

  _begun = true;
  Serial.printf("Firebase: host=%s deviceName=%s (%s) chu ky=%lums\n",
                _host.c_str(), _deviceName.c_str(), _location,
                _pushIntervalMs);
}

// ====================== phia loop() - khong chan ======================

void FirebaseUploader::handle(bool hasDht, float temperature, float humidity,
                              bool hasLux, float lux, bool hasPm,
                              uint16_t pm1_0, uint16_t pm2_5, uint16_t pm10,
                              int rssi) {
  if (!_begun || WiFi.status() != WL_CONNECTED) {
    return;
  }
  const unsigned long now = millis();
  const uint8_t validity = (hasDht ? 1 : 0) | (hasLux ? 2 : 0) |
                           (hasPm ? 4 : 0);
  // Gui ngay snapshot dau tien va khi mat/co lai du lieu; trang thai khong
  // doi van chi gui theo chu ky, khong tao vong retry mang trong loop().
  if (_hasQueued && validity == _lastQueuedValidity &&
      now - _lastPush < _pushIntervalMs) {
    return;
  }

  // Bo ban moi nhat vao queue, task phu se lay ra push. Neu task dang ban
  // (mang cham), ban nay ghi de len slot -> DB luon nhan du lieu moi nhat.
  if (xSemaphoreTake(_mutex, 10) == pdTRUE) {
    _pending.hasDht = hasDht;
    _pending.temperature = temperature;
    _pending.humidity = humidity;
    _pending.hasLux = hasLux;
    _pending.lux = lux;
    _pending.hasPm = hasPm;
    _pending.pm1_0 = pm1_0;
    _pending.pm2_5 = pm2_5;
    _pending.pm10 = pm10;
    _pending.rssi = rssi;
    _hasPending = true;
    // Chi ghi nhan sau khi nap thanh cong; neu mutex ban thi vong sau thu lai.
    _lastPush = now;
    _lastQueuedValidity = validity;
    _hasQueued = true;
    xSemaphoreGive(_mutex);
  }
}

// ====================== phia task phu - duoc phep block ======================

void FirebaseUploader::networkTask(void *arg) {
  static_cast<FirebaseUploader *>(arg)->networkLoop();
  vTaskDelete(nullptr);
}

void FirebaseUploader::networkLoop() {
  SensorReading snap;
  for (;;) {
    // Cho den khi co du lieu moi (loop() danh thuc qua _hasPending).
    if (!_hasPending) {
      vTaskDelay(50 / portTICK_PERIOD_MS);
      continue;
    }

    // Lay snapshot ra khoi queue -> loop() co the ghi ban moi ngay
    // ma khong phai cho request dang chay xong.
    if (xSemaphoreTake(_mutex, 50) == pdTRUE) {
      snap = _pending;
      _hasPending = false;
      xSemaphoreGive(_mutex);
    } else {
      continue;
    }

    if (WiFi.status() != WL_CONNECTED) {
      continue; // mat WiFi: bo ban nay, handle() se khong nap them
    }

    // Chua co token -> dang nhap truoc. Block o day chi anh huong task nay.
    if (!_authed) {
      signInAnonymously();
      if (!_authed) {
        vTaskDelay(10000 / portTICK_PERIOD_MS); // thu lai sau 10s
        continue;
      }
    }

    // Dang nhap co the mat nhieu giay; uu tien trang thai cam bien moi nhat.
    if (xSemaphoreTake(_mutex, 50) == pdTRUE) {
      if (_hasPending) {
        snap = _pending;
        _hasPending = false;
      }
      xSemaphoreGive(_mutex);
    } else {
      continue;
    }

    // Timestamp neu NTP da sync (ClockTime da cau hinh GMT+7).
    unsigned long ts = (unsigned long)time(nullptr);
    if (ts < 1700000000UL) {
      ts = 0;
    }

    // Build JSON - payload ~300 byte. Metadata kem moi ban ghi de query
    // orderByChild tren RTDB loc duoc theo device/location ngay tren server.
    auto jsonEscape = [](const char *s) -> String {
      String out;
      for (const char *c = s; *c; c++) {
        if (*c == '"' || *c == '\\') {
          out += '\\';
        }
        out += *c;
      }
      return out;
    };

    String json = "{";
    json += "\"deviceName\":\"" + jsonEscape(_deviceName.c_str()) + "\"";
    json += ",\"location\":\"" + jsonEscape(_location) + "\"";
    json += ",\"sensors\":{";
    json += "\"DHT11\":{";
    // JSON null (khong phai 0/chuoi rong); RTDB co the bo leaf null khi luu.
    json += "\"temperature\":" + (snap.hasDht ? String(snap.temperature, 1) : String("null"));
    json += ",\"humidity\":" + (snap.hasDht ? String(snap.humidity, 1) : String("null"));
    json += ",\"ok\":" + String(snap.hasDht ? "true" : "false");
    json += "}";
    json += ",\"BH1750\":{";
    json += "\"lux\":" + (snap.hasLux ? String(snap.lux, 1) : String("null"));
    json += ",\"ok\":" + String(snap.hasLux ? "true" : "false");
    json += "}";
    // Key Firebase khong duoc chua dau ".", nen dung pm2_5 thay vi PM2.5
    json += ",\"PM\":{";
    json += "\"pm1_0\":" + (snap.hasPm ? String(snap.pm1_0) : String("null"));
    json += ",\"pm2_5\":" + (snap.hasPm ? String(snap.pm2_5) : String("null"));
    json += ",\"pm10\":" + (snap.hasPm ? String(snap.pm10) : String("null"));
    json += ",\"ok\":" + String(snap.hasPm ? "true" : "false");
    json += "}";
    json += "}";
    json += ",\"rssi\":" + String(snap.rssi);
    json += ",\"timestamp\":" + String(ts);
    json += "}";

    String auth = "?auth=" + _idToken;

    if (_dbClient == nullptr) {
      _failCount++;
      Serial.println("Firebase: khong tao duoc TLS client");
      continue;
    }

    String errBody;
    int code = httpRequest(*_dbClient, _host.c_str(), "POST",
                           "/sensorData.json" + auth + "&print=silent",
                           json, &errBody);
    if (code == 0) {
      // Loi ket noi/timeout: bo socket cu de lan sau connect lai sach.
      _dbClient->stop();
    }

    if (code >= 200 && code < 300) {
      _okCount++;
    } else {
      _failCount++;
      Serial.printf("Firebase: push loi HTTP %d (tong loi %lu)\n", code,
                    _failCount);
      if (errBody.length() > 0) {
        Serial.println("  body: " + errBody.substring(0, 200));
      }
      // 401/403: token het han hoac rules chan -> xoa de login lai
      if (code == 401 || code == 403 || _failCount % 5 == 0) {
        _idToken = "";
        _authed = false;
      }
    }
  }
}

// ====================== HTTP helpers (chi goi trong task phu) ======================

int FirebaseUploader::httpRequest(WiFiClientSecure &client, const char *host,
                                  const char *method, const String &path,
                                  const String &body, String *response) {
  // setTimeout cua WiFiClientSecure nhan GIAY, khong phai ms.
  // Chi connect lai khi socket da bi dong; neu con song thi tai su dung TLS.
  if (!client.connected()) {
    if (!client.connect(host, 443)) {
      return 0;
    }
  }
  client.setTimeout(2);

  client.printf("%s %s HTTP/1.1\r\n", method, path.c_str());
  client.printf("Host: %s\r\n", host);
  client.print("Content-Type: application/json\r\n");
  client.printf("Content-Length: %u\r\n", body.length());
  client.print("Connection: keep-alive\r\n\r\n");
  if (body.length() > 0 && client.print(body) != body.length()) {
    return 0;
  }

  const unsigned long deadline = millis() + 8000;
  while (!client.available() && client.connected() && millis() < deadline) {
    delay(1);
  }
  if (!client.available()) {
    return 0;
  }

  String statusLine = client.readStringUntil('\n');
  int code = 0;
  int sp1 = statusLine.indexOf(' ');
  if (sp1 > 0) {
    code = statusLine.substring(sp1 + 1, sp1 + 4).toInt();
  }

  int contentLength = 0;
  bool hasContentLength = false;
  bool connectionClose = false;
  while (millis() < deadline) {
    if (!client.available()) {
      if (!client.connected()) {
        break;
      }
      delay(1);
      continue;
    }
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) {
      break;
    }
    String lower = line;
    lower.toLowerCase();
    if (lower.startsWith("content-length:")) {
      contentLength = lower.substring(15).toInt();
      hasContentLength = true;
    } else if (lower.startsWith("connection:") && lower.indexOf("close") >= 0) {
      connectionClose = true;
    }
  }

  if (response != nullptr) {
    response->remove(0);
    if (hasContentLength && contentLength > 0) {
      unsigned long bodyDeadline = millis() + 2000;
      while ((int)response->length() < contentLength && millis() < bodyDeadline) {
        if (client.available()) {
          response->concat((char)client.read());
        } else {
          delay(1);
        }
      }
      if ((int)response->length() < contentLength) {
        return 0;
      }
    } else if (connectionClose) {
      while (client.connected() || client.available()) {
        if (client.available()) {
          response->concat((char)client.read());
        } else {
          delay(1);
        }
        if (millis() >= deadline) {
          break;
        }
      }
    }
  } else if (hasContentLength) {
    for (int i = 0; i < contentLength && millis() < deadline; ++i) {
      while (!client.available() && client.connected() && millis() < deadline) {
        delay(1);
      }
      if (client.available()) {
        client.read();
      }
    }
  }

  if (connectionClose) {
    client.stop();
  }
  return code;
}

// POST /v1/accounts:signUp?key=API_KEY  body {}
// -> idToken trong response JSON. Parse thu cong bang indexOf cho gon,
// khoi can keo ArduinoJson vao.
void FirebaseUploader::signInAnonymously() {
  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect(AUTH_HOST, 443)) {
    Serial.println("Firebase auth: khong ket noi duoc");
    return;
  }
  client.setTimeout(8); // giay; chi goi sau khi socket da mo

  String path = String("/v1/accounts:signUp?key=") + _apiKey;
  client.printf("POST %s HTTP/1.1\r\n", path.c_str());
  client.printf("Host: %s\r\n", AUTH_HOST);
  client.print("Content-Type: application/json\r\n");
  client.print("Content-Length: 2\r\n");
  client.print("Connection: close\r\n\r\n{}");

  unsigned long deadline = millis() + 8000;
  while (client.connected() && !client.available() && millis() < deadline) {
    delay(1);
  }
  String statusLine;
  if (client.available()) {
    statusLine = client.readStringUntil('\n');
  }
  while (client.connected() || client.available()) {
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) {
      break;
    }
  }
  String body = client.readString();
  client.stop();

  if (statusLine.indexOf(" 200") < 0) {
    Serial.printf("Firebase auth: loi (%s)\n", statusLine.c_str());
    return;
  }

  int p = body.indexOf("\"idToken\"");
  if (p < 0) {
    Serial.println("Firebase auth: response khong co idToken");
    return;
  }
  int q1 = body.indexOf('"', body.indexOf(':', p) + 1);
  int q2 = body.indexOf('"', q1 + 1);
  _idToken = body.substring(q1 + 1, q2);
  _authed = _idToken.length() > 0;
  Serial.printf("Firebase auth: dang nhap an danh %s\n",
                _authed ? "OK" : "that bai");
}
