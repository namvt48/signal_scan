// Public CA TTL cache + shared single-flight behavior.
// Tests drive the gateway app over ephemeral ports with stubbed upstreams and
// recording limiters to verify cache/preflight/limiter ordering.
// Flows retain exact date range identity; GMGN and private endpoints remain uncached.
// The fake clock makes expiration deterministic.
//
// The TTL cases use an injected `GatewayCache` over a controllable clock, so
// expiry is observed deterministically without a real wait.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { Caller, CallerTokens } from '../../src/gateway/auth.js';
import {
  NANSEN_CREDIT_LIMITER,
  NANSEN_CREDIT_PATH,
  NANSEN_DOOR_PATH,
  type DoorPost,
} from '../../src/gateway/nansen.js';
import { DEXSCREENER_PATH } from '../../src/gateway/dexscreener.js';
import { GMGN_TOKEN_INFO_PATH } from '../../src/gateway/gmgn.js';
import { GatewayCache, cacheKey, type Preflight } from '../../src/gateway/cache.js';
import { CreditAccountant } from '../../src/gateway/credit.js';
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
  nansenDoor?: DoorPost;
  credits?: CreditAccountant;
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

test('(f) Nansen flows cache identical windows but isolate different ranges', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('{"data":[]}');
  };
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlFlowsMs: 60_000 });

  await withServer({ nansenCreditUpstream: upstream, runLimiter: rec.run, cache }, async (base) => {
    const body = {
      endpoint: FLOWS,
      body: {
        parameters: { tokenAddress: 'CA', chain: 'solana' },
        date: { from: '2026-09-01', to: '2026-09-07' },
      },
    };
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.b);
    await post(base, NANSEN_CREDIT_PATH,
      { ...body, body: { ...body.body, date: { from: '2026-09-02', to: '2026-09-07' } } }, TOKENS.b);
    assert.equal(calls, 2, 'equal range shares; different range is a separate upstream request');
    assert.equal(rec.calls.length, 2);
    assert.equal(cache.size(), 2);
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

test('DexScreener latest profiles are cached and shared across callers', async () => {
  let calls = 0;
  const cache = new GatewayCache({ ttlDexscreenerMs: 60_000 });
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('[{"chainId":"base","tokenAddress":"0xabc"}]');
  };

  await withServer({ dexUpstream: upstream, cache }, async (base) => {
    const body = { endpoint: 'profiles' };
    const first = await post(base, DEXSCREENER_PATH, body, TOKENS.a);
    const second = await post(base, DEXSCREENER_PATH, body, TOKENS.b);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1, 'public profile data shares one cached upstream result');
    assert.equal(envelope(first).body, envelope(second).body);
  });
});

test('DexScreener boosts are treated as public cacheable data', async () => {
  let calls = 0;
  const cache = new GatewayCache({ ttlDexscreenerMs: 60_000 });
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('[]');
  };

  await withServer({ dexUpstream: upstream, cache }, async (base) => {
    await post(base, DEXSCREENER_PATH, { endpoint: 'boosts' }, TOKENS.a);
    await post(base, DEXSCREENER_PATH, { endpoint: 'boosts' }, TOKENS.a);
    assert.equal(calls, 1);
  });
});

test('(h) concurrent identical Nansen credit calls from different callers share one initiator', async () => {
  const up = blockingUpstream('{"data":[]}');
  const rec = recordingLimiter();
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });
  const credits = new CreditAccountant({ budget: 100 });

  await withServer(
    { nansenCreditUpstream: up.fetch, runLimiter: rec.run, cache, credits },
    async (base) => {
      const body = creditBody('CAH');
      const pa = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
      await waitFor(() => up.calls() === 1);
      const pb = post(base, NANSEN_CREDIT_PATH, body, TOKENS.b);
      await waitFor(() => cache.joinedCount() === 1);
      assert.equal(up.calls(), 1);
      up.open();
      await Promise.all([pa, pb]);
      assert.equal(rec.calls.length, 1, 'only the initiating caller reaches the credit upstream');
      assert.ok(credits.snapshot().used.a > 0, 'the initiator is charged the real/fallback credit cost');
      assert.equal(credits.snapshot().used.b, 0, 'the joiner pays no duplicate credit');
    },
  );
});

test('(i) a successful Nansen credit result is shared across callers within TTL', async () => {
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
    clock.advance(500);
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.b);
    assert.equal(calls, 1, 'cross-caller cache hit avoids duplicate paid fetch');
    assert.equal(rec.calls.length, 1, 'cache hit performs no second charge');
    assert.equal(cache.size(), 1);
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

test('cacheKey preserves semantic ranges, shares public caller keys, and normalizes EVM CA only', () => {
  const upperCa = `0x${'A'.repeat(40)}`;
  const lowerCa = upperCa.toLowerCase();
  const k1 = cacheKey('nansen-credit',
    { endpoint: FLOWS, body: { parameters: { tokenAddress: upperCa, chain: 'ethereum' }, date: { from: '1', to: '2' } }, priority: 2 }, true, 'a');
  const k2 = cacheKey('nansen-credit',
    { endpoint: FLOWS, body: { date: { to: '2', from: '1' }, parameters: { chain: 'ethereum', tokenAddress: lowerCa } }, priority: 0 }, true, 'b');
  assert.equal(k1, k2, 'caller, property order, priority and EVM CA case do not split key');
  const differentRange = cacheKey('nansen-credit',
    { endpoint: FLOWS, body: { parameters: { tokenAddress: lowerCa, chain: 'ethereum' }, date: { from: '1', to: '3' } } }, true, 'b');
  assert.notEqual(k1, differentRange, 'different date range stays isolated');
  const malformedUpper = cacheKey('nansen-credit',
    { endpoint: TOKEN_INFO, body: { tokenAddress: '0xAbC', chain: 'ethereum' } }, true, 'a');
  const malformedLower = cacheKey('nansen-credit',
    { endpoint: TOKEN_INFO, body: { tokenAddress: '0xabc', chain: 'ethereum' } }, true, 'b');
  assert.notEqual(malformedUpper, malformedLower, 'malformed EVM-like input is not case-folded');
  const solanaA = cacheKey('nansen-credit', { endpoint: TOKEN_INFO, body: { tokenAddress: 'AbC', chain: 'solana' } }, true, 'a');
  const solanaB = cacheKey('nansen-credit', { endpoint: TOKEN_INFO, body: { tokenAddress: 'abc', chain: 'solana' } }, true, 'b');
  assert.notEqual(solanaA, solanaB, 'Solana CA remains case-sensitive');
});

test('Nansen door public CA data is shared across callers within the short TTL', async () => {
  let calls = 0;
  const door: DoorPost = async (_url, body) => {
    calls += 1;
    return { status: 200, json: { data: body } };
  };
  const cache = new GatewayCache({ ttlDoorMs: 30_000 });

  await withServer({ nansenDoor: door, cache }, async (base) => {
    const request = {
      endpoint: 'tgm-essential-data',
      body: { parameters: { tokenAddress: 'CA', chain: 'base' } },
    };
    const first = await post(base, NANSEN_DOOR_PATH, request, TOKENS.a);
    const second = await post(base, NANSEN_DOOR_PATH, request, TOKENS.b);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1, 'the cross-caller cache hit avoids a second browser-door request');
    assert.equal(envelope(second).body, envelope(first).body);
    assert.equal(cache.stats().hits, 1);
  });
});

test('per-wallet Nansen balance requests stay uncached and retain per-caller preflight', async () => {
  let calls = 0;
  const preflightCallers: Caller[] = [];
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream('{"data":[]}');
  };
  const preflight: Preflight = (_provider, _body, caller) => {
    preflightCallers.push(caller);
    return undefined;
  };
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer(
    { nansenCreditUpstream: upstream, cache, preflight },
    async (base) => {
      const request = {
        endpoint: '/api/v1/profiler/address/current-balance',
        body: { address: 'wallet-specific', chain: 'solana', tokenAddress: 'CA' },
      };
      const first = await post(base, NANSEN_CREDIT_PATH, request, TOKENS.a);
      const second = await post(base, NANSEN_CREDIT_PATH, request, TOKENS.b);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 2, 'wallet-specific requests do not share upstream results');
      assert.deepEqual(preflightCallers, ['a', 'b']);
      assert.equal(cache.size(), 0);
    },
  );
});

test('DexScreener token-list cache keys normalize EVM addresses without changing list order', () => {
  const upper = cacheKey(
    'dexscreener',
    { endpoint: 'tokens', params: { addresses: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,SoLCase' } },
    false,
    'a',
  );
  const lower = cacheKey(
    'dexscreener',
    { endpoint: 'tokens', params: { addresses: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,SoLCase' } },
    false,
    'b',
  );
  const reordered = cacheKey(
    'dexscreener',
    { endpoint: 'tokens', params: { addresses: 'SoLCase,0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
    false,
    'b',
  );
  assert.equal(upper, lower, 'EVM casing is semantically irrelevant');
  assert.notEqual(upper, reordered, 'token-list order remains significant');
});

test('DexScreener pair cache key normalizes an EVM pair ID only for known EVM chains', () => {
  const upper = cacheKey(
    'dexscreener',
    { endpoint: 'pairs', params: { chainId: 'base', pairId: `0x${'A'.repeat(40)}` } },
    false,
    'a',
  );
  const lower = cacheKey(
    'dexscreener',
    { endpoint: 'pairs', params: { chainId: 'base', pairId: `0x${'a'.repeat(40)}` } },
    false,
    'b',
  );
  const solana = cacheKey(
    'dexscreener',
    { endpoint: 'pairs', params: { chainId: 'solana', pairId: `0x${'A'.repeat(40)}` } },
    false,
    'b',
  );
  assert.equal(upper, lower);
  assert.notEqual(upper, solana, 'an unknown/non-EVM chain keeps address case intact');
});
