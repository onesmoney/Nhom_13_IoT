#include "Pms7003Sensor.h"

Pms7003Sensor::Pms7003Sensor(HardwareSerial &serial, int rxPin, int txPin,
                             unsigned long staleMs)
    : _serial(serial), _rxPin(rxPin), _txPin(txPin), _staleMs(staleMs),
      _pos(0), _hasReading(false), _lastOkMs(0), _checksumErrors(0),
      _bytesReceived(0), _pm1_0(0), _pm2_5(0), _pm10(0) {}

void Pms7003Sensor::begin() {
  _serial.begin(9600, SERIAL_8N1, _rxPin, _txPin);
  // Luc gan chan RX, UART co the nhan 1 byte rac -> bo di de bytesReceived()
  // chi dem byte that su den tu cam bien.
  delay(10);
  while (_serial.available() > 0) {
    _serial.read();
  }
  Serial.printf("Khoi tao PMS7003: UART 9600 baud, RX=GPIO %d (<- PMS TX), "
                "TX=GPIO %d (-> PMS RX)\n",
                _rxPin, _txPin);
}

void Pms7003Sensor::handle() {
  while (_serial.available() > 0) {
    processByte((uint8_t)_serial.read());
    _bytesReceived++;
  }
}

void Pms7003Sensor::processByte(uint8_t b) {
  if (_pos == 0) {
    if (b == 0x42) {
      _buf[_pos++] = b;
    }
    return;
  }
  if (_pos == 1) {
    if (b == 0x4D) {
      _buf[_pos++] = b;
    } else {
      // 42 42 4D: byte 0x42 vua nhan moi la dau frame that
      _pos = (b == 0x42) ? 1 : 0;
    }
    return;
  }

  _buf[_pos++] = b;

  // Truong do dai sai -> 42 4D vua gap nam giua du lieu, tim header lai ngay
  // thay vi nuot them 28 byte (co the chua header that cua frame sau).
  if (_pos == 4 && readWord(2) != FRAME_LEN - 4) {
    _pos = 0;
    return;
  }

  if (_pos == FRAME_LEN) {
    _pos = 0;
    parseFrame();
  }
}

void Pms7003Sensor::parseFrame() {
  uint16_t sum = 0;
  for (uint8_t i = 0; i < FRAME_LEN - 2; i++) {
    sum += _buf[i];
  }
  if (sum != readWord(FRAME_LEN - 2)) {
    _checksumErrors++;
    // Buffer UART tran luc loop() bi chan lau (vd. setup cho WiFi) cung gay
    // 1-2 frame hong; loi lien tuc moi la dau hieu day TX/GND long.
    if (_checksumErrors <= 3 || _checksumErrors % 20 == 0) {
      Serial.printf("PMS7003: bo frame sai checksum (lan %lu)\n",
                    _checksumErrors);
    }
    return;
  }

  // Word 1-3 (byte 4-9): CF=1, chuan nha may.
  // Word 4-6 (byte 10-15): atmospheric environment.
  _pm1_0 = readWord(10);
  _pm2_5 = readWord(12);
  _pm10 = readWord(14);
  _hasReading = true;
  _lastOkMs = millis();
}
