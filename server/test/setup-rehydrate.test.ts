// Rehydrate / fill-on-add integration (plan setup-fill-on-add T3):
//   - ONE setup pass fills the derived columns AND writes the file cache
//   - a fresh entry survives a DB-table reset and rehydrates with ZERO fetches
//   - a fresh entry with no token_state row waits (never fetches) and applies later
//   - a stale entry (age >= POLL_SETUP_MS) refetches through the official
//     tgm/flows door and refreshes the file
//   - balanceSeries serves the FILE cache when nansen_series is empty
// T100/LF ride the official API (fake counting TokenFlowsClient); the browser
// door stays installed as a TRIPWIRE (any hourly-stats fetch = regression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { balanceSeries, DoorPool, setPoolForTest, type DoorConn, type DoorHttpResponse } from '../src/crawl.js';
import { getDb, getNansenSeries, getTokenState, open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { refreshSeries, setPollerDeps } from '../src/poller.js';
import { NANSEN_HOURLY_STATS_URL, type HourlyStatsRow, type TgmFlowsRow, type TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider } from '../src/providers/provider.js';
import {
  getSetupCacheEntry,
  loadSetupCache,
  putSetupCacheEntry,
  type SetupCacheEntry,
} from '../src/setup-cache.js';

const CA = 'CA-SETUP-FILL';
const CHAIN = 'sol' as const;
const DAY = 86_400_000;

let doorFetches = 0;
let flowsCalls = 0;

function flowRows(points: readonly (readonly [ageDays: number, total: number])[], now: number): TgmFlowsRow[] {
  return points.map(([ageDays, total]) => ({ date: new Date(now - ageDays * DAY).toISOString(), token_amount: total, holders_count: 1 }));
}

function okJson(data: HourlyStatsRow[]): DoorHttpResponse {
  return { status: 200, contentType: 'application/json', retryAfter: null, head: '', len: 2, json: { data }, threw: false };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Counting fake of the official tgm/flows client — one call = one API request. */
function installFakeFlows(series: TgmFlowsRow[], exchange: TgmFlowsRow[]): TokenFlowsClient {
  flowsCalls = 0;
  const client: TokenFlowsClient = {
    tokenFlows: async (req) => {
      flowsCalls += 1;
      return req.label === 'exchange' ? exchange : series;
    },
  };
  setPollerDeps(stubProvider, null, client);
  return client;
}

const stubProvider: MarketDataProvider = {
  name: 'stub-rehydrate',
  tokenInfo: async () => {
    throw new Error('unused');
  },
  metric: async () => ({}),
  walletTokenHoldings: async () => [],
};

/** Tripwire door: the prod T100/LF path must never touch the browser door again. */
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
  await nextTurn(); // let the fake door finish warming before the first postJson
}

function tempCacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'setup-rehydrate-')), 'nansen-cache.json');
}

/** The essential sweep / kickToken creates the bare row (updateTokenAnalytics is an UPDATE). */
function seedTokenRow(deployedAt: number): void {
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
}

/** A fresh cache entry as an earlier life of the system would have written it. */
function sampleEntry(now: number, deployedAt: number): SetupCacheEntry {
  return {
    ca: CA,
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
    lf_rule: 'bucket-hour-v2',
    genesis_bal: 120,
    info_at: now - 60_000,
    series_at: now - 60_000,
  };
}

test('fill-on-add: ONE setup pass fills the derived columns AND writes the file cache', async () => {
  const file = tempCacheFile();
  open(':memory:');
  loadSetupCache(file);
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  seedTokenRow(deployedAt);
  // series: leftmost 900 @ deploy, trough 600, latest 700 → pct 33.33, multiple 1.5
  await installFakeDoor();
  installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now));

  await refreshSeries(CA, CHAIN);

  const st = getTokenState(CA, CHAIN);
  assert.ok(st, 'the seeded row must exist');
  assert.equal(st.t100_multiple, 1.5);
  assert.ok(Math.abs((st.t100_pct ?? 0) - 100 / 3) < 1e-9, `t100_pct=${st.t100_pct}`);
  assert.equal(st.genesis_bal, 120, 'LF = the exchange chart leftmost');
  assert.equal(st.anchor_at, deployedAt);
  assert.equal(flowsCalls, 2, 'one T100 primary + one exchange tgm/flows call');
  assert.equal(doorFetches, 0, 'the browser door is off the T100/LF path');
  const e = getSetupCacheEntry(CA, CHAIN);
  assert.ok(e, 'the pass must persist a file-cache entry');
  assert.equal(e.series.length, 3);
  assert.equal(e.exchange.length, 2);
  assert.equal(e.window, '1W', 'a 2-day-old token needs a single 7-day chunk');
  assert.equal(e.series_from, deployedAt, 'the deploy-anchored window start');
  assert.equal(e.t100_multiple, 1.5);
  assert.equal(e.genesis_bal, 120);
  assert.ok(getNansenSeries(CA, CHAIN, 'week').length >= 3, 'chart rows replayed into nansen_series');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] };
  assert.equal(raw.entries.length, 1, 'the entry reached disk');
});

test('rehydrate: after a table reset, a fresh entry restores columns + chart rows with ZERO door fetches', async () => {
  const file = tempCacheFile();
  open(':memory:');
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  // Given a fresh entry written by an earlier life of the system
  loadSetupCache(file);
  putSetupCacheEntry(sampleEntry(now, deployedAt));
  // When the tables are wiped (the reset the plan exists for) and startup reloads the file
  getDb().prepare('DELETE FROM nansen_series').run();
  getDb().prepare('DELETE FROM token_state').run();
  loadSetupCache(file);
  seedTokenRow(deployedAt); // the essential sweep re-creates the bare row
  await installFakeDoor(); // ANY door fetch would be a regression (tripwire)
  installFakeFlows([], []); // ANY flows call would also be visible: empty series

  await refreshSeries(CA, CHAIN);

  // Then the derived columns are back, the chart replayed, the door untouched
  assert.equal(doorFetches, 0, 'a fresh file-cache entry must skip the browser door entirely');
  assert.equal(flowsCalls, 0, 'a fresh file-cache entry must skip the official API too');
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 1.5);
  assert.equal(st.t100_pct, 33.33);
  assert.equal(st.genesis_bal, 120);
  assert.equal(st.anchor_at, deployedAt);
  assert.ok(getNansenSeries(CA, CHAIN, 'week').length >= 3, 'cached windows replayed into nansen_series');
});

test('rehydrate waits: a fresh entry with NO token_state row applies nothing and never fetches', async () => {
  const file = tempCacheFile();
  open(':memory:');
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  loadSetupCache(file);
  putSetupCacheEntry(sampleEntry(now, deployedAt));
  await installFakeDoor();
  installFakeFlows([], []);

  await refreshSeries(CA, CHAIN); // no row yet — the essential sweep has not run

  assert.equal(doorFetches, 0, 'while a fresh entry exists the door must never be fetched');
  assert.equal(flowsCalls, 0, 'while a fresh entry exists the official API must never be called');
  assert.equal(getTokenState(CA, CHAIN), undefined);

  seedTokenRow(deployedAt); // the row appears (essential sweep / kickToken)
  await refreshSeries(CA, CHAIN);

  assert.equal(doorFetches, 0);
  assert.equal(flowsCalls, 0);
  assert.equal(getTokenState(CA, CHAIN)?.t100_multiple, 1.5, 'the still-fresh entry applies on the later pass');
});

test('stale entry: age >= POLL_FLOWS_MS refetches the series and refreshes the file', async () => {
  const file = tempCacheFile();
  open(':memory:');
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  seedTokenRow(deployedAt);
  loadSetupCache(file);
  putSetupCacheEntry({
    ...sampleEntry(now, deployedAt),
    taken_at: now - config.pollFlowsMs - 1_000,
    series_at: now - config.pollFlowsMs - 1_000,
  });
  await installFakeDoor();
  installFakeFlows(flowRows([[2, 900], [1, 600], [0, 700]], now), flowRows([[2, 120], [1, 130]], now));

  await refreshSeries(CA, CHAIN);

  assert.equal(flowsCalls, 1, 'refresh T100 without re-buying the cached LF anchor');
  assert.equal(doorFetches, 0, 'the browser door is off the T100/LF path');
  const e = getSetupCacheEntry(CA, CHAIN);
  assert.ok(e);
  assert.ok(e.taken_at > now - config.pollSetupMs, 'the entry was refreshed');
  assert.equal(e.t100_multiple, 1.5);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: { t100_multiple: number }[] };
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0]?.t100_multiple, 1.5);
});

test('balanceSeries: serves the FILE cache when nansen_series is empty and the entry is fresh', async () => {
  const file = tempCacheFile();
  open(':memory:');
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  loadSetupCache(file);
  putSetupCacheEntry(sampleEntry(now, deployedAt));
  await installFakeDoor();
  installFakeFlows([], []);

  const out = await balanceSeries(CA, CHAIN, 'week');

  assert.equal(out.source, 'nansen');
  assert.equal(out.points.length, 3);
  assert.equal(doorFetches, 0, 'the fallback replays the file cache — no door, no snapshot degradation');
  assert.equal(flowsCalls, 0, 'the fallback replays the file cache — no official API call');
  assert.ok(getNansenSeries(CA, CHAIN, 'week').length >= 3, 'the replay filled nansen_series');
});

test('chart replay uses series freshness and timestamp, not a later Fresh% stamp', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  const seriesAt = now - (config.pollSetupMs + config.pollFlowsMs) / 2;
  const deployedAt = seriesAt - 2 * DAY;
  seedTokenRow(deployedAt);
  putSetupCacheEntry({
    ...sampleEntry(seriesAt, deployedAt),
    taken_at: now,
    info_at: now,
    series_at: seriesAt,
  });
  installFakeFlows([], []);
  const out = await balanceSeries(CA, CHAIN, 'week');
  await refreshSeries(CA, CHAIN);
  assert.equal(out.source, 'nansen');
  assert.equal(out.cachedAt, seriesAt, 'Fresh% must not reset the chart fetch clock');
  assert.equal(flowsCalls, 0, 'the series remains inside its own TTL');
  assert.equal(getTokenState(CA, CHAIN)?.genesis_bal, 120);
});
