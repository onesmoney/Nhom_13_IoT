#include "FirebaseUploader.h"
#include "LogTimestamp.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>

// REST API cua Identity Toolkit: dang nhap an danh -> tra ve idToken JWT.
// idToken dung lam ?auth=... tren Realtime Database REST, het han sau 1h
// thi dang nhap lai (refresh token khong can thiet cho do an - chi can
// sign-in lai khi 401/403).
static const char *AUTH_HOST = "identitytoolkit.googleapis.com";

static const char *wifiStatusName(wl_status_t status) {
  switch (status) {
  case WL_IDLE_STATUS: return "IDLE";
  case WL_NO_SSID_AVAIL: return "NO_SSID_AVAIL";
  case WL_SCAN_COMPLETED: return "SCAN_COMPLETED";
  case WL_CONNECTED: return "CONNECTED";
  case WL_CONNECT_FAILED: return "CONNECT_FAILED";
  case WL_CONNECTION_LOST: return "CONNECTION_LOST";
  case WL_DISCONNECTED: return "DISCONNECTED";
  default: return "UNKNOWN";
  }
}

// Chi doc trang thai hien tai; khong ping/DNS probe lam cham lan gui tiep theo.
static void logPostNetwork(uint32_t id, const char *kind, wl_status_t before,
                           unsigned long elapsedMs) {
  const wl_status_t now = WiFi.status();
  const String rssi = now == WL_CONNECTED ? String(WiFi.RSSI()) + "dBm" : "N/A";
  const String ip = WiFi.localIP().toString();
  const String gateway = WiFi.gatewayIP().toString();
  const String dns = WiFi.dnsIP().toString();
  Serial.printf("%s Firebase id=%lu kind=%s network wifi_before=%s(%d) wifi_after=%s(%d) "
                "RSSI=%s IP=%s gateway=%s DNS=%s request_ms=%lu "
                "heap_free=%u heap_min=%u heap_largest=%u\n",
                LogTimestamp().c_str(), static_cast<unsigned long>(id), kind,
                wifiStatusName(before), static_cast<int>(before),
                wifiStatusName(now), static_cast<int>(now), rssi.c_str(),
                ip.c_str(), gateway.c_str(), dns.c_str(), elapsedMs,
                ESP.getFreeHeap(), ESP.getMinFreeHeap(), ESP.getMaxAllocHeap());
}

namespace {
enum Stage { Connect, WriteHeaders, WriteBody, Wait, Status, Headers, Body, Token, StageCount };
const char *const stageNames[] = {"connect_dns_tcp_tls", "write_headers", "write_body",
                                "wait", "status", "headers", "body", "token_parse"};

// Never echo server-controlled strings, even truncated ones: auth bodies contain tokens.
const char *responseCategory(const String &body) {
  const char *const allowed[] = {"PERMISSION_DENIED", "Permission denied",
    "INVALID_ID_TOKEN", "TOKEN_EXPIRED", "API_KEY_INVALID", "OPERATION_NOT_ALLOWED",
    "TOO_MANY_ATTEMPTS_TRY_LATER", "CONFIGURATION_NOT_FOUND", "INVALID_API_KEY"};
  for (const char *category : allowed) {
    if (body.indexOf(category) >= 0) return category;
  }
  return body.length() ? "unclassified" : "empty";
}

// Bat lai khi can dieu tra tung request; mac dinh chi log loi/canh bao.
static constexpr bool FIREBASE_VERBOSE_LOG = false;

// Observations only: no connected() probes, retries, or changes to parsing/returns.
struct RequestTrace {
  uint32_t id;
  const char *kind;
  wl_status_t wifiBefore;
  uint32_t start, stageStart;
  Stage stage = Connect;
  uint32_t durations[StageCount] = {};
  size_t headerWritten = 0, headerExpected = 0, bodyWritten = 0, bodyExpected = 0;
  size_t statusRead = 0, headersRead = 0, bodyRead = 0;
  bool reused = false, headerShort = false, headersComplete = false, malformed = false;
  bool errorCaptured = false, readHeaders = false;
  int cachedConnectResult = 0;
  int httpStatus = 0;
  int responseExpected = -1;
  const char *reason = "unspecified";
  bool waitExpired = false;

  RequestTrace(uint32_t requestId, const char *requestKind)
      : id(requestId), kind(requestKind), wifiBefore(WiFi.status()),
        start(millis()), stageStart(start) {
    if (FIREBASE_VERBOSE_LOG) Serial.printf("%s Firebase id=%lu kind=%s start\n", LogTimestamp().c_str(),
                  static_cast<unsigned long>(id), kind);
  }
  void next(Stage nextStage) {
    const uint32_t now = millis();
    durations[stage] += FirebaseDiagnostics::elapsed(now, stageStart);
    stageStart = now;
    stage = nextStage;
    if (nextStage == Headers) readHeaders = true;
  }
  void wroteHeader(size_t written, size_t expected) {
    headerWritten += written;
    headerExpected += expected;
    headerShort |= written != expected;
  }
  void observeHeader(const String &line) {
    String lower = line;
    lower.toLowerCase();
    if (lower.startsWith("content-length:")) responseExpected = lower.substring(15).toInt();
    headersRead += line.length(); // excludes consumed LF; not a wire-byte count
    if (line == "\r") headersComplete = true;
    else if (line.length() == 0 || line.indexOf(':') <= 0 || !line.endsWith("\r"))
      malformed = true;
  }
  void capture(WiFiClientSecure &client) {
    if (errorCaptured) return;
    // Installed core caches connect's result, including a POSITIVE socket on success.
    // It is not updated for I/O; do not label positive values as errors or print text.
    char text[128] = {};
    cachedConnectResult = client.lastError(text, sizeof(text));
    errorCaptured = true;
  }
  void end(WiFiClientSecure *client, bool ok, const char *failure, const String &response) {
    next(stage);
    if (client) capture(*client); // caller must capture before any earlier stop()
    if (!ok && strcmp(reason, "unspecified") == 0) reason = failure;
    if (!FIREBASE_VERBOSE_LOG) {
      const bool unusual = headerShort || bodyWritten != bodyExpected || malformed ||
          (!headersComplete && readHeaders) ||
          (responseExpected >= 0 && bodyRead != static_cast<size_t>(responseExpected));
      if (!ok) {
        Serial.printf("%s [ERROR] Firebase %s #%lu HTTP=%d stage=%s reason=%s ms=%lu category=%s\n",
                      LogTimestamp().c_str(), kind, static_cast<unsigned long>(id), httpStatus,
                      failure, reason, static_cast<unsigned long>(FirebaseDiagnostics::elapsed(millis(), start)),
                      responseCategory(response));
        logPostNetwork(id, kind, wifiBefore, FirebaseDiagnostics::elapsed(millis(), start));
      } else if (unusual) {
        Serial.printf("%s [WARN] Firebase %s #%lu HTTP=%d phan hoi/ghi bat thuong: header_short=%d body_short=%d headers_complete=%d malformed=%d rx_body=%u/%d\n",
                      LogTimestamp().c_str(), kind, static_cast<unsigned long>(id), httpStatus,
                      headerShort, bodyWritten != bodyExpected, headersComplete, malformed,
                      static_cast<unsigned>(bodyRead), responseExpected);
      }
      return;
    }
    Serial.printf("%s Firebase id=%lu kind=%s detail reason=%s rx_body_expected=%d wait_deadline_reached=%d\n",
                  LogTimestamp().c_str(), static_cast<unsigned long>(id), kind,
                  ok ? "none" : reason, responseExpected, waitExpired);
    Serial.printf("%s Firebase id=%lu kind=%s end result=%s stage=%s http=%d "
                  "total_ms=%lu reused=%d tx_headers=%u/%u tx_body=%u/%u "
                  "rx_status_chars=%u rx_header_chars=%u rx_body=%u response_len=%u category=%s\n",
                  LogTimestamp().c_str(), static_cast<unsigned long>(id), kind,
                  ok ? "ok" : "fail", ok ? "done" : failure, httpStatus,
                  static_cast<unsigned long>(FirebaseDiagnostics::elapsed(millis(), start)), reused,
                  static_cast<unsigned>(headerWritten), static_cast<unsigned>(headerExpected),
                  static_cast<unsigned>(bodyWritten), static_cast<unsigned>(bodyExpected),
                  static_cast<unsigned>(statusRead), static_cast<unsigned>(headersRead),
                  static_cast<unsigned>(bodyRead), response.length(),
                  ok ? "none" : responseCategory(response));
    Serial.printf("%s Firebase id=%lu kind=%s stage_ms connect_dns_tcp_tls=%lu "
                  "write_headers=%lu write_body=%lu wait=%lu status=%lu headers=%lu body=%lu token_parse=%lu "
                  "cached_connect_result_possibly_stale=%d cached_connect_error=%d\n",
                  LogTimestamp().c_str(), static_cast<unsigned long>(id), kind,
                  static_cast<unsigned long>(durations[Connect]), static_cast<unsigned long>(durations[WriteHeaders]),
                  static_cast<unsigned long>(durations[WriteBody]), static_cast<unsigned long>(durations[Wait]),
                  static_cast<unsigned long>(durations[Status]), static_cast<unsigned long>(durations[Headers]),
                  static_cast<unsigned long>(durations[Body]), static_cast<unsigned long>(durations[Token]),
                  cachedConnectResult, cachedConnectResult < 0 ? cachedConnectResult : 0);
    if (responseExpected >= 0 && bodyRead != static_cast<size_t>(responseExpected)) {
      Serial.printf("%s Firebase id=%lu kind=%s warning response_body_length_mismatch=1 expected=%d received=%u parser_unchanged=1\n",
                    LogTimestamp().c_str(), static_cast<unsigned long>(id), kind,
                    responseExpected, static_cast<unsigned>(bodyRead));
    }
    if (headerShort || bodyWritten != bodyExpected || malformed || (!headersComplete && readHeaders)) {
      Serial.printf("%s Firebase id=%lu kind=%s warning header_write_short=%d body_write_short=%d "
                    "response_headers_complete=%d response_malformed=%d parser_unchanged=1\n",
                    LogTimestamp().c_str(), static_cast<unsigned long>(id), kind,
                    headerShort, bodyWritten != bodyExpected, headersComplete, malformed);
    }
    if (!ok) logPostNetwork(id, kind, wifiBefore, FirebaseDiagnostics::elapsed(millis(), start));
  }
};
} // namespace

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
  Serial.printf("%s Firebase: configured chu ky=%lums\n",
                LogTimestamp().c_str(), _pushIntervalMs);
}

// ====================== phia loop() - khong chan ======================

void FirebaseUploader::handle(bool hasDht, float temperature, float humidity,
                              bool hasLux, float lux, bool hasPm,
                              uint16_t pm1_0, uint16_t pm2_5, uint16_t pm10,
                              int rssi, bool dhtStale) {
  if (!_begun) return;
  if (WiFi.status() != WL_CONNECTED) {
    ++_handleSkipped;
    if (_handleOffline.due(millis(), 60000, true)) {
      Serial.printf("%s [WARN] Firebase offline snapshot skipped source=handle calls=%lu\n",
                    LogTimestamp().c_str(), static_cast<unsigned long>(_handleSkipped));
    }
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
    _pending.dhtStale = hasDht && dhtStale;
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

void FirebaseUploader::recordResult(const char *kind, FirebaseDiagnostics::Counters &stats, bool ok) {
  const uint32_t now = millis();
  const auto recovery = stats.record(ok, now);
  if (recovery.failures) {
    Serial.printf("%s [RECOVERED] Firebase kind=%s recovered streak=%lu since_first_error_ms=%lu\n",
                  LogTimestamp().c_str(), kind, static_cast<unsigned long>(recovery.failures),
                  static_cast<unsigned long>(recovery.elapsedMs));
  } else if (!ok && FIREBASE_VERBOSE_LOG) {
    Serial.printf("%s Firebase kind=%s failure streak=%lu since_first_error_ms=%lu\n",
                  LogTimestamp().c_str(), kind, static_cast<unsigned long>(stats.streak),
                  static_cast<unsigned long>(FirebaseDiagnostics::elapsed(now, stats.firstError)));
  }
}

void FirebaseUploader::logSummary() {
  const uint32_t now = millis();
  if (!_summaryInterval.due(now, 60000)) return;
  const String postAge = _postStats.hasSuccess
      ? String(FirebaseDiagnostics::elapsed(now, _postStats.lastSuccess)) : String("never");
  const String authAge = _authStats.hasSuccess
      ? String(FirebaseDiagnostics::elapsed(now, _authStats.lastSuccess)) : String("never");
  Serial.printf("%s [SUMMARY] Firebase post_ok=%lu post_fail=%lu post_streak=%lu "
                "auth_ok=%lu auth_fail=%lu auth_streak=%lu post_last_success_age_ms=%s "
                "auth_last_success_age_ms=%s worker_offline_skipped=%lu\n",
                LogTimestamp().c_str(), static_cast<unsigned long>(_postStats.successes),
                static_cast<unsigned long>(_postStats.failures), static_cast<unsigned long>(_postStats.streak),
                static_cast<unsigned long>(_authStats.successes), static_cast<unsigned long>(_authStats.failures),
                static_cast<unsigned long>(_authStats.streak), postAge.c_str(), authAge.c_str(),
                static_cast<unsigned long>(_workerSkipped));
}

void FirebaseUploader::networkLoop() {
  SensorReading snap;
  for (;;) {
    logSummary(); // Also runs while idle; blocking requests can delay a summary.
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
      ++_workerSkipped;
      if (_workerOffline.due(millis(), 60000, true)) {
        Serial.printf("%s [WARN] Firebase offline snapshot skipped source=worker count=%lu\n",
                      LogTimestamp().c_str(), static_cast<unsigned long>(_workerSkipped));
      }
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
      RequestTrace trace(++_requestId, "POST");
      trace.end(nullptr, false, "client_allocation", String());
      _failCount++;
      recordResult("POST", _postStats, false);
      continue;
    }

    if (snap.hasDht && snap.dhtStale) {
      Serial.printf("%s Firebase: dang POST du lieu DHT11 cu (T=%.1fC, H=%.1f%%)\n",
                    LogTimestamp().c_str(), snap.temperature, snap.humidity);
    }
    String errBody;
    int code = httpRequest(*_dbClient, _host.c_str(), "POST",
                           "/sensorData.json" + auth + "&print=silent",
                           json, &errBody);
    recordResult("POST", _postStats, code >= 200 && code < 300);
    if (code == 0) {
      // Loi ket noi/timeout: bo socket cu de lan sau connect lai sach.
      _dbClient->stop();
    }

    if (code >= 200 && code < 300) {
      _okCount++;
    } else {
      _failCount++;
      const LogTimestamp stamp;
      if (FIREBASE_VERBOSE_LOG) Serial.printf("%s Firebase: push loi HTTP %d (tong loi %lu)\n",
                    stamp.c_str(), code, _failCount);
      // 401/403: token het han hoac rules chan -> xoa de login lai
      if (code == 401 || code == 403 || _failCount % 5 == 0) {
        _authReason = code == 401 ? "http_401" : code == 403 ? "http_403" : "every_fifth_cumulative_post_failure";
        Serial.printf("%s Firebase reauth scheduled reason=%s\n", LogTimestamp().c_str(), _authReason);
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
  RequestTrace trace(++_requestId, "POST");
  auto finish = [&](int code, const char *failure) {
    trace.bodyRead = response ? response->length() : trace.bodyRead;
    trace.end(&client, code >= 200 && code < 300, failure, response ? *response : String());
    return code;
  };
  // setTimeout cua WiFiClientSecure nhan GIAY, khong phai ms.
  // Chi connect lai khi socket da bi dong; neu con song thi tai su dung TLS.
  if (!client.connected()) {
    if (!client.connect(host, 443)) {
      return finish(0, stageNames[Connect]);
    }
  } else {
    trace.reused = true;
  }
  client.setTimeout(2);

  trace.next(WriteHeaders);
  trace.wroteHeader(client.printf("%s %s HTTP/1.1\r\n", method, path.c_str()),
                    strlen(method) + path.length() + 12);
  trace.wroteHeader(client.printf("Host: %s\r\n", host), strlen(host) + 8);
  trace.wroteHeader(client.print("Content-Type: application/json\r\n"), sizeof("Content-Type: application/json\r\n") - 1);
  trace.wroteHeader(client.printf("Content-Length: %u\r\n", body.length()),
                    18 + String(body.length()).length());
  trace.wroteHeader(client.print("Connection: keep-alive\r\n\r\n"), sizeof("Connection: keep-alive\r\n\r\n") - 1);
  trace.next(WriteBody);
  trace.bodyExpected = body.length();
  if (body.length() > 0 && (trace.bodyWritten = client.print(body)) != body.length()) {
    return finish(0, stageNames[WriteBody]);
  }

  trace.next(Wait);
  const unsigned long deadline = millis() + 8000;
  while (!client.available() && client.connected() && millis() < deadline) {
    delay(1);
  }
  if (!client.available()) {
    trace.waitExpired = millis() >= deadline;
    trace.reason = trace.waitExpired ? "no_response_deadline" : "connection_ended_before_response";
    return finish(0, trace.headerShort ? stageNames[WriteHeaders] : stageNames[Wait]);
  }

  trace.next(Status);
  String statusLine = client.readStringUntil('\n');
  trace.statusRead = statusLine.length();
  int code = 0;
  int sp1 = statusLine.indexOf(' ');
  if (sp1 > 0) {
    code = statusLine.substring(sp1 + 1, sp1 + 4).toInt();
  }

  trace.httpStatus = code;
  trace.malformed = code == 0 || !statusLine.startsWith("HTTP/") || !statusLine.endsWith("\r");
  trace.next(Headers);
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
    trace.observeHeader(line);
    if (line == "\r" || line.length() == 0) {
      break;
    }
    String lower = line;
    lower.toLowerCase();
    if (lower.startsWith("content-length:")) {
      contentLength = lower.substring(15).toInt();
      trace.responseExpected = contentLength;
      hasContentLength = true;
    } else if (lower.startsWith("connection:") && lower.indexOf("close") >= 0) {
      connectionClose = true;
    }
  }

  trace.next(Body);
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
        trace.reason = "response_body_incomplete_deadline";
        return finish(0, stageNames[Body]);
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
        ++trace.bodyRead;
      }
    }
  }

  trace.capture(client);
  if (connectionClose) {
    client.stop();
  }
  return finish(code, trace.headerShort ? stageNames[WriteHeaders] :
                code == 0 ? stageNames[Status] : !trace.headersComplete ? stageNames[Headers] : "http_status");
}

// POST /v1/accounts:signUp?key=API_KEY  body {}
// -> idToken trong response JSON. Parse thu cong bang indexOf cho gon,
// khoi can keo ArduinoJson vao.
void FirebaseUploader::signInAnonymously() {
  RequestTrace trace(++_requestId, "AUTH");
  if (FIREBASE_VERBOSE_LOG) Serial.printf("%s Firebase id=%lu kind=AUTH reason=%s previous_auth_streak=%lu\n",
                LogTimestamp().c_str(), static_cast<unsigned long>(_requestId), _authReason,
                static_cast<unsigned long>(_authStats.streak));
  WiFiClientSecure client;
  client.setInsecure();
  auto finish = [&](bool ok, const char *failure, const String &body) {
    trace.end(&client, ok, failure, body);
    recordResult("AUTH", _authStats, ok);
    if (!ok) _authReason = "retry_after_auth_failure";
  };

  if (!client.connect(AUTH_HOST, 443)) {
    finish(false, stageNames[Connect], String());
    return;
  }
  client.setTimeout(8); // giay; chi goi sau khi socket da mo

  String path = String("/v1/accounts:signUp?key=") + _apiKey;
  trace.next(WriteHeaders);
  trace.wroteHeader(client.printf("POST %s HTTP/1.1\r\n", path.c_str()), path.length() + 16);
  trace.wroteHeader(client.printf("Host: %s\r\n", AUTH_HOST), strlen(AUTH_HOST) + 8);
  trace.wroteHeader(client.print("Content-Type: application/json\r\n"), sizeof("Content-Type: application/json\r\n") - 1);
  trace.wroteHeader(client.print("Content-Length: 2\r\n"), 19);
  // Preserve the original single combined header/body write and attribute its
  // time to write_body; accepted byte counts split at the header boundary.
  trace.next(WriteBody);
  const size_t combinedWritten = client.print("Connection: close\r\n\r\n{}");
  trace.wroteHeader(combinedWritten < 21 ? combinedWritten : 21, 21);
  trace.bodyExpected = 2;
  trace.bodyWritten = combinedWritten > 21 ? combinedWritten - 21 : 0;

  trace.next(Wait);
  unsigned long deadline = millis() + 8000;
  while (client.connected() && !client.available() && millis() < deadline) {
    delay(1);
  }
  trace.waitExpired = millis() >= deadline;
  trace.next(Status);
  String statusLine;
  bool hadStatus = false;
  if (client.available()) {
    hadStatus = true;
    statusLine = client.readStringUntil('\n');
  }
  trace.statusRead = statusLine.length();
  const int sp = statusLine.indexOf(' ');
  trace.httpStatus = sp > 0 ? statusLine.substring(sp + 1, sp + 4).toInt() : 0;
  trace.malformed = !statusLine.startsWith("HTTP/") || !statusLine.endsWith("\r");
  trace.next(Headers);
  while (client.connected() || client.available()) {
    String line = client.readStringUntil('\n');
    trace.observeHeader(line);
    if (line == "\r" || line.length() == 0) {
      break;
    }
  }
  trace.next(Body);
  String body = client.readString();
  trace.bodyRead = body.length();
  trace.capture(client); // lastError must be captured before application stop().
  client.stop();

  if (statusLine.indexOf(" 200") < 0) {
    if (!hadStatus) trace.reason = trace.waitExpired ? "no_response_deadline" : "no_status_received";
    const char *failure = trace.headerShort ? stageNames[WriteHeaders] :
        trace.bodyWritten != trace.bodyExpected ? stageNames[WriteBody] :
        !hadStatus ? stageNames[Wait] : trace.httpStatus == 0 ? stageNames[Status] :
        !trace.headersComplete ? stageNames[Headers] : "http_status";
    finish(false, failure, body);
    return;
  }

  trace.next(Token);
  int p = body.indexOf("\"idToken\"");
  if (p < 0) {
    finish(false, body.length() == 0 ? stageNames[Body] : stageNames[Token], body);
    return;
  }
  int q1 = body.indexOf('"', body.indexOf(':', p) + 1);
  int q2 = body.indexOf('"', q1 + 1);
  _idToken = body.substring(q1 + 1, q2);
  _authed = _idToken.length() > 0;
  finish(_authed, stageNames[Token], body);
}
