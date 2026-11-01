#ifndef STATUS_LED_H
#define STATUS_LED_H

#include <Arduino.h>

// LED trang thai nhay khong chan (dung millis(), khong dung delay()).
// Goi update() lien tuc de LED chay dung mau. pin < 0 = tat tinh nang.
class StatusLed {
public:
  enum State {
    OFF,             // LED tat
    WIFI_CONNECTING, // 1 nhay ngan moi giay
    SMARTCONFIG,     // nhay nhanh lien tuc (~5 lan/giay)
    AP_PORTAL,       // nhay doi moi giay
    CONNECTED        // sang du
  };

  StatusLed(int pin, bool activeHigh = true);

  void setState(State state);
  void update();

private:
  void setPattern(unsigned long onMs, unsigned long offMs, uint8_t blinks, unsigned long pauseMs);
  void writeLed(bool on);

  int _pin;
  bool _activeHigh;
  bool _initialized;
  bool _solid; // true = LED duoc giu co dinh, update() khong lam gi
  unsigned long _onMs, _offMs, _pauseMs;
  uint8_t _blinks;
  unsigned long _cycleStart;
};

#endif // STATUS_LED_H
