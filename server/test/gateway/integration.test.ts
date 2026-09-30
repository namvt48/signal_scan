// Wave-2 gateway integration test (plan request-plane-gateway, todo 12).
//
// Boots the REAL gateway HTTP app over an ephemeral port with only the NETWORK
// stubbed (`upstream` / `gmgnUpstream` / `dexUpstream` / `nansenCreditUpstream` /
// `nansenDoor`) and exercises EVERY route end-to-end through the real HTTP layer:
//
//   GET  /health            (public, side-effect-free)
//   GET  /metrics           (token-gated)
//   POST /v1/proxy          (the generic raw-payload contract)
//   POST /v1/gmgn/token-info
//   POST /v1/dexscreener     (standard + profiles classes)
//   POST /v1/nansen/credit
//   POST /v1/nansen/door
//
// Auth, contract, cache AND limiter are the REAL modules — nothing below HTTP is
// faked: the limiter is a real `LimiterRegistry` over `buildSpecs` (injected so
// the spec can read its `snapshot()` deterministically) and the cache is the
// real `GatewayCache`. Only the upstream bytes are synthetic.
//
// Acceptance pinned here:
//   * 1 upstream call for 2 identical CROSS-CALLER DexScreener requests
//   * 1 upstream call for 2 identical SAME-CALLER Nansen token-information requests
//   * 2 upstream calls for 2 identical CROSS-CALLER Nansen credit requests
//   * 2 upstream calls for 2 identical GMGN requests (the cache exception)
//   * upstream 429 propagates (200 envelope `{status:429, body:null}`) for every
//     limiter, and the gmgn gate ARMS (next call 503 `{error:"gated"}`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp, PROXY_PATH } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import { GMGN_TOKEN_INFO_PATH } from '../../src/gateway/gmgn.js';
import {
  DEXSCREENER_LIMITER,
  DEXSCREENER_PATH,
  DEXSCREENER_PROFILES_LIMITER,
} from '../../src/gateway/dexscreener.js';
import {
  NANSEN_CREDIT_LIMITER,
  NANSEN_CREDIT_PATH,
  NANSEN_DOOR_PATH,
  NANSEN_DOOR_URLS,
  type DoorPost,
} from '../../src/gateway/nansen.js';
import {
  GATED_HEADER,
  type GatewayEnvelope,
  type LimiterRun,
  type UpstreamFetch,
} from '../../src/gateway/contract.js';
import { GatewayCache } from '../../src/gateway/cache.js';
import { LimiterRegistry } from '../../src/ratelimit/registry.js';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import type { ApiLimitSpec } from '../../src/ratelimit/types.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

/** Nansen credit path for token-information (`providers/nansen.ts`). */
const TOKEN_INFORMATION = '/api/v1/tgm/token-information';

/** Every limiter key the gateway registry exposes (the /health snapshot shape). */
const LIMITER_KEYS = [
  'gmgn',
  'solana-rpc',
  NANSEN_CREDIT_LIMITER,
  'nansen-door',
  DEXSCREENER_LIMITER,
  DEXSCREENER_PROFILES_LIMITER,
] as const;

/** The token-information credit request body. */
function creditBody(tokenAddress: string): unknown {
  return {
    endpoint: TOKEN_INFORMATION,
    body: { parameters: { tokenAddress, chain: 'solana' } },
  };
}

interface Res {
  status: number;
  json: unknown;
  headers: Headers;
}

function envelope(r: Res): GatewayEnvelope {
  return r.json as GatewayEnvelope;
}

/** A 200 upstream stub that counts calls and always returns the same raw body. */
function rawUpstream(raw: string): { fetch: UpstreamFetch; calls: () => number } {
  let calls = 0;
  const fetch: UpstreamFetch = async () => {
    calls += 1;
    return { status: 200, body: raw, headers: { 'content-type': 'application/json' } };
  };
  return { fetch, calls: () => calls };
}

interface GatewayDeps {
  upstream?: UpstreamFetch;
  gmgnUpstream?: UpstreamFetch;
  dexUpstream?: UpstreamFetch;
  nansenCreditUpstream?: UpstreamFetch;
  nansenDoor?: DoorPost;
  cache?: GatewayCache;
  /** Real spec override (e.g. a 1-retry credit limiter); defaults to buildSpecs(5). */
  specs?: Record<string, ApiLimitSpec>;
}

/**
 * Boot the real gateway app over an ephemeral port with a FRESH real
 * `LimiterRegistry`, handing the test the base URL + that registry so it can read
 * the real limiter snapshots.
 */
async function withGateway(
  deps: GatewayDeps,
  fn: (base: string, registry: LimiterRegistry) => Promise<void>,
): Promise<void> {
  const registry = new LimiterRegistry(deps.specs ?? buildSpecs(5));
  const runLimiter: LimiterRun = (api, opts, job) => registry.run(api, opts, job);
  const server = createGatewayApp({
    tokens: TOKENS,
    upstream: deps.upstream,
    gmgnUpstream: deps.gmgnUpstream,
    dexUpstream: deps.dexUpstream,
    nansenCreditUpstream: deps.nansenCreditUpstream,
    nansenDoor: deps.nansenDoor,
    cache: deps.cache,
    runLimiter,
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, registry);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

async function post(base: string, path: string, body: unknown, token?: string): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

async function get(base: string, path: string, token?: string): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

test('route matrix: /health is public; /metrics and every /v1 route need a caller bearer', async () => {
  let upstreamCalls = 0;
  const never: UpstreamFetch = async () => {
    upstreamCalls += 1;
    return { status: 200, body: '{}', headers: {} };
  };
  const door: DoorPost = async () => {
    upstreamCalls += 1;
    return { status: 200, json: {} };
  };

  await withGateway(
    {
      upstream: never,
      gmgnUpstream: never,
      dexUpstream: never,
      nansenCreditUpstream: never,
      nansenDoor: door,
    },
    async (base) => {
      const health = await get(base, '/health');
      assert.equal(health.status, 200);
      const h = health.json as { ok: boolean; ratelimit: Record<string, unknown>; doors: unknown };
      assert.equal(h.ok, true, '/health is public');
      assert.equal(h.doors, null, '/health is side-effect-free (no door pool spawned)');
      for (const key of LIMITER_KEYS) {
        assert.ok(key in h.ratelimit, `/health snapshot exposes the ${key} limiter`);
      }

      for (const path of [
        PROXY_PATH,
        GMGN_TOKEN_INFO_PATH,
        DEXSCREENER_PATH,
        NANSEN_CREDIT_PATH,
        NANSEN_DOOR_PATH,
      ]) {
        const missing = await post(base, path, {}, undefined);
        assert.equal(missing.status, 401, `${path} without a token`);
        assert.deepEqual(missing.json, { error: 'unauthorized' });

        const bogus = await post(base, path, {}, 'not-a-caller-token');
        assert.equal(bogus.status, 401, `${path} with an unknown token`);
      }

      const metricsMissing = await get(base, '/metrics');
      assert.equal(metricsMissing.status, 401);
      const metricsOk = await get(base, '/metrics', TOKENS.a);
      assert.equal(metricsOk.status, 200);
      assert.equal((metricsOk.json as { caller: string }).caller, 'a');

      assert.equal(upstreamCalls, 0, 'no unauthenticated request ever reached upstream/door');
    },
  );
});

test('/v1/proxy forwards the byte-verbatim raw body through the real limiter; a malformed contract is a 400', async () => {
  const raw = '{"schemaVersion":"1","pairs":[{"chainId":"solana","priceUsd":"0.42"}]}';
  const up = rawUpstream(raw);

  await withGateway({ upstream: up.fetch }, async (base, registry) => {
    const r = await post(
      base,
      PROXY_PATH,
      { provider: DEXSCREENER_LIMITER, endpoint: 'tokens', params: { addresses: 'P' } },
      TOKENS.a,
    );
    assert.equal(r.status, 200);
    assert.equal(envelope(r).status, 200);
    assert.equal(envelope(r).body, raw, 'the raw upstream payload is byte-verbatim');
    assert.equal(envelope(r).headers['content-type'], 'application/json');
    assert.equal(up.calls(), 1);
    assert.equal(
      registry.snapshot()[DEXSCREENER_LIMITER].windowUsed,
      1,
      'the real limiter dispatched exactly one call',
    );

    const bad = await post(base, PROXY_PATH, { endpoint: '/no-provider' }, TOKENS.a);
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'bad_request' });
    assert.equal(up.calls(), 1, 'a malformed contract never reaches upstream');
  });
});

test('selective cache: 2 identical CROSS-CALLER DexScreener requests → 1 upstream call', async () => {
  const raw = '{"pairs":[{"pairAddress":"POOL","priceUsd":"1.23"}]}';
  const up = rawUpstream(raw);

  await withGateway({ dexUpstream: up.fetch }, async (base, registry) => {
    const body = { endpoint: 'tokens', params: { addresses: 'M' } };
    const r1 = await post(base, DEXSCREENER_PATH, body, TOKENS.a);
    const r2 = await post(base, DEXSCREENER_PATH, body, TOKENS.b);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(envelope(r1).body, raw);
    assert.equal(envelope(r2).body, raw, 'caller b receives the cached raw body');
    assert.equal(up.calls(), 1, 'non-credit DexScreener dedupes across callers');
    assert.equal(
      registry.snapshot()[DEXSCREENER_LIMITER].windowUsed,
      1,
      'the cache hit short-circuited BEFORE the limiter (only the initiator ran)',
    );
  });
});

test('selective cache: 2 identical SAME-CALLER Nansen token-information requests → 1 upstream call', async () => {
  const raw = '{"data":[{"token_address":"CA_SAME","volume_usd":9}]}';
  const up = rawUpstream(raw);

  await withGateway({ nansenCreditUpstream: up.fetch }, async (base, registry) => {
    const body = creditBody('CA_SAME');
    const r1 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    const r2 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);

    assert.equal(r1.status, 200);
    assert.equal(envelope(r1).body, raw);
    assert.equal(envelope(r2).body, raw, 'the second same-caller call is a cache hit');
    assert.equal(up.calls(), 1, 'same-caller credit TTL/single-flight collapses to ONE upstream');
    assert.ok(NANSEN_CREDIT_LIMITER in registry.snapshot());
  });
});

test('selective cache: 2 identical CROSS-CALLER Nansen credit requests → 2 upstream calls', async () => {
  const raw = '{"data":[{"token_address":"CA_CROSS"}]}';
  const up = rawUpstream(raw);

  await withGateway({ nansenCreditUpstream: up.fetch }, async (base, registry) => {
    const body = creditBody('CA_CROSS');
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    await post(base, NANSEN_CREDIT_PATH, body, TOKENS.b);

    assert.equal(up.calls(), 2, 'the credit cache key is caller-scoped — b cannot hit a');
    assert.equal(registry.snapshot()[NANSEN_CREDIT_LIMITER].inFlight, 0);
  });
});

test('GMGN exception: 2 identical requests → 2 upstream calls and the cache stays empty', async () => {
  const raw = '{"code":0,"data":{"symbol":"MINI","price":0.001}}';
  const up = rawUpstream(raw);
  const cache = new GatewayCache();

  await withGateway({ gmgnUpstream: up.fetch, cache }, async (base) => {
    const body = { ca: 'CA_GMGN', chain: 'sol' };
    const r1 = await post(base, GMGN_TOKEN_INFO_PATH, body, TOKENS.a);
    const r2 = await post(base, GMGN_TOKEN_INFO_PATH, body, TOKENS.b);

    assert.equal(envelope(r1).body, raw);
    assert.equal(envelope(r2).body, raw);
    assert.equal(up.calls(), 2, 'GMGN mints a fresh client_id/timestamp — never cached/deduped');
    assert.equal(cache.size(), 0, 'the GMGN route never touches the selective cache');
  });
});

test('/v1/nansen/door passes the app-question through the door seam and maps its status', async () => {
  const seen: { url: string; body: unknown }[] = [];
  let status = 200;
  let json: unknown | null = { data: { totalBalance: 42 } };
  const door: DoorPost = async (url, body) => {
    seen.push({ url, body });
    return { status, json };
  };

  await withGateway({ nansenDoor: door }, async (base) => {
    const body = { parameters: { tokenAddress: 'CA_DOOR', chain: 'sol', date: 'day' } };
    const ok = await post(
      base,
      NANSEN_DOOR_PATH,
      { endpoint: 'tgm-holders-gini-stats', body },
      TOKENS.a,
    );
    assert.equal(ok.status, 200);
    assert.equal(
      envelope(ok).body,
      JSON.stringify({ data: { totalBalance: 42 } }),
      'the door JSON is re-serialized into the raw envelope body',
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, NANSEN_DOOR_URLS['tgm-holders-gini-stats']);
    assert.deepEqual(seen[0].body, body, 'the upstream POST body is forwarded verbatim');

    status = 503;
    json = null;
    const unavailable = await post(
      base,
      NANSEN_DOOR_PATH,
      { endpoint: 'tgm-volume-details', body: {} },
      TOKENS.a,
    );
    assert.equal(unavailable.status, 200);
    assert.equal(envelope(unavailable).status, 503, 'a door 503 is a distinct envelope status');
    assert.equal(envelope(unavailable).body, null);
  });
});

test('429 propagation: a GMGN 429 rides the 200 envelope, arms the gate, then the next call is 503 gated', async () => {
  // `x-ratelimit-reset` is an ABSOLUTE epoch-SECONDS value (`gate.ts:27-30`,
  // matching the upstream header) — pin it 30s in the future so the gate arms.
  const resetAt = Math.ceil(Date.now() / 1000) + 30;
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return {
      status: 429,
      body: '{"code":429,"error":"rate limited"}',
      headers: { 'content-type': 'application/json', 'x-ratelimit-reset': String(resetAt) },
    };
  };

  await withGateway({ gmgnUpstream: upstream }, async (base, registry) => {
    const body = { ca: 'CA_429_GMGN', chain: 'sol' };

    const first = await post(base, GMGN_TOKEN_INFO_PATH, body, TOKENS.a);
    assert.equal(first.status, 200, 'an upstream 429 rides the 200 envelope (todo-3 contract)');
    assert.equal(envelope(first).status, 429, 'the upstream status propagates — never swallowed');
    assert.equal(envelope(first).body, null, 'the gate-arming error body is not forwarded');
    assert.ok(
      registry.snapshot().gmgn.gateUntil > Date.now(),
      'the gmgn gate is armed from x-ratelimit-reset',
    );

    const second = await post(base, GMGN_TOKEN_INFO_PATH, body, TOKENS.a);
    assert.equal(second.status, 503, 'the armed gate makes the next call back off');
    assert.deepEqual(second.json, { error: 'gated' });
    assert.ok(second.headers.get(GATED_HEADER), 'the 503 carries the gate-expiry header');
    assert.equal(calls, 1, 'the gated call never reached upstream');
  });
});

test('429 propagation: both DexScreener classes surface the upstream 429 (no gate, no retry)', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return { status: 429, body: 'too many requests', headers: {} };
  };

  await withGateway({ dexUpstream: upstream }, async (base, registry) => {
    const standard = await post(
      base,
      DEXSCREENER_PATH,
      { endpoint: 'tokens', params: { addresses: 'M' } },
      TOKENS.a,
    );
    assert.equal(standard.status, 200);
    assert.equal(envelope(standard).status, 429, 'the standard class propagates the 429');
    assert.equal(envelope(standard).body, null);

    const profiles = await post(base, DEXSCREENER_PATH, { endpoint: 'profiles' }, TOKENS.a);
    assert.equal(profiles.status, 200);
    assert.equal(envelope(profiles).status, 429, 'the profiles class propagates the 429 too');

    assert.equal(calls, 2, 'neither DexScreener class retries (retries belong to other limiters)');
    assert.equal(registry.snapshot()[DEXSCREENER_LIMITER].gateUntil, 0, 'no gate on the standard class');
    assert.equal(
      registry.snapshot()[DEXSCREENER_PROFILES_LIMITER].gateUntil,
      0,
      'no gate on the profiles class',
    );
  });
});

test('429 propagation: a Nansen credit 429 surfaces after the real limiter retry (no swallow)', async () => {
  // Pin a fast, ONE-retry real limiter so the test proves the retry ran (upstream
  // called twice) without the default ~20s fibonacci wait.
  const specs = buildSpecs(5);
  specs[NANSEN_CREDIT_LIMITER] = {
    ...specs[NANSEN_CREDIT_LIMITER],
    retry: { retries: 1, backoff: 'fibo', baseMs: 1, retryOn: (s: number) => s === 429 || s >= 500 },
  };
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return { status: 429, body: 'slow down', headers: {} };
  };

  await withGateway({ nansenCreditUpstream: upstream, specs }, async (base, registry) => {
    const r = await post(base, NANSEN_CREDIT_PATH, creditBody('CA_429_CREDIT'), TOKENS.a);
    assert.equal(r.status, 200);
    assert.equal(envelope(r).status, 429, 'the status propagates after the retry budget is spent');
    assert.equal(envelope(r).body, null);
    assert.equal(calls, 2, 'the real limiter retried exactly once before surfacing — not swallowed');
    assert.equal(registry.snapshot()[NANSEN_CREDIT_LIMITER].inFlight, 0);
  });
});
