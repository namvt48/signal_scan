import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../src/api.js';
import { createPublicApiServer } from '../src/public-api.js';
import { appendAlertMetricObservation, getDb, insertWallet, open, setSetting } from '../src/db.js';
import type { PublicAlert } from '../src/public-api-contract.js';

const SERVICE_TOKEN = 'ws-test-service-token';
const EXPORT_TOKEN = 'ws-test-export-token';

test('streams only new durable inflow alerts, paginates bursts and isolates new subscribers', { timeout: 25_000 }, async (t) => {
  open(':memory:');
  setSetting('systemDeployAt', '1700000000000');
  insertWallet({ address: 'ws-wallet', name: 'private-name', tags: [], chain: 'sol', source: 'test' });
  const source = createApp('ws-test', { serviceToken: SERVICE_TOKEN, publicExportToken: EXPORT_TOKEN }).listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, internalToken: EXPORT_TOKEN, heartbeatIntervalMs: 25 });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const url = `ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws`;
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await Promise.all([new Promise<void>((resolve) => service.close(() => resolve())), new Promise<void>((resolve) => source.close(() => resolve()))]);
  });
  async function buy(tx: string, side = 'buy') {
    const response = await fetch(`${sourceUrl}/api/wallet-watch/trades`, {
      method: 'POST', headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: 'ws-wallet', ca: 'ws-ca', chain: 'sol', tx, ts: 1_758_000_000_000, side, amountUsd: 250, price: 0.002, provenance: 'live' }),
    });
    assert.equal(response.status, 200);
  }
  async function connect() {
    const ws = new WebSocket(url);
    clients.push(ws);
    const messages: Array<{ type: string; data?: PublicAlert; afterId?: number }> = [];
    let pings = 0;
    ws.on('ping', () => { pings++; });
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await until(() => messages.some((message) => message.type === 'ready'));
    return { ws, messages, get pings() { return pings; } };
  }
  await buy('old');
  const first = await connect();
  await buy('new');
  await buy('new'); // Watcher replay must not emit twice.
  await buy('sell', 'sell');
  appendAlertMetricObservation(getDb(), 'ws-ca', 'sol', 'fresh', 20, Date.now());
  for (let i = 0; i < 205; i++) appendAlertMetricObservation(getDb(), 'burst-ca', 'base', 'trackerBuy', i + 1, Date.now(), { name: 'secret', address: 'wallet' });
  await until(() => first.messages.filter((message) => message.type === 'inflow').length === 206);
  const inflows = first.messages.filter((message) => message.type === 'inflow').map((message) => message.data!);
  assert.equal(inflows[0].ca, 'ws-ca');
  assert.equal(inflows[0].value, 250);
  assert.equal(inflows[0].responseAt, 1_758_000_000_000, 'new arrival may have an older transaction timestamp');
  assert.deepEqual(inflows.slice(1).map((item) => item.value), Array.from({ length: 205 }, (_, i) => i + 1));
  assert.equal(new Set(inflows.map((item) => item.id)).size, 206);
  assert.ok(inflows.every((item) => item.metric === 'trackerBuy'));
  assert.ok(inflows.every((item) => !('trackerBuyer' in item.snapshot) && !('tracked' in item.snapshot)));
  const second = await connect();
  await buy('after-second');
  await until(() => second.messages.some((message) => message.type === 'inflow'));
  await until(() => first.pings >= 2);
  assert.equal(first.ws.readyState, WebSocket.OPEN, 'pong responses keep the idle connection alive');
  await buy('after-heartbeat');
  await until(() => first.messages.filter((message) => message.type === 'inflow').length === 207);
  const closed = once(first.ws, 'close');
  first.ws.close();
  await closed;
  assert.equal((await fetch(url.replace('ws:', 'http:').replace('/ws', '/status'))).status, 200);
});

test('streams tracker-buy alerts from the FOMO upstream on its own path', { timeout: 10_000 }, async (t) => {
  let alerts: Array<PublicAlert> = [];
  const fomoApp = express();
  fomoApp.get('/api/internal/public-export', (req, res) => {
    const afterId = Number(req.query.afterId ?? 0);
    if (req.query.resource === 'latestAlertId') { res.json({ data: [], nextId: alerts.at(-1)?.id ?? 0 }); return; }
    const page = alerts.filter((alert) => alert.id > afterId).slice(0, Number(req.query.limit ?? 100));
    res.json({ data: page, nextId: page.at(-1)?.id ?? afterId, oldestAvailableId: null, gap: false });
  });
  const fomoSource = fomoApp.listen(0, '127.0.0.1');
  await once(fomoSource, 'listening');
  const fomoUrl = `http://127.0.0.1:${(fomoSource.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: '', internalToken: 'fomo-ws-token', fomoInternalUrl: fomoUrl });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/fomo/ws`);
  const messages: Array<{ type: string; data?: PublicAlert }> = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  t.after(async () => {
    ws.terminate();
    await Promise.all([new Promise<void>((resolve) => service.close(() => resolve())), new Promise<void>((resolve) => fomoSource.close(() => resolve()))]);
  });
  await until(() => messages.some((message) => message.type === 'ready'));
  alerts = [{
    id: 1, ca: 'fomo-ca', chain: 'eth', metric: 'trackerBuy', value: 42, responseAt: 1_758_000_000_000,
    snapshot: {
      capturedAt: 1_758_000_000_000, symbol: 'FOMO', marketCap: 1000, marketCapAt: 1_758_000_000_000,
      freshPct: 10, t100Multiple: 1, lf: 1, trackedHoldingPct: null, iconUrl: null, xHandle: null,
    },
  }];
  await until(() => messages.some((message) => message.type === 'inflow'));
  const inflow = messages.find((message) => message.type === 'inflow')!.data!;
  assert.equal(inflow.ca, 'fomo-ca');
  assert.equal(inflow.metric, 'trackerBuy');
  assert.equal(inflow.value, 42);
});

async function until(predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for WebSocket event');
    await delay(10);
  }
}

test('closes with an explicit error when the private data source is unavailable', { timeout: 5_000 }, async (t) => {
  const service = createPublicApiServer({ internalUrl: '', internalToken: '' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const port = (service.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
  const fomoWs = new WebSocket(`ws://127.0.0.1:${port}/api/v1/fomo/ws`);
  t.after(() => { ws.terminate(); fomoWs.terminate(); service.close(); });
  const [code] = await once(ws, 'close');
  assert.equal(code, 1011);
  const [fomoCode] = await once(fomoWs, 'close');
  assert.equal(fomoCode, 1011);
});

test('terminates a client that does not answer heartbeat pings', { timeout: 5_000 }, async (t) => {
  const sourceServer = express().get('/api/internal/public-export', (_req, res) => res.json({ data: [], nextId: 0 })).listen(0, '127.0.0.1');
  await once(sourceServer, 'listening');
  const sourceUrl = `http://127.0.0.1:${(sourceServer.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, internalToken: 'heartbeat-test-token', heartbeatIntervalMs: 25 });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws`, { autoPong: false });
  t.after(() => { ws.terminate(); service.close(); sourceServer.close(); });
  await once(ws, 'message');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1006);
});

test('rejects WebSocket upgrades above the connection limit and frees slots on close', { timeout: 10_000 }, async (t) => {
  const source = express().get('/api/internal/public-export', (_req, res) => res.json({ data: [], nextId: 0 })).listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, internalToken: 'capacity-test-token' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const url = `ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws`;
  const clients: WebSocket[] = [];
  t.after(() => {
    for (const client of clients) client.terminate();
    service.close();
    source.close();
  });
  async function openClient() {
    const client = new WebSocket(url);
    clients.push(client);
    await once(client, 'open');
    return client;
  }
  const admitted = await Promise.all(Array.from({ length: 64 }, () => openClient()));
  const denied = new WebSocket(url);
  clients.push(denied);
  const [error] = await once(denied, 'error');
  assert.match((error as Error).message, /503/);
  admitted[0]!.close();
  await once(admitted[0]!, 'close');
  const replacement = await openClient();
  assert.equal(replacement.readyState, WebSocket.OPEN);
});

test('readiness requires authenticated main and FOMO exports', { timeout: 5_000 }, async (t) => {
  let fomoAvailable = false;
  const source = express().get('/api/internal/public-export', (req, res) => {
    if (req.headers.authorization !== 'Bearer readiness-token') { res.sendStatus(401); return; }
    if (req.query.resource === 'fomoTokens' && !fomoAvailable) { res.sendStatus(503); return; }
    res.json({ data: [], nextId: 0 });
  }).listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, fomoInternalUrl: sourceUrl, internalToken: 'readiness-token' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => service.close(() => resolve())),
      new Promise<void>((resolve) => source.close(() => resolve())),
    ]);
  });
  const url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/readyz`;
  assert.equal((await fetch(url)).status, 503);
  fomoAvailable = true;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready', release: 'unknown' });
});

test('rejects future and retention-gap replay cursors explicitly', { timeout: 5_000 }, async (t) => {
  const source = express().get('/api/internal/public-export', (req, res) => {
    if (req.query.resource === 'latestAlertId') { res.json({ data: [], nextId: 4 }); return; }
    res.json({ data: [], nextId: 4, oldestAvailableId: 3, gap: req.query.afterId === '1' });
  }).listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, internalToken: 'cursor-token' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => service.close(() => resolve())),
      new Promise<void>((resolve) => source.close(() => resolve())),
    ]);
  });
  for (const [cursor, expected] of [[1, 'cursor_gap'], [5, 'invalid_cursor']] as const) {
    const ws = new WebSocket(`ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws?after_id=${cursor}`);
    const messages: Array<{ type: string }> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    const [code] = await once(ws, 'close');
    assert.equal(code, 1008);
    assert.ok(messages.some((message) => message.type === expected));
  }
});

test('drain closes streams and marks readiness unavailable', { timeout: 5_000 }, async (t) => {
  const source = express().get('/api/internal/public-export', (_req, res) => res.json({ data: [], nextId: 0 })).listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, fomoInternalUrl: sourceUrl, internalToken: 'drain-token' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws`);
  t.after(async () => {
    ws.terminate();
    await Promise.all([
      new Promise<void>((resolve) => service.close(() => resolve())),
      new Promise<void>((resolve) => source.close(() => resolve())),
    ]);
  });
  await once(ws, 'message');
  service.emit('drain');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1012);
  assert.equal((await fetch(`http://127.0.0.1:${(service.address() as AddressInfo).port}/readyz`)).status, 503);
});

test('drain during WebSocket initialization closes the pending connection', { timeout: 5_000 }, async (t) => {
  let beginFetch!: () => void;
  let releaseResponse!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { beginFetch = resolve; });
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const source = express().get('/api/internal/public-export', (req, res) => {
    if (req.query.resource === 'latestAlertId') {
      beginFetch();
      void responseGate.then(() => res.json({ data: [], nextId: 0 }));
      return;
    }
    res.json({ data: [], nextId: 0 });
  }).listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const service = createPublicApiServer({ internalUrl: sourceUrl, internalToken: 'pending-drain-token' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws`);
  const messages: Array<{ type: string }> = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  t.after(async () => {
    ws.terminate();
    await Promise.all([
      new Promise<void>((resolve) => service.close(() => resolve())),
      new Promise<void>((resolve) => source.close(() => resolve())),
    ]);
  });

  await once(ws, 'open');
  await fetchStarted;
  service.emit('drain');
  releaseResponse();
  const [code] = await once(ws, 'close');
  assert.equal(code, 1012);
  assert.ok(!messages.some((message) => message.type === 'ready'));
});
