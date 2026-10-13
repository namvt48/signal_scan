// GMGN token/info gateway route (plan request-plane-gateway, todo 8).
//
//   (a) the per-request weight + priority reach `limiters.run('gmgn', ...)`
//   (b) a weight-1 call consumes the bucket; the next call is DELAYED, never rejected
//   (c) simultaneous identical reads share one in-flight request; later reads
//       fetch again (no completed-result TTL)
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
import { Limiter } from '../../src/ratelimit/limiter.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import { createGatewayApp } from '../../src/gateway/app.js';
import {
  GMGN_TOKEN_INFO_ENDPOINT,
  GMGN_TOKEN_INFO_PATH,
  GMGN_TOKEN_INFO_WEIGHT,
  GmgnTokenInfoSingleFlight,
  gmgnTokenInfoUpstream,
  handleGmgnTokenInfo,
  parseGmgnTokenInfo,
} from '../../src/gateway/gmgn.js';
import {
  GATED_HEADER,
  type DispatchResult,
  type GatewayEnvelope,
  type GatewayRequest,
  type LimiterRun,
  type UpstreamFetch,
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
  deps: {
    gmgnUpstream?: UpstreamFetch;
    runLimiter?: LimiterRun;
    runEgressLimiter?: LimiterRun;
    gmgnPool?: GmgnKeyPool;
    gmgnSingleFlight?: GmgnTokenInfoSingleFlight;
  },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const passThrough: LimiterRun = async (_api, _opts, job) => job();
  const server = createGatewayApp({
    tokens: TOKENS,
    gmgnUpstream: deps.gmgnUpstream,
    runLimiter: deps.runLimiter,
    runEgressLimiter: deps.runEgressLimiter ?? passThrough,
    gmgnPool: deps.gmgnPool,
    gmgnSingleFlight: deps.gmgnSingleFlight,
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
class SignallingSingleFlight extends GmgnTokenInfoSingleFlight {
  private invocations = 0;
  private readonly secondInvocation = Promise.withResolvers<void>();

  waitForSecondInvocation(): Promise<void> {
    return this.secondInvocation.promise;
  }

  override run(rawBody: unknown, operation: () => Promise<DispatchResult>): Promise<DispatchResult> {
    this.invocations += 1;
    if (this.invocations === 2) this.secondInvocation.resolve();
    return super.run(rawBody, operation);
  }
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
    assert.equal(rec.calls[0].opts.caller, 'a');
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

test('(c) simultaneous identical GMGN reads single-flight, but completed data is never cached', async () => {
  const seen: GatewayRequest[] = [];
  const { promise: upstreamStarted, resolve: signalStarted } = Promise.withResolvers<void>();
  const { promise: upstreamBlocked, resolve: releaseUpstream } = Promise.withResolvers<void>();
  const upstream: UpstreamFetch = async (req) => {
    seen.push(req);
    signalStarted();
    await upstreamBlocked;
    return okUpstream();
  };
  const singleFlight = new SignallingSingleFlight();
  const rec = recordingLimiter();

  await withServer(
    { gmgnUpstream: upstream, runLimiter: rec.run, gmgnSingleFlight: singleFlight },
    async (base) => {
      const ca = `0x${'A'.repeat(40)}`;
      const first = post(base, { ca, chain: 'base', priority: 2 }, TOKENS.a);
      await upstreamStarted;
      const joined = post(base, { ca: ca.toLowerCase(), chain: 'base', priority: 0 }, TOKENS.b);
      await singleFlight.waitForSecondInvocation();
      assert.equal(seen.length, 1, 'the concurrent request does not start another upstream call');

      releaseUpstream();
      const [r1, r2] = await Promise.all([first, joined]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.deepEqual(r2.json, r1.json, 'both callers receive the in-flight public response');
      assert.equal(singleFlight.snapshot().inflight, 0, 'the flight is removed after completion');

      const later = await post(base, { ca, chain: 'base' }, TOKENS.b);
      assert.equal(later.status, 200);
      assert.equal(seen.length, 2, 'a completed result is not retained as a cache entry');
      assert.equal(rec.calls.length, 2, 'only actual outbound requests enter the limiter');
      assert.equal(seen[0].provider, 'gmgn');
      assert.equal(seen[0].endpoint, GMGN_TOKEN_INFO_ENDPOINT);
      assert.deepEqual(seen[0].params, { chain: 'base', address: ca });
    },
  );
});

test('GMGN single-flight separates chains and case-sensitive Solana addresses', async () => {
  const flights = new GmgnTokenInfoSingleFlight();
  const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
  const result: DispatchResult = {
    status: 200,
    payload: { status: 200, body: '{"code":0}', headers: {} },
  };
  let calls = 0;
  const upstream = async (): Promise<DispatchResult> => {
    calls += 1;
    await blocked;
    return result;
  };
  const ca = `0x${'A'.repeat(40)}`;
  const requests = [
    flights.run({ ca: 'AbC', chain: 'sol' }, upstream),
    flights.run({ ca: 'abc', chain: 'sol' }, upstream),
    flights.run({ ca, chain: 'base' }, upstream),
    flights.run({ ca: ca.toLowerCase(), chain: 'bsc' }, upstream),
  ];
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 4, 'distinct chain/address identities do not join');
  release();
  await Promise.all(requests);
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
test('GMGN retry reacquires per-key quota for a fresh outbound attempt', async () => {
  let now = Date.now();
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: unknown) => {
      const index = timers.indexOf(timer as { at: number; fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const specs = buildSpecs(5);
  const keySpec = {
    ...specs.gmgn!,
    weightBucket: { capacity: 1, refillPerSec: 0.1, defaultWeight: 1 },
    retry: { ...specs.gmgn!.retry!, baseMs: 1, jitterMs: 0 },
  };
  const keyLimiter = new Limiter('gmgn', keySpec, clock);
  const egressLimiter = new Limiter('gmgn-egress', specs['gmgn-egress']!, clock);
  const runKey: LimiterRun = (_api, opts, job) => keyLimiter.run(opts, job);
  const runEgress: LimiterRun = (_api, opts, job) => egressLimiter.run(opts, job);
  const urls: string[] = [];
  const attemptTimes: number[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    attemptTimes.push(now);
    return new Response(
      urls.length === 1 ? '{"error":"temporary"}' : '{"code":0,"data":{"symbol":"MINI"}}',
      { status: urls.length === 1 ? 500 : 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const resultPromise = handleGmgnTokenInfo({ ca: 'CA', chain: 'sol' }, 'a', {
    fetchUpstream: gmgnTokenInfoUpstream({ fetchImpl: fakeFetch, apiKey: 'gmgn-key' }),
    runLimiter: runKey,
    runEgressLimiter: runEgress,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(urls.length, 1, 'the first outbound attempt receives a transient failure');
  for (let i = 0; i < 5 && urls.length < 2; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const timer = timers.shift();
    assert.ok(timer, 'bounded retry or per-key refill schedules the next attempt');
    now = timer.at;
    timer.fn();
  }
  const result = await resultPromise;

  assert.equal(result.status, 200);
  assert.equal(urls.length, 2, 'exactly one retry is issued');
  assert.ok(
    attemptTimes[1]! - attemptTimes[0]! >= 10_000,
    'the retry waits for the per-key bucket to refill, proving the quota is charged per attempt',
  );
  const firstUrl = new URL(urls[0]!);
  const retryUrl = new URL(urls[1]!);
  assert.notEqual(
    firstUrl.searchParams.get('client_id'),
    retryUrl.searchParams.get('client_id'),
    'every actual outbound retry receives a fresh client_id',
  );
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
    assert.deepEqual(
      gmgnPool.stats().map(({ index, attempts, failures, served }) => ({ index, attempts, failures, served })),
      [
        { index: 0, attempts: 0, failures: 0, served: 0 },
        { index: 1, attempts: 1, failures: 0, served: 1 },
      ],
      'the selected key records one actual HTTP attempt and success',
    );
  });
});
test('a GMGN 429 gates shared egress before the next key can call upstream', async () => {
  const perKeyRegistry = new LimiterRegistry(buildSpecs(5, 2));
  const egressRegistry = new LimiterRegistry(buildSpecs(5, 2));
  const runLimiter: LimiterRun = (api, opts, job) => perKeyRegistry.run(api, opts, job);
  const runEgressLimiter: LimiterRun = (api, opts, job) => egressRegistry.run(api, opts, job);
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return {
      status: 429,
      body: '{"code":429,"error":"RATE_LIMIT_BANNED"}',
      headers: { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 300) },
    };
  };
  const keys: GmgnKey[] = [
    { apiKey: 'k0', limiterKey: 'gmgn', weight: 5 },
    { apiKey: 'k1', limiterKey: 'gmgn:1', weight: 5 },
  ];
  const gmgnPool = new GmgnKeyPool({
    keys,
    fetcherFor: () => upstream,
    gateUntilOf: (key) => perKeyRegistry.snapshot()[key]?.gateUntil ?? 0,
    log: () => {},
  });

  await withServer(
    { gmgnPool, runLimiter, runEgressLimiter },
    async (base) => {
      const first = await post(base, { ca: 'CA', chain: 'sol' }, TOKENS.a);
      assert.equal(first.status, 200);
      assert.equal((first.json as GatewayEnvelope).status, 429);
      assert.ok(egressRegistry.snapshot()['gmgn-egress'].gateUntil > Date.now());

      const second = await post(base, { ca: 'CA', chain: 'sol' }, TOKENS.a);
      assert.equal(second.status, 503);
      assert.deepEqual(second.json, { error: 'gated' });
      assert.equal(calls, 1, 'the second key must not send a request during the shared ban');
    },
  );
});
