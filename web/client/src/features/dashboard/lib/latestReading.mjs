const CARD_METRICS = ['temperature', 'humidity', 'lux', 'pm2_5', 'pm10', 'rssi'];

// Select a whole normalized reading, never merge individual sensor values.
// Null metrics are valid; device-status timestamps are not readings.
export function newestReading(device, ...readings) {
  return readings.reduce((latest, reading) => {
    if (!device || reading?.device !== device || !Number.isFinite(reading.time)
      || !CARD_METRICS.every((metric) => Object.hasOwn(reading, metric))) return latest;
    // On equal timestamps prefer the later candidate (SSE after API snapshots).
    return !latest || reading.time >= latest.time ? reading : latest;
  }, null);
}

export function selectStatReading(mode, device, data, liveReading) {
  return mode === 'recent'
    ? newestReading(device, data?.latest, data?.liveLatest, liveReading)
    : newestReading(device, data?.latest);
}
