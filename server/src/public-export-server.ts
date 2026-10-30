import express, { type Express } from 'express';
import { matchServiceToken } from './auth.js';
import { config } from './config.js';
import { openReadOnly } from './db.js';
import { installGracefulShutdown } from './http-lifecycle.js';
import { publicExportResource } from './public-export-route.js';
import { PublicExportSnapshotManager } from './public-export-snapshot.js';
const snapshots = new PublicExportSnapshotManager();

export function createPublicExportApp(options: { token?: string } = {}): Express {
  const token = options.token ?? config.publicApiExportToken;
  const app = express();
  app.disable('x-powered-by');
  snapshots.start();
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => res.status(snapshots.isReady() ? 200 : 503).json({ status: snapshots.isReady() ? 'ok' : 'unavailable' }));
  app.get('/api/internal/public-export', async (req, res) => {
    const authorization = req.headers.authorization;
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!matchServiceToken(provided, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      const result = await publicExportResource(req.query as Record<string, unknown>, { readOnly: true, snapshot: () => snapshots.get() });
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      res.status(result.status).json(result.body);
    } catch {
      res.status(503).json({ error: 'export unavailable' });
    }
  });
  return app;
}

if (process.env.PUBLIC_EXPORT_RUN === '1') {
  openReadOnly(config.dbPath, config.marketDbPath);
  const app = createPublicExportApp();
  const server = app.listen(config.port, '0.0.0.0', () => console.log(`[public-export] read-only listener on ${config.port}`));
  installGracefulShutdown(server, { drainTimeoutMs: 10_000, onClose: () => snapshots.stop() });
}
