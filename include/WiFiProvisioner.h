#ifndef WIFI_PROVISIONER_H
#define WIFI_PROVISIONER_H

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include "StatusLed.h"

// Quan ly ket noi WiFi cua ESP32 theo 3 buoc:
//   1. Thu ket noi WiFi da luu trong NVS, toi da wifiTimeoutMs (30 giay dau kho dong)
//   2. Neu duoc cho phep thi bat SmartConfig trong smartConfigTimeoutMs (dung app ESP-Touch)
//   3. Khong chay/that bai SmartConfig thi mo AP tai http://192.168.4.1
class WiFiProvisioner {
public:
  WiFiProvisioner(const char *apSsid, const char *apPass,
                  unsigned long wifiTimeoutMs = 30000,
                  unsigned long smartConfigTimeoutMs = 30000,
                  unsigned long smartConfigConnectTimeoutMs = 20000,
                  unsigned long portalConnectTimeoutMs = 20000,
                  int statusLedPin = 2); // -1 de tat LED trang thai

  // Luon thu WiFi da luu truoc. SmartConfig chi chay khi allowSmartConfig=true
  // VA smartConfigPin >= 0 dang o muc HIGH; rut xuong LOW giua chung se HUY
  // SmartConfig ngay (khong cho het timeout) roi nhay sang AP portal.
  // Neu van chua co WiFi thi bat AP portal va tra ve false; khi do loop()
  // phai goi handle() lien tuc de phuc vu trang web cau hinh.
  bool begin(bool allowSmartConfig = true, int smartConfigPin = -1);

  // Phuc vu trang cau hinh khi portal dang bat (goi trong loop)
  void handle();

  bool isConnected() const;
  bool isPortalActive() const { return _portalActive; }
  bool isSmartConfigActive() const { return _smartConfigActive; }

  // Dang ky callback duoc goi dinh ky (~100ms) ngay CA TRONG cac vong cho
  // cua begin() va trong handle(). remainingSeconds >= 0 = dang dem nguoc
  // (cho WiFi cu / SmartConfig), -1 = khong co gi de dem (portal dang mo,
  // hoac trong loop binh thuong).
  typedef void (*ProgressCallback)(int remainingSeconds);
  void setProgressCallback(ProgressCallback cb) { _onProgress = cb; }

private:
  void progressTick(int remainingSeconds);
  bool waitConnected(unsigned long timeoutMs);
  void startPortal();
  void stopPortal();
  void handleRoot();
  void handleSave();
  void handleScan();    // API JSON: bat dau quet WiFi async / doc ket qua
  void stopScan();
  void handleCaptive(); // tra loi cac URL "kiem tra mang" cua he dieu hanh
  static String htmlEscape(const String &s);

  const char *_apSsid;
  const char *_apPass;
  unsigned long _wifiTimeoutMs;
  unsigned long _smartConfigTimeoutMs;
  unsigned long _smartConfigConnectTimeoutMs;
  unsigned long _portalConnectTimeoutMs;

  WebServer _server;
  DNSServer _dnsServer;
  bool _portalActive;
  bool _smartConfigActive;
  bool _scanActive;
  unsigned long _scanStartedMs;
  bool _portalAutoReconnect;
  StatusLed _led;
  ProgressCallback _onProgress;
};

#endif // WIFI_PROVISIONER_H
