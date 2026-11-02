import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { METRICS, normalizeReading } from '../../domain/readings.js';

export const CACHE_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const key = (v) => typeof v === 'string' && /^[\w-]{8}(?:[\w-]{12})?$/.test(v);

// Only the public database target is stored, never API keys, auth or URL tokens.
export function cacheTarget({ databaseURL, dataPath }) {
  const url = new URL(databaseURL);
  return { databaseURL: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, dataPath: String(dataPath || 'sensorData').replace(/^\/+|\/+$/g, '') };
}

// Disk rows are already normalized: do NOT pass them through raw sensors parsing.
export function hydrateReading(value) {
  if (!object(value) || !key(value.id) || value.id.length !== 20 || !Number.isFinite(value.time) || value.time < 0 || value.time > 8.64e15 ||
      typeof value.device !== 'string' || typeof value.location !== 'string') throw new Error('Invalid cached reading');
  const row = { id: value.id, device: value.device, location: value.location, time: value.time };
  for (const metric of METRICS) {
    if (value[metric] !== null && !Number.isFinite(value[metric])) throw new Error('Invalid cached metric');
    row[metric] = value[metric];
  }
  if (value.aggregation !== undefined) {
    // Reuse the bounded metadata validator; sensor values themselves stay untouched.
    const aggregate = normalizeReading(row.id, { timestamp: row.time / 1000, aggregation: value.aggregation }).aggregation;
    if (!aggregate) throw new Error('Invalid cached aggregation');
    row.aggregation = aggregate;
  }
  return row;
}

export function validateCache(value, target) {
  if (!object(value) || value.version !== CACHE_VERSION || !object(value.target) ||
      JSON.stringify(value.target) !== JSON.stringify(cacheTarget(target)) ||
      !timestamp(value.savedAt) || !Array.isArray(value.rows) || !Array.isArray(value.history)) throw new Error('Invalid cache schema or target');
  let scan = null;
  if (value.scan !== null) {
    if (!object(value.scan) || !timestamp(value.scan.from) ||
        (value.scan.cursor !== null && !key(value.scan.cursor))) throw new Error('Invalid cached scan cursor');
    scan = { from: value.scan.from, cursor: value.scan.cursor };
  }
  const rows = value.rows.map(hydrateReading);
  const history = value.history.map((entry) => {
    if (!object(entry) || !timestamp(entry.from) || !timestamp(entry.to) || entry.from > entry.to ||
        !timestamp(entry.expires) || (entry.device !== null && typeof entry.device !== 'string') || !Array.isArray(entry.rows)) throw new Error('Invalid cached history');
    return { device: entry.device, from: entry.from, to: entry.to, expires: entry.expires, rows: entry.rows.map(hydrateReading) };
  });
  return { version: CACHE_VERSION, target: cacheTarget(target), savedAt: value.savedAt, scan, rows, history };
}

async function atomicWrite(path, value, io = fs, maxBytes = MAX_FILE_BYTES) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Cache file exceeds size limit');
  await io.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await io.rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await io.unlink(temporary).catch(() => {});
  }
}

// Debounced writes are serialized, including changes arriving during a write.
// Failed writes leave the previous atomic file intact and pending data retryable.
export class FileCache {
  constructor(path, target, { debounceMs = 250, io = fs, onError = () => {}, validator = validateCache,
    maxBytes = MAX_FILE_BYTES, protectInvalid = false } = {}) {
    this.path = path;
    this.target = target;
    this.debounceMs = debounceMs;
    this.io = io;
    this.onError = onError;
    Object.assign(this, { validator, maxBytes, protectInvalid });
    this.blocked = false;
    this.pending = null;
    this.writing = null;
    this.timer = null;
  }

  async load() {
    if (!this.path) return null;
    try {
      const stat = await this.io.stat(this.path);
      if (stat.size > this.maxBytes) throw new Error('Cache file exceeds size limit');
      return this.validator(JSON.parse(await this.io.readFile(this.path, 'utf8')), this.target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.blocked = this.protectInvalid;
        if (this.blocked) this.pending = null;
        this.onError(error);
      }
      return null;
    }
  }

  schedule(value) {
    if (!this.path || this.blocked) return;
    this.pending = value;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.debounceMs);
      this.timer.unref?.();
    }
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.pending) {
        const value = this.pending;
        this.pending = null;
        try { if (!this.blocked) await atomicWrite(this.path, value, this.io, this.maxBytes); }
        catch (error) {
          this.pending ??= value;
          this.onError(error);
          return false;
        }
      }
      return true;
    })();
    try { return await this.writing; }
    finally { this.writing = null; }
  }
}

// Maintenance must stop the server first. Keep recent rows/cursor because the
// downsampler only changes older history. Fail closed on any non-ENOENT I/O error.
export async function invalidateFileCache(path, target) {
  if (!path) return false;
  let text;
  try { text = await fs.readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // Fail closed: an unexpected file must be inspected, not overwritten/deleted.
  const value = validateCache(JSON.parse(text), target);
  value.history = [];
  await atomicWrite(path, value);
  return true;
}
