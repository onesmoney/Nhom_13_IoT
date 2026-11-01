#ifndef BH1750_SENSOR_H
#define BH1750_SENSOR_H

#include <Arduino.h>
#include <BH1750.h>
#include <Wire.h>

// Doc module cam bien anh sang BH1750 qua I2C, tra ve do roi (lux).
// Dau noi mac dinh ESP32: SDA -> GPIO 21, SCL -> GPIO 22, VCC -> 3.3V, GND -> GND.
// Chan ADDR: de trong hoac noi GND -> dia chi 0x23; noi 3.3V -> dia chi 0x5C.
// Doc dinh ky khong chan (dung millis()).
class Bh1750Sensor {
public:
  Bh1750Sensor(uint8_t address = 0x23, int sdaPin = 21, int sclPin = 22,
               unsigned long intervalMs = 1000);

  bool begin();   // tra ve false neu khong tim thay module tren bus I2C
  void handle();  // goi lien tuc trong loop()

  bool isReady() const { return _ready; }
  bool hasReading() const { return _hasReading; }
  float lux() const { return _lux; }
  unsigned long dataAgeMs() const { return millis() - _lastOk; }

private:
  bool connect();
  void readNow();

  static const unsigned long RETRY_MS = 2000;

  BH1750 _sensor;
  uint8_t _address;
  int _sdaPin;
  int _sclPin;
  unsigned long _intervalMs;
  unsigned long _lastRead;
  unsigned long _lastOk;
  unsigned long _lastConnect;
  bool _ready;
  bool _hasReading;
  float _lux;
};

#endif // BH1750_SENSOR_H
