#ifndef PMS7003_SENSOR_H
#define PMS7003_SENSOR_H

#include <Arduino.h>
#include <HardwareSerial.h>

// Doc bui min PMS7003 qua UART 9600 8N1; cam bien tu gui frame 32 byte.
// Cap nguon 5V (khong dung 3.3V), GND chung; TX cam bien -> RX17, RX -> TX16.
// Duong RX cua cam bien la tuy chon vi chuong trinh chi nhan, khong gui lenh.
// Kiem tra header 0x42 0x4D, do dai va checksum truoc khi cap nhat so do.
class Pms7003Sensor {
public:
  // staleMs: thoi gian khong nhan frame hop le de coi du lieu la cu.
  Pms7003Sensor(HardwareSerial &serial, int rxPin = 17, int txPin = 16,
                unsigned long staleMs = 10000);

  void begin();
  void handle(); // Goi trong loop(); chi xu ly cac byte UART dang co.

  // Da nhan it nhat mot frame hop le; dung isStale() de kiem tra do moi.
  bool hasReading() const { return _hasReading; }
  // Nong do PM1.0, PM2.5, PM10 trong khong khi (ug/m3), khong phai gia tri CF=1.
  uint16_t pm1_0() const { return _pm1_0; }
  uint16_t pm2_5() const { return _pm2_5; }
  uint16_t pm10() const { return _pm10; }

  // So ms tu frame hop le gan nhat; tra ve 0 neu chua co du lieu.
  unsigned long dataAgeMs() const {
    return _hasReading ? millis() - _lastOkMs : 0;
  }
  // Chi bao cu khi da co du lieu va qua staleMs khong nhan frame hop le moi.
  bool isStale() const { return _hasReading && dataAgeMs() > _staleMs; }
  // Dem ca byte cua frame loi; giup phan biet khong co tin hieu voi sai frame.
  unsigned long bytesReceived() const { return _bytesReceived; }

private:
  static const uint8_t FRAME_LEN = 32;

  void processByte(uint8_t b);
  void parseFrame();
  uint16_t readWord(uint8_t index) const {
    return ((uint16_t)_buf[index] << 8) | _buf[index + 1];
  }

  HardwareSerial &_serial;
  int _rxPin;
  int _txPin;
  unsigned long _staleMs;

  uint8_t _buf[FRAME_LEN];
  uint8_t _pos;
  bool _hasReading;
  unsigned long _lastOkMs;
  unsigned long _checksumErrors;
  unsigned long _bytesReceived;
  uint16_t _pm1_0;
  uint16_t _pm2_5;
  uint16_t _pm10;
};

#endif // PMS7003_SENSOR_H
