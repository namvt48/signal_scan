// LF write-once credit guard: once genesis_bal is known AND the setup cache
// carries exchange points, a series pass must NOT re-ask the 1-credit
// label='exchange' tgm/flows endpoint — the leftmost is a deterministic read at
// a fixed window, so a repeat buys nothing. The cached points must be carried
// into the re-stored entry (isStorable refuses an empty `exchange`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { DoorPool, setPoolForTest, type DoorConn, type DoorHttpResponse } from '../src/crawl.js';
import { getTokenState, open } from '../src/db.js';
import { updateTokenAnalytics, updateTokenMetrics } from '../src/ingest.js';
import { refreshSeries, setPollerDeps } from '../src/poller.js';
import { NANSEN_HOURLY_STATS_URL, type HourlyStatsRow, type TgmFlowsRow, type TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider } from '../src/providers/provider.js';
import { getSetupCacheEntry, loadSetupCache, putSetupCacheEntry, type SetupCacheEntry } from '../src/setup-cache.js';

const CA = 'CA-LF-WRITE-ONCE';
const CHAIN = 'sol' as const;
const DAY = 86_400_000;

let doorFetches = 0;
let exchangeCalls = 0;
let seriesCalls = 0;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[], now: number): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(now - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const stubProvider: MarketDataProvider = {
  name: 'stub-lf-write-once',
  tokenInfo: async () => {
    throw new Error('unused');
  },
  metric: async () => ({}),
  walletTokenHoldings: async () => [],
};

/** Label-counting fake: exchange = LF (1 credit each), anything else = the T100 series. */
function installFakeFlows(series: TgmFlowsRow[]): void {
  exchangeCalls = 0;
  seriesCalls = 0;
  const client: TokenFlowsClient = {
    tokenFlows: async (req) => {
      if (req.label === 'exchange') exchangeCalls += 1;
      else seriesCalls += 1;
      return series;
    },
  };
  setPollerDeps(stubProvider, null, client);
}

/** Tripwire door: the T100/LF path must never touch the browser door. */
async function installFakeDoor(): Promise<void> {
  doorFetches = 0;
  const conn: DoorConn = {
    fetch: async (url) => {
      if (url === NANSEN_HOURLY_STATS_URL) doorFetches += 1;
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
  await nextTurn();
}

/** A stale entry carrying a known LF — the state the write-once guard exists for. */
function staleEntryWithLf(now: number, deployedAt: number): SetupCacheEntry {
  return {
    ca: CA,
    chain: CHAIN,
    taken_at: now - config.pollFlowsMs - 1_000,
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

test('LF write-once: known genesis_bal + cached exchange points -> series refetch, ZERO exchange calls', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lf-write-once-')), 'nansen-cache.json');
  open(':memory:');
  loadSetupCache(file);
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  updateTokenAnalytics(CA, CHAIN, { genesisBal: 120 });
  putSetupCacheEntry(staleEntryWithLf(now, deployedAt));
  await installFakeDoor();
  installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now));

  await refreshSeries(CA, CHAIN);

  // The stale entry forces the series refetch; the write-once guard skips the LF.
  assert.equal(seriesCalls, 1, 'the stale entry must refetch the T100 series');
  assert.equal(exchangeCalls, 0, 'a known genesis_bal + cached exchange must never re-ask the 1-credit LF');
  assert.equal(doorFetches, 0, 'the browser door stays off this path');
  // genesis_bal survives the pass untouched.
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.genesis_bal, 120);
  // The pass re-stores a FRESH entry whose exchange carries the cached points —
  // isStorable refuses an empty exchange, so an empty carry would stall the sweep.
  const e = getSetupCacheEntry(CA, CHAIN);
  assert.ok(e, 'the pass must persist a refreshed entry');
  assert.ok(e.taken_at > now - config.pollSetupMs, 'the entry was refreshed');
  assert.ok(e.exchange.length > 0, 'cached exchange points carried into the re-stored entry');
  assert.equal(e.exchange[0]?.total, 120);
  assert.equal(e.genesis_bal, 120);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: { exchange: unknown[] }[] };
  assert.equal(raw.entries.length, 1, 'the carried entry reached disk');
  assert.ok((raw.entries[0]?.exchange ?? []).length > 0);
});

test('LF still fetched while genesis_bal is unknown (first pass keeps working)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lf-write-once2-')), 'nansen-cache.json');
  open(':memory:');
  loadSetupCache(file);
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  await installFakeDoor();
  installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now));

  await refreshSeries(CA, CHAIN);

  // No genesis_bal yet: the guard must NOT suppress the initial LF fetch.
  assert.equal(seriesCalls, 1);
  assert.equal(exchangeCalls, 1, 'the first pass must fetch the LF');
  assert.equal(getTokenState(CA, CHAIN)?.genesis_bal, 900, 'LF = the series leftmost (deploy-clamped)');
});
