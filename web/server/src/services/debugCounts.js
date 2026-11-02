import { validatePaths } from '../domain/compaction.js';

export const COUNTS_MAX_BYTES = 8 * 1024 * 1024; // Three responses: at most 24 MiB JSON, plus parsing overhead.
export const COUNTS_TIMEOUT_MS = 15000;
export const COUNTS_CACHE_MS = 15000;

const ERRORS = {
  AUTH_NOT_READY: [503, 'Firebase authentication is not ready. Retry shortly.'],
  UPSTREAM_PERMISSION_DENIED: [502, 'Firebase read permission denied.'],
  UPSTREAM_FAILED: [502, 'Firebase count request failed.'],
  UPSTREAM_TOO_LARGE: [502, 'Firebase shallow response exceeds the size limit.'],
  UPSTREAM_INVALID: [502, 'Firebase returned an invalid shallow response.'],
  UPSTREAM_TIMEOUT: [504, 'Firebase count request timed out.'],
};
export class CountsError extends Error {
  constructor(code) {
    super(ERRORS[code][1]);
    this.code = code;
    this.status = ERRORS[code][0];
  }
}
export const failure = (code) => new CountsError(code);

function databaseRoot(value) {
  // Only the configured HTTPS RTDB root; no credentials, ports, paths, query,
  // fragment, URL normalization tricks, emulator or caller-supplied destination.
  if (typeof value !== 'string' || !/^https:\/\/(?:[a-z0-9-]+\.firebaseio\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)?\.firebasedatabase\.app)\/?$/i.test(value)) {
    throw Error('Invalid Firebase database root for debug counts');
  }
  return new URL(value);
}

// Bound SDK token refresh too (the SDK operation itself cannot be cancelled).
// Late completions never populate the result cache.
function abortable(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readShallow(response, signal, maxBytes) {
  let reader;
  let complete = false;
  try {
    if (response.status === 401 || response.status === 403) throw failure('UPSTREAM_PERMISSION_DENIED');
    if (!response.ok) throw failure('UPSTREAM_FAILED');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw failure('UPSTREAM_TOO_LARGE');
    if (!response.body) throw failure('UPSTREAM_INVALID');
    reader = response.body.getReader();
    // A single capped buffer also bounds bookkeeping for tiny streamed chunks;
    // accumulating one Buffer per chunk can otherwise dwarf the byte budget.
    const buffer = Buffer.allocUnsafe(maxBytes);
    let bytes = 0;
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      if (bytes + value.byteLength > maxBytes) throw failure('UPSTREAM_TOO_LARGE');
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
    complete = true;
    signal.throwIfAborted();
    let value;
    try { value = JSON.parse(buffer.toString('utf8', 0, bytes)); }
    catch { throw failure('UPSTREAM_INVALID'); }
    if (value === null) return { exists: false, count: 0 };
    if (typeof value !== 'object' || Array.isArray(value)) throw failure('UPSTREAM_INVALID');
    let count = 0;
    for (const key of Object.keys(value)) {
      // shallow=true replaces nested data with true but preserves scalar children.
      // Count every actual immediate key; null children and nested data are invalid.
      if (value[key] === null || !['boolean', 'number', 'string'].includes(typeof value[key])) {
        throw failure('UPSTREAM_INVALID');
      }
      count++;
    }
    return { exists: true, count };
  } finally {
    // Do not read error bodies (which may contain credentials/URLs), or wait on
    // cancellation. The shared controller also aborts outstanding sibling reads.
    if (!complete) {
      const cancellation = reader ? reader.cancel() : response.body?.cancel();
      cancellation?.catch(() => {});
    }
    reader?.releaseLock();
  }
}

export function createDebugCounts({ databaseURL, dataPath = 'sensorData' }, {
  getAuth, fetch: fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = COUNTS_TIMEOUT_MS, maxBytes = COUNTS_MAX_BYTES, cacheMs = COUNTS_CACHE_MS,
} = {}) {
  const root = databaseRoot(databaseURL);
  const raw = validatePaths(dataPath, 'sensorData5m').dataPath;
  const paths = { sensorData: raw, sensorData5m: 'sensorData5m', devices: 'devices' };
  if (typeof getAuth !== 'function' || typeof fetchImpl !== 'function' ||
      ![timeoutMs, maxBytes, cacheMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw Error('Invalid debug counts options');
  }
  let cache;
  let inflight;

  async function load(user) {
    const started = now();
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(failure('UPSTREAM_TIMEOUT')), timeoutMs);
    try {
      let token;
      try { token = await abortable(() => user.getIdToken(), signal); }
      catch { throw signal.aborted ? signal.reason : failure('AUTH_NOT_READY'); }
      if (typeof token !== 'string' || !token) throw failure('AUTH_NOT_READY');
      const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => {
        const url = new URL(`${path.split('/').map(encodeURIComponent).join('/')}.json`, root);
        url.searchParams.set('shallow', 'true');
        url.searchParams.set('auth', token); // Firebase ID token, in memory only; never log URL/error bodies.
        const response = await abortable(() => fetchImpl(url, {
          method: 'GET', signal, redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json' },
        }), signal);
        const count = await readShallow(response, signal, maxBytes);
        return [name, { path: `/${path}`, ...count }];
      }));
      signal.throwIfAborted();
      const finished = now();
      return Object.freeze({ checkedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started),
        counts: Object.freeze(Object.fromEntries(entries.map(([name, count]) => [name, Object.freeze(count)]))) });
    } catch (error) {
      const safe = error instanceof CountsError ? error : failure('UPSTREAM_FAILED');
      controller.abort(safe);
      throw safe;
    } finally { clearTimeout(timer); }
  }

  return async function counts() {
    let user;
    try { user = getAuth()?.currentUser; } catch { throw failure('AUTH_NOT_READY'); }
    if (!user) throw failure('AUTH_NOT_READY');
    if (cache?.uid === user.uid && cache.expires > now()) return { ...cache.result, cached: true };
    if (inflight) return { ...await inflight, cached: false };
    const uid = user.uid;
    inflight = load(user).then((result) => {
      cache = { uid, result, expires: now() + cacheMs }; // No token, URL, payload or Auth object cached.
      return result;
    });
    try { return { ...await inflight, cached: false }; }
    finally { inflight = null; }
  };
}

