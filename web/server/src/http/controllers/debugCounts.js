import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { CountsError, failure } from '../../services/debugCounts.js';

function isLoopback(address) {
  if (address === '::1') return true;
  const ipv4 = address?.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(ipv4 || '') === 4 && ipv4.startsWith('127.');
}
const digest = (value) => createHash('sha256').update(value).digest();

export function debugCountsHandler(counts, { token = '' } = {}) {
  const expected = token ? digest(token) : null;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (expected) {
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
      if (!match || !timingSafeEqual(expected, digest(match[1]))) {
        res.set('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ error: 'UNAUTHORIZED', message: 'A valid debug bearer token is required.' });
      }
    } else if (!isLoopback(req.socket.remoteAddress)) {
      // Never use req.ip, Host, X-Forwarded-For or Forwarded for this decision.
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Debug counts require a local connection or configured bearer token.' });
    }
    try { res.json(await counts()); }
    catch (error) {
      const safe = error instanceof CountsError ? error : failure('UPSTREAM_FAILED');
      if (safe.status === 503) res.set('Retry-After', '15');
      res.status(safe.status).json({ error: safe.code, message: safe.message });
    }
  };
}
