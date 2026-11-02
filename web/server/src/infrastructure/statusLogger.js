// No config, Firebase, timers or server imports: usable with snapshots and fake I/O.
export function safeLogText(value, limit = 240) {
  if (typeof value !== 'string') return '-';
  return value.slice(0, 4096)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    // Error messages sometimes embed request/config JSON or sample payloads.
    .replace(/(?:\{|\[\s*(?:[\[{"]|[-\d]|true\b|false\b|null\b))[\s\S]*$/, '[structured data omitted]')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url redacted]')
    .replace(/\b[\w.-]+\.(?:firebaseio\.com|firebasedatabase\.app)\b/gi, '[database redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:[\w-]*(?:token|password|secret|credential)|(?:FIREBASE_)?API[_-]?KEY|databaseURL|FIREBASE_DATABASE_URL|authorization)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[credential redacted]')
    .replace(/\bAIza[\w-]+|\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, '[credential redacted]')
    .replace(/\b(?:sensors|payload)\s*[=:][\s\S]*/gi, '[payload omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function safeLogCode(value, fallback) {
  return typeof value === 'string' && /^[\w/-]{1,96}$/.test(value) ? value : fallback;
}
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const elapsed = (start, end) => Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
const COUNT_KEYS = ['scanned', 'buckets', 'summaries', 'deleted', 'alreadyAbsent', 'changed', 'late', 'invalid', 'oversized', 'errors'];
const countsText = (counts) => COUNT_KEYS.map((key) => `${key}=${count(counts?.[key])}`).join(' ');
const errorHint = (code) => /permission|denied/i.test(code) ? 'Check backend identity and Firebase rules; do not open public writes.'
  : /auth/i.test(code) ? 'Check Firebase authentication configuration.'
    : /timeout|network/i.test(code) ? 'Check connectivity and /api/status deadlines.'
      : 'Check /api/status, permissions and data integrity before retrying.';

export class StatusLogger {
  constructor({ logger = console, now = Date.now, progressMs = 5000, progressRows = 10000 } = {}) {
    Object.assign(this, { logger, now, progressMs, progressRows });
    this.previous = null;
  }

  write(level, event, detail = '') {
    // Diagnostic output must never interrupt synchronization or transactions.
    try { this.logger[level](`[${new Date(this.now()).toISOString()}] ${event}${detail ? ` ${detail}` : ''}`); }
    catch { /* A broken terminal/logger is not a backend failure. */ }
  }

  startup() { this.write('info', 'backend.start'); }
  listening(port) { this.write('info', 'backend.listening', `port=${count(port)}`); }
  shutdown(error) {
    if (!error) this.write('info', 'backend.stopped');
    else this.write('error', 'backend.shutdown.error', `code=${safeLogCode(error.code, 'SHUTDOWN_FAILED')} detail=${safeLogText(error.message)}`);
  }

  observe(status) {
    const previous = this.previous;
    const sync = status.sync || {}, oldSync = previous?.sync || {};
    const compaction = status.compaction || {}, oldCompaction = previous?.compaction || {};
    const now = this.now();
    if (status.cache?.restoredAt != null && status.cache.restoredAt !== previous?.cacheRestoredAt) {
      this.write('info', 'cache.restore', `rows=${count(status.records)} savedAt=${count(status.cache.savedAt)} stale=true`);
    }
    if (sync.reason && sync.reason !== oldSync.reason) this.write('info', 'sync.source', `reason=${safeLogText(sync.reason, 40)}`);
    if (!previous || status.connection !== previous.connection || status.firebase !== previous.firebase) {
      this.write('info', 'firebase.state', `connection=${safeLogText(status.connection, 32)} state=${safeLogText(status.firebase, 32)}`);
    }
    if ((!previous || oldSync.phase !== sync.phase) && ['connecting', 'waiting-connection'].includes(sync.phase)) {
      this.write('info', oldSync.phase === 'error' ? 'sync.retry' : 'sync.wait', `phase=${sync.phase}`);
    }
    const newScan = sync.phase === 'scanning' && (oldSync.phase !== 'scanning' || sync.startedAt !== oldSync.startedAt || sync.rows < oldSync.rows || sync.pages < oldSync.pages);
    const syncTotals = `rows=${count(sync.rows)} pages=${count(sync.pages)} attempt=${count(sync.attempt)}`;
    if (newScan) {
      this.syncProgressAt = now; this.syncProgressRows = count(sync.rows);
      this.write('info', 'sync.start', `mode=${safeLogText(status.queryLimits?.recentScanMode, 16)} ${syncTotals}`);
    } else if (sync.phase === 'scanning' && (sync.rows !== oldSync.rows || sync.pages !== oldSync.pages)) {
      if (now - this.syncProgressAt >= this.progressMs || count(sync.rows) - this.syncProgressRows >= this.progressRows) {
        this.write('info', 'sync.progress', `${syncTotals} elapsedMs=${elapsed(sync.startedAt, now)}`);
        this.syncProgressAt = now; this.syncProgressRows = count(sync.rows);
      }
    }
    if (sync.phase === 'scanning' && count(sync.attempt) > 1 && sync.attempt !== oldSync.attempt) {
      this.write('info', 'sync.reconcile.retry', `code=RECONCILIATION_CHANGED attempt=${count(sync.attempt)}`);
    }
    if (sync.phase === 'complete' && (oldSync.phase !== 'complete' || sync.completedAt !== oldSync.completedAt)) {
      this.write('info', 'sync.complete', `${syncTotals} elapsedMs=${elapsed(sync.startedAt, sync.completedAt)}`);
    }
    if (sync.phase === 'error' && (oldSync.phase !== 'error' || sync.code !== oldSync.code || sync.detail !== oldSync.detail || status.lastError?.at !== previous?.errorAt)) {
      const code = safeLogCode(sync.code, 'SYNC_FAILED');
      this.write('error', 'sync.error', `code=${code} ${syncTotals} elapsedMs=${elapsed(sync.startedAt, now)} retryMs=15000 detail=${safeLogText(sync.detail || status.lastError?.message || status.error)} hint=${safeLogText(status.error || errorHint(code))}`);
    }

    if (!previous || compaction.enabled !== oldCompaction.enabled) {
      this.write('info', 'compaction.state', `enabled=${compaction.enabled === true}`);
    }
    if (compaction.running && !oldCompaction.running) {
      this.compactionStartedAt = now; this.bucketProgressAt = now; this.bucketProgressDeleted = 0; this.bucketLogged = false;
      this.write('info', 'compaction.start');
    }
    const bucket = compaction.lastBucket;
    const newBucket = bucket && (bucket.number !== oldCompaction.lastBucket?.number || bucket.completedAt !== oldCompaction.lastBucket?.completedAt);
    if (compaction.running && newBucket && (!this.bucketLogged || now - this.bucketProgressAt >= this.progressMs || count(compaction.lastCounts?.deleted) - this.bucketProgressDeleted >= this.progressRows)) {
      this.write('info', 'compaction.progress', `bucket=${count(bucket.start)} device=${safeLogText(bucket.device, 96)} ${this.compactionTotals(compaction)} elapsedMs=${elapsed(this.compactionStartedAt, now)}`);
      this.bucketLogged = true; this.bucketProgressAt = now; this.bucketProgressDeleted = count(compaction.lastCounts?.deleted);
    }
    // Always flush final totals and the latest error, even after a throttled bucket.
    if (!compaction.running && oldCompaction.running) {
      const detail = `${this.compactionTotals(compaction)} elapsedMs=${elapsed(this.compactionStartedAt, now)}`;
      if (compaction.error) {
        const code = safeLogCode(compaction.errorCode, 'COMPACTION_FAILED');
        this.write('error', 'compaction.error', `${detail} code=${code} detail=${safeLogText(compaction.error)} hint=${errorHint(code)} Failed buckets retry on a later sweep.`);
      } else this.write('info', 'compaction.complete', detail);
    }
    // Store only copied diagnostic primitives, never retain mutable count objects,
    // sensor payloads, Firebase configuration or entire status snapshots.
    this.previous = { connection: status.connection, firebase: status.firebase, errorAt: status.lastError?.at,
      cacheRestoredAt: status.cache?.restoredAt,
      sync: { reason: sync.reason, phase: sync.phase, startedAt: sync.startedAt, completedAt: sync.completedAt, rows: sync.rows, pages: sync.pages, attempt: sync.attempt, code: sync.code, detail: sync.detail },
      compaction: { enabled: compaction.enabled, running: compaction.running,
        lastBucket: bucket ? { number: bucket.number, completedAt: bucket.completedAt } : null } };
  }

  compactionTotals(state) {
    const sourceId = count(state.lastCounts?.deleted) > 0 ? safeLogText(state.lastDeletion?.sourceId, 96) : '-';
    return `${countsText(state.lastCounts)} lastConfirmedSourceId=${sourceId}`;
  }
}
