import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignalPage } from '../src/signal-page.js';
import type { TokenSignal } from '../src/signals.js';
import type { Tier } from '../src/shared/tier.js';

/** Minimal DTO: only the fields buildSignalPage reads are meaningful. */
function signal(id: string, tier: Tier | null, score: number, activityAt: number, volume24h: number, fomoTs = 0): TokenSignal {
  return {
    id,
    ca: `ca-${id}`,
    chain: 'sol',
    trackedWallets: [],
    fomoUsers: fomoTs === 0 ? [] : [{ handle: '@u', buyUsd: 1, sellUsd: 0, buys: 1, sells: 0, trades: 1, lastTs: fomoTs }],
    nansen: { score, pass: { fresh: score >= 1, t100: false, lf: false }, freshCurrent: true },
    holders: 0,
    trackedInflow: 0,
    trackedActivityAt: activityAt,
    trackedHolding: 0,
    volume24h,
    tier,
  };
}

const options = { allFactors: false, showFomo: false, limit: 100, offset: 0 };

// score>=1 passers and explicitly tiered rows form the dashboard; the rest stay hidden.
const rows: TokenSignal[] = [
  signal('pass-old', null, 2, 1_000, 10),
  signal('pass-new', null, 1, 5_000, 20),
  signal('tier-b', 'B', 0, 3_000, 30),
  signal('hidden', null, 0, 9_000, 40),
  signal('pass-p', 'P', 3, 7_000, 50),
];

test('dashboard view keeps passers and tiered rows, and orders by newest activity', () => {
  const page = buildSignalPage(rows, options);
  assert.deepEqual(page.rows.map((row) => row.id), ['pass-new', 'tier-b', 'pass-old', 'pass-p']);
  assert.equal(page.total, 4);
});

test('a page is a contiguous, globally ordered slice of the full view', () => {
  const first = buildSignalPage(rows, { ...options, limit: 2 });
  const second = buildSignalPage(rows, { ...options, limit: 2, offset: 2 });
  const full = buildSignalPage(rows, options);
  assert.deepEqual([...first.rows, ...second.rows].map((row) => row.id), full.rows.map((row) => row.id));
  assert.equal(first.total, full.total);
  assert.equal(second.total, full.total);
});

test('stats describe the full view, not the returned slice', () => {
  const page = buildSignalPage(rows, { ...options, limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.stats, { tracked: 5, active: 4, watch: 1, volume24h: 110, tiers: { s: 0, a: 0, b: 1 } });
});

test('rated view drops P, orders S+ down to B, and counts tiers across the whole list', () => {
  const ratedRows: TokenSignal[] = [
    signal('b-new', 'B', 0, 9_000, 1),
    signal('s-plus', 'S+', 0, 1_000, 2),
    signal('pass-p', 'P', 3, 8_000, 3),
    signal('a-old', 'A', 0, 2_000, 4),
  ];
  const page = buildSignalPage(ratedRows, { ...options, view: 'rated' });
  assert.deepEqual(page.rows.map((row) => row.id), ['s-plus', 'a-old', 'b-new']);
  assert.equal(page.total, 3);
  assert.deepEqual(page.stats.tiers, { s: 1, a: 1, b: 1 });
});

test('allFactors widens the dashboard to every tracked CA', () => {
  const page = buildSignalPage(rows, { ...options, allFactors: true });
  assert.equal(page.total, rows.length);
});

test('showFomo orders by the newest FOMO trade when it is newer than tracked activity', () => {
  const fomoRows = [signal('tracked-newer', null, 1, 9_000, 0, 1_000), signal('fomo-newer', null, 1, 1_000, 0, 12_000)];
  const without = buildSignalPage(fomoRows, options);
  const withFomo = buildSignalPage(fomoRows, { ...options, showFomo: true });
  assert.deepEqual(without.rows.map((row) => row.id), ['tracked-newer', 'fomo-newer']);
  assert.deepEqual(withFomo.rows.map((row) => row.id), ['fomo-newer', 'tracked-newer']);
});
