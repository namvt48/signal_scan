// User 2026-09-23: a CA keeps being queried for setup (fresh% / T100 / LF /
// series) until it is FULLY populated — only then does it enter the 12h cadence —
// and a CA that keeps coming back EMPTY (brand-new token, no data yet) backs off
// instead of being hammered on every pass.
// Env BEFORE the src imports (node:test = one process per file). POLL_SETUP_MS
// stays 1min so a just-written cache entry is still 'fresh' for the whole test.
process.env.NANSEN_CRAWL = 'on';
process.env.POLL_SETUP_MS = '60000';
process.env.POLL_SETUP_RETRY_MS = '1000';
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

const { open, insertTrackedCa, getTokenState } = await import('../src/db.js');
const { upsertTokenInfo, updateTokenAnalytics, updateTokenMetrics } = await import('../src/ingest.js');
const { loadSetupCache, getSetupCacheEntry, putSetupCacheEntry } = await import('../src/setup-cache.js');
const { DoorPool, setPoolForTest } = await import('../src/crawl.js');
const { setPollerDeps, setupSweep } = await import('../src/poller.js');

const CHAIN: Chain = 'sol';
const DONE = 'CA-RETRY-DONE';
const TODO = 'CA-RETRY-TODO';
const EMPTY = 'CA-RETRY-EMPTY';
const FRESH_INCOMPLETE = 'CA-RETRY-FRESH-INCOMPLETE';
const DAY = 86_400_000;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[], now: number): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(now - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fake of the official tgm/flows client feeding the T100/LF path. */
function installFakeFlows(series: TgmFlowsRow[], exchange: TgmFlowsRow[]): TokenFlowsClient {
  return { tokenFlows: async (req) => (req.label === 'exchange' ? exchange : series) };
}

/** Tripwire door — the T100/LF path must never fetch through it (returns empty). */
async function installFakeDoor(): Promise<void> {
  const conn: DoorConn = {
    fetch: async () => okJson([]),
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
  await nextTurn();
}

function info(ca: string, now: number): TokenInfo {
  return {
    ca,
    chain: CHAIN,
    price: 1,
    holders: 100,
    volume24h: 1_000,
    buyVol24h: 600,
    sellVol24h: 400,
    marketCap: 100_000,
    liquidity: 50_000,
    supply: 1_000_000_000,
    deployedAt: now - 2 * DAY,
    symbol: 'TST',
  };
}

function countingProvider(now: number, metricCalls: Map<string, number>): MarketDataProvider {
  return {
    name: 'fake-setup-retry',
    tokenInfo: async (ca: string): Promise<TokenInfo> => info(ca, now),
    metric: async (ca: string): Promise<MetricPatch> => {
      metricCalls.set(ca, (metricCalls.get(ca) ?? 0) + 1);
      return { nansenFreshPct: 30 };
    },
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

test('setup retry: missing setup is re-queried every pass; a COMPLETE CA sits on the 12h cache', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-retry-')), 'nansen-cache.json'));
  const now = Date.now();
  // series leftmost 900 → trough 600, latest 700 (multiple 1.5); exchange leftmost 120.
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls);
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: DONE, chain: CHAIN, note: '' });
  insertTrackedCa({ address: TODO, chain: CHAIN, note: '' });
  upsertTokenInfo(info(DONE, now));
  upsertTokenInfo(info(TODO, now));

  // DONE: all setup fields present + a FRESH cache entry.
  updateTokenMetrics(DONE, CHAIN, { nansenFreshPct: 30 });
  updateTokenAnalytics(DONE, CHAIN, { t100Pct: 40, t100Multiple: 1.5, genesisBal: 120, anchorAt: now, bal: { d1: { peak: 1, trough: 0 } } });
  putSetupCacheEntry({
    ca: DONE,
    chain: CHAIN,
    taken_at: now,
    window: 'week',
    series_from: now - 7 * DAY,
    series: [{ t: new Date(now - DAY).toISOString(), total: 700 }],
    exchange: [{ t: new Date(now - DAY).toISOString(), total: 120 }],
    t100_pct: 40,
    t100_multiple: 1.5,
    anchor_at: now,
    genesis_bal: 120,
    info_at: now,
    series_at: now,
  });

  await setupSweep(provider);
  assert.equal(metricCalls.get(DONE) ?? 0, 0, 'COMPLETE + fresh cache: must NOT be re-queried (12h cadence)');
  assert.equal(metricCalls.get(TODO), 1, 'INCOMPLETE setup: must be re-queried');
  assert.ok(getSetupCacheEntry(TODO, CHAIN), 'the retry must actually fetch + cache the missing setup');
  assert.ok(getTokenState(TODO, CHAIN)?.t100_multiple != null, 'and write T100 into the row');

  await setupSweep(provider);
  assert.equal(metricCalls.get(TODO), 1, 'now complete → on the 12h cadence, no further retry');
});

test('setup TTL authoritative: a FRESH cache entry with an INCOMPLETE row is NOT re-asked', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-fresh-incomplete-')), 'nansen-cache.json'));
  const now = Date.now();
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls);
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  insertTrackedCa({ address: FRESH_INCOMPLETE, chain: CHAIN, note: '' });
  upsertTokenInfo(info(FRESH_INCOMPLETE, now)); // creates the row; NO fresh%/t100/LF yet
  putSetupCacheEntry({
    ca: FRESH_INCOMPLETE,
    chain: CHAIN,
    taken_at: now,
    window: 'week',
    series_from: now - 7 * DAY,
    series: [{ t: new Date(now - DAY).toISOString(), total: 700 }],
    exchange: [{ t: new Date(now - DAY).toISOString(), total: 120 }],
    t100_pct: 40,
    t100_multiple: 1.5,
    anchor_at: now,
    genesis_bal: 120,
    info_at: now,
    series_at: now,
  });

  // Precondition: the row really IS incomplete (no T100/LF) — otherwise the
  // old re-ask-every-pass rule would not have queried it either.
  assert.equal(getTokenState(FRESH_INCOMPLETE, CHAIN)?.t100_multiple, null);
  assert.equal(getTokenState(FRESH_INCOMPLETE, CHAIN)?.genesis_bal, null);

  await setupSweep(provider);
  assert.equal(metricCalls.get(FRESH_INCOMPLETE) ?? 0, 0, 'a FRESH cache entry means no setup — even when the row is still incomplete');
});

test('setup spam guard: a CA whose setup keeps coming back EMPTY backs off after one attempt', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-retry-empty-')), 'nansen-cache.json'));
  const now = Date.now();
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls);
  setPollerDeps(provider, null, installFakeFlows([], [])); // brand-new token: Nansen has no flows yet
  insertTrackedCa({ address: EMPTY, chain: CHAIN, note: '' });
  upsertTokenInfo(info(EMPTY, now));

  await setupSweep(provider);
  assert.equal(metricCalls.get(EMPTY), 1, 'first attempt happens');
  // 2026-09-29: the empty pass DOES write an entry (the markers need a container) but
  // stamps no marker, so the CA still owes its data — the backoff below must hold.
  const emptyEntry = getSetupCacheEntry(EMPTY, CHAIN);
  assert.notEqual(emptyEntry, undefined, 'the empty pass records an entry');
  assert.equal(emptyEntry?.series_at, undefined, 'nothing was obtained, so no series marker');
  assert.equal(emptyEntry?.info_at, undefined, 'and no gini marker');

  await setupSweep(provider);
  assert.equal(metricCalls.get(EMPTY), 1, 'empty CA must NOT be hammered on the next pass (backoff)');
});
