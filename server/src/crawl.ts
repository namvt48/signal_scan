// Browser-transport crawler helpers (DB-backed chart/series layer).
//
// The browser DOOR POOL, the browserless WS transport and the ipify egress-IP
// probe live in `gateway/door.ts` (plan request-plane-gateway, todo 10) — the
// gateway is the single authority, and that module is DB-free so the gateway
// never pulls this instance's DB. THIS file keeps the db/poller-backed series
// helpers (`nansenSeries`, `balanceSeries`, `hourlyStatsToPoints`) and
// re-exports the moved door surface for back-compat: the existing
// door-importing tests import those symbols from `./crawl.js`.
//
// Import direction is one-way — crawl.ts imports from gateway/door.ts, never
// the reverse — so there is no module cycle.

import {
  hourlyStatsBody,
  NANSEN_HOURLY_STATS_URL,
  type HourlyStatsRow,
  type SeriesDate,
} from './providers/nansen.js';
import { snapshotSeries } from './detail.js';
import { getNansenSeries, nansenSeriesCachedAt } from './db.js';
import { cacheSeriesWindows, kickNansen } from './poller.js';
import { getSetupCacheEntry, isSetupCacheFresh } from './setup-cache.js';
import type { Chain } from './shared/chain.js';
import { log } from './log.js';
// A re-export below is NOT a local binding, so the internal caller
// (`nansenSeries`) imports `browserPostJson` explicitly here.
import { browserPostJson } from './gateway/door.js';

// Back-compat re-export shim (plan request-plane-gateway, todo 10): the DoorPool
// + transport moved to `gateway/door.ts`; consumers/tests keep importing the
// same names from here. Types use `export type` so the runtime module has no
// phantom value exports.
export {
  DoorPool,
  setPoolForTest,
  poolStatsOrNull,
  browserPostJson,
  classify,
  parseProxyFile,
} from './gateway/door.js';
export type {
  Classification,
  DoorConn,
  DoorHttpResponse,
  DoorPoolConfig,
  DoorPoolDeps,
  DoorSpec,
  ProxySpec,
} from './gateway/door.js';

export interface BalancePoint {
  t: number | string;
  total: number;
  totalUsd?: number;
  /** totalHolders of the top-100 cohort at this hour (row field may be absent). */
  holders?: number;
  /** Σ totalInflows this hour, TOKEN UNITS (row field may be absent). */
  inflow?: number;
}

/**
 * Fail fast while the sidecar is sick: a dead page costs 30–45s per call and one
 * sweep retries every CA, which is how an OOM'd Chrome stretched a 5-min pass into
 * 64 min. Kept exported (crawl-breaker.test.ts); the door pool now supersedes it
 * in the live path — per-door transport-fail retirement replaces the global
 * breaker + page-rebuild loop.
 */
export function createCircuitBreaker(failureLimit: number, cooldownMs: number) {
  let failures = 0;
  let openUntil = 0;
  return {
    open: (): boolean => Date.now() < openUntil,
    ok: (): void => {
      failures = 0;
    },
    fail: (): void => {
      if (++failures < failureLimit) return;
      failures = 0;
      openUntil = Date.now() + cooldownMs;
      log.error(`[crawl] ${failureLimit} transport failures — pausing browser requests ${cooldownMs}ms`);
    },
  };
}

/** Pure: hourly-stats rows → chart points (holders/inflow only when finite). */
export function hourlyStatsToPoints(rows: HourlyStatsRow[]): BalancePoint[] {
  return rows
    .filter((r) => typeof r.totalBalance === 'number' && Number.isFinite(r.totalBalance))
    .map((r) => ({
      t: r.blockDate ?? '',
      total: r.totalBalance as number,
      ...(typeof r.totalBalanceUsd === 'number' ? { totalUsd: r.totalBalanceUsd } : {}),
      ...(typeof r.totalHolders === 'number' && Number.isFinite(r.totalHolders) ? { holders: r.totalHolders } : {}),
      ...(typeof r.totalInflows === 'number' && Number.isFinite(r.totalInflows) ? { inflow: r.totalInflows } : {}),
    }));
}

/** LEGACY free-door path (superseded by the official tgm/flows door for T100/LF
 * 2026-09-23) — kept for the probe scripts; no production caller remains. */
export async function nansenSeries(ca: string, chain: Chain, date: SeriesDate, label = 'top_100_holders'): Promise<BalancePoint[]> {
  const { status, json } = await browserPostJson<{ data?: HourlyStatsRow[] }>(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, chain, date, false, label));
  const rows = (json as { data?: HourlyStatsRow[] } | null)?.data;
  if (status !== 200 || !Array.isArray(rows)) throw new Error(`nansen chart ${status}`);
  return hourlyStatsToPoints(rows);
}

/**
 * Balance chart series (top-100 total balance, token units).
 * Primary: Nansen hourly-stats through the browser sidecar.
 * Fallback: our own hourly snapshots (short history, grows over time).
 */
/**
 * CACHE-ONLY endpoint: setupSweep là writer duy nhất (một pass 12h paced trên
 * toàn bộ queue) — dashboard click KHÔNG BAO GIỜ sinh request lên Nansen. Cache
 * miss (CA chưa đến lượt sweep) -> phục series snapshot nội bộ tạm thời.
 */
export async function balanceSeries(
  ca: string,
  chain: Chain,
  window: 'day' | 'week' | 'month',
): Promise<{ source: 'nansen' | 'snapshots'; points: BalancePoint[]; cachedAt?: number }> {
  let cachedAt = nansenSeriesCachedAt(ca, chain, window);
  let cached = getNansenSeries(ca, chain, window);
  // FILE-cache fallback (plan setup-fill-on-add §4): a DB-table reset wipes
  // nansen_series, but data/nansen-cache.json survives — replay a FRESH entry
  // through the SAME window slicer the fetch path uses instead of degrading to
  // internal snapshots or kicking a door refetch.
  if (cached.length <= 1) {
    const e = getSetupCacheEntry(ca, chain);
    // Payload guard (2026-09-29): an always-written entry can be `taken_at`-fresh with
    // an EMPTY series (an empty fetch pass writes one so its markers have a home) —
    // replaying it would log a false "replayed chart windows" and buy nothing.
    if (e && e.series.length > 0 && isSetupCacheFresh(e, Date.now())) {
      cacheSeriesWindows(ca, chain, e.series, e.taken_at);
      log.info(`[setup-cache] replayed ${ca.slice(0, 8)} (${chain}) chart windows from the file cache`);
      cachedAt = nansenSeriesCachedAt(ca, chain, window);
      cached = getNansenSeries(ca, chain, window);
    }
  }
  // Stale top-up: serve the cache immediately but kick a background refresh so
  // the series converges toward Nansen live within one sweep interval.
  if (cachedAt !== undefined && Date.now() - cachedAt > 3_600_000) kickNansen(ca, chain);
  const atMs = (p: BalancePoint) => (typeof p.t === 'number' ? p.t : Date.parse(String(p.t)));
  if (cached.length > 1) return { source: 'nansen', points: cached.sort((a, b) => atMs(a) - atMs(b)), cachedAt };
  const since = Date.now() - (window === 'day' ? 86_400_000 : window === 'week' ? 7 * 86_400_000 : 30 * 86_400_000);
  return { source: 'snapshots', points: snapshotSeries(ca, chain, since), cachedAt };
}
