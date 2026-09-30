// DexScreener gateway route (plan request-plane-gateway, todo 9).
//
//   (a) the pairs/tokens/search class → the `dexscreener` limiter (300/min)
//   (b) the profiles/boosts class     → the `dexscreener-profiles` limiter (60/min)
//   (c) the RAW upstream body is returned unchanged
//   (d) the literal `dexscreener` key still exists in `limiters.snapshot()`
//   + each class throttles at its own window (300 pass, #301 waits; 60 pass, #61 waits)
//   + an unknown endpoint is a 400 trust-boundary denial (no upstream call)
//
// The burst case drives the REAL `Limiter` over an injected fake clock, so the
// 300/min and 60/min windows are observed deterministically without waiting a
// real minute. The HTTP cases drive the REAL gateway app over an ephemeral port
// with a stubbed upstream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import {
  DEXSCREENER_LIMITER,
  DEXSCREENER_PATH,
  DEXSCREENER_PROFILES_LIMITER,
  dexScreenerUpstream,
  handleDexScreener,
  parseDexScreener,
  type DexEndpoint,
} from '../../src/gateway/dexscreener.js';
import type {
  GatewayEnvelope,
  GatewayRequest,
  LimiterRun,
  UpstreamFetch,
  UpstreamResponse,
} from '../../src/gateway/contract.js';
import { limiters } from '../../src/ratelimit/index.js';
import { Limiter } from '../../src/ratelimit/limiter.js';
import { buildSpecs } from '../../src/ratelimit/spec.js';
import type { ApiLimitSpec, RunOpts } from '../../src/ratelimit/types.js';

const TOKENS: CallerTokens = {
  a: 'token-a-secret',
  b: 'token-b-secret',
  watcher: 'token-w-secret',
};

function okUpstream(body = '{"pairs":[]}'): UpstreamResponse {
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

/** Controllable clock so window waits are observed without real minutes. */
class FakeClock {
  private t = 0;
  private timers: { at: number; id: object; fn: () => void }[] = [];
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = {};
    this.timers.push({ at: this.t + ms, id, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers = this.timers.filter((x) => (x.id as unknown) !== handle);
  };
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.fn();
  }
}

/** A `Limiter` per api key sharing one fake clock (the real throttle logic). */
function classedLimiter(specs: Record<string, ApiLimitSpec>, clock: FakeClock): LimiterRun {
  const byKey = new Map<string, Limiter>();
  return (api, opts, fn) => {
    let l = byKey.get(api);
    if (l === undefined) {
      l = new Limiter(api, specs[api], clock);
      byKey.set(api, l);
    }
    return l.run(opts, fn);
  };
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withServer(
  deps: { dexUpstream: UpstreamFetch; runLimiter?: LimiterRun },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createGatewayApp({
    tokens: TOKENS,
    dexUpstream: deps.dexUpstream,
    runLimiter: deps.runLimiter,
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

async function post(base: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${DEXSCREENER_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

test('parseDexScreener validates endpoint / params / priority at the trust boundary', () => {
  assert.deepEqual(parseDexScreener({ endpoint: 'tokens', params: { addresses: 'A' } }), {
    ok: true,
    value: { endpoint: 'tokens', params: { addresses: 'A' }, priority: undefined },
  });
  assert.deepEqual(parseDexScreener({ endpoint: 'boosts', priority: 2 }), {
    ok: true,
    value: { endpoint: 'boosts', params: undefined, priority: 2 },
  });
  assert.equal(parseDexScreener({ endpoint: 'nope' }).ok, false);
  assert.equal(parseDexScreener({ endpoint: 'tokens', priority: 9 }).ok, false);
  assert.equal(parseDexScreener({ endpoint: 'tokens', params: { a: {} } }).ok, false);
  assert.equal(parseDexScreener(null).ok, false);
});

test('(a) a pairs/tokens/search endpoint picks the `dexscreener` limiter (300/min class)', async () => {
  const upstream: UpstreamFetch = async () => okUpstream();
  const rec = recordingLimiter();

  await withServer({ dexUpstream: upstream, runLimiter: rec.run }, async (base) => {
    for (const endpoint of ['tokens', 'pairs', 'search'] as const) {
      const r = await post(base, { endpoint, params: { addresses: 'A' }, priority: 0 }, TOKENS.a);
      assert.equal(r.status, 200);
      assert.equal(rec.calls.at(-1)?.api, DEXSCREENER_LIMITER, `${endpoint} → standard class`);
      assert.equal(rec.calls.at(-1)?.opts.priority, 0);
      assert.equal(rec.calls.at(-1)?.opts.path, endpoint);
    }
    assert.equal(rec.calls.length, 3);
  });
});

test('(b) a profiles/boosts endpoint picks the `dexscreener-profiles` limiter (60/min class)', async () => {
  const upstream: UpstreamFetch = async () => okUpstream();
  const rec = recordingLimiter();

  await withServer({ dexUpstream: upstream, runLimiter: rec.run }, async (base) => {
    for (const endpoint of ['profiles', 'boosts'] as const) {
      const r = await post(base, { endpoint }, TOKENS.a);
      assert.equal(r.status, 200);
      assert.equal(
        rec.calls.at(-1)?.api,
        DEXSCREENER_PROFILES_LIMITER,
        `${endpoint} → profiles class`,
      );
    }
    assert.equal(rec.calls.length, 2);
  });
});

test('(c) the raw upstream body is returned byte-identical over the HTTP route', async () => {
  const raw =
    '{"pairs":[{"baseToken":{"address":"MINT"},"info":{"imageUrl":"https://cdn.dexscreener.com/x.png"},"liquidity":{"usd":42}}]}';
  const upstream: UpstreamFetch = async () => ({
    status: 200,
    body: raw,
    headers: { 'content-type': 'application/json' },
  });
  const rec = recordingLimiter();

  await withServer({ dexUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(base, { endpoint: 'tokens', params: { addresses: 'MINT' } }, TOKENS.a);
    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 200);
    assert.equal(env.body, raw, 'raw body is byte-identical');
    assert.equal(env.headers['content-type'], 'application/json');
    assert.equal(rec.calls[0].api, DEXSCREENER_LIMITER);
  });
});

test('(d) the windows are class-correct and the literal `dexscreener` key survives', () => {
  withEnv({ RL_DEXSCREENER_MAX: '', RL_DEXSCREENER_PROFILES_MAX: '' }, () => {
    const s = buildSpecs(5);
    assert.equal(s.dexscreener.window?.max, 300, 'standard class defaults to 300/min');
    assert.equal(s['dexscreener-profiles'].window?.max, 60, 'profiles class defaults to 60/min');
  });
  withEnv({ RL_DEXSCREENER_MAX: '321', RL_DEXSCREENER_PROFILES_MAX: '17' }, () => {
    const s = buildSpecs(5);
    assert.equal(s.dexscreener.window?.max, 321, 'standard window is env-tunable');
    assert.equal(s['dexscreener-profiles'].window?.max, 17, 'profiles window is env-tunable');
  });
  const snap = limiters.snapshot();
  assert.ok(DEXSCREENER_LIMITER in snap, 'the literal `dexscreener` key still exists');
  assert.ok(DEXSCREENER_PROFILES_LIMITER in snap);
});

test('each class throttles at its own window: 300 pass / #301 waits; 60 pass / #61 waits', async () => {
  await withEnvAsync({ RL_DEXSCREENER_MAX: '300', RL_DEXSCREENER_PROFILES_MAX: '60' }, async () => {
    const specs = buildSpecs(1);
    const clock = new FakeClock();
    const runLimiter = classedLimiter(specs, clock);
    let calls = 0;
    const upstream: UpstreamFetch = async (req) => {
      calls += 1;
      return { status: 200, body: `{"e":"${req.endpoint}"}`, headers: {} };
    };
    const call = (endpoint: DexEndpoint) =>
      handleDexScreener({ endpoint, params: { addresses: 'A' } }, 'a', {
        fetchUpstream: upstream,
        runLimiter,
      });

    // standard class: 300 pass immediately
    const burst = Array.from({ length: 300 }, () => call('tokens'));
    const results = await Promise.all(burst);
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(calls, 300, '300 standard-class calls all start');

    let settled301 = false;
    const p301 = call('tokens').then((r) => {
      settled301 = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled301, false, '#301 must WAIT out the 300/min window');
    clock.advance(60_000);
    assert.equal((await p301).status, 200, '#301 runs once the window rolls');
    assert.equal(calls, 301);

    // profiles class: 60 pass, #61 waits
    const pburst = Array.from({ length: 60 }, () => call('profiles'));
    const presults = await Promise.all(pburst);
    assert.ok(presults.every((r) => r.status === 200));
    assert.equal(calls, 361, '60 profiles-class calls all start');

    let settled61 = false;
    const p61 = call('profiles').then((r) => {
      settled61 = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled61, false, '#61 must WAIT out the 60/min profiles window');
    clock.advance(60_000);
    assert.equal((await p61).status, 200);
    assert.equal(calls, 362);
  });
});

test('an upstream 500 surfaces as envelope status:500 with a null body (no swallow)', async () => {
  const upstream: UpstreamFetch = async () => ({ status: 500, body: 'boom', headers: {} });
  const rec = recordingLimiter();

  await withServer({ dexUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(base, { endpoint: 'tokens', params: { addresses: 'M' } }, TOKENS.a);
    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 500);
    assert.equal(env.body, null, 'the error body is not forwarded');
  });
});

test('the real fetcher builds the tokens URL and returns the raw body', async () => {
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response('{"pairs":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const upstream = dexScreenerUpstream({ fetchImpl: fakeFetch });
  const req: GatewayRequest = {
    provider: DEXSCREENER_LIMITER,
    endpoint: 'tokens',
    params: { addresses: 'A,B' },
  };
  const res = await upstream(req, 'a');
  assert.equal(urls[0], 'https://api.dexscreener.com/latest/dex/tokens/A,B');
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"pairs":[]}');
});

test('the route is caller-gated and rejects a bad endpoint without calling upstream', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream();
  };
  const rec = recordingLimiter();

  await withServer({ dexUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const noToken = await post(base, { endpoint: 'tokens' });
    assert.equal(noToken.status, 401);
    assert.deepEqual(noToken.json, { error: 'unauthorized' });

    const badEndpoint = await post(base, { endpoint: 'nope' }, TOKENS.a);
    assert.equal(badEndpoint.status, 400);
    assert.deepEqual(badEndpoint.json, { error: 'bad_request' });

    assert.equal(calls, 0, 'no denial ever reached upstream');
    assert.equal(rec.calls.length, 0, 'no denial ever reached the limiter');
  });
});
