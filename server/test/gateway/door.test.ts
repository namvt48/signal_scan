// DoorPool relocation + gateway door-stats (plan request-plane-gateway, todo 10).
//
//   (a) a door call is counted against the path + door budget
//   (b) a quarantined door is skipped (clear 503, no stuck wait)
//   (c) the gateway /health reports the relocated pool stats
//   + door.ts is DB-free (grep-style)
//   + instance a's PUBLIC /api/health is fed from the gateway AND strips
//     egressIp/proxy, degrading to doors:null (never 500) when the gateway is down
//
// No network / no chrome: the DoorPool runs over a fake connect/now/sleep, and
// the two HTTP assertions drive REAL listeners over ephemeral ports.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DoorPool,
  setPoolForTest,
  type DoorConn,
  type DoorHttpResponse,
  type DoorPoolDeps,
} from '../../src/gateway/door.js';
import { createGatewayApp } from '../../src/gateway/app.js';
import { open } from '../../src/db.js';
import { createApp } from '../../src/api.js';

before(() => {
  // /api/health reads maxTokenFetchedAt(); a real (in-memory) DB must be open.
  open(':memory:');
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.once('listening', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });
}

function okResponse(json: unknown = { ok: true }): DoorHttpResponse {
  const head = JSON.stringify(json);
  return { status: 200, contentType: 'application/json', retryAfter: null, head, len: head.length, json, threw: false };
}

/** Fake-clock DoorPool deps; `sleep` advances the virtual clock so D7 loops terminate. */
function fakeDeps(opts: {
  pathBudget?: number;
  doorCapPerMin?: number;
  budgetWindowMs?: number;
  fetch?: (call: number) => DoorHttpResponse;
}): DoorPoolDeps {
  let now = 1_000_000;
  let calls = 0;
  const conn: DoorConn = {
    async fetch() {
      calls += 1;
      return (opts.fetch ?? (() => okResponse()))(calls);
    },
    async invalidate() {},
    async close() {},
  };
  return {
    connect: async () => conn,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    config: {
      wsEndpoint: 'ws://fake',
      proxies: [],
      pathBudget: opts.pathBudget ?? 30,
      budgetWindowMs: opts.budgetWindowMs ?? 60_000,
      doorCapPerMin: opts.doorCapPerMin ?? 40,
      warmupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      quarantineJitterMs: 0,
    },
    log: () => {},
  };
}

async function startedPool(deps: DoorPoolDeps): Promise<DoorPool> {
  const pool = new DoorPool(deps);
  pool.start();
  // start() warms fire-and-forget; flush the microtask so conn is set before use.
  await new Promise((r) => setImmediate(r));
  return pool;
}

test('(a) a door call is counted against the path + door budget', async () => {
  const deps = fakeDeps({ pathBudget: 1, budgetWindowMs: 5_000 });
  const pool = await startedPool(deps);
  const url = 'https://app.nansen.ai/api/questions/tgm-volume-details';

  const r1 = await pool.postJson(url, { q: 1 });
  assert.equal(r1.status, 200);
  assert.equal(pool.stats()[0].requests, 1);
  assert.equal(pool.stats()[0].budgetUsed, 1, 'the call was counted in the sliding window');

  const before = deps.now();
  const r2 = await pool.postJson(url, { q: 2 });
  assert.equal(r2.status, 200);
  assert.ok(deps.now() - before >= 5_000, 'same-path call waited out the per-path budget window');
  assert.equal(pool.stats()[0].requests, 2);
  assert.equal(pool.stats()[0].budgetUsed, 1, 'only the fresh hit remains inside the window');
});

test('(b) a quarantined door is skipped with a clear 503, no stuck wait', async () => {
  const deps = fakeDeps({
    fetch: (call) =>
      call === 1
        ? { status: 429, contentType: 'text/html', retryAfter: 100, head: 'Error 1015', len: 9, json: null, threw: false }
        : okResponse(),
  });
  const pool = await startedPool(deps);
  const url = 'https://app.nansen.ai/api/questions/app-questions';

  const r1 = await pool.postJson(url, {});
  assert.equal(r1.status, 429);
  assert.equal(pool.stats()[0].state, 'throttled');

  const before = deps.now();
  const r2 = await pool.postJson(url, {});
  assert.equal(r2.status, 503);
  assert.equal(deps.now(), before, 'an already-beyond-cap quarantine slot 503s without polling');
  assert.equal(pool.stats()[0].requests, 1, 'the quarantined door was not dispatched again');
});

test('(c) the gateway /health reports the relocated pool stats', async () => {
  const pool = await startedPool(fakeDeps({}));
  setPoolForTest(pool);
  const server = createGatewayApp({ tokens: { a: 'a', b: 'b', watcher: 'w' } }).listen(0);
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { doors: Array<Record<string, unknown>> };
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.doors));
    assert.equal(body.doors.length, 1);
    assert.equal(body.doors[0].state, 'probation');
    assert.ok('egressIp' in body.doors[0], 'gateway /health carries egressIp (internal-only)');
  } finally {
    server.close();
    setPoolForTest(null);
  }
});

test('door.ts is DB-free (no db / better-sqlite3 import)', () => {
  const src = readFileSync(new URL('../../src/gateway/door.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /better-sqlite3/);
  assert.doesNotMatch(src, /from\s+['"][^'"]*\/db\.js['"]/);
});

test("instance a's /api/health door table is fed from the gateway, egressIp/proxy stripped", async () => {
  const stub = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        ratelimit: {},
        doors: [
          {
            id: 0,
            state: 'healthy',
            proxy: 'http://user:pass@1.2.3.4:8080',
            egressIp: '203.0.113.9',
            requests: 7,
            lastStatus: 200,
            budgetUsed: 2,
            retiredReason: null,
          },
        ],
      }),
    );
  }).listen(0);
  const gbase = await listen(stub);
  const prev = process.env.GATEWAY_URL;
  process.env.GATEWAY_URL = gbase;
  const app = createApp('test').listen(0);
  const abase = await listen(app);
  try {
    const res = await fetch(`${abase}/api/health`);
    const body = (await res.json()) as { doors: Array<Record<string, unknown>> };
    assert.equal(res.status, 200);
    assert.equal(body.doors.length, 1);
    assert.equal(body.doors[0].state, 'healthy');
    assert.equal(body.doors[0].budgetUsed, 2);
    assert.equal(body.doors[0].egressIp, undefined);
    assert.equal(body.doors[0].proxy, undefined);
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes('203.0.113.9'), 'the egress IP must not reach the PUBLIC api health');
    assert.ok(!wire.includes('1.2.3.4'), 'the proxy string must not reach the PUBLIC api health');
  } finally {
    app.close();
    stub.close();
    if (prev === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = prev;
  }
});

test('instance a /api/health degrades to doors:null when the gateway is down (never 500)', async () => {
  const prev = process.env.GATEWAY_URL;
  process.env.GATEWAY_URL = 'http://127.0.0.1:1';
  const app = createApp('test').listen(0);
  const base = await listen(app);
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200, 'a dead gateway must not 500 the public health endpoint');
    const body = (await res.json()) as { doors: unknown; healthy: boolean };
    assert.equal(body.doors, null);
    assert.equal(body.healthy, true);
  } finally {
    app.close();
    if (prev === undefined) delete process.env.GATEWAY_URL;
    else process.env.GATEWAY_URL = prev;
  }
});
