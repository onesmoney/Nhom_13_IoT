import { validatePaths } from '../../domain/compaction.js';

export const INVENTORY_MAX_BYTES = 8 * 1024 * 1024;
export const INVENTORY_TIMEOUT_MS = 15000;
const fail = (code) => Object.assign(new Error(`Summary inventory ${code.toLowerCase().replaceAll('_', ' ')}.`), { code: `INVENTORY_${code}`, status: 503 });

// No SDK initialization/sign-in and no public fallback. Only the existing user's
// ID token may authorize this bounded REST read. Never propagate URL/body errors.
export function createSummaryInventory({ databaseURL, aggregatePath }, {
  getUser, fetch: fetchImpl = globalThis.fetch, maxBytes = INVENTORY_MAX_BYTES, timeoutMs = INVENTORY_TIMEOUT_MS,
} = {}) {
  const path = validatePaths('__inventory_raw__', aggregatePath).aggregatePath;
  return async function inventory({ signal: external } = {}) {
    if (!/^https:\/\/(?:[a-z0-9-]+\.firebaseio\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)?\.firebasedatabase\.app)\/?$/i.test(databaseURL)) throw fail('INVALID_TARGET');
    const controller = new AbortController(), { signal } = controller;
    const cancel = () => controller.abort(fail('CANCELLED'));
    external?.addEventListener('abort', cancel, { once: true });
    if (external?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(fail('TIMEOUT')), timeoutMs);
    const wait = (load) => new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return load(); }).then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
    let reader, response, complete = false;
    try {
      const user = getUser?.();
      if (!user) throw fail('AUTH_REQUIRED');
      const token = await wait(() => user.getIdToken());
      if (typeof token !== 'string' || !token) throw fail('AUTH_REQUIRED');
      const url = new URL(`${path.split('/').map(encodeURIComponent).join('/')}.json`, databaseURL);
      url.searchParams.set('shallow', 'true');
      url.searchParams.set('auth', token);
      // shallow cannot be combined with orderBy/startAt or any range filter.
      response = await wait(() => fetchImpl(url, { signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } }));
      if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : 'FAILED');
      if (Number(response.headers.get('content-length')) > maxBytes) throw fail('TOO_LARGE');
      if (!response.body) throw fail('INVALID');
      reader = response.body.getReader();
      const buffer = Buffer.allocUnsafe(maxBytes);
      let bytes = 0;
      while (true) {
        const part = await wait(() => reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw fail('TOO_LARGE');
        buffer.set(part.value, bytes - part.value.byteLength);
      }
      complete = true;
      const value = JSON.parse(buffer.toString('utf8', 0, bytes));
      if (value === null) return [];
      if (typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID');
      const keys = Object.keys(value);
      if (keys.some((id) => !/^[-0-9A-Z_a-z]{20}$/.test(id) || value[id] !== true)) throw fail('INVALID');
      signal.throwIfAborted();
      return keys;
    } catch (error) {
      const safe = signal.aborted ? signal.reason : /^INVENTORY_/.test(error?.code || '') ? error : fail('FAILED');
      controller.abort(safe);
      throw safe;
    } finally {
      clearTimeout(timer); external?.removeEventListener('abort', cancel);
      if (!complete) (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
      reader?.releaseLock();
    }
  };
}
