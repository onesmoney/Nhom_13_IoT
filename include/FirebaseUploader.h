#ifndef FIREBASE_UPLOADER_H
#define FIREBASE_UPLOADER_H

#include <Arduino.h>

class WiFiClientSecure;

// Gui du lieu cam bien qua HTTPS REST vao /sensorData/<pushId>.
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

  // Goi trong loop(); nap du lieu khi du chu ky hoac trang thai hop le thay doi.
  // Chi nap khi co WiFi; co has* = false thi gui ok=false va gia tri null.
  void handle(bool hasDht, float temperature, float humidity,
              bool hasLux, float lux, bool hasPm, uint16_t pm1_0,
              uint16_t pm2_5, uint16_t pm10, int rssi);

  // Trang thai dang nhap, khong dam bao ket noi mang hay gui thanh cong.
  bool isReady() const { return _authed; }
  // Moc millis() lan nap du lieu cho gui gan nhat, khong phai luc gui thanh cong.
  unsigned long lastPushMs() const { return _lastPush; }
  unsigned long successCount() const { return _okCount; }
  unsigned long failCount() const { return _failCount; }

private:
  // Task tren core 0: lay du lieu, dang nhap, tao JSON va POST len Firebase.
  static void networkTask(void *arg);
  void networkLoop();
  void signInAnonymously();
  int httpRequest(WiFiClientSecure &client, const char *host,
                  const char *method, const String &path,
                  const String &body, String *response);

  struct SensorReading {
    bool hasDht;
    float temperature;
    float humidity;
    bool hasLux;
    float lux;
    bool hasPm;
    uint16_t pm1_0;
    uint16_t pm2_5;
    uint16_t pm10;
    int rssi;
  };

  const char *_apiKey;
  const char *_databaseUrl;
  String _deviceName;
  const char *_location;
  unsigned long _pushIntervalMs;
  // Theo doi ban da nap va trang thai hop le de quyet dinh lan nap tiep theo.
  bool _hasQueued;
  uint8_t _lastQueuedValidity;

  String _host;
  String _idToken;

  // Chi giu mot ban cho gui, ban moi ghi de ban cu; khong luu du moi mau khi mat mang.
  // Mutex bao ve du lieu dung chung giua loop() va task mang.
  SensorReading _pending;
  volatile bool _hasPending;
  SemaphoreHandle_t _mutex;

  volatile unsigned long _lastPush;
  volatile unsigned long _okCount;
  volatile unsigned long _failCount;
  bool _begun;
  volatile bool _authed;
  WiFiClientSecure *_dbClient;
};

#endif // FIREBASE_UPLOADER_H
