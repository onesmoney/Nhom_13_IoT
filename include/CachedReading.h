#pragma once
#include <stddef.h>
#include <stdint.h>

// Version 1 journal format, ESP32 little endian. No pointers or String objects.
struct CachedReading {
  enum Flag : uint8_t { Dht = 1, DhtStale = 2, Lux = 4, Pm = 8, Wifi = 16 };
  uint64_t epochMs = 0;
  uint64_t uptimeMs = 0;
  uint32_t bootId = 0;
  float temperature = 0, humidity = 0, lux = 0;
  uint16_t pm1_0 = 0, pm2_5 = 0, pm10 = 0;
  uint8_t flags = 0;
  int8_t rssi = 0;
  char key[20] = {};
  uint32_t crc = 0;

  bool hasDht() const { return flags & Dht; }
  bool dhtStale() const { return flags & DhtStale; }
  bool hasLux() const { return flags & Lux; }
  bool hasPm() const { return flags & Pm; }
};
static_assert(sizeof(CachedReading) == 64, "Cache record layout changed: migrate the journal");
static_assert(offsetof(CachedReading, crc) == 60, "Unexpected journal padding");

inline uint32_t cacheCrc(const void *data, size_t size) {
  const auto *bytes = static_cast<const uint8_t *>(data);
  uint32_t crc = 0xffffffff;
  while (size--) {
    crc ^= *bytes++;
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
  }
  return ~crc;
}

inline void cacheTimePrefix(char *key, uint64_t epochMs) {
  static const char alphabet[] = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  for (int i = 7; i >= 0; --i) { key[i] = alphabet[epochMs & 63]; epochMs >>= 6; }
}
