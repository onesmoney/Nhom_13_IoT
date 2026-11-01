#include <Arduino.h>
#include <WiFiProvisioner.h>
#include "DhtSensor.h"
#include "Bh1750Sensor.h"
#include "Pms7003Sensor.h"
#include "StatusDisplay.h"
#include "ClockTime.h"
#include "FirebaseUploader.h"

// Cau hinh AP: ten + mat khau (toi thieu 8 ky tu) khi mo trang cau hinh WiFi.
// LED trang thai mac dinh o GPIO 2 (LED tren board ESP32 DevKit);
// truyen -1 lam tham so cuoi de tat LED, hoac doi chan khac.
WiFiProvisioner provisioner("Nhom13_IoT_Setup", "12345678");

// Cap 3.3V vao GPIO32 luc khoi dong/reset de cho phep SmartConfig.
// INPUT_PULLDOWN giu chan o LOW khi khong cap dien ap.
const uint8_t SMARTCONFIG_TRIGGER_PIN = 32;

// DHT11: DATA cai o D4 (GPIO 4)
const uint8_t DHT_PIN = 4;
DhtSensor dhtSensor(DHT_PIN);

// Cam bien BH1750 I2C 5 chan: SDA=GPIO21, SCL=GPIO22, ADDR de ho/noi GND -> 0x23
Bh1750Sensor bh1750(0x23, 21, 22, 1000);

// Cam bien bui PMS7003 qua UART2: PMS TX -> GPIO16, PMS RX -> GPIO17 (tuy
// chon), VCC -> 5V/VIN, GND chung. Khong dung chung chan voi BH1750/OLED.
Pms7003Sensor pms7003(Serial2, 16, 17);

// Man hinh OLED I2C 1.3 inch (128x64, SH1106, dia chi 0x3C), chung bus I2C
// voi BH1750: SDA=GPIO21, SCL=GPIO22
StatusDisplay oled(21, 22, 0x3C);

// Dong ho lay gio tu NTP (GMT+7), chi chay duoc khi da co WiFi
ClockTime clockTime(7 * 3600);

const bool FIREBASE_UPLOAD_ENABLED = true;

// Firebase Realtime Database: day du lieu cam bien len cloud moi 5s.
// Can bat Anonymous sign-in trong Authentication tren Firebase Console.
// Moi ban ghi duoc append vao nhanh sensorData chung; deviceName la MAC
// cua ESP32 de phan biet cac thiet bi.
FirebaseUploader firebase(
    "AIzaSyDUAf2shvLwkoB-b2o_EU-bD_wi27LyhsU",
    "https://iot-ptit-13-default-rtdb.asia-southeast1.firebasedatabase.app",
    "ESP32 Node 13",    // deviceName tam, se thay bang MAC trong setup()
    "Lab IoT",          // location: vi tri dat thiet bi
    5000);              // POST /sensorData moi 5 giay

unsigned long lastPortalPrint = 0;
unsigned long connectedAt = 0;   // thoi diem bat dau ket noi WiFi
const unsigned long IP_SHOW_MS = 5000; // hien IP 5 giay roi chuyen sang dong ho

// Callback gan vao WiFiProvisioner: chay ~100ms/lan ngay ca khi begin()
// dang cho, nen OLED cap nhat trang thai trong suot qua trinh ket noi.
// remainingSeconds >= 0 khi dang dem nguoc (WiFi cu / SmartConfig) -> hien
// so giay con lai + thanh progress; -1 khi portal mo hoac da ket noi.
void buildClimateLines(String &line1, String &line2);

void oledProgress(int remainingSeconds) {
  if (!oled.isReady() || oled.isPaused()) {
    return;
  }
  if (provisioner.isConnected()) {
    // Da online: ghi nhan thoi diem ket noi. Chi ve man INFO trong 3s dau;
    // sau do oledUpdateSensors() lo man hinh dong ho, khong de ham nay
    // ve ONLINE nua (tranh 2 màn thay nhau -> nhay).
    if (connectedAt == 0) {
      connectedAt = millis();
    }
    if (millis() - connectedAt < IP_SHOW_MS) {
      oled.update(StatusDisplay::WIFI_ONLINE, WiFi.SSID(), WiFi.RSSI(),
                  WiFi.localIP().toString());
    }
  } else {
    connectedAt = 0;
    StatusDisplay::WifiMode mode;
    String ssid;
    String ip;
    if (provisioner.isPortalActive()) {
      mode = StatusDisplay::WIFI_PORTAL;
      ssid = "Nhom13_IoT_Setup";
      ip = "192.168.4.1";
    } else if (provisioner.isSmartConfigActive()) {
      mode = StatusDisplay::WIFI_SMARTCONFIG;
    } else {
      mode = StatusDisplay::WIFI_CONNECTING;
    }
    String line1;
    String line2;
    buildClimateLines(line1, line2);
    oled.update(mode, ssid, 0, ip, &line1, &line2, remainingSeconds);
  }
}

// Hai dong duoi: nhiet do/do am (DHT11) + anh sang (BH1750).
void buildClimateLines(String &line1, String &line2) {
  if (dhtSensor.hasReading()) {
    line1 = "ND:" + String(dhtSensor.temperature(), 1) + "C DA:" +
            String(dhtSensor.humidity(), 0) + "%";
    if (dhtSensor.dataAgeMs() > 5000) {
      line1 = "DHT: du lieu cu";
    }
  } else {
    line1 = "ND:--C DA:--%";
  }
  if (bh1750.isReady() && bh1750.hasReading()) {
    line2 = "AS:" + String(bh1750.lux(), 0) + " lux";
  } else {
    line2 = bh1750.isReady() ? "BH1750: cho du lieu" : "BH1750: loi day";
  }
}

// Hai dong giua trong che do dong ho: bui min PMS7003 (ug/m3).
void buildPmLines(String &line1, String &line2) {
  if (!pms7003.hasReading()) {
    line1 = "PMS7003: cho du lieu";
    line2 = "";
  } else if (pms7003.isStale()) {
    line1 = "PMS7003: du lieu cu";
    line2 = "Kiem tra day/nguon 5V";
  } else {
    line1 = "PM1:" + String(pms7003.pm1_0()) + " PM2.5:" +
            String(pms7003.pm2_5());
    if (line1.length() > 21) {
      line1.replace(" PM2.5:", "PM2.5:");
    }
    line2 = "PM10:" + String(pms7003.pm10()) + " ug/m3";
  }
}

// 3 giay dau giu man hinh IP; sau do hien dong ho va ca 4 dong cam bien.
// StatusDisplay tu loc thay doi de tranh gui lai buffer khi noi dung khong doi.
void oledUpdateSensors() {
  if (!oled.isReady() || oled.isPaused()) {
    return;
  }
  String line1;
  String line2;
  String pmLine1;
  String pmLine2;
  buildClimateLines(line1, line2);
  buildPmLines(pmLine1, pmLine2);

  // Trong 3s dau sau ket noi: van hien man INFO, chi thay 2 dong duoi
  if (millis() - connectedAt < IP_SHOW_MS) {
    oled.update(StatusDisplay::WIFI_ONLINE, WiFi.SSID(), WiFi.RSSI(),
                WiFi.localIP().toString(), &line1, &line2);
    return;
  }

  // Qua 3s: man hinh dong ho. Gio lay moi lan, chi day len man hinh khi phut
  // hoac giay doi (dau ":" nhay theo giay) -> nhay dung 1s moi nhay.
  char timeBuf[8];
  char dateBuf[8];
  clockTime.getTime(timeBuf, sizeof(timeBuf)); // "HH:MM"
  clockTime.getDate(dateBuf, sizeof(dateBuf)); // "DD/MM"
  struct tm t;
  int blinkSec = getLocalTime(&t, 50) ? t.tm_sec : -1;

  oled.update(StatusDisplay::WIFI_CLOCK, WiFi.SSID(), WiFi.RSSI(),
              WiFi.localIP().toString(), &line1, &line2, -1,
              timeBuf, dateBuf, blinkSec, &pmLine1, &pmLine2);
}

void pauseOled() {
  provisioner.setProgressCallback(nullptr);
  oled.pause();
}

void resumeOled() {
  if (!oled.isPaused()) {
    return;
  }
  oled.resume();
  connectedAt = 0;
  provisioner.setProgressCallback(oledProgress);
  oledProgress(-1);
}

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 khoi dong thanh cong!");

  // Dung dia chi MAC phan cung lam deviceName trong moi payload Firebase.
  // WiFi.macAddress() doc duoc truoc khi ket noi WiFi va tra ve dang AA:BB:CC:DD:EE:FF.
  const String deviceMac = WiFi.macAddress();
  firebase.setDeviceName(deviceMac);
  Serial.println("Firebase deviceName (MAC): " + deviceMac);

  pinMode(SMARTCONFIG_TRIGGER_PIN, INPUT_PULLDOWN);
  const bool allowSmartConfig = digitalRead(SMARTCONFIG_TRIGGER_PIN) == HIGH;
  Serial.printf("GPIO%d=%s -> SmartConfig %s neu WiFi da luu ket noi that bai.\n",
                SMARTCONFIG_TRIGGER_PIN, allowSmartConfig ? "HIGH" : "LOW",
                allowSmartConfig ? "DUOC BAT" : "BI BO QUA");

  dhtSensor.begin();
  pms7003.begin();     // UART2 9600 baud, RX=GPIO16, TX=GPIO17
  bh1750.begin();      // mo Wire(21,22) mot lan cho chung bus I2C
  oled.begin();        // dung lai bus do, dia chi 0x3C
  clockTime.begin();   // dong bo NTP, se lay gio khi WiFi ket noi
  // Bat OLED ngay tu dau de hien trang thai ket noi, SmartConfig va AP portal.
  // Khong pause trong qua trinh provisioning; callback se cap nhat man hinh.
  provisioner.setProgressCallback(oledProgress);
  oledProgress(-1);

  if (FIREBASE_UPLOAD_ENABLED) {
    firebase.begin();
  } else {
    Serial.println("Firebase: tam dung gui du lieu.");
  }

  // Luon thu WiFi da luu truoc; SmartConfig chi chay khi GPIO32 da HIGH luc
  // boot, va se bi HUY ngay neu rut GPIO32 xuong LOW giua chung.
  provisioner.begin(allowSmartConfig, SMARTCONFIG_TRIGGER_PIN);
  oledProgress(-1);
}

void loop() {
  provisioner.handle(); // ben trong da goi oledProgress() dinh ky
  dhtSensor.handle();
  bh1750.handle();
  pms7003.handle();    // chi doc byte co san trong buffer UART, khong chan
  clockTime.handle();  // sync lai NTP moi 1 gio

  if (provisioner.isConnected()) {
    if (!oled.isPaused()) {
      oledUpdateSensors();
    }
    if (FIREBASE_UPLOAD_ENABLED) {
      firebase.handle(dhtSensor.hasReading(), dhtSensor.temperature(),
                      dhtSensor.humidity(), bh1750.hasReading(),
                      bh1750.lux(), pms7003.hasReading() && !pms7003.isStale(),
                      pms7003.pm1_0(),
                      pms7003.pm2_5(), pms7003.pm10(), WiFi.RSSI());
    }
  } else if (provisioner.isPortalActive()) {
    if (millis() - lastPortalPrint >= 5000) {
      lastPortalPrint = millis();
      Serial.println("Dang cho cau hinh: ket noi WiFi 'Nhom13_IoT_Setup' roi mo http://192.168.4.1");
    }
  }
}
