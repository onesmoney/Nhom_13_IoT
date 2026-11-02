import { createApp } from './app.js';
import { config } from './config/index.js';
import { createDebugCounts } from './services/debugCounts.js';
import { SensorStore } from './services/sensorStore.js';
import { StatusLogger } from './infrastructure/statusLogger.js';

// Production composition root: importing app.js alone never starts any of this.
const store = new SensorStore(config);
const debugCounts = createDebugCounts({ databaseURL: config.firebase.databaseURL, dataPath: store.dataPath }, {
  // Reuse the SDK session; no sign-in, sync/readiness gate or history read.
  getAuth: () => !store.stopped && store.app ? store.adapter.auth(store.app) : null,
});
const terminal = new StatusLogger();
terminal.startup();
const logStatus = (status) => terminal.observe(status);
store.on('status', logStatus); // One observer, independent of SSE client count.
logStatus(store.status());
store.start();

const app = createApp({ store, config, debugCounts });
const server = app.listen(config.port, () => {
  terminal.listening(config.port);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeAllConnections(); // Includes long-lived SSE connections.
  try { await store.stop(); terminal.shutdown(); }
  catch (error) { terminal.shutdown(error); process.exitCode = 1; }
  finally { store.off('status', logStatus); }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
