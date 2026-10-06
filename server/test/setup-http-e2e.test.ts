// F3 HTTP-level e2e (plan setup-fill-on-add, Final Verification Wave):
//   A REAL `POST /api/tracked-cas` request must drive the serialized early setup pass
//   through the production chain — createApp route → kickCAs → kickToken().then(
//   kickSetupEarly) → drainEarlySetup → refreshSeries — so token_state fills
//   (t100_multiple / genesis_bal / anchor_at) without waiting for a sweep.
//   Unlike setup-early-kick.test.ts, this exercises the real HTTP route.
//   One add fills setup with one T100 and one LF request; no separate chart fetch.
//   - two concurrent adds → early passes serialized, never an exchange-call burst
//   - re-add after a DB-table reset → absorbed by the FILE cache entry the first
//     HTTP add wrote: ZERO extra calls anywhere (the cache lifecycle end-to-end)
// Env BEFORE the src imports: crawlEnabled gates the trigger, NEW_CA_PRIORITY_MS
// shrinks the queue-jump window to test size, DB_PATH + SETUP_CACHE_FILE point
// config at this test's temp dir. Assertions are on COUNTS and DB state, never
// on wall-clock. node:test = one process per file, so this is safe.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'setup-http-e2e-'));
const dbFile = join(dir, 'signal_scan.db');
process.env.NANSEN_CRAWL = 'on';
process.env.NEW_CA_PRIORITY_MS = '1000';
process.env.DB_PATH = dbFile;
process.env.SETUP_CACHE_FILE = join(dir, 'nansen-cache.json');
// AUTH CONTRACT v1: POST /api/tracked-cas accepts the service role — the same
// token the wallet_watch daemon sends. Env BEFORE the src imports (config snapshot).
process.env.SERVICE_TOKEN = 'e2e-service-token';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DoorConn, DoorHttpResponse } from '../src/crawl.js';
import type { HourlyStatsRow, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider, MetricPatch, TokenInfo, WalletTokenHolding } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';

const { open, getDb, getTokenState } = await import('../src/db.js');
const { loadSetupCache, getSetupCacheEntry } = await import('../src/setup-cache.js');
const { DoorPool, setPoolForTest } = await import('../src/crawl.js');
const { setPollerDeps, earlySetupIdle } = await import('../src/poller.js');
const { createApp } = await import('../src/api.js');
const { NANSEN_HOURLY_STATS_URL } = await import('../src/providers/nansen.js');

const CHAIN: Chain = 'sol';
const CA1 = 'CA-HTTP-1';
const CA2 = 'CA-HTTP-2';
const CA3 = 'CA-HTTP-3';
const DAY = 86_400_000;
const NOW = Date.now();
const DEPLOYED_AT = NOW - 2 * DAY;

let doorFetches = 0;
let flowsCalls = 0;
let exchangeFetches = 0;
let activeExchange = 0;
let maxActiveExchange = 0;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[]): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(NOW - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Counting fake of the official tgm/flows client; tracks exchange-call overlap.
 * (Same harness as setup-early-kick.test.ts.) */
function installFakeFlows(series: TgmFlowsRow[], exchange: TgmFlowsRow[]): TokenFlowsClient {
  flowsCalls = 0;
  exchangeFetches = 0;
  activeExchange = 0;
  maxActiveExchange = 0;
  return {
    tokenFlows: async (req) => {
      flowsCalls += 1;
      if (req.label !== 'exchange') return series;
      exchangeFetches += 1;
      activeExchange += 1;
      maxActiveExchange = Math.max(maxActiveExchange, activeExchange);
      await nextTurn(); // hold the "request" open so overlap is observable
      activeExchange -= 1;
      return exchange;
    },
  };
}

/** Tripwire door — any hourly-stats fetch through it is a regression. */
async function installFakeDoor(): Promise<void> {
  doorFetches = 0;
  const conn: DoorConn = {
    fetch: async (url) => {
      if (url !== NANSEN_HOURLY_STATS_URL) return okJson([]);
      doorFetches += 1;
      return okJson([]);
    },
    invalidate: async () => {},
    close: async () => {},
  };
  const pool = new DoorPool({
    connect: async () => conn,
    now: () => Date.now(),
    sleep: async () => {},
    config: {
      wsEndpoint: 'ws://fake-door',
      proxies: [],
      pathBudget: 1_000,
      budgetWindowMs: 60_000,
      doorCapPerMin: 1_000,
      warmupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      quarantineJitterMs: 0,
    },
    log: () => {},
  });
  pool.start();
  setPoolForTest(pool);
  await nextTurn(); // let the fake door finish warming before the first postJson
}

/** kickToken's credit tokenInfo creates the row — the fake resolves immediately. */
function fakeProvider(): MarketDataProvider {
  return {
    name: 'fake-http-e2e',
    tokenInfo: async (ca: string, chain: Chain): Promise<TokenInfo> => ({
      ca,
      chain,
      price: 1,
      holders: 100,
      volume24h: 1_000,
      buyVol24h: 600,
      sellVol24h: 400,
      marketCap: 100_000,
      liquidity: 50_000,
      supply: 1_000_000_000,
      deployedAt: DEPLOYED_AT,
      symbol: 'TST',
    }),
    metric: async (): Promise<MetricPatch> => ({}),
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

/** Waits (bounded) until kickToken's upsert created every row — sync point, not an assertion. */
async function awaitRows(cas: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cas.every((ca) => getTokenState(ca, CHAIN) !== undefined)) {
    if (Date.now() > deadline) throw new Error('token_state rows never appeared');
    await nextTurn();
  }
}

function assertFilled(ca: string): void {
  const st = getTokenState(ca, CHAIN);
  assert.ok(st, `row ${ca} must exist`);
  assert.equal(st.t100_multiple, 1.5, `${ca} t100_multiple filled by the early pass`);
  assert.equal(st.genesis_bal, 120, `${ca} LF filled by the early pass`);
  assert.equal(st.anchor_at, DEPLOYED_AT, `${ca} genesis anchor filled by the early pass`);
}

interface TrackedCaJson {
  id: string;
  address: string;
  chain: string;
  note: string;
  addedAt: string;
  status: string;
}

let server: Server;
let base = '';

async function postTrackedCa(body: unknown): Promise<{ status: number; json: TrackedCaJson }> {
  const res = await fetch(`${base}/api/tracked-cas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SERVICE_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as TrackedCaJson };
}

before(async () => {
  open(dbFile); // TEMP db on disk — the DB_PATH config wiring, not :memory:
  loadSetupCache(); // binds SETUP_CACHE_FILE (index.ts's startup call)
  // series: leftmost 900 @ deploy, trough 600, latest 700 → multiple 1.5; exchange leftmost 120
  await installFakeDoor();
  const flows = installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]]), flowRows([[2, 120], [1, 130]]));
  setPollerDeps(fakeProvider(), null, flows); // startPoller's wiring, minus the sweeps
  server = createApp('test').listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('POST /api/tracked-cas fills setup through the real route without waiting for a sweep', async () => {
  // When: a user adds a CA over HTTP with the real body shape.
  const res = await postTrackedCa({ address: CA1, chain: CHAIN });

  // Then: the route contract — 201 + the inserted row as JSON.
  assert.equal(res.status, 201);
  assert.equal(res.json.address, CA1);
  assert.equal(res.json.chain, CHAIN);
  assert.equal(res.json.note, '');
  assert.equal(res.json.status, 'queued');
  assert.equal(typeof res.json.id, 'string');
  assert.equal(typeof res.json.addedAt, 'string');

  await awaitRows([CA1]); // kickToken created the row (sync point)
  await earlySetupIdle(); // the early pass chained on kickToken has finished

  // Ordering proof: refreshSeries no-ops without the row, so filled columns
  // mean the pass ran AFTER the row existed — reached VIA the HTTP route.
  assertFilled(CA1);
  assert.ok(getSetupCacheEntry(CA1, CHAIN), 'the pass persisted a file-cache entry');
  assert.equal(exchangeFetches, 1, 'one LF fetch for the added CA');
  assert.equal(flowsCalls, 2, 'one T100 and one LF, no redundant chart request');
  assert.equal(doorFetches, 0, 'the browser door is off the T100/LF path');
  assert.equal(maxActiveExchange, 1, 'no overlapping exchange fetches');
});

test('two concurrent POSTs: both CAs filled, the early passes stay serialized (paced, never a burst)', async () => {
  await installFakeDoor(); // fresh tripwire counters
  setPollerDeps(fakeProvider(), null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]]), flowRows([[2, 120], [1, 130]]))); // fresh counters

  const [r2, r3] = await Promise.all([
    postTrackedCa({ address: CA2, chain: CHAIN }),
    postTrackedCa({ address: CA3, chain: CHAIN }),
  ]);
  assert.equal(r2.status, 201);
  assert.equal(r3.status, 201);

  await awaitRows([CA2, CA3]);
  await earlySetupIdle();

  assertFilled(CA2);
  assertFilled(CA3);
  assert.equal(exchangeFetches, 2, 'one early pass per added CA');
  assert.equal(flowsCalls, 4, 'two official flows calls per CA, without duplicate chart requests');
  assert.equal(doorFetches, 0, 'the browser door is off the T100/LF path');
  assert.equal(maxActiveExchange, 1, 'the adds race, but their early passes never overlap');
});

test('re-add after a DB reset: the FILE cache entry the first HTTP add wrote absorbs everything — ZERO door fetches', async () => {
  // Given: the tables wiped (the reset the plan exists for) and the cache
  // reloaded from DISK — the entry test 1's HTTP add wrote, not in-memory state.
  getDb().prepare('DELETE FROM tracked_cas').run();
  getDb().prepare('DELETE FROM token_state').run();
  getDb().prepare('DELETE FROM nansen_series').run();
  loadSetupCache();
  await installFakeDoor(); // ANY fetch would be a regression (tripwire)
  setPollerDeps(fakeProvider(), null, installFakeFlows([], []));

  // When: the same CA is added again through the real route.
  const res = await postTrackedCa({ address: CA1, chain: CHAIN });
  assert.equal(res.status, 201);
  await awaitRows([CA1]);
  await earlySetupIdle();

  // Then: nothing was fetched anywhere, yet the columns are back.
  assert.equal(doorFetches, 0, 'a fresh file-cache entry must absorb the whole add');
  assert.equal(flowsCalls, 0, 'a fresh file-cache entry must absorb every official API call');
  assert.equal(exchangeFetches, 0);
  assertFilled(CA1);
});
