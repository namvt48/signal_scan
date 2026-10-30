import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createPublicApiApp } from '../src/public-api.js';
import { getDb, insertTrackedCa, open, openReadOnly } from '../src/db.js';
import { upsertTokenInfo } from '../src/ingest.js';

const internalToken = 'public-export-reader-test-token';
const tempDir = mkdtempSync(join(tmpdir(), 'signal-scan-public-reader-'));
const dbPath = join(tempDir, 'main.sqlite');
const marketDbPath = join(tempDir, 'market.sqlite');
let exporterProcess: ChildProcess | undefined;
let api: Server;
let writerDb: Database.Database;
let writerOpen = true;
let unavailableDashboard: Server;
let dashboardUrl = '';
let apiUrl = '';
let exportUrl = '';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

async function reservePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitForExporter(child: ChildProcess, url: string): Promise<void> {
  await once(child, 'spawn');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`read-only exporter exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The integration smoke waits for the child process to bind its HTTP listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('read-only exporter did not become healthy');
}


before(async () => {
  open(dbPath);
  insertTrackedCa({ address: 'reader-test-ca', chain: 'sol', note: 'private', entryUsd: 100 });
  writerDb = getDb();
  open(marketDbPath);
  upsertTokenInfo({
    ca: 'reader-test-ca', chain: 'sol', price: 0.001, holders: 10, volume24h: 20,
    buyVol24h: 12, sellVol24h: 8, marketCap: 1000, liquidity: 500, supply: 1e6,
    freshCount: 2, top10Rate: 0.1,
  });
  getDb().close();
  openReadOnly(dbPath, marketDbPath);
  const port = await reservePort();
  exportUrl = `http://127.0.0.1:${port}`;
  exporterProcess = spawn(join(serverRoot, 'node_modules', '.bin', 'tsx'), ['src/public-export-server.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PUBLIC_EXPORT_RUN: '1',
      PUBLIC_API_EXPORT_TOKEN: internalToken,
      DB_PATH: dbPath,
      MARKET_DB_PATH: marketDbPath,
      PORT: String(port),
      SHOW_FOMO: 'on',
    },
    stdio: 'ignore',
  });
  await waitForExporter(exporterProcess, exportUrl);

  unavailableDashboard = express().get('/api/internal/public-export', (_req, res) => res.sendStatus(503)).listen(0, '127.0.0.1');
  await new Promise((resolve) => unavailableDashboard.once('listening', resolve));
  dashboardUrl = `http://127.0.0.1:${(unavailableDashboard.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => unavailableDashboard.close(() => resolve()));

  api = createPublicApiApp({ internalUrl: exportUrl, fomoInternalUrl: exportUrl, internalToken }).listen(0, '127.0.0.1');
  await new Promise((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  if (writerOpen) writerDb.close();
  const shutdown: Promise<unknown>[] = [
    new Promise<void>((resolve) => api.close(() => resolve())),
  ];
  if (exporterProcess && exporterProcess.exitCode === null && exporterProcess.signalCode === null) {
    const exited = once(exporterProcess, 'exit');
    exporterProcess.kill('SIGTERM');
    shutdown.push(exited);
  }
  await Promise.all(shutdown);
  getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('continues serving uncached live reads after the dashboard API and writer stop', async () => {
  const beforeStop = await fetch(`${apiUrl}/api/v1/tokens?limit=10`);
  assert.equal(beforeStop.status, 200);
  writerDb.close();
  writerOpen = false;
  await assert.rejects(fetch(`${dashboardUrl}/api/internal/public-export?resource=tokens`));
  const response = await fetch(`${apiUrl}/api/v1/tokens?limit=9`);
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Array<{ ca: string; market: { marketCap: number | null } }> };
  assert.equal(body.data[0]?.ca, 'reader-test-ca');
  assert.equal(body.data[0]?.market.marketCap, 1000);
});

test('read-only exporter refuses writes without running migrations', () => {
  assert.equal(getDb().pragma('query_only', { simple: true }), 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM token_state').get()?.n, 1);
  assert.throws(() => getDb().prepare('INSERT INTO market_data.settings(key, value) VALUES (?, ?)').run('unsafe', '1'));
  assert.throws(() => getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('unsafe', '1'));
  assert.equal(getDb().prepare('SELECT value FROM settings WHERE key = ?').get('unsafe'), undefined);
});
test('read-only export route keeps the internal bearer gate', async () => {
  assert.equal((await fetch(`${exportUrl}/api/internal/public-export?resource=tokens`)).status, 401);
});
test('worker snapshot pagination reuses capture time and leaves health/activity responsive', async () => {
  const firstResponse = await fetch(`${exportUrl}/api/internal/public-export?resource=tokens&limit=1`, { headers: { authorization: `Bearer ${internalToken}` } });
  assert.equal(firstResponse.status, 200);
  const snapshotAt = firstResponse.headers.get('x-signal-scan-snapshot-at');
  assert.ok(snapshotAt);
  const first = await firstResponse.json() as { generatedAt: number; data: Array<{ ca: string }>; nextOffset: number | null };
  assert.equal(String(first.generatedAt), snapshotAt);
  assert.equal(first.data[0]?.ca, 'reader-test-ca');
  assert.equal(first.nextOffset, null);

  const [health, activity] = await Promise.all([
    fetch(`${exportUrl}/healthz`),
    fetch(`${exportUrl}/api/internal/public-export?resource=activity&chain=sol&ca=reader-test-ca&from=0&to=1000`, { headers: { authorization: `Bearer ${internalToken}` } }),
  ]);
  assert.equal(health.status, 200);
  assert.equal(activity.status, 200);
});
