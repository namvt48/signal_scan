// Nansen credit accounting + equal a/b split + exceeded-half soft-deny
// (plan request-plane-gateway, todo 19; draft Decision 5 superseded to EQUAL
// split 2026-09-30).
//
// The REAL gateway app drives every case over an ephemeral port with only the
// upstream bytes stubbed, so the pinned request order (auth -> cache -> budget
// pre-flight -> limiter -> upstream) is what is actually exercised:
//
//   (a) each side is capped at HALF of the injected budget (snapshot().used)
//   (b) the over-cap caller gets 429 {error:"budget_exceeded"} +
//       `x-gateway-budget: exceeded`, and ONLY that caller
//   (c) the other caller AND the other providers keep working (gmgn /
//       dexscreener / nansen-door still 200; the pre-flight no-ops for them)
//   (d) counters reset on the UTC day boundary of the injected clock
//   (e) a budget denial never reaches the limiter: the shared `nansen-credit`
//       gate stays unarmed and nothing is queued for the other caller
//   (f) a cache hit adds 0 to the caller's credit count
//   cost rules: the real `x-nansen-credits-cost` wins; else the table
//       (`holders`=5, `holders`+`premium_labels`=150); a headerless non-2xx is
//       not charged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import {
  NANSEN_CREDIT_LIMITER,
  NANSEN_CREDIT_PATH,
  NANSEN_DOOR_PATH,
  type DoorPost,
} from '../../src/gateway/nansen.js';
import { DEXSCREENER_PATH } from '../../src/gateway/dexscreener.js';
import { GMGN_TOKEN_INFO_PATH } from '../../src/gateway/gmgn.js';
import {
  BUDGET_EXCEEDED,
  BUDGET_HEADER,
  CreditAccountant,
  creditCostFor,
} from '../../src/gateway/credit.js';
import { GatewayCache } from '../../src/gateway/cache.js';
import type {
  GatewayEnvelope,
  LimiterRun,
  UpstreamFetch,
  UpstreamResponse,
} from '../../src/gateway/contract.js';
import { LimiterRegistry } from '../../src/ratelimit/registry.js';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import type { RunOpts } from '../../src/ratelimit/types.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

const TOKEN_INFO = '/api/v1/tgm/token-information';

function creditBody(tokenAddress: string, extra: Record<string, unknown> = {}): unknown {
  return { endpoint: TOKEN_INFO, body: { parameters: { tokenAddress, chain: 'solana', ...extra } } };
}

function okUpstream(body = '{"data":[]}'): UpstreamResponse {
  return { status: 200, body, headers: { 'content-type': 'application/json' } };
}

/** A 200 upstream stub that counts calls (unique addresses avoid cache hits). */
function countingUpstream(body = '{"data":[]}'): { fetch: UpstreamFetch; calls: () => number } {
  let calls = 0;
  const fetch: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream(body);
  };
  return { fetch, calls: () => calls };
}

function fakeClock(start = Date.UTC(2026, 0, 1, 12)): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** A REAL limiter registry plus a spy recording every `run()` it dispatches. */
function recordingRegistry(): { run: LimiterRun; calls: { api: string; opts: RunOpts }[]; registry: LimiterRegistry } {
  const registry = new LimiterRegistry(buildSpecs(5));
  const calls: { api: string; opts: RunOpts }[] = [];
  const run: LimiterRun = (api, opts, fn) => {
    calls.push({ api, opts });
    return registry.run(api, opts, fn);
  };
  return { run, calls, registry };
}

interface ServerDeps {
  nansenCreditUpstream?: UpstreamFetch;
  dexUpstream?: UpstreamFetch;
  gmgnUpstream?: UpstreamFetch;
  nansenDoor?: DoorPost;
  runLimiter?: LimiterRun;
  cache?: GatewayCache;
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

test('(a)(b)(c)(e) equal split: each side capped at half; denial is caller-scoped, gate-free and route-scoped', async () => {
  const up = countingUpstream();
  const rec = recordingRegistry();
  const credits = new CreditAccountant({ budget: 4 }); // half = 2
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });
  const dex = countingUpstream('{"pairs":[]}');
  const gmgn = countingUpstream('{"code":0}');
  const doorUrls: string[] = [];
  const door: DoorPost = async (url) => {
    doorUrls.push(url);
    return { status: 200, json: { ok: true } };
  };

  await withServer(
    {
      nansenCreditUpstream: up.fetch,
      dexUpstream: dex.fetch,
      gmgnUpstream: gmgn.fetch,
      nansenDoor: door,
      runLimiter: rec.run,
      cache,
      credits,
    },
    async (base) => {
      // (a) caller a consumes its half (2 credits at cost 1) then is denied.
      const a1 = await post(base, NANSEN_CREDIT_PATH, creditBody('A1'), TOKENS.a);
      const a2 = await post(base, NANSEN_CREDIT_PATH, creditBody('A2'), TOKENS.a);
      assert.equal(a1.status, 200);
      assert.equal(envelope(a1).body, '{"data":[]}');
      assert.equal(a2.status, 200);
      assert.equal(credits.snapshot().used.a, 2, 'a consumed exactly its half');

      const denied = await post(base, NANSEN_CREDIT_PATH, creditBody('A3'), TOKENS.a);
      assert.equal(denied.status, 429, '(b) over-cap is a gateway 429');
      assert.deepEqual(denied.json, { error: 'budget_exceeded' });
      assert.equal(
        denied.headers.get(BUDGET_HEADER),
        BUDGET_EXCEEDED,
        'the marker header distinguishes it from a genuine upstream 429',
      );
      assert.equal(up.calls(), 2, 'the denied call never reached upstream');
      assert.equal(rec.calls.length, 2, 'the denied call never reached the limiter');
      assert.equal(credits.snapshot().used.a, 2, 'a denial charges nothing');

      // (e) the shared gate is NOT armed and nothing is queued for b.
      const snap = rec.registry.snapshot()[NANSEN_CREDIT_LIMITER];
      assert.equal(snap.gateUntil, 0, 'a budget denial must not arm the shared nansen-credit gate');
      assert.equal(snap.inFlight, 0);
      assert.equal(snap.queued, 0);

      // (a) caller b is unaffected and gets its own half.
      const b1 = await post(base, NANSEN_CREDIT_PATH, creditBody('B1'), TOKENS.b);
      assert.equal(b1.status, 200, 'b still succeeds after a is denied');
      assert.equal(credits.snapshot().used.b, 1, 'b spends its own half only');
      assert.equal(rec.calls.length, 3, 'b ran the limiter normally');
      assert.equal(rec.registry.snapshot()[NANSEN_CREDIT_LIMITER].gateUntil, 0);

      // (c) a's OTHER routes keep working while a is over its credit half.
      const dexRes = await post(base, DEXSCREENER_PATH, { endpoint: 'tokens', params: { addresses: 'M' } }, TOKENS.a);
      const gmgnRes = await post(base, GMGN_TOKEN_INFO_PATH, { ca: 'CA', chain: 'sol' }, TOKENS.a);
      const doorRes = await post(base, NANSEN_DOOR_PATH, { endpoint: 'tgm-essential-data', body: {} }, TOKENS.a);
      assert.equal(dexRes.status, 200, 'DexScreener is unaffected by the credit half');
      assert.equal(gmgnRes.status, 200, 'GMGN is unaffected by the credit half');
      assert.equal(doorRes.status, 200, 'the free door is unaffected by the credit half');
      assert.equal(dex.calls(), 1);
      assert.equal(gmgn.calls(), 1);
      assert.equal(doorUrls.length, 1);

      // (c) the pre-flight only ever governs the nansen-credit provider + a/b.
      assert.equal(credits.preflight('gmgn', {}, 'a'), undefined);
      assert.equal(credits.preflight('dexscreener', {}, 'a'), undefined);
      assert.equal(credits.preflight(NANSEN_CREDIT_LIMITER, {}, 'watcher'), undefined);
      assert.equal(credits.snapshot().used.a, 2, 'a stayed capped');
      assert.equal(credits.snapshot().used.b, 1);
    },
  );
});

test('(d) counters reset at the UTC day boundary of the injected clock', async () => {
  const up = countingUpstream();
  const rec = recordingRegistry();
  const clock = fakeClock(Date.UTC(2026, 0, 1, 12));
  const credits = new CreditAccountant({ budget: 2, now: clock.now }); // half = 1
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: up.fetch, runLimiter: rec.run, cache, credits }, async (base) => {
    const first = await post(base, NANSEN_CREDIT_PATH, creditBody('D1'), TOKENS.a);
    assert.equal(first.status, 200);
    assert.equal(credits.snapshot().day, '2026-01-01');
    assert.equal(credits.snapshot().used.a, 1);

    const denied = await post(base, NANSEN_CREDIT_PATH, creditBody('D2'), TOKENS.a);
    assert.equal(denied.status, 429, 'the half is exhausted on day 1');

    clock.advance(86_400_000); // 2026-01-02
    const nextDay = await post(base, NANSEN_CREDIT_PATH, creditBody('D3'), TOKENS.a);
    assert.equal(nextDay.status, 200, 'a new UTC day resets the half');
    const snap = credits.snapshot();
    assert.equal(snap.day, '2026-01-02');
    assert.equal(snap.used.a, 1, 'the counter restarted at 0, then charged this call');
    assert.equal(snap.used.b, 0);
  });
});

test('(f) a cache hit adds 0 to the caller credit count', async () => {
  const up = countingUpstream();
  const credits = new CreditAccountant({ budget: 10 });
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });

  await withServer({ nansenCreditUpstream: up.fetch, cache, credits }, async (base) => {
    const body = creditBody('F1');
    const r1 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(r1.status, 200);
    assert.equal(up.calls(), 1);
    assert.equal(credits.snapshot().used.a, 1);

    const r2 = await post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    assert.equal(r2.status, 200);
    assert.equal(envelope(r2).body, envelope(r1).body, 'the cached body is served');
    assert.equal(up.calls(), 1, 'a hit performs no second upstream call');
    assert.equal(credits.snapshot().used.a, 1, 'a 0-credit hit does not increment the caller count');
  });
});

test('cost rules: the real upstream header wins, else the table; a headerless non-2xx is not charged', async () => {
  assert.equal(creditCostFor('/api/v1/tgm/token-information', {}), 1);
  assert.equal(creditCostFor('/api/v1/tgm/flows?page=1', {}), 1);
  assert.equal(creditCostFor('/api/v1/tgm/holders', {}), 5);
  assert.equal(creditCostFor('/api/v1/tgm/holders', { parameters: { premium_labels: true } }), 150);
  assert.equal(creditCostFor('/api/v1/tgm/unknown', {}), 1, 'an unknown endpoint defaults to the conservative floor');

  let mode: 'header' | 'fail' = 'header';
  const upstream: UpstreamFetch = async (): Promise<UpstreamResponse> => {
    if (mode === 'fail') return { status: 500, body: 'boom', headers: {} };
    return {
      status: 200,
      body: '{"data":[]}',
      headers: { 'content-type': 'application/json', 'x-nansen-credits-cost': '7' },
    };
  };
  const credits = new CreditAccountant({ budget: 100 });
  const cache = new GatewayCache({ ttlNansenMs: 60_000 });
  // Pass-through limiter: this test is about the COST rules, and the real
  // nansen-credit fibo retry would make the intentional 500 wait ~20s.
  const passthrough: LimiterRun = (_api, _opts, fn) => fn();

  await withServer({ nansenCreditUpstream: upstream, cache, credits, runLimiter: passthrough }, async (base) => {
    const r1 = await post(base, NANSEN_CREDIT_PATH, creditBody('C1'), TOKENS.a);
    assert.equal(r1.status, 200);
    assert.equal(credits.snapshot().used.a, 7, 'the REAL header cost (7) is charged, not the table (1)');

    mode = 'fail';
    const r2 = await post(base, NANSEN_CREDIT_PATH, creditBody('C2'), TOKENS.a);
    assert.equal(r2.status, 200);
    assert.equal(envelope(r2).status, 500, 'the upstream 500 rides the envelope');
    assert.equal(credits.snapshot().used.a, 7, 'a headerless non-2xx charges nothing');
  });
});
