#include "DhtSensor.h"

DhtSensor::DhtSensor(uint8_t pin, unsigned long intervalMs)
    : _pin(pin), _intervalMs(intervalMs), _lastRead(0), _lastSuccessMs(0),
      _hasReading(false), _temperature(NAN), _humidity(NAN), _failCount(0) {}

void DhtSensor::begin() {
  pinMode(_pin, INPUT_PULLUP); // line o trang thai nghi phai HIGH
  Serial.println("Khoi tao DHT11 tai GPIO " + String(_pin));
}

// Cho den khi chan DATA ROI KHOI muc 'fromLevel' (cuon sang muc nguoc lai);
// qua han timeoutUs ma khong chuyen muc thi bao that bai.
bool DhtSensor::waitForEdge(int fromLevel, uint32_t timeoutUs) {
  uint32_t start = micros();
  while (digitalRead(_pin) == fromLevel) {
    if (micros() - start > timeoutUs) {
      return false;
    }
  }
  return true;
}

// Doc 5 byte theo giao thuc DHT11, tra ve true neu checksum dung.
// Trinh tu: host keo DATA xuong LOW >=18ms -> nha line -> cam bien tra loi
// (keo LOW ~80us, nha HIGH ~80us) -> 40 bit, moi bit la pha LOW ~50us roi
// pha HIGH 26-28us (bit 0) hoac ~70us (bit 1) -> byte cuoi la checksum.
bool DhtSensor::readRaw(uint8_t data[5]) {
  pinMode(_pin, OUTPUT);
  digitalWrite(_pin, LOW);
  delay(20); // tin hieu bat dau

  pinMode(_pin, INPUT_PULLUP);

  // Phan hoi cua cam bien: HIGH -> LOW -> HIGH
  if (!waitForEdge(HIGH, 250)) { // cam bien keo line xuong bat dau phan hoi
    return false;
  }
  if (!waitForEdge(LOW, 250)) { // het pha LOW ~80us
    return false;
  }
  if (!waitForEdge(HIGH, 250)) { // het pha HIGH ~80us, sap vao bit dau tien
    return false;
  }

  for (int i = 0; i < 40; i++) {
    if (!waitForEdge(LOW, 250)) { // het pha LOW ~50us cua bit
      return false;
    }
    uint32_t rise = micros(); // bat dau pha HIGH
    if (!waitForEdge(HIGH, 250)) { // het pha HIGH cua bit
      return false;
    }
    uint32_t highUs = micros() - rise;
    data[i / 8] <<= 1;
    if (highUs >= 50) { // 26-28us la bit 0, ~70us la bit 1
      data[i / 8] |= 1;
    }
  }

  return data[4] == (uint8_t)((data[0] + data[1] + data[2] + data[3]) & 0xFF);
}

void DhtSensor::readNow() {
  _lastRead = millis();
  uint8_t data[5] = {0, 0, 0, 0, 0};

  if (!readRaw(data)) {
    _hasReading = false;
    _temperature = NAN;
    _humidity = NAN;
    _failCount++;
    // chi log 3 lan dau va sau do moi 10 lan de tranh spam Serial
    if (_failCount <= 3 || _failCount % 10 == 0) {
      Serial.println("Doc DHT that bai (lan " + String(_failCount) +
                     "), kiem tra day noi/nguon...");
    }
    return;
  }

  if (!_hasReading) {
    Serial.println("DHT11: da nhan du lieu hop le");
  }
  _failCount = 0;
  _hasReading = true;
  _lastSuccessMs = _lastRead;
  _humidity = data[0] + data[1] * 0.1f;
  _temperature = data[2] + (data[3] & 0x0F) * 0.1f;
}

void DhtSensor::handle() {
  if (millis() - _lastRead < _intervalMs) {
    return;
  }
  readNow();
}
