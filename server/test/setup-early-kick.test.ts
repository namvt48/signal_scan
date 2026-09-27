// T4 early setup trigger (plan setup-fill-on-add):
//   - N CAs added in one kickCAs call each get exactly ONE early refreshSeries pass,
//     AFTER their token_state row exists (filled columns are the ordering proof:
//     refreshSeries no-ops without the row, so nothing could fill them earlier)
//   - the passes are paced, never a burst: serialized (max 1 exchange flows call in
//     flight) and counted — exactly 3 official tgm/flows calls (T100 primary +
//     the extra daily T100 series + exchange) per CA on top of the kickNansen T100
//     call (ONE: it runs before the row exists, so its unanchored 7d window fails
//     the reach guard against the 2-day-old fake series — no extra daily call)
//   - a CA whose fresh file-cache entry already exists costs 0 flows calls
// The browser door stays installed as a TRIPWIRE: the T100/LF path must never
// touch it again (official API since 2026-09-23).
// Env BEFORE the src imports: crawlEnabled gates the trigger, and the queue-jump
// window is shrunk so pacedFor slots are test-sized (assertions are on COUNTS,
// never on wall-clock sleeps). node:test = one process per file, so this is safe.
process.env.NANSEN_CRAWL = 'on';
process.env.NEW_CA_PRIORITY_MS = '1000';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoorConn, DoorHttpResponse } from '../src/crawl.js';
import type { HourlyStatsRow, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider, MetricPatch, TokenInfo, WalletTokenHolding } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';
import type { SetupCacheEntry } from '../src/setup-cache.js';

const { open, getTokenState } = await import('../src/db.js');
const { loadSetupCache, putSetupCacheEntry } = await import('../src/setup-cache.js');
const { DoorPool, setPoolForTest } = await import('../src/crawl.js');
const { kickCAs, setPollerDeps, earlySetupIdle } = await import('../src/poller.js');
const { NANSEN_HOURLY_STATS_URL } = await import('../src/providers/nansen.js');

const CHAIN: Chain = 'sol';
const CA1 = 'CA-EARLY-1';
const CA2 = 'CA-EARLY-2';
const DAY = 86_400_000;

let doorFetches = 0;
let flowsCalls = 0;
let exchangeFetches = 0;
let activeExchange = 0;
let maxActiveExchange = 0;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[], now: number): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(now - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Counting fake of the official tgm/flows client; tracks exchange-call overlap. */
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

function tempCacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'setup-early-kick-')), 'nansen-cache.json');
}

/** kickToken's credit tokenInfo creates the row — the fake resolves immediately. */
function fakeProvider(deployedAt: number): MarketDataProvider {
  return {
    name: 'fake-early-kick',
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
      deployedAt,
      symbol: 'TST',
    }),
    metric: async (): Promise<MetricPatch> => ({}),
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

function sampleEntry(ca: string, now: number, deployedAt: number): SetupCacheEntry {
  return {
    ca,
    chain: CHAIN,
    taken_at: now - 60_000,
    window: 'week',
    series_from: deployedAt,
    series: [
      { t: new Date(deployedAt).toISOString(), total: 900 },
      { t: new Date(now - DAY).toISOString(), total: 600 },
      { t: new Date(now).toISOString(), total: 700 },
    ],
    exchange: [{ t: new Date(deployedAt).toISOString(), total: 120 }],
    t100_pct: 33.33,
    t100_multiple: 1.5,
    anchor_at: deployedAt,
    genesis_bal: 120,
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

function assertFilled(ca: string, deployedAt: number): void {
  const st = getTokenState(ca, CHAIN);
  assert.ok(st, `row ${ca} must exist`);
  assert.equal(st.t100_multiple, 1.5, `${ca} t100_multiple filled by the early pass`);
  assert.equal(st.genesis_bal, 120, `${ca} LF filled by the early pass`);
  assert.equal(st.anchor_at, deployedAt, `${ca} genesis anchor filled by the early pass`);
}

test('early kick: 2 CAs in one call → ONE paced setup pass each, after the row exists', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  // series: leftmost 900 @ deploy, trough 600, latest 700 → multiple 1.5; exchange leftmost 120
  await installFakeDoor();
  const flows = installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now));
  setPollerDeps(fakeProvider(deployedAt), null, flows);

  kickCAs([
    { address: CA1, chain: CHAIN },
    { address: CA2, chain: CHAIN },
  ]);
  await awaitRows([CA1, CA2]);
  await earlySetupIdle();

  // Ordering proof: refreshSeries no-ops when the row is missing, so filled
  // columns mean the pass ran strictly AFTER kickToken/upsertTokenInfo.
  assertFilled(CA1, deployedAt);
  assertFilled(CA2, deployedAt);
  // Counts, not sleeps: exactly one early pass per CA (exchange is fetched ONLY
  // by refreshSeries), plus the pre-existing kickNansen T100 call — 3 per CA.
  assert.equal(exchangeFetches, 2, 'exactly one early setup pass per CA');
  assert.equal(flowsCalls, 6, '2 early-pass calls + 1 kickNansen T100 call per CA, nothing more');
  assert.equal(doorFetches, 0, 'the browser door is off the T100/LF path');
  assert.equal(maxActiveExchange, 1, 'early passes never overlap — paced, not a burst');
});

test('early kick: a fresh file-cache entry costs ZERO door fetches', async () => {
  open(':memory:');
  const file = tempCacheFile();
  loadSetupCache(file);
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  putSetupCacheEntry(sampleEntry(CA1, now, deployedAt));
  putSetupCacheEntry(sampleEntry(CA2, now, deployedAt));
  await installFakeDoor(); // ANY fetch would be a regression (tripwire)
  setPollerDeps(fakeProvider(deployedAt), null, installFakeFlows([], []));

  kickCAs([
    { address: CA1, chain: CHAIN },
    { address: CA2, chain: CHAIN },
  ]);
  await awaitRows([CA1, CA2]);
  await earlySetupIdle();

  assert.equal(doorFetches, 0, 'fresh cache entries must absorb both early passes AND kickNansen');
  assert.equal(flowsCalls, 0, 'fresh cache entries must absorb every official API call');
  assert.equal(exchangeFetches, 0);
  assertFilled(CA1, deployedAt);
  assertFilled(CA2, deployedAt);
});
