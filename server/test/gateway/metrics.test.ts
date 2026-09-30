// Metrics / observability endpoint (plan request-plane-gateway, todo 20).
//
// Drives the REAL gateway app over an ephemeral port with only the upstream
// bytes + cache injected. Acceptance (plan:253):
//   * token-gated: a valid Bearer (a|b|watcher) reads /metrics; absent/bogus -> 401
//   * the JSON contains EVERY limiter key from `limiters.snapshot()` plus
//     `credits{day,budget,half,used{a,b}}` and the cache counters
//   * a cacheable call moves `cache.hits` (the second identical call is a hit)
//   * `?format=text` returns the same figures as a text/plain summary

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import { DEXSCREENER_PATH } from '../../src/gateway/dexscreener.js';
import { GatewayCache } from '../../src/gateway/cache.js';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import type { UpstreamFetch } from '../../src/gateway/contract.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

/** Every limiter key the gateway registry exposes (the /metrics snapshot shape). */
const LIMITER_KEYS = Object.keys(buildSpecs(5));

interface MetricsJson {
  ok: boolean;
  caller: string | null;
  ratelimit: Record<
    string,
    { inFlight: number; queued: number; gateUntil: number; windowUsed: number }
  >;
  credits: { day: string; budget: number; half: number; used: { a: number; b: number } };
  cache: { hits: number; misses: number; joined: number; size: number; inflight: number };
  text: string;
}

let server: Server;
let base = '';
const cache = new GatewayCache();
let dexCalls = 0;

const dexUpstream: UpstreamFetch = async () => {
  dexCalls += 1;
  return {
    status: 200,
    body: '{"pairs":[{"pairAddress":"POOL","priceUsd":"1.23"}]}',
    headers: { 'content-type': 'application/json' },
  };
};

function get(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { headers });
}

before(async () => {
  server = createGatewayApp({ tokens: TOKENS, cache, dexUpstream }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  server.closeAllConnections();
});

test('GET /metrics without or with a bogus Bearer is 401', async () => {
  for (const [label, token] of [
    ['absent', undefined],
    ['bogus', 'not-a-caller-token'],
  ] as const) {
    const res = await get('/metrics', token);
    assert.equal(res.status, 401, `${label} bearer`);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('GET /metrics returns every limiter key + credits{a,b} + cache counters', async () => {
  const res = await get('/metrics', TOKENS.a);
  assert.equal(res.status, 200);
  const m = (await res.json()) as MetricsJson;
  assert.equal(m.ok, true);
  assert.equal(m.caller, 'a');

  for (const key of LIMITER_KEYS) {
    assert.ok(key in m.ratelimit, `limiter key ${key} present`);
    assert.equal(typeof m.ratelimit[key]?.windowUsed, 'number', `${key}.windowUsed is a number`);
  }
  // The plan-named keys: the DexScreener key is `dexscreener` (must still exist)
  // and the free-door limiter key is `nansen-door` (there is no bare `door` key).
  for (const key of [
    'nansen-credit',
    'nansen-door',
    'gmgn',
    'dexscreener',
    'dexscreener-profiles',
  ]) {
    assert.ok(key in m.ratelimit, `expected limiter ${key}`);
  }

  assert.equal(typeof m.credits.day, 'string');
  assert.equal(typeof m.credits.budget, 'number');
  assert.equal(typeof m.credits.half, 'number');
  assert.equal(typeof m.credits.used.a, 'number');
  assert.equal(typeof m.credits.used.b, 'number');

  for (const k of ['hits', 'misses', 'joined', 'size', 'inflight'] as const) {
    assert.equal(typeof m.cache[k], 'number', `cache.${k} is a number`);
  }
  assert.ok(m.text.length > 0, 'text summary is present');
  assert.match(m.text, /credits day=/);
  assert.match(m.text, /cache hits=/);
});

test('a cacheable call increments cache.hits and ?format=text renders the figures', async () => {
  const body = { endpoint: 'tokens', params: { addresses: 'M' } };
  const post = async (token: string): Promise<number> => {
    const res = await fetch(`${base}${DEXSCREENER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.status;
  };
  assert.equal(await post(TOKENS.a), 200);
  assert.equal(await post(TOKENS.b), 200, "caller b hits caller a's cross-caller cache entry");
  assert.equal(dexCalls, 1, 'the cache hit short-circuited before upstream');

  const res = await get('/metrics?format=text', TOKENS.watcher);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.match(text, /caller=watcher/);
  assert.match(text, /hits=1 misses=1/);
  assert.match(text, /limiter gmgn /);
});
