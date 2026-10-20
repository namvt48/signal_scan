import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicApiApp } from '../src/public-api.js';

let source: Server;
let service: Server;
let sourceUrl = '';
let publicUrl = '';
let internalCalls = 0;

before(async () => {
  const sourceApp = express();
  sourceApp.get('/api/internal/public-export', (req, res) => {
    internalCalls++;
    if (req.headers.authorization !== 'Bearer internal-secret') { res.status(401).end(); return; }
    if (req.query.resource === 'tokens') res.json({ generatedAt: 123, data: [{ id: 'sol:CA', ca: 'CA', chain: 'sol', fomoUsers: undefined }], nextOffset: null });
    else if (req.query.resource === 'token') res.json({ market: { marketCap: 10 }, metrics: { score: 2 }, history: { marketCap: [] } });
    else if (req.query.resource === 'alerts') res.json({ data: [], nextId: 0, oldestAvailableId: null, gap: false });
    else if (req.query.resource === 'wallets') res.json({ data: [], nextOffset: null });
    else if (req.query.resource === 'activity') res.json({ buys: 1, sells: 0, netInflowUsd: 10 });
    else if (req.query.resource === 'trades') res.json({ data: [], nextId: null });
    else res.status(400).end();
  });
  source = sourceApp.listen(0);
  await new Promise((resolve) => source.once('listening', resolve));
  sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const app = createPublicApiApp({
    internalUrl: sourceUrl,
    internalToken: 'internal-secret',
  });
  service = app.listen(0);
  await new Promise((resolve) => service.once('listening', resolve));
  publicUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

after(() => { source.close(); service.close(); });

async function get(path: string): Promise<Response> {
  return fetch(`${publicUrl}${path}`);
}

test('serves data without client authentication while keeping private backend auth', async () => {
  const beforeCalls = internalCalls;
  assert.equal((await fetch(`${publicUrl}/api/v1/status`)).status, 200);
  assert.equal((await get('/api/v1/tokens')).status, 200);
  assert.ok(internalCalls > beforeCalls);
});

test('paginates token list and exposes allowlisted metrics routes', async () => {
  const tokens = await get('/api/v1/tokens?limit=10');
  assert.equal(tokens.status, 200);
  const body = await tokens.json() as { data: Array<Record<string, unknown>> };
  assert.equal(body.data[0]?.ca, 'CA');
  assert.equal('fomoUsers' in (body.data[0] ?? {}), false);
  assert.equal((await get('/api/v1/tokens/sol/CA/market')).status, 200);
  assert.equal((await get('/api/v1/tokens/sol/CA/metrics')).status, 200);
  assert.equal((await get('/api/v1/tokens/sol/CA/history')).status, 200);
  assert.equal((await get('/api/v1/chains')).status, 200);
  assert.equal((await get('/api/v1/tiers')).status, 200);
  assert.equal((await get('/api/v1/status')).status, 200);
});

test('validates bounds and serves alerts, activity, wallets and trades', async () => {
  assert.equal((await get('/api/v1/tokens?limit=101')).status, 400);
  assert.equal((await get('/api/v1/alerts?after_id=-1')).status, 400);
  assert.equal((await get('/api/v1/alerts')).status, 200);
  assert.equal((await get('/api/v1/tokens/sol/CA/activity')).status, 200);
  assert.equal((await get('/api/v1/wallets')).status, 200);
  assert.equal((await get('/api/v1/wallets/id/trades')).status, 200);
});

test('serves backend exports that take longer than three seconds', async () => {
  const slowSourceApp = express();
  // Real HTTP latency must exceed the abort deadline to catch premature upstream timeouts.
  slowSourceApp.get('/api/internal/public-export', (_req, res) => {
    setTimeout(() => res.json({ generatedAt: 123, data: [], nextOffset: null }), 3_500);
  });
  const slowSource = slowSourceApp.listen(0);
  await new Promise((resolve) => slowSource.once('listening', resolve));
  const slowSourceUrl = `http://127.0.0.1:${(slowSource.address() as AddressInfo).port}`;
  const slowService = createPublicApiApp({ internalUrl: slowSourceUrl, internalToken: 'internal-secret' }).listen(0);
  await new Promise((resolve) => slowService.once('listening', resolve));
  const slowServiceUrl = `http://127.0.0.1:${(slowService.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${slowServiceUrl}/api/v1/tokens?limit=1`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, []);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => slowService.close(() => resolve())),
      new Promise<void>((resolve) => slowSource.close(() => resolve())),
    ]);
  }
});

test('applies a global quota without requiring a client credential', async () => {
  const local = createPublicApiApp({ internalUrl: sourceUrl, internalToken: 'internal-secret' }).listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  try {
    let last!: Response;
    for (let i = 0; i < 121; i++) last = await fetch(`${base}/api/v1/status`);
    assert.equal(last.status, 429);
    assert.ok(last.headers.has('retry-after'));
  } finally { local.close(); }
});
