import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { MonitorConfig } from './config.js';
import { MonitorNotifications } from './notifications.js';
import { MonitorStore } from './store.js';

export interface MonitorAppDeps {
  config: MonitorConfig;
  store: MonitorStore;
  notifications: MonitorNotifications;
}

export function createMonitorApp(deps: MonitorAppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(fileURLToPath(new URL('../../public/monitor.html', import.meta.url)));
  });
  app.get('/api/snapshot', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const now = Date.now();
    res.json({
      generatedAt: new Date(now).toISOString(),
      ...deps.store.snapshot(now, deps.config.sampleIntervalMs * 3),
      notifications: deps.notifications.status(),
    });
  });
  app.get('/api/history', (req, res) => {
    const raw = req.query.hours;
    const hours = raw === undefined ? 24 : Number(raw);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      res.status(400).json({ error: 'hours must be between 1 and 720' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(deps.store.history(hours));
  });
  return app;
}
