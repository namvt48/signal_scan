import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeAnchorLf, LF_WINDOWS, normalizeHolderRows, RUNG_SPAN_DAYS, seriesFromMs, seriesReachesStart, tfFor, t100Decrease, t100Mdd } from '../src/snapshot.js';
import type { HolderRow } from '../src/providers/provider.js';

function row(address: string, amountPct: number, addrType = 1): HolderRow {
  return { address, amountPct, addrType, isNew: false, usdValue: 0 };
}

function requireNumber(v: number | undefined): number {
  if (v === undefined) throw new Error('expected a number, got undefined');
  return v;
}

test('normalizeHolderRows leaves 0-1 shares untouched', () => {
  const rows = [row('A', 0.5), row('B', 0.4)];
  const out = normalizeHolderRows(rows);
  assert.equal(out[0]?.amountPct, 0.5);
  assert.equal(out[1]?.amountPct, 0.4);
});

test('normalizeHolderRows rescales percent-scale feed (sum > 1.5)', () => {
  const rows = [row('A', 30), row('B', 20)]; // sum 50 -> percent scale
  const out = normalizeHolderRows(rows);
  assert.ok(Math.abs((out[0]?.amountPct ?? 0) - 0.3) < 1e-12);
  assert.ok(Math.abs((out[1]?.amountPct ?? 0) - 0.2) < 1e-12);
});

test('cohort zero-fill: holder that left the top-100 counts as fully sold', () => {
  const prev = [row('A', 0.5), row('B', 0.3)];
  const curr = [row('A', 0.4)]; // B fully exited
  const pct = requireNumber(t100Decrease(prev, curr));
  // sumPrev 0.8 -> sumCurr 0.4 (B counts 0) => 50%
  assert.ok(Math.abs(pct - 50) < 1e-9, `expected 50, got ${pct}`);
});

test('empty curr = 100% decrease for the cohort', () => {
  const pct = requireNumber(t100Decrease([row('A', 0.4)], []));
  assert.ok(Math.abs(pct - 100) < 1e-9, `expected 100, got ${pct}`);
});

test('exchange-classified rows are included in the cohort', () => {
  // EX is an exchange in prev; its -12.5% drop now counts.
  const prev = [row('EX', 0.6, 2), row('A', 0.2)];
  const curr = [row('EX', 0.6, 2), row('A', 0.1)];
  const pct = requireNumber(t100Decrease(prev, curr));
  // cohort = {EX,A}: (0.8 - 0.7) / 0.8 => 12.5
  assert.ok(Math.abs(pct - 12.5) < 1e-9, `expected 12.5, got ${pct}`);
});

test('curr addrType is ignored — membership comes from prev addresses only', () => {
  const pct = requireNumber(t100Decrease([row('A', 0.5)], [row('A', 0.5, 2)]));
  assert.ok(Math.abs(pct) < 1e-9, `expected 0 (unchanged), got ${pct}`);
});

test('all-exchange prev now produces a number (was undefined under exclusion)', () => {
  const pct = requireNumber(t100Decrease([row('EX', 0.6, 2)], [row('EX', 0.3, 2)]));
  assert.ok(Math.abs(pct - 50) < 1e-9, `expected 50, got ${pct}`);
});

test('sumPrev <= 0 -> undefined (empty prev)', () => {
  assert.equal(t100Decrease([], [row('A', 0.3)]), undefined);
});

test('missing prev or curr -> undefined', () => {
  assert.equal(t100Decrease(undefined, [row('A', 0.3)]), undefined);
  assert.equal(t100Decrease([row('A', 0.3)], undefined), undefined);
  assert.equal(t100Decrease(undefined, undefined), undefined);
});

// --- T100 sliding max drawdown (user 2026-09-25) ----------------------------
// pct = max over t of (peak_t − total_t)/peak_t×100, with the running peak raised
// BEFORE each point is measured, so a drawdown can only run peak → later trough.
// The peak SLIDES: it is the running max, not the leftmost point. The old
// genesis-anchor read 0% for the ~69% of tokens whose cohort minimum sat AT
// genesis, which is why this replaced it.

test('t100Mdd: peak then later trough, mixed timestamp shapes, unsorted arrival', () => {
  const g = t100Mdd([
    { t: '2026-09-09', total: 600 },
    { t: '2026-09-08T20:28:00Z', total: 1000 }, // earliest → peak
    { t: Date.parse('2026-09-08T22:00:00Z'), total: 800 }, // epoch-number shape
    { t: '2026-09-09T05:00:00Z', total: 400 }, // trough
    { t: '2026-09-09T09:00:00Z', total: 650 },
  ]);
  assert.ok(g);
  assert.ok(Math.abs(g.pct - 60) < 1e-9, `pct=${g?.pct}`);
  assert.equal(g.multiple, 2.5);
  assert.equal(g.peak, 1000);
  assert.equal(g.trough, 400);
  assert.equal(g.peakAt, Date.parse('2026-09-08T20:28:00Z'));
});

test('t100Mdd: the MAX anchors, not the leftmost — a token that grew then dumped now registers', () => {
  // The old leftmost rule read A=165.3M here → pct 39%. The sliding peak reads the
  // 393.3M high → ~74.6%, which is the drawdown the chart actually shows.
  const g = t100Mdd([
    { t: '2026-08-11T19:25:11Z', total: 165_298_676.455 },
    { t: '2026-09-03', total: 357_052_343.881 },
    { t: '2026-09-04', total: 393_272_380.304 }, // peak
    { t: '2026-09-05', total: 100_000_000 }, // trough
  ]);
  assert.ok(g);
  assert.equal(g.peak, 393_272_380.304);
  assert.equal(g.trough, 100_000_000);
  assert.ok(Math.abs(g.pct - ((393_272_380.304 - 100_000_000) / 393_272_380.304) * 100) < 1e-9, `pct=${g?.pct}`);
  assert.ok(Math.abs(g.multiple - 393_272_380.304 / 100_000_000) < 1e-9, `multiple=${g?.multiple}`);
});

test('t100Mdd: the peak is raised BEFORE measuring, so a new high is never its own trough', () => {
  // Raised after measuring instead, every point here would compute a negative
  // drawdown and the result would silently be pct 0.
  const g = t100Mdd([
    { t: '2026-09-09T00:00:00Z', total: 100 },
    { t: '2026-09-09T01:00:00Z', total: 300 }, // peak
    { t: '2026-09-09T02:00:00Z', total: 150 }, // trough
  ]);
  assert.ok(g);
  assert.equal(g.pct, 50);
  assert.equal(g.multiple, 2);
  assert.equal(g.peak, 300);
  assert.equal(g.trough, 150);
  assert.equal(g.peakAt, Date.parse('2026-09-09T01:00:00Z'));
});

test('t100Mdd: a later high cannot erase an earlier peak→trough drawdown', () => {
  const g = t100Mdd([
    { t: '2026-08-21', total: 208_428_160 }, // peak
    { t: '2026-08-22', total: 110_888_890 }, // trough
    { t: '2026-09-10', total: 887_528_525 }, // later high — no trough after it
  ]);
  assert.ok(g);
  assert.equal(g.peak, 208_428_160);
  assert.equal(g.trough, 110_888_890);
  assert.ok(Math.abs(g.pct - ((208_428_160 - 110_888_890) / 208_428_160) * 100) < 1e-6, `pct=${g?.pct}`);
  assert.ok(Math.abs(g.multiple - 208_428_160 / 110_888_890) < 1e-9, `multiple=${g?.multiple}`);
});

test('t100Mdd: no drawdown anywhere → pct 0, multiple exactly 1, peak = the global max', () => {
  const g = t100Mdd([
    { t: '2026-09-09T00:00:00Z', total: 100 },
    { t: '2026-09-10T00:00:00Z', total: 200 },
    { t: '2026-09-11T00:00:00Z', total: 300 },
  ]);
  assert.deepEqual(g, { pct: 0, multiple: 1, peak: 300, trough: 300, peakAt: Date.parse('2026-09-11T00:00:00Z') });
});

test('t100Mdd: single point → pct 0, multiple 1 (hasn\'t leaked yet)', () => {
  const g = t100Mdd([{ t: '2026-09-09T00:00:00Z', total: 500 }]);
  assert.deepEqual(g, { pct: 0, multiple: 1, peak: 500, trough: 500, peakAt: Date.parse('2026-09-09T00:00:00Z') });
});

test('t100Mdd guards: zero rows / zero-balance rows / junk timestamps', () => {
  assert.equal(t100Mdd([]), undefined);
  assert.equal(t100Mdd([{ t: '2026-09-09', total: 0 }]), undefined); // pre-supply placeholder dropped → 0 rows
  assert.equal(t100Mdd([{ t: 'not-a-date', total: 100 }]), undefined); // row filtered → 0 rows
  assert.equal(
    t100Mdd([{ t: '2026-09-09', total: 0 }, { t: '2026-09-10', total: 0 }]),
    undefined,
  );
});

test('t100Mdd: a zero placeholder never becomes the trough', () => {
  const g = t100Mdd([
    { t: '2026-08-29', total: 0 }, // pre-listing placeholder
    { t: '2026-08-30', total: 25_854_338.624151 },
    { t: '2026-09-05', total: 974_900_000 }, // peak
    { t: '2026-09-06', total: 0 }, // placeholder — a trough of 0 would be multiple Infinity
    { t: '2026-09-07', total: 500_000_000 }, // real trough
  ]);
  assert.ok(g);
  assert.equal(g.peak, 974_900_000);
  assert.equal(g.trough, 500_000_000);
  assert.ok(Number.isFinite(g.multiple), `multiple=${g?.multiple}`);
});

test('t100Mdd: date-only and full-ISO shapes sort against each other correctly', () => {
  const g = t100Mdd([
    { t: '2026-09-10', total: 300 }, // UTC midnight — an hour LATER, so the trough
    { t: '2026-09-09T23:00:00Z', total: 900 }, // one hour earlier → peak
  ]);
  assert.ok(g);
  assert.equal(g.peak, 900);
  assert.equal(g.trough, 300);
  assert.equal(g.multiple, 3);
  assert.equal(g.peakAt, Date.parse('2026-09-09T23:00:00Z'));
});

// --- FE timeframe ladder (user 2026-09-18) ----------------------------------
// Rung N unlocks at the NEXT-SMALLER rung's span (probed live: `7D` disabled at
// age 0.74d, enabled at 1.17d), and 1Y is the cap. Ages below are live ages.

test('tfFor: rung boundaries — week at 1d, month at 7d, quarter at 30d, year at 90d', () => {
  assert.equal(tfFor(0), 'day');
  assert.equal(tfFor(0.74), 'day'); // LOCKINU — 7D still disabled
  assert.equal(tfFor(1), 'week'); // boundary
  assert.equal(tfFor(1.17), 'week'); // POT — 7D enabled
  assert.equal(tfFor(6.99), 'week');
  assert.equal(tfFor(7), 'month');
  assert.equal(tfFor(17.3), 'month'); // ZCAT
  assert.equal(tfFor(29.99), 'month');
  assert.equal(tfFor(30), 'quarter');
  assert.equal(tfFor(55.4), 'quarter'); // STONK
  assert.equal(tfFor(89.99), 'quarter');
  assert.equal(tfFor(90), 'year');
  assert.equal(tfFor(495.5), 'year'); // LINK — capped, never 'all'
});

test('tfFor: junk age falls back to the floor rung (never throws)', () => {
  assert.equal(tfFor(-5), 'day');
  assert.equal(tfFor(Number.NaN), 'day');
  assert.equal(tfFor(Number.POSITIVE_INFINITY), 'year');
});

test('LF_WINDOWS: widest first, exactly the chart TF list (1Y/180D/90D/30D/7D/24h)', () => {
  assert.deepEqual(LF_WINDOWS.map((r) => r.label), ['1Y', '180D', '90D', '30D', '7D', '24h']);
  assert.deepEqual(LF_WINDOWS.map((r) => r.days), [365, 180, 90, 30, 7, 1]);
});

test('RUNG_SPAN_DAYS: the FE rung maps to its chart span', () => {
  assert.deepEqual(RUNG_SPAN_DAYS, { day: 1, week: 7, month: 30, quarter: 90, year: 365 });
});

/**
 * The T100/anchor_at defect: a fetch whose `from` precedes the deploy comes back with
 * the pre-genesis back-fill, and its leftmost is then stored as genesis — KNOTS carried
 * anchor_at 2026-08-22 while deployed_at was 2026-09-05. Clamping `from` to the deploy
 * makes a pre-deploy anchor unreachable.
 */
test('seriesFromMs: never before the deploy; older-than-window and unknown deploy fall back to the window edge', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  const span = 30 * 86_400_000;
  const deployed = Date.parse('2026-09-05T16:34:16Z');
  assert.equal(seriesFromMs(now, deployed, span), deployed); // inside the window → from the deploy
  assert.equal(seriesFromMs(now, Date.parse('2025-01-01T00:00:00Z'), span), now - span); // older → window edge
  assert.equal(seriesFromMs(now, null, span), now - span); // unknown deploy → window only
  assert.equal(seriesFromMs(now, undefined, span), now - span);
});

/**
 * The defect this guards: `nansenSeries` accepts ANY 200 with an array, so a
 * throttled / coarser response that starts LATER passes through, and
 * `exchangeAnchorLf` then returns a later balance as if it were the listing float
 * (KNOTS: 45.67M written where the chart reads 616.08M). A series is only usable as
 * a genesis read if it reaches back to the `from` it was asked for.
 */
test('seriesReachesStart: a later-starting (partial/throttled) series is rejected', () => {
  const requestedFrom = Date.parse('2026-09-05T16:34:16Z'); // = max(now - span, deployed_at)
  const onTime = [
    { t: '2026-09-05T17:00:00Z', total: 616_080_000 },
    { t: '2026-09-21T00:00:00Z', total: 593_230_000 },
  ];
  const truncated = [
    { t: '2026-09-14T00:00:00Z', total: 45_669_715.93 },
    { t: '2026-09-21T00:00:00Z', total: 593_230_000 },
  ];
  assert.equal(seriesReachesStart(onTime, requestedFrom), true);
  assert.equal(seriesReachesStart(truncated, requestedFrom), false);
});

test('exchangeAnchorLf: a partial series silently yields a later balance (the KNOTS bug)', () => {
  const deployed = Date.parse('2026-09-05T16:34:16Z');
  const truncated = [{ t: '2026-09-06T00:00:00Z', total: 45_669_715.93 }];
  assert.equal(exchangeAnchorLf(truncated, deployed)?.total, 45_669_715.93);
});

// --- LF: the exchange chart's LEFTMOST point (user 2026-09-11) --------------

test('exchangeAnchorLf: leftmost total>0 row wins — arrival order and later bigger rows ignored', () => {
  const lf = exchangeAnchorLf([
    { t: '2026-09-05', total: 999_000_000 }, // later + bigger → loses
    { t: '2026-08-18T00:00:00Z', total: 71_323_704.5 }, // leftmost → LF
    { t: '2026-09-04T02:00:00Z', total: 341_553_999 }, // same-day-later, out
  ]);
  assert.equal(lf?.total, 71_323_704.5);
  assert.equal(lf?.at, '2026-08-18T00:00:00.000Z');
});

test('exchangeAnchorLf: pre-listing total=0 rows are skipped, not treated as the float', () => {
  const lf = exchangeAnchorLf([
    { t: '2026-09-03', total: 0 }, // no supply yet
    { t: '2026-09-03T12:00:00Z', total: 0 },
    { t: '2026-09-04', total: 222_482_702 }, // first real float
  ]);
  assert.equal(lf?.total, 222_482_702);
  assert.equal(lf?.at, '2026-09-04T00:00:00.000Z');
});

test('exchangeAnchorLf: no total>0 row anywhere → undefined (caller keeps the previous value)', () => {
  assert.equal(exchangeAnchorLf([{ t: '2026-08-23', total: 0 }, { t: '2026-08-25', total: 0 }]), undefined);
  assert.equal(exchangeAnchorLf([]), undefined);
  assert.equal(exchangeAnchorLf([{ t: 'not-a-date', total: 5 }]), undefined);
});

test('exchangeAnchorLf: minAt (deployed_at) skips the pre-genesis back-fill filler', () => {
  const deployedAt = Date.parse('2026-09-17T20:00:00Z');
  const lf = exchangeAnchorLf(
    [
      { t: '2025-09-19', total: 871_973_000 }, // month+ filler, a year before deploy
      { t: '2026-09-15T00:00:00Z', total: 90_062_000 }, // also before deploy
      { t: '2026-09-17T20:00:00Z', total: 824_201_000 }, // real listing float
      { t: '2026-09-18T04:00:00Z', total: 874_021_500 },
    ],
    deployedAt,
  );
  assert.equal(lf?.total, 824_201_000);
  assert.equal(lf?.at, '2026-09-17T20:00:00.000Z');
});

test('exchangeAnchorLf: minAt 0 (unknown deploy) keeps the plain leftmost>0 rule', () => {
  const lf = exchangeAnchorLf([{ t: '2026-09-15T00:00:00Z', total: 90_062_000 }]);
  assert.equal(lf?.total, 90_062_000);
});
