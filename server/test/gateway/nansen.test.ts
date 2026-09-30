// Nansen gateway routes (plan request-plane-gateway, todo 7) — BOTH seams.
//
//   (a) the CREDIT route (`/v1/nansen/credit`) calls upstream exactly ONCE and
//       returns the raw body, through `limiters.run('nansen-credit', {priority})`
//   (b) the FREE-DOOR route (`/v1/nansen/door`) calls the DoorPool exactly ONCE
//       and returns the raw body
//   (c) an upstream 429 propagates the status + `x-ratelimit-reset` (never swallowed)
//   (d) a SECOND CONCURRENT credit call is QUEUED by the concurrency cap — never dropped
//   + the real credit fetcher hits api.nansen.ai with the gateway-held apikey
//   + the routes are caller-gated and reject a bad body at the trust boundary
//
// The HTTP assertions drive the REAL gateway app over ephemeral ports with a
// STUBBED upstream; the concurrency case drives the REAL `Limiter` so the
// `maxConcurrency` semaphore (not a hand-rolled mock) is what queues the call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createGatewayApp } from '../../src/gateway/app.js';
import type { CallerTokens } from '../../src/gateway/auth.js';
import {
  NANSEN_CREDIT_LIMITER,
  NANSEN_CREDIT_PATH,
  NANSEN_DOOR_PATH,
  NANSEN_DOOR_URLS,
  nansenCreditUpstream,
  doorEndpointFor,
  parseNansenCredit,
  parseNansenDoor,
  type DoorPost,
} from '../../src/gateway/nansen.js';
import type {
  GatewayEnvelope,
  GatewayRequest,
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

const CREDIT_ENDPOINT = '/api/v1/tgm/flows';
const CREDIT_BODY = { chain: 'sol', token_address: 'CA', date: { from: 'a', to: 'b' } };

function okUpstream(body = '{"data":[]}'): UpstreamResponse {
  return { status: 200, body, headers: { 'content-type': 'application/json' } };
}

/** A runner that records the (api, opts) and executes the job untouched (no throttle). */
function recordingLimiter(): { run: LimiterRun; calls: { api: string; opts: RunOpts }[] } {
  const calls: { api: string; opts: RunOpts }[] = [];
  const run: LimiterRun = async (api, opts, fn) => {
    calls.push({ api, opts });
    return fn();
  };
  return { run, calls };
}

interface ServerDeps {
  nansenCreditUpstream?: UpstreamFetch;
  nansenDoor?: DoorPost;
  runLimiter?: LimiterRun;
}

async function withServer(
  deps: ServerDeps,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createGatewayApp({
    tokens: TOKENS,
    nansenCreditUpstream: deps.nansenCreditUpstream,
    nansenDoor: deps.nansenDoor,
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

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('parseNansenCredit validates the API path at the trust boundary (SSRF guard)', () => {
  assert.deepEqual(parseNansenCredit({ endpoint: CREDIT_ENDPOINT, body: { a: 1 } }), {
    ok: true,
    value: { endpoint: CREDIT_ENDPOINT, body: { a: 1 }, priority: undefined },
  });
  assert.equal(parseNansenCredit({ endpoint: 'no-slash' }).ok, false);
  assert.equal(parseNansenCredit({ endpoint: '//evil.example/x' }).ok, false, 'no authority swap via //');
  assert.equal(parseNansenCredit({ endpoint: 'https://evil.example/x' }).ok, false, 'no absolute URL');
  assert.equal(parseNansenCredit({ endpoint: CREDIT_ENDPOINT, priority: 3 }).ok, false);
  assert.equal(parseNansenCredit(null).ok, false);
});

test('parseNansenDoor allowlists the app-question endpoints', () => {
  assert.deepEqual(parseNansenDoor({ endpoint: 'tgm-holders-gini-stats', body: { q: 1 } }), {
    ok: true,
    value: { endpoint: 'tgm-holders-gini-stats', body: { q: 1 } },
  });
  assert.equal(parseNansenDoor({ endpoint: 'tgm-unknown' }).ok, false);
  assert.equal(parseNansenDoor({ endpoint: 'https://evil.example/x' }).ok, false);
  assert.equal(parseNansenDoor(null).ok, false);
});

test('doorEndpointFor maps the three provider URLs to their gateway endpoints', () => {
  assert.equal(doorEndpointFor(NANSEN_DOOR_URLS['tgm-essential-data']), 'tgm-essential-data');
  assert.equal(doorEndpointFor(NANSEN_DOOR_URLS['tgm-volume-details']), 'tgm-volume-details');
  assert.equal(doorEndpointFor(NANSEN_DOOR_URLS['tgm-holders-gini-stats']), 'tgm-holders-gini-stats');
  assert.equal(doorEndpointFor('https://app.nansen.ai/api/questions/unknown'), null);
});

test('(a) the credit route calls upstream ONCE, returns the raw body, and passes priority to nansen-credit', async () => {
  const RAW = '{"data":[{"date":"2026-09-30","value_usd":42}]}';
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return okUpstream(RAW);
  };
  const rec = recordingLimiter();

  await withServer({ nansenCreditUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(base, NANSEN_CREDIT_PATH, { endpoint: CREDIT_ENDPOINT, body: CREDIT_BODY, priority: 1 }, TOKENS.a);

    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 200);
    assert.equal(env.body, RAW, 'the byte-verbatim raw upstream body is returned');
    assert.equal(env.headers['content-type'], 'application/json');

    assert.equal(calls, 1, 'exactly ONE upstream call');
    assert.equal(rec.calls.length, 1, 'exactly ONE limiter call');
    assert.equal(rec.calls[0].api, NANSEN_CREDIT_LIMITER);
    assert.equal(rec.calls[0].opts.priority, 1);
    assert.equal(rec.calls[0].opts.path, CREDIT_ENDPOINT);
  });
});

test('(b) the free-door route calls the DoorPool ONCE and returns the raw body', async () => {
  const seen: { url: string; body: unknown }[] = [];
  const door: DoorPost = async (url, body) => {
    seen.push({ url, body });
    return { status: 200, json: { data: [{ totalBalance: 208_428_160 }] } };
  };

  await withServer({ nansenDoor: door }, async (base) => {
    const body = { parameters: { tokenAddress: 'CA', chain: 'sol', date: 'day' } };
    const r = await post(base, NANSEN_DOOR_PATH, { endpoint: 'tgm-holders-gini-stats', body }, TOKENS.a);

    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 200);
    assert.equal(
      env.body,
      JSON.stringify({ data: [{ totalBalance: 208_428_160 }] }),
      'the raw app-question body is returned (re-serialized from the DoorPool JSON)',
    );

    assert.equal(seen.length, 1, 'exactly ONE door call');
    assert.equal(seen[0].url, NANSEN_DOOR_URLS['tgm-holders-gini-stats'], 'the endpoint maps to its app-question URL');
    assert.deepEqual(seen[0].body, body, 'the upstream POST body is forwarded verbatim');
  });
});

test('(c) an upstream 429 propagates status + x-ratelimit-reset and is NOT swallowed', async () => {
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    return {
      status: 429,
      body: '{"error":"rate limited"}',
      headers: { 'content-type': 'application/json', 'x-ratelimit-reset': '1700000000' },
    };
  };
  // Pass-through runner so the assertion is about propagation, not the
  // limiter's own fibo retry (which is the ONLY place retries may live).
  const rec = recordingLimiter();

  await withServer({ nansenCreditUpstream: upstream, runLimiter: rec.run }, async (base) => {
    const r = await post(base, NANSEN_CREDIT_PATH, { endpoint: CREDIT_ENDPOINT, body: CREDIT_BODY }, TOKENS.a);

    assert.equal(r.status, 200, 'an upstream 429 rides the 200 envelope, per the todo-3 contract');
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 429, 'the upstream status is propagated, not swallowed');
    assert.equal(env.body, null, 'the gate-arming error body is never forwarded');
    assert.equal(env.headers['x-ratelimit-reset'], '1700000000', 'the reset header arms the gate');
    assert.equal(r.headers.get('x-ratelimit-reset'), null, 'allowlisted headers ride the envelope, not the transport');
    assert.equal(calls, 1, 'exactly ONE upstream call (retries belong to the limiter)');
    assert.equal(rec.calls.length, 1);
  });
});

test('(c2) a DoorPool 429 propagates as a distinct envelope status', async () => {
  let calls = 0;
  const door: DoorPost = async () => {
    calls += 1;
    return { status: 429, json: null };
  };

  await withServer({ nansenDoor: door }, async (base) => {
    const r = await post(base, NANSEN_DOOR_PATH, { endpoint: 'tgm-volume-details', body: {} }, TOKENS.a);
    assert.equal(r.status, 200);
    const env = r.json as GatewayEnvelope;
    assert.equal(env.status, 429, 'the quarantined-door status is distinct');
    assert.equal(env.body, null);
    assert.equal(calls, 1);
  });
});

test('(d) a second concurrent credit call is QUEUED by the concurrency cap — never dropped', async () => {
  // Pin the cap so the test is independent of any RL_* env override.
  const specs = buildSpecs(1);
  specs[NANSEN_CREDIT_LIMITER] = { ...specs[NANSEN_CREDIT_LIMITER], maxConcurrency: 2 };
  const registry = new LimiterRegistry(specs);
  const runLimiter: LimiterRun = (api, opts, fn) => registry.run(api, opts, fn);

  const releases: Array<() => void> = [];
  let calls = 0;
  const upstream: UpstreamFetch = async () => {
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return okUpstream('{"data":[]}');
  };

  await withServer({ nansenCreditUpstream: upstream, runLimiter }, async (base) => {
    const body = { endpoint: CREDIT_ENDPOINT, body: CREDIT_BODY };
    const p1 = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    const p2 = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);

    await waitFor(() => calls === 2);
    assert.equal(registry.snapshot()[NANSEN_CREDIT_LIMITER].inFlight, 2, 'both slots are occupied');

    const p3 = post(base, NANSEN_CREDIT_PATH, body, TOKENS.a);
    await waitFor(() => registry.snapshot()[NANSEN_CREDIT_LIMITER].queued === 1);
    assert.equal(calls, 2, 'the 3rd call is QUEUED at the cap — not dispatched, not dropped');

    releases[0]();
    await waitFor(() => calls === 3);
    releases[1]();
    releases[2]();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(calls, 3, 'the queued call runs once a slot frees — never dropped');
    for (const r of [r1, r2, r3]) {
      assert.equal(r.status, 200);
      assert.equal((r.json as GatewayEnvelope).status, 200);
    }
  });
});

test('the real credit fetcher POSTs to api.nansen.ai with the gateway-held apikey', async () => {
  const urls: string[] = [];
  const keys: string[] = [];
  const bodies: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    const headers = init?.headers as Record<string, string> | undefined;
    keys.push(headers?.apikey ?? '');
    bodies.push(String(init?.body ?? ''));
    return new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const upstream = nansenCreditUpstream({ fetchImpl: fakeFetch, apiKey: 'nansen-key' });
  const req: GatewayRequest = {
    provider: NANSEN_CREDIT_LIMITER,
    endpoint: CREDIT_ENDPOINT,
    body: CREDIT_BODY,
    priority: 1,
  };
  const res = await upstream(req, 'a');

  assert.equal(urls[0], 'https://api.nansen.ai/api/v1/tgm/flows');
  assert.deepEqual(keys, ['nansen-key']);
  assert.deepEqual(JSON.parse(bodies[0]), CREDIT_BODY);
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"data":[]}');
});

test('both routes are caller-gated and reject a bad body without calling upstream', async () => {
  let creditCalls = 0;
  let doorCalls = 0;
  const upstream: UpstreamFetch = async () => {
    creditCalls += 1;
    return okUpstream();
  };
  const door: DoorPost = async () => {
    doorCalls += 1;
    return { status: 200, json: {} };
  };

  await withServer({ nansenCreditUpstream: upstream, nansenDoor: door }, async (base) => {
    const noTokenCredit = await post(base, NANSEN_CREDIT_PATH, { endpoint: CREDIT_ENDPOINT, body: {} });
    assert.equal(noTokenCredit.status, 401);
    assert.deepEqual(noTokenCredit.json, { error: 'unauthorized' });

    const noTokenDoor = await post(base, NANSEN_DOOR_PATH, { endpoint: 'tgm-volume-details', body: {} });
    assert.equal(noTokenDoor.status, 401);
    assert.deepEqual(noTokenDoor.json, { error: 'unauthorized' });

    const badCredit = await post(base, NANSEN_CREDIT_PATH, { endpoint: 'https://evil.example/x', body: {} }, TOKENS.a);
    assert.equal(badCredit.status, 400);
    assert.deepEqual(badCredit.json, { error: 'bad_request' });

    const badDoor = await post(base, NANSEN_DOOR_PATH, { endpoint: 'tgm-nope', body: {} }, TOKENS.a);
    assert.equal(badDoor.status, 400);
    assert.deepEqual(badDoor.json, { error: 'bad_request' });

    assert.equal(creditCalls, 0, 'no denial ever reached the credit upstream');
    assert.equal(doorCalls, 0, 'no denial ever reached the DoorPool');
  });
});
