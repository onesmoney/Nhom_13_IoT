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
