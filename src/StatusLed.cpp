#include "StatusLed.h"

StatusLed::StatusLed(int pin, bool activeHigh)
    : _pin(pin), _activeHigh(activeHigh), _initialized(false), _solid(true),
      _onMs(0), _offMs(0), _pauseMs(0), _blinks(0), _cycleStart(0) {}

void StatusLed::setState(State state) {
  if (_pin < 0) {
    return;
  }
  if (!_initialized) {
    // tri hoan pinMode den lan goi dau tien, khi Arduino init da hoan tat
    pinMode(_pin, OUTPUT);
    _initialized = true;
  }

  switch (state) {
    case OFF:
      _solid = true;
      writeLed(false);
      break;
    case CONNECTED:
      _solid = true;
      writeLed(true);
      break;
    case WIFI_CONNECTING:
      _solid = false;
      setPattern(150, 850, 1, 0); // 1 nhay ngan moi giay
      break;
    case SMARTCONFIG:
      _solid = false;
      setPattern(100, 100, 1, 0); // nhay nhanh ~5 lan/giay
      break;
    case AP_PORTAL:
      _solid = false;
      setPattern(100, 100, 2, 700); // nhay doi moi giay
      break;
  }
}

void StatusLed::setPattern(unsigned long onMs, unsigned long offMs,
                           uint8_t blinks, unsigned long pauseMs) {
  _onMs = onMs;
  _offMs = offMs;
  _blinks = blinks;
  _pauseMs = pauseMs;
  _cycleStart = millis();
  update(); // cap nhat ngay de LED khong bi "tre" o mau cu
}

void StatusLed::update() {
  if (_pin < 0 || _solid || !_initialized) {
    return;
  }

  unsigned long seg = _onMs + _offMs;
  unsigned long cycle = (unsigned long)_blinks * seg + _pauseMs;
  if (seg == 0 || cycle == 0) {
    writeLed(false);
    return;
  }

  unsigned long t = (millis() - _cycleStart) % cycle;
  bool on = (t / seg < _blinks) && (t % seg < _onMs);
  writeLed(on);
}

void StatusLed::writeLed(bool on) {
  digitalWrite(_pin, (on == _activeHigh) ? HIGH : LOW);
}
