import { summarize, toChartPoints, METRICS } from '../domain/readings.js';

// Store selection and chart/stat assembly, independent of HTTP parsing/headers.
export async function createReadingsResponse(store, { period, device }) {
  const { from, to, historical } = period;
  let rows, points;
  if (period.dates) {
    const groups = await store.selectedHistory({ device, dates: period.dates });
    const missing = period.dates.filter((_, i) => !groups[i]?.length);
    if (missing.length) return { error: `Không có dữ liệu cho thiết bị vào ngày: ${missing.join(', ')}`, invalidDates: missing };
    rows = groups.flat();
    points = [];
    // Sample each selected day separately, never average across an omitted day.
    for (const group of groups) {
      if (points.length) points.push({ time: points.at(-1).time + 1, ...Object.fromEntries(METRICS.map((m) => [m, null])) });
      points.push(...toChartPoints(group, Math.max(2, Math.floor(400 / groups.length)), 30000));
    }
  } else {
    rows = historical ? await store.history({ device, from, to }) : store.range ? await store.range({ device, from, to }) : store.query({ device, from, to });
    points = toChartPoints(rows, 400, 30000);
  }
  const partialBucketCoverage = rows.some((row) => row.aggregation &&
    (row.aggregation.bucketStart < from || row.aggregation.bucketEnd > to + 1));
  // Clip display coordinates only; recent rows keep original timestamps and
  // metadata. Stats include full overlapping buckets, never invented partial medians.
  if (partialBucketCoverage) points = points.map((point) => ({ ...point, time: Math.max(from, Math.min(to, point.time)) }));
  const recent = rows.slice(-10).reverse();
  const cache = !historical ? store.cacheStatus?.() : null;
  const dataSource = historical ? 'history-on-demand' : cache?.stale ? `${cache.source}-cache-stale` : 'memory-reconciled';
  return {
    dataSource, cache, stale: !!cache?.stale, readiness: store.readiness?.(), syncReason: store.syncStatus?.reason,
    partialBucketCoverage,
    resolutionNote: partialBucketCoverage ? 'Full intersecting five-minute buckets included; boundary statistics are not exact partial-bucket statistics.' : null,
    from, to,
    count: rows.length,
    latest: recent[0] ?? null,
    liveLatest: store.recent(device, 1)[0] ?? null,
    recent,
    stats: summarize(rows),
    dates: period.dates,
    points,
  };
}
