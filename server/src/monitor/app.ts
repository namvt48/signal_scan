import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { MonitorConfig } from './config.js';
import type { MonitorHistory } from './types.js';
import { MonitorNotifications } from './notifications.js';
import { MonitorStore } from './store.js';

export interface MonitorAppDeps {
  config: MonitorConfig;
  store: MonitorStore;
  notifications: MonitorNotifications;
}

const MAX_HISTORY_POINTS = 300;

/**
 * Keep at most one point per time bucket per series. Values in history are
 * cumulative, so the last point in a bucket preserves the running total while
 * keeping the 24h chart payload small enough for a first page load.
 */
function downsampleHistory(
  payload: MonitorHistory,
  maxPoints = MAX_HISTORY_POINTS,
): MonitorHistory {
  return {
    series: payload.series.map((series) => {
      const points = series.points;
      if (points.length <= maxPoints) return series;
      const first = points[0].ts;
      const last = points[points.length - 1].ts;
      const bucketMs = Math.max(1, Math.ceil((last - first) / Math.max(1, maxPoints - 1)));
      const kept: typeof points = [];
      let bucket = -1;
      for (const point of points) {
        const next = Math.floor((point.ts - first) / bucketMs);
        if (next !== bucket) {
          kept.push(point);
          bucket = next;
        } else {
          kept[kept.length - 1] = point;
        }
      }
      return { ...series, points: kept };
    }),
  };
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
    res.json(downsampleHistory(deps.store.history(hours)));
  });
  return app;
}
