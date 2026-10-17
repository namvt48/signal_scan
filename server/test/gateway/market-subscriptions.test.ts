import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { appendAlertMetricObservation, getAlertMetricObservations, getDb, listTrackedCas, open } from '../../src/db.js';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';

const tokens: CallerTokens = { a: 'token-a-secret', b: 'token-b-secret', watcher: 'token-w-secret' };
const addedTargets: (readonly { address: string; chain: string }[])[] = [];
let dir: string;
let server: Server;
let base = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'signal-scan-market-route-'));
  open(join(dir, 'market.db'));
  server = createGatewayApp({
    tokens,
    onMarketTargetsAdded: (targets) => addedTargets.push(targets),
  }).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('A/B maintain a gateway union and non-dashboard callers cannot register targets', async () => {
  const tokenA = { ca: '11111111111111111111111111111111', chain: 'sol' };
  const tokenB = { ca: '0x0000000000000000000000000000000000000001', chain: 'base' };
  const request = async (token: string | undefined, body: unknown) => fetch(`${base}/v1/market/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

  assert.equal((await request(undefined, { tokens: [tokenA] })).status, 401);
  assert.equal((await request(tokens.watcher, { tokens: [tokenA] })).status, 403);
  assert.equal((await request(tokens.a, { tokens: [{ ca: 'bad', chain: 'sol' }] })).status, 400);

  assert.equal((await request(tokens.a, { tokens: [tokenA] })).status, 200);
  assert.equal((await request(tokens.b, { tokens: [tokenA, tokenB] })).status, 200);
  assert.deepEqual(listTrackedCas().map(({ address, chain }) => `${chain}:${address}`).sort(), [
    'base:0x0000000000000000000000000000000000000001',
    'sol:11111111111111111111111111111111',
  ]);
  assert.deepEqual(addedTargets.map((targets) => targets.map(({ address, chain }) => `${chain}:${address}`)), [
    ['sol:11111111111111111111111111111111'],
    ['base:0x0000000000000000000000000000000000000001'],
  ]);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM market_subscriptions').get() as { n: number }).n, 3);
});

test('shared alert source is compacted only after both dashboard delivery cursors advance', async () => {
  appendAlertMetricObservation(getDb(), '11111111111111111111111111111111', 'sol', 'fresh', 42, 1_900_000_000_000);
  const row = getAlertMetricObservations(0, 1)[0];
  assert.ok(row);
  const ack = async (token: string, throughId: number) => fetch(`${base}/v1/market/alerts/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ throughId }),
  });

  assert.equal((await ack(tokens.watcher, row.id)).status, 403);
  assert.equal((await ack(tokens.a, row.id + 1)).status, 409);
  assert.equal((await ack(tokens.a, row.id)).status, 200);
  assert.equal(getAlertMetricObservations(0, 10).length, 1, 'A acknowledgement must retain the source for B');
  assert.equal((await ack(tokens.b, row.id)).status, 200);
  assert.deepEqual(getAlertMetricObservations(0, 10), []);
});
