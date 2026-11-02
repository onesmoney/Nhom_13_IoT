import { EventEmitter } from 'node:events';
import { safeLogText } from '../infrastructure/statusLogger.js';
import { Compactor } from './compactor.js';
import { BUCKET_MS, fingerprint, mergeReadings, validatePaths, validateSummary } from '../domain/compaction.js';
import { FileCache, CACHE_VERSION, cacheTarget } from '../infrastructure/cache/fileCache.js';
import { createMixedCache, mixedPayload, MIXED_CACHE_MAX_ROWS, MIXED_CACHE_MAX_BYTES } from '../infrastructure/cache/mixedCache.js';
import { createSummaryInventory } from '../infrastructure/firebase/summaryInventory.js';
import { createSensorAdapter } from '../infrastructure/firebase/sensorAdapter.js';
import { normalizeReading, timeToPushPrefix } from '../domain/readings.js';
import { calendarBounds, addDays, shiftMonth, todayVN } from '../../../shared/time.mjs';

export const PAGE_SIZE = 1000;
export const MAX_QUERY_ROWS = 100000;
export const MAX_MIXED_QUERY_BYTES = 32 * 1024 * 1024;
const MAX_RECENT_ATTEMPTS = 2;
// Explicit source revision: distinguishes a loaded process from files edited on disk.
export const BUILD_REVISION = 'quota-mixed-durable-v4';
const RUNTIME = Object.freeze({ buildRevision: BUILD_REVISION, pid: process.pid,
  startedAt: Math.round(Date.now() - process.uptime() * 1000) });
// Push keys record receipt time, while rows use the device timestamp. Read a
// bounded overlap for small clock/network delays, then filter by timestamp.
export const HISTORY_KEY_OVERLAP_MS = 60000;
const historyKeyBounds = ({ from, to }) => ({ from: from - HISTORY_KEY_OVERLAP_MS, to: to + HISTORY_KEY_OVERLAP_MS });
const budgetError = () => Object.assign(new Error('Truy vấn vượt 100.000 bản ghi. Hãy chọn ít ngày hơn; lịch theo thiết bị cần chỉ mục riêng nếu dữ liệu quá lớn.'), { status: 422 });

// The scanned cursor is independent of listener rows: a newest-row event does
// not prove that the gap preceding it has been fetched. Only snapshots advance it.
export class SensorStore extends EventEmitter {
  constructor({ firebase, dataPath = 'sensorData', aggregatePath = null, compaction = {}, historyHours = 168, cacheFile = null,
    historyClosedTtlMs = 86400000, historyCurrentTtlMs = 30000,
    historyCacheEntries = 32, historyCacheBytes = 32 * 1024 * 1024,
    readTimeoutMs = 15000, syncTimeoutMs = 120000 },
  { readSnapshot, transaction, now = Date.now, fileCacheOptions, connect, listen, summaryInventory,
    realtime, adapter = createSensorAdapter({ readSnapshot, transaction, realtime }) } = {}) {
    super();
    this.adapter = adapter;
    this.readSnapshot = readSnapshot ?? adapter.readSnapshot;
    for (const value of [readTimeoutMs, syncTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid synchronization timeout');
    }
    this.readTimeoutMs = readTimeoutMs;
    this.syncTimeoutMs = syncTimeoutMs;
    this.pendingReads = new Set();
    this.syncStatus = { phase: 'idle', startedAt: null, completedAt: null, pages: 0, rows: 0, attempt: 0, code: null, detail: null };
    this.now = now;
    this.connect = connect;
    this.listen = listen;
    this.realtime = realtime ?? adapter.realtime;
    this.historyCache = new Map();
    this.historyInflight = new Map();
    this.historyClosedTtlMs = historyClosedTtlMs;
    this.historyCurrentTtlMs = historyCurrentTtlMs;
    this.historyCacheEntries = historyCacheEntries;
    this.historyCacheBytes = historyCacheBytes;
    this.availabilityCache = new Map();
    this.firebaseConfig = firebase;
    Object.assign(this, validatePaths(dataPath, aggregatePath || (compaction.enabled ? 'sensorData5m' : null)));
    this.generation = 0;
    this.manifests = new Map();
    this.reconciledManifests = new Set();
    this.coveredSources = new Map();
    this.recentCoverage = null;
    this.compactor = new Compactor(compaction, {
      now, status: () => this.setState({}), invalidate: (sources, row) => this.invalidateMixed(sources, row),
      readPage: (options) => this.rawPage(this.dataRef, options),
      summaryTransaction: (id, update) => this.adapter.transaction(this.aggregateRef, id, update),
      sourceTransaction: (id, update) => this.adapter.transaction(this.dataRef, id, update),
    });
    this.historyMs = historyHours * 3600 * 1000;
    this.readings = [];
    this.ids = new Set();
    this.scan = null;
    this.state = { firebase: 'connecting', error: null, lastError: null, loadedAt: null, cacheError: null };
    this.wasOnline = false;
    this.stopped = false;
    this.failureVersion = 0;
    this.connectionVersion = 0;
    this.unsubscribers = [];
    this.cacheSavedAt = null;
    this.cacheRestoredAt = null;
    this.cacheSource = 'none';
    this.summaryInventory = summaryInventory || (this.aggregatePath ? createSummaryInventory({
      databaseURL: firebase.databaseURL, aggregatePath: this.aggregatePath,
    }, { getUser: () => this.app ? this.adapter.auth(this.app).currentUser : null }) : null);
    const target = { databaseURL: firebase.databaseURL, dataPath: this.dataPath, aggregatePath: this.aggregatePath };
    const diskOptions = { ...fileCacheOptions, onError: (error) => {
      this.setState({ cacheError: error.message });
      fileCacheOptions?.onError?.(error);
    } };
    this.disk = this.aggregatePath ? createMixedCache(cacheFile, target, diskOptions) : new FileCache(cacheFile, target, diskOptions);
  }

  loadCache() {
    this.cacheLoading ??= this.hydrateCache();
    return this.cacheLoading;
  }

  async hydrateCache() {
    const cached = await this.disk.load();
    if (!cached) return;
    if (this.aggregatePath) {
      const cutoff = Math.max(0, this.now() - this.historyMs);
      this.recentCoverage = cached.scan ? { ...cached.scan, from: Math.max(cached.scan.from, cutoff) } : null;
      this.manifests = new Map(cached.manifests.filter(({ summary }) => summary.aggregation.bucketEnd > this.now() - this.historyMs)
        .map((manifest) => [manifest.summary.id, manifest]));
      this.reconciledManifests = new Set(this.manifests.keys());
      this.rebuildCoverage();
    } else this.scan = cached.scan;
    this.cacheSource = 'disk'; this.cacheSavedAt = cached.savedAt; this.cacheRestoredAt = this.now();
    for (const row of cached.rows) this.insert(row, false, false);
    for (const entry of cached.history) {
      if (entry.expires > this.now()) this.historyCache.set(this.historyKey(entry), entry);
    }
    this.trimHistory();
    this.setState({ loadedAt: cached.savedAt });
  }

  persist() {
    if (!this.disk.path || this.disk.blocked) return;
    if (this.aggregatePath) {
      // Only serialize a coherent snapshot; cursor advances only at scan commit.
      if (!this.recentCoverage || this.recentCoverage.from > this.recentCoverage.through ||
          [...this.manifests.keys()].some((id) => !this.reconciledManifests.has(id))) return;
      this.disk.schedule(mixedPayload(this.disk.target, { savedAt: this.cacheSavedAt, scan: this.recentCoverage,
        rows: this.readings, manifests: this.manifests }));
      return;
    }
    this.trimHistory();
    this.disk.schedule({ version: CACHE_VERSION, target: cacheTarget(this.disk.target), savedAt: this.now(),
      scan: this.scan ? { ...this.scan } : null, rows: this.readings, history: [...this.historyCache.values()] });
  }

  start() {
    if (this.starting) return this.starting;
    if (this.stopped) return Promise.resolve();
    this.starting = this.startInternal().finally(() => { this.starting = null; });
    return this.starting;
  }

  async startInternal() {
    clearTimeout(this.retryTimer);
    try {
      await this.loadCache(); // Available even when authentication/network fails.
      if (this.stopped) return;
      // A retry/start request must not reset progress or replace listeners while
      // a healthy scan is already running. Failed/aborted work must settle first.
      if (this.syncing) {
        if (!this.syncContext?.signal.aborted) { await this.syncing; return; }
        await this.syncing.catch(() => {});
        if (this.stopped) return;
      }
      this.syncStatus = { ...this.syncStatus,
        phase: this.connected === false ? 'waiting-connection' : 'connecting', code: null, detail: null };
      this.setState({ firebase: this.connected === false ? 'offline' : 'connecting', error: null });
      if (this.connect) this.dataRef = await this.bounded(() => this.connect());
      else {
        this.app ??= this.adapter.initialize(this.firebaseConfig);
        await this.bounded(() => this.adapter.authenticate(this.app));
        this.dataRef = this.adapter.reference(this.app, this.dataPath);
      }
      if (this.stopped) return;
      if (this.aggregatePath) this.aggregateRef = this.adapter.childReference(this.dataRef.root, this.aggregatePath);
      this.cleanupListeners();
      // Observe transport separately from synchronization. Reads are not proof
      // of connectivity: the SDK can satisfy get() from an active query cache.
      // Do not overwrite an active scan or publish waiting with online transport.
      // backfill owns the atomic transition to scanning below.
      const failureVersion = this.failureVersion;
      // Install the bounded listener before scanning so no post-snapshot gap is lost.
      const onCancel = (error) => { if (!this.stopped) this.syncFailure(error); };
      if (this.listen) this.unsubscribers = this.listen(this, onCancel) || [];
      else {
        this.adapter.subscribe({
          dataRef: this.dataRef, aggregateRef: this.aggregatePath ? this.aggregateRef : null,
          realtime: this.realtime, unsubscribers: this.unsubscribers, onCancel,
          onRaw: (child) => { if (!this.stopped) this.add(child.key, child.val(), true); },
          onSummary: (child) => {
            if (this.stopped) return;
            try {
              const { sources, row } = validateSummary(child.key, child.val());
              this.invalidateMixed(sources, row);
            } catch (error) { this.syncFailure(error); }
          },
          onConnection: (snap) => { void this.onConnection(snap.val() === true); },
        });
      }
      if (this.stopped || failureVersion !== this.failureVersion) return;
      this.pruneTimer ??= setInterval(() => { void this.maintain(); }, 60000);
      this.pruneTimer.unref?.();
      // Start bounded backlog work even if recent history exceeds query budget.
      this.compactor.start();
      if (this.connected !== false) await this.backfill();
      else this.waitForConnection();
    } catch (error) { if (!this.stopped) this.syncFailure(error); }
  }

  cleanupListeners() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  waitForConnection() {
    clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => {
      if (!this.stopped && this.connected !== true) this.syncFailure(syncError('CONNECTION_TIMEOUT'));
    }, this.readTimeoutMs);
    this.connectionTimer.unref?.();
  }

  syncFailure(error) {
    if (this.stopped || error?.code === 'CONNECTION_CHANGED') return;
    // The scan and its callers can observe the same rejection; record it once.
    if (error && error === this.lastFailure && this.syncStatus.phase === 'error') return;
    this.lastFailure = error;
    this.failureVersion++;
    this.wasOnline = false;
    this.syncContext?.abort(error);
    this.maintenanceContext?.abort(error);
    this.syncStatus = { ...this.syncStatus, phase: 'error', code: error?.code || 'SYNC_FAILED',
      detail: safeLogText(error?.message) };
    // Keep the existing frontend error contract; transport is reported separately.
    const message = describeFirebaseError(error, this.dataPath);
    this.setState({ firebase: 'error', error: message,
      lastError: { code: this.syncStatus.code, message, at: this.now() } });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { void this.start(); }, 15000);
    this.retryTimer.unref?.();
  }

  async onConnection(connected) {
    if (this.stopped) return;
    if (this.connected === connected) {
      // Repeated true is also delivered when retry installs a fresh listener.
      // Coalesce healthy work, but recover failed/missing synchronization even
      // without a false->true edge. start() also replaces cancelled listeners.
      if (!connected || !this.dataRef) return;
      if (this.syncing && !this.syncContext?.signal.aborted) {
        await this.syncing.catch(() => {});
      } else if (!this.wasOnline || this.syncStatus.phase === 'error') {
        await this.start();
      }
      return;
    }
    const connectionVersion = ++this.connectionVersion;
    this.connected = connected;
    this.wasOnline = false;
    clearTimeout(this.connectionTimer);
    // Also invalidate an optimistic startup scan on the first connected event.
    // It belongs to the previous connection version and must not block this one.
    const error = syncError('CONNECTION_CHANGED');
    this.syncContext?.abort(error);
    this.maintenanceContext?.abort(error);
    for (const cancel of [...this.pendingReads]) cancel(error);
    if (!connected) {
      this.wasOnline = false;
      this.syncStatus = { ...this.syncStatus, phase: 'waiting-connection', code: null, detail: null };
      this.setState({ firebase: 'offline' });
      this.waitForConnection();
      return;
    }
    this.syncStatus = { ...this.syncStatus, phase: 'connecting', code: null, detail: null };
    this.setState({ firebase: 'connecting', error: null });
    // A reconnect must not coalesce onto a scan from the previous connection.
    // Abort settles it even if the SDK's underlying get() never settles.
    if (this.syncing) await this.syncing.catch(() => {});
    if (this.stopped || connectionVersion !== this.connectionVersion) return;
    try { await this.backfill(); }
    catch (error) { this.syncFailure(error); }
  }

  // SDK get() has no cancellation/timeout and may use an active-listener cache.
  // Bound our wait and ignore late completions; never let them mutate coverage.
  bounded(load, { signal, timeoutMs = this.readTimeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.stopped) return Promise.reject(syncError('STORE_STOPPED'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pendingReads.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = (error) => finish(error);
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(syncError('READ_TIMEOUT')), timeoutMs);
      this.pendingReads.add(cancel);
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => settled ? undefined : load()).then((value) => finish(null, value), cancel);
    });
  }

  async readPageSnapshot(target, context) {
    context?.signal.throwIfAborted();
    const version = this.connectionVersion;
    const snap = await this.bounded(() => this.readSnapshot(target), { signal: context?.signal });
    context?.signal.throwIfAborted();
    if (version !== this.connectionVersion) throw syncError('CONNECTION_CHANGED');
    if (context && context === this.syncContext) {
      let rows = 0; snap.forEach(() => { rows++; });
      this.syncStatus = { ...this.syncStatus, pages: this.syncStatus.pages + 1,
        rows: this.syncStatus.rows + rows, lastProgressAt: this.now() };
      this.setState({});
    }
    return snap;
  }

  backfill() {
    if (this.syncing) return this.syncing;
    if (this.stopped) return Promise.reject(syncError('STORE_STOPPED'));
    if (this.connected === false) return Promise.reject(syncError('CONNECTION_CHANGED'));
    this.maintenanceContext?.abort(syncError('CONNECTION_CHANGED'));
    const context = new AbortController();
    const version = this.connectionVersion, failureVersion = this.failureVersion;
    this.syncContext = context;
    this.syncStatus = { ...this.syncStatus, phase: 'scanning', startedAt: this.now(),
      lastProgressAt: this.now(), pages: 0, rows: 0, attempt: 0, code: null, detail: null };
    // Only a new scan clears the current failure; lastError remains historical.
    // Keep explicit reconciliation online when already healthy, but never
    // advertise a failed/initial scan as ready merely because transport is connected.
    this.setState({ firebase: this.wasOnline ? 'online' : 'connecting', error: null });
    const timer = setTimeout(() => context.abort(syncError('SYNC_TIMEOUT')), this.syncTimeoutMs);
    this.syncing = this.bounded(() => this.scanRecent(context), { signal: context.signal, timeoutMs: this.syncTimeoutMs })
      .then(() => {
        context.signal.throwIfAborted();
        if (this.stopped || version !== this.connectionVersion || failureVersion !== this.failureVersion) throw syncError('CONNECTION_CHANGED');
        this.wasOnline = true;
        this.cacheSource = 'memory'; this.cacheSavedAt = this.now();
        clearTimeout(this.retryTimer);
        this.syncStatus = { ...this.syncStatus, phase: 'complete', completedAt: this.now(), code: null, detail: null };
        this.setState({ firebase: 'online', error: null, loadedAt: this.now() });
      }).catch((error) => {
        context.abort(error);
        if (error.code !== 'CONNECTION_CHANGED' && !this.stopped) this.syncFailure(error);
        throw error;
      }).finally(() => {
        clearTimeout(timer);
        if (this.syncContext === context) this.syncContext = null;
        this.syncing = null;
      });
    return this.syncing;
  }

  async maintain() {
    if (this.stopped) return;
    this.prune();
    if (this.state.firebase !== 'online' || this.connected === false || this.syncing) return;
    if (this.maintaining) return this.maintaining;
    const context = new AbortController();
    context.live = new Map();
    this.maintenanceContext = context;
    this.maintaining = this.bounded(async () => {
      await this.scanRecent(context);
    }, { signal: context.signal, timeoutMs: this.syncTimeoutMs }).catch((error) => {
      context.abort(error);
      if (!this.stopped) this.syncFailure(error);
    }).finally(() => {
      if (this.maintenanceContext === context) this.maintenanceContext = null;
      this.maintaining = null;
    });
    return this.maintaining;
  }

  async scanRecent(context) {
    if (this.aggregatePath) return this.scanMixedRecent(context);
    const cutoff = Math.max(0, this.now() - this.historyMs);
    const upper = timeToPushPrefix(this.now()); // fixed exclusive boundary, resumed next scan
    this.prune();
    // Expanding retention needs older rows. Reset coverage, retaining useful rows
    // and deduplicating them while a bounded full retained-range scan catches up.
    if (!this.scan || cutoff < this.scan.from) this.scan = { from: cutoff, cursor: null };
    else this.scan = { ...this.scan, from: cutoff };
    const lower = timeToPushPrefix(cutoff);
    if (this.scan.cursor && this.scan.cursor < lower) this.scan.cursor = null;
    while (!this.stopped) {
      context.signal.throwIfAborted();
      const cursor = this.scan.cursor;
      if (cursor && cursor >= upper) return;
      const snap = await this.readPageSnapshot(this.adapter.recentPageQuery(this.dataRef, { cursor, lower, upper, limit: PAGE_SIZE }), context);
      if (this.stopped) return;
      const children = [];
      snap.forEach((child) => { children.push(child); });
      if (!children.length) {
        // Prefix itself is shorter than every key in that millisecond, so
        // startAfter(prefix) includes all keys at the exclusive upper boundary.
        this.scan.cursor = upper;
        this.persist();
        await this.disk.flush();
        return;
      }
      const next = [...new Map(children.map((child) => [child.key, child])).values()]
        .filter((child) => (!cursor || child.key > cursor) && child.key >= lower && child.key < upper)
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      if (!next.length) throw new Error('Firebase pagination cursor did not advance');
      for (const child of next) {
        const row = normalizeReading(child.key, child.val());
        if (row) this.insert(row, true, false);
      }
      this.scan.cursor = next.at(-1).key;
      this.persist();
      await this.disk.flush(); // completed pages survive failures/restarts
    }
  }

  async scanMixedRecent(context) {
    context.live = new Map(); context.summaries = new Map();
    this.syncStatus.attempt = 1;
    const generation = this.generation;
    const to = this.now(), from = Math.max(0, to - this.historyMs);
    const previous = this.recentCoverage;
    const warm = previous && previous.from <= from && previous.through >= from && previous.through <= to;
    this.syncStatus.reason = warm ? (this.cacheSource === 'disk' ? 'warm-cache-delta' : 'incremental')
      : !previous ? 'cold-cache' : previous.from > from ? 'retention-expanded' : 'downtime-pruned';
    const rawFrom = Math.max(0, warm ? previous.through - HISTORY_KEY_OVERLAP_MS : from - HISTORY_KEY_OVERLAP_MS);
    const budget = { remaining: MAX_QUERY_ROWS, bytes: MAX_MIXED_QUERY_BYTES };
    const byId = new Map((warm ? this.readings : []).map((r) => [r.id, r]));
    const manifests = new Map([...this.manifests].filter(([, m]) => m.summary.aggregation.bucketEnd > from && m.summary.aggregation.bucketStart <= to));
    const readRaw = async (lower, upper) => {
      const seen = new Set();
      for await (const page of this.entryPages(this.dataRef, { from: lower, to: upper, context, budget })) {
        for (const { id, value } of page) {
          const row = normalizeReading(id, value);
          if (row) { seen.add(id); byId.set(id, { ...row, sourceFingerprint: fingerprint(value) }); }
        }
      }
      context.signal.throwIfAborted();
      // Only an exhausted interval proves absence. Work on the staged snapshot;
      // failed pages never remove published rows, and context.live wins at commit.
      const lowerKey = timeToPushPrefix(lower), upperKey = timeToPushPrefix(upper);
      for (const [id, row] of byId) {
        if (row.sourceFingerprint && id >= lowerKey && id < upperKey && !seen.has(id)) byId.delete(id);
      }
    };
    // Summary creation precedes deletion; no listener event advances this cursor.
    await readRaw(rawFrom, to);
    const keys = await this.bounded(() => this.summaryInventory({ signal: context.signal }), { signal: context.signal });
    context.signal.throwIfAborted();
    if (!Array.isArray(keys) || keys.length > 300000 || keys.some((id) => !/^[-0-9A-Z_a-z]{20}$/.test(id))) throw syncError('INVENTORY_INVALID');
    const inventory = new Set(keys);
    // Forgetting a missing summary would resurrect compacted raw from disk.
    for (const id of manifests.keys()) {
      if (!inventory.has(id) && !context.summaries.has(id)) throw syncError('SUMMARY_MISSING');
    }
    const lower = timeToPushPrefix(Math.max(0, from - BUCKET_MS)), upper = timeToPushPrefix(to + 1);
    const probed = new Set();
    for (const id of inventory) {
      if (id < lower || id >= upper || manifests.has(id) || context.summaries.has(id)) continue;
      let value;
      for (let attempt = 0; attempt < MAX_RECENT_ATTEMPTS; attempt++) {
        const snapshot = await this.readPageSnapshot(this.adapter.childReference(this.aggregateRef, id), context);
        value = snapshot.val();
        if (value !== null) break;
      }
      if (value === null) throw syncError('SUMMARY_MISSING');
      budget.remaining--; budget.bytes -= Buffer.byteLength(JSON.stringify(value));
      if (budget.remaining <= 0 || budget.bytes < 0) throw budgetError();
      const { row: summary, sources } = validateSummary(id, value);
      manifests.set(id, { summary, sources });
      // A newly summarized old bucket can contain changed/unlisted leftovers.
      // Probe it once, not every possible historical bucket on every restart.
      const start = Math.max(0, summary.aggregation.bucketStart - HISTORY_KEY_OVERLAP_MS);
      const end = Math.min(to, summary.aggregation.bucketEnd + HISTORY_KEY_OVERLAP_MS);
      if (warm && start < rawFrom && !probed.has(start)) {
        probed.add(start); await readRaw(start, end);
      }
    }
    // Listener/own-compactor patches can precede or race the inventory. Probe
    // their old buckets too, without restarting the entire retained scan.
    for (let pass = 0; pass < MAX_RECENT_ATTEMPTS; pass++) {
      for (const [id, manifest] of context.summaries) manifests.set(id, manifest);
      let work = false;
      for (const [id, { summary }] of manifests) {
        const start = Math.max(0, summary.aggregation.bucketStart - HISTORY_KEY_OVERLAP_MS);
        if (warm && !this.reconciledManifests.has(id) && start < rawFrom && !probed.has(start)) {
          probed.add(start); work = true;
          await readRaw(start, Math.min(to, summary.aggregation.bucketEnd + HISTORY_KEY_OVERLAP_MS));
        }
      }
      if (!work) break;
    }
    context.signal.throwIfAborted();
    for (const [id, row] of context.live) { if (row) byId.set(id, row); else byId.delete(id); }
    for (const [id, manifest] of context.summaries) manifests.set(id, manifest);
    for (const [id, { sources, summary }] of manifests) {
      if (summary.aggregation.bucketEnd <= from || summary.aggregation.bucketStart > to) { manifests.delete(id); continue; }
      for (const [sourceId, source] of Object.entries(sources)) {
        if (byId.get(sourceId)?.sourceFingerprint === source.fingerprint) byId.delete(sourceId);
      }
      byId.set(id, summary);
    }
    if (generation !== this.generation) throw syncError('RECONCILIATION_CHANGED');
    const rows = [...byId.values()].filter((row) => row.aggregation
      ? row.aggregation.bucketEnd > from : row.time >= from);
    if (rows.length > MIXED_CACHE_MAX_ROWS || Buffer.byteLength(JSON.stringify({ rows, manifests: [...manifests.values()] })) > MIXED_CACHE_MAX_BYTES / 2) throw budgetError();
    context.signal.throwIfAborted();
    this.readings = rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    this.ids = new Set(rows.map((row) => row.id));
    this.manifests = manifests;
    this.reconciledManifests = new Set([...manifests].filter(([id, { summary }]) => !warm || this.reconciledManifests.has(id) ||
      summary.aggregation.bucketStart - HISTORY_KEY_OVERLAP_MS >= rawFrom || probed.has(Math.max(0, summary.aggregation.bucketStart - HISTORY_KEY_OVERLAP_MS))).map(([id]) => id));
    this.rebuildCoverage();
    this.recentCoverage = { from, through: to, cursor: timeToPushPrefix(to) };
    this.cacheSource = 'memory'; this.cacheSavedAt = this.now();
    this.persist(); await this.disk.flush();
  }

  cacheStatus() {
    const available = !!this.recentCoverage && this.recentCoverage.from <= this.recentCoverage.through && this.readings.length > 0;
    return { source: this.cacheSource, savedAt: this.cacheSavedAt, restoredAt: this.cacheRestoredAt,
      ageMs: this.cacheSavedAt === null ? null : Math.max(0, this.now() - this.cacheSavedAt),
      stale: !this.readiness().ready, available };
  }

  rebuildCoverage() {
    this.coveredSources.clear();
    for (const { sources } of this.manifests.values()) {
      for (const [id, source] of Object.entries(sources)) this.coveredSources.set(id, source.fingerprint);
    }
  }

  invalidateMixed(sources, summary) {
    if (!this.aggregatePath) return;
    if (sources && summary) {
      this.syncContext?.summaries?.set(summary.id, { sources, summary });
      this.maintenanceContext?.summaries?.set(summary.id, { sources, summary });
      if (summary.aggregation.bucketEnd > this.now() - this.historyMs) {
        const previous = this.manifests.get(summary.id);
        // Summaries are immutable. Unexpected edits need explicit recovery,
        // not silently claiming a complete snapshot with discarded old sources.
        if (previous && fingerprint(previous) !== fingerprint({ sources, summary })) {
          this.syncFailure(syncError('RECONCILIATION_CHANGED'));
          return;
        }
        this.manifests.set(summary.id, { sources, summary });
        for (const [id, source] of Object.entries(sources)) this.coveredSources.set(id, source.fingerprint);
      }
    } else this.generation++;
    if (sources) {
      this.readings = this.readings.filter((row) => sources[row.id]?.fingerprint !== row.sourceFingerprint || !row.sourceFingerprint);
      this.ids = new Set(this.readings.map((row) => row.id));
      if (summary) this.insert(summary, false, false);
    }
    this.historyCache.clear(); this.availabilityCache.clear();
    this.persist();
  }

  async rawPage(dataRef, { from, to, after, limit, reverse = false, context }) {
    const target = this.adapter.rawPageQuery(dataRef, { from, to, after, limit, reverse });
    const snap = await this.readPageSnapshot(target, context);
    const entries = [];
    snap.forEach((child) => {
      entries.push({ id: child.key, value: child.val() });
    });
    return reverse ? entries.reverse() : entries;
  }

  async *entryPages(dataRef, { from, to, reverse = false, context, budget = { remaining: MAX_QUERY_ROWS, bytes: MAX_MIXED_QUERY_BYTES } } = {}) {
    let after;
    budget.bytes ??= MAX_MIXED_QUERY_BYTES;
    while (true) {
      if (budget.remaining <= 0) throw budgetError();
      context?.signal.throwIfAborted();
      const entries = await this.rawPage(dataRef, { from, to, after, reverse, context, limit: Math.min(PAGE_SIZE, budget.remaining) });
      if (!entries.length) return;
      budget.remaining -= entries.length;
      for (const entry of entries) {
        budget.bytes -= Buffer.byteLength(JSON.stringify(entry));
        if (budget.bytes < 0) throw Object.assign(Error('Mixed query exceeds 32 MiB; select a shorter range'), { status: 422 });
        if (after && (reverse ? entry.id >= after : entry.id <= after)) throw Error('Firebase pagination cursor did not advance');
        after = entry.id;
      }
      yield entries;
    }
  }

  mergedRange(options) {
    const key = JSON.stringify([options.from, options.to, this.connectionVersion, !!options.context]);
    this.mixedRequests ??= new Map();
    if (this.mixedRequests.has(key)) return this.mixedRequests.get(key);
    if (this.stopped) return Promise.reject(Error('Store stopped'));
    if (this.mixedRequests.size >= 8) return Promise.reject(Object.assign(Error('History queue full; retry shortly'), { status: 503 }));
    // Serialize heavy merged scans; coalesce identical in-flight ranges only.
    const context = options.context || new AbortController();
    const previous = this.mixedTail || Promise.resolve();
    const work = this.bounded(() => previous.catch(() => {}).then(() => {
      context.signal.throwIfAborted();
      if (this.stopped) throw Error('Store stopped');
      return this.readMergedRange({ ...options, context });
    }), { signal: context.signal, timeoutMs: this.syncTimeoutMs })
      .catch((error) => { context.abort(error); throw error; });
    this.mixedTail = work;
    this.mixedRequests.set(key, work);
    this.mixedInflight ??= new Set(); this.mixedInflight.add(work);
    work.finally(() => { this.mixedInflight.delete(work); this.mixedRequests.delete(key); }).catch(() => {});
    return work;
  }

  async readMergedRange({ from, to, context, budget = { remaining: MAX_QUERY_ROWS } }) {
    const raw = [], summaries = [];
    // Raw first: summary is persisted before deletion. Deduplicate ONLY exact
    // manifest fingerprints; changed/unlisted late arrivals remain visible.
    for await (const entries of this.entryPages(this.dataRef, { from: Math.max(0, from - HISTORY_KEY_OVERLAP_MS), to: to + HISTORY_KEY_OVERLAP_MS + 1, budget, context })) raw.push(...entries);
    for await (const entries of this.entryPages(this.aggregateRef, { from: Math.max(0, from - BUCKET_MS), to: to + 1, budget, context })) summaries.push(...entries);
    context?.signal.throwIfAborted();
    if (context?.scannedManifests) {
      for (const entry of summaries) {
        const { sources, row: summary } = validateSummary(entry.id, entry.value);
        context.scannedManifests.set(summary.id, { sources, summary });
      }
    }
    // Arbitrary range edges can cut a five-minute bucket. Exact partial
    // medians cannot be reconstructed: return the full intersecting bucket,
    // retaining its honest timestamp/coverage (API flags this precision).
    return mergeReadings(raw, summaries).filter((row) => row.aggregation
      ? row.aggregation.bucketStart <= to && row.aggregation.bucketEnd > from
      : row.time >= from && row.time <= to);
  }

  async range(options) {
    if (!this.aggregatePath) return this.query(options);
    if (!this.cacheStatus().available) this.assertReady();
    if (!this.recentCoverage) throw syncError('RECONCILIATION_CHANGED');
    // A shorter configured retention must not masquerade as a complete 24h view.
    if (options.from < this.recentCoverage.from) {
      throw Object.assign(Error('Khoảng gần đây vượt dữ liệu RAM đã đồng bộ; chọn khoảng ngắn hơn hoặc lịch theo ngày.'), { status: 422 });
    }
    return this.readings.filter((row) => (!options.device || row.device === options.device) && (row.aggregation
      ? row.aggregation.bucketStart <= options.to && row.aggregation.bucketEnd > options.from
      : row.time >= options.from && row.time <= options.to));
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectionTimer);
    clearInterval(this.pruneTimer);
    this.syncContext?.abort(syncError('STORE_STOPPED'));
    this.maintenanceContext?.abort(syncError('STORE_STOPPED'));
    for (const cancel of [...this.pendingReads]) cancel(syncError('STORE_STOPPED'));
    this.cleanupListeners();
    await this.compactor.stop();
    await Promise.allSettled([this.starting, this.syncing, this.maintaining, ...this.historyInflight.values(), ...(this.mixedInflight || [])].filter(Boolean));
    this.persist();
    await this.disk.flush();
    if (this.app) await this.adapter.dispose(this.app);
  }

  add(id, raw, notify) {
    if (this.stopped || (!this.aggregatePath && this.ids.has(id))) return;
    const reading = normalizeReading(id, raw);
    if (this.aggregatePath) {
      if (reading) reading.sourceFingerprint = fingerprint(raw);
      const visible = reading && this.coveredSources.get(id) !== reading.sourceFingerprint ? reading : null;
      this.syncContext?.live?.set(id, visible);
      this.maintenanceContext?.live?.set(id, visible);
      if (this.ids.has(id)) {
        const previous = this.readings.find((row) => row.id === id);
        if (visible && previous.sourceFingerprint === visible.sourceFingerprint) return;
        this.readings = this.readings.filter((row) => row.id !== id);
        this.ids.delete(id);
      }
      this.historyCache.clear(); this.availabilityCache.clear();
      if (visible) this.insert(visible, notify);
    } else if (reading) this.insert(reading, notify);
  }

  insert(reading, notify, persist = true) {
    const { id } = reading;
    if (this.ids.has(id) || !Number.isFinite(reading.time) || (reading.aggregation
      ? reading.aggregation.bucketEnd <= this.now() - this.historyMs
      : reading.time < this.now() - this.historyMs)) return;
    this.ids.add(id);
    let i = this.readings.length;
    while (i > 0 && (this.aggregatePath
      ? this.readings[i - 1].time > reading.time || (this.readings[i - 1].time === reading.time && this.readings[i - 1].id > id)
      : this.readings[i - 1].id > id)) i--;
    this.readings.splice(i, 0, reading);
    if (persist) this.persist();
    if (notify && !reading.aggregation) this.emit('reading', reading);
  }

  prune() {
    const cutoff = Math.max(0, this.now() - this.historyMs);
    // Coverage cannot claim rows discarded during a long-running process.
    if (this.scan && cutoff > this.scan.from) this.scan = { ...this.scan, from: cutoff };
    if (this.recentCoverage) this.recentCoverage.from = Math.max(this.recentCoverage.from, cutoff);
    let removedManifest = false;
    for (const [id, { summary }] of this.manifests) {
      if (summary.aggregation.bucketEnd <= cutoff) { this.manifests.delete(id); removedManifest = true; }
    }
    if (removedManifest) this.rebuildCoverage();
    // Device timestamps need not follow push-key order.
    this.readings = this.readings.filter((row) => {
      if (row.aggregation ? row.aggregation.bucketEnd > cutoff : row.time >= cutoff) return true;
      this.ids.delete(row.id);
      return false;
    });
    this.persist();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.status());
  }

  status() {
    return {
      ...this.state,
      lastError: this.state.lastError ? { ...this.state.lastError } : null,
      runtime: { ...RUNTIME },
      queryLimits: {
        pageSize: PAGE_SIZE, maxQueryRows: MAX_QUERY_ROWS,
        mixedMaxBytes: MAX_MIXED_QUERY_BYTES,
        recentScanMode: this.aggregatePath ? 'mixed' : 'raw',
        recentMaxRowsPerAttempt: this.aggregatePath ? MAX_QUERY_ROWS : null,
        recentMaxAttempts: this.aggregatePath ? MAX_RECENT_ATTEMPTS : 1,
        readTimeoutMs: this.readTimeoutMs, syncTimeoutMs: this.syncTimeoutMs,
      },
      readiness: this.readiness(),
      sync: { ...this.syncStatus },
      connection: this.connected === undefined ? 'unknown' : this.connected ? 'online' : 'offline',
      recentCoverage: this.recentCoverage ? { ...this.recentCoverage } : null,
      recentReadSemantics: this.aggregatePath
        ? 'durable-mixed; raw-delta-60s-overlap; summary-shallow-inventory-60s; immutable-summaries; arbitrary-old-raw-edits-not-detected'
        : 'memory-durable; raw-listener-last-50; incremental-key-cursor; append-only',
      readSemantics: 'sdk-get-may-use-active-listener-cache; no-server-freshness-guarantee',
      dataPath: this.dataPath,
      aggregatePath: this.aggregatePath,
      compaction: { ...this.compactor.state },
      cache: this.cacheStatus(),
      cacheMode: this.aggregatePath ? (this.disk.path ? 'mixed-durable' : 'mixed-memory') : 'durable',
      records: this.readings.length,
      historyHours: this.historyMs / 3600000,
    };
  }

  devices() {
    const map = new Map();
    for (const r of this.readings) {
      const d = map.get(r.device) ?? { device: r.device, count: 0 };
      d.count++;
      if (d.lastSeen === undefined || r.time >= d.lastSeen) {
        d.location = r.location;
        d.lastSeen = r.time;
      }
      map.set(r.device, d);
    }
    return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  query({ device, from, to = Date.now() }) {
    return this.readings.filter(
      (r) =>
        r.time >= from && r.time <= to && (!device || r.device === device),
    );
  }

  readiness() {
    const reason = this.stopped ? 'stopped' : this.connected === false || this.state.firebase === 'offline' ? 'realtime-offline'
      : this.syncStatus.phase === 'error' || this.state.error ? 'sync-failed'
      : !this.dataRef ? 'connecting'
      : !this.state.loadedAt || this.state.firebase !== 'online' ? 'initial-sync-incomplete'
      : this.connected !== undefined && !this.wasOnline ? 'resync-required' : null;
    return { ready: reason === null, reason, retryAfterMs: reason ? 15000 : null };
  }

  assertReady() {
    const readiness = this.readiness();
    if (!readiness.ready) {
      throw Object.assign(new Error(`Firebase chưa sẵn sàng (${readiness.reason}). Kiểm tra /api/status và thử lại.`),
        { status: 503, code: 'NOT_READY', readiness });
    }
  }

  cached(cache, key, load, limit) {
    this.assertReady();
    if (this.aggregatePath) return load();
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      entry = { promise: load(), expires: Date.now() + 30000 };
      cache.set(key, entry);
      while (cache.size > limit) cache.delete(cache.keys().next().value);
      entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    }
    return entry.promise;
  }

  // The schema is flat /sensorData/<pushId>; only the key has a guaranteed
  // index. Page by that index, filter device locally, never read the whole node.
  // No guessed deviceName/timestamp index and no rules or database writes.
  async *pages({ from, to, reverse = false, budget = { remaining: MAX_QUERY_ROWS } } = {}) {
    this.assertReady();
    let cursor;
    while (true) {
      if (budget.remaining <= 0) throw budgetError();
      const size = Math.min(PAGE_SIZE, budget.remaining);
      const target = this.adapter.historyPageQuery(this.dataRef, { from, to, cursor, reverse, limit: size });
      const snap = await this.readPageSnapshot(target);
      this.assertReady();
      const children = [];
      snap.forEach((child) => { children.push(child); });
      budget.remaining -= children.length;
      if (!children.length) return;
      // Exclusive-cursor queries can return size - 1 even with more rows left.
      // Only an empty snapshot proves exhaustion; the shared budget still caps
      // every fetched child, including duplicates or malformed readings.
      const next = [...new Map(children.map((child) => [child.key, child])).values()]
        .filter((child) => !cursor || (reverse ? child.key < cursor : child.key > cursor))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      if (!next.length) throw new Error('Firebase pagination cursor did not advance');
      cursor = reverse ? next[0].key : next.at(-1).key;
      yield (reverse ? next.reverse() : next).map((child) => normalizeReading(child.key, child.val())).filter((row) => row && Number.isFinite(row.time));
    }
  }

  async edge(device, reverse, budget, dataRef = this.dataRef) {
    if (this.aggregatePath) {
      for await (const entries of this.entryPages(dataRef, { reverse, budget })) {
        const rows = dataRef === this.aggregateRef ? mergeReadings([], entries) : entries.map(({ id, value }) => normalizeReading(id, value)).filter(Boolean);
        rows.sort((a, b) => reverse ? b.time - a.time : a.time - b.time);
        const row = rows.find((r) => (!device || r.device === device) && todayVN(r.time) >= '1970-01-01' && todayVN(r.time) <= todayVN());
        if (row) return todayVN(row.time);
      }
      return null;
    }
    for await (const rows of this.pages({ reverse, budget })) {
      const row = rows.find((r) => (!device || r.device === device) && todayVN(r.time) >= '1970-01-01' && todayVN(r.time) <= todayVN());
      if (row) return todayVN(row.time);
    }
    return null;
  }

  async extent(device) {
    return this.cached(this.availabilityCache, `extent:${device || ''}`, async () => {
      const budget = { remaining: MAX_QUERY_ROWS };
      let first = await this.edge(device, false, budget);
      let last = first ? await this.edge(device, true, budget) : null;
      if (this.aggregatePath) {
        const summaryFirst = await this.edge(device, false, budget, this.aggregateRef);
        const summaryLast = summaryFirst ? await this.edge(device, true, budget, this.aggregateRef) : null;
        first = [first, summaryFirst].filter(Boolean).sort()[0] || null;
        last = [last, summaryLast].filter(Boolean).sort().at(-1) || null;
      }
      return { first, last };
    }, 64);
  }

  async availableDates(device, dates) {
    const budget = { remaining: MAX_QUERY_ROWS };
    const available = [];
    for (const date of dates) {
      const found = await this.cached(this.availabilityCache, JSON.stringify(['day', device, date]), async () => {
        const bounds = calendarBounds(date);
        if (this.aggregatePath) return (await this.mergedRange({ ...bounds, budget })).some((r) => !device || r.device === device);
        // Stop as soon as one actual row for this device/day is found.
        for await (const rows of this.pages({ ...historyKeyBounds(bounds), budget })) {
          if (rows.some((r) => (!device || r.device === device) && r.time >= bounds.from && r.time <= bounds.to)) return true;
        }
        return false;
      }, 256);
      if (found) available.push(date);
    }
    return available;
  }

  async availability({ device, month, dates }) {
    const key = JSON.stringify({ device, month, dates });
    return this.cached(this.availabilityCache, key, async () => {
      const extent = await this.extent(device);
      const visible = [];
      if (month && extent.first) {
        const end = `${shiftMonth(month, 1)}-01`;
        for (let day = `${month}-01`; day < end; day = addDays(day, 1)) {
          if (day >= extent.first && day <= extent.last) visible.push(day);
        }
      }
      const candidates = [...new Set([...visible, ...(dates || [])])].filter((d) => extent.first && d >= extent.first && d <= extent.last);
      const available = await this.availableDates(device, candidates);
      return { ...extent, month: month || null, days: available.filter((d) => visible.includes(d)), validDates: available.filter((d) => dates?.includes(d)) };
    }, 64);
  }

  historyKey({ device, from, to }) {
    return JSON.stringify([device || null, from, to]);
  }

  trimHistory() {
    let bytes = 0;
    for (const [key, entry] of this.historyCache) {
      if (entry.expires <= this.now()) this.historyCache.delete(key);
      else bytes += Buffer.byteLength(JSON.stringify(entry));
    }
    while (this.historyCache.size > this.historyCacheEntries || bytes > this.historyCacheBytes) {
      const key = this.historyCache.keys().next().value;
      bytes -= Buffer.byteLength(JSON.stringify(this.historyCache.get(key)));
      this.historyCache.delete(key);
    }
  }

  // Completed intervals, not selected-date combinations, are cached. Both API
  // paths share these entries; failed/partial scans are never cached.
  async history({ device, from, to, budget = { remaining: MAX_QUERY_ROWS } }) {
    if (this.aggregatePath) {
      this.assertReady();
      return (await this.mergedRange({ from, to, budget })).filter((row) => !device || row.device === device);
    }
    await this.loadCache();
    const key = this.historyKey({ device, from, to });
    const cached = this.historyCache.get(key);
    if (cached?.expires > this.now()) {
      this.historyCache.delete(key);
      this.historyCache.set(key, cached);
      return cached.rows;
    }
    if (this.historyInflight.has(key)) return this.historyInflight.get(key);
    this.assertReady();
    const promise = (async () => {
      const rows = [];
      for await (const page of this.pages({ ...historyKeyBounds({ from, to }), budget })) {
        for (const row of page) {
          if (row.time >= from && row.time <= to && (!device || row.device === device)) rows.push(row);
        }
      }
      rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
      const ttl = to < this.now() ? this.historyClosedTtlMs : this.historyCurrentTtlMs;
      this.historyCache.set(key, { device: device || null, from, to, expires: this.now() + ttl, rows });
      this.persist();
      this.trimHistory();
      return rows;
    })();
    this.historyInflight.set(key, promise);
    try { return await promise; }
    finally { this.historyInflight.delete(key); }
  }

  async selectedHistory({ device, dates }) {
    const budget = { remaining: MAX_QUERY_ROWS };
    const groups = [];
    for (const date of dates) groups.push(await this.history({ device, ...calendarBounds(date), budget }));
    return groups;
  }

  // n ban ghi moi nhat cua mot thiet bi (khong phu thuoc khoang xem).
  recent(device, n) {
    const out = [];
    for (let i = this.readings.length - 1; i >= 0 && out.length < n; i--) {
      const r = this.readings[i];
      if ((!device || r.device === device) && !r.aggregation) out.push(r);
    }
    return out;
  }
}

const SYNC_MESSAGES = {
  SUMMARY_MISSING: 'A retained summary is missing. Cached coverage is preserved; inspect external deletion before recovery.',
  INVENTORY_INVALID: 'Summary key inventory is invalid or exceeds its bound.',
  READ_TIMEOUT: 'Firebase read timed out; check connectivity and retry.',
  SYNC_TIMEOUT: 'Initial synchronization exceeded its deadline; check /api/status progress and retry.',
  CONNECTION_TIMEOUT: 'Realtime connection not established; check network, Firebase URL and authentication.',
  CONNECTION_CHANGED: 'Connection changed during read; retry after synchronization.',
  RECONCILIATION_CHANGED: 'Recent data changed during reconciliation; retry shortly.',
  STORE_STOPPED: 'Store stopped.',
};
function syncError(code) {
  return Object.assign(new Error(SYNC_MESSAGES[code]), { code, status: 503 });
}

function describeFirebaseError(err, dataPath) {
  const code = err?.code ?? '';
  if (
    code === 'auth/operation-not-allowed' ||
    code === 'auth/admin-restricted-operation'
  ) {
    return 'Chua bat Anonymous trong Firebase Console > Authentication > Sign-in method';
  }
  if (code.startsWith('auth/api-key') || code === 'auth/invalid-api-key') {
    return 'FIREBASE_API_KEY khong hop le';
  }
  if (code === 'auth/network-request-failed') {
    return 'Khong ket noi duoc toi Firebase (kiem tra mang)';
  }
  if (/permission/i.test(err?.message ?? '')) {
    return `Rules khong cho phep doc /${dataPath} (can ".read": "auth != null")`;
  }
  return SYNC_MESSAGES[code] || 'Firebase synchronization failed; check network, authentication and read permissions, then retry.';
}
