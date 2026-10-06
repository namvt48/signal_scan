// Fix C regression (2026-09-29): a cold setup cache must TRICKLE, not burst. With
// SETUP_PASS_CAP=1 and 3 tracked CAs needing setup, ONE setupSweep may query exactly
// ONE CA; the next sweep picks up the next one. Env BEFORE the src imports
// (node:test = one process per file).
process.env.NANSEN_CRAWL = 'on';
process.env.POLL_SETUP_MS = '60000';
process.env.POLL_SETUP_RETRY_MS = '1000';
process.env.NEW_CA_PRIORITY_MS = '1000';
process.env.SETUP_PASS_CAP = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoorConn, DoorHttpResponse } from '../src/crawl.js';
import type { HourlyStatsRow, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider, MetricPatch, TokenInfo, WalletTokenHolding } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';

const { getDb, getTokenState, open, insertTrackedCa } = await import('../src/db.js');
const { upsertTokenInfo, updateTokenMetrics } = await import('../src/ingest.js');
const { getSetupCacheEntry, loadSetupCache, setupCacheSize, stampSetupCacheField } = await import('../src/setup-cache.js');
const { DoorPool, setPoolForTest } = await import('../src/crawl.js');
const { setPollerDeps, setupSweep } = await import('../src/poller.js');

const CHAIN: Chain = 'sol';
const CA1 = 'CA-CAP-1';
const CA2 = 'CA-CAP-2';
const CA3 = 'CA-CAP-3';
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
    name: 'fake-setup-pass-cap',
    tokenInfo: async (ca: string): Promise<TokenInfo> => info(ca, now),
    metric: async (ca: string): Promise<MetricPatch> => {
      metricCalls.set(ca, (metricCalls.get(ca) ?? 0) + 1);
      return { nansenFreshPct: 30 };
    },
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

test('setup pass cap: a cold cache with 3 CAs queries exactly 1 per sweep (cap=1), the next sweep the next', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-pass-cap-')), 'nansen-cache.json'));
  const now = Date.now();
  await installFakeDoor();
  const metricCalls = new Map<string, number>();
  const provider = countingProvider(now, metricCalls);
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  for (const ca of [CA1, CA2, CA3]) {
    insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
    upsertTokenInfo(info(ca, now));
  }

  const total = (): number => [...metricCalls.values()].reduce((n, v) => n + v, 0);

  await setupSweep(provider);
  assert.equal(total(), 1, 'the cap must bound a cold-cache pass to ONE CA');
  assert.equal(setupCacheSize(), 1, 'the capped pass wrote exactly one fresh cache entry');

  await setupSweep(provider);
  assert.equal(total(), 2, 'the next sweep queries the next CA (the first is parked on its fresh entry)');
  assert.equal(setupCacheSize(), 2);
});

test('capped refresh picks the oldest expired Fresh result, not the newest tracked CA repeatedly', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-refresh-fair-')), 'nansen-cache.json'));
  const now = Date.now();
  const calls = new Map<string, number>();
  const provider = countingProvider(now, calls);
  setPollerDeps(provider, null, installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now)));
  for (const [ca, age] of [['old-stale', 300_000], ['new-stale', 120_000], ['series-only', 60_000]] as const) {
    insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
    getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(new Date(now - age).toISOString(), ca);
    upsertTokenInfo(info(ca, now));
    stampSetupCacheField(ca, CHAIN, 'info_at', ca === 'series-only' ? now : now - age);
    updateTokenMetrics(ca, CHAIN, { nansenFreshPct: 10 });
    stampSetupCacheField(ca, CHAIN, 'series_at', now);
  }
  await setupSweep(provider);
  assert.equal(getTokenState('old-stale', CHAIN)?.nansen_fresh_pct, 30, 'the older Fresh result must refresh before the newer one');
  assert.equal(calls.get('new-stale'), undefined, 'cap still limits the pass to one CA');
  assert.equal(calls.get('series-only'), undefined, 'Fresh-not-due series/LF debt must not take the capped Fresh slot');
  const realNow = Date.now;
  Date.now = () => now + 60_000; // Even the just-refreshed prefix is due again at the next cadence.
  try {
    await setupSweep(provider);
  } finally {
    Date.now = realNow;
  }
  assert.equal(getTokenState('new-stale', CHAIN)?.nansen_fresh_pct, 30, 'the next overdue CA progresses instead of being starved');
  assert.equal(calls.get('old-stale'), 1, 'the prior selection cannot monopolize subsequent passes');
});

test('both Fresh and series/LF debt progress when each pass crosses the Fresh TTL', async () => {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'setup-mixed-fair-')), 'cache.json'));
  const start = Date.now();
  const calls = new Map<string, number>();
  const provider = countingProvider(start, calls);
  const seriesCalls: string[] = [];
  const flows = installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], start), flowRows([[2, 120], [1, 130]], start));
  setPollerDeps(provider, null, { tokenFlows: async (req) => {
    seriesCalls.push(req.token_address);
    return flows.tokenFlows(req);
  } });
  for (const ca of ['fresh-debt', 'series-debt']) {
    insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
    upsertTokenInfo(info(ca, start));
    updateTokenMetrics(ca, CHAIN, { nansenFreshPct: 10 });
    stampSetupCacheField(ca, CHAIN, 'info_at', start - 120_000);
    if (ca === 'fresh-debt') stampSetupCacheField(ca, CHAIN, 'series_at', start);
  }
  const realNow = Date.now;
  try {
    for (let pass = 0; pass < 4; pass++) {
      const now = start + pass * DAY; // Both Fresh and series TTLs expire between passes.
      Date.now = () => now;
      // Incoming gini reads keep this CA's Fresh current while its other fields remain due.
      stampSetupCacheField('series-debt', CHAIN, 'info_at', now);
      await setupSweep(provider);
      if (pass === 1) {
        assert.ok(seriesCalls.includes('series-debt'), 'series/LF cannot wait behind permanent Fresh debt');
        assert.notEqual(getTokenState('series-debt', CHAIN)?.genesis_bal, null);
      }
    }
    assert.equal(getTokenState('fresh-debt', CHAIN)?.nansen_fresh_pct, 30);
    assert.ok((calls.get('fresh-debt') ?? 0) >= 2, 'Fresh continues progressing across TTL crossings');
    assert.equal(getSetupCacheEntry('series-debt', CHAIN)?.series_at, start + 3 * DAY, 'series continues refreshing after its own TTL expires again');
  } finally {
    Date.now = realNow;
  }
});
