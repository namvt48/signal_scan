// T100 window selection (user 2026-09-25): the series is fetched ONCE per pass over
// the token's RETAINED life, `max(deploy, now - 365d) -> now` (not a fixed first
// month), and those same rows feed the chart, the bal_* extremes, the file cache and
// T100 (sliding max drawdown, see snapshot.test.ts). There is NO granularity-forcing
// second call any more: MDD needs no daily discipline, so the wire's own span rule
// (≤7.5d → hourly, ≥8d → daily) applies untouched at every age. The request start is
// FLOORED at that 365-day analytics window, so data older than a year never reaches
// T100 (user 2026-09-25). T100 rows are clamped
// to the deploy DAY, which drops the pre-genesis back-fill while keeping the genesis
// bucket whose `date` 00:00 precedes `deployed_at`, and `holders_count` is still NOT
// a discriminator (the API leaves it 0 on virtually every DAILY row). `anchor_at` now
// carries the drawdown PEAK's time. Mirrors the node:test harness used by
// tgm-flows.test.ts / setup-rehydrate.test.ts (the repo runs
// `tsx --test test/*.test.ts`; no vitest dependency exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TgmFlowsRequest, TgmFlowsRow, TokenFlowsClient } from '../src/providers/nansen.js';
import type { MarketDataProvider } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';

const { open, getTokenState } = await import('../src/db.js');
const { updateTokenMetrics } = await import('../src/ingest.js');
const { loadSetupCache } = await import('../src/setup-cache.js');
const { refreshSeries, setPollerDeps } = await import('../src/poller.js');

const CA = 'CA-T100-WINDOW';
const CHAIN: Chain = 'sol';
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Must match SERIES_MAX_WINDOW_DAYS in poller.ts. */
const CAP_MS = 365 * DAY;

const stubProvider: MarketDataProvider = {
  name: 'stub-t100-window',
  tokenInfo: async () => {
    throw new Error('unused');
  },
  metric: async () => ({}),
  walletTokenHoldings: async () => [],
};

/** 00:00 of the deploy DAY — the daily genesis bucket's `date` precedes deployed_at. */
const deployDay = (deployedAt: number): number => Math.floor(deployedAt / DAY) * DAY;

let t100Calls = 0;
let t100Windows: { from: number; to: number }[] = [];

/** Counting fake: `top_100_holders` goes through `pick`, `exchange` always []. */
function countingFlows(pick: (req: TgmFlowsRequest, from: number, to: number) => TgmFlowsRow[]): TokenFlowsClient {
  t100Calls = 0;
  t100Windows = [];
  return {
    tokenFlows: async (req: TgmFlowsRequest) => {
      const from = Date.parse(req.date.from);
      const to = Date.parse(req.date.to);
      if (req.label === 'exchange') return [];
      t100Calls += 1;
      t100Windows.push({ from, to });
      return pick(req, from, to);
    },
  };
}

async function runRefresh(deployedAt: number, client: TokenFlowsClient): Promise<void> {
  open(':memory:');
  loadSetupCache(join(mkdtempSync(join(tmpdir(), 't100-window-')), 'nansen-cache.json'));
  updateTokenMetrics(CA, CHAIN, { supply: 1_000_000_000, deployedAt });
  setPollerDeps(stubProvider, null, client);
  await refreshSeries(CA, CHAIN);
}

test('age <24h: ONE call over deploy→now, T100 from that same array', async () => {
  const deployedAt = Date.now() - 12 * HOUR;
  const rows: TgmFlowsRow[] = [
    { date: new Date(deployedAt).toISOString(), token_amount: 1000, holders_count: 0 },
    { date: new Date(deployedAt + 6 * HOUR).toISOString(), token_amount: 600, holders_count: 0 },
    { date: new Date(deployedAt + 11 * HOUR).toISOString(), token_amount: 400, holders_count: 0 },
  ];
  await runRefresh(deployedAt, countingFlows(() => rows));

  assert.equal(t100Calls, 1, 'exactly ONE top_100_holders call — no forcing extra');
  assert.equal(t100Windows[0].from, deployedAt, 'the window starts at the DEPLOY');
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2.5, 'peak 1000 → trough 400');
  assert.equal(st.anchor_at, deployedAt, 'anchor_at is the PEAK time — the first point here');
});

test('age 24h..8d: still ONE call — the old ≥8d daily-forcing extra is gone', async () => {
  const deployedAt = Date.now() - 3 * DAY;
  const rows: TgmFlowsRow[] = [
    { date: new Date(deployedAt).toISOString(), token_amount: 1000, holders_count: 0 },
    { date: new Date(deployedAt + DAY).toISOString(), token_amount: 900, holders_count: 0 },
    { date: new Date(deployedAt + 2 * DAY).toISOString(), token_amount: 800, holders_count: 0 },
    { date: new Date(deployedAt + 2.5 * DAY).toISOString(), token_amount: 400, holders_count: 0 },
  ];
  await runRefresh(deployedAt, countingFlows(() => rows));

  assert.equal(t100Calls, 1, 'no second call at any age');
  assert.equal(t100Windows[0].from, deployedAt, 'the window starts at the DEPLOY, not a fixed first month');
  assert.ok(t100Windows[0].to - deployedAt > 2 * DAY, 'the window runs past the first month cap to now');
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2.5, 'peak 1000 → trough 400 from the primary rows');
  assert.equal(st.anchor_at, deployedAt);
});

test('age ≥30d: the window still spans the whole life, not just the first month', async () => {
  const deployedAt = Date.now() - 45 * DAY;
  // The drawdown lives BEYOND day 30, so a window capped at the first month would
  // never see it.
  const pick = (_req: TgmFlowsRequest, from: number, _to: number): TgmFlowsRow[] => [
    { date: new Date(from).toISOString(), token_amount: 200, holders_count: 0 },
    { date: new Date(from + 40 * DAY).toISOString(), token_amount: 1000, holders_count: 0 },
    { date: new Date(from + 44 * DAY).toISOString(), token_amount: 500, holders_count: 0 },
  ];
  await runRefresh(deployedAt, countingFlows(pick));

  assert.equal(t100Calls, 1);
  assert.equal(t100Windows[0].from, deployedAt, 'the window anchors at the deploy, not at now-30d');
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2, 'a day-40 peak → day-44 trough is only visible over the full life');
  assert.equal(st.anchor_at, deployedAt + 40 * DAY);
});

test('deploy-day clamp drops pre-genesis back-fill and keeps the deploy-day row', async () => {
  const deployedAt = Date.now() - 10 * DAY;
  const day = deployDay(deployedAt);
  const rows: TgmFlowsRow[] = [
    // pre-genesis back-fill — holders_count > 0 is exactly what the OLD filter kept.
    { date: new Date(day - 2 * DAY).toISOString(), token_amount: 999_999, holders_count: 7 },
    { date: new Date(day - DAY).toISOString(), token_amount: 999_999, holders_count: 7 },
    // deploy-day bucket: its 00:00 `date` precedes deployed_at, so only the DAY clamp keeps it.
    { date: new Date(day).toISOString(), token_amount: 500, holders_count: 0 },
    { date: new Date(day + DAY).toISOString(), token_amount: 400, holders_count: 0 },
    { date: new Date(day + 2 * DAY).toISOString(), token_amount: 250, holders_count: 0 },
  ];
  await runRefresh(deployedAt, countingFlows(() => rows));

  assert.equal(t100Calls, 1);
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2, 'peak 500 → trough 250 — the 999999 back-fill must be gone');
  assert.equal(st.anchor_at, day, 'anchor_at is the deploy-day bucket (kept), not the pre-genesis filler');
});

test('rows with holders_count 0 still produce a T100 (the old filter returned [])', async () => {
  const deployedAt = Date.now() - 10 * DAY;
  const rows: TgmFlowsRow[] = [
    { date: new Date(deployedAt).toISOString(), token_amount: 1000, holders_count: 0 },
    { date: new Date(deployedAt + DAY).toISOString(), token_amount: 500, holders_count: 0 },
  ];
  await runRefresh(deployedAt, countingFlows(() => rows));

  assert.equal(t100Calls, 1);
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2, 'holders_count 0 must NOT empty the series — peak 1000 → trough 500');
  assert.equal(st.anchor_at, deployedAt);
});

test('a token older than the 365d window is truncated to its last 365d, not skipped', async () => {
  const deployedAt = Date.now() - 1500 * DAY;
  // The fake answers from the start it was ASKED for, so the reach guard passes for
  // whatever `from` the cap produces.
  const pick = (_req: TgmFlowsRequest, from: number, to: number): TgmFlowsRow[] => [
    { date: new Date(from).toISOString(), token_amount: 1000, holders_count: 0 },
    { date: new Date(from + (to - from) * 0.7).toISOString(), token_amount: 400, holders_count: 0 },
  ];
  const before = Date.now();
  await runRefresh(deployedAt, countingFlows(pick));
  const after = Date.now();

  assert.equal(t100Calls, 1);
  const { from } = t100Windows[0];
  assert.ok(
    from >= before - CAP_MS - HOUR && from <= after - CAP_MS + HOUR,
    `from must sit at the ${CAP_MS / DAY}d cap, got ${new Date(from).toISOString()} for a deploy ${new Date(deployedAt).toISOString()}`,
  );
  const st = getTokenState(CA, CHAIN);
  assert.ok(st);
  assert.equal(st.t100_multiple, 2.5, 'the truncated series still yields a drawdown');
});
