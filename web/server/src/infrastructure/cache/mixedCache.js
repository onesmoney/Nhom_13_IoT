import { FileCache, cacheTarget, hydrateReading } from './fileCache.js';
import { fingerprint, validateSummary } from '../../domain/compaction.js';
import { timeToPushPrefix } from '../../domain/readings.js';

export const MIXED_CACHE_VERSION = 2;
export const MIXED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const MIXED_CACHE_MAX_ROWS = 100000;
const timestamp = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15;
export const mixedCachePath = (path) => path ? `${path}.mixed-v2.json` : null;
export const mixedTarget = (target) => ({ ...cacheTarget(target), aggregatePath: target.aggregatePath,
  schema: 'normalized-mixed-manifest-v2' });

// Reuse the source-summary validator rather than trusting on-disk coverage.
// Reconstruct only its normalized metric inputs, never normalize raw disk rows.
export function validateManifest(value) {
  const row = hydrateReading(value?.summary);
  const { temperature, humidity, lux, pm1_0, pm2_5, pm10, rssi } = row;
  const checked = validateSummary(row.id, { deviceName: row.device, location: row.location,
    timestamp: row.time / 1000, aggregation: row.aggregation, coverage: { version: 1, sources: value.sources }, rssi,
    sensors: { DHT11: { ok: true, temperature, humidity }, BH1750: { ok: true, lux }, PM: { ok: true, pm1_0, pm2_5, pm10 } } });
  return { summary: row, sources: structuredClone(checked.sources) };
}

export function mixedPayload(target, { savedAt, scan, rows, manifests }) {
  const body = { version: MIXED_CACHE_VERSION, target: mixedTarget(target), savedAt,
    scan: scan ? { ...scan } : null, rows: structuredClone(rows), manifests: structuredClone([...manifests.values()]) };
  return { ...body, digest: fingerprint(body) };
}

export function validateMixedCache(value, target) {
  if (!value || value.version !== MIXED_CACHE_VERSION || JSON.stringify(value.target) !== JSON.stringify(mixedTarget(target)) ||
      !timestamp(value.savedAt) || !Array.isArray(value.rows) || value.rows.length > MIXED_CACHE_MAX_ROWS ||
      !Array.isArray(value.manifests) || value.manifests.length > MIXED_CACHE_MAX_ROWS) throw Error('Invalid mixed cache schema or target');
  const { digest, ...body } = value;
  if (digest !== fingerprint(body)) throw Error('Invalid mixed cache integrity');
  const scan = value.scan;
  if (scan !== null && (!scan || !timestamp(scan.from) || !timestamp(scan.through) || scan.from > scan.through ||
      scan.through > value.savedAt || scan.cursor !== timeToPushPrefix(scan.through))) throw Error('Invalid mixed scan coverage');
  const rows = value.rows.map((value) => {
    const row = hydrateReading(value);
    if (value.sourceFingerprint !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) throw Error('Invalid cached source fingerprint');
      row.sourceFingerprint = value.sourceFingerprint;
    } else if (!row.aggregation) throw Error('Missing cached source fingerprint');
    return row;
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw Error('Duplicate mixed cache rows');
  const manifests = value.manifests.map(validateManifest);
  const byId = new Map(manifests.map((m) => [m.summary.id, m]));
  if (byId.size !== manifests.length) throw Error('Duplicate mixed cache manifests');
  for (const row of rows) {
    if (row.aggregation && !row.sourceFingerprint && fingerprint(row) !== fingerprint(byId.get(row.id)?.summary ?? null)) throw Error('Missing or inconsistent cached manifest');
  }
  const rowDigests = new Map(rows.map((row) => [row.id, fingerprint(row)]));
  for (const { summary } of manifests) {
    if (rowDigests.get(summary.id) !== fingerprint(summary)) throw Error('Orphan cached manifest');
  }
  return { savedAt: value.savedAt, scan: scan ? { ...scan } : null, rows, manifests, history: [] };
}

export function createMixedCache(path, target, options) {
  return new FileCache(mixedCachePath(path), target, { ...options, validator: validateMixedCache,
    maxBytes: MIXED_CACHE_MAX_BYTES, protectInvalid: true });
}
