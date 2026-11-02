import { createHash } from 'node:crypto';
import { METRICS, normalizeReading, pushIdToTime, timeToPushPrefix } from './readings.js';

export const BUCKET_MS = 300000;
export const SKEW_MS = 60000;
const CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const validId = (id) => typeof id === 'string' && /^[-0-9A-Z_a-z]{20}$/.test(id);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const bucketOf = (time) => Math.floor(time / BUCKET_MS) * BUCKET_MS;

// RTDB removes null properties/empty objects. Sorting keys makes object order
// irrelevant, but preserves every actual field (not just normalized metrics).
export function canonical(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  const entries = Object.keys(value).sort().map((key) => [key, canonical(value[key])]).filter(([, v]) => v !== null);
  return entries.length ? Object.fromEntries(entries) : null;
}
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function summaryId(device, start) {
  const hash = createHash('sha256').update(device).digest();
  let suffix = '';
  for (let i = 0; i < 9; i += 3) {
    const n = hash.readUIntBE(i, 3);
    suffix += CHARS[(n >>> 18) & 63] + CHARS[(n >>> 12) & 63] + CHARS[(n >>> 6) & 63] + CHARS[n & 63];
  }
  return timeToPushPrefix(start) + suffix;
}
export function validatePaths(raw, aggregate) {
  const clean = (path) => {
    if (typeof path !== 'string' || !path.replace(/^\/+|\/+$/g, '') || /[.#$\[\]\u0000-\u001f\u007f]/.test(path)) throw Error('Invalid Firebase data path');
    return path.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  };
  raw = clean(raw);
  if (aggregate == null || aggregate === '') return { dataPath: raw, aggregatePath: null };
  aggregate = clean(aggregate);
  if (raw === aggregate || raw.startsWith(aggregate + '/') || aggregate.startsWith(raw + '/')) throw Error('Raw and aggregate Firebase paths must not overlap');
  return { dataPath: raw, aggregatePath: aggregate };
}
export function sourceRow(id, value) {
  if (!validId(id) || !object(value) || Object.hasOwn(value, 'aggregation') ||
      typeof value.deviceName !== 'string' || !value.deviceName.trim() || value.deviceName.length > 256 || /[\u0000-\u001f\u007f]/.test(value.deviceName)) return null;
  const ts = value.timestamp;
  if (ts != null && (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0 || (ts !== 0 && ts <= 1700000000))) return null;
  const row = normalizeReading(id, value);
  return row && Number.isFinite(row.time) && Math.abs(row.time - pushIdToTime(id)) <= SKEW_MS ? row : null;
}

export function buildSummary(entries, device, start) {
  const sources = entries.map(({ id, value }) => ({ id, value, row: sourceRow(id, value) }))
    .filter(({ row }) => row?.device === device && bucketOf(row.time) === start).sort((a, b) => a.id.localeCompare(b.id));
  if (!sources.length) throw Error('Empty compaction bucket');
  const metrics = {}, medians = {}, manifest = {};
  for (const { id, value, row } of sources) manifest[id] = { fingerprint: fingerprint(value), time: row.time };
  for (const metric of METRICS) {
    const values = sources.map(({ row }) => row[metric]).filter(Number.isFinite).sort((a, b) => a - b);
    const count = values.length, sum = values.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum)) throw Error('Metric sum overflow');
    medians[metric] = count ? (count % 2 ? values[count >> 1] : values[count / 2 - 1] / 2 + values[count / 2] / 2) : null;
    metrics[metric] = { count, sum, min: count ? values[0] : null, max: count ? values.at(-1) : null };
  }
  const firstTime = Math.min(...sources.map(({ row }) => row.time));
  const lastTime = Math.max(...sources.map(({ row }) => row.time));
  // Only metadata and aggregates are archived, never original samples.
  const value = { deviceName: device, location: sources.at(-1).row.location, timestamp: lastTime / 1000,
    sensors: { DHT11: { ok: metrics.temperature.count > 0 || metrics.humidity.count > 0, temperature: medians.temperature, humidity: medians.humidity },
      BH1750: { ok: metrics.lux.count > 0, lux: medians.lux }, PM: { ok: metrics.pm1_0.count > 0 || metrics.pm2_5.count > 0 || metrics.pm10.count > 0, pm1_0: medians.pm1_0, pm2_5: medians.pm2_5, pm10: medians.pm10 } }, rssi: medians.rssi,
    aggregation: { version: 1, method: 'median', bucketMinutes: 5, bucketStart: start, bucketEnd: start + BUCKET_MS,
      sourceCount: sources.length, firstTime, lastTime, metrics },
    coverage: { version: 1, sources: manifest } };
  return { id: summaryId(device, start), value: canonical(value) };
}

// A malformed/colliding existing CAS value must never authorize deletion or
// deduplication. Identity, interval, normalized stats and original coverage all
// have to agree. Immutable summaries are the authority, not a newly computed median.
export function validateSummary(id, value) {
  if (!object(value) || typeof value.deviceName !== 'string') throw Error('Malformed summary identity');
  const row = normalizeReading(id, value), a = row?.aggregation, coverage = value.coverage;
  if (!a || a.bucketMinutes !== 5 || bucketOf(a.bucketStart) !== a.bucketStart || id !== summaryId(row.device, a.bucketStart) ||
      coverage?.version !== 1 || !object(coverage.sources)) throw Error('Malformed summary identity/coverage');
  const entries = Object.entries(coverage.sources);
  if (entries.length !== a.sourceCount || !entries.length) throw Error('Malformed summary source count');
  let first = Infinity, last = -Infinity;
  for (const [sourceId, source] of entries) {
    if (!validId(sourceId) || !object(source) || !/^[a-f0-9]{64}$/.test(source.fingerprint) ||
        !Number.isFinite(source.time) || source.time < a.bucketStart || source.time >= a.bucketEnd ||
        Math.abs(source.time - pushIdToTime(sourceId)) > SKEW_MS) throw Error('Malformed summary source manifest');
    first = Math.min(first, source.time); last = Math.max(last, source.time);
  }
  if (first !== a.firstTime || last !== a.lastTime || row.time !== last) throw Error('Malformed summary source times');
  for (const metric of METRICS) {
    const stats = a.metrics[metric], n = row[metric];
    if (stats.count ? !Number.isFinite(n) || n < stats.min || n > stats.max : n !== null) throw Error('Malformed summary median');
  }
  return { row, sources: coverage.sources };
}

export function mergeReadings(rawEntries, summaryEntries) {
  const raw = new Map(rawEntries.map(({ id, value }) => {
    const row = normalizeReading(id, value);
    return [id, { value, row: row ? { ...row, sourceFingerprint: fingerprint(value) } : null }];
  }));
  const summaries = [];
  for (const { id, value } of summaryEntries) {
    const { row, sources } = validateSummary(id, value);
    summaries.push(row);
    for (const [sourceId, source] of Object.entries(sources)) {
      const entry = raw.get(sourceId);
      if (entry && fingerprint(entry.value) === source.fingerprint) raw.delete(sourceId);
    }
  }
  return [...raw.values()].map(({ row }) => row).filter(Boolean).concat(summaries)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

