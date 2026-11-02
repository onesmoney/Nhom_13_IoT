import { isDeepStrictEqual } from 'node:util';
import { METRICS, normalizeReading, pushIdToTime, timeToPushPrefix } from './readings.js';

export const DEFAULTS = Object.freeze({ retainDays: 7, bucketMinutes: 5, pageSize: 1000, maxRows: 100000, maxBytes: 64 * 1024 * 1024, maxUpdateBytes: 4 * 1024 * 1024 });
export const MAX_SKEW_MS = 60000;
const DAY = 86400000;
const VN = 7 * 3600000;
const validKey = (id) => typeof id === 'string' && /^[-0-9A-Z_a-z]{20}$/.test(id);
const validDevice = (s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 256 && !/[\u0000-\u001f\u007f]/.test(s);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
export const bucketStart = (time, bucketMinutes) => Math.floor((time + VN) / (bucketMinutes * 60000)) * bucketMinutes * 60000 - VN;

export function downsamplingOptions(options = {}) {
  const o = { ...DEFAULTS, ...options };
  if (!Number.isFinite(o.now) || o.now < 0 || o.now >= 2 ** 48) throw new Error('now must be a fixed epoch millisecond time');
  if (!Number.isFinite(o.retainDays) || o.retainDays <= 0) throw new Error('retainDays must be positive');
  if (!Number.isInteger(o.bucketMinutes) || o.bucketMinutes <= 0 || 1440 % o.bucketMinutes !== 0) throw new Error('bucketMinutes must be an integer divisor of 1440');
  for (const key of ['pageSize', 'maxRows', 'maxBytes', 'maxUpdateBytes']) {
    if (!Number.isSafeInteger(o[key]) || o[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  o.cutoff = o.now - o.retainDays * DAY;
  if (o.cutoff <= 0) throw new Error('Retention cutoff must be after epoch');
  // Include keys just beyond cutoff: they can belong to an old event bucket,
  // and must prevent that bucket from being compacted incompletely.
  o.endBefore = timeToPushPrefix(Math.ceil(o.cutoff + MAX_SKEW_MS));
  return o;
}

/** Pure, deterministic planner. entries must be the complete bounded raw scan. */
export function planDownsampling(entries, options) {
  const o = downsamplingOptions(options);
  const groups = new Map();
  const blockedDevices = new Set();
  const summaryBuckets = new Set();
  const seen = new Set();
  const skipped = { invalid: 0, aggregation: 0, incomplete: 0, singleton: 0 };
  const keyFor = (device, start) => JSON.stringify([device, start]);
  for (const { id, value } of entries) {
    if (seen.has(id)) throw new Error(`Duplicate source key: ${id}`);
    seen.add(id);
    const device = value?.deviceName;
    if (value && Object.hasOwn(value, 'aggregation')) {
      // Unknown or incompatible summaries cannot safely be interpreted as raw
      // samples. Block the device if their covered interval cannot be trusted.
      if (!validDevice(device)) throw new Error('Aggregate has invalid device');
      const a = value.aggregation;
      const start = a?.bucketStart;
      const row = validKey(id) ? normalizeReading(id, value) : null;
      if (a?.version !== 1 || a?.method !== 'median' || a?.bucketMinutes !== o.bucketMinutes ||
          !Number.isSafeInteger(start) || bucketStart(start, o.bucketMinutes) !== start ||
          a.bucketEnd !== start + o.bucketMinutes * 60000 ||
          !row || !Number.isFinite(row.time) || row.time < start || row.time >= a.bucketEnd ||
          !Number.isSafeInteger(a.sourceCount) || a.sourceCount < 1 ||
          !Number.isFinite(a.firstTime) || !Number.isFinite(a.lastTime) ||
          a.firstTime < start || a.firstTime > row.time || a.lastTime < row.time || a.lastTime >= a.bucketEnd ||
          !METRICS.every((name) => {
            const m = a.metrics?.[name];
            return m && Number.isSafeInteger(m.count) && m.count >= 0 && m.count <= a.sourceCount &&
              (m.count === 0 ? m.sum === 0 && m.min == null && m.max == null :
                Number.isFinite(m.sum) && Number.isFinite(m.min) && Number.isFinite(m.max) && m.min <= m.max);
          }) || Math.abs(row.time - pushIdToTime(id)) > MAX_SKEW_MS) {
        blockedDevices.add(device);
      } else {
        summaryBuckets.add(keyFor(device, start));
      }
      skipped.aggregation++;
      continue;
    }
    const row = validKey(id) && validDevice(device) ? normalizeReading(id, value) : null;
    const ts = value?.timestamp;
    if (!row || !Number.isFinite(row.time) || row.time < 0 ||
        (ts !== undefined && ts !== null && (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0 || (ts !== 0 && ts <= 1700000000))) ||
        Math.abs(row.time - pushIdToTime(id)) > MAX_SKEW_MS) {
      skipped.invalid++;
      continue;
    }
    const start = bucketStart(row.time, o.bucketMinutes);
    const key = keyFor(device, start);
    const group = groups.get(key) ?? { device, bucketStart: start, bucketEnd: start + o.bucketMinutes * 60000, rows: [] };
    group.rows.push({ id, value, row });
    groups.set(key, group);
  }
  const buckets = [];
  for (const [key, g] of groups) {
    if (blockedDevices.has(g.device) || summaryBuckets.has(key)) { skipped.aggregation += g.rows.length; continue; }
    if (g.bucketEnd > o.cutoff || g.rows.some((r) => pushIdToTime(r.id) >= o.cutoff || r.row.time >= o.cutoff)) { skipped.incomplete += g.rows.length; continue; }
    if (g.rows.length < 2) { skipped.singleton++; continue; }
    g.rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const representative = g.rows.at(-1);
    const medians = {};
    const metrics = {};
    for (const name of METRICS) {
      const values = g.rows.map((r) => r.row[name]).filter(Number.isFinite).sort((a, b) => a - b);
      const count = values.length;
      const sum = values.reduce((s, n) => s + n, 0);
      if (!Number.isFinite(sum)) throw new Error(`Metric sum overflow: ${name}`);
      medians[name] = count ? (count % 2 ? values[count >> 1] : values[count / 2 - 1] / 2 + values[count / 2] / 2) : null;
      metrics[name] = { count, sum, min: count ? values[0] : null, max: count ? values.at(-1) : null };
    }
    const value = structuredClone(representative.value);
    const sensors = value.sensors ?? {};
    value.sensors = {
      ...sensors,
      DHT11: { ...sensors.DHT11, ok: metrics.temperature.count > 0 || metrics.humidity.count > 0, temperature: medians.temperature, humidity: medians.humidity },
      BH1750: { ...sensors.BH1750, ok: metrics.lux.count > 0, lux: medians.lux },
      PM: { ...sensors.PM, ok: metrics.pm1_0.count > 0 || metrics.pm2_5.count > 0 || metrics.pm10.count > 0, pm1_0: medians.pm1_0, pm2_5: medians.pm2_5, pm10: medians.pm10 },
    };
    value.rssi = medians.rssi;
    value.aggregation = {
      version: 1, method: 'median', bucketMinutes: o.bucketMinutes,
      bucketStart: g.bucketStart, bucketEnd: g.bucketEnd, sourceCount: g.rows.length, metrics,
      firstTime: g.rows.reduce((min, r) => Math.min(min, r.row.time), Infinity),
      lastTime: g.rows.reduce((max, r) => Math.max(max, r.row.time), -Infinity),
    };
    const originals = g.rows.map(({ id, value: raw }) => ({ id, value: raw }));
    const updates = Object.fromEntries(originals.map(({ id }) => [id, id === representative.id ? value : null]));
    if (bytes(updates) > o.maxUpdateBytes) throw new Error('Bucket exceeds maxUpdateBytes; buckets are never split');
    buckets.push({ device: g.device, bucketStart: g.bucketStart, bucketEnd: g.bucketEnd, representativeId: representative.id, value, originals, updates });
  }
  buckets.sort((a, b) => a.bucketStart - b.bucketStart || (a.representativeId < b.representativeId ? -1 : 1));
  return { now: o.now, retainDays: o.retainDays, bucketMinutes: o.bucketMinutes, cutoff: o.cutoff, endBefore: o.endBefore, scanned: entries.length, skipped, buckets, sourceCount: buckets.reduce((n, b) => n + b.originals.length, 0), deletedCount: buckets.reduce((n, b) => n + b.originals.length - 1, 0) };
}

/** readPage({after,endBefore,limit}) -> raw [{id,value}], never normalized. */
export async function scanRaw(readPage, options) {
  const o = downsamplingOptions(options);
  const entries = [];
  let after;
  let usedBytes = 0;
  while (true) {
    // An empty page proves completeness. Reaching a budget is not completeness.
    if (entries.length >= o.maxRows) throw new Error('Scan row budget exhausted; no writes permitted');
    const limit = Math.min(o.pageSize, o.maxRows - entries.length);
    const page = await readPage({ after, endBefore: o.endBefore, limit });
    if (!Array.isArray(page) || page.length > limit) throw new Error('Invalid scan page');
    if (!page.length) return entries;
    for (const entry of page) {
      if (typeof entry.id !== 'string' || (after !== undefined && entry.id <= after) || entry.id >= o.endBefore) throw new Error('Scan cursor or bound violation');
      after = entry.id;
      usedBytes += bytes(entry);
      if (usedBytes > o.maxBytes) throw new Error('Scan byte budget exhausted; no writes permitted');
      entries.push(entry);
    }
  }
}

// RTDB deletes null object properties (and empty objects) on persistence.
// Comparing that canonical form allows adjacent bucket checks after our own
// updates, without treating removed numeric values or changed flags as equal.
function firebaseValue(value) {
  if (Array.isArray(value)) return value.map((item) => firebaseValue(item));
  if (!value || typeof value !== 'object') return value ?? null;
  const entries = Object.entries(value).map(([key, item]) => [key, firebaseValue(item)]).filter(([, item]) => item !== null);
  return entries.length ? Object.fromEntries(entries) : null;
}

export function assertUnchanged(expected, actual) {
  if (!isDeepStrictEqual(firebaseValue(expected), firebaseValue(actual))) throw new Error('Source changed; aborting without applying this bucket');
}
