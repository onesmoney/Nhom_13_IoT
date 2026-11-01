#ifndef DHT_SENSOR_H
#define DHT_SENSOR_H

#include <Arduino.h>

// Doc nhiet do, do am DHT11 theo chu ky millis(), mac dinh 2 giay.
// Tu doc 40 bit va kiem tra checksum; cho chuyen muc co timeout, khong khoa ngat.
// Moi lan do van co delay(20) va cho xung, khong hoan toan non-blocking.
class DhtSensor {
public:
  DhtSensor(uint8_t pin, unsigned long intervalMs = 2000);

  void begin();
  void handle(); // Goi trong loop(); chi doc khi du intervalMs.

  // Lan doc gan nhat hop le; neu doc loi, tra ve false va cac gia tri la NAN.
  bool hasReading() const { return _hasReading; }
  float temperature() const { return _temperature; } // do C
  float humidity() const { return _humidity; }       // do %

  // So ms tu lan doc thanh cong gan nhat; tra ve 0 khi khong co du lieu hop le.
  unsigned long dataAgeMs() const {
    return _hasReading ? millis() - _lastSuccessMs : 0;
  }

private:
  bool waitForEdge(int fromLevel, uint32_t timeoutUs);
  bool readRaw(uint8_t data[5]);
  void readNow();

  uint8_t _pin;
  unsigned long _intervalMs;
  unsigned long _lastRead;
  unsigned long _lastSuccessMs;
  bool _hasReading;
  float _temperature;
  float _humidity;
  int _failCount;
};

#endif // DHT_SENSOR_H
