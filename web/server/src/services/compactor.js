import { normalizeReading } from '../domain/readings.js';
import { BUCKET_MS, SKEW_MS, bucketOf, sourceRow, summaryId, buildSummary, validateSummary, fingerprint } from '../domain/compaction.js';

export class Compactor {
  // Internal callers can opt out; production config always enables this worker.
  constructor({ enabled = false, retainMs = 86400000, intervalMs = 60000, pageSize = 1000,
    maxRows = 10000, maxBytes = 8388608, windowsPerTick = 8 } = {}, io) {
    if (!Number.isFinite(retainMs) || retainMs <= 0 || retainMs > Number.MAX_SAFE_INTEGER) throw Error('Invalid compaction retainMs');
    for (const [key, value] of Object.entries({ intervalMs, pageSize, maxRows, maxBytes, windowsPerTick })) {
      if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid compaction ${key}`);
    }
    Object.assign(this, { io, retainMs, intervalMs, pageSize, maxRows, maxBytes, windowsPerTick });
    this.state = { enabled, running: false, error: null, errorCode: null, lastBucket: null, lastScanAt: null, lastCounts: null, lastDeletion: null, cursor: null,
      lateDataPolicy: 'retain-unlisted-or-changed-raw; immutable-summary', oversizedPolicy: 'retain-raw-and-continue' };
  }
  start() {
    if (!this.state.enabled || this.stopped || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs); this.timer.unref?.();
    void this.tick();
  }
  tick() {
    if (this.work) return this.work;
    if (!this.state.enabled || this.stopped) return Promise.resolve();
    this.state.running = true; this.state.lastBucket = null; this.io.status?.();
    this.work = this.scan().catch((error) => {
      this.state.error = error.message; this.state.errorCode = error.code || 'COMPACTION_SCAN_FAILED';
      this.state.lastCounts.errors = (this.state.lastCounts.errors || 0) + 1;
    }).finally(() => {
      this.state.running = false; this.work = null; this.io.status?.();
    });
    return this.work;
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.work; }
  async scan() {
    // Only whole buckets ending at/before the retention cutoff are eligible.
    const now = this.io.now(), cutoff = bucketOf(now - this.retainMs);
    const counts = { scanned: 0, buckets: 0, summaries: 0, deleted: 0, alreadyAbsent: 0, changed: 0, late: 0, invalid: 0, oversized: 0 };
    this.state.lastScanAt = now; this.state.lastCounts = counts; this.state.error = null; this.state.errorCode = null;
    let lastProgressAt = now, lastProgressDeleted = 0, reportedBucket = false;
    const page = await this.io.readPage({ after: this.state.cursor, to: cutoff, limit: this.pageSize });
    if (!page.length) { this.state.cursor = null; return; } // periodic full rescan, including late inserts
    const visited = new Set();
    for (const entry of page) {
      if (this.stopped) break;
      if (this.state.cursor && entry.id <= this.state.cursor) throw Error('Compaction cursor did not advance');
      const row = sourceRow(entry.id, entry.value);
      const start = row ? bucketOf(row.time) : null;
      const key = row ? summaryId(row.device, start) : null;
      let completedBucket = false;
      if (row && start + BUCKET_MS <= cutoff && !visited.has(key)) {
        if (visited.size >= this.windowsPerTick) break;
        visited.add(key); counts.buckets++;
        try { await this.compactBucket(row.device, start, counts); }
        catch (error) {
          // A poisoned/denied bucket must not starve every newer bucket. Retry
          // it on the next full sweep; partial deletes remain manifest-safe.
          counts.errors = (counts.errors || 0) + 1;
          this.state.error = error.message;
          this.state.errorCode = error.code || 'COMPACTION_BUCKET_FAILED';
        }
        this.state.lastBucket = { number: counts.buckets, device: row.device, start, completedAt: this.io.now() };
        completedBucket = true;
      } else if (!row) counts.invalid++;
      counts.scanned++; this.state.cursor = entry.id;
      // Publish after awaited bucket work, never per source transaction. First
      // bucket is immediate; subsequent notifications are bounded like logs.
      if (completedBucket && (!reportedBucket || this.io.now() - lastProgressAt >= 5000 || counts.deleted - lastProgressDeleted >= 10000)) {
        this.io.status?.(); reportedBucket = true;
        lastProgressAt = this.io.now(); lastProgressDeleted = counts.deleted;
      }
    }
  }
  async compactBucket(device, start, counts) {
    const entries = []; let after, used = 0;
    while (true) {
      const page = await this.io.readPage({ from: Math.max(0, start - SKEW_MS), to: start + BUCKET_MS + SKEW_MS, after,
        limit: Math.min(this.pageSize, this.maxRows - entries.length + 1) });
      if (!page.length) break;
      for (const entry of page) {
        if (after && entry.id <= after) throw Error('Bucket cursor did not advance');
        after = entry.id; used += Buffer.byteLength(JSON.stringify(entry)); entries.push(entry);
        if (entries.length > this.maxRows || used > this.maxBytes) { counts.oversized++; return; }
      }
      if (this.stopped) return;
    }
    // Never fold leftovers into a second summary of an inline summarized bucket.
    if (entries.some(({ id, value }) => value?.deviceName === device && Object.hasOwn(value, 'aggregation') &&
        (!normalizeReading(id, value)?.aggregation || value.aggregation.bucketStart === start))) { counts.invalid++; return; }
    const originals = entries.filter(({ id, value }) => { const row = sourceRow(id, value); return row?.device === device && bucketOf(row.time) === start; });
    if (!originals.length) return;
    const candidate = buildSummary(originals, device, start);
    // The transaction result is the server-acknowledged immutable value. Another
    // worker can win with a different snapshot; always use the winning manifest.
    const result = await this.io.summaryTransaction(candidate.id, (current) => {
      if (current === null) return candidate.value;
      validateSummary(candidate.id, current);
      return current;
    });
    if (result.committed !== true) throw Error('Summary transaction did not commit');
    const persisted = result.snapshot.val();
    const { sources, row } = validateSummary(candidate.id, persisted);
    if (row.device !== device || row.aggregation.bucketStart !== start) throw Error('Summary CAS identity mismatch');
    counts.summaries++;
    this.io.invalidate?.(sources, row);
    for (const { id, value } of originals) {
      if (this.stopped) break;
      const source = sources[id];
      if (!source || source.fingerprint !== fingerprint(value)) { counts.late++; continue; }
      const deleted = await this.io.sourceTransaction(id, (current) => {
        if (current === null) return null; // allow SDK server CAS retry after initially empty local cache
        if (fingerprint(current) !== source.fingerprint) return; // atomic compare, never blind delete
        return null;
      });
      const exists = deleted.snapshot.exists();
      if (deleted.committed === true) {
        if (exists !== false) throw Error('Source deletion transaction committed but snapshot is not empty');
        // Confirms absence at commit, not a unique removal or permanent absence.
        counts.deleted++;
        this.state.lastDeletion = { sourceId: id, summaryId: candidate.id, confirmedAt: this.io.now(),
          confirmation: 'transaction-committed-empty-snapshot' };
      } else if (exists === false) counts.alreadyAbsent++;
      else { counts.changed++; break; }
    }
    this.io.invalidate?.(sources, row);
  }
}
