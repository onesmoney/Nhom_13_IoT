#ifndef FIREBASE_UPLOADER_H
#define FIREBASE_UPLOADER_H

#include <Arduino.h>
#include "FirebaseDiagnostics.h"
#include "OfflineQueue.h"

class WiFiClientSecure;

// Ghi LittleFS truoc khi gui HTTPS; PATCH bang push ID co dinh, ACK sau 2xx.
// Can bat Anonymous Auth va cau hinh rules chi cho phep truy cap can thiet.
// Moi ban ghi gom deviceName, location, sensors, RSSI va timestamp (epoch giay).
// Task mang xu ly dang nhap/gui; loop() chi cap nhat ban du lieu cho gui.
class FirebaseUploader {
public:
  FirebaseUploader(const char *apiKey, const char *databaseUrl,
                   const char *deviceName, const char *location,
                   unsigned long pushIntervalMs = 5000);

  // Goi mot lan trong setup() de tao task mang va TLS client.
  void begin();

  // Dat ten truoc khi begin(), vi du dung MAC ESP32 de phan biet thiet bi.
  void setDeviceName(const String &deviceName) { _deviceName = deviceName; }

  // Goi ca khi offline. Cache theo chu ky co dinh de gioi han duoc X phut.
  void handle(bool hasDht, float temperature, float humidity,
              bool hasLux, float lux, bool hasPm, uint16_t pm1_0,
              uint16_t pm2_5, uint16_t pm10, int rssi, bool dhtStale);

  // Trang thai dang nhap, khong dam bao ket noi mang hay gui thanh cong.
  bool isReady() const { return _authed; }
  // Moc millis() lan lay mau/thu ghi cache, khong phai luc gui thanh cong.
  unsigned long lastPushMs() const { return _lastPush; }
  unsigned long successCount() const { return _okCount; }
  unsigned long failCount() const { return _failCount; }

private:
  // Task tren core 0: peek journal, dang nhap, PATCH, roi checkpoint ACK.
  static void networkTask(void *arg);
  void networkLoop();
  void signInAnonymously();
  void recordResult(const char *kind, FirebaseDiagnostics::Counters &stats, bool ok);
  void logSummary();
  // Worker-owned request counters; storage counters are protected by _mutex.
  FirebaseDiagnostics::Counters _postStats, _authStats;
  FirebaseDiagnostics::Interval _summaryInterval;
  uint32_t _requestId = 0;
  const char *_authReason = "initial_no_token";
  int httpRequest(WiFiClientSecure &client, const char *host,
                  const char *method, const String &path,
                  const String &body, String *response);

  using SensorReading = CachedReading;

  const char *_apiKey;
  const char *_databaseUrl;
  String _deviceName;
  const char *_location;
  unsigned long _pushIntervalMs;
  // Theo doi ban da nap va trang thai hop le de quyet dinh lan nap tiep theo.
  bool _hasQueued;

  String _host;
  String _idToken;

  // Mutex chi bao ve LittleFS/checkpoint, khong bao gio giu khi goi mang.
  OfflineQueue *_queue = nullptr;
  uint32_t _bootId = 0;
  uint32_t _cacheWriteFailures = 0;
  uint64_t _replayFrom = 0;
  SemaphoreHandle_t _mutex;

  volatile unsigned long _lastPush;
  volatile unsigned long _okCount;
  volatile unsigned long _failCount;
  bool _begun;
  volatile bool _authed;
  WiFiClientSecure *_dbClient;
};

#endif // FIREBASE_UPLOADER_H
