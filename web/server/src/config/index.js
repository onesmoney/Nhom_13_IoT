import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const serverDirectory = fileURLToPath(new URL('../../', import.meta.url));
const positive = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // Khong co file .env -> dung bien moi truong cua he thong.
}

// Explicit compaction settings fail closed instead of silently shortening retention
// or raising work limits. Fractional days are supported without rounding down.
function compactionNumber(name, fallback, scale = 1, integer = true) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  const scaled = value * scale;
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(scaled) || scaled <= 0 ||
      scaled > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(scaled))) {
    throw new Error(`Invalid ${name}: expected a positive finite ${integer ? 'value producing a safe integer' : 'number'} (scaled value <= Number.MAX_SAFE_INTEGER)`);
  }
  return scaled;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Thieu bien moi truong ${name} (xem server/.env.example)`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  debugApiToken: process.env.DEBUG_API_TOKEN || '',
  firebase: {
    apiKey: required('FIREBASE_API_KEY'),
    databaseURL: required('FIREBASE_DATABASE_URL'),
  },
  dataPath: process.env.FIREBASE_DATA_PATH || 'sensorData',
  aggregatePath: 'sensorData5m',
  compaction: {
    enabled: true,
    retainMs: compactionNumber('COMPACTION_RETAIN_DAYS', 1, 86400000, false),
    intervalMs: compactionNumber('COMPACTION_INTERVAL_SECONDS', 60, 1000),
    pageSize: compactionNumber('COMPACTION_PAGE_SIZE', 1000),
    maxRows: compactionNumber('COMPACTION_MAX_ROWS', 10000),
    maxBytes: compactionNumber('COMPACTION_MAX_BYTES', 8388608),
    windowsPerTick: compactionNumber('COMPACTION_WINDOWS_PER_TICK', 8),
  },
  // So gio du lieu gan day giu trong RAM; lich ngay/tuan doc rieng tu Firebase.
  historyHours: positive('HISTORY_HOURS', 168),
  // Relative custom paths resolve against server/, independent of launch cwd.
  cacheFile: process.env.CACHE_FILE?.toLowerCase() === 'off' ? null
    : resolve(serverDirectory, process.env.CACHE_FILE || '.cache/sensor-cache.json'),
  historyClosedTtlMs: positive('HISTORY_CACHE_CLOSED_TTL_SECONDS', 86400) * 1000,
  historyCurrentTtlMs: positive('HISTORY_CACHE_CURRENT_TTL_SECONDS', 30) * 1000,
  historyCacheEntries: Math.floor(positive('HISTORY_CACHE_MAX_ENTRIES', 32)),
  historyCacheBytes: positive('HISTORY_CACHE_MAX_BYTES', 33554432),
};
