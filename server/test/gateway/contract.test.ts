// Raw-payload proxy contract for the gateway (plan request-plane-gateway, todo 3).
//
// Drives the REAL gateway app over an ephemeral port with a STUBBED upstream and
// a STUBBED limiter runner, plus the real limiter registry for the gate case.
// Everything asserts the plan's pinned wire shape: every request that reaches an
// upstream is HTTP 200 whose JSON is `{status, body, headers}`; the ONLY non-200
// replies are gateway-generated `{error:...}` denials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp, PROXY_PATH } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import {
  GATED_HEADER,
  filterHeaders,
  type GatewayEnvelope,
  type GatewayRequest,
  type LimiterRun,
  type UpstreamFetch,
} from '../../src/gateway/contract.js';
import { LimiterRegistry } from '../../src/ratelimit/registry.js';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import type { RunOpts } from '../../src/ratelimit/types.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

// Fixture with whitespace + Unicode + nested JSON: any re-serialization, field
// rename or drop would change these bytes.
const RAW_BODY =
  '{\n  "data": { "price": "1.2345", "symbol": "TEST", "note": "h\u00e9llo \ud83d\ude80" },\n  "ok": true\n}';

const UPSTREAM_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'retry-after': '7',
  'x-ratelimit-reset': '4102444800',
  'x-nansen-credits-cost': '5',
  'x-nansen-credits-remaining': '999', // deliberately NOT forwarded
  'set-cookie': 'nope=1', // never forwarded
};

/** Records every limiter call so the test can assert `priority` reached it. */
function recordingLimiter(): { run: LimiterRun; calls: { api: string; opts: RunOpts }[] } {
  const calls: { api: string; opts: RunOpts }[] = [];
  const run: LimiterRun = async (api, opts, fn) => {
    calls.push({ api, opts });
    return fn();
  };
  return { run, calls };
}

async function withServer(
  deps: { upstream: UpstreamFetch; runLimiter: LimiterRun },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createGatewayApp({ tokens: TOKENS, ...deps }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

interface PostResult {
  status: number;
  json: unknown;
  headers: Headers;
}

async function post(base: string, path: string, body: unknown, token?: string): Promise<PostResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

test('filterHeaders keeps only the four-entry allowlist (case-insensitive, Headers or map)', () => {
  // Given: a response carrying allowlisted AND non-allowlisted headers.
  const filtered = filterHeaders({
    'Content-Type': 'application/json',
    'x-ratelimit-reset': '1',
    'x-nansen-credits-cost': '5',
    'retry-after': '2',
    'x-nansen-credits-remaining': '99',
    'set-cookie': 'a=b',
  });
  // Then: exactly the four allowed names (lower-cased), nothing else.
  assert.deepEqual(filtered, {
    'content-type': 'application/json',
    'retry-after': '2',
    'x-ratelimit-reset': '1',
    'x-nansen-credits-cost': '5',
  });
  // A real `Headers` instance is handled the same way.
  const headers = new Headers({ 'x-ratelimit-reset': '9', 'x-secret': 'x' });
  assert.deepEqual(filterHeaders(headers), { 'x-ratelimit-reset': '9' });
});

test('round-trips the raw upstream body byte-identically with the four allowlisted headers', async () => {
  const upstream: UpstreamFetch = async () => ({
    status: 200,
    body: RAW_BODY,
    headers: UPSTREAM_HEADERS,
  });
  const rec = recordingLimiter();

  await withServer({ upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(
      base,
      PROXY_PATH,
      { provider: 'nansen', endpoint: '/api/v1/tgm/token-information', body: { token: '0xabc' }, priority: 0 },
      TOKENS.a,
    );

    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 200);

    // (a) byte-identical: not re-serialized, not renamed, not dropped.
    assert.equal(env.body, RAW_BODY);

    // (b) the four allowlisted headers propagate; (c) everything else is dropped.
    assert.deepEqual(env.headers, {
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '7',
      'x-ratelimit-reset': '4102444800',
      'x-nansen-credits-cost': '5',
    });
    assert.equal('x-nansen-credits-remaining' in env.headers, false);
    assert.equal('set-cookie' in env.headers, false);
  });
});

test('the request body reaches upstream unchanged and priority reaches the limiter call', async () => {
  const seen: GatewayRequest[] = [];
  const upstream: UpstreamFetch = async (req) => {
    seen.push(req);
    return { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } };
  };
  const rec = recordingLimiter();

  await withServer({ upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(
      base,
      PROXY_PATH,
      {
        provider: 'nansen',
        endpoint: '/api/v1/tgm/flows',
        params: { chains: 'solana' },
        body: { page: 1, per_page: 1000 },
        priority: 0,
      },
      TOKENS.a,
    );
    assert.equal(r.status, 200);

    // The POST body is forwarded verbatim (tgm-flows pagination survives).
    assert.deepEqual(seen, [
      {
        provider: 'nansen',
        endpoint: '/api/v1/tgm/flows',
        params: { chains: 'solana' },
        body: { page: 1, per_page: 1000 },
        priority: 0,
      },
    ]);

    // (d) priority + provider + endpoint reached the limiter.
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].api, 'nansen');
    assert.equal(rec.calls[0].opts.priority, 0);
    assert.equal(rec.calls[0].opts.path, '/api/v1/tgm/flows');
  });
});

test('an upstream 429 rides INSIDE HTTP 200 as status:429 + x-ratelimit-reset, body null, no throw', async () => {
  const upstream: UpstreamFetch = async () => ({
    status: 429,
    body: '{"error":"rate limited"}', // NOT forwarded
    headers: { 'content-type': 'application/json', 'x-ratelimit-reset': '4102444800' },
  });
  const rec = recordingLimiter();

  await withServer({ upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(
      base,
      PROXY_PATH,
      { provider: 'nansen', endpoint: '/api/v1/tgm/token-information', priority: 1 },
      TOKENS.a,
    );

    // HTTP 200 + upstream status inside; never a thrown exception.
    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 429);
    assert.equal(env.body, null);
    assert.equal(env.headers['x-ratelimit-reset'], '4102444800');
  });
});

test('an armed limiter gate maps the next call to 503 {error:"gated"} + x-gateway-gated-until', async () => {
  const registry = new LimiterRegistry(buildSpecs(10));
  const runLimiter: LimiterRun = (api, opts, fn) => registry.run(api, opts, fn);
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream: UpstreamFetch = async () => ({
    status: 429,
    body: '{"error":"throttled"}',
    headers: { 'content-type': 'application/json', 'x-ratelimit-reset': reset },
  });
  const request = {
    provider: 'gmgn',
    endpoint: '/defi/router/v1/sol/tx/get_swap_route',
    priority: 1,
  };

  await withServer({ upstream, runLimiter }, async (base) => {
    const first = await post(base, PROXY_PATH, request, TOKENS.a);
    assert.equal(first.status, 200);
    const env = first.json as GatewayEnvelope;
    assert.equal(env.status, 429);
    assert.equal(env.headers['x-ratelimit-reset'], reset);

    // Second call hits the limiter's gate-already-blocked pre-flight.
    const second = await post(base, PROXY_PATH, request, TOKENS.a);
    assert.equal(second.status, 503);
    assert.deepEqual(second.json, { error: 'gated' });
    assert.ok(second.headers.get(GATED_HEADER));
  });
});

test('gateway-generated denials are non-200 {error:...}', async () => {
  const upstream: UpstreamFetch = async () => ({
    status: 200,
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  const rec = recordingLimiter();

  await withServer({ upstream, runLimiter: rec.run }, async (base) => {
    // 401: missing token.
    const noToken = await post(base, PROXY_PATH, { provider: 'nansen', endpoint: '/x' });
    assert.equal(noToken.status, 401);
    assert.deepEqual(noToken.json, { error: 'unauthorized' });

    // 400: malformed request (no endpoint).
    const bad = await post(base, PROXY_PATH, { provider: 'nansen' }, TOKENS.a);
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'bad_request' });

    // 400: body that is not valid JSON at all.
    const raw = await fetch(`${base}${PROXY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.a}` },
      body: '{not json',
    });
    assert.equal(raw.status, 400);
    assert.deepEqual(await raw.json(), { error: 'bad_request' });

    // No denial ever reached upstream.
    assert.equal(rec.calls.length, 0);
  });
});
