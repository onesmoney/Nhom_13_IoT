import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileCache, cacheTarget, hydrateReading } from './fileCache.js';

export const HISTORY_ARCHIVE_TTL_MS = 3 * 86400000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MANAGED_FILE = /^([a-f0-9]{64})\.([0-9]{1,16})\.json$/;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queryKey = ({ device, from, to }) => ({ device: device || null, from, to });

// Historical snapshots deliberately remain unchanged for three days. They are
// separate from recent reconciliation/manifests and contain normalized rows only.
export class HistoryArchive {
  constructor(cacheFile, target, { now = Date.now, io = fs, onError = () => {},
    memoryBytes = 32 * 1024 * 1024, memoryEntries = 32, cleanupMs = 60000 } = {}) {
    this.target = { ...cacheTarget({ ...target, databaseURL: target.databaseURL || 'https://unconfigured.invalid' }),
      aggregatePath: target.aggregatePath || null };
    this.directory = cacheFile ? join(`${cacheFile}.history-v1`, hash(this.target)) : null;
    Object.assign(this, { now, io, onError, memoryBytes, memoryEntries, cleanupMs });
    this.memory = new Map(); this.files = new Map(); this.inflight = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.cleanup(); }, this.cleanupMs);
    this.timer.unref?.();
    void this.cleanup();
  }

  async initialize() {
    this.initializing ??= (async () => {
      if (!this.directory) return;
      let names;
      try { names = await this.io.readdir(this.directory); }
      catch (error) { if (error.code !== 'ENOENT') this.onError(error); return; }
      for (const name of names) {
        const match = MANAGED_FILE.exec(name);
        if (!match || !Number.isSafeInteger(Number(match[2]))) continue;
        // File names encode expiry, so sweeping never reads large payloads.
        this.files.set(name, { key: match[1], expires: Number(match[2]) });
      }
    })();
    await this.initializing;
  }

  async removeFile(name) {
    if (!this.directory || !MANAGED_FILE.test(name)) return;
    try { await this.io.unlink(join(this.directory, name)); this.files.delete(name); }
    catch (error) {
      if (error.code === 'ENOENT') this.files.delete(name);
      else this.onError(error);
    }
  }

  async cleanup() {
    await this.initialize();
    const now = this.now();
    for (const [key, entry] of this.memory) if (entry.expires <= now) this.memory.delete(key);
    for (const [name, entry] of this.files) if (entry.expires <= now) await this.removeFile(name);
  }

  remember(key, entry) {
    this.memory.delete(key); this.memory.set(key, entry);
    let bytes = [...this.memory.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (this.memory.size > this.memoryEntries || bytes > this.memoryBytes) {
      const oldest = this.memory.keys().next().value;
      bytes -= this.memory.get(oldest).bytes; this.memory.delete(oldest);
    }
  }

  validate(value, query, expires) {
    const { checksum, ...payload } = value || {};
    if (payload.version !== 1 || hash(payload.target) !== hash(this.target) ||
        hash(payload.query) !== hash(query) || !Number.isSafeInteger(payload.savedAt) ||
        payload.savedAt < 0 || payload.savedAt > this.now() ||
        payload.expires !== expires || payload.expires - payload.savedAt !== HISTORY_ARCHIVE_TTL_MS ||
        !Array.isArray(payload.rows) || payload.rows.length > 100000 || checksum !== hash(payload)) {
      throw Error('Invalid historical cache snapshot');
    }
    const rows = payload.rows.map(hydrateReading);
    if (rows.some((row) => (query.device && row.device !== query.device) || (row.aggregation
      ? row.aggregation.bucketStart > query.to || row.aggregation.bucketEnd <= query.from
      : row.time < query.from || row.time > query.to))) throw Error('Historical cache range mismatch');
    return { ...payload, rows, bytes: Buffer.byteLength(JSON.stringify(value)) };
  }

  async read(key, query) {
    await this.cleanup();
    const memory = this.memory.get(key);
    if (memory && memory.expires > this.now()) { this.remember(key, memory); return memory.rows; }
    if (memory) this.memory.delete(key);
    for (const [name, { key: fileKey, expires }] of this.files) {
      if (fileKey !== key) continue;
      if (expires <= this.now()) { await this.removeFile(name); continue; }
      const file = new FileCache(join(this.directory, name), this.target, {
        io: this.io, onError: this.onError, maxBytes: MAX_FILE_BYTES,
        validator: (value) => this.validate(value, query, expires),
      });
      const entry = await file.load();
      if (!entry) { await this.removeFile(name); continue; }
      if (entry.expires <= this.now()) { await this.removeFile(name); continue; }
      this.remember(key, entry); return entry.rows;
    }
    return null;
  }

  async write(key, query, rows) {
    if (rows.length > 100000) throw Error('Historical cache snapshot exceeds row limit');
    const savedAt = this.now(), expires = savedAt + HISTORY_ARCHIVE_TTL_MS;
    const payload = { version: 1, target: this.target, query, savedAt, expires, rows: rows.map(hydrateReading) };
    const value = { ...payload, checksum: hash(payload) };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_FILE_BYTES) throw Error('Historical cache snapshot exceeds 64 MiB');
    this.remember(key, { ...payload, bytes });
    if (!this.directory) return payload.rows;
    const name = `${key}.${expires}.json`;
    const file = new FileCache(join(this.directory, name), this.target, {
      io: this.io, onError: this.onError, maxBytes: MAX_FILE_BYTES,
    });
    file.schedule(value);
    if (await file.flush()) this.files.set(name, { key, expires });
    return payload.rows;
  }

  getOrLoad(options, load) {
    if (this.invalidating) return this.invalidating.then(() => this.getOrLoad(options, load));
    const query = queryKey(options), key = hash(query);
    if (this.inflight.has(key)) return this.inflight.get(key);
    this.start();
    const work = (async () => {
      const cached = await this.read(key, query);
      if (cached) return cached; // Includes completed, empty days.
      const rows = await load(); // Only a successful complete scan is saved.
      try { return await this.write(key, query, rows); }
      catch (error) { this.onError(error); return rows; }
    })();
    this.inflight.set(key, work);
    work.finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); }).catch(() => {});
    return work;
  }

  // Explicit device backfills supersede the normal three-day snapshot TTL.
  // Let older writes finish before removal; gate new reads until it completes.
  invalidate() {
    if (this.invalidating) return this.invalidating;
    this.invalidating = (async () => {
      await this.initialize();
      await Promise.allSettled([...this.inflight.values()]);
      this.memory.clear();
      for (const name of [...this.files.keys()]) {
        await this.removeFile(name);
        if (this.files.has(name)) throw Error('Could not invalidate historical backfill cache');
      }
    })().finally(() => { this.invalidating = null; });
    return this.invalidating;
  }

  async stop() {
    clearInterval(this.timer); this.timer = null;
    await Promise.allSettled([...this.inflight.values()]);
    await this.invalidating;
  }
}
