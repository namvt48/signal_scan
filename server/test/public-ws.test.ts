import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../src/api.js';
import { createPublicApiServer } from '../src/public-api.js';
import { appendAlertMetricObservation, getDb, insertWallet, open } from '../src/db.js';
import type { PublicAlert } from '../src/public-api-contract.js';

const SERVICE_TOKEN = 'ws-test-service-token';
const EXPORT_TOKEN = 'ws-test-export-token';

test('streams only new durable inflow alerts, paginates bursts and isolates new subscribers', { timeout: 15_000 }, async (t) => {
  open(':memory:');
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
      body: JSON.stringify({ wallet: 'ws-wallet', ca: 'ws-ca', chain: 'sol', tx, ts: 1_758_000_000_000, side, amountUsd: 250, price: 0.002 }),
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

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for WebSocket event');
    await delay(10);
  }
}

test('closes with an explicit error when the private data source is unavailable', { timeout: 5_000 }, async (t) => {
  const service = createPublicApiServer({ internalUrl: '', internalToken: '' });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const ws = new WebSocket(`ws://127.0.0.1:${(service.address() as AddressInfo).port}/api/v1/ws`);
  t.after(() => { ws.terminate(); service.close(); });
  const [code] = await once(ws, 'close');
  assert.equal(code, 1011);
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
