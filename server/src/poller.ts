// Self-scheduling poll loops. setTimeout-after-completion instead of
// setInterval (Metis blocker): a slow upstream can never overlap runs and pile
// up against the rate limiter. ONE shared provider instance — constructing a
// provider per sweep would double the leaky buckets.

import { CA_INFLOW_WINDOW_MS, SNAPSHOT_RETENTION_MS, TRACKED_BY_WINDOW_MS, config } from './config.js';
import type { Chain } from './shared/chain.js';
import {
  deleteSnapshotsBefore,
  deleteTrackedCasByIds,
  findTrackedCa,
  getSetting,
  getTokenState,
  listCaScoreGateCandidates,
  listCaTargetsMissingEssential,
  listCaTargetsMissingIcon,
  listCaTargetsMissingSymbol,
  listTrackedCas,
  pruneTrackedByNone,
  pruneUntrackedCas,
  trackedByPairs,
  watchedCasForWallet,
  upsertNansenSeries,
  type CaScoreGateRow,
  type CaTarget,
  type TokenStateRow,
  type WalletRow,
} from './db.js';
import { replaceWalletBalances, updateNansenHolders, updateTokenAnalytics, updateTokenMetrics, upsertTokenInfo } from './ingest.js';
import type { BalancePoint } from './crawl.js';
import {
  cacheKey,
  getSetupCacheEntry,
  isInfoFresh,
  isSeriesFresh,
  pruneSetupCache,
  putSetupCacheEntry,
  setupCacheSize,
  stampSetupCacheField,
  type SetupCacheEntry,
} from './setup-cache.js';
import { type NansenApiClient, type BalanceRange, type StatWindow, type TgmFlowsRow, type TokenFlowsClient } from './providers/nansen.js';
import { exchangeAnchorLf, RUNG_SPAN_DAYS, seriesReachesStart, t100Mdd } from './snapshot.js';
import { nansenScore } from './signals.js';
import { getThresholds } from './settings.js';
import type { MarketDataProvider, MetricKind, MetricPatch } from './providers/provider.js';
import { fetchIcons } from './providers/dexscreener.js';
import { log } from './log.js';

interface PollTask {
  name: string;
  intervalMs: number;
  /** Override for the i*20s boot stagger — setupSweep phase-locks to systemDeployAt. */
  initialDelayMs?: number;
  fn: () => Promise<void>;
}

/**
 * Fixed-rate pacing: item i starts no earlier than one slot after item i-1, so a
 * slow request CONSUMES its slot instead of adding the slot on top of it. The
 * old gap-after-request form made every pass cost an extra n×requestCost, which
 * is what pushed the 15m tiers past their own interval (measured: 1007s against
 * a 900s interval = 720s of slots + 299s of request time). The average rate —
 * the thing that keeps us off 429/CF-403 bans — is unchanged.
 */
export async function pacedFor<T>(items: readonly T[], intervalMs: number, fn: (item: T) => Promise<void>): Promise<void> {
  const slotMs = Math.max(250, Math.round((intervalMs * config.sweepPaceFactor) / Math.max(1, items.length)));
  let nextAt = Date.now();
  for (let i = 0; i < items.length; i++) {
    await fn(items[i]!);
    nextAt += slotMs;
    const wait = nextAt - Date.now();
    if (i < items.length - 1 && wait > 0) await sleep(wait);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A CA added inside newCaPriorityMs jumps the queue on every free sweep, so a
 * fresh add is not stuck behind a long paced list (user 2026-09-22). Stable:
 * both partitions keep their input order.
 */
function isNewCa(addedAt: string | undefined, cutoff: number): boolean {
  return addedAt !== undefined && Date.parse(addedAt) >= cutoff;
}

function newCasFirst<T extends { added_at?: string }>(rows: readonly T[]): T[] {
  const cutoff = Date.now() - config.newCaPriorityMs;
  return [...rows.filter((r) => isNewCa(r.added_at, cutoff)), ...rows.filter((r) => !isNewCa(r.added_at, cutoff))];
}

/**
 * Same jump-the-queue rule as newCasFirst, but for the (CA, wallet) pairs the
 * holdings sweep walks — a pair carries its CA's address, not its added_at, and
 * trackedByPairs orders by wallet name so the CA recency never survives into it.
 */
function newCaPairsFirst<T extends { ca: string }>(
  tracked: readonly { address: string; added_at?: string }[],
  pairs: readonly T[],
): T[] {
  const cutoff = Date.now() - config.newCaPriorityMs;
  const fresh = new Set(tracked.filter((c) => isNewCa(c.added_at, cutoff)).map((c) => c.address));
  return [...pairs.filter((p) => fresh.has(p.ca)), ...pairs.filter((p) => !fresh.has(p.ca))];
}

/**
 * ONE free app-question per (CA, kind); each kind owns its cadence and columns.
 * Covers the whole tracked queue; `only` pins an explicit list instead — the
 * essential gap re-ask uses it.
 */
async function metricSweep(
  provider: MarketDataProvider,
  kind: MetricKind,
  intervalMs: number,
  only?: readonly CaTarget[],
): Promise<void> {
  const cas = only ?? newCasFirst(listTrackedCas());
  await pacedFor(cas, intervalMs, async (c) => {
    try {
      const patch = kind === 'essential'
        ? await withRetry(() => provider.metric(c.address, c.chain, kind), config.essentialRetries)
        : await provider.metric(c.address, c.chain, kind);
      if (kind === 'volume') applyVolumeDelta(c.address, c.chain, patch);
      updateTokenMetrics(c.address, c.chain, patch);
    } catch (e) {
      log.error(`[poller] ${kind}Sweep`, c.address, e);
    }
  });
}

/**
 * vol_1h = the volume24h growth since the previous sweep (user 2026-09-22): ONE
 * endpoint call per hour now. A delta over a much longer gap would overstate an
 * hour (skip it — COALESCE keeps the last value), and the first ever sweep has no
 * base. The fresh reading + its timestamp are always stored as the next base.
 */
export function applyVolumeDelta(ca: string, chain: Chain, patch: MetricPatch): void {
  if (patch.volume24h === undefined) return;
  const st = getTokenState(ca, chain);
  const prev = st?.vol_24h_prev;
  const prevAt = st?.vol_24h_prev_at;
  const now = Date.now();
  if (prev != null && prevAt != null) {
    const dt = now - prevAt;
    // A provider that returns a REAL 1h figure (GMGN) keeps it; the delta is only
    // the fallback for providers that omit it (Nansen mode).
    if (patch.volume1h === undefined && dt >= 1_800_000 && dt <= 7_200_000) {
      patch.volume1h = Math.max(0, patch.volume24h - prev);
    }
  }
  patch.vol24hPrev = patch.volume24h;
  patch.vol24hPrevAt = now;
}

/**
 * Ticker floor. `symbol` is written only by essential-data, which rides the browser
 * door — so while CF or a sick Chrome blocks it, every CA renders "—" on the
 * dashboard. This sweep reads the mint from the Solana RPC instead (no browser, no
 * Nansen credits — but getAsset costs 10 DAS credits/call, hence the window bound)
 * and writes ONLY symbol, so it can never mask the essential pass: the gap re-ask
 * is gated on `supply IS NULL`, which stays true.
 */
async function symbolBackfillSweep(provider: MarketDataProvider): Promise<void> {
  const cas = listCaTargetsMissingSymbol(config.symbolBackfillWindowMs);
  if (cas.length === 0) return;
  await pacedFor(cas, config.pollSymbolBackfillMs, async (c) => {
    try {
      const info = await provider.assetInfo?.(c.address, c.chain);
      if (info?.symbol !== undefined) updateTokenMetrics(c.address, c.chain, { symbol: info.symbol });
    } catch (e) {
      log.error('[poller] symbolBackfill', c.address, e);
    }
  });
}

/**
 * Token-icon backfill (DexScreener, keyless + free — deliberately OUTSIDE the
 * MarketDataProvider seam so icons keep landing in every MODE, including when
 * Nansen credits are exhausted). NOT pacedFor-shaped: one batch call covers
 * ≤30 CAs, so fetchIcons walks the chunks sequentially and the await chain IS
 * the pacing — per-item slots exist to protect per-CA rate-limited doors, and
 * this door has none. fetchIcons never throws (a failed chunk = no icons for
 * that chunk; the next sweep is the durable retry).
 *
 * ponytail: a mint with no DEX pair returns no icon and stays NULL, so it is
 * re-asked every sweep — cheap while one call covers 30 CAs. Ceiling: if the
 * icon-less queue ever dominates the sweep, store '' as a checked-and-empty
 * sentinel or add an icon_checked_at column to suppress the re-ask.
 */
async function iconSweep(): Promise<void> {
  const cas = listCaTargetsMissingIcon(config.iconWindowMs);
  if (cas.length === 0) return;
  const icons = await fetchIcons(cas.map((c) => c.address));
  for (const c of cas) {
    const iconUrl = icons.get(c.address);
    if (iconUrl !== undefined) updateTokenMetrics(c.address, c.chain, { iconUrl });
  }
}

/**
 * essential-data is the ONLY source of supply (the LF denominator) and of
 * deployed_at, and both are write-once: a single CF 403 would leave that CA dark
 * until the next 24h pass, so retry inside the pass before giving up.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  const tries = Math.max(1, attempts);
  let lastError: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < tries - 1) await sleep(3_000);
    }
  }
  throw lastError;
}

// --- official tgm/flows door (T100 + LF since 2026-09-23) ---------------------
// Narrow TokenFlowsClient seam: setPollerDeps derives it from the NansenApiClient
// (production) or a counting test stub. null = no NANSEN_API_KEY → both fetches
// keep previous values and every other metric keeps running.
let tokenFlowsClient: TokenFlowsClient | null = null;
let tokenFlowsWarned = false;

function flowsClient(): TokenFlowsClient | null {
  if (tokenFlowsClient) return tokenFlowsClient;
  if (!tokenFlowsWarned) {
    tokenFlowsWarned = true;
    log.warn('[poller] NANSEN_API_KEY absent — official tgm/flows unavailable; T100/LF keep previous values');
  }
  return null;
}

/** tgm/flows rows → chart points. A missing date maps to '' — every reader
 * (t100Mdd/exchangeAnchorLf/seriesReachesStart/cacheSeriesWindows) parses
 * timestamps defensively and drops unparseable rows. */
function flowsToPoints(rows: readonly TgmFlowsRow[]): BalancePoint[] {
  const points: BalancePoint[] = [];
  for (const r of rows) {
    if (typeof r.token_amount !== 'number' || !Number.isFinite(r.token_amount)) continue;
    points.push({ t: r.date ?? '', total: r.token_amount });
  }
  return points;
}

/** tgm/flows rows → T100 A/B candidates: finite balances only. `holders_count` is
 * NOT a discriminator (the API leaves it 0 on virtually every DAILY row — measured
 * 2/31 daily rows for a 30d token); the pre-genesis back-fill is excluded by a DATE
 * clamp at the deploy bucket in `seriesAtRung`, not here. */
function t100RealPoints(rows: readonly TgmFlowsRow[]): BalancePoint[] {
  const points: BalancePoint[] = [];
  for (const r of rows) {
    if (typeof r.token_amount !== 'number' || !Number.isFinite(r.token_amount)) continue;
    points.push({ t: r.date ?? '', total: r.token_amount });
  }
  return points;
}

/** Pre-genesis back-fill detector: the API fills every bucket before genesis with ONE
 * positive constant AND `holders_count` 0, so a series that never leaves its first
 * value while carrying no holders anywhere is that filler — it holds no delta and must
 * never become the chart (measured 2026-09-23: THERANOS 963,581,533 across all 30 daily
 * buckets, inucrypted 999,915,963, both holders 0 throughout — EVIDENCE §16b). A flat
 * series WITH holders (>0) is real data and is kept. */
function isBackFill(rows: readonly TgmFlowsRow[]): boolean {
  const real = rows.filter((r) => typeof r.token_amount === 'number' && Number.isFinite(r.token_amount) && r.token_amount > 0);
  const first = real[0];
  if (!first || real.length < 2) return false;
  return real.every((r) => r.token_amount === first.token_amount) && real.every((r) => !(Number(r.holders_count) > 0));
}

/**
 * The LF = the exchange chart's LEFTMOST point. Fetched only while UNKNOWN —
 * applySeriesPass skips the 1-credit call once genesis_bal is set and the setup
 * cache carries exchange points (the leftmost is a deterministic read at a fixed
 * window, 5/5 identical fetches, so a repeat buys nothing). When it does run the
 * value is ALWAYS written: the old ≥10% overwrite guard only ever
 * froze a stale value: GERI stored 758.56M while the chart read 824.2M (8.65%
 * off, under the guard) and could never heal. A fetch failure keeps the previous
 * value instead of clearing the column.
 *
 * The window is walked widest → narrowest and sent as a `{from,to}` RANGE clamped
 * to `deployed_at`, not as a sugar rung: a sugar rung always starts at `now - span`,
 * so a young token gets pre-genesis filler AND coarse daily buckets — its first
 * post-deploy bucket read 45.67M for KNOTS where the user's chart reads 616.08M
 * (2026-09-21). A range from the deploy has no pre-genesis rows and hourly buckets at
 * genesis, the read behind every user-confirmed value (POT 128.89M @ 09-16T02:00).
 */
async function exchangeLf(ca: string, chain: Chain, deployedAt?: number | null): Promise<{ total: number; points: BalancePoint[] } | undefined> {
  // Không có deployed_at ⇒ không biết genesis nằm đâu — giữ nguyên giá trị cũ (94/152
  // dòng LF hiện thuộc nhóm này — xem EVIDENCE-2026-09-21-lf-range-form-restore.md).
  if (!deployedAt) return undefined;
  const client = flowsClient();
  if (!client) return undefined;
  const now = Date.now();
  try {
    // ONE official tgm/flows call, deploy → now, label=exchange. The LF_WINDOWS
    // widest→narrowest ladder is no longer on the prod path (snapshot.ts keeps it
    // for the debug probe + invariant tests). `to` is capped so the range always
    // fits the API's most-recent-1000-bucket window (a deploy→now range on a
    // >1000d token would otherwise truncate the OLD end and lose genesis).
    // RISK: ranges >7d come back DAILY.
    const to = Math.min(deployedAt + 999 * 86_400_000, now);
    const rows = await client.tokenFlows({
      chain,
      token_address: ca,
      date: { from: new Date(deployedAt).toISOString(), to: new Date(to).toISOString() },
      label: 'exchange',
    });
    const points = flowsToPoints(rows);
    if (!seriesReachesStart(points, deployedAt)) {
      log.error('[poller] genesisLF series cut ngan hon cua so xin, keep previous', ca.slice(0, 8), 'n=' + points.length);
      return undefined;
    }
    const lf = exchangeAnchorLf(points, deployedAt);
    if (lf) return { total: lf.total, points };
    log.warn('[poller] genesisLF no exchange row, keep previous', ca.slice(0, 8));
    return undefined;
  } catch (e) {
    // A throw aborts the single call (the old 429/403 early-abort semantics) —
    // never swallowed silently: log, keep the previous value.
    log.error('[poller] genesisLF flows call failed, keep previous', ca.slice(0, 8), String(e).slice(0, 120));
    return undefined;
  }
}

/** updateTokenAnalytics clears on undefined — carry the analytics columns through. */
function passThroughAnalytics(st: TokenStateRow): { t100Pct?: number; t100Multiple?: number; genesisBal?: number; anchorAt?: number } {
  return {
    t100Pct: st.t100_pct ?? undefined,
    t100Multiple: st.t100_multiple ?? undefined,
    genesisBal: st.genesis_bal ?? undefined,
    anchorAt: st.anchor_at ?? undefined,
  };
}

/** Attempts that produced no setup, per cacheKey — the empty-CA backoff ladder. */
const setupMisses = new Map<string, { misses: number; nextAt: number }>();
/** An empty CA is never re-asked faster than this, whatever POLL_SETUP_RETRY_MS says. */
const SETUP_RETRY_MIN_MS = 60_000;
/** Ceiling of the miss ladder, deliberately NOT POLL_SETUP_MS: that is now 1h, so
 * capping there would make a CA whose setup keeps coming back empty retry every
 * hour forever instead of backing off. 12h keeps the ladder meaningful. */
const SETUP_RETRY_MAX_MS = 43_200_000;

function setupRetryDelayMs(misses: number): number {
  return Math.min(SETUP_RETRY_MAX_MS, Math.max(SETUP_RETRY_MIN_MS, config.pollSetupRetryMs * 2 ** misses));
}

/** Still owed setup data: no cache entry, or one whose gini/fresh% field is past its
 * 6h TTL. Gini has its own clock (isInfoFresh); the T100 series has its own 12h clock
 * (isSeriesFresh) and refreshes independently via flowsSweep. */
function needsSetup(c: CaTarget, now: number): boolean {
  const miss = setupMisses.get(cacheKey(c.address, c.chain));
  if (miss && now < miss.nextAt) return false;
  const cached = getSetupCacheEntry(c.address, c.chain);
  return !cached || !isInfoFresh(cached, now);
}

/** Too young to retry fast: Nansen indexes a fresh mint only after some hours, so
 * a token whose age — deployed_at, or the CA's added_at while deploy is unknown —
 * is under NEW_TOKEN_MIN_AGE_MS gets flat hourly spacing instead of the ladder /
 * the 5-min essential gap re-ask. Neither timestamp known → NOT too-new, so a CA
 * can never be throttled into a stuck state. */
function isTooNewToken(address: string, chain: Chain, now: number): boolean {
  const basis = getTokenState(address, chain)?.deployed_at ?? Date.parse(findTrackedCa(address, chain)?.added_at ?? '');
  return Number.isFinite(basis) && now - basis < config.newTokenMinAgeMs;
}

/**
 * The setup pass — ONE paced walk over the CAs the pass still owes setup data to
 * (fresh% / T100 / LF / series). A CA that comes back EMPTY (brand-new token, no
 * Nansen data yet) backs off on a doubling ladder so it is never hammered; a FULL
 * pass lands a fresh cache entry, which is what parks that CA on the 12h cadence.
 * Per CA it writes the free gini-stats setup card (fresh% / T100 supply / median
 * buy) and then the hourly-stats series: the T100 leftmost→trough pair, the
 * genesis timestamp, the Bal 24H/7D/30D extremes and the chart cache rows.
 * Grouping both into one pass makes the setup indicators land together (user
 * 2026-09-22).
 *
 * EXPORTED for the prune regression test only — same seam precedent as
 * refreshSeries/pacedFor; the scheduler stays the sole production caller.
 */
export async function setupSweep(provider: MarketDataProvider): Promise<void> {
  const now = Date.now();
  const tracked = listTrackedCas();
  const all = newCasFirst(tracked).filter((c) => needsSetup(c, now));
  if (tracked.length > 0 && setupCacheSize() === 0) {
    log.warn('[poller] setup cache EMPTY with', tracked.length, 'tracked CA(s) — backfill capped per pass');
  }
  // A cold cache would otherwise backfill the whole queue in one pass — each CA
  // costs ≥1 credit, so trickle: the cap bounds the burst, the rest wait the next pass.
  const cas = all.slice(0, config.setupPassCap);
  if (all.length > cas.length) {
    log.warn('[poller] setup pass capped to', cas.length, 'of', all.length, 'CA(s)');
  }
  await pacedFor(cas, config.pollSetupRetryMs, async (c) => {
    const key = cacheKey(c.address, c.chain);
    try {
      const patch = await provider.metric(c.address, c.chain, 'gini');
      updateTokenMetrics(c.address, c.chain, patch);
      // Owner rule: the marker means "we OBTAINED the field", not "we called". A
      // DAS-floor / not-indexed gini pass resolves with NO nansenFreshPct — stamping
      // it would park the CA on the 6h clock with an empty field. Empty data must NOT
      // stamp, so the CA keeps its retry ladder.
      if (typeof patch.nansenFreshPct === 'number' && Number.isFinite(patch.nansenFreshPct)) {
        stampSetupCacheField(c.address, c.chain, 'info_at', Date.now());
      }
    } catch (e) {
      log.error('[poller] setupSweep gini', c.address, e);
    }
    try {
      await refreshSeries(c.address, c.chain);
    } catch (e) {
      log.error('[poller] setupSweep series', c.address, e);
    }
    // A storable gini pass stamps info_at — that is the CA's ticket to the 6h
    // cadence. Anything else counts as a miss and doubles its next wait.
    const entry = getSetupCacheEntry(c.address, c.chain);
    if (entry && isInfoFresh(entry, now)) setupMisses.delete(key);
    else {
      const misses = (setupMisses.get(key)?.misses ?? 0) + 1;
      // Too-new token: flat hourly spacing — Nansen has not indexed the mint yet,
      // so the doubling ladder's fast early retries are pure credit spam. The
      // first attempt on add (kickSetupEarly) is untouched; only RETRIES throttle.
      const delayMs = isTooNewToken(c.address, c.chain, Date.now()) ? config.newTokenRetryMs : setupRetryDelayMs(misses);
      setupMisses.set(key, { misses, nextAt: Date.now() + delayMs });
    }
  });
  deleteSnapshotsBefore(now - SNAPSHOT_RETENTION_MS);
  // File-cache prune (plan setup-fill-on-add §4): drop entries whose CA left the
  // queue or aged past 7 cadences; the empty-set guard inside pruneSetupCache
  // keeps a just-reset DB from wiping the whole file.
  // F2 fix: prune against a FRESH tracked-set read, NOT the sweep-start `cas` —
  // this pass is paced across ~0.8 × POLL_SETUP_MS (~9.6h in prod), so a CA added
  // mid-sweep has already had its entry written by the early kick; the stale
  // snapshot deleted that legitimate fresh entry. Sync block: no await between
  // listTrackedCas() and pruneSetupCache(), so no new race window opens.
  const trackedKeysNow = new Set(listTrackedCas().map((c) => cacheKey(c.address, c.chain)));
  const dropped = pruneSetupCache(Date.now(), trackedKeysNow);
  if (dropped > 0) log.info(`[setup-cache] pruned ${dropped} entries`);
}

/**
 * One series fetch via the official tgm/flows door. The window is the token's
 * RETAINED life — `max(deployed_at, now - SERIES_MAX_WINDOW_DAYS) → now` (unknown
 * deploy → the last week ending now): analytics only ever see the last 365 days
 * (user 2026-09-25), so an old token's pre-window rows can never drive T100. That
 * also gives T100 the same horizon as the FE's widest rung, so the number in the
 * table is the number the chart shows (HYPER read x12.29 off a 2025-01 dump, x2.36
 * with the window back at a year). The FE chart, the bal_* extremes and
 * the file cache all read this one fetch — `cacheSeriesWindows` slices it back
 * down to its 24h/7d/30d windows by timestamp, so widening costs no extra call.
 * Granularity is strictly span-driven (measured 7.5d → hourly, 8.0d → daily) and a
 * 1..4 × 7-day chunk loop is deliberately NOT used: hourly is retained only ~11
 * days, so older chunks return 0 rows (LUV read 17.49 against the crawl's 1.05).
 * A primary that does not reach its requested start fails the reach guard → keep
 * previous values.
 *
 * T100 is the sliding max drawdown over that same window (user 2026-09-25),
 * deploy-DAY clamped so the pre-genesis back-fill drops while the genesis bucket
 * survives (its `date` 00:00 precedes `deployed_at`). `holders_count` is NOT a
 * discriminator — the API leaves it 0 on virtually every DAILY row — and MDD needs
 * no granularity discipline, so there is NO extra daily-forcing call at any age.
 * A failing read sets `t100 = []` (t100Mdd([]) → undefined → the caller keeps the
 * previous T100) and never fails the pass.
 */
/** One series fetch — points plus the window metadata the file cache stores. */
type SeriesAttempt = { rows: TgmFlowsRow[]; points: BalancePoint[] } | { why: string };

interface SeriesFetch {
  points: BalancePoint[];
  /** Epoch ms of the window start (deploy-anchored, floored at the window cap). */
  from: number;
  /** Deterministic window label for the file cache: '1W' ≤7d span, '1M' longer. */
  window: string;
  /** T100 max-drawdown candidates — the primary's RAW rows, deploy-day clamped. */
  t100: BalancePoint[];
}

/** Analytics retention: T100 (and the chart/file cache fed by the same fetch) only
 * see the last 365 days. Kept in step with the FE's widest rung (`RUNG_SPAN_DAYS.year`)
 * and comfortably inside the wire's ~1000-row budget. */
const SERIES_MAX_WINDOW_DAYS = 365;

async function seriesAtRung(ca: string, chain: Chain): Promise<SeriesFetch | undefined> {
  const client = flowsClient();
  if (!client) return undefined;
  const now = Date.now();
  const deployedAt = getTokenState(ca, chain)?.deployed_at;
  const dayMs = 86_400_000;
  const weekMs = RUNG_SPAN_DAYS.week * dayMs;
  const floor = now - SERIES_MAX_WINDOW_DAYS * dayMs;
  const from = deployedAt ? Math.max(deployedAt, floor) : now - weekMs;
  if (deployedAt && deployedAt < floor) {
    log.debug('[poller] deploy older than the', SERIES_MAX_WINDOW_DAYS, 'd window, series truncated', ca.slice(0, 8));
  }
  const end = now;
  // deploy in the future / nothing to fetch — keep previous values.
  if (end <= from) return undefined;
  try {
    // ONE attempt at a given request start. The deploy clamp (`t >= from`) is applied
    // AFTER the response, so the request itself may start EARLIER than the deploy.
    const attempt = async (reqFrom: number): Promise<SeriesAttempt> => {
      const rows = await client.tokenFlows({
        chain,
        token_address: ca,
        date: { from: new Date(reqFrom).toISOString(), to: new Date(end).toISOString() },
        label: 'top_100_holders',
      });
      // Clamp the pre-genesis constant back-fill out before anchoring.
      const points = flowsToPoints(rows).filter((p) => {
        const t = typeof p.t === 'number' ? p.t : Date.parse(p.t);
        return Number.isFinite(t) && t >= from;
      });
      if (!seriesReachesStart(points, from)) return { why: 'n=' + points.length };
      if (isBackFill(rows)) return { why: 'back-fill n=' + rows.length };
      return { rows, points };
    };
    // Span drives granularity (<8d → hourly, ≥8d → daily), and a young token's HOURLY
    // window can come back EMPTY where the SAME token has DAILY rows. Aborting on that
    // empty response used to cost the whole pass — chart, T100, anchor and cache kept
    // previous forever (CASES, 4.07d: 0 hourly rows against a real 30d daily series;
    // EVIDENCE 2026-09-23 §16b). Retry the SAME end widened to a month: the wider span
    // flips the wire granularity to daily. An old token cannot widen (its primary IS
    // already wider, `wideFrom === from`), so it never pays a second call for this.
    const wideFrom = Math.min(from, end - RUNG_SPAN_DAYS.month * dayMs);
    let got = await attempt(from);
    // Only a KNOWN deploy is worth retrying: with `deployed_at` unknown the LF is
    // unavailable anyway (exchangeLf needs the genesis) and the wider window would
    // return nothing but the pre-genesis back-fill, which isBackFill refuses — a call
    // that can never buy anything, once per kick.
    if (!('rows' in got) && deployedAt && wideFrom < from) {
      log.info('[poller] series short, retry as 30d daily', ca.slice(0, 8));
      got = await attempt(wideFrom);
    }
    if (!('rows' in got)) {
      log.error('[poller] series cut ngan hon cua so xin, keep previous', ca.slice(0, 8), got.why);
      return undefined;
    }
    const { rows, points } = got;
    // T100 source: the primary's OWN raw rows, clamped to the deploy DAY. The day
    // bucket is the looser of the two and so is right for hourly AND daily rows: it
    // drops every pre-genesis back-fill bucket while keeping the genesis bucket,
    // whose `date` 00:00 precedes `deployed_at`.
    const atMs = (p: BalancePoint): number => (typeof p.t === 'number' ? p.t : Date.parse(p.t));
    const anchorFloor = deployedAt ? Math.floor(deployedAt / dayMs) * dayMs : Number.NEGATIVE_INFINITY;
    const t100 = t100RealPoints(rows).filter((p) => {
      const t = atMs(p);
      return Number.isFinite(t) && t >= anchorFloor;
    });
    // <2 buckets can't show a drawdown, and a non-null t100_multiple flips
    // nansenScore.complete ⇒ zeroScoreGate would delete a still-filling newborn CA.
    return { points, from, window: end - from > weekMs ? '1M' : '1W', t100: t100.length < 2 ? [] : t100 };
  } catch (e) {
    log.error('[poller] seriesAtRung', ca.slice(0, 8), String(e).slice(0, 120));
    return undefined;
  }
}

/**
 * File-cache rehydrate (plan setup-fill-on-add §4): replay a FRESH entry's windows
 * through the same slicer the fetch path uses and write the derived columns straight
 * through — ZERO door requests. No-op when the token_state row is missing
 * (updateTokenAnalytics is an UPDATE — the essential sweep / kickToken creates the
 * row; a later pass applies the still-fresh entry). Returns the replayed bal
 * ranges, or undefined when nothing was applied.
 */
function applySetupCacheEntry(e: SetupCacheEntry): { d1?: BalanceRange; d7?: BalanceRange; d30?: BalanceRange } | undefined {
  if (!getTokenState(e.ca, e.chain)) {
    log.info(`[setup-cache] fresh entry ${e.ca.slice(0, 8)} (${e.chain}) waits — token_state row not created yet`);
    return undefined;
  }
  // Marker-only entry: no chart payload to replay. We must NOT fall through to
  // updateTokenAnalytics — it writes `?? null`, so replaying an empty payload would
  // WIPE bal_peak_*/bal_trough_* in token_state. The marker alone parks the CA.
  if (e.series.length === 0) {
    log.info(`[setup-cache] marker-only entry ${e.ca.slice(0, 8)} (${e.chain}) applied nothing — no payload to replay`);
    return undefined;
  }
  const bal = cacheSeriesWindows(e.ca, e.chain, e.series, e.taken_at);
  updateTokenAnalytics(e.ca, e.chain, {
    t100Pct: e.t100_pct,
    t100Multiple: e.t100_multiple,
    genesisBal: e.genesis_bal,
    anchorAt: e.anchor_at,
    bal,
  });
  log.info(`[setup-cache] applied ${e.ca.slice(0, 8)} (${e.chain}) from file cache — 0 door requests`);
  return bal;
}

/**
 * T100/bal/anchors for one CA, both read off the token's OWN FE rung span — one span
 * per token, the granularity the FE would actually be showing (user 2026-09-18) —
 * fetched as a deploy-clamped range (`seriesAtRung`). T100 always overwrites from
 * the fresh series; the LF's second request is skipped once the value is known and
 * cached (write-once credit guard in applySeriesPass).
 *
 * EXPORTED for the T4 early trigger and the rehydrate tests: awaits, one CA,
 * door-guarded by the file cache — while a FRESH entry exists this NEVER fetches
 * (plan setup-fill-on-add §4), and a completed fetch pass is offered to
 * putSetupCacheEntry (whose storable guard refuses incomplete passes).
 */
export async function refreshSeries(ca: string, chain: Chain): Promise<void> {
  const now = Date.now();
  const cached = getSetupCacheEntry(ca, chain);
  if (cached && isSeriesFresh(cached, now)) {
    applySetupCacheEntry(cached); // applies when the row exists, else waits — never fetches
    return;
  }
  const entry = await applySeriesPass(ca, chain, now);
  if (entry) putSetupCacheEntry(entry);
}

/**
 * Credit-only tgm/flows refresh on its own faster cadence (user 2026-09-24): T100
 * multiple, LF and the bal_* chart windows. No browser door — this is the REST
 * credit API — so it is paced against POLL_FLOWS_MS, not the door budget. Gini
 * (fresh%) stays on setupSweep's 1h cadence: the two refresh at different rates.
 *
 * Only CAs that still OWE a series are swept: an entry whose series_at marker is missing
 * or past 12h. No entry at all is setupSweep's job — it owns the setup pass cap
 * (config.setupPassCap) and the miss ladder (setupMisses). This is also the credit guard:
 * refreshSeries honors the per-field series_at marker, so a fresh entry costs 0
 * (and its LF write-once guard skips the exchange call). An always-fetch pass here
 * ignores that marker and re-buys every CA's T100+LF forever (measured leak:
 * 14 credits / 17 min ≈ 1170/day, 469 tracked CAs against only 124 cache entries).
 *
 * The old "a series write would keep gini permanently fresh" fear is gone with the
 * split per-field markers: applySeriesPass stamps only series_at and carries
 * info_at forward from prev?.info_at, so a flows write can never freeze gini's 6h
 * clock.
 *
 * EXPORTED for the credit-leak regression tests (same test-seam precedent as
 * setupSweep / refreshSeries / pacedFor).
 */
export async function flowsSweep(): Promise<void> {
  if (!flowsClient()) return;
  const now = Date.now();
  const cas = newCasFirst(listTrackedCas()).filter((c) => {
    const e = getSetupCacheEntry(c.address, c.chain);
    return e !== undefined && !isSeriesFresh(e, now);
  });
  await pacedFor(cas, config.pollFlowsMs, async (c) => {
    try {
      await refreshSeries(c.address, c.chain);
    } catch (e) {
      log.error('[poller] flowsSweep', c.address, e);
    }
  });
}

/** One flows pass: fetch the series → T100 multiple / LF / bal_* windows → DB.
 * Returns the setup-cache entry, or undefined when the token row does not exist
 * yet (the essential sweep creates it). */
async function applySeriesPass(ca: string, chain: Chain, now: number): Promise<SetupCacheEntry | undefined> {
  const st = getTokenState(ca, chain);
  if (!st) return undefined; // the essential sweep creates the row (supply + deployed_at)
  const fetched = await seriesAtRung(ca, chain);
  const series = fetched?.points;
  let { t100Pct, t100Multiple, anchorAt, genesisBal } = passThroughAnalytics(st);
  if (series) {
    const g = fetched ? t100Mdd(fetched.t100) : undefined;
    if (g) {
      t100Pct = g.pct;
      t100Multiple = g.multiple;
      anchorAt = g.peakAt;
    }
  }
  const bal = series ? cacheSeriesWindows(ca, chain, series, now) : passThroughBal(st);
  // LF write-once (credit guard): skip the 1-credit exchange fetch once genesis_bal
  // is known. `st.genesis_bal != null` already means the LF total was obtained; the
  // old `prev.exchange.length > 0` requirement existed ONLY because isStorable
  // refused an empty `exchange` — that invariant is gone, so requiring cached points
  // would merely re-buy the same 1-credit call forever.
  const prev = getSetupCacheEntry(ca, chain);
  const haveLf = st.genesis_bal != null && prev !== undefined;
  const lf = haveLf ? undefined : await exchangeLf(ca, chain, st.deployed_at);
  if (lf !== undefined) genesisBal = lf.total;
  updateTokenAnalytics(ca, chain, { t100Pct, t100Multiple, genesisBal, anchorAt, bal });
  return {
    ca,
    chain,
    taken_at: now,
    window: fetched?.window ?? '',
    series_from: fetched?.from,
    series: series ?? [],
    exchange: lf?.points ?? prev?.exchange ?? [],
    t100_pct: t100Pct,
    t100_multiple: t100Multiple,
    anchor_at: anchorAt,
    genesis_bal: genesisBal,
    // Carry the previous series marker FIRST; a fresh non-empty series then stamps
    // `now` over it. An empty pass therefore keeps prev.series_at (no fresh stamp,
    // an existing marker is never lost).
    ...(prev?.series_at !== undefined ? { series_at: prev.series_at } : {}),
    ...(series !== undefined && series.length > 0 ? { series_at: now } : {}),
    // Carry the gini stamp forward ONLY from prev.info_at: a series-only pass must
    // not fabricate one, so an unstamped entry stays eligible for the gini re-ask.
    ...(prev?.info_at !== undefined ? { info_at: prev.info_at } : {}),
  };
}

/**
 * Zero-score rejection gate (user 2026-09-21): a tracked CA whose data has
 * FULLY arrived (nansenScore.complete) while its Nansen setup scores 0/3 is a
 * dead symbol — delete it instead of tracking it forever. A CA a tracked wallet
 * still HOLDS is out of scope (user 2026-09-25) — that is filtered in
 * listCaScoreGateCandidates. An incomplete row is
 * deliberately left untouched (no flag, no write): the sweeps are still filling
 * it. Reads the SAME runtime thresholds assembleSignals uses, so a
 * PUT /api/settings moves the gate too. Wrapped end-to-end: a throw here can
 * never kill the wallet sweep.
 */
export function zeroScoreGate(): void {
  try {
    const th = getThresholds();
    const doomed: CaScoreGateRow[] = [];
    for (const row of listCaScoreGateCandidates()) {
      const s = nansenScore(getTokenState(row.address, row.chain), th);
      if (s.complete && s.score === 0) doomed.push(row);
    }
    for (const r of doomed) {
      log.warn(
        `[poller] rejected CA ${r.address} (${r.chain}) 0/3 symbol=${r.symbol} fresh=${r.nansen_fresh_pct} t100=${r.t100_multiple} lf=${r.genesis_bal} added=${r.added_at}`,
      );
    }
    if (doomed.length > 0) {
      const deleted = deleteTrackedCasByIds(doomed.map((r) => r.id));
      log.warn(`[poller] zero-score gate: deleted ${deleted}/${doomed.length} CAs`);
    }
  } catch (e) {
    log.error('[poller] zeroScoreGate', e);
  }
}

/**
 * Holdings half of the wallet sweep — credit-free on sol, ONE getTokenAccountsByOwner
 * per (CA, wallet) pair, so it keeps the faster cadence. Its own try/catch: a dead
 * trades door can never gate this (that inerting bug is what this split exists to
 * prevent). The pair set is exactly the `Tracked by` link — the source='watch' BUY
 * that feeds trackedByNames/inflow/holding (user 2026-09-23), so no wallet without a
 * CA link and no mint outside that pair is ever queried. Pairs whose CA is inside
 * NEW_CA_PRIORITY_MS go first (user 2026-09-24), same jump-the-queue rule as the
 * metric/setup sweeps.
 */
export async function walletSweep(provider: MarketDataProvider): Promise<void> {
  const tracked = listTrackedCas();
  const pairs = newCaPairsFirst(tracked, trackedByPairs(tracked.map((c) => c.address)));
  await pacedFor(pairs, config.pollWalletsMs, async (p) => {
    try {
      const balances = await provider.walletTokenHoldings(p.wallet.address, p.wallet.chain, [p.ca]);
      replaceWalletBalances(p.wallet.id, p.wallet.chain, balances);
    } catch (e) {
      log.error('[poller] walletSweep holdings', p.wallet.name, e);
    }
  });
  // Runs AFTER the holdings above: the prune's "no wallet holds it" test reads
  // exactly what this pass just wrote.
  const dropped = pruneUntrackedCas(CA_INFLOW_WINDOW_MS);
  for (const r of dropped) {
    log.warn(`[poller] prune untracked CA ${r.address} ${r.chain} (added ${r.added_at}) ${r.note}`);
  }
  // The market-cap band is a DISPLAY filter only (user 2026-09-24): a CA below the
  // floor stays TRACKED so it can surface the moment its cap crosses it. Deleting it
  // here (the old pruneOutOfBandCas) guaranteed churn — add → learn mc → delete → re-add.
  zeroScoreGate();
  // No wallet `Tracked by` -> the row renders "tracked by none"; drop it (user 2026-09-25).
  // Mock skipped: seed CAs are demo rows with no watch trades.
  if (config.mode !== 'mock') {
    for (const r of pruneTrackedByNone(TRACKED_BY_WINDOW_MS)) {
      log.warn(`[poller] prune tracked-by-none CA ${r.address} ${r.chain} (added ${r.added_at}) ${r.note}`);
    }
  }
}

async function run(task: PollTask): Promise<void> {
  const started = Date.now();
  try {
    await task.fn();
    const durationMs = Date.now() - started;
    log.info(`[poller] ${task.name} done in ${durationMs}ms`);
    // Ceiling detector: a sweep approaching its own interval means the free
    // REST cadence is saturated (upgrade path: paid WS provider).
    if (durationMs > task.intervalMs * 0.8) {
      log.warn(`[poller] ${task.name} took ${durationMs}ms > 80% of its ${task.intervalMs}ms interval`);
    }
  } catch (e) {
    log.error('[poller]', task.name, e);
  } finally {
    // Fixed rate: the next run is due one INTERVAL after the last one STARTED, so a
    // slow pass no longer pushes its own next start back by its own duration (an
    // overrunning sweep used to drift further behind every cycle).
    const waitMs = Math.max(1_000, task.intervalMs - (Date.now() - started));
    setTimeout(() => {
      void run(task);
    }, waitMs);
  }
}

/**
 * Chart consistency (user-verified 2026-09-10): cohort membership depends on the
 * REQUESTED window, so ONE full series is sliced by timestamp into the 3 cache
 * rows — per-window refetches return different totals at the same hour (the
 * 'switching windows shows a different chart' bug). Works for hourly AND
 * daily-degraded rows alike. EXPORTED: crawl.balanceSeries replays file-cache
 * entries through the SAME slicer (plan setup-fill-on-add §4).
 */
export function cacheSeriesWindows(ca: string, chain: Chain, fullRaw: BalancePoint[], now: number): { d1?: BalanceRange; d7?: BalanceRange; d30?: BalanceRange } {
  const bal: { d1?: BalanceRange; d7?: BalanceRange; d30?: BalanceRange } = {};
  const atMs = (p: { t: number | string }) => (typeof p.t === 'number' ? p.t : Date.parse(String(p.t)));
  // API returns hours out of order — the FE chart plots by index.
  const full = fullRaw.filter((p) => Number.isFinite(atMs(p))).sort((a, b) => atMs(a) - atMs(b));
  for (const w of ['day', 'week', 'month'] as StatWindow[]) {
    const since = now - (w === 'day' ? 1 : w === 'week' ? 7 : 30) * 86_400_000;
    const pts = full.filter((p) => atMs(p) >= since);
    if (pts.length === 0) continue;
    upsertNansenSeries(ca, chain, w, pts);
    const vals = pts.map((p) => p.total).filter((v) => Number.isFinite(v));
    if (vals.length) bal[w === 'day' ? 'd1' : w === 'week' ? 'd7' : 'd30'] = { peak: Math.max(...vals), trough: Math.min(...vals) };
  }
  return bal;
}

/** On-demand series fetch for the chart fallback (crawl.balanceSeries → kickNansen). */
async function crawlBalanceSeries(
  address: string,
  chain: Chain,
): Promise<{ bal: { d1?: BalanceRange; d7?: BalanceRange; d30?: BalanceRange }; ok: boolean }> {
  try {
    const now = Date.now();
    // Door guard (plan setup-fill-on-add §4): kickNansen must not refetch while a
    // FRESH series exists — apply it (row permitting) like refreshSeries.
    const cached = getSetupCacheEntry(address, chain);
    if (cached && isSeriesFresh(cached, now)) {
      const bal = applySetupCacheEntry(cached);
      return { bal: bal ?? {}, ok: bal !== undefined };
    }
    const fetched = await seriesAtRung(address, chain);
    if (!fetched) return { bal: {}, ok: false };
    return { bal: cacheSeriesWindows(address, chain, fetched.points, now), ok: true };
  } catch (e) {
    log.error('[poller] crawlBalanceSeries', address.slice(0, 8), String(e).slice(0, 120));
    return { bal: {}, ok: false };
  }
}

function passThroughBal(st: { bal_peak_24h: number | null; bal_trough_24h: number | null; bal_peak_7d: number | null; bal_trough_7d: number | null; bal_peak_30d: number | null; bal_trough_30d: number | null }): { d1?: BalanceRange; d7?: BalanceRange; d30?: BalanceRange } {
  return {
    d1: st.bal_peak_24h != null && st.bal_trough_24h != null ? { peak: st.bal_peak_24h, trough: st.bal_trough_24h } : undefined,
    d7: st.bal_peak_7d != null && st.bal_trough_7d != null ? { peak: st.bal_peak_7d, trough: st.bal_trough_7d } : undefined,
    d30: st.bal_peak_30d != null && st.bal_trough_30d != null ? { peak: st.bal_peak_30d, trough: st.bal_trough_30d } : undefined,
  };
}

// --- on-demand crawls (mutation-triggered): fire-and-forget from api.ts, the
// API response never waits on them — errors are logged, not thrown.

interface PollerDeps {
  provider: MarketDataProvider;
  nansenApi: NansenApiClient | null;
}

let pollerDeps: PollerDeps | null = null;

/** startPoller stores its provider deps here so api.ts can kick on-demand crawls.
 * `tokenFlows` is the narrow T100/LF seam — it defaults to `nansenApi` (prod,
 * NansenApiClient implements TokenFlowsClient); tests inject a counting stub. */
export function setPollerDeps(provider: MarketDataProvider, nansenApi: NansenApiClient | null, tokenFlows?: TokenFlowsClient | null): void {
  pollerDeps = { provider, nansenApi };
  tokenFlowsClient = tokenFlows ?? nansenApi;
}

// Kick helpers used by api.ts — pick the right deps + fire-and-forget.
// void kickCAs([...]): API response never waits; errors logged inside.

/** Chains with a holdings kick already running — one refresh per chain per burst. */
const holdingsKickInFlight = new Set<Chain>();

/**
 * Holdings refresh for the CA chains just inserted, so their linked wallets
 * attach in ~1s instead of waiting out walletSweep (15m interval). Only the
 * wallets ALREADY linked to those CAs are read — a `Tracked by` link is written
 * by the watch BUY event itself (signals.trackedByNames), so the daemon has
 * already named them; the full wallet list would spend ~n×2 RPC calls on a set
 * the DB already knows. Coalesced per chain so a burst of inserts costs one
 * refresh, not one per CA.
 *
 * Every chain is kicked (T5, plan evm-base-bsc): holdings are credit-free on all
 * of them — sol via Solana getTokenAccountsByOwner, base/bsc via ONE Multicall3
 * eth_call per wallet. The old sol-only gate protected the Nansen credit door,
 * which EVM chains no longer use.
 */
export function kickWalletHoldingsFor(cas: readonly { address: string; chain: Chain }[]): void {
  if (!pollerDeps) return;
  const deps = pollerDeps;
  for (const chain of new Set(cas.map((c) => c.chain))) {
    if (holdingsKickInFlight.has(chain)) continue;
    holdingsKickInFlight.add(chain);
    void (async () => {
      try {
        const addresses = cas.filter((c) => c.chain === chain).map((c) => c.address);
        const pairs = trackedByPairs(addresses);
        log.info(`[poller] kickWalletHoldings ${chain}: ${pairs.length} (CA,wallet) pair(s) for ${addresses.length} CA(s)`);
        for (const p of pairs) {
          if (p.wallet.chain !== chain) continue;
          try {
            replaceWalletBalances(p.wallet.id, p.wallet.chain, await deps.provider.walletTokenHoldings(p.wallet.address, p.wallet.chain, [p.ca]));
          } catch (e) {
            log.error('[poller] kickWalletHoldings', p.wallet.name, e);
          }
        }
      } finally {
        holdingsKickInFlight.delete(chain);
      }
    })();
  }
}

/** Token info + Nansen series for each CA, immediately — plus its wallet links. */
export function kickCAs(cas: readonly { address: string; chain: Chain }[]): void {
  if (!pollerDeps) return;
  for (const c of cas) {
    // T4 (plan setup-fill-on-add): the early setup pass rides kickToken's
    // completion — upsertTokenInfo has CREATED the token_state row by then, and
    // refreshSeries no-ops without it, so the chain IS the ordering guarantee.
    void kickToken(pollerDeps.provider, c.address, c.chain).then(() => {
      kickSetupEarly([c]);
    });
    kickNansen(c.address, c.chain);
  }
  kickWalletHoldingsFor(cas);
}

// --- T4 early setup trigger (plan setup-fill-on-add) -------------------------
// A newly-added CA gets ONE early refreshSeries pass instead of waiting out the
// 12h setupSweep. Paced, never a burst: one serialized drainer (kicks arriving
// while a pass runs batch into the next pacedFor, spaced across the queue-jump
// window — 2 requests per CA stays far under the 30/min path + 40/min door
// budgets), and the pool's own budgets remain the hard cap. Best-effort: every
// error is caught inside, so an add can never fail on the early pass.
const earlySetupPending: { address: string; chain: Chain }[] = [];
let earlySetupDrain: Promise<void> = Promise.resolve();

export function kickSetupEarly(cas: readonly { address: string; chain: Chain }[]): void {
  if (!config.crawlEnabled) return; // crawl off ⇒ no door, no setupSweep either — nothing to front-run
  earlySetupPending.push(...cas);
  earlySetupDrain = earlySetupDrain.then(drainEarlySetup);
}

async function drainEarlySetup(): Promise<void> {
  const batch = earlySetupPending.splice(0, earlySetupPending.length);
  await pacedFor(batch, config.newCaPriorityMs, async (c) => {
    try {
      log.info(`[poller] early setup pass ${c.address.slice(0, 8)} (${c.chain})`);
      await refreshSeries(c.address, c.chain);
    } catch (e) {
      log.error('[poller] earlySetup', c.address, e);
    }
  });
}

/** Test/observability seam: resolves when every queued early setup pass has finished. */
export function earlySetupIdle(): Promise<void> {
  return earlySetupDrain;
}

/** Token balances for one wallet row, immediately. `ca` = the single pair a trade
 * event landed on; omitted = every still-tracked CA the wallet has traded (add/edit path). */
export function kickWalletRow(row: WalletRow, ca?: string): void {
  if (!pollerDeps) return;
  kickWallet(pollerDeps.provider, row.id, row.address, row.chain, ca ? [ca] : watchedCasForWallet(row.id));
}

/** Pull one CA's token info now (creates token_state → detail 404 fix).
 * Resolves (never rejects) once the row exists — kickCAs chains the T4 early
 * setup pass on it. */
export function kickToken(provider: MarketDataProvider, address: string, chain: Chain): Promise<void> {
  return provider
    .tokenInfo(address, chain)
    .then((info) => {
      upsertTokenInfo(info);
      if (info.nansenStats) updateNansenHolders(address, chain, info.nansenStats);
    })
    .catch((e) => log.error('[poller] kickToken', address, e));
}

/** Cache one CA's Nansen balance series (one full-series fetch, 3 sliced windows) now. */
export function kickNansen(address: string, chain: Chain): void {
  void (async () => {
    const { bal, ok } = await crawlBalanceSeries(address, chain);
    const st = getTokenState(address, chain);
    if (st) updateTokenAnalytics(address, chain, { ...passThroughAnalytics(st), bal: ok ? bal : passThroughBal(st) });
    log.info(`[poller] kickNansen ${address.slice(0, 8)}: cached + extremes updated`);
  })();
}

/** Refreshes the given (CA, wallet) pairs now (Tracked Holding). An empty `cas` is a
 * no-op: a wallet no tracked CA links to is never queried. */
export function kickWallet(
  provider: MarketDataProvider,
  walletId: string,
  address: string,
  chain: Chain,
  cas: readonly string[],
): void {
  if (cas.length === 0) return;
  void (async () => {
    try {
      const balances = await provider.walletTokenHoldings(address, chain, cas);
      replaceWalletBalances(walletId, chain, balances);
      log.info(`[poller] kickWallet ${address.slice(0, 8)}: ${balances.length} position(s) / ${cas.length} pair(s)`);
    } catch (e) {
      log.error('[poller] kickWallet holdings', address, e);
    }
  })();
}

/**
 * F1=(b) phase anchor (plan setup-fill-on-add T5): delay until the next
 * `anchorAt + n × intervalMs` boundary at or after `now` — setupSweep's 12h marks
 * count from the systemDeployAt setting, so restarts RE-PHASE to the same
 * boundaries instead of drifting. `now` exactly on a boundary (incl. a fresh
 * deploy, anchor == now) fires immediately: that instant IS boundary n.
 */
export function nextPhaseDelayMs(anchorAt: number, now: number, intervalMs: number): number {
  const n = Math.ceil((now - anchorAt) / intervalMs);
  return Math.max(0, anchorAt + n * intervalMs - now);
}

/** Starts the sweeps with staggered initial delays (20s apart, in this order). */
export function startPoller(provider: MarketDataProvider, nansenApi: NansenApiClient | null, tokenFlows?: TokenFlowsClient | null): void {
  setPollerDeps(provider, nansenApi, tokenFlows);
  const tasks: PollTask[] = [
    { name: 'essentialSweep', intervalMs: config.pollEssentialMs, fn: () => metricSweep(provider, 'essential', config.pollEssentialMs) },
    {
      name: 'essentialGapSweep',
      intervalMs: config.pollEssentialGapMs,
      // Too-new CAs are filtered out: a mint Nansen has not indexed yet gains
      // nothing from a 5-min re-ask — the hourly essentialSweep covers it.
      fn: () =>
        metricSweep(
          provider,
          'essential',
          config.pollEssentialGapMs,
          listCaTargetsMissingEssential(config.essentialGapWindowMs).filter((c) => !isTooNewToken(c.address, c.chain, Date.now())),
        ),
    },
    { name: 'volumeSweep', intervalMs: config.pollVolumeMs, fn: () => metricSweep(provider, 'volume', config.pollVolumeMs) },
    { name: 'flowsSweep', intervalMs: config.pollFlowsMs, fn: () => flowsSweep() },
    { name: 'walletSweep', intervalMs: config.pollWalletsMs, fn: () => walletSweep(provider) },
    { name: 'symbolBackfillSweep', intervalMs: config.pollSymbolBackfillMs, fn: () => symbolBackfillSweep(provider) },
    { name: 'iconSweep', intervalMs: config.pollIconMs, fn: () => iconSweep() },
  ];
  if (config.crawlEnabled) {
    // F1=(b) (plan setup-fill-on-add T5): the marks count from the SYSTEM deploy
    // anchor in settings (written once by db.open(), never overwritten), not from
    // process boot.
    const rawAnchor = Number(getSetting('systemDeployAt'));
    const anchorAt = Number.isFinite(rawAnchor) ? rawAnchor : Date.now();
    const delay = nextPhaseDelayMs(anchorAt, Date.now(), config.pollSetupRetryMs);
    tasks.push({ name: 'setupSweep', intervalMs: config.pollSetupRetryMs, initialDelayMs: delay, fn: () => setupSweep(provider) });
    log.info(`[poller] setupSweep anchored to systemDeployAt=${new Date(anchorAt).toISOString()} — next pass in ${Math.round(delay / 1000)}s`);
  }
  log.info(`[poller] setup sweep every ${config.pollSetupRetryMs}ms (retries until a CA is complete, then ${config.pollSetupMs}ms)`);
  tasks.forEach((task, i) => {
    setTimeout(() => {
      void run(task);
    }, task.initialDelayMs ?? i * 20_000);
  });
}
