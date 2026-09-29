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

const { open, insertTrackedCa } = await import('../src/db.js');
const { upsertTokenInfo } = await import('../src/ingest.js');
const { loadSetupCache, setupCacheSize } = await import('../src/setup-cache.js');
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
