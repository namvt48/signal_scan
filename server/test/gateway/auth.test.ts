// Per-caller bearer auth for the gateway (plan request-plane-gateway, todo 2).
//
// Drives the REAL gateway app over an ephemeral port (same harness shape as
// test/tier.test.ts): /health is public, /v1/* needs a caller token, /metrics
// reports the caller each separate token resolves to.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import { resolveCaller, type CallerTokens } from '../../src/gateway/auth.js';

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
  server = createGatewayApp({ tokens: TOKENS }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
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
