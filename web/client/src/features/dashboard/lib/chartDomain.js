const CHART_METRICS = ['temperature', 'humidity', 'lux', 'pm1_0', 'pm2_5', 'pm10', 'rssi'];

export function chartTimeDomain(points, from, to, fitData = false) {
  // Live charts keep their rolling window; history fits the measurements that
  // were actually returned. Null separators must not extend the visible range.
  if (!fitData) return [from, to];
  let first = Infinity;
  let last = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.time) || point.time < from || point.time > to ||
        !CHART_METRICS.some((metric) => Number.isFinite(point[metric]))) continue;
    first = Math.min(first, point.time);
    last = Math.max(last, point.time);
  }
  // Keep a usable axis for empty results or a single measurement timestamp.
  return first < last ? [first, last] : [from, to];
}

export function autoDomain(points, metric) {
  const humidity = metric === 'humidity';
  const fallback = humidity ? [0, 100] : [0, 50];
  const values = points.map((point) => point[metric])
    .filter((value) => Number.isFinite(value) && (!humidity || (value >= 0 && value <= 100)));
  if (!values.length) return fallback;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(humidity ? 1 : 0.5, (max - min) * 0.15);
  const span = Math.max(humidity ? 5 : 2, max - min + padding * 2);
  if (!humidity) return [(min + max - span) / 2, (min + max + span) / 2];
  const boundedSpan = Math.min(100, span);
  const lower = Math.max(0, Math.min(100 - boundedSpan, (min + max - boundedSpan) / 2));
  return [lower, lower + boundedSpan];
}

export function axisTicks([min, max]) {
  return Array.from({ length: 6 }, (_, i) => min + ((max - min) * i) / 5);
}
