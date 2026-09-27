// T2 RED tests for the door pool — frozen contract:
// .omo/notepads/nansen-proxy-routing/decisions.md "T2/T3 FROZEN INTERFACE CONTRACT"
// + plan D3–D7. T3 implements these crawl.ts exports to turn this file GREEN
// WITHOUT editing it. No network, no chrome, no real timers: fake
// connect/now/sleep everywhere; sleep() resolves immediately and advances the
// virtual clock so D7 wait loops terminate deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  DoorPool,
  parseProxyFile,
  type DoorConn,
  type DoorHttpResponse,
  type DoorPoolConfig,
  type DoorPoolDeps,
  type DoorSpec,
  type ProxySpec,
} from '../src/crawl.js';

// ---------- fake clock ----------

interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
}

const T0 = 1_000_000;

function makeClock(): Clock {
  let t = T0;
  return {
    now: () => t,
    // Resolve immediately AND move virtual time forward: the D7 wait loop
    // (poll 250ms, cap 65s) and quarantine waits finish in bounded iterations
    // with zero real time passed.
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

// ---------- response fixtures (shapes from .probe evidence, see issues.md) ----------

function res(p: Partial<DoorHttpResponse>): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 0, json: null, threw: false, ...p };
}
const okJson = (json: unknown): DoorHttpResponse => res({ status: 200, json, head: JSON.stringify(json), len: 64 });
const transportFail = (): DoorHttpResponse => res({ status: 0, contentType: '', json: null, threw: true });
const throttle429 = (retryAfter: number): DoorHttpResponse =>
  res({ status: 429, contentType: 'text/html', retryAfter, head: '<html><head><title>Error 1015</title>', len: 975, json: null });
const real403Json = (): DoorHttpResponse =>
  res({ status: 403, contentType: 'application/json', head: '{"error":"access denied"}', len: 25, json: { error: 'access denied' } });
const interstitialHtml = (): DoorHttpResponse =>
  res({ status: 403, contentType: 'text/html', head: '<html><head><title>Just a moment...</title>', len: 6173, json: null });

type Responder = (callIndex: number) => DoorHttpResponse;

// ---------- fake door ----------

interface FakeDoor {
  conn: DoorConn;
  responder: Responder;
  fetchCount: number;
  fetchTimes: number[]; // virtual timestamp of every fetch (proves waits/quarantines)
  invalidateCount: number;
  closeCount: number;
  outstanding: number;
  holdNext: boolean; // keep the next fetch in flight (least-outstanding test)
  blocked: Array<() => void>;
}

function makeDoor(clock: Clock): FakeDoor {
  const d: FakeDoor = {
    responder: () => okJson({ data: 'ok' }),
    fetchCount: 0,
    fetchTimes: [],
    invalidateCount: 0,
    closeCount: 0,
    outstanding: 0,
    holdNext: false,
    blocked: [],
    conn: {
      fetch: async (_url, _body, _timeoutMs) => {
        d.fetchCount += 1;
        d.fetchTimes.push(clock.now());
        d.outstanding += 1;
        try {
          const out = d.responder(d.fetchCount);
          if (d.holdNext) {
            d.holdNext = false;
            await new Promise<void>((r) => {
              d.blocked.push(r);
            });
          }
          return out;
        } finally {
          d.outstanding -= 1;
        }
      },
      invalidate: async () => {
        d.invalidateCount += 1;
      },
      close: async () => {
        d.closeCount += 1;
      },
    },
  };
  return d;
}

// ---------- harness ----------

interface Harness {
  pool: DoorPool;
  doors: FakeDoor[];
  clock: Clock;
  connectSpecs: DoorSpec[];
  logs: string[];
}

function makeHarness(over: Partial<DoorPoolConfig> = {}): Harness {
  const clock = makeClock();
  const config: DoorPoolConfig = {
    wsEndpoint: 'ws://chrome:3000',
    proxies: [],
    pathBudget: 30,
    budgetWindowMs: 60_000,
    doorCapPerMin: 40,
    warmupTimeoutMs: 30_000,
    requestTimeoutMs: 45_000,
    quarantineJitterMs: 0, // quarantine = retryAfter*1000 exactly → deterministic clock jumps
    ...over,
  };
  const doors: FakeDoor[] = [];
  for (let i = 0; i < Math.max(1, config.proxies.length); i++) doors.push(makeDoor(clock));
  const connectSpecs: DoorSpec[] = [];
  const logs: string[] = [];
  const deps: DoorPoolDeps = {
    config,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    log: (line) => {
      logs.push(line);
    },
    connect: async (spec) => {
      connectSpecs.push(spec);
      // Re-warm reconnects map back to the SAME fake door (matched by proxy
      // url) so per-door counters accumulate across re-warms.
      const idx = spec.proxy == null ? 0 : Math.max(0, config.proxies.findIndex((p) => p.url === spec.proxy?.url));
      return doors[Math.min(idx, doors.length - 1)]!.conn;
    },
  };
  return { pool: new DoorPool(deps), doors, clock, connectSpecs, logs };
}

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

async function waitFor(cond: () => boolean, what: string, maxTurns = 5000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** start() is fire-and-forget per contract — drain via event-loop turns, never real sleep. */
async function startPool(h: Harness): Promise<void> {
  h.pool.start();
  await waitFor(
    () => h.pool.stats().length === h.doors.length && h.pool.stats().every((s) => s.state !== 'cold' && s.state !== 'warming'),
    'all doors finish warmup',
  );
}

const nu = (path: string): string => `https://app.nansen.ai/api/questions/${path}`;
const px = (n: number): ProxySpec => ({ url: `http://u${n}:p${n}@10.0.0.${n}:808${n}`, username: `u${n}`, password: `p${n}` });
const statOf = (h: Harness, i: number) => h.pool.stats()[i]!;

/**
 * Prime the LRU: one successful request marks its door most-recently-used, so
 * the NEXT request deterministically routes to the OTHER door first
 * (plan D7: least-outstanding, tie → least-recently-used) — no assumption
 * about which door a cold pool picks first.
 */
async function primeSplit(h: Harness): Promise<{ first: FakeDoor; other: FakeDoor; otherIdx: number }> {
  const r = await h.pool.postJson(nu('prime'), { prime: true });
  assert.equal(r.status, 200, 'prime request must succeed');
  const firstIdx = h.doors[0]!.fetchCount > 0 ? 0 : 1;
  const otherIdx = 1 - firstIdx;
  return { first: h.doors[firstIdx]!, other: h.doors[otherIdx]!, otherIdx };
}

// ---------- group 1: parseProxyFile ----------

test('parseProxyFile: drops blanks/comments/garbage, splits credentials, keeps valid http(s) lines in order', () => {
  const text = [
    '# dedicated proxy list — one per line',
    '',
    'http://alice:s3cret@10.0.0.1:8080',
    '   ',
    'https://bob:pw@proxy.example.com:3128',
    'garbage not a url',
    'ftp://carol:x@10.0.0.2:1080',
    '://broken',
    'http://',
  ].join('\n');
  const specs = parseProxyFile(text);
  assert.equal(specs.length, 2, 'exactly the two valid http(s) proxy lines survive');
  assert.equal(specs[0]!.username, 'alice');
  assert.equal(specs[0]!.password, 's3cret');
  assert.ok(specs[0]!.url.includes('10.0.0.1:8080'), 'url keeps host:port');
  assert.equal(specs[1]!.username, 'bob');
  assert.equal(specs[1]!.password, 'pw');
  assert.ok(specs[1]!.url.includes('proxy.example.com:3128'));
  assert.deepEqual(parseProxyFile(''), [], 'empty file → no proxies (single-door fallback)');
  assert.deepEqual(parseProxyFile('# only\n# comments\n\n'), [], 'comments-only file → no proxies');
});

// ---------- group 2: classify ----------

test('classify: evidence fixtures map to ok/throttle/interstitial/real403/5xx/transport', () => {
  const cases: Array<[DoorHttpResponse, ReturnType<typeof classify>, string]> = [
    [res({ status: 200, json: { data: [] }, head: '{"data":[]}', len: 13 }), 'ok', '200 + parsed json'],
    [res({ status: 429, contentType: 'text/html', retryAfter: 2204, head: '<html><head><title>Error 1015</title>', len: 975 }), 'throttle', '429 Error 1015 ~975B'],
    [res({ status: 403, contentType: 'text/html', head: '<html> Just a moment...</html>', len: 6472 }), 'interstitial', '403 + html ~6472B challenge'],
    [res({ status: 403, contentType: 'application/octet-stream', head: '<html><body>challenge</body>', len: 6100 }), 'interstitial', '403 + head starting with < (D4)'],
    [res({ status: 403, head: '{"error":"access denied"}', len: 25, json: { error: 'access denied' } }), 'real403', '403 + json'],
    [res({ status: 500 }), '5xx', '500'],
    [res({ status: 503 }), '5xx', '503'],
    [res({ status: 0, contentType: '', threw: true }), 'transport', 'thrown transport failure'],
    [res({ status: 200, threw: true, json: { half: true } }), 'transport', 'threw beats any status'],
    [res({ status: 200, json: null, head: '', len: 0 }), 'transport', '200 but json parse failed (D4)'],
  ];
  for (const [fixture, want, label] of cases) {
    assert.equal(classify(fixture), want, label);
  }
});

// ---------- group 3: budget per (door,path) + sliding-window prune ----------

test('budget: 31st request for a saturated path waits for the window to prune; other paths unaffected', async () => {
  const h = makeHarness({ proxies: [] }); // single door: pathBudget 30 / window 60s / cap 40
  await startPool(h);
  const d = h.doors[0]!;
  const t0 = h.clock.now();

  for (let i = 0; i < 30; i++) {
    const r = await h.pool.postJson(nu('tgm-volume-details'), { i });
    assert.equal(r.status, 200);
  }
  assert.equal(d.fetchCount, 30);
  assert.equal(statOf(h, 0).budgetUsed, 30, 'window budget fully used after 30 same-path requests');

  const rb = await h.pool.postJson(nu('tgm-essential-data'), {});
  assert.equal(rb.status, 200);
  assert.ok(d.fetchTimes[30]! < t0 + 60_000, 'path B served immediately — per-path budget, no wait');

  const r31 = await h.pool.postJson(nu('tgm-volume-details'), { i: 31 });
  assert.equal(r31.status, 200);
  assert.equal(d.fetchCount, 32);
  assert.ok(
    d.fetchTimes[31]! >= t0 + 60_000,
    `31st path-A fetch must wait until the t0 timestamps fall out of the 60s window (fetched at +${d.fetchTimes[31]! - t0}ms)`,
  );
});

// ---------- group 3b: door cap across all paths ----------

test('budget: door cap per minute blocks EVERY path until the window slides', async () => {
  const h = makeHarness({ proxies: [] });
  await startPool(h);
  const d = h.doors[0]!;
  const t0 = h.clock.now();

  for (let i = 0; i < 30; i++) await h.pool.postJson(nu('tgm-volume-details'), { i });
  for (let i = 0; i < 10; i++) await h.pool.postJson(nu(`wp4t-transactions-${i}`), { i });
  assert.equal(d.fetchCount, 40, '30 + 10 requests fill the 40/min door cap');
  assert.ok(d.fetchTimes.every((t) => t < t0 + 60_000), 'cap reached without any waiting');

  const r = await h.pool.postJson(nu('tgm-holders-gini-stats'), {}); // fresh path, cap full
  assert.equal(r.status, 200);
  assert.equal(d.fetchCount, 41);
  assert.ok(d.fetchTimes[40]! >= t0 + 60_000, 'even a fresh path is ineligible once the door cap is hit');
});

// ---------- group 4a: router least-outstanding ----------

test('router: second in-flight request goes to the door with fewer outstanding fetches', async () => {
  const h = makeHarness({ proxies: [px(1), px(2)] });
  await startPool(h);
  h.doors[0]!.holdNext = true;
  h.doors[1]!.holdNext = true;

  const p1 = h.pool.postJson(nu('p1'), {});
  await waitFor(() => h.doors[0]!.outstanding + h.doors[1]!.outstanding === 1, 'first request in flight');
  const p2 = h.pool.postJson(nu('p2'), {});
  await waitFor(() => h.doors[0]!.outstanding + h.doors[1]!.outstanding === 2, 'second request in flight');

  assert.equal(h.doors[0]!.outstanding, 1, 'least-outstanding spreads concurrent requests across doors');
  assert.equal(h.doors[1]!.outstanding, 1);

  for (const door of h.doors) for (const release of door.blocked.splice(0)) release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

// ---------- group 4b: router excludes throttled doors ----------

test('router: throttled door is excluded from selection', async () => {
  const h = makeHarness({ proxies: [px(1), px(2)] });
  await startPool(h);
  const { first, other, otherIdx } = await primeSplit(h);
  other.responder = (n) => (n === 1 ? throttle429(1000) : okJson({ data: 'ok' }));

  const r1 = await h.pool.postJson(nu('x1'), {});
  assert.equal(r1.status, 200, '429 on one door is requeried to the healthy door');
  assert.equal(other.fetchCount, 1);
  assert.equal(statOf(h, otherIdx).state, 'throttled');

  for (let i = 0; i < 3; i++) {
    const r = await h.pool.postJson(nu(`q${i}`), {});
    assert.equal(r.status, 200);
  }
  assert.equal(other.fetchCount, 1, 'throttled door receives no new requests');
  assert.equal(first.fetchCount, 5, 'prime + requery + 3 requests all served by the healthy door');
});

// ---------- group 5a: requery on transport failure ----------

test('requery: transport failure on one door is retried exactly once on the other (total 2 fetches)', async () => {
  const h = makeHarness({ proxies: [px(1), px(2)] });
  await startPool(h);
  const { first, other } = await primeSplit(h);
  other.responder = (n) => (n === 1 ? transportFail() : okJson({ data: 'ok' }));

  const r = await h.pool.postJson(nu('tgm-holders-change'), {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: 'ok' });
  assert.equal(other.fetchCount, 1, 'failing door tried exactly once');
  assert.equal(first.fetchCount, 2, 'requery ran on the other door — exactly 2 fetches for the request, no loop');
});

// ---------- group 5b: requery also fails ----------

test('requery: when the requery also fails → {status:502|original, json:null}, at most 2 fetches', async () => {
  const h = makeHarness({ proxies: [px(1), px(2)] });
  await startPool(h);
  for (const d of h.doors) d.responder = () => transportFail();

  const r = await h.pool.postJson(nu('tgm-volume-details'), {});
  assert.equal(r.json, null, 'no fabricated data on failure');
  assert.ok(r.status === 502 || r.status === 0, `status must be 502 or the original transport status, got ${r.status}`);
  assert.equal(h.doors[0]!.fetchCount + h.doors[1]!.fetchCount, 2, 'one fetch per door — requery capped at 1 extra');
});

// ---------- group 5a-bis: interstitial retried on the SAME page before any rewarm ----------

test('interstitial: challenged XHR retried once on the same page → 200, no rewarm (cleared page reused)', async () => {
  const h = makeHarness({ proxies: [] }); // single door
  await startPool(h);
  const d = h.doors[0]!;
  d.responder = (n) => (n === 1 ? interstitialHtml() : okJson({ data: 'ok' }));

  const r = await h.pool.postJson(nu('tgm-holders-gini-stats'), {});
  assert.equal(r.status, 200, 'same-page retry must win');
  assert.deepEqual(r.json, { data: 'ok' });
  assert.equal(d.fetchCount, 2, 'exactly one same-page retry');
  assert.equal(d.invalidateCount, 0, 'no page rebuild on a transient challenge');
  assert.equal(statOf(h, 0).state, 'healthy');
});

// ---------- group 5c + 4c: retire after 2 consecutive transport fails; exhausted pool → 503 ----------

test('lifecycle: 2 consecutive transport failures retire a door (broken-proxy); exhausted pool degrades to 503 without throwing', async () => {
  const h = makeHarness({ proxies: [] }); // single door
  await startPool(h);
  const d = h.doors[0]!;
  d.responder = () => transportFail();

  const r1 = await h.pool.postJson(nu('a'), {});
  assert.equal(r1.json, null);
  assert.equal(d.fetchCount, 1);
  assert.notEqual(statOf(h, 0).state, 'retired', 'one transport failure is not enough');

  const r2 = await h.pool.postJson(nu('b'), {});
  assert.equal(r2.json, null);
  assert.equal(d.fetchCount, 2, 'no retry loop');
  assert.equal(statOf(h, 0).state, 'retired');
  assert.equal(statOf(h, 0).retiredReason, 'broken-proxy');

  const r3 = await h.pool.postJson(nu('c'), {}); // must NOT throw
  assert.equal(r3.status, 503, 'no live doors → 503 marker');
  assert.equal(r3.json, null);
  assert.equal(d.fetchCount, 2, 'retired door is never fetched again');
});

// ---------- group 6: 429 quarantine lifecycle ----------

test('429: quarantine for retryAfter (+jitter=0) → probation → first 200 promotes to healthy; request requeried immediately', async () => {
  const h = makeHarness({ proxies: [px(1), px(2)] });
  await startPool(h);
  const { first, other, otherIdx } = await primeSplit(h);
  other.responder = (n) => (n === 1 ? throttle429(100) : okJson({ data: 'ok' })); // retry-after 100s

  const t1 = h.clock.now();
  const r1 = await h.pool.postJson(nu('hit'), {});
  assert.equal(r1.status, 200, 'throttled request is requeried to the other door right away');
  assert.equal(first.fetchCount, 2);
  assert.equal(statOf(h, otherIdx).state, 'throttled');

  h.clock.advance(99_999); // 1ms short of quarantine expiry
  const r2 = await h.pool.postJson(nu('early'), {});
  assert.equal(r2.status, 200);
  assert.equal(other.fetchCount, 1, 'still quarantined 99.999s into a 100s retry-after');
  assert.equal(first.fetchCount, 3);

  h.clock.advance(2); // now = t1 + 100_001 — quarantine over
  const r3 = await h.pool.postJson(nu('after'), {});
  assert.equal(r3.status, 200);
  assert.equal(other.fetchCount, 2, 'door back in rotation once retry-after elapsed (probation)');
  assert.equal(statOf(h, otherIdx).state, 'healthy', 'first 200 after probation promotes to healthy');
});

// ---------- group 7a: real 403 → re-warm + requery; repeat → penalized ----------

test('403-real: invalidate + re-warm, request requeried; second real-403 after re-warm → penalized', async () => {
  const h = makeHarness({ proxies: [px(1), px(2)] });
  await startPool(h);
  const { first, other, otherIdx } = await primeSplit(h);
  other.responder = (n) => (n <= 2 ? real403Json() : okJson({ data: 'ok' }));

  const r1 = await h.pool.postJson(nu('d1'), {});
  assert.equal(r1.status, 200, 'real-403 request requeried to the healthy door');
  assert.equal(other.fetchCount, 1);
  assert.equal(first.fetchCount, 2);
  assert.ok(other.invalidateCount >= 1, 'real 403 invalidates the page (re-warm, D5)');
  await waitFor(() => statOf(h, otherIdx).state === 'probation', 're-warmed door returns to probation');

  const r2 = await h.pool.postJson(nu('d2'), {});
  assert.equal(r2.status, 200, 'second real-403 still requeried');
  assert.equal(other.fetchCount, 2);
  assert.equal(first.fetchCount, 3);
  assert.equal(statOf(h, otherIdx).state, 'penalized', 'repeated real-403 after re-warm penalizes the door (D3)');
});

// ---------- group 7b: penalized backoff expiry (fake clock) ----------

test('penalized: 2m backoff via fake clock → re-warm → probation → 200 → healthy', async () => {
  const h = makeHarness({ proxies: [] });
  await startPool(h);
  const d = h.doors[0]!;
  d.responder = (n) => (n <= 2 ? real403Json() : okJson({ data: 'ok' }));

  const r1 = await h.pool.postJson(nu('s1'), {});
  assert.equal(r1.json, null);
  assert.ok([403, 502].includes(r1.status), `original status or 502, got ${r1.status}`);
  await waitFor(() => statOf(h, 0).state === 'probation', 'first real-403 → re-warm → probation');

  const r2 = await h.pool.postJson(nu('s2'), {});
  assert.equal(r2.json, null);
  assert.equal(statOf(h, 0).state, 'penalized');
  const tPenalized = h.clock.now();

  h.clock.advance(120_001); // first-stage 2m backoff over
  const r3 = await h.pool.postJson(nu('s3'), {});
  assert.equal(r3.status, 200, 'door recovers after the backoff and serves again');
  assert.ok(d.fetchTimes[2]! >= tPenalized + 120_000, 'no fetch before the 2m backoff elapsed');
  assert.equal(statOf(h, 0).state, 'healthy');
});

// ---------- group 8: single-door fallback ----------

test('fallback: empty proxy list → one door, connect spec {ws, proxy:null} without --proxy-server, 429 still quarantined', async () => {
  const h = makeHarness({ proxies: [] });
  await startPool(h);
  assert.equal(h.connectSpecs.length, 1, 'exactly one door from the bare WS endpoint');
  assert.deepEqual(h.connectSpecs[0], { ws: 'ws://chrome:3000', proxy: null });
  assert.ok(!h.connectSpecs[0]!.ws.includes('--proxy-server'), 'no proxy query on the fallback door');
  assert.equal(h.pool.stats().length, 1);

  const d = h.doors[0]!;
  d.responder = (n) => (n === 1 ? throttle429(50) : okJson({ data: 'ok' })); // retry-after 50s < 65s wait cap
  const t0 = h.clock.now();

  const r1 = await h.pool.postJson(nu('f1'), {});
  assert.equal(r1.json, null, '429 is not passed through as data (old crawl.ts:145 bug) and not fabricated');
  assert.ok([429, 502].includes(r1.status), `original 429 or 502, got ${r1.status}`);
  assert.equal(statOf(h, 0).state, 'throttled', 'single-door 429 still quarantines (bug-fix)');

  const r2 = await h.pool.postJson(nu('f2'), {});
  assert.equal(r2.status, 200, 'next request waits out the quarantine (fake sleep advances the clock) then succeeds');
  assert.ok(d.fetchTimes[1]! >= t0 + 50_000, 'no fetch during quarantine');
  assert.equal(statOf(h, 0).state, 'healthy');
});

// ---------- group 9: page/CDP-origin failures must not retire the door ----------
//
// 2026-09-23 incident: browserless closed the browser process, so every in-flight fetch
// returned threw + head='browser: page unavailable (invalidated)'. classify() can only
// see threw+status 0, so those counted as transport fails and BOTH doors retired
// 'broken-proxy' within 200ms — while both proxies were actually healthy (an
// in-container probe got HTTP 200 through each). The pool then served 503 for 30+ min
// and no T100/LF factor landed. A page-origin throw is a LOCAL failure: re-warm.

const browserFail = (): DoorHttpResponse =>
  res({ status: 0, contentType: '', json: null, threw: true, head: 'browser: page unavailable (invalidated)' });

test('browser-level failure: re-warms the door instead of retiring it, and the door keeps serving', async () => {
  const h = makeHarness({ proxies: [] }); // single door — the blackout case
  await startPool(h);
  const d = h.doors[0]!;
  d.responder = () => browserFail();

  for (let i = 0; i < 3; i++) {
    const r = await h.pool.postJson(nu(`page-fail-${i}`), {});
    assert.equal(r.json, null, 'no fabricated data on a page-origin failure');
  }
  assert.notEqual(statOf(h, 0).state, 'retired', 'a dead PAGE is not a dead proxy');
  assert.equal(statOf(h, 0).retiredReason, null);
  assert.ok(d.invalidateCount >= 1, 'page-origin failure triggers a re-warm');
  assert.ok(d.fetchCount >= 3, 'door keeps taking requests instead of dying');

  d.responder = () => okJson({ data: 'ok' });
  await waitFor(() => ['probation', 'healthy'].includes(statOf(h, 0).state), 're-warm settles the door');
  const r = await h.pool.postJson(nu('after-page-fail'), {});
  assert.equal(r.status, 200, 're-warmed door serves again');
  assert.deepEqual(r.json, { data: 'ok' });
  assert.equal(statOf(h, 0).retiredReason, null, 'never marked retired');
});

test('browser-level failure does NOT spend a transport fail: a real transport fail still retires (2 consecutive)', async () => {
  const h = makeHarness({ proxies: [] });
  await startPool(h);
  const d = h.doors[0]!;

  d.responder = () => browserFail();
  await h.pool.postJson(nu('p1'), {});
  await h.pool.postJson(nu('p2'), {});
  assert.notEqual(statOf(h, 0).state, 'retired', 'two page-origin fails leave the door alive');

  d.responder = () => transportFail(); // bare throw, empty head = genuine transport failure
  await h.pool.postJson(nu('t1'), {});
  assert.notEqual(statOf(h, 0).state, 'retired', 'first real transport fail is not enough');
  await h.pool.postJson(nu('t2'), {});
  assert.equal(statOf(h, 0).state, 'retired', 'the D5 rule still holds for real transport failures');
  assert.equal(statOf(h, 0).retiredReason, 'broken-proxy');
});

// ---------- group 10: a retired door is not a permanent death sentence ----------

test('re-arm: broken-proxy door revives after RETIRED_RETRY_MS and serves again (503 only inside the cooldown)', async () => {
  const h = makeHarness({ proxies: [] });
  await startPool(h);
  const d = h.doors[0]!;
  d.responder = () => transportFail();

  await h.pool.postJson(nu('r1'), {});
  await h.pool.postJson(nu('r2'), {});
  assert.equal(statOf(h, 0).state, 'retired');
  assert.equal(statOf(h, 0).retiredReason, 'broken-proxy');

  const r3 = await h.pool.postJson(nu('r3'), {});
  assert.equal(r3.status, 503, 'inside the cooldown the pool still degrades to 503');
  assert.equal(d.fetchCount, 2, 'retired door is not fetched while the cooldown runs');

  h.clock.advance(60_001); // cooldown over
  d.responder = () => okJson({ data: 'revived' });
  const r4 = await h.pool.postJson(nu('r4'), {});
  assert.equal(r4.status, 200, 're-armed door serves again instead of a permanent blackout');
  assert.deepEqual(r4.json, { data: 'revived' });
  assert.equal(statOf(h, 0).state, 'healthy');
  assert.equal(statOf(h, 0).retiredReason, null, 'a live door does not read as retired');
  assert.ok(h.connectSpecs.length >= 2, 're-arm re-connects the door');
});

test('re-arm: a real403-reputation retire stays terminal (a 403-ing IP is not re-probed every minute)', async () => {
  const h = makeHarness({ proxies: [] });
  await startPool(h);
  const d = h.doors[0]!;
  d.responder = () => real403Json();

  // Drive the full reputation ladder: re-warm → penalized 2m → 10m → 30m → retired.
  for (let i = 0; i < 5; i++) {
    await h.pool.postJson(nu(`403-${i}`), {});
    h.clock.advance(1_800_001); // past every backoff stage
  }
  assert.equal(statOf(h, 0).retiredReason, 'real403-reputation');

  h.clock.advance(600_000); // 10 minutes later
  d.responder = () => okJson({ data: 'ok' });
  const r = await h.pool.postJson(nu('after'), {});
  assert.equal(r.status, 503, 'reputation-retired doors are not re-armed');
  assert.equal(statOf(h, 0).state, 'retired');
});
