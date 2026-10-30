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
    else if (req.query.resource === 'token') {
      if (req.query.ca === 'missing') { res.status(404).end(); return; }
      res.json({ market: { marketCap: 10 }, metrics: { score: 2 }, history: { marketCap: [] } });
    }
    else if (req.query.resource === 'alerts') res.json({ data: [], nextId: 0, oldestAvailableId: null, gap: false });
    else if (req.query.resource === 'wallets') res.json({ data: [], nextOffset: null });
    else if (req.query.resource === 'activity') res.json({ buys: 1, sells: 0, netInflowUsd: 10 });
    else if (req.query.resource === 'detail') {
      if (req.query.ca === 'missing') { res.status(404).end(); return; }
      res.json({ ca: 'CA', chain: 'sol', supply: 10, top100: [] });
    }
    else if (req.query.resource === 'balance') res.json({ source: 'snapshots', points: [] });
    else if (req.query.resource === 'trades') res.json({ data: [], nextId: null });
    else if (req.query.resource === 'fomoUsers') res.json({ data: [{ id: 'u1', handle: '@u1' }], nextOffset: null });
    else if (req.query.resource === 'fomoTokens') res.json({ generatedAt: 123, data: [{ id: 'sol:CA', ca: 'CA', chain: 'sol', fomoUsers: [{ handle: '@u1' }] }], nextOffset: null });
    else if (req.query.resource === 'fomoToken') {
      if (req.query.ca === 'missing') { res.status(404).end(); return; }
      res.json({ id: 'sol:CA', ca: 'CA', chain: 'sol', fomoUsers: [{ handle: '@u1' }] });
    }
    else if (req.query.resource === 'fomoTrades') res.json({ data: [], nextId: null });
    else if (req.query.resource === 'fomoTokenStats') res.json({ data: [] });
    else if (req.query.resource === 'fomoPositions') res.json({ data: [], freshness: { balances: null, positions: null } });
    else res.status(400).end();
  });
  source = sourceApp.listen(0);
  await new Promise((resolve) => source.once('listening', resolve));
  sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const app = createPublicApiApp({
    internalUrl: sourceUrl,
    internalToken: 'internal-secret',
    fomoInternalUrl: sourceUrl,
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
  assert.equal((await get('/api/v1/tokens/sol/CA/detail')).status, 200);
  assert.equal((await get('/api/v1/tokens/sol/CA/balance-chart')).status, 200);
  assert.equal((await get('/api/v1/tokens/sol/CA/balance-chart?window=month')).status, 200);
  assert.equal((await get('/api/v1/tokens/sol/CA/balance-chart?window=year')).status, 400);
  assert.equal((await get('/api/v1/wallets')).status, 200);
  assert.equal((await get('/api/v1/wallets/id/trades')).status, 200);
});

test('serves FOMO dashboard data through its own upstream', async () => {
  assert.equal((await get('/api/v1/fomo/users?limit=10')).status, 200);
  const users = await (await get('/api/v1/fomo/users')).json() as { data: Array<{ handle: string }> };
  assert.equal(users.data[0]?.handle, '@u1');
  assert.equal((await get('/api/v1/fomo/users/u1/trades')).status, 200);
  assert.equal((await get('/api/v1/fomo/users/u1/positions')).status, 200);
  assert.equal((await get('/api/v1/fomo/tokens/base/0xabc/users')).status, 200);
  assert.equal((await get('/api/v1/fomo/tokens/eth/0xabc/users')).status, 200);
  assert.equal((await get('/api/v1/fomo/tokens/dog/0xabc/users')).status, 400);
  assert.equal((await get('/api/v1/fomo/tokens?limit=101')).status, 400);
  const table = await (await get('/api/v1/fomo/tokens')).json() as { data: Array<{ ca: string; fomoUsers: Array<{ handle: string }> }> };
  assert.equal(table.data[0]?.fomoUsers[0]?.handle, '@u1');
  assert.equal((await get('/api/v1/fomo/tokens/sol/CA')).status, 200);
  assert.equal((await get('/api/v1/fomo/tokens/sol/missing')).status, 404);
  assert.equal((await get('/api/v1/fomo/tokens/eth/0xabc')).status, 200);
  assert.equal((await get('/api/v1/fomo/tokens/dog/0xabc')).status, 400);
  assert.equal((await get('/api/v1/fomo/alerts')).status, 200);
  assert.equal((await get('/api/v1/fomo/alerts?after_id=-1')).status, 400);
  assert.equal((await get('/api/v1/fomo/wallets')).status, 200);
  assert.equal((await get('/api/v1/fomo/wallets/id/trades')).status, 200);
  assert.equal((await get('/api/v1/fomo/wallets/id/trades?limit=101')).status, 400);
  assert.equal((await get(`/api/v1/fomo/users/${'x'.repeat(129)}/positions`)).status, 400);
  assert.equal((await get('/api/v1/fomo/users/u1/trades?limit=101')).status, 400);
});

test('FOMO routes return 502 when no FOMO upstream is configured', async () => {
  const local = createPublicApiApp({ internalUrl: sourceUrl, internalToken: 'internal-secret', fomoInternalUrl: '' }).listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/v1/fomo/users`)).status, 502);
    assert.equal((await fetch(`${base}/api/v1/fomo/tokens`)).status, 502);
    assert.equal((await fetch(`${base}/api/v1/fomo/alerts`)).status, 502);
    assert.equal((await fetch(`${base}/api/v1/fomo/wallets`)).status, 502);
    assert.equal((await fetch(`${base}/api/v1/tokens`)).status, 200);
  } finally { local.close(); }
});

test('preserves backend 404 for missing tokens and detail', async () => {
  assert.equal((await get('/api/v1/tokens/sol/missing')).status, 404);
  assert.equal((await get('/api/v1/tokens/sol/missing/metrics')).status, 404);
  assert.equal((await get('/api/v1/tokens/sol/missing/detail')).status, 404);
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
test('coalesces concurrent public requests and reuses the short response cache', async () => {
  let upstreamCalls = 0;
  const cacheSourceApp = express();
  cacheSourceApp.get('/api/internal/public-export', (_req, res) => {
    upstreamCalls++;
    res.json({ generatedAt: 123, data: [], nextOffset: null });
  });
  const cacheSource = cacheSourceApp.listen(0);
  await new Promise((resolve) => cacheSource.once('listening', resolve));
  const cacheSourceUrl = `http://127.0.0.1:${(cacheSource.address() as AddressInfo).port}`;
  const cacheService = createPublicApiApp({ internalUrl: cacheSourceUrl, internalToken: 'internal-secret' }).listen(0);
  await new Promise((resolve) => cacheService.once('listening', resolve));
  const cacheServiceUrl = `http://127.0.0.1:${(cacheService.address() as AddressInfo).port}`;
  const requestUrl = `${cacheServiceUrl}/api/v1/tokens?limit=7&offset=42`;
  try {
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(requestUrl)));
    assert.deepEqual(responses.map((response) => response.status), Array(6).fill(200));
    assert.equal(upstreamCalls, 1, 'identical in-flight requests must share one export fetch');
    assert.equal((await fetch(requestUrl)).status, 200);
    assert.equal(upstreamCalls, 1, 'a cache hit must not start another export fetch');
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => cacheService.close(() => resolve())),
      new Promise<void>((resolve) => cacheSource.close(() => resolve())),
    ]);
  }
});
test('uses bounded freshness by resource and keeps FOMO responses separate', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let mainCalls = 0;
  let fomoCalls = 0;
  let failActivity = true;
  const mainApp = express();
  mainApp.get('/api/internal/public-export', (req, res) => {
    if (req.query.resource === 'activity' && failActivity) { res.status(503).end(); return; }
    mainCalls++;
    res.json({ source: 'main', calls: mainCalls });
  });
  const fomoApp = express();
  fomoApp.get('/api/internal/public-export', (_req, res) => {
    fomoCalls++;
    res.json({ source: 'fomo', calls: fomoCalls });
  });
  const mainSource = mainApp.listen(0);
  const fomoSource = fomoApp.listen(0);
  await Promise.all([
    new Promise((resolve) => mainSource.once('listening', resolve)),
    new Promise((resolve) => fomoSource.once('listening', resolve)),
  ]);
  const local = createPublicApiApp({
    internalUrl: `http://127.0.0.1:${(mainSource.address() as AddressInfo).port}`,
    fomoInternalUrl: `http://127.0.0.1:${(fomoSource.address() as AddressInfo).port}`,
    internalToken: 'internal-secret',
  }).listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  try {
    const tokenPath = '/api/v1/tokens?limit=7&offset=42';
    const first = await (await fetch(`${base}${tokenPath}`)).json() as { source: string; calls: number };
    now += 1_000;
    const cached = await (await fetch(`${base}${tokenPath}`)).json() as { source: string; calls: number };
    assert.deepEqual(first, { source: 'main', calls: 1 });
    assert.deepEqual(cached, first, 'token pages remain cached within their five-second freshness window');
    const fomo = await (await fetch(`${base}/api/v1/fomo/tokens?limit=7&offset=42`)).json() as { source: string; calls: number };
    assert.deepEqual(fomo, { source: 'fomo', calls: 1 }, 'FOMO uses its own upstream and cache identity');
    assert.equal(mainCalls, 1);
    assert.equal(fomoCalls, 1);
    const activityPath = '/api/v1/tokens/sol/CA/activity?from=1&to=86400001';
    assert.equal((await fetch(`${base}${activityPath}`)).status, 502);
    failActivity = false;
    assert.equal((await fetch(`${base}${activityPath}`)).status, 200, 'failed upstream responses are not cached');
    now += 1_050;
    await fetch(`${base}${activityPath}`);
    assert.equal(mainCalls, 3, 'activity results expire after one second');
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => local.close(() => resolve())),
      new Promise<void>((resolve) => mainSource.close(() => resolve())),
      new Promise<void>((resolve) => fomoSource.close(() => resolve())),
    ]);
  }
});

test('expires cached token responses at the upstream snapshot age bound', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let unavailable = false;
  const source = express().get('/api/internal/public-export', (_req, res) => {
    if (unavailable) { res.status(503).end(); return; }
    res.setHeader('X-Signal-Scan-Snapshot-At', String(now - 59_000));
    res.json({ generatedAt: now - 59_000, data: [], nextOffset: null });
  }).listen(0);
  await new Promise((resolve) => source.once('listening', resolve));
  const local = createPublicApiApp({
    internalUrl: `http://127.0.0.1:${(source.address() as AddressInfo).port}`,
    internalToken: 'internal-secret',
  }).listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  const path = `http://127.0.0.1:${(local.address() as AddressInfo).port}/api/v1/tokens`;
  try {
    assert.equal((await fetch(path)).status, 200);
    unavailable = true;
    now += 1_000;
    assert.equal((await fetch(path)).status, 502, 'five-second response TTL must not extend the snapshot past 60 seconds');
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => local.close(() => resolve())),
      new Promise<void>((resolve) => source.close(() => resolve())),
    ]);
  }
});

test('keeps an explicit recent from valid when to uses the current time', async (t) => {
  t.mock.method(Date, 'now', () => 1_790_000_000_500);
  const response = await get('/api/v1/tokens/sol/CA/activity?from=1790000000400');
  assert.equal(response.status, 200);
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
