// Selective TTL cache + single-flight (plan request-plane-gateway, todo 11).
//
// Acceptance (a)-(k) drives the REAL gateway app over ephemeral ports with
// stubbed upstreams and a recording limiter, so the assertions observe the
// actual cache/limiter/upstream ordering rather than a hand-rolled mock:
//
//   (a) N concurrent identical SAME-CALLER Nansen token-information → 1 upstream
//   (b) a second same-caller call within TTL → 0 upstream
//   (c) after TTL expiry → 1 upstream
//   (d) a 4xx/5xx is never cached
//   (e) two identical GMGN calls → 2 upstream (never cached)
//   (f) two time-windowed Nansen flows calls → 2 upstream (flows NOT deduped)
//   (g) N concurrent identical DexScreener calls from DIFFERENT callers → 1 upstream
//   (h) two concurrent identical Nansen credit calls from DIFFERENT callers → 2
//   (i) a cross-caller Nansen credit request WITHIN TTL is NOT a hit → 2 + 2 charges
//   (j) N concurrent identical SAME-CALLER Nansen credit → 1 upstream, ONE charge
//   (k) an over-budget caller's cache HIT for a 0-credit endpoint returns the
//       cached body (cache short-circuits BEFORE the budget pre-flight)
//
// The TTL cases use an injected `GatewayCache` over a controllable clock, so
// expiry is observed deterministically without a real wait.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { Caller, CallerTokens } from '../../src/gateway/auth.js';
import { NANSEN_CREDIT_PATH } from '../../src/gateway/nansen.js';
import { DEXSCREENER_PATH } from '../../src/gateway/dexscreener.js';
import { GMGN_TOKEN_INFO_PATH } from '../../src/gateway/gmgn.js';
import { GatewayCache, cacheKey, type Preflight } from '../../src/gateway/cache.js';
import {
  denial,
  type GatewayEnvelope,
  type LimiterRun,
  type UpstreamFetch,
  type UpstreamResponse,
} from '../../src/gateway/contract.js';
import type { RunOpts } from '../../src/ratelimit/types.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

const TOKEN_INFO = '/api/v1/tgm/token-information';
const FLOWS = '/api/v1/tgm/flows';

function creditBody(tokenAddress: string, extra: Record<string, unknown> = {}): unknown {
  return { endpoint: TOKEN_INFO, body: { parameters: { tokenAddress, chain: 'solana' }, ...extra } };
}

function okUpstream(body = '{"data":[]}'): UpstreamResponse {
  return { status: 200, body, headers: { 'content-type': 'application/json' } };
}

/** A runner that records the (api, opts) and executes the job untouched. */
function recordingLimiter(): { run: LimiterRun; calls: { api: string; opts: RunOpts }[] } {
  const calls: { api: string; opts: RunOpts }[] = [];
  const run: LimiterRun = async (api, opts, fn) => {
    calls.push({ api, opts });
    return fn();
  };
  return { run, calls };
}

/** Controllable clock for deterministic TTL expiry. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

/** An upstream that counts calls and BLOCKS until `open()` — so concurrency is observable. */
function blockingUpstream(body: string): {
  fetch: UpstreamFetch;
  calls: () => number;
  open: () => void;
} {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let calls = 0;
  const fetch: UpstreamFetch = async () => {
    calls += 1;
    await gate;
    return okUpstream(body);
  };
  return { fetch, calls: () => calls, open };
}

interface ServerDeps {
  nansenCreditUpstream?: UpstreamFetch;
  dexUpstream?: UpstreamFetch;
  gmgnUpstream?: UpstreamFetch;
  runLimiter?: LimiterRun;
  cache?: GatewayCache;
  preflight?: Preflight;
}

async function withServer(deps: ServerDeps, fn: (base: string) => Promise<void>): Promise<void> {
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
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

function envelope(r: PostResult): GatewayEnvelope {
  return r.json as GatewayEnvelope;
}

test('(a) N concurrent identical SAME-CALLER Nansen token-information calls collapse to ONE upstream', async () => {
  const raw = '{"data":[{"it":"one"}]}';
  const up = blockingUpstream(raw);
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: up.fetch, runLimiter: rec.run, cache }, async (base) => {
    const body = creditBody('CA1');
    const first = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    await waitFor(() => up.calls() === 1); // the initiator has reached the (blocked) upstream
    const rest = Array.from({ length: 4 }, () => post(base, NANSEN_CREDIT_PATH, body, TOKENS.a));

    await waitFor(() => cache.joinedCount() === 4); // all 4 late arrivals shared the in-flight call
    assert.equal(up.calls(), 1, 'single-flight: only ONE upstream call while all 5 are in flight');
    assert.equal(rec.calls.length, 1, 'exactly ONE limiter run (the initiator)');

    up.open();
    const results = await Promise.all([first, ...rest]);
    assert.equal(up.calls(), 1, 'still exactly ONE upstream call after all settle');
    assert.equal(rec.calls.length, 1, 'joiners never reached the limiter');
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(envelope(r).body, raw, 'every caller gets the one raw upstream body');
    }
  });
});

test('(b) a second same-caller call within TTL is a HIT (0 upstream)', async () => {
  let calls = 0;
  const raw = '{"data":[{"it":"b"}]}';
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream(raw);
  };
  const clock = fakeClock();
  const cache = new GatewayCache({ now: clock.now, ttlNansenMs: 1_000 });

  await withServer({ nansenCreditUpstream: upstream, cache }, async (base) => {
    const body = creditBody('CA2');
    const r1 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(calls, 1);
    clock.advance(500); // still inside the 1s TTL
    const r2 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(calls, 1, 'within TTL: 0 additional upstream calls');
    assert.equal(envelope(r2).body, envelope(r1).body, 'the cached body is served');
  });
});

test('(c) after TTL expiry the next call goes upstream again', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream(`{"n":${calls}}`);
  };
  const clock = fakeClock();
  const cache = new GatewayCache({ now: clock.now, ttlNansenMs: 1_000 });

  await withServer({ nansenCreditUpstream: upstream, cache }, async (base) => {
    const body = creditBody('CA3');
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(calls, 1);
    clock.advance(1_500); // past the 1s TTL
    const r2 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(calls, 2, 'after TTL expiry: 1 additional upstream call');
    assert.equal(envelope(r2).body, '{"n":2}', 'the FRESH body, not the stale one');
  });
});

test('(d) a 4xx/5xx upstream is never cached', async () => {
  let status = 500;
  let body = 'boom';
  const upstream: UpstreamFetch = async () => ({ status, body, headers: {} });
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: upstream, runLimiter: rec.run, cache }, async (base) => {
    const req = creditBody('CA4');
    const r1 = await post(base, NANSEN_CREDIT_PATH, req, TOKENS.a);
    assert.equal(envelope(r1).status, 500, 'the 5xx surfaces as the envelope status');
    assert.equal(envelope(r1).body, null, 'the error body is not forwarded');

    status = 404;
    const r2 = await post(base, NANSEN_CREDIT_PATH, req, TOKENS.a);
    assert.equal(envelope(r2).status, 404, 'the 4xx surfaces too');
    assert.equal(rec.calls.length, 2, 'both error calls reached the limiter/upstream (not cached)');
    assert.equal(cache.size(), 0, 'no error result was cached');

    status = 200;
    body = '{"ok":1}';
    const r3 = await post(base, NANSEN_CREDIT_PATH, req, TOKENS.a);
    assert.equal(envelope(r3).status, 200);
    assert.equal(envelope(r3).body, '{"ok":1}');
    assert.equal(rec.calls.length, 3, 'the next call retried upstream');
    assert.equal(cache.size(), 1, 'the 2xx is cached');
  });
});

test('(e) two identical GMGN calls produce TWO upstream calls (never cached)', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('{"code":0}');
  };
  const rec = recordingLimiter();
  const cache = new GatewayCache();

  await withServer({ gmgnUpstream: upstream, runLimiter: rec.run, cache }, async (base) => {
    const body = { ca: 'CA', chain: 'sol' };
    await post(base, GMGN_TOKEN_INFO_PATH, body, TOKENS.a);
    await post(base, GMGN_TOKEN_INFO_PATH, body, TOKENS.a);
    assert.equal(calls, 2, 'GMGN is excluded from the cache (fresh client_id per call)');
    assert.equal(rec.calls.length, 2);
    assert.equal(cache.size(), 0, 'nothing GMGN was cached');
  });
});

test('(f) two identical time-windowed Nansen flows calls produce TWO upstream calls (not deduped)', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('{"data":[]}');
  };
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: upstream, runLimiter: rec.run, cache }, async (base) => {
    const body = {
      endpoint: FLOWS,
      body: {
        parameters: { tokenAddress: 'CA', chain: 'solana' },
        date: { from: '2026-09-01', to: '2026-09-07' },
      },
    };
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(calls, 2, 'flows carry a moving window — never cached/deduped, even when identical');
    assert.equal(rec.calls.length, 2);
    assert.equal(cache.size(), 0, 'no flows entry was written');
  });
});

test('(g) N concurrent identical DexScreener calls from DIFFERENT callers collapse to ONE upstream', async () => {
  const raw = '{"pairs":[]}';
  const up = blockingUpstream(raw);
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlDexscreenerMs: 60_000 });

  await withServer({ dexUpstream: up.fetch, runLimiter: rec.run, cache }, async (base) => {
    const body = { endpoint: 'tokens', params: { addresses: 'M' } };
    const first = post(base, DEXSCREENER_PATH, body, TOKENS.a);
    await waitFor(() => up.calls() === 1); // the initiator is in the (blocked) upstream
    const rest = [
      post(base, DEXSCREENER_PATH, body, TOKENS.b),
      post(base, DEXSCREENER_PATH, body, TOKENS.a),
      post(base, DEXSCREENER_PATH, body, TOKENS.b),
      post(base, DEXSCREENER_PATH, body, TOKENS.watcher),
    ];

    await waitFor(() => cache.joinedCount() === 4);
    assert.equal(up.calls(), 1, 'cross-caller dedupe: non-credit DexScreener shares ONE upstream call');

    up.open();
    const results = await Promise.all([first, ...rest]);
    assert.equal(up.calls(), 1);
    assert.equal(rec.calls.length, 1, 'the initiator pays the single upstream/limiter cost');
    for (const r of results) assert.equal(envelope(r).body, raw);
  });
});

test('(h) two concurrent identical Nansen credit calls from DIFFERENT callers are NOT collapsed', async () => {
  const up = blockingUpstream('{"data":[]}');
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: up.fetch, runLimiter: rec.run, cache }, async (base) => {
    const body = creditBody('CAH');
    const pa = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    const pb = post(base, NANSEN_CREDIT_PATH, body, TOKENS.b);

    await waitFor(() => up.calls() === 2);
    assert.equal(rec.calls.length, 2, 'each caller ran its own limiter (its own charge)');

    up.open();
    await Promise.all([pa, pb]);
    assert.equal(up.calls(), 2, 'cross-caller credit calls stay separate (caller is in the key)');
  });
});

test('(i) a cross-caller Nansen credit request WITHIN TTL is NOT a cache hit (2 upstream, 2 charges)', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('{"data":[]}');
  };
  const rec = recordingLimiter();
  const clock = fakeClock();
  const cache = new GatewayCache({ now: clock.now, ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: upstream, runLimiter: rec.run, cache }, async (base) => {
    const body = creditBody('CAI');
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    clock.advance(500); // well inside the TTL — yet b still must miss
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.b);
    assert.equal(calls, 2, 'the credit key is caller-scoped, so b cannot TTL-hit a');
    assert.equal(rec.calls.length, 2, 'both callers were charged');
    assert.equal(cache.size(), 2, 'one entry per caller');
  });
});

test('(j) N concurrent identical SAME-CALLER Nansen credit calls → ONE upstream and ONE charge', async () => {
  const up = blockingUpstream('{"data":[]}');
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: up.fetch, runLimiter: rec.run, cache }, async (base) => {
    const body = creditBody('CAJ');
    const first = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    await waitFor(() => up.calls() === 1);
    const rest = Array.from({ length: 5 }, () => post(base, NANSEN_CREDIT_PATH, body, TOKENS.a));

    await waitFor(() => cache.joinedCount() === 5);
    assert.equal(up.calls(), 1, 'single-flight collapses the burst');
    assert.equal(rec.calls.length, 1, 'the caller is charged exactly ONE (joiners pay ZERO)');

    up.open();
    await Promise.all([first, ...rest]);
    assert.equal(up.calls(), 1);
    assert.equal(rec.calls.length, 1, 'still exactly ONE charge after the burst settles');
  });
});

test('(k) an over-budget caller still returns a cached 0-credit body (hit short-circuits BEFORE pre-flight)', async () => {
  const raw = '{"pairs":[{"baseToken":{"address":"M"}}]}';
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream(raw);
  };
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlDexscreenerMs: 60_000 });
  const seen: Caller[] = [];
  const preflight: Preflight = (_provider, _body, caller) => {
    seen.push(caller);
    return caller === 'b' ? denial(429, 'budget_exceeded') : undefined;
  };

  await withServer(
    { dexUpstream: upstream, runLimiter: rec.run, cache, preflight },
    async (base) => {
      const body = { endpoint: 'tokens', params: { addresses: 'M' } };

      const r1 = await post(base, DEXSCREENER_PATH, body, TOKENS.a);
      assert.equal(r1.status, 200);
      assert.equal(envelope(r1).body, raw, 'the initiator populated the cache');
      assert.equal(calls, 1);
      assert.deepEqual(seen, ['a'], 'pre-flight ran for the initiator');

      // b is "over budget": if pre-flight ran, it would return a 429 denial.
      const r2 = await post(base, DEXSCREENER_PATH, body, TOKENS.b);
      assert.equal(r2.status, 200, 'a cache HIT must NOT be budget-denied');
      assert.equal(envelope(r2).status, 200);
      assert.equal(envelope(r2).body, raw, 'the cached body is returned');
      assert.equal(calls, 1, 'no new upstream call');
      assert.deepEqual(seen, ['a'], 'pre-flight was short-circuited on the hit (never called for b)');
    },
  );
});

test('cacheKey normalization: order-independent, priority-excluded, caller-scoped for credit', () => {
  const k1 = cacheKey(
    'nansen-credit',
    { endpoint: TOKEN_INFO, body: { a: 1, b: 2 }, priority: 2 },
    true,
    'a',
  );
  const k2 = cacheKey(
    'nansen-credit',
    { priority: 0, body: { b: 2, a: 1 }, endpoint: TOKEN_INFO },
    true,
    'a',
  );
  assert.equal(k1, k2, 'key ignores property order and priority');

  const other = cacheKey(
    'nansen-credit',
    { endpoint: TOKEN_INFO, body: { a: 1, b: 2 } },
    true,
    'b',
  );
  assert.notEqual(k1, other, 'a credit key is caller-scoped');

  const shared = cacheKey('dexscreener', { endpoint: 'tokens', params: { addresses: 'A' } }, false, 'b');
  const shared2 = cacheKey('dexscreener', { endpoint: 'tokens', params: { addresses: 'A' } }, false, 'watcher');
  assert.equal(shared, shared2, 'a non-credit key is caller-agnostic');
});
