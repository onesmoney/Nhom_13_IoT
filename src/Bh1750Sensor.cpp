#include "Bh1750Sensor.h"

Bh1750Sensor::Bh1750Sensor(uint8_t address, int sdaPin, int sclPin,
                           unsigned long intervalMs)
    : _sensor(address), _address(address), _sdaPin(sdaPin), _sclPin(sclPin),
      _intervalMs(intervalMs), _lastRead(0), _lastOk(0), _lastConnect(0),
      _ready(false), _hasReading(false), _lux(NAN) {}

bool Bh1750Sensor::begin() {
  Serial.printf("Khoi tao BH1750: I2C dia chi 0x%02X, SDA=GPIO %d (<-> BH1750 SDA), "
                "SCL=GPIO %d (-> BH1750 SCL), VCC=3.3V, GND=GND\n",
                _address, _sdaPin, _sclPin);
  Serial.println("BH1750 ADDR: de ho hoac noi GND -> 0x23; noi 3.3V -> 0x5C");
  Wire.begin(_sdaPin, _sclPin);
  if (!connect()) {
    Serial.printf("Khong tim thay BH1750 o dia chi 0x%02X (kiem tra day SDA/SCL/ADDR); "
                  "tu thu lai moi 2 giay\n", _address);
  }
  return _ready;
}

bool Bh1750Sensor::connect() {
  _lastConnect = millis();
  _ready = false;
  _hasReading = false;
  _lux = NAN;
  Wire.beginTransmission(_address);
  if (Wire.endTransmission() != 0) {
    return false;
  }
  // Chi cau hinh cam bien; khong khoi dong lai bus I2C chung voi OLED.
  _ready = _sensor.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, _address, &Wire);
  _lastRead = millis();
  if (_ready) {
    Serial.printf("Khoi tao BH1750 OK: dia chi 0x%02X, SDA=GPIO %d, SCL=GPIO %d\n",
                  _address, _sdaPin, _sclPin);
  }
  return _ready;
}

void Bh1750Sensor::handle() {
  if (!_ready) {
    if (millis() - _lastConnect >= RETRY_MS) {
      connect();
    }
    return;
  }
  if (millis() - _lastRead >= _intervalMs) {
    readNow();
  }
}

void Bh1750Sensor::readNow() {
  _lastRead = millis();
  if (!_sensor.measurementReady(true)) {
    return;
  }
  float value = _sensor.readLightLevel();
  if (!isfinite(value) || value < 0) {
    _ready = false;
    _hasReading = false;
    _lux = NAN;
    _lastConnect = millis();
    Serial.println("BH1750: mat ket noi/doc loi; xoa du lieu, tu thu lai moi 2 giay");
    return;
  }
  _lux = value;
  _hasReading = true;
  _lastOk = millis();
}
