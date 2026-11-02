import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_SKEW_MS, assertUnchanged, downsamplingOptions, planDownsampling, scanRaw } from '../src/domain/downsampling.js';
import { timeToPushPrefix } from '../src/domain/readings.js';

export const HELP = `Usage: npm run downsample -- [options]
Safe default: no connection and no writes. Use --input or explicitly --connect.
  --help                    Print help without loading Firebase/config
  --input FILE              Offline JSON array [{id,value}] or key/value object
  --connect                 Allow real Firebase reads (server/.env config)
  --apply                   Write changes (otherwise dry-run)
  --backup FILE             Exclusive-create backup of ALL planned originals
  --server-stopped          Acknowledge server stopped and history writers paused
  --retain-days N           Raw retention, default 7; apply >= HISTORY_HOURS / 24
  --bucket-minutes N        Integer divisor of 1440, default 5 (UTC+7 aligned)
  --page-size N             Rows per query, default 1000
  --max-rows N              Scan row budget, default 100000 (must prove exhaustion)
  --max-bytes N             Scan JSON byte budget, default 67108864
  --max-update-bytes N      Atomic bucket update byte cap, default 4194304
  --now ISO_OR_EPOCH_MS     Fixed reference time (dry-run only)
No scheduler. Applying is destructive: stop server and all writers capable of
changing historical data first. Rechecks are NOT a concurrent-writer lock.
`;

export function parseArgs(argv) {
  const args = {};
  const flags = { '--help': 'help', '--connect': 'connect', '--apply': 'apply', '--server-stopped': 'serverStopped' };
  const values = { '--input': 'input', '--backup': 'backup', '--retain-days': 'retainDays', '--bucket-minutes': 'bucketMinutes', '--page-size': 'pageSize', '--max-rows': 'maxRows', '--max-bytes': 'maxBytes', '--max-update-bytes': 'maxUpdateBytes', '--now': 'now' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flags[flag] ?? values[flag];
    if (!name || Object.hasOwn(args, name)) throw new Error(`Unknown or duplicate argument: ${flag}`);
    if (flags[flag]) args[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${flag}`);
      args[name] = ['input', 'backup'].includes(name) ? value : name === 'now' ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : Number(value);
    }
  }
  return args;
}

async function connectFirebase() {
  const { config } = await import('../src/config/index.js');
  const { invalidateFileCache } = await import('../src/infrastructure/cache/fileCache.js');
  const { initializeApp, deleteApp } = await import('firebase/app');
  const { getAuth, signInAnonymously } = await import('firebase/auth');
  const { getDatabase, ref, query, orderByKey, startAfter, endBefore, limitToFirst, get, update } = await import('firebase/database');
  const app = initializeApp(config.firebase, `downsample-${process.pid}`);
  try {
    await signInAnonymously(getAuth(app));
    const root = ref(getDatabase(app), config.dataPath);
    return {
      historyHours: config.historyHours,
      target: { databaseURL: config.firebase.databaseURL, dataPath: config.dataPath },
      async readPage({ after, endBefore: end, limit }) {
        const constraints = [orderByKey(), endBefore(end), limitToFirst(limit)];
        if (after !== undefined) constraints.push(startAfter(after));
        const snapshot = await get(query(root, ...constraints));
        const rows = [];
        snapshot.forEach((child) => { rows.push({ id: child.key, value: child.val() }); });
        return rows;
      },
      invalidateCache: () => invalidateFileCache(config.cacheFile, {
        databaseURL: config.firebase.databaseURL, dataPath: config.dataPath,
      }),
      update: (updates) => update(root, updates),
      close: () => deleteApp(app),
    };
  } catch (error) { await deleteApp(app); throw error; }
}

async function writeBackup(path, backup) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(backup, null, 2)); await file.sync(); }
  finally { await file.close(); }
}

/** Injectable I/O keeps all tests offline; importing this module has no effects. */
export async function runCli(argv, io = {}) {
  const args = parseArgs(argv);
  const log = io.log ?? console.log;
  if (args.help) { log(HELP); return { help: true }; }
  if (args.input && args.connect) throw new Error('--input and --connect are mutually exclusive');
  if (args.apply && (!args.connect || !args.backup || !args.serverStopped)) throw new Error('--apply requires --connect, --backup and --server-stopped');
  if (args.apply && args.now !== undefined) throw new Error('--now is dry-run only');
  if (!args.input && !args.connect) { log(HELP); return { connected: false, applied: 0 }; }
  const options = downsamplingOptions({ ...args, now: args.now ?? (io.now ?? Date.now)() });
  let db;
  try {
    let entries;
    if (args.input) {
      const text = await (io.readFile ?? readFile)(args.input, 'utf8');
      if (Buffer.byteLength(text) > options.maxBytes) throw new Error('Fixture byte budget exhausted');
      const fixture = JSON.parse(text);
      if (!fixture || typeof fixture !== 'object') throw new Error('Invalid fixture');
      entries = Array.isArray(fixture) ? fixture : Object.entries(fixture).map(([id, value]) => ({ id, value }));
      if (entries.length >= options.maxRows) throw new Error('Fixture row budget exhausted');
      // Fixture is already complete, but use the same fixed key end bound.
      entries = entries.filter((r) => typeof r.id !== 'string' || r.id < options.endBefore);
    } else {
      db = await (io.connect ?? connectFirebase)();
      if (args.apply && (!Number.isFinite(db.historyHours) || db.historyHours <= 0 || options.retainDays * 24 < db.historyHours)) throw new Error('Retention must cover HISTORY_HOURS');
      entries = await scanRaw(db.readPage, options);
    }
    const plan = planDownsampling(entries, options);
    const report = { mode: args.apply ? 'apply' : 'dry-run', now: plan.now, cutoff: plan.cutoff, scanned: plan.scanned, buckets: plan.buckets.length, sourceCount: plan.sourceCount, deletedCount: plan.deletedCount, skipped: plan.skipped, applied: 0 };
    log(JSON.stringify(report));
    if (!args.apply || !plan.buckets.length) return report;
    // Recheck complete scan, including added/deleted/moved rows, before backup.
    assertUnchanged(entries, await scanRaw(db.readPage, options));
    await (io.writeBackup ?? writeBackup)(args.backup, {
      version: 1, createdAt: options.now, target: db.target,
      retainDays: options.retainDays, bucketMinutes: options.bucketMinutes, cutoff: options.cutoff,
      originals: plan.buckets.flatMap((b) => b.originals),
      buckets: plan.buckets.map(({ originals, ...bucket }) => bucket),
    });
    // Server da dung: bo cache lich su truoc ca khi chi mot phan bucket duoc ghi.
    await db.invalidateCache();
    const expected = new Map(entries.map((e) => [e.id, e.value]));
    for (const bucket of plan.buckets) {
      // Check all keys in the event bucket's possible receipt-time interval,
      // not just known source IDs: a late insert must also veto this write.
      const lower = timeToPushPrefix(Math.max(0, bucket.bucketStart - MAX_SKEW_MS));
      const upper = timeToPushPrefix(bucket.bucketEnd + MAX_SKEW_MS);
      const boundedRead = ({ after, limit }) => db.readPage({ after: after ?? lower, endBefore: upper, limit });
      const actual = await scanRaw(boundedRead, { ...options, endBefore: upper });
      const before = [...expected].filter(([id]) => id > lower && id < upper).map(([id, value]) => ({ id, value }));
      assertUnchanged(before, actual);
      await db.update(bucket.updates); // One atomic multi-location update per whole bucket.
      for (const { id } of bucket.originals) expected.delete(id);
      expected.set(bucket.representativeId, bucket.value);
      // Preserve Firebase lexical order for the next overlapping check.
      const sorted = [...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      expected.clear();
      for (const [id, value] of sorted) expected.set(id, value);
      report.applied++;
      log(`Applied ${report.applied}/${plan.buckets.length}: ${bucket.representativeId}`);
    }
    return report;
  } finally { if (db) await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`Downsampling aborted: ${error.message}. Earlier buckets may have committed; inspect the backup before retrying.`);
    process.exitCode = 1;
  });
}
