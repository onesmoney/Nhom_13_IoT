import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerRoutes } from './http/routes.js';

const defaultClientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));

// Composition supplies the store and diagnostic service. No configuration load,
// Firebase initialization, worker startup, signal handlers or listening here.
export function createApp({ store, config = {}, debugCounts, clientDist = defaultClientDist }) {
  const app = express();
  registerRoutes(app, { store, config, debugCounts });

  // null disables static serving; resolve injected paths before sendFile uses them.
  if (clientDist && existsSync(clientDist)) {
    const root = resolve(clientDist);
    app.use(express.static(root));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile('index.html', { root });
    });
  }
  return app;
}
