// Pure holder-snapshot math — no I/O. Tested in test/snapshot.test.ts.

import type { HolderRow } from './providers/provider.js';

/**
 * Fail-loud sanity guard: amountPct is a 0-1 share of supply per holder, so the
 * batch sum must be ≤ ~1. A sum above 1.5 can only mean the feed switched to
 * percent scale (0-100) — rescale by /100 instead of silently storing garbage.
 */
export function normalizeHolderRows(rows: HolderRow[]): HolderRow[] {
  const sum = rows.reduce((acc, r) => acc + r.amountPct, 0);
  if (sum <= 1.5) return rows;
  return rows.map((r) => ({ ...r, amountPct: r.amountPct / 100 }));
}

/**
 * Top-100 decrease in percent, COHORT semantics (Metis decision — a
 * common-address join under-reports full sell-outs): the cohort is the previous
 * snapshot's full address set — exchange-classified addresses included, the
 * equivalent of Nansen's "Include exchange-classified addresses in the current
 * Top 100 cohort" toggle always ON. sumCurr sums the SAME addresses in curr
 * and counts 0 for any that left the top 100 (fully exited).
 * Returns undefined when prev/curr are missing or sumPrev ≤ 0.
 */
export function t100Decrease(
  prevRows: HolderRow[] | undefined,
  currRows: HolderRow[] | undefined,
): number | undefined {
  if (!prevRows || !currRows) return undefined;
  const cohort = prevRows;
  const sumPrev = cohort.reduce((acc, r) => acc + r.amountPct, 0);
  if (sumPrev <= 0) return undefined;
  const currByAddr = new Map<string, number>();
  for (const r of currRows) currByAddr.set(r.address, r.amountPct);
  let sumCurr = 0;
  for (const r of cohort) sumCurr += currByAddr.get(r.address) ?? 0;
  return ((sumPrev - sumCurr) / sumPrev) * 100;
}

/**
 * T100 sliding MAX DRAWDOWN (user 2026-09-25, REPLACES the genesis-leftmost A/B
 * leak): over `deploy -> now`, the deepest peak-to-trough decline —
 *   peak     = running maximum, raised BEFORE each point is measured,
 *   trough   = lowest balance strictly after that peak,
 *   pct      = max over t of (peak_t - total_t) / peak_t * 100,
 *   multiple = peak / trough,   peakAt = epoch ms of that peak.
 * The peak slides (not fixed to genesis), so it may move between passes.
 *
 * Zero rows dropped (pre-supply placeholders carry total=0 and would read as a
 * trough). 0 rows -> undefined; 1 row or no drawdown -> pct 0, multiple 1 (the
 * "chua xa" signal). Timestamps arrive mixed-shape, so parse defensively and
 * sort ascending. Granularity-agnostic, so the caller need not force DAILY.
 */
export function t100Mdd(
  points: { t: number | string; total: number }[],
): { pct: number; multiple: number; peak: number; trough: number; peakAt: number } | undefined {
  const rows = points
    .map((p) => ({ at: typeof p.t === 'number' ? p.t : Date.parse(String(p.t)), total: p.total }))
    .filter((p) => Number.isFinite(p.at) && p.total > 0)
    .sort((a, b) => a.at - b.at);
  if (rows.length === 0) return undefined;
  let peak = rows[0].total;
  let peakAt = rows[0].at;
  let bestPct = 0;
  let bestMultiple = 1;
  let bestPeak = peak;
  let bestPeakAt = peakAt;
  let bestTrough = peak;
  for (const r of rows) {
    // Raise the peak BEFORE measuring, so a point that is itself a new high can
    // never be read as its own trough (dd >= 0 by construction).
    if (r.total > peak) {
      peak = r.total;
      peakAt = r.at;
    }
    if (peak <= 0) continue;
    const pct = ((peak - r.total) / peak) * 100;
    if (pct > bestPct) {
      bestPct = pct;
      bestMultiple = peak / r.total;
      bestPeak = peak;
      bestPeakAt = peakAt;
      bestTrough = r.total;
    }
  }
  // No drawdown anywhere: `peak` now holds the global max — return it as both ends
  // so `multiple` stays exactly 1 and the column keeps its "chua xa" meaning.
  if (bestPct === 0) return { pct: 0, multiple: 1, peak, trough: peak, peakAt };
  return { pct: bestPct, multiple: bestMultiple, peak: bestPeak, trough: bestTrough, peakAt: bestPeakAt };
}

/**
 * LF (user 2026-09-11, REPLACES the anchor-day / closest-day rule): genesis_bal
 * = the LEFTMOST (earliest) total>0 point of the label='exchange' chart at its
 * highest timeframe — the float the app's token tab=exchanges plots at the far
 * left of the chart. Pre-listing exchange rows carry total=0 (supply does not
 * exist yet), so the earliest total>0 row IS the listing float. None anywhere ->
 * undefined -> caller keeps the previous value.
 *
 * `minAt` là mốc bucket deploy do caller chọn (0 = không clamp). Các rung từ
 * month có thể back-fill bucket pre-genesis bằng hằng số DƯƠNG; không clamp sẽ
 * chọn filler thay vì listing float. Caller dùng UTC hour/day floor, không dùng
 * timestamp intraday vì dữ liệu daily của ngày deploy nằm tại 00:00.
 * Chỉ bỏ bucket trước mốc này; giữ bucket chứa thời điểm deploy.
 */
export function exchangeAnchorLf(
  points: { t: number | string; total: number }[],
  minAt = 0,
): { total: number; at: string } | undefined {
  let first: { t: number; total: number } | undefined;
  for (const p of points) {
    const at = typeof p.t === 'number' ? p.t : Date.parse(String(p.t));
    if (!Number.isFinite(at) || !(p.total > 0) || at < minAt) continue;
    if (!first || at < first.t) first = { t: at, total: p.total };
  }
  return first && { total: first.total, at: new Date(first.t).toISOString() };
}

/** The app's granularity rungs, in FE order (1D 7D 30D 3M 1Y). */
export type TfRung = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * A series is only usable if it reaches back to the `from` it was asked for.
 * `nansenSeries` accepts any 200 carrying an array, so a throttled/coarser response
 * that starts later slips through and its leftmost is read as the listing float
 * (KNOTS wrote 45.67M where the chart reads 616.08M, 2026-09-21). Slack absorbs
 * bucket-edge rounding.
 */
export function seriesReachesStart(
  points: { t: number | string }[],
  expectedFrom: number,
  slackMs = 86_400_000,
): boolean {
  let earliest = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const at = typeof p.t === 'number' ? p.t : Date.parse(String(p.t));
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  return earliest <= expectedFrom + slackMs;
}

/**
 * The highest TF the FE enables for a token (user 2026-09-18). Probed on the live
 * toggle: `7D` disabled at age 0.74d, enabled at 1.17d ⇒ rung N unlocks at the
 * NEXT-SMALLER rung's span, and 1Y is the cap ('all' works in the API, unused).
 *
 * The rung picks the window SPAN (`RUNG_SPAN_DAYS`), never the wire form: the fetch is
 * a `{from,to}` range clamped to the deploy (see `seriesFromMs`), because the sugar
 * string always starts at `now - span` and so brings back the pre-genesis back-fill —
 * that filler anchored T100 on itself and left `anchor_at` BEFORE the deploy (KNOTS
 * anchor_at 2026-08-22 vs deployed_at 2026-09-05, 2026-09-21).
 */
const TF_RUNGS: readonly { rung: TfRung; unlockDays: number }[] = [
  { rung: 'day', unlockDays: 0 },
  { rung: 'week', unlockDays: 1 },
  { rung: 'month', unlockDays: 7 },
  { rung: 'quarter', unlockDays: 30 },
  { rung: 'year', unlockDays: 90 },
];

/** A rung's window span in days — the same chart TFs the FE toggles (24h/7D/30D/90D/1Y). */
export const RUNG_SPAN_DAYS: Record<TfRung, number> = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };

/**
 * The `from` to send for a series fetch: the window, but never before the deploy — a
 * token's rows cannot predate its listing, and any bucket before it is API back-fill.
 * 0/null/undefined (unknown deploy) → the window alone, no clamp.
 */
export function seriesFromMs(now: number, deployedAt: number | null | undefined, capMs: number): number {
  return Math.max(now - capMs, deployedAt || 0);
}

/**
 * The LF ladder, widest → narrowest, mirroring the chart's own TF list (user
 * 2026-09-21: "1Y, 180D, 90D, 30D, 7D, 24h"). Each window is fetched as a `{from,to}`
 * RANGE clamped to `deployed_at`, never as a sugar rung: a sugar rung always starts at
 * `now - span`, so a young token gets pre-genesis filler AND coarse DAILY buckets, and
 * its first post-deploy bucket is not the listing float (KNOTS 45.67M vs the user's
 * 616.08M). A range starting at the deploy has no pre-genesis rows and hourly buckets
 * at genesis — the read behind every user-confirmed value (POT 128.89M @ 09-16T02:00,
 * LOCKINU 47.93M, PAID 52.03M). Replaces the 2026-09-18 sugar-rung swap.
 */
export const LF_WINDOWS: readonly { label: string; days: number }[] = [
  { label: '1Y', days: 365 },
  { label: '180D', days: 180 },
  { label: '90D', days: 90 },
  { label: '30D', days: 30 },
  { label: '7D', days: 7 },
  { label: '24h', days: 1 },
];

/** Highest rung unlocked at this age (days); unknown/negative/NaN age → 'day'. */
export function tfFor(ageDays: number): TfRung {
  let out: TfRung = TF_RUNGS[0]!.rung;
  for (const r of TF_RUNGS) if (ageDays >= r.unlockDays) out = r.rung;
  return out;
}

/** top10_rate: Σ percentOwnership of the first 10 rows (balance-desc) × 100 → percent. */
export function top10RateOfRows(rows: HolderRow[]): number | undefined {
  if (rows.length === 0) return undefined;
  return rows.slice(0, 10).reduce((acc, r) => acc + r.amountPct, 0) * 100;
}
