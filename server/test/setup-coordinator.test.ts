process.env.NANSEN_CRAWL = 'on';
process.env.POLL_SETUP_RETRY_MS = '1';
process.env.NEW_CA_PRIORITY_MS = '1000';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Chain } from '../src/shared/chain.js';
import type { SetupCacheEntry } from '../src/setup-cache.js';
import type { TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider, MetricPatch, TokenInfo, WalletTokenHolding } from '../src/providers/provider.js';
// Imports must follow env setup because config is captured when poller modules load.
// Dynamic imports intentionally isolate this node:test process's coordinator config.

const { open, getTokenState, insertTrackedCa } = await import('../src/db.js');
const { loadSetupCache, getSetupCacheEntry, getSetupRetry, putSetupCacheEntry } = await import('../src/setup-cache.js');
const { kickToken, kickNansen, refreshSeries, setPollerDeps } = await import('../src/poller.js');

const CHAIN: Chain = 'sol';
const DAY = 86_400_000;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function cacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'setup-coordinator-')), 'nansen-cache.json');
}

function tokenInfo(ca: string, deployedAt: number): TokenInfo {
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
    deployedAt,
    symbol: 'TST',
    nansenStats: { holders: 100, freshSupplyPct: 30 },
  };
}

function provider(deployedAt: number): MarketDataProvider {
  return {
    name: 'setup-coordinator-test',
    tokenInfo: async (ca: string): Promise<TokenInfo> => tokenInfo(ca, deployedAt),
    metric: async (): Promise<MetricPatch> => ({ nansenFreshPct: 30 }),
    walletTokenHoldings: async (): Promise<WalletTokenHolding[]> => [],
  };
}

function rows(now: number, totals: readonly number[] = [900, 600, 700]): TgmFlowsRow[] {
  return totals.map((token_amount, i) => ({
    date: new Date(now - (totals.length - i - 1) * DAY).toISOString(),
    token_amount,
    holders_count: 1,
  }));
}

function entry(ca: string, now: number, patch: Partial<SetupCacheEntry> = {}): SetupCacheEntry {
  return {
    ca,
    chain: CHAIN,
    taken_at: now,
    window: 'week',
    series_from: now - 7 * DAY,
    series: rows(now).map((row) => ({ t: row.date, total: row.token_amount })),
    exchange: [],
    t100_pct: 40,
    t100_multiple: 1.5,
    anchor_at: now - 2 * DAY,
    genesis_bal: undefined,
    series_at: now,
    ...patch,
  };
}

function seed(ca: string, deployedAt: number): void {
  insertTrackedCa({ address: ca, chain: CHAIN, note: '' });
  // This also creates the token_state row required for a series pass.
  const info = tokenInfo(ca, deployedAt);
  const { upsertTokenInfo } = ingest;
  upsertTokenInfo(info);
}

const ingest = await import('../src/ingest.js');

test('concurrent refreshSeries callers share one T100 and one LF request', async () => {
  open(':memory:');
  loadSetupCache(cacheFile());
  const ca = 'CA-COORD-CONCURRENT';
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  seed(ca, deployedAt);

  let t100Calls = 0;
  let lfCalls = 0;
  let entered!: () => void;
  const requestStarted = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const flows: TokenFlowsClient = {
    tokenFlows: async (request) => {
      if (request.label === 'exchange') {
        lfCalls += 1;
        return rows(now, [120, 125, 130]);
      }
      t100Calls += 1;
      entered();
      await blocked;
      return rows(now);
    },
  };
  setPollerDeps(provider(deployedAt), null, flows);

  const first = refreshSeries(ca, CHAIN);
  await requestStarted;
  const concurrent = refreshSeries(ca, CHAIN);
  await nextTurn();
  release();
  await Promise.all([first, concurrent]);

  assert.equal(t100Calls, 1, 'same-key refreshes must share the in-flight T100 request');
  assert.equal(lfCalls, 1, 'same-key refreshes must share the in-flight LF request');
  assert.equal(getTokenState(ca, CHAIN)?.genesis_bal, 120);
});

test('fresh T100 with missing LF fetches LF alone and fills consumer state', async () => {
  open(':memory:');
  loadSetupCache(cacheFile());
  const ca = 'CA-COORD-MISSING-LF';
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  seed(ca, deployedAt);
  putSetupCacheEntry(entry(ca, now, { info_at: now }));

  let t100Calls = 0;
  let lfCalls = 0;
  const flows: TokenFlowsClient = {
    tokenFlows: async (request) => {
      if (request.label === 'exchange') {
        lfCalls += 1;
        return rows(now, [120, 125, 130]);
      }
      t100Calls += 1;
      return rows(now);
    },
  };
  setPollerDeps(provider(deployedAt), null, flows);

  await refreshSeries(ca, CHAIN);

  assert.equal(t100Calls, 0, 'fresh T100 must not be re-bought to fill LF');
  assert.equal(lfCalls, 1, 'missing LF is independently fetched');
  assert.equal(getTokenState(ca, CHAIN)?.genesis_bal, 120);
  assert.ok(getSetupCacheEntry(ca, CHAIN)?.series_at, 'series freshness remains available after LF fill');
});

test('chart fallback and setup share a fetch whose result is reused by the next refresh', async () => {
  open(':memory:');
  loadSetupCache(cacheFile());
  const ca = 'CA-COORD-CHART-FALLBACK';
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  seed(ca, deployedAt);

  let t100Calls = 0;
  let lfCalls = 0;
  const flows: TokenFlowsClient = {
    tokenFlows: async (request) => {
      if (request.label === 'exchange') {
        lfCalls += 1;
        return rows(now, [120, 125, 130]);
      }
      t100Calls += 1;
      // Short initial range forces the chart-window fallback; the final response
      // includes deployment coverage and is then reusable from the cache.
      return t100Calls === 1 ? rows(now, [700]) : rows(now);
    },
  };
  setPollerDeps(provider(deployedAt), null, flows);

  kickNansen(ca, CHAIN);
  await refreshSeries(ca, CHAIN);
  const afterFirst = { t100Calls, lfCalls };
  await refreshSeries(ca, CHAIN);

  assert.ok(getSetupCacheEntry(ca, CHAIN), 'first-add refresh must persist its chart result');
  assert.deepEqual({ t100Calls, lfCalls }, afterFirst, 'a fresh cached first-add result costs no additional credits');
});

test('kickToken records info freshness when token info is obtained', async () => {
  open(':memory:');
  loadSetupCache(cacheFile());
  const ca = 'CA-COORD-KICK-TOKEN';
  const now = Date.now();
  setPollerDeps(provider(now - 2 * DAY), null, {
    tokenFlows: async () => [],
  });

  await kickToken(provider(now - 2 * DAY), ca, CHAIN);

  assert.ok(getTokenState(ca, CHAIN), 'kickToken obtains token state');
  assert.ok((getSetupCacheEntry(ca, CHAIN)?.info_at ?? 0) > 0, 'obtained info has a persisted freshness marker');
});

test('failed LF retries survive reload and do not re-buy a fresh T100 series', async () => {
  open(':memory:');
  const file = cacheFile();
  loadSetupCache(file);
  const ca = 'CA-COORD-LF-RETRY';
  const now = Date.now();
  seed(ca, now - 2 * DAY);
  putSetupCacheEntry(entry(ca, now, { info_at: now }));
  let t100Calls = 0;
  let lfCalls = 0;
  let available = false;
  setPollerDeps(provider(now - 2 * DAY), null, {
    tokenFlows: async (request) => {
      if (request.label !== 'exchange') {
        t100Calls += 1;
        return rows(now);
      }
      lfCalls += 1;
      return available ? rows(now, [120, 125, 130]) : [];
    },
  });
  await refreshSeries(ca, CHAIN);
  assert.equal(lfCalls, 1);
  assert.equal(getTokenState(ca, CHAIN)?.genesis_bal, null);
  loadSetupCache(file);
  await refreshSeries(ca, CHAIN);
  assert.equal(lfCalls, 1, 'restart must not reset a failed LF retry clock');
  available = true;
  const realNow = Date.now;
  const nextAt = getSetupRetry(ca, CHAIN, 'lf')?.nextAt;
  assert.notEqual(nextAt, undefined);
  Date.now = () => nextAt! + 1;
  try {
    await refreshSeries(ca, CHAIN);
  } finally {
    Date.now = realNow;
  }
  assert.equal(lfCalls, 2);
  assert.equal(t100Calls, 0, 'retry only LF, even after restart');
  assert.equal(getTokenState(ca, CHAIN)?.genesis_bal, 120);
});

test('a Fresh% obtained while series is in flight retains its freshness marker', async () => {
  open(':memory:');
  loadSetupCache(cacheFile());
  const ca = 'CA-COORD-INFO-RACE';
  const now = Date.now();
  seed(ca, now - 2 * DAY);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  setPollerDeps(provider(now - 2 * DAY), null, {
    tokenFlows: async (request) => {
      if (request.label === 'exchange') return rows(now, [120, 125, 130]);
      started();
      await held;
      return rows(now);
    },
  });
  const series = refreshSeries(ca, CHAIN);
  await entered;
  await kickToken(provider(now - 2 * DAY), ca, CHAIN);
  const obtainedAt = getSetupCacheEntry(ca, CHAIN)?.info_at;
  assert.notEqual(obtainedAt, undefined);
  release();
  await series;
  assert.equal(getSetupCacheEntry(ca, CHAIN)?.info_at, obtainedAt);
});

test('verified cache replay keeps a newer DB LF without repeating upstream reads', async () => {
  open(':memory:');
  loadSetupCache(cacheFile());
  const ca = 'CA-COORD-KNOWN-LF';
  const now = Date.now();
  seed(ca, now - 2 * DAY);
  ingest.updateTokenAnalytics(ca, CHAIN, { genesisBal: 121 });
  putSetupCacheEntry(entry(ca, now, { genesis_bal: 120, lf_rule: 'bucket-hour-v2' }));
  let calls = 0;
  setPollerDeps(provider(now - 2 * DAY), null, {
    tokenFlows: async () => { calls += 1; return []; },
  });
  await refreshSeries(ca, CHAIN);
  assert.equal(calls, 0);
  assert.equal(getTokenState(ca, CHAIN)?.genesis_bal, 121);
});

test('empty T100 backoff survives reload and clears when the retry succeeds', async () => {
  open(':memory:');
  const file = cacheFile();
  loadSetupCache(file);
  const ca = 'CA-COORD-SERIES-RETRY';
  const now = Date.now();
  seed(ca, now - 2 * DAY);
  ingest.updateTokenAnalytics(ca, CHAIN, { genesisBal: 120 });
  putSetupCacheEntry(entry(ca, now, {
    genesis_bal: 120, lf_rule: 'bucket-hour-v2',
    series: [], series_at: undefined, t100_pct: undefined, t100_multiple: undefined,
  }));
  let calls = 0;
  let available = false;
  setPollerDeps(provider(now - 2 * DAY), null, {
    tokenFlows: async () => { calls += 1; return available ? rows(now) : []; },
  });
  await refreshSeries(ca, CHAIN);
  assert.equal(getSetupCacheEntry(ca, CHAIN)?.series_at, undefined);
  const firstCalls = calls;
  assert.ok(firstCalls > 0);
  loadSetupCache(file);
  await refreshSeries(ca, CHAIN);
  assert.equal(calls, firstCalls, 'no repeat credit calls before persisted retry is due');
  const retry = getSetupRetry(ca, CHAIN, 'series');
  assert.ok(retry);
  available = true;
  const realNow = Date.now;
  Date.now = () => retry.nextAt + 1;
  try {
    await refreshSeries(ca, CHAIN);
  } finally {
    Date.now = realNow;
  }
  assert.equal(calls, firstCalls + 1);
  assert.equal(getSetupRetry(ca, CHAIN, 'series'), undefined);
  assert.equal(getTokenState(ca, CHAIN)?.t100_multiple, 1.5);
});
