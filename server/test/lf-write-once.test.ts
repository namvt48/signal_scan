// LF credit guard: reuse a verified anchor at the same upstream resolution,
// but repair legacy values and re-anchor once hourly data becomes daily.
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
import { getSetupCacheEntry, loadSetupCache, putSetupCacheEntry } from '../src/setup-cache.js';
import type { SetupCacheEntry } from '../src/setup-cache.js';

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
    lf_rule: 'bucket-hour-v2',
    genesis_bal: 120,
    info_at: now - config.pollFlowsMs - 1_000,
    series_at: now - config.pollFlowsMs - 1_000,
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

const SI_DEPLOYED_AT = Date.parse('2026-09-21T15:44:55.000Z');
const SI_NOW = Date.parse('2026-10-05T09:00:00.000Z');
const SI_DAILY_LF = 58_804_652.770357996;
const SI_HOURLY_LF = 3_059_728.920552999;
const HOUR = 3_600_000;
const SI_DAILY_ROWS: TgmFlowsRow[] = [
  { date: '2026-09-21T00:00:00.000Z', token_amount: SI_DAILY_LF },
  { date: '2026-09-22T00:00:00.000Z', token_amount: 84_107_630.47038598 },
  { date: '2026-09-23T00:00:00.000Z', token_amount: 27_714_941.616504 },
];

function seedBucketCase(now: number, rule?: SetupCacheEntry['lf_rule'], lf?: number): void {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 'lf-buckets-')), 'nansen-cache.json'));
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt: SI_DEPLOYED_AT });
  updateTokenAnalytics(CA, CHAIN, { t100Pct: 10, t100Multiple: 1.1, genesisBal: lf });
  putSetupCacheEntry({
    ca: CA, chain: CHAIN, taken_at: now, window: 'month',
    series_from: SI_DEPLOYED_AT, series: [], exchange: [],
    t100_pct: 10, t100_multiple: 1.1, genesis_bal: lf, lf_rule: rule,
    info_at: now, series_at: now,
  });
}

function installBoundaryFlows(rows: TgmFlowsRow[]) {
  const calls: Parameters<TokenFlowsClient['tokenFlows']>[0][] = [];
  setPollerDeps(stubProvider, null, {
    tokenFlows: async (req) => {
      calls.push(req);
      return rows.filter((row) => {
        const at = Date.parse(row.date!);
        return at > Date.parse(req.date.from) && at <= Date.parse(req.date.to);
      });
    },
  });
  return calls;
}

for (const previous of [
  { name: 'missing LF', lf: undefined, rule: undefined },
  { name: 'legacy next-day LF', lf: 84_101_604.666091, rule: undefined },
  { name: 'hourly LF at daily resolution', lf: SI_HOURLY_LF, rule: 'bucket-hour-v2' as const },
]) {
  test(`SI listing-day bucket repairs ${previous.name} and then avoids repeat LF reads`, async (t) => {
    t.mock.method(Date, 'now', () => SI_NOW);
    seedBucketCase(SI_NOW, previous.rule, previous.lf);
    const calls = installBoundaryFlows(SI_DAILY_ROWS);

    await refreshSeries(CA, CHAIN);

    const exchange = calls.filter((req) => req.label === 'exchange');
    assert.equal(exchange.length, 1);
    assert.equal(exchange[0].date.from, '2026-09-20T00:00:00.000Z');
    assert.equal(getTokenState(CA, CHAIN)?.genesis_bal, SI_DAILY_LF);
    assert.equal(getSetupCacheEntry(CA, CHAIN)?.lf_rule, 'bucket-day-v2');
    await refreshSeries(CA, CHAIN);
    assert.equal(calls.filter((req) => req.label === 'exchange').length, 1);
  });
}

test('LF crosses seven days once without predecessor padding forcing premature daily resolution', async (t) => {
  let now = SI_DEPLOYED_AT + 7 * DAY - 60_000;
  t.mock.method(Date, 'now', () => now);
  seedBucketCase(now);
  const hourlyRows: TgmFlowsRow[] = [{
    date: new Date(Math.floor(SI_DEPLOYED_AT / HOUR) * HOUR).toISOString(),
    token_amount: SI_HOURLY_LF,
  }];
  const calls: Parameters<TokenFlowsClient['tokenFlows']>[0][] = [];
  setPollerDeps(stubProvider, null, {
    tokenFlows: async (req) => {
      calls.push(req);
      const span = Date.parse(req.date.to) - Date.parse(req.date.from);
      const rows = span > 7 * DAY ? SI_DAILY_ROWS : hourlyRows;
      return rows.filter((row) => Date.parse(row.date!) > Date.parse(req.date.from));
    },
  });
  await refreshSeries(CA, CHAIN);
  const hourly = calls.find((req) => req.label === 'exchange')!;
  assert.equal(hourly.date.from, '2026-09-21T14:00:00.000Z');
  assert.ok(Date.parse(hourly.date.to) - Date.parse(hourly.date.from) <= 7 * DAY);
  assert.equal(getTokenState(CA, CHAIN)?.genesis_bal, SI_HOURLY_LF);
  assert.equal(getSetupCacheEntry(CA, CHAIN)?.lf_rule, 'bucket-hour-v2');

  now = SI_DEPLOYED_AT + 7 * DAY + 60_000;
  await refreshSeries(CA, CHAIN);
  assert.equal(getTokenState(CA, CHAIN)?.genesis_bal, SI_DAILY_LF);
  assert.equal(getSetupCacheEntry(CA, CHAIN)?.lf_rule, 'bucket-day-v2');
  await refreshSeries(CA, CHAIN);
  assert.equal(calls.filter((req) => req.label === 'exchange').length, 2);
});

for (const failure of ['provider denial', 'missing listing-day bucket']) {
  test(`LF repair preserves the previous value and provenance on ${failure}`, async (t) => {
    t.mock.method(Date, 'now', () => SI_NOW);
    seedBucketCase(SI_NOW, 'bucket-hour-v2', SI_HOURLY_LF);
    setPollerDeps(stubProvider, null, {
      tokenFlows: async (req) => {
        if (req.label === 'exchange' && failure === 'provider denial') throw new Error('gated');
        return SI_DAILY_ROWS.slice(1);
      },
    });

    await refreshSeries(CA, CHAIN);

    assert.equal(getTokenState(CA, CHAIN)?.genesis_bal, SI_HOURLY_LF);
    assert.equal(getSetupCacheEntry(CA, CHAIN)?.genesis_bal, SI_HOURLY_LF);
    assert.equal(getSetupCacheEntry(CA, CHAIN)?.lf_rule, 'bucket-hour-v2');
  });
}

test('fresh LF-only cache restores DB LF without upstream reads or changing other token fields', async (t) => {
  let now = SI_NOW;
  t.mock.method(Date, 'now', () => now);
  seedBucketCase(SI_NOW, 'bucket-day-v2', SI_DAILY_LF);
  updateTokenAnalytics(CA, CHAIN, {
    t100Pct: 25, t100Multiple: 1.5, anchorAt: SI_DEPLOYED_AT,
    bal: { d1: { peak: 900, trough: 600 }, d7: { peak: 800, trough: 500 } },
  });
  const before = getTokenState(CA, CHAIN)!;
  assert.equal(before.genesis_bal, null);
  const calls = installBoundaryFlows(SI_DAILY_ROWS);

  now += 1_000;
  await refreshSeries(CA, CHAIN);

  const after = getTokenState(CA, CHAIN)!;
  assert.equal(after.genesis_bal, SI_DAILY_LF);
  assert.deepEqual({ ...after, genesis_bal: before.genesis_bal }, before);
  assert.equal(calls.length, 0);
});
