// GMGN token/info gateway route (plan request-plane-gateway, todo 8).
//
//   (a) the per-request weight + priority reach `limiters.run('gmgn', ...)`
//   (b) a weight-1 call consumes the bucket; the next call is DELAYED, never rejected
//   (c) two identical calls produce TWO upstream calls (never cached/deduped)
//   (d) the real fetcher adds a FRESH client_id + timestamp and the X-APIKEY header
//   (e) an upstream 403 surfaces as a distinct status AND arms the gmgn gate
//       (the next call backs off instead of retrying the blocked egress)
//   + the route is caller-gated and rejects a bad body at the trust boundary
//
// The HTTP assertions drive the REAL gateway app over ephemeral ports with a
// STUBBED upstream; the limiter is the real registry where the gate/bucket
// behaviour is under test, and a pass-through runner where it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import {
  GMGN_TOKEN_INFO_ENDPOINT,
  GMGN_TOKEN_INFO_PATH,
  GMGN_TOKEN_INFO_WEIGHT,
  gmgnTokenInfoUpstream,
  parseGmgnTokenInfo,
} from '../../src/gateway/gmgn.js';
import {
  GATED_HEADER,
  type GatewayEnvelope,
  type GatewayRequest,
  type LimiterRun,
  type UpstreamFetch,
  type UpstreamResponse,
} from '../../src/gateway/contract.js';
import { LimiterRegistry } from '../../src/ratelimit/registry.js';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import { GmgnKeyPool, type GmgnKey } from '../../src/gateway/gmgn-keys.js';
import type { RunOpts } from '../../src/ratelimit/types.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

function okUpstream(body = '{"code":0,"data":{"symbol":"MINI"}}'): UpstreamResponse {
  return { status: 200, body, headers: { 'content-type': 'application/json' } };
}

/** A runner that records calls and executes the job untouched (no throttle). */
function recordingLimiter(): { run: LimiterRun; calls: { api: string; opts: RunOpts }[] } {
  const calls: { api: string; opts: RunOpts }[] = [];
  const run: LimiterRun = async (api, opts, fn) => {
    calls.push({ api, opts });
    return fn();
  };
  return { run, calls };
}

async function withServer(
  deps: { gmgnUpstream?: UpstreamFetch; runLimiter?: LimiterRun; gmgnPool?: GmgnKeyPool },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createGatewayApp({
    tokens: TOKENS,
    gmgnUpstream: deps.gmgnUpstream,
    runLimiter: deps.runLimiter,
    gmgnPool: deps.gmgnPool,
  }).listen(0);
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

async function post(base: string, body: unknown, token?: string): Promise<PostResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${GMGN_TOKEN_INFO_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

test('parseGmgnTokenInfo validates ca / chain / priority at the trust boundary', () => {
  assert.deepEqual(parseGmgnTokenInfo({ ca: 'CA', chain: 'sol' }), {
    ok: true,
    value: { ca: 'CA', chain: 'sol', priority: undefined },
  });
  assert.deepEqual(parseGmgnTokenInfo({ ca: 'CA', chain: 'bsc', priority: 0 }), {
    ok: true,
    value: { ca: 'CA', chain: 'bsc', priority: 0 },
  });
  assert.equal(parseGmgnTokenInfo({ ca: '', chain: 'sol' }).ok, false);
  assert.equal(parseGmgnTokenInfo({ ca: 'CA', chain: 'doge' }).ok, false);
  assert.equal(parseGmgnTokenInfo({ ca: 'CA', chain: 'sol', priority: 3 }).ok, false);
  assert.equal(parseGmgnTokenInfo(null).ok, false);
});

test('(a) the weight + priority reach the gmgn limiter call', async () => {
  const upstream: UpstreamFetch = async () => okUpstream();
  const rec = recordingLimiter();

  await withServer({ gmgnUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(base, { ca: 'CA', chain: 'sol', priority: 0 }, TOKENS.a);
    assert.equal(r.status, 200);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].api, 'gmgn');
    assert.equal(rec.calls[0].opts.weight, GMGN_TOKEN_INFO_WEIGHT);
    assert.equal(rec.calls[0].opts.priority, 0);
    assert.equal(rec.calls[0].opts.path, GMGN_TOKEN_INFO_ENDPOINT);
  });
});

test('(b) a weight-1 call consumes the bucket; the next call is DELAYED, not rejected', async () => {
  // gmgn plan weight 1 ⇒ capacity 1, refill 1/s: one call drains the bucket.
  const registry = new LimiterRegistry(buildSpecs(1));
  const runLimiter: LimiterRun = (api, opts, fn) => registry.run(api, opts, fn);
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream();
  };

  await withServer({ gmgnUpstream: upstream, runLimiter }, async (base) => {
    const t0 = Date.now();
    const first = await post(base, { ca: 'CA', chain: 'sol' }, TOKENS.a);
    const firstMs = Date.now() - t0;

    const t1 = Date.now();
    const second = await post(base, { ca: 'CA', chain: 'sol' }, TOKENS.a);
    const secondMs = Date.now() - t1;

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'the queued call waits for a refill; it is never rejected');
    assert.ok(firstMs < 500, `first call is immediate (took ${firstMs}ms)`);
    assert.ok(secondMs >= 900, `second call waited out the empty bucket (took ${secondMs}ms)`);
    assert.equal(calls, 2);
  });
});

test('(c) two identical GMGN calls produce TWO upstream calls (never cached/deduped)', async () => {
  const seen: GatewayRequest[] = [];
  const upstream: UpstreamFetch = async (req) => {
    seen.push(req);
    return okUpstream();
  };
  const rec = recordingLimiter();

  await withServer({ gmgnUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const body = { ca: 'CA', chain: 'sol' };
    const [r1, r2] = await Promise.all([
      post(base, body, TOKENS.a),
      post(base, body, TOKENS.a),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(seen.length, 2, 'both requests reached upstream — no cache/single-flight collapse');
    assert.equal(seen[0].provider, 'gmgn');
    assert.equal(seen[0].endpoint, GMGN_TOKEN_INFO_ENDPOINT);
    assert.deepEqual(seen[0].params, { chain: 'sol', address: 'CA' });
  });
});

test('(d) the real fetcher adds a FRESH client_id + timestamp and sends X-APIKEY', async () => {
  const urls: string[] = [];
  const keys: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    const headers = init?.headers as Record<string, string> | undefined;
    keys.push(headers?.['X-APIKEY'] ?? '');
    return new Response('{"code":0,"data":{"symbol":"MINI"}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const upstream = gmgnTokenInfoUpstream({ fetchImpl: fakeFetch, apiKey: 'gmgn-key' });
  const req: GatewayRequest = {
    provider: 'gmgn',
    endpoint: GMGN_TOKEN_INFO_ENDPOINT,
    params: { chain: 'sol', address: 'CA' },
    priority: 1,
  };
  await upstream(req, 'a');
  await upstream(req, 'a');

  const u1 = new URL(urls[0]);
  const u2 = new URL(urls[1]);
  assert.equal(u1.searchParams.get('chain'), 'sol');
  assert.equal(u1.searchParams.get('address'), 'CA');
  assert.ok(Number(u1.searchParams.get('timestamp')) > 0);
  assert.notEqual(
    u1.searchParams.get('client_id'),
    u2.searchParams.get('client_id'),
    'client_id must be FRESH on every call (GMGN rejects a replay within 7s)',
  );
  assert.deepEqual(keys, ['gmgn-key', 'gmgn-key']);
});

test('(e) an upstream 403 surfaces as status:403 AND arms the gate; the next call backs off', async () => {
  const registry = new LimiterRegistry(buildSpecs(5));
  const runLimiter: LimiterRun = (api, opts, fn) => registry.run(api, opts, fn);
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return {
      status: 403,
      body: '{"code":1001,"error":"AUTH_IP_BLOCKED"}',
      headers: { 'content-type': 'application/json' },
    };
  };

  await withServer({ gmgnUpstream: upstream, runLimiter }, async (base) => {
    const body = { ca: 'CA', chain: 'sol' };

    const first = await post(base, body, TOKENS.a);
    assert.equal(first.status, 200);
    const env = first.json as GatewayEnvelope;
    assert.equal(env.status, 403, 'the upstream 403 is a DISTINCT status, not swallowed');
    assert.equal(env.body, null, 'the gate-arming error body is not forwarded');
    assert.ok(registry.snapshot().gmgn.gateUntil > Date.now(), 'the gmgn gate is armed');

    const second = await post(base, body, TOKENS.a);
    assert.equal(second.status, 503, 'the armed gate makes the next call back off');
    assert.deepEqual(second.json, { error: 'gated' });
    assert.ok(second.headers.get(GATED_HEADER));
    assert.equal(calls, 1, 'the blocked egress is NOT retried');
  });
});

test('the route is caller-gated and rejects a bad body without calling upstream', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream();
  };
  const rec = recordingLimiter();

  await withServer({ gmgnUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const noToken = await post(base, { ca: 'CA', chain: 'sol' });
    assert.equal(noToken.status, 401);
    assert.deepEqual(noToken.json, { error: 'unauthorized' });

    const badChain = await post(base, { ca: 'CA', chain: 'doge' }, TOKENS.a);
    assert.equal(badChain.status, 400);
    assert.deepEqual(badChain.json, { error: 'bad_request' });

    assert.equal(calls, 0, 'no denial ever reached upstream');
    assert.equal(rec.calls.length, 0, 'no denial ever reached the limiter');
  });
});

test('(f) a multi-key pool picks the next OPEN key and routes on its own limiter', async () => {
  const rec = recordingLimiter();
  let served = 0;
  const keyUpstream: UpstreamFetch = async () => {
    served += 1;
    return okUpstream();
  };
  const keys: GmgnKey[] = [
    { apiKey: 'k0', limiterKey: 'gmgn', weight: 5 },
    { apiKey: 'k1', limiterKey: 'gmgn:1', weight: 5 },
  ];
  const gmgnPool = new GmgnKeyPool({
    keys,
    fetcherFor: () => keyUpstream,
    gateUntilOf: (limiterKey) => (limiterKey === 'gmgn' ? Date.now() + 60_000 : 0),
    log: () => {},
  });

  await withServer({ runLimiter: rec.run, gmgnPool }, async (base) => {
    const r = await post(base, { ca: 'CA', chain: 'sol' }, TOKENS.a);
    assert.equal(r.status, 200);
    assert.equal(served, 1, "the picked key's upstream served the call");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].api, 'gmgn:1', 'gated key 0 is skipped; key 1 routes on gmgn:1');
  });
});
