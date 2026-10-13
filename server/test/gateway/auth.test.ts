// Per-caller bearer auth for the gateway (plan request-plane-gateway, todo 2).
//
// Drives the REAL gateway app over an ephemeral port (same harness shape as
// test/tier.test.ts): /health is public, /v1/* needs a caller token, /metrics
// reports the caller each separate token resolves to.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import { resolveCaller, type CallerTokens } from '../../src/gateway/auth.js';
import { GmgnKeyPool } from '../../src/gateway/gmgn-keys.js';
const MONITOR_TOKEN = 'monitor-token-for-test-8d71c4a9';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

let server: Server;
let base = '';

async function get(path: string, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  const gmgnPool = new GmgnKeyPool({
    keys: [{ apiKey: 'gmgn-secret-never-return-this', limiterKey: 'gmgn:0', weight: 7 }],
    fetcherFor: () => async () => ({ status: 200, body: '{}', headers: new Headers() }),
    gateUntilOf: () => 0,
  });
  server = createGatewayApp({ tokens: TOKENS, monitorToken: MONITOR_TOKEN, gmgnPool }).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('resolveCaller maps each separate token to its caller and rejects the rest', () => {
  // Given: three distinct caller tokens.
  // When/Then: each resolves to its own caller — a shared token could not.
  assert.equal(resolveCaller(`Bearer ${TOKENS.a}`, TOKENS), 'a');
  assert.equal(resolveCaller(`Bearer ${TOKENS.b}`, TOKENS), 'b');
  assert.equal(resolveCaller(`Bearer ${TOKENS.watcher}`, TOKENS), 'watcher');
  // Failure: missing / malformed / unknown headers resolve to null (→ 401).
  assert.equal(resolveCaller(undefined, TOKENS), null);
  assert.equal(resolveCaller('', TOKENS), null);
  assert.equal(resolveCaller('Bearer', TOKENS), null);
  assert.equal(resolveCaller('Bearer ', TOKENS), null);
  assert.equal(resolveCaller('Basic abc', TOKENS), null);
  assert.equal(resolveCaller('Bearer nope', TOKENS), null);
  // A blank configured token never matches the empty string.
  assert.equal(resolveCaller('Bearer ', { a: '', b: 'x', watcher: '' }), null);
});

test('GET /health is public and returns {ok:true}', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal((r.json as { ok: boolean }).ok, true);
});

test('GET /v1/x without a token is 401 (no upstream attempted)', async () => {
  const r = await get('/v1/x');
  assert.equal(r.status, 401);
  assert.equal((r.json as { error: string }).error, 'unauthorized');
});

test('GET /v1/x with a valid token passes the gate', async () => {
  // The /v1/* proxy contract lands in todo 3; the placeholder answers 404. What
  // matters here is that a valid token is NOT rejected with 401.
  const r = await get('/v1/x', TOKENS.a);
  assert.notEqual(r.status, 401);
});

test('GET /metrics resolves distinct callers from distinct tokens', async () => {
  const a = await get('/metrics', TOKENS.a);
  assert.equal(a.status, 200);
  assert.equal((a.json as { caller: string }).caller, 'a');

  const b = await get('/metrics', TOKENS.b);
  assert.equal((b.json as { caller: string }).caller, 'b');

  const w = await get('/metrics', TOKENS.watcher);
  assert.equal((w.json as { caller: string }).caller, 'watcher');

  const none = await get('/metrics');
  assert.equal(none.status, 401);
});

test('monitor metrics require the isolated token and expose only key usage', async () => {
  assert.equal((await get('/monitor/metrics')).status, 401);
  assert.equal((await get('/monitor/metrics', TOKENS.a)).status, 401);
  assert.equal((await get('/metrics', MONITOR_TOKEN)).status, 401);
  const result = await get('/monitor/metrics', MONITOR_TOKEN);
  assert.equal(result.status, 200);
  let gmgnKeys: unknown;
  if (typeof result.json === 'object' && result.json !== null && 'gmgnKeys' in result.json) {
    gmgnKeys = result.json.gmgnKeys;
  }
  assert.equal(Array.isArray(gmgnKeys), true);
  assert.equal(JSON.stringify(result.json)?.includes('gmgn-secret-never-return-this'), false);
});
