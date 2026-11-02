import { availabilityHandler, devicesHandler, readingsHandler } from './controllers/readings.js';
import { debugCountsHandler } from './controllers/debugCounts.js';
import { streamHandler } from './sse.js';

export function registerRoutes(app, { store, config, debugCounts }) {
  app.get('/api/status', (_req, res) => res.json(store.status()));
  app.get('/api/debug/counts', debugCountsHandler(debugCounts, { token: config.debugApiToken }));
  app.get('/api/devices', devicesHandler(store));
  app.get('/api/readings', readingsHandler(store));
  app.get('/api/availability', availabilityHandler(store));
  app.get('/api/stream', streamHandler(store));
}
