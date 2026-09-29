// Official tgm/flows migration (2026-09-23; T100 sliding max drawdown 2026-09-25)
// — request-count boundaries:
//   - T100 is fetched ONCE per pass over the token's WHOLE life, `deploy -> now`,
//     and those same rows feed the chart, the bal_* extremes and the file cache.
//     There is NO granularity-forcing extra call: MDD needs no daily discipline, so
//     the wire's own span rule (≤7.5d → hourly, ≥8d → daily) applies untouched at
//     every age. The request start is floored at 1000d, since the wire's ~1000-row
//     budget truncates the OLD end. Window label is '1W' when the life is ≤7d, '1M'
//     longer.
//   - LF = exactly ONE call with label 'exchange', `to` capped so the range fits
//     the API's most-recent-1000-bucket window.
//   - pre-genesis buckets carry a constant back-fill and are dropped by the
//     deploy-DAY date clamp (floor(deployed_at / DAY)), never by holders_count
//     (the API leaves holders_count 0 on virtually every DAILY row).
//   - a flows throw keeps the previous genesis_bal / t100_multiple in token_state
//     and never writes a cache entry (isStorable refuses empty passes).
//   - NansenApiClient.tokenFlows makes ONE request (page 2 returns 0 rows):
//     per_page 1000, no order_by / filters
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TgmFlowsRequest, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';

const { open, getTokenState } = await import('../src/db.js');
const { updateTokenMetrics, updateTokenAnalytics } = await import('../src/ingest.js');
const { loadSetupCache, getSetupCacheEntry } = await import('../src/setup-cache.js');
const { refreshSeries, setPollerDeps } = await import('../src/poller.js');
const { NansenApiClient } = await import('../src/providers/nansen.js');

const CA = 'CA-TGM-FLOWS';
const CHAIN: Chain = 'sol';
const DAY = 86_400_000;

const stubProvider: MarketDataProvider = {
  name: 'stub-tgm-flows',
  tokenInfo: async () => {
    throw new Error('unused');
  },
  metric: async () => ({}),
  walletTokenHoldings: async () => [],
};

let t100Calls = 0;
let exchangeCalls = 0;
let t100Windows: { from: number; to: number }[] = [];

/** Full-coverage fake: rows at date.from + every DAY up to date.to, so the
 * requested range always passes seriesReachesStart. holders_count 1 keeps every
 * row a T100 A-candidate (PA1: holders 0 = pre-genesis placeholder). */
function installDenseFlows(): TokenFlowsClient {
  t100Calls = 0;
  exchangeCalls = 0;
  t100Windows = [];
  return {
    tokenFlows: async (req: TgmFlowsRequest) => {
      const from = Date.parse(req.date.from);
      const to = Date.parse(req.date.to);
      const rows: TgmFlowsRow[] = [];
      for (let t = from; t <= to; t += DAY) rows.push({ date: new Date(t).toISOString(), token_amount: 100, holders_count: 1 });
      if (req.label === 'exchange') {
        exchangeCalls += 1;
        return rows;
      }
      t100Calls += 1;
      t100Windows.push({ from, to });
      return rows;
    },
  };
}

function tempCacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'tgm-flows-')), 'nansen-cache.json');
}

async function runRefreshAtAge(ageDays: number): Promise<void> {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt: now - ageDays * DAY });
  setPollerDeps(stubProvider, null, installDenseFlows());
  await refreshSeries(CA, CHAIN);
}

test('T100: age 3d → exactly 1 tgm/flows call, window 1W, no forcing extra', async () => {
  const before = Date.now();
  await runRefreshAtAge(3);
  assert.equal(t100Calls, 1, 'ONE call at every age — MDD needs no granularity forcing');
  assert.equal(exchangeCalls, 1, 'LF is always exactly one exchange call');
  assert.ok(Math.abs(t100Windows[0].from - (before - 3 * DAY)) < 5_000, 'the window anchors at deployed_at');
  assert.ok(Math.abs(t100Windows[0].to - before) < 5_000, 'the window ends at now');
  assert.equal(getSetupCacheEntry(CA, CHAIN)?.window, '1W', 'a ≤7d life is the 1W window');
});

test('T100: age 10d → exactly 1 call, window 1M', async () => {
  const before = Date.now();
  await runRefreshAtAge(10);
  assert.equal(t100Calls, 1);
  assert.equal(exchangeCalls, 1);
  assert.ok(Math.abs(t100Windows[0].from - (before - 10 * DAY)) < 5_000, 'the window anchors at deployed_at');
  assert.equal(getSetupCacheEntry(CA, CHAIN)?.window, '1M');
});

test('T100: age 40d → 1 call over the WHOLE life, not a capped first month', async () => {
  const before = Date.now();
  await runRefreshAtAge(40);
  assert.equal(t100Calls, 1, 'no extra call, no chunk loop');
  assert.equal(exchangeCalls, 1);
  const deployedAt = t100Windows[0].from;
  assert.ok(Math.abs(deployedAt - (before - 40 * DAY)) < 5_000, 'the window anchors at deployed_at');
  assert.ok(Math.abs(t100Windows[0].to - before) < 5_000, 'the window runs to now, so a day-40 drawdown is visible');
  assert.equal(getSetupCacheEntry(CA, CHAIN)?.window, '1M');
});

test('pre-genesis back-fill is clamped out of both T100 and LF', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  setPollerDeps(stubProvider, null, {
    tokenFlows: async (req: TgmFlowsRequest) => {
      const from = Date.parse(req.date.from);
      return [
        { date: new Date(from - 5 * DAY).toISOString(), token_amount: 999_999, holders_count: 0 },
        { date: new Date(from).toISOString(), token_amount: 500, holders_count: 1 },
        { date: new Date(from + DAY).toISOString(), token_amount: 400, holders_count: 1 },
        { date: new Date(from + 2 * DAY).toISOString(), token_amount: 450, holders_count: 1 },
      ];
    },
  });

  await refreshSeries(CA, CHAIN);

  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.genesis_bal, 500, 'the pre-genesis constant must lose to the first real bucket');
  assert.equal(st.t100_multiple, 1.25, 'A=500 B=400 from the post-deploy rows only');
});

/** Fake for the measured-row fixtures below: returns the given measured rows for
 * every top_100_holders window — the wire's own span rule no longer routes T100
 * anywhere else — and [] for exchange (LF keeps its previous value). Deploy is
 * relative (now-7d) so the fixtures stay wall-clock stable. */
function installDailyOnlyFlows(dailyRows: readonly TgmFlowsRow[]): TokenFlowsClient {
  return {
    tokenFlows: async (req: TgmFlowsRequest) => {
      if (req.label === 'exchange') return [];
      return [...dailyRows];
    },
  };
}

async function runDailyOnly(deployedAt: number, dailyRows: readonly TgmFlowsRow[]): Promise<void> {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  setPollerDeps(stubProvider, null, installDailyOnlyFlows(dailyRows));
  await refreshSeries(CA, CHAIN);
}

/** API-shaped fake for the measured "hourly window empty, daily window real" case
 * (CASES 4.07d read 0 hourly rows while its 30d daily series existed — EVIDENCE §16b):
 * a span <8d returns [] for top_100_holders, a span ≥8d returns the given daily rows.
 * Exchange follows the same span rule (the back-fill is daily-only, so the LF's short
 * deploy-anchored window is legitimately empty — hence no cache entry, the storable
 * guard wants a non-empty exchange). */
function installNoHourlyFlows(dailyRows: readonly TgmFlowsRow[], exchangeRows: readonly TgmFlowsRow[]): TokenFlowsClient {
  t100Calls = 0;
  exchangeCalls = 0;
  t100Windows = [];
  return {
    tokenFlows: async (req: TgmFlowsRequest) => {
      const from = Date.parse(req.date.from);
      const to = Date.parse(req.date.to);
      const daily = to - from >= 8 * DAY;
      if (req.label === 'exchange') {
        exchangeCalls += 1;
        return daily ? [...exchangeRows] : [];
      }
      t100Calls += 1;
      t100Windows.push({ from, to });
      return daily ? [...dailyRows] : [];
    },
  };
}

test('an EMPTY hourly window retries as a 30d daily window instead of dropping the pass (CASES, measured)', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const deployedAt = Date.now() - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  const day = (n: number) => new Date(deployedAt + n * DAY).toISOString();
  setPollerDeps(stubProvider, null, installNoHourlyFlows(
    [
      { date: day(0), token_amount: 1_067_198_001, holders_count: 0 },
      { date: day(1), token_amount: 1_010_000_000, holders_count: 0 },
      { date: day(2), token_amount: 965_647_456, holders_count: 0 },
    ],
    [{ date: day(0), token_amount: 990_240_299, holders_count: 0 }],
  ));

  await refreshSeries(CA, CHAIN);

  assert.equal(t100Calls, 2, 'the empty hourly attempt + ONE widened daily attempt');
  assert.ok(t100Windows[0].to - t100Windows[0].from < 8 * DAY, 'attempt 1 is the deploy-anchored short span');
  assert.ok(t100Windows[1].to - t100Windows[1].from >= 8 * DAY, 'the retry widens the SAME end into a daily span');
  assert.ok(t100Windows[1].to - t100Windows[1].from >= 29 * DAY, 'a full month back');

  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.bal_peak_7d, 1_067_198_001, 'the widened daily series IS the chart now — before the retry the pass was dropped and this stayed null');
  assert.equal(st.bal_trough_7d, 965_647_456);
  assert.ok(Math.abs((st.t100_multiple ?? 0) - 1.10516) < 0.001, 'holders_count 0 no longer empties the series — A=1067198001 B=965647456');
  assert.equal(st.anchor_at, deployedAt, 'A is the first row of the widened daily array (fixture rows sit at deployedAt + n*DAY)');
});

test('a flat back-fill series (holders 0) is refused: it never becomes the chart (THERANOS, measured)', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  updateTokenAnalytics(CA, CHAIN, { t100Pct: 40, t100Multiple: 1.5, genesisBal: 120, anchorAt: deployedAt });
  const flat = (n: number) => ({ date: new Date(deployedAt + n * DAY).toISOString(), token_amount: 963_581_533, holders_count: 0 });
  setPollerDeps(stubProvider, null, installNoHourlyFlows([flat(0), flat(1)], []));

  await refreshSeries(CA, CHAIN);

  assert.equal(t100Calls, 2, 'the retry still fires — one call is not enough to tell filler from data');
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 1.5, 'the previous T100 is kept');
  assert.equal(st.t100_pct, 40);
  assert.equal(st.bal_peak_7d, null, 'the back-fill must never become the chart');
  assert.equal(st.bal_trough_7d, null);
  assert.equal(st.genesis_bal, 120, 'the empty LF window kept the previous balance');
});

test('a ONE-bucket widened series still charts, but must NOT flip T100 (keeps previous, so the CA stays incomplete)', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const deployedAt = Date.now() - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  updateTokenAnalytics(CA, CHAIN, { t100Pct: 40, t100Multiple: 1.5, genesisBal: 120, anchorAt: deployedAt });
  setPollerDeps(stubProvider, null, installNoHourlyFlows(
    [{ date: new Date(deployedAt).toISOString(), token_amount: 1_067_198_001, holders_count: 42 }],
    [],
  ));

  await refreshSeries(CA, CHAIN);

  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.bal_peak_7d, 1_067_198_001, 'one REAL bucket is still the chart — the widened read is useful');
  assert.equal(
    st.t100_multiple,
    1.5,
    'ONE bucket cannot show a drawdown: writing 1 here would set nansenScore.complete and zeroScoreGate would DELETE a 1h-old CA 0/3',
  );
  assert.equal(st.genesis_bal, 120, 'the empty hourly LF window kept the previous balance');
});

test('T100 (6JETX, measured rows): the cohort only GREW → no drawdown at all, multiple 1', async () => {
  // REAL measured daily rows (label top_100_holders, per_page 1000, chain solana),
  // re-anchored relative to deployedAt so the deploy-DAY clamp is wall-clock stable.
  // The series is monotone non-decreasing, so no peak→trough pair exists at all:
  // multiple 1, pct 0. The old two-series read scored 4.9732 (a false PASS) by mixing
  // an hourly trough with a daily peak, while the cohort actually only GREW 5.65x.
  const deployedAt = Date.now() - 7 * DAY;
  const day = (n: number) => new Date(Math.floor(deployedAt / DAY) * DAY + n * DAY).toISOString();
  await runDailyOnly(deployedAt, [
    { date: day(0), token_amount: 588_133_839.6615192, holders_count: 0 },
    { date: day(1), token_amount: 588_133_839.6615192, holders_count: 0 },
    { date: day(2), token_amount: 588_133_839.6615192, holders_count: 0 },
    { date: day(3), token_amount: 702_015_526.2933141, holders_count: 0 },
    { date: day(4), token_amount: 761_274_900.555144, holders_count: 0 },
    { date: day(5), token_amount: 850_486_243.9319422, holders_count: 72 },
    { date: day(6), token_amount: 896_897_663.7473482, holders_count: 82 },
    { date: day(7), token_amount: 965_674_324.1667278, holders_count: 100 },
  ]);
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 1, 'nothing ever fell below an earlier high');
  assert.equal(st.t100_pct, 0);
  assert.equal(st.anchor_at, Math.floor(deployedAt / DAY) * DAY + 7 * DAY, 'with no drawdown the peak IS the latest high');
});

test('T100 (LOOT bveCU…, measured rows): monotone growth → no drawdown, multiple 1', async () => {
  // REAL measured daily rows, re-anchored relative to deployedAt. Every later bucket
  // is larger than the last, so there is no peak→trough pair to measure.
  const deployedAt = Date.now() - 7 * DAY;
  const day = (n: number) => new Date(Math.floor(deployedAt / DAY) * DAY + n * DAY).toISOString();
  await runDailyOnly(deployedAt, [
    { date: day(0), token_amount: 181_601_270.53050095, holders_count: 44 },
    { date: day(1), token_amount: 209_540_609.603393, holders_count: 71 },
    { date: day(2), token_amount: 285_794_030.2882249, holders_count: 91 },
    { date: day(3), token_amount: 765_859_164.9407878, holders_count: 99 },
    { date: day(4), token_amount: 944_192_856.9355568, holders_count: 0 },
    { date: day(5), token_amount: 974_803_358.6954718, holders_count: 0 },
    { date: day(6), token_amount: 988_092_316.1345847, holders_count: 0 },
    { date: day(7), token_amount: 988_838_718.6320697, holders_count: 0 },
  ]);
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 1, 'monotonic growth over the real buckets — nothing fell');
  assert.equal(st.t100_pct, 0);
  assert.equal(st.anchor_at, Math.floor(deployedAt / DAY) * DAY + 7 * DAY, 'the peak is the latest high');
});

test('T100: the factor fires from the wire rows alone (synthetic dip)', async () => {
  const deployedAt = Date.now() - 7 * DAY;
  const day = (n: number) => new Date(Math.floor(deployedAt / DAY) * DAY + n * DAY).toISOString();
  await runDailyOnly(deployedAt, [
    { date: day(0), token_amount: 1000, holders_count: 50 },
    { date: day(1), token_amount: 400, holders_count: 60 },
  ]);
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2.5, 'peak 1000 → trough 400');
  assert.ok(Math.abs((st.t100_pct ?? 0) - 60) < 1e-9, `t100_pct=${st.t100_pct}`);
  assert.equal(st.anchor_at, Math.floor(deployedAt / DAY) * DAY, 'the peak is the deploy-day bucket');
});

test('T100: a flat series (≥2 buckets, no drawdown) writes multiple 1 over the previous value', async () => {
  // The inverse of the ONE-bucket case above: two or more REAL buckets that never fell
  // are enough to assert "chua xa", so a previous 1.5 must be replaced by 1.
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  updateTokenAnalytics(CA, CHAIN, { t100Pct: 40, t100Multiple: 1.5, genesisBal: 120, anchorAt: deployedAt });
  setPollerDeps(stubProvider, null, {
    tokenFlows: async (req: TgmFlowsRequest) => {
      const from = Date.parse(req.date.from);
      const to = Date.parse(req.date.to);
      const rows: TgmFlowsRow[] = [];
      for (let t = from; t <= to; t += DAY) rows.push({ date: new Date(t).toISOString(), token_amount: 100, holders_count: 1 });
      return rows;
    },
  });

  await refreshSeries(CA, CHAIN);

  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 1, 'three flat buckets prove no drawdown — the previous 1.5 is replaced');
  assert.equal(st.t100_pct, 0);
  assert.equal(st.genesis_bal, 100, 'the pass completed: LF re-read from the exchange rows');
  assert.equal(getSetupCacheEntry(CA, CHAIN)?.t100_multiple, 1, 'the completed pass still stored a cache entry');
});

test('keep previous: a flows throw leaves genesis_bal / t100_multiple untouched and stamps no marker', async () => {
  open(':memory:');
  loadSetupCache(tempCacheFile());
  const now = Date.now();
  const deployedAt = now - 2 * DAY;
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  updateTokenAnalytics(CA, CHAIN, { t100Pct: 40, t100Multiple: 1.5, genesisBal: 120, anchorAt: deployedAt });
  setPollerDeps(stubProvider, null, {
    tokenFlows: async () => {
      throw new Error('boom');
    },
  });

  await refreshSeries(CA, CHAIN);

  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 1.5, 'a failed T100 fetch must keep the previous multiple');
  assert.equal(st.genesis_bal, 120, 'a failed LF fetch must keep the previous genesis balance');
  assert.equal(st.anchor_at, deployedAt);
  // 2026-09-29: an entry is written even by a failed pass so the per-field markers have
  // somewhere to live — but it stamps NONE, so the CA still owes its data and keeps being
  // retried (every gate is marker-based; taken_at parks nothing).
  const failed = getSetupCacheEntry(CA, CHAIN);
  assert.notEqual(failed, undefined, 'a failed pass still records its clock container');
  assert.equal(failed?.series_at, undefined, 'a failed pass must not stamp series_at');
  assert.equal(failed?.info_at, undefined, 'a failed pass must not stamp info_at');
});

test('tokenFlows: ONE request, per_page 1000, no order_by/filters', async () => {
  const realFetch = globalThis.fetch;
  const client = new NansenApiClient('test-key');
  const req: TgmFlowsRequest = {
    chain: CHAIN,
    token_address: CA,
    date: { from: new Date(0).toISOString(), to: new Date(DAY).toISOString() },
    label: 'top_100_holders',
  };
  const bodies: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      const data = Array.from({ length: 1000 }, (_, i) => ({ date: new Date(0).toISOString(), token_amount: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;
    const rows = await client.tokenFlows(req);
    assert.equal(rows.length, 1000);
    assert.equal(bodies.length, 1, 'a full page must NOT trigger page 2 — the endpoint has no real pagination');
    assert.deepEqual(bodies[0].pagination, { page: 1, per_page: 1000 });
    assert.equal('order_by' in bodies[0], false);
    assert.equal('filters' in bodies[0], false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
