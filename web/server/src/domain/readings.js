// Chuyen doi ban ghi tho trong /sensorData thanh dang phang cho bieu do.

const PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

// 8 ky tu dau cua push ID Firebase ma hoa thoi diem tao (ms, base64 tuy bien).
export function pushIdToTime(key) {
  let ms = 0;
  for (let i = 0; i < 8; i++) {
    const idx = PUSH_CHARS.indexOf(key.charAt(i));
    if (idx < 0) return null;
    ms = ms * 64 + idx;
  }
  return ms;
}

// Tien to push ID ung voi mot thoi diem -> dung voi orderByKey().startAt()
// de lay ban ghi theo khoang thoi gian ma khong can .indexOn trong rules.
export function timeToPushPrefix(ms) {
  const chars = new Array(8);
  let now = Math.floor(ms);
  for (let i = 7; i >= 0; i--) {
    chars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }
  return chars.join('');
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalizeReading(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sensors = raw.sensors ?? {};
  const dht = sensors.DHT11 ?? {};
  const bh = sensors.BH1750 ?? {};
  const pm = sensors.PM ?? {};

  // timestamp = 0 khi ESP32 chua dong bo NTP -> lay gio tu push ID.
  const ts = num(raw.timestamp);
  const time = ts && ts > 1_700_000_000 ? ts * 1000 : pushIdToTime(key);

  const aggregation = normalizeAggregation(raw.aggregation, time);
  return {
    id: key,
    device: raw.deviceName ?? 'unknown',
    location: raw.location ?? '',
    time,
    temperature: dht.ok ? num(dht.temperature) : null,
    humidity: dht.ok ? num(dht.humidity) : null,
    lux: bh.ok ? num(bh.lux) : null,
    pm1_0: pm.ok ? num(pm.pm1_0) : null,
    pm2_5: pm.ok ? num(pm.pm2_5) : null,
    pm10: pm.ok ? num(pm.pm10) : null,
    rssi: num(raw.rssi),
    ...(aggregation ? { aggregation } : {}),
  };
}

export const METRICS = [
  'temperature',
  'humidity',
  'lux',
  'pm1_0',
  'pm2_5',
  'pm10',
  'rssi',
];

// Accept only bounded v1 metadata, never arbitrary objects from the database.
// Bucket/time values are milliseconds; bucketEnd is exclusive. RTDB removes
// null object properties, so absent min/max on an empty metric mean null.
function normalizeAggregation(value, time) {
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const timestamp = (v) => Number.isFinite(v) && v >= 0 && v <= 8.64e15;
  if (!object(value) || value.version !== 1 || value.method !== 'median') return null;
  const { bucketMinutes, bucketStart, bucketEnd, sourceCount, firstTime, lastTime } = value;
  if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 1440 ||
      !timestamp(bucketStart) || !timestamp(bucketEnd) ||
      !Number.isSafeInteger(bucketStart) || !Number.isSafeInteger(bucketEnd) ||
      bucketEnd - bucketStart !== bucketMinutes * 60000 ||
      !Number.isSafeInteger(sourceCount) || sourceCount < 1 ||
      !timestamp(firstTime) || !timestamp(lastTime) ||
      firstTime < bucketStart || lastTime >= bucketEnd || firstTime > lastTime ||
      !Number.isFinite(time) || time < firstTime || time > lastTime ||
      !object(value.metrics)) return null;
  const metrics = {};
  for (const m of METRICS) {
    const entry = value.metrics[m];
    if (!object(entry)) return null;
    const { count, sum, min, max } = entry;
    if (!Number.isSafeInteger(count) || count < 0 || count > sourceCount || num(sum) === null) return null;
    if (count === 0) {
      if (sum !== 0 || min != null || max != null) return null;
      metrics[m] = { count: 0, sum: 0, min: null, max: null };
    } else {
      if (num(min) === null || num(max) === null || min > max) return null;
      const mean = sum / count;
      // Repeated decimal additions in a large source bucket accumulate error.
      const tolerance = 1e-9 * Math.max(1, Math.abs(min), Math.abs(max), Math.abs(mean));
      if (mean < min - tolerance || mean > max + tolerance) return null;
      metrics[m] = { count, sum, min, max };
    }
  }
  return { version: 1, method: 'median', bucketMinutes, bucketStart, bucketEnd,
    sourceCount, metrics, firstTime, lastTime };
}

export function summarize(points) {
  const stats = {};
  for (const m of METRICS) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (const p of points) {
      const aggregate = p.aggregation?.metrics[m];
      if (aggregate) {
        if (aggregate.count === 0) continue;
        min = Math.min(min, aggregate.min);
        max = Math.max(max, aggregate.max);
        sum += aggregate.sum;
        n += aggregate.count;
      } else {
        const v = num(p[m]);
        if (v === null) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
        n++;
      }
    }
    stats[m] = n ? { min, max, avg: Math.round((sum / n) * 10) / 10 } : null;
  }
  return stats;
}

// Gom diem vao toi da maxPoints bucket theo thoi gian, lay trung binh tung
// truong (bo qua null) de bieu do 24h khong phai ve hang chuc nghin diem.
// Khoang trong lon hon gapMs (thiet bi mat ket noi) duoc chen mot diem rong
// de bieu do ngat net thay vi noi thang qua khoang mat du lieu.
export function toChartPoints(points, maxPoints, minGapMs) {
  const span = points.length ? points.at(-1).time - points[0].time : 0;
  const gapMs = Math.max(minGapMs, (3 * span) / maxPoints);
  // Mark discontinuities BEFORE sampling: display buckets must not bridge an
  // outage or invent one by moving their representative timestamps. Compacted
  // rows cover the whole bucket, not just the retained original timestamp.
  let coverageEnd = -Infinity;
  let coverageAggregate = false;
  const covered = points.map((p, i) => {
    const start = p.aggregation?.bucketStart ?? p.time;
    const end = p.aggregation?.bucketEnd ?? p.time;
    const aggregate = Boolean(p.aggregation);
    const threshold = aggregate || coverageAggregate ? minGapMs : gapMs;
    const breakBefore = i > 0 && start - coverageEnd > threshold;
    if (breakBefore || end > coverageEnd) {
      coverageEnd = end;
      coverageAggregate = aggregate;
    } else if (end === coverageEnd) {
      coverageAggregate ||= aggregate;
    }
    return { ...p, breakBefore };
  });
  // Archived medians are real five-minute measurements, not inputs to an
  // average-of-medians. Preserve them; apply the display budget only to raw runs.
  const sampled = [];
  let rawRun = [];
  const flushRaw = () => { sampled.push(...downsample(rawRun, maxPoints)); rawRun = []; };
  for (const point of covered) {
    if (point.aggregation) { flushRaw(); sampled.push(point); }
    else rawRun.push(point);
  }
  flushRaw();

  const out = [];
  for (let i = 0; i < sampled.length; i++) {
    const p = sampled[i];
    if (i > 0 && p.breakBefore) {
      const gap = { time: sampled[i - 1].time + 1 };
      for (const m of METRICS) gap[m] = null;
      out.push(gap);
    }
    const row = { time: p.time };
    for (const m of METRICS) row[m] = p[m];
    out.push(row);
  }
  return out;
}

// maxPoints is a display target: preserving a real break can split a display
// bucket into multiple rows (and separators are additional rows as before).
function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const start = points[0].time;
  const span = points[points.length - 1].time - start || 1;
  const bucketMs = span / maxPoints;

  const out = [];
  let bucket = null;
  const flush = () => {
    if (!bucket) return;
    const row = { time: Math.round(bucket.timeSum / bucket.n), breakBefore: bucket.breakBefore };
    for (const m of METRICS) {
      row[m] = bucket.cnt[m]
        ? Math.round((bucket.sum[m] / bucket.cnt[m]) * 10) / 10
        : null;
    }
    out.push(row);
  };

  for (const p of points) {
    const idx = Math.min(maxPoints - 1, Math.floor((p.time - start) / bucketMs));
    if (!bucket || bucket.idx !== idx || p.breakBefore) {
      flush();
      bucket = { idx, n: 0, timeSum: 0, sum: {}, cnt: {}, breakBefore: p.breakBefore };
    }
    bucket.n++;
    bucket.timeSum += p.time;
    for (const m of METRICS) {
      if (num(p[m]) !== null) {
        bucket.sum[m] = (bucket.sum[m] ?? 0) + p[m];
        bucket.cnt[m] = (bucket.cnt[m] ?? 0) + 1;
      }
    }
  }
  flush();
  return out;
}
