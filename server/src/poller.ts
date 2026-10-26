// Self-scheduling poll loops. setTimeout-after-completion instead of
// setInterval (Metis blocker): a slow upstream can never overlap runs and pile
// up against the rate limiter. ONE shared provider instance — constructing a
// provider per sweep would double the leaky buckets.

import { CA_INFLOW_WINDOW_MS, SNAPSHOT_RETENTION_MS, TRACKED_BY_WINDOW_MS, config } from './config.js';
import { canonicalCa, type Chain } from './shared/chain.js';
import {
  deleteSnapshotsBefore,
  deactivateTrackedCasByIds,
  findTrackedCa,
  getSetting,
  setSetting,
  getTokenState,
  getMetricPollCache,
  listMetricPollCache,
  metricPollNextAllowedAt,
  reserveMetricPoll,
  saveMetricPollResponse,
  failMetricPoll,
  deferMetricPoll,
  METRIC_RECOVERY_RETRY_MS,
  listCaScoreGateCandidates,
  listCaTargetsMissingEssential,
  listCaTargetsMissingSymbol,
  listCaTargetsMissingIcon,
  getFomoApiRequestState,
  getFomoPositionEvidence,
  clearFomoPositionPrice,
  saveFomoApiRequestState,
  getFomoTradeEnrichmentTarget,
  getFomoPositionSnapshot,
  listFomoPositionTargets,
  listTrackedCas,
  pruneTrackedByNone,
  pruneUntrackedCas,
  trackedByPairs,
  updateFomoTradeUsd,
  syncFomoPositionsSnapshot,
  upsertFomoPosition,
  upsertNansenSeries,
  watchedCasForWallet,
  type CaScoreGateRow,
  type CaTarget,
  type FomoApiRequestEndpoint,
  type FomoPositionInput,
  type MetricPollReservation,
  type TokenStateRow,
  type WalletRow,
} from './db.js';
import { replaceWalletBalances, restoreTokenLf, updateNansenHolders, updateTokenAnalytics, updateTokenMetrics, updateTokenIconIfMissing, upsertTokenInfo, clearCurrentMarketQuote, recomputeMarketCap } from './ingest.js';
import { fetchFomoBalances, fetchFomoSwaps, fetchFomoTradeDetail, matchFomoBuySwaps, recordFomoApiDeferred } from './fomo-api.js';
import type { FomoApiOutcome, FomoPosition, FomoSwap } from './fomo-api.js';
import type { BalancePoint } from './crawl.js';
import {
  cacheKey,
  getSetupCacheEntry,
  refreshSetupCacheIfChanged,
  getSetupRetry,
  recordSetupRetry,
  clearSetupRetry,
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
import { trackFomoWalletFromTx } from './fomo-holdings.js';
import { getThresholds } from './settings.js';
import type { MarketDataProvider, MetricKind, MetricPatch, TokenInfo } from './providers/provider.js';
import type { GmgnIconProvider } from './providers/gmgn.js';
import { enqueueSetup } from './setup-queue.js';
import { fetchTokenMeta, validatedIconUrl, type DexTokenMeta } from './providers/dexscreener.js';
import { GatewayTransportError } from './gateway-client.js';
import { log } from './log.js';
import { NansenDoorError } from './shared/nansen-door.js';

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
 * Todo 15 (request-plane-gateway): the sweep-level gateway fail-open policy.
 *
 * A gateway TRANSPORT failure (connection refused / timeout / DNS) is the ONE
 * fail-open category — warn and SKIP this sweep, so the poller keeps running and
 * the instance serves from its OWN DB (the gateway is read-only: nothing is lost).
 * This is NOT a cross-process stale cache — the cache lives in the gateway.
 *
 * A per-CA error — an upstream non-2xx surfaced as HttpError, or a gateway denial
 * (429 budget / 503 gated / 401) — no longer aborts the pass (bug3): it is logged
 * per-CA and the sweep moves on, and the pass ends with a one-line failure summary.
 */
export async function runGatewaySweep(
  where: string,
  body: (summary: SweepSummary) => Promise<void>,
): Promise<void> {
  const summary: SweepSummary = { count: 0 };
  try {
    await body(summary);
  } catch (e) {
    if (e instanceof GatewayTransportError) {
      log.warn(`[poller] ${where}: gateway unreachable — sweep skipped`, e);
      return;
    }
    throw e;
  } finally {
    if (summary.count > 0) {
      log.warn(`[poller] ${where}: ${summary.count} CA error(s) this pass — logged per-CA, pass continued`);
    }
  }
}

/** Per-pass per-CA failure tally, owned by `runGatewaySweep`, bumped by `logProviderError`. */
export interface SweepSummary {
  count: number;
}

/**
 * Per-CA error inside a gateway-backed sweep. A TRANSPORT failure still aborts (the
 * whole sweep is skipped, fail-open) and is NOT counted. Every other per-CA error —
 * HttpError, GatewayDenialError — is counted, logged, and the sweep CONTINUES to the
 * next CA, so one bad CA or upstream blip can no longer kill the rest of the pass (bug3).
 */
function logProviderError(summary: SweepSummary, e: unknown, where: string, ...fields: unknown[]): void {
  if (e instanceof GatewayTransportError) throw e;
  summary.count += 1;
  log.error(`[poller] ${where}`, ...fields, e);
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
 *
 * EXPORTED for the todo-15 fail-open test only (same test-seam precedent as
 * setupSweep / flowsSweep / pacedFor); the scheduler stays the production caller.
 */
const MIN_MARKET_CAP_QUERY_INTERVAL_MS = 30 * 60_000;
const METRIC_KINDS: readonly MetricKind[] = ['essential', 'volume', 'gini'];

interface CachedMetricResult {
  patch: MetricPatch | null;
  fetched: boolean;
  responseAt: number | null;
}

const metricQueriesInFlight = new Map<string, Promise<CachedMetricResult>>();

function metricInterval(kind: MetricKind, requestedMs: number): number {
  return kind === 'essential' || (config.mode === 'gmgn' && kind === 'volume')
    ? Math.max(MIN_MARKET_CAP_QUERY_INTERVAL_MS, requestedMs)
    : requestedMs;
}

const GMGN_MARKET_CACHE_KIND = 'gmgnMarket';
const ESSENTIAL_FIELDS: readonly (keyof MetricPatch)[] = [
  'price', 'supply', 'marketCap', 'liquidity', 'holders', 'symbol', 'xHandle', 'deployedAt',
];
const VOLUME_FIELDS: readonly (keyof MetricPatch)[] = ['volume24h', 'buyVol24h', 'sellVol24h', 'volume1h'];

function metricProjection(patch: MetricPatch, fields: readonly (keyof MetricPatch)[]): MetricPatch {
  return Object.fromEntries(fields.flatMap((field) =>
    patch[field] !== undefined ? [[field, patch[field]]] : [],
  )) as MetricPatch;
}

function hasMetricFields(patch: MetricPatch): boolean {
  return Object.keys(patch).length > 0;
}

function sharedMarketMetric(kind: MetricKind): boolean {
  return config.mode === 'gmgn' && (kind === 'essential' || kind === 'volume');
}
function metricFailureInterval(kind: MetricKind, intervalMs: number): number {
  return kind === 'gini' ? Math.min(intervalMs, config.pollSetupRetryMs) : intervalMs;
}
function failureNextAllowedAt(previousFailures: number, intervalMs: number, now: number): number {
  const backoffMs = Math.min(24 * 60 * 60_000, intervalMs * 2 ** Math.min(previousFailures, 5));
  return now + Math.max(intervalMs, backoffMs);
}

function cachedPatch(row: { response_json: string | null } | undefined): MetricPatch | null {
  if (!row?.response_json) return null;
  try {
    const value: unknown = JSON.parse(row.response_json);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as MetricPatch)
      : null;
  } catch {
    return null;
  }
}

function cachedMetricResult(
  ca: string,
  chain: Chain,
  kind: MetricKind,
  resourceRow?: ReturnType<typeof getMetricPollCache>,
): CachedMetricResult {
  const row = getMetricPollCache(ca, chain, kind);
  const fallback = resourceRow ? cachedPatch(resourceRow) : null;
  const patch = cachedPatch(row) ?? (fallback
    ? metricProjection(fallback, kind === 'essential' ? ESSENTIAL_FIELDS : VOLUME_FIELDS)
    : null);
  return { patch, fetched: false, responseAt: row?.response_at ?? resourceRow?.response_at ?? null };
}

function cacheSharedMarketResponse(
  ca: string,
  chain: Chain,
  responseAt: number,
  patch: MetricPatch,
): void {
  saveMetricPollResponse(
    ca, chain, GMGN_MARKET_CACHE_KIND, responseAt,
    responseAt + MIN_MARKET_CAP_QUERY_INTERVAL_MS, patch,
  );
  saveMetricPollResponse(
    ca, chain, 'essential', responseAt,
    responseAt + metricInterval('essential', MIN_MARKET_CAP_QUERY_INTERVAL_MS),
    metricProjection(patch, ESSENTIAL_FIELDS),
  );
  const volumePatch = metricProjection(patch, VOLUME_FIELDS);
  if (hasMetricFields(volumePatch)) {
    saveMetricPollResponse(
      ca, chain, 'volume', responseAt,
      responseAt + metricInterval('volume', config.pollVolumeMs),
      volumePatch,
    );
  }
}

async function cachedMetric(
  provider: MarketDataProvider,
  ca: string,
  chain: Chain,
  kind: MetricKind,
  requestedIntervalMs: number,
): Promise<CachedMetricResult> {
  const intervalMs = metricInterval(kind, requestedIntervalMs);
  const shared = sharedMarketMetric(kind);
  const key = `${chain}:${ca}:${shared ? GMGN_MARKET_CACHE_KIND : kind}`;
  const active = metricQueriesInFlight.get(key);
  if (active) return { ...(await active), fetched: false };

  const now = Date.now();
  const resourceRow = shared ? getMetricPollCache(ca, chain, GMGN_MARKET_CACHE_KIND) : undefined;
  if (shared && resourceRow && now < resourceRow.next_allowed_at) {
    return cachedMetricResult(ca, chain, kind, resourceRow);
  }
  const reservationKind = shared ? GMGN_MARKET_CACHE_KIND : kind;
  const reservationInterval = shared ? MIN_MARKET_CAP_QUERY_INTERVAL_MS : intervalMs;
  const reservation = reserveMetricPoll(ca, chain, reservationKind, now, reservationInterval);
  if (!reservation.claimed) {
    if (kind === 'gini') log.debug('[collector] fw_deferred', {
      ca, chain, nextAllowedAt: reservation.row?.next_allowed_at ?? null,
      lastSuccessAt: reservation.row?.response_at ?? null,
      failures: reservation.row?.failure_count ?? 0,
    });
    return cachedMetricResult(ca, chain, kind, reservation.row);
  }

  const kindReservation = shared
    ? reserveMetricPoll(ca, chain, kind, now, intervalMs)
    : reservation;
  if (!kindReservation.claimed) {
    failMetricPoll(ca, chain, reservationKind, kindReservation.row?.next_allowed_at ?? now + reservationInterval);
    return cachedMetricResult(ca, chain, kind, kindReservation.row);
  }
  const controller = kind === 'gini' ? new AbortController() : undefined;
  let timedOut = false;
  if (kind === 'gini') log.info('[collector] fw_start', {
    ca, chain, attemptAt: now, lastSuccessAt: reservation.row?.response_at ?? null,
    failures: reservation.row?.failure_count ?? 0, timeoutMs: config.giniMetricTimeoutMs,
  });
  const request = (async (): Promise<CachedMetricResult> => {
    try {
      const providerRequest = provider.metric(ca, chain, kind, controller?.signal);
      if (kind === 'gini') void providerRequest.then(
        () => {
          if (timedOut) log.info('[collector] fw_late_result', { ca, chain, outcome: 'resolved_discarded', runMs: Date.now() - now });
        },
        () => {
          if (timedOut) log.info('[collector] fw_late_result', { ca, chain, outcome: 'rejected', runMs: Date.now() - now });
        },
      );
      const patch = controller
        ? await Promise.race([
          providerRequest,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error(`gini metric timed out after ${config.giniMetricTimeoutMs}ms`));
            }, config.giniMetricTimeoutMs);
            providerRequest.finally(() => clearTimeout(timer)).catch(() => {});
          }),
        ])
        : await providerRequest;
      if (timedOut) throw new Error('gini metric completed after timeout');
      const responseAt = Date.now();
      if (kind === 'gini' && patch.nansenFreshPct === undefined) {
        const retryAt = failureNextAllowedAt(
          reservation.row?.failure_count ?? 0,
          metricFailureInterval(kind, intervalMs),
          responseAt,
        );
        failMetricPoll(ca, chain, kind, retryAt);
        log.info('[collector] fw_finish', {
          ca, chain, outcome: 'missing_value', runMs: responseAt - now, nextAllowedAt: retryAt,
          lastSuccessAt: reservation.row?.response_at ?? null,
        });
        return { patch, fetched: true, responseAt };
      }
      if (shared) cacheSharedMarketResponse(ca, chain, responseAt, patch);
      else saveMetricPollResponse(ca, chain, kind, responseAt, responseAt + intervalMs, patch);
      if (kind === 'gini') log.info('[collector] fw_finish', {
        ca, chain, outcome: 'cache_persisted', responseAt, runMs: responseAt - now,
        nextAllowedAt: responseAt + intervalMs, freshPct: patch.nansenFreshPct,
      });
      return { patch, fetched: true, responseAt };
    } catch (error) {
      const transientFwFailure = kind === 'gini' &&
        (timedOut || (error instanceof NansenDoorError && error.transient));
      const failedAt = Date.now();
      const nextAllowedAt = transientFwFailure
        ? failedAt + Math.min(config.pollSetupSweepMs, METRIC_RECOVERY_RETRY_MS)
        : failureNextAllowedAt(
          reservation.row?.failure_count ?? 0,
          metricFailureInterval(kind, intervalMs),
          failedAt,
        );
      if (transientFwFailure) {
        deferMetricPoll(ca, chain, reservationKind, nextAllowedAt);
        if (shared) deferMetricPoll(ca, chain, kind, nextAllowedAt);
      } else {
        failMetricPoll(ca, chain, reservationKind, nextAllowedAt);
        if (shared) failMetricPoll(ca, chain, kind, nextAllowedAt);
      }
      if (kind === 'gini') log.info('[collector] fw_finish', {
        ca, chain, outcome: timedOut ? 'timeout' : transientFwFailure ? 'door_retry' : 'error',
        retryClass: transientFwFailure ? 'transient' : 'permanent',
        runMs: failedAt - now, nextAllowedAt,
        failures: (reservation.row?.failure_count ?? 0) + (transientFwFailure ? 0 : 1),
        lastSuccessAt: reservation.row?.response_at ?? null,
      });
      throw error;
    }
  })();
  metricQueriesInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (metricQueriesInFlight.get(key) === request) metricQueriesInFlight.delete(key);
  }
}

function orderedMetricTargets(cas: readonly CaTarget[], kind: string): CaTarget[] {
  const now = Date.now();
  const cutoff = now - config.newCaPriorityMs;
  const newTargets = new Set(
    listTrackedCas().filter((c) => isNewCa(c.added_at, cutoff)).map((c) => `${c.chain}:${c.address}`),
  );
  const cache = new Map(listMetricPollCache(kind).map((row) => [`${row.chain}:${row.ca}`, row]));
  return cas
    .filter((c) => {
      const row = cache.get(`${c.chain}:${c.address}`);
      return !row || row.next_allowed_at <= now;
    })
    .sort((a, b) => {
      const aNew = newTargets.has(`${a.chain}:${a.address}`);
      const bNew = newTargets.has(`${b.chain}:${b.address}`);
      if (aNew !== bNew) return aNew ? -1 : 1;
      const aAt = cache.get(`${a.chain}:${a.address}`)?.last_attempt_at ?? 0;
      const bAt = cache.get(`${b.chain}:${b.address}`)?.last_attempt_at ?? 0;
      return aAt - bAt || a.address.localeCompare(b.address);
    });
}

/**
 * ONE free app-question per (CA, kind); the durable cache gate is shared by
 * scheduled sweeps and add-triggered queries.
 */
export async function metricSweep(
  provider: MarketDataProvider,
  kind: MetricKind,
  intervalMs: number,
  only?: readonly CaTarget[],
): Promise<void> {
  const base = only ?? listTrackedCas().map((c) => ({ address: c.address, chain: c.chain }));
  const cas = orderedMetricTargets(base, kind);
  const effectiveInterval = metricInterval(kind, intervalMs);
  await runGatewaySweep(`${kind}Sweep`, (summary) =>
    pacedFor(cas, effectiveInterval, async (c) => {
      try {
        const result = await cachedMetric(provider, c.address, c.chain, kind, intervalMs);
        if (!result.fetched || !result.patch) return;
        applyMetricPatch(c.address, c.chain, kind, result.patch);
        if (kind === 'gini' && typeof result.patch.nansenFreshPct === 'number' && result.responseAt !== null) {
          log.info('[collector] fw_applied', {
            ca: c.address, chain: c.chain, source: 'upstream',
            responseAt: result.responseAt, freshPct: result.patch.nansenFreshPct,
          });
        }
      } catch (e) {
        // Keep the last successful quote and metrics. The cache records this failure
        // and blocks another attempt until the cadence/backoff expires.
        logProviderError(summary, e, `${kind}Sweep`, c.address);
      }
    }),
  );
}

/**
 * In GMGN mode, only a fresh GMGN quote may update current MC; a missing quote
 * clears its current value instead of reusing an older provider's price. History
 * remains untouched. Other modes retain the existing provider-owned price.
 */
function writeEssential(ca: string, chain: Chain, patch: MetricPatch, mode: string): void {
  const price = typeof patch.price === 'number' && Number.isFinite(patch.price) && patch.price > 0
    ? patch.price
    : undefined;
  updateTokenMetrics(ca, chain, {
    ...(price !== undefined ? { price } : {}),
    ...(patch.symbol !== undefined ? { symbol: patch.symbol } : {}),
    ...(patch.liquidity !== undefined ? { liquidity: patch.liquidity } : {}),
    ...(patch.holders !== undefined ? { holders: patch.holders } : {}),
    ...(patch.supply !== undefined ? { supply: patch.supply } : {}),
    ...(patch.xHandle !== undefined ? { xHandle: patch.xHandle } : {}),
    ...(patch.deployedAt !== undefined ? { deployedAt: patch.deployedAt } : {}),
  });
  if (price === undefined) {
    if (mode === 'gmgn') clearCurrentMarketQuote(ca, chain);
    else recomputeMarketCap(ca, chain);
    return;
  }
  recomputeMarketCap(ca, chain);
}

function applyMetricPatch(ca: string, chain: Chain, kind: MetricKind, patch: MetricPatch): void {
  if (sharedMarketMetric(kind)) {
    writeEssential(ca, chain, metricProjection(patch, ESSENTIAL_FIELDS), config.mode);
    const volumePatch = metricProjection(patch, VOLUME_FIELDS);
    if (hasMetricFields(volumePatch)) {
      applyVolumeDelta(ca, chain, volumePatch);
      updateTokenMetrics(ca, chain, volumePatch);
    }
    return;
  }
  if (kind === 'volume') {
    applyVolumeDelta(ca, chain, patch);
    updateTokenMetrics(ca, chain, patch);
  } else if (kind === 'essential') {
    writeEssential(ca, chain, patch, config.mode);
  } else {
    updateTokenMetrics(ca, chain, patch);
  }
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
 * Missing symbols use the same essential-data query gate as MC. `assetInfo`
 * shared GMGN's token/info endpoint but previously bypassed its cadence.
 */
async function symbolBackfillSweep(provider: MarketDataProvider): Promise<void> {
  const cas = listCaTargetsMissingSymbol(config.symbolBackfillWindowMs);
  if (cas.length > 0) await metricSweep(provider, 'essential', config.pollEssentialMs, cas);
}

/**
 * DexScreener is the symbol/icon market metadata source. In GMGN mode, only
 * GMGN may update price/MC; other modes retain the DexScreener price fallback.
 */
export function dexMarketPatch(meta: DexTokenMeta, mode: string): MetricPatch {
  return {
    ...(meta.iconUrl !== undefined ? { iconUrl: meta.iconUrl } : {}),
    ...(meta.symbol !== undefined ? { symbol: meta.symbol } : {}),
    ...(mode !== 'gmgn' && meta.price !== undefined ? { price: meta.price } : {}),
  };
}

async function dexMarketSweep(): Promise<void> {
  const targets = orderedMetricTargets(
    listTrackedCas().map((t) => ({ address: t.address, chain: t.chain })),
    'dexMeta',
  );
  if (targets.length === 0) return;
  const intervalMs = Math.max(config.pollIconMs, MIN_MARKET_CAP_QUERY_INTERVAL_MS);
  const reserved = targets.flatMap((c) => {
    const reservation = reserveMetricPoll(c.address, c.chain, 'dexMeta', Date.now(), intervalMs);
    return reservation.claimed ? [{ target: c, reservation }] : [];
  });
  if (reserved.length === 0) return;

  await runGatewaySweep('dexMarketSweep', async (summary) => {
    try {
      const meta = await fetchTokenMeta(reserved.map(({ target }) => target.address));
      const responseAt = Date.now();
      for (const { target, reservation } of reserved) {
        const token = meta.get(target.address);
        if (!token) {
          failMetricPoll(
            target.address,
            target.chain,
            'dexMeta',
            failureNextAllowedAt(reservation.row?.failure_count ?? 0, intervalMs, responseAt),
          );
          continue;
        }
        saveMetricPollResponse(target.address, target.chain, 'dexMeta', responseAt, responseAt + intervalMs, token);
        const patch = dexMarketPatch(token, config.mode);
        updateTokenMetrics(target.address, target.chain, patch);
        if (patch.price !== undefined) recomputeMarketCap(target.address, target.chain);
      }
    } catch (error) {
      const failedAt = Date.now();
      for (const { target, reservation } of reserved) {
        failMetricPoll(
          target.address,
          target.chain,
          'dexMeta',
          failureNextAllowedAt(reservation.row?.failure_count ?? 0, intervalMs, failedAt),
        );
      }
      logProviderError(summary, error, 'dexMarketSweep');
    }
  });
}

/** Retry missing icons through GMGN after the shared DexScreener metadata pass. */
export async function gmgnIconSweep(provider: GmgnIconProvider): Promise<void> {
  const intervalMs = config.pollIconMs;
  const targets = orderedMetricTargets(listCaTargetsMissingIcon(), 'gmgnIcon').slice(0, 30);
  if (targets.length === 0) return;
  const reserved = targets.flatMap((target) => {
    const reservation = reserveMetricPoll(target.address, target.chain, 'gmgnIcon', Date.now(), intervalMs);
    return reservation.claimed ? [{ target, reservation }] : [];
  });
  if (reserved.length === 0) return;

  await runGatewaySweep('gmgnIconSweep', async (summary) => {
    await pacedFor(reserved, intervalMs, async ({ target, reservation }) => {
      if (getTokenState(target.address, target.chain)?.icon_url?.trim()) return;
      try {
        const iconUrl = validatedIconUrl(await provider.tokenIcon(target.address, target.chain));
        if (iconUrl === undefined) {
          failMetricPoll(
            target.address,
            target.chain,
            'gmgnIcon',
            failureNextAllowedAt(reservation.row?.failure_count ?? 0, intervalMs, Date.now()),
          );
          return;
        }
        const responseAt = Date.now();
        const stored = updateTokenIconIfMissing(target.address, target.chain, iconUrl, responseAt);
        if (stored) {
          saveMetricPollResponse(target.address, target.chain, 'gmgnIcon', responseAt, responseAt + intervalMs, { iconUrl });
        }
      } catch (error) {
        failMetricPoll(
          target.address,
          target.chain,
          'gmgnIcon',
          failureNextAllowedAt(reservation.row?.failure_count ?? 0, intervalMs, Date.now()),
        );
        logProviderError(summary, error, 'gmgnIconSweep', target.address);
      }
    });
  });
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
 * The window is walked widest → narrowest and sent as a `{from,to}` RANGE aligned
 * to the deployment bucket: hourly through seven days, daily beyond that. The
 * range is capped at 1000 buckets; the aligned first bucket includes listing-day
 * balances without admitting earlier buckets into the LF anchor.
 */
async function exchangeLf(ca: string, chain: Chain, deployedAt?: number | null, signal?: AbortSignal): Promise<{ total: number; points: BalancePoint[]; rule: 'bucket-hour-v2' | 'bucket-day-v2' } | undefined> {
  // Không có deployed_at ⇒ không biết genesis nằm đâu — giữ nguyên giá trị cũ (94/152
  // dòng LF hiện thuộc nhóm này — xem EVIDENCE-2026-09-21-lf-range-form-restore.md).
  if (!deployedAt) return undefined;
  const client = flowsClient();
  if (!client) return undefined;
  const now = Date.now();
  try {
    // API range starts are exclusive at the bucket boundary, so request one bucket
    // before listing while anchoring/validating at the listing bucket itself.
    const dayMs = 86_400_000;
    const hourMs = 3_600_000;
    const lfRule = now - deployedAt > 7 * dayMs ? 'bucket-day-v2' : 'bucket-hour-v2';
    const bucketMs = lfRule === 'bucket-day-v2' ? dayMs : hourMs;
    const anchorFrom = Math.floor(deployedAt / bucketMs) * bucketMs;
    const requestFrom = anchorFrom - bucketMs;
    // Padding must not change the selected wire granularity near day seven.
    const to = Math.min(requestFrom + (lfRule === 'bucket-day-v2' ? 999 * dayMs : 7 * dayMs), now);
    const rows = await client.tokenFlows({
      chain,
      token_address: ca,
      date: { from: new Date(requestFrom).toISOString(), to: new Date(to).toISOString() },
      label: 'exchange',
    }, signal);
    const points = flowsToPoints(rows);
    if (!seriesReachesStart(points, anchorFrom, lfRule === 'bucket-day-v2' ? 0 : bucketMs)) {
      log.error('[poller] genesisLF series cut ngan hon cua so xin, keep previous', ca.slice(0, 8), 'n=' + points.length);
      return undefined;
    }
    const lf = exchangeAnchorLf(points, anchorFrom);
    if (lf) return { total: lf.total, points, rule: lfRule };
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

type SetupField = 'series' | 'lf';
const SETUP_RETRY_MIN_MS = 60_000;
const SETUP_RETRY_MAX_MS = 43_200_000;

function retryReady(ca: string, chain: Chain, field: SetupField, now: number): boolean {
  const retry = getSetupRetry(ca, chain, field);
  return retry === undefined || now >= retry.nextAt;
}

function setupRetryDelayMs(misses: number): number {
  return Math.min(SETUP_RETRY_MAX_MS, Math.max(SETUP_RETRY_MIN_MS, config.pollSetupRetryMs * 2 ** misses));
}

function retryLater(ca: string, chain: Chain, field: SetupField): void {
  const now = Date.now();
  const misses = (getSetupRetry(ca, chain, field)?.misses ?? 0) + 1;
  const delay = isTooNewToken(ca, chain, now) ? config.newTokenRetryMs : setupRetryDelayMs(misses);
  recordSetupRetry(ca, chain, field, misses, now + delay);
  log.info('[collector] setup_retry', { ca, chain, dataset: field, misses, nextAllowedAt: now + delay });
}

function owesInfo(ca: string, chain: Chain, now: number): boolean {
  const cached = getSetupCacheEntry(ca, chain);
  const poll = getMetricPollCache(ca, chain, 'gini');
  return (!cached || !isInfoFresh(cached, now)) && (!poll || now >= metricPollNextAllowedAt(poll, config.pollSetupMs));
}

function owesSeries(ca: string, chain: Chain, now: number): boolean {
  const cached = getSetupCacheEntry(ca, chain);
  return (!cached || !isSeriesFresh(cached, now)) && retryReady(ca, chain, 'series', now);
}

function owesLf(ca: string, chain: Chain, now: number): boolean {
  const st = getTokenState(ca, chain);
  const cached = getSetupCacheEntry(ca, chain);
  if (!st?.deployed_at || !retryReady(ca, chain, 'lf', now)) return false;
  const expectedRule = now - st.deployed_at > 7 * 86_400_000 ? 'bucket-day-v2' : 'bucket-hour-v2';
  return cached?.genesis_bal == null || cached.lf_rule !== expectedRule;
}

function needsSetup(c: CaTarget, now: number): boolean {
  return owesInfo(c.address, c.chain, now) || owesSeries(c.address, c.chain, now) || owesLf(c.address, c.chain, now);
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

/** Keep both debt classes moving without increasing the per-pass CA budget. */
function cappedSetupTargets(all: readonly CaTarget[], now: number): CaTarget[] {
  const cap = config.setupPassCap;
  const fresh = all.filter((c) => owesInfo(c.address, c.chain, now));
  const seriesOnly = all.filter((c) => !owesInfo(c.address, c.chain, now));
  if (fresh.length === 0 || seriesOnly.length === 0) return all.slice(0, cap);
  let seriesSlots = Math.min(seriesOnly.length, Math.max(1, Math.floor(cap / 5)));
  if (cap === 1) {
    seriesSlots = getSetting('setupDebtTurn') === 'series' ? 1 : 0;
    setSetting('setupDebtTurn', seriesSlots ? 'fresh' : 'series');
  }
  const freshSlots = Math.min(fresh.length, cap - seriesSlots);
  return [...fresh.slice(0, freshSlots), ...seriesOnly.slice(0, cap - freshSlots)];
}

/** Fill due factors independently, capped per pass; gateway owns upstream pacing. */
export async function setupSweep(provider: MarketDataProvider): Promise<void> {
  const now = Date.now();
  const tracked = listTrackedCas();
  const all = newCasFirst(tracked).filter((c) => needsSetup(c, now)).sort((a, b) => {
    const aInfo = owesInfo(a.address, a.chain, now);
    const bInfo = owesInfo(b.address, b.chain, now);
    if (aInfo !== bInfo) return aInfo ? -1 : 1;
    // Oldest successful Fresh read goes first; series-only debt cannot consume
    // every capped slot while expired Fresh values wait indefinitely.
    return aInfo
      ? (getSetupCacheEntry(a.address, a.chain)?.info_at ?? 0) - (getSetupCacheEntry(b.address, b.chain)?.info_at ?? 0)
      : (getSetupCacheEntry(a.address, a.chain)?.series_at ?? 0) - (getSetupCacheEntry(b.address, b.chain)?.series_at ?? 0);
  });
  if (tracked.length > 0 && setupCacheSize() === 0) {
    log.warn('[poller] setup cache EMPTY with', tracked.length, 'tracked CA(s) — backfill capped per pass');
  }
  // A cold cache would otherwise backfill the whole queue in one pass — each CA
  // costs ≥1 credit, so trickle: the cap bounds the burst, the rest wait the next pass.
  const cas = cappedSetupTargets(all, now);
  log.info('[collector] setup_pass', {
    tracked: tracked.length, due: all.length, selected: cas.length, capped: all.length - cas.length,
    fwDue: all.filter((c) => owesInfo(c.address, c.chain, now)).length,
    seriesDue: all.filter((c) => owesSeries(c.address, c.chain, now)).length,
    lfDue: all.filter((c) => owesLf(c.address, c.chain, now)).length,
  });
  if (all.length > cas.length) {
    log.warn('[poller] setup pass capped to', cas.length, 'of', all.length, 'CA(s)');
  }
  await runGatewaySweep('setupSweep', async (summary) => {
    const seriesWork = cas.map(async (c) => {
      try {
        await refreshSeries(c.address, c.chain);
      } catch (e) {
        logProviderError(summary, e, 'setupSweep series', c.address);
      }
    });
    for (const c of cas) {
      if (!owesInfo(c.address, c.chain, Date.now())) continue;
      try {
        const result = await cachedMetric(provider, c.address, c.chain, 'gini', config.pollSetupMs);
        const patch = result.patch;
        const fresh = patch?.nansenFreshPct;
        if (result.fetched && patch) updateTokenMetrics(c.address, c.chain, patch);
        else if (result.responseAt !== null && fresh !== undefined &&
            getTokenState(c.address, c.chain)?.nansen_fresh_pct == null && patch) {
          updateTokenMetrics(c.address, c.chain, patch);
        }
        if (typeof fresh === 'number' && Number.isFinite(fresh) && result.responseAt !== null) {
          stampSetupCacheField(c.address, c.chain, 'info_at', result.responseAt);
          log.info('[collector] fw_applied', {
            ca: c.address, chain: c.chain, source: result.fetched ? 'upstream' : 'cache',
            responseAt: result.responseAt, freshPct: fresh,
          });
        }
      } catch (e) {
        logProviderError(summary, e, 'setupSweep gini', c.address);
      }
    }
    await Promise.all(seriesWork);
    log.info('[collector] setup_pass_finish', { selected: cas.length, runMs: Date.now() - now });
  });
  deleteSnapshotsBefore(now - SNAPSHOT_RETENTION_MS);
  // File-cache prune (plan setup-fill-on-add §4): drop entries whose CA left the
  // queue or aged past 7 cadences; the empty-set guard inside pruneSetupCache
  // keeps a just-reset DB from wiping the whole file.
  // Re-read tracked keys after awaits so a token added mid-pass keeps its cache.
  const trackedKeysNow = new Set(listTrackedCas().map((c) => cacheKey(c.address, c.chain)));
  const dropped = pruneSetupCache(Date.now(), trackedKeysNow);
  if (dropped > 0) log.info(`[setup-cache] pruned ${dropped} entries`);
}
export interface SetupFreshnessStats {
  trackedCaCount: number;
  latestFwSuccessAt: number | null;
  latestT100SuccessAt: number | null;
  fwFreshCount: number;
  fwStaleCount: number;
  fwUnknownCount: number;
  t100FreshCount: number;
  t100StaleCount: number;
  t100UnknownCount: number;
}

/** Shared-cache-aware setup freshness summary for health reporting. */
export function getSetupFreshnessStats(now: number, staleAfterMs: number): SetupFreshnessStats {
  refreshSetupCacheIfChanged();
  const stats: SetupFreshnessStats = {
    trackedCaCount: 0,
    latestFwSuccessAt: null,
    latestT100SuccessAt: null,
    fwFreshCount: 0,
    fwStaleCount: 0,
    fwUnknownCount: 0,
    t100FreshCount: 0,
    t100StaleCount: 0,
    t100UnknownCount: 0,
  };
  for (const ca of listTrackedCas()) {
    stats.trackedCaCount += 1;
    const entry = getSetupCacheEntry(ca.address, ca.chain);
    const fwAt = entry?.info_at;
    const t100At = entry?.series_at;
    if (fwAt === undefined) stats.fwUnknownCount += 1;
    else {
      stats.latestFwSuccessAt = Math.max(stats.latestFwSuccessAt ?? 0, fwAt);
      if (now - fwAt <= staleAfterMs) stats.fwFreshCount += 1;
      else stats.fwStaleCount += 1;
    }
    if (t100At === undefined) stats.t100UnknownCount += 1;
    else {
      stats.latestT100SuccessAt = Math.max(stats.latestT100SuccessAt ?? 0, t100At);
      if (now - t100At <= staleAfterMs) stats.t100FreshCount += 1;
      else stats.t100StaleCount += 1;
    }
  }
  return stats;
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

async function seriesAtRung(ca: string, chain: Chain, signal?: AbortSignal): Promise<SeriesFetch | undefined> {
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
      }, signal);
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
  const st = getTokenState(e.ca, e.chain);
  if (!st) {
    log.info(`[setup-cache] fresh entry ${e.ca.slice(0, 8)} (${e.chain}) waits — token_state row not created yet`);
    return undefined;
  }
  if (st.genesis_bal == null && e.genesis_bal !== undefined) restoreTokenLf(e.ca, e.chain, e.genesis_bal);
  // Marker-only entry: no chart payload to replay. We must NOT fall through to
  // updateTokenAnalytics — it writes `?? null`, so replaying an empty payload would
  // WIPE bal_peak_*/bal_trough_* in token_state. The marker alone parks the CA.
  if (e.series.length === 0) {
    log.info(`[setup-cache] ${e.ca.slice(0, 8)} (${e.chain}) skipped chart replay — no series payload`);
    return undefined;
  }
  const bal = cacheSeriesWindows(e.ca, e.chain, e.series, e.series_at ?? e.taken_at);
  updateTokenAnalytics(e.ca, e.chain, {
    t100Pct: e.t100_pct,
    t100Multiple: e.t100_multiple,
    genesisBal: st.genesis_bal ?? e.genesis_bal ?? undefined,
    anchorAt: e.anchor_at,
    bal,
  });
  log.info(`[setup-cache] applied ${e.ca.slice(0, 8)} (${e.chain}) from file cache — 0 door requests`);
  return bal;
}

/** Shared, serialized enrichment. TTLs decide eligibility; the gateway limits requests. */
export function refreshSeries(ca: string, chain: Chain): Promise<void> {
  const st = getTokenState(ca, chain);
  const tracked = findTrackedCa(ca, chain);
  const urgent = st?.t100_multiple == null || st?.genesis_bal == null ||
    isNewCa(tracked?.added_at, Date.now() - config.newCaPriorityMs);
  return enqueueSetup(ca, chain, urgent ? 0 : 1, async (signal) => {
    const now = Date.now();
    const cached = getSetupCacheEntry(ca, chain);
    if (cached && isSeriesFresh(cached, now)) applySetupCacheEntry(cached);
    if (!owesSeries(ca, chain, now) && !owesLf(ca, chain, now)) return;
    const entry = await applySeriesPass(ca, chain, now, signal);
    if (!signal.aborted && entry) putSetupCacheEntry(entry);
  });
}

/** Refresh due cached series and missing LF without stretching the walk across its TTL. */
export async function flowsSweep(): Promise<void> {
  if (!flowsClient()) return;
  const now = Date.now();
  const cas = newCasFirst(listTrackedCas()).filter((c) =>
    getSetupCacheEntry(c.address, c.chain) !== undefined &&
    (owesSeries(c.address, c.chain, now) || owesLf(c.address, c.chain, now)));
  await runGatewaySweep('flowsSweep', async (summary) => {
    for (const c of cas) {
      try {
        await refreshSeries(c.address, c.chain);
      } catch (e) {
        logProviderError(summary, e, 'flowsSweep', c.address);
      }
    }
  });
}

/** One flows pass: fetch the series → T100 multiple / LF / bal_* windows → DB.
 * Returns the setup-cache entry, or undefined when the token row does not exist
 * yet (the essential sweep creates it). */
async function applySeriesPass(
  ca: string,
  chain: Chain,
  now: number,
  signal: AbortSignal,
): Promise<SetupCacheEntry | undefined> {
  const st = getTokenState(ca, chain);
  if (!st) {
    log.info('[collector] setup_deferred', { ca, chain, reason: 'missing_token_state' });
    return undefined;
  }
  const prev = getSetupCacheEntry(ca, chain);
  const fetchSeries = owesSeries(ca, chain, now);
  const seriesProviderAvailable = flowsClient() !== null;
  const seriesStartedAt = Date.now();
  if (fetchSeries) log.info('[collector] series_start', {
    ca, chain, lastSuccessAt: prev?.series_at ?? null, providerAvailable: seriesProviderAvailable,
  });
  const fetched = fetchSeries && seriesProviderAvailable ? await seriesAtRung(ca, chain, signal) : undefined;
  const seriesResponseAt = fetched === undefined ? undefined : Date.now();
  if (fetchSeries) log.info('[collector] series_finish', {
    ca, chain, outcome: !seriesProviderAvailable ? 'provider_unavailable' : fetched ? 'fetched' : 'no_data',
    responseAt: seriesResponseAt ?? null, points: fetched?.points.length ?? 0,
    runMs: Date.now() - seriesStartedAt,
  });
  if (signal.aborted) return undefined;
  const series = fetched?.points;
  if (fetchSeries && seriesProviderAvailable) {
    if (series && series.length > 0) clearSetupRetry(ca, chain, 'series');
    else retryLater(ca, chain, 'series');
  }
  let { t100Pct, t100Multiple, anchorAt, genesisBal } = passThroughAnalytics(st);
  let t100ObservationAt: number | undefined;
  let t100BalanceDrawdown: { peak: number; trough: number } | undefined;
  genesisBal ??= prev?.genesis_bal;
  if (series) {
    const g = fetched ? t100Mdd(fetched.t100) : undefined;
    if (g) {
      t100Pct = g.pct;
      t100Multiple = g.multiple;
      t100BalanceDrawdown = { peak: g.peak, trough: g.trough };
      anchorAt = g.peakAt;
      t100ObservationAt = seriesResponseAt;
    }
  }
  const bal = series ? cacheSeriesWindows(ca, chain, series, now) : passThroughBal(st);
  if (series && series.length > 0 && t100ObservationAt !== undefined && seriesResponseAt !== undefined) {
    updateTokenAnalytics(ca, chain, { t100Pct, t100Multiple, t100BalanceDrawdown, genesisBal, anchorAt, bal }, t100ObservationAt);
    putSetupCacheEntry({
      ca,
      chain,
      taken_at: seriesResponseAt,
      window: fetched?.window ?? prev?.window ?? '',
      series_from: fetched?.from ?? prev?.series_from,
      series,
      exchange: prev?.exchange ?? [],
      t100_pct: t100Pct,
      t100_multiple: t100Multiple,
      anchor_at: anchorAt,
      genesis_bal: genesisBal,
      lf_rule: prev?.lf_rule,
      series_at: seriesResponseAt,
      ...(getSetupCacheEntry(ca, chain)?.info_at !== undefined
        ? { info_at: getSetupCacheEntry(ca, chain)?.info_at }
        : {}),
    });
    log.info('[collector] t100_persisted', {
      ca, chain, responseAt: seriesResponseAt, runMs: Date.now() - now,
      points: series.length, multiple: t100Multiple,
    });
  }
  const fetchLf = owesLf(ca, chain, now);
  const lfProviderAvailable = flowsClient() !== null;
  const lfStartedAt = Date.now();
  if (fetchLf) log.info('[collector] lf_start', {
    ca, chain, providerAvailable: lfProviderAvailable, previousRule: prev?.lf_rule ?? null,
  });
  const lf = fetchLf && lfProviderAvailable ? await exchangeLf(ca, chain, st.deployed_at, signal) : undefined;
  if (signal.aborted) return undefined;
  if (fetchLf) log.info('[collector] lf_finish', {
    ca, chain, outcome: !lfProviderAvailable ? 'provider_unavailable' : lf ? 'fetched' : 'no_data',
    points: lf?.points.length ?? 0, runMs: Date.now() - lfStartedAt,
  });
  if (lf !== undefined) {
    genesisBal = lf.total;
    clearSetupRetry(ca, chain, 'lf');
  } else if (fetchLf && lfProviderAvailable) retryLater(ca, chain, 'lf');
  updateTokenAnalytics(ca, chain, { t100Pct, t100Multiple, t100BalanceDrawdown, genesisBal, anchorAt, bal });
  if (lf !== undefined) log.info('[collector] lf_persisted', {
    ca, chain, rule: lf.rule, points: lf.points.length, runMs: Date.now() - now,
  });
  const infoAt = getSetupCacheEntry(ca, chain)?.info_at;
  return {
    ca,
    chain,
    taken_at: now,
    window: fetched?.window ?? prev?.window ?? '',
    series_from: fetched?.from ?? prev?.series_from,
    series: series ?? prev?.series ?? [],
    exchange: lf?.points ?? prev?.exchange ?? [],
    t100_pct: t100Pct,
    t100_multiple: t100Multiple,
    anchor_at: anchorAt,
    genesis_bal: genesisBal,
    lf_rule: lf?.rule ?? prev?.lf_rule,
    // Carry the previous series marker FIRST; a fresh non-empty series then stamps
    // `now` over it. An empty pass therefore keeps prev.series_at (no fresh stamp,
    // an existing marker is never lost).
    ...(prev?.series_at !== undefined ? { series_at: prev.series_at } : {}),
    ...(series !== undefined && series.length > 0 && seriesResponseAt !== undefined
      ? { series_at: seriesResponseAt }
      : {}),
    // A first-add gini result may have landed while the series request awaited.
    ...(infoAt !== undefined ? { info_at: infoAt } : {}),
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
      const deactivated = deactivateTrackedCasByIds(doomed.map((r) => r.id));
      log.warn(`[poller] zero-score gate: deactivated ${deactivated}/${doomed.length} CAs`);
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
  // FOMO social positions and holdings refresh only from incoming alert events.
  // Native wallet holdings above retain their normal polling cadence.
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
    upsertNansenSeries(ca, chain, w, pts, now);
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
    await refreshSeries(address, chain);
    const cached = getSetupCacheEntry(address, chain);
    const bal = cached && isSeriesFresh(cached, Date.now()) ? applySetupCacheEntry(cached) : undefined;
    return { bal: bal ?? {}, ok: bal !== undefined };
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
type PollerScope = 'all' | 'market' | 'wallets';
let pollerScope: PollerScope = 'all';

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

// --- FOMO user holdings (credit-free RPC, fomo tables only) ------------------

/** FOMO wallet RPC alerts serialize independently from API batches. */
let fomoKickDrain: Promise<void> = Promise.resolve();
const FOMO_ALERT_BATCH_MS = 5_000;
const FOMO_POSITION_REFRESH_COOLDOWN_MS = 60 * 1000;
interface FomoPositionAlertBatch {
  handle: string;
  apiUserId?: string;
  eventIds: Set<string>;
  done: Promise<void>;
  finish: () => void;
}
const fomoPositionAlertBatches = new Map<string, FomoPositionAlertBatch>();
// Keep unrelated FOMO users moving without creating an unbounded API burst.
const FOMO_POSITION_BATCH_CONCURRENCY = 4;
let activeFomoPositionBatches = 0;
const fomoPositionSlotWaiters: (() => void)[] = [];
const fomoPositionUserDrains = new Map<string, Promise<void>>();
interface FomoPositionCooldownRefresh {
  handle: string;
  apiUserId?: string;
  timer: NodeJS.Timeout;
  done: Promise<void>;
  finish: () => void;
}
const fomoPositionCooldownRefreshes = new Map<string, FomoPositionCooldownRefresh>();

const FOMO_API_BACKOFF_BASE_MS = 60_000;
const FOMO_API_BACKOFF_MAX_MS = 5 * 60_000;
const FOMO_API_NO_DATA_BACKOFF_MS = 60_000;

function saveFomoApiOutcome(
  fomoUserId: string,
  endpoint: FomoApiRequestEndpoint,
  outcome: FomoApiOutcome,
  retryAfterMs: number | null,
  now: number,
): void {
  const previous = getFomoApiRequestState(fomoUserId, endpoint);
  let consecutiveFailures = previous?.consecutive_failures ?? 0;
  let delayMs = 0;
  if (outcome === 'success') consecutiveFailures = 0;
  else if (outcome === 'no_data' || outcome === 'incomplete') {
    consecutiveFailures = 0;
    delayMs = FOMO_API_NO_DATA_BACKOFF_MS;
  } else if (outcome === 'upstream_down' || outcome === 'unconfigured') {
    delayMs = FOMO_API_NO_DATA_BACKOFF_MS;
  } else {
    consecutiveFailures += 1;
    delayMs = Math.min(FOMO_API_BACKOFF_MAX_MS, FOMO_API_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
  }
  if (retryAfterMs !== null) delayMs = Math.max(delayMs, retryAfterMs);
  saveFomoApiRequestState({
    fomo_user_id: fomoUserId,
    endpoint,
    last_attempt_at: now,
    next_eligible_at: now + delayMs,
    consecutive_failures: consecutiveFailures,
    last_outcome: outcome,
  });
}

function scheduleFomoPositionCooldownRefresh(
  fomoUserId: string,
  handle: string,
  apiUserId: string | undefined,
  checkedAt: number,
): void {
  const existing = fomoPositionCooldownRefreshes.get(fomoUserId);
  if (existing !== undefined) {
    existing.handle = handle;
    if (apiUserId !== undefined) existing.apiUserId = apiUserId;
    return;
  }
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const pending: FomoPositionCooldownRefresh = {
    handle,
    ...(apiUserId !== undefined ? { apiUserId } : {}),
    timer: setTimeout(() => {
      if (fomoPositionCooldownRefreshes.get(fomoUserId) !== pending) return;
      fomoPositionCooldownRefreshes.delete(fomoUserId);
      const previous = fomoPositionUserDrains.get(fomoUserId) ?? Promise.resolve();
      const drain = previous
        .then(() => withFomoPositionSlot(async () => {
          await refreshFomoBalances(fomoUserId, pending.handle, pending.apiUserId);
        }))
        .catch((e) => log.error('[poller] fomo cooldown refresh', e));
      let settled!: Promise<void>;
      settled = drain.finally(() => {
        pending.finish();
        if (fomoPositionUserDrains.get(fomoUserId) === settled) fomoPositionUserDrains.delete(fomoUserId);
      });
      fomoPositionUserDrains.set(fomoUserId, settled);
    }, Math.max(1, checkedAt + FOMO_POSITION_REFRESH_COOLDOWN_MS - Date.now())),
    done,
    finish,
  };
  fomoPositionCooldownRefreshes.set(fomoUserId, pending);
}

function cancelFomoPositionCooldownRefresh(fomoUserId: string): void {
  const pending = fomoPositionCooldownRefreshes.get(fomoUserId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  fomoPositionCooldownRefreshes.delete(fomoUserId);
  pending.finish();
}

async function withFomoPositionSlot(run: () => Promise<void>): Promise<void> {
  if (activeFomoPositionBatches >= FOMO_POSITION_BATCH_CONCURRENCY) {
    await new Promise<void>((resolve) => fomoPositionSlotWaiters.push(resolve));
  } else {
    activeFomoPositionBatches++;
  }
  try {
    await run();
  } finally {
    const next = fomoPositionSlotWaiters.shift();
    if (next !== undefined) next();
    else activeFomoPositionBatches--;
  }
}

/** Resolve + measure ONE alert's wallet fire-and-forget — never blocks the API
 *  response, never rejects (trackFomoWalletFromTx swallows every failure). */
export function kickFomoHoldings(fomoUserId: string, chain: Chain, ca: string, txHash: string): void {
  if (txHash === '') return;
  fomoKickDrain = fomoKickDrain.then(() => trackFomoWalletFromTx(fomoUserId, chain, ca, txHash));
}

/** Test/observability seam: resolves when queued FOMO holding and API kicks finish. */
export async function fomoHoldingsIdle(): Promise<void> {
  await fomoKickDrain;
  while (true) {
    const pendingBatches = [...fomoPositionAlertBatches.values()].map((batch) => batch.done);
    const drains = [...fomoPositionUserDrains.values()];
    await Promise.all([...drains, ...pendingBatches]);
    if (pendingBatches.length === 0 && fomoPositionAlertBatches.size === 0 && fomoPositionUserDrains.size === 0) return;
  }
}
/** Await delayed position refreshes; unlike fomoHoldingsIdle, this waits through cooldown timers. */
export async function fomoPositionCooldownRefreshIdle(): Promise<void> {
  while (true) {
    const pending = [...fomoPositionCooldownRefreshes.values()].map((refresh) => refresh.done);
    const drains = [...fomoPositionUserDrains.values()];
    await Promise.all([...pending, ...drains]);
    if (pending.length === 0 && fomoPositionCooldownRefreshes.size === 0 && fomoPositionUserDrains.size === 0) return;
  }
}


/** Refresh ONE trader's positions from an alert; never called by a periodic sweep. */
async function refreshFomoBalances(
  fomoUserId: string,
  handle: string,
  apiUserId: string | undefined,
): Promise<FomoPosition[] | null> {
  const now = Date.now();
  const state = getFomoApiRequestState(fomoUserId, 'balances');
  if (state !== undefined && state.next_eligible_at > now) {
    recordFomoApiDeferred('balances', now);
    return null;
  }
  const previous = getFomoPositionSnapshot(fomoUserId);
  if (previous !== undefined && now - previous.checked_at < FOMO_POSITION_REFRESH_COOLDOWN_MS) {
    recordFomoApiDeferred('balances', now);
    scheduleFomoPositionCooldownRefresh(fomoUserId, handle, apiUserId, previous.checked_at);
    return null;
  }
  const fetchedAt = Date.now();
  const result = await fetchFomoBalances(apiUserId ?? handle);
  saveFomoApiOutcome(fomoUserId, 'balances', result.outcome, result.retryAfterMs, Date.now());
  if (result.outcome !== 'success' || result.value === null) return null;
  const positions = result.value;
  const resolved: FomoPositionInput[] = positions.map((p) => ({
    fomo_user_id: fomoUserId,
    ca: p.ca,
    chain: p.chain,
    trade_id: p.tradeId,
    status: p.status,
    amount: p.amount,
    cost_basis_usd: p.costBasisUsd,
    avg_entry_price: p.avgEntryPrice,
    price_usd: p.priceUsd,
    realized_pnl_usd: p.realizedPnlUsd,
    unrealized_pnl_usd: p.unrealizedPnlUsd,
    fetched_at: fetchedAt,
  }));
  const recovered: FomoPosition[] = [];
  const closed: { ca: string; chain: Chain }[] = [];
  // Omission is only a reason to ask the trade detail, never proof of closure.
  // A partial SELL still leaves an open remainder; a later sell timestamp alone
  // must not zero it. Only a trade detail that is closed/zero closes here.
  if (result.complete) {
    const live = new Set(positions.map((p) => `${p.chain}:${canonicalCa(p.ca, p.chain)}`));
    const dashboard = new Set(listTrackedCas().map((c) => `${c.chain}:${canonicalCa(c.address, c.chain)}`));
    const checkedTrades = new Set<string>();
    for (const target of listFomoPositionTargets(fomoUserId, fetchedAt)) {
      const ca = canonicalCa(target.ca, target.chain);
      const key = `${target.chain}:${ca}`;
      if (!dashboard.has(key) || live.has(key)) continue;
      const evidence = getFomoPositionEvidence(fomoUserId, ca, target.chain);
      // No later sell means no closure is even plausible; skip the extra read.
      const laterSell = evidence.sell_ts !== null
        && (evidence.buy_ts === null || evidence.sell_ts >= evidence.buy_ts);
      if (!laterSell || evidence.trade_id === null || checkedTrades.has(evidence.trade_id)) continue;
      checkedTrades.add(evidence.trade_id);
      const detail = await fetchFomoTradeDetail(evidence.trade_id);
      if (
        detail === null ||
        detail.chain !== target.chain ||
        canonicalCa(detail.ca, detail.chain) !== ca
      ) continue;
      if (detail.closed || detail.amount <= 0) {
        closed.push({ ca, chain: target.chain });
        resolved.push({
          fomo_user_id: fomoUserId,
          ca,
          chain: target.chain,
          trade_id: evidence.trade_id,
          status: 'closed',
          amount: 0,
          cost_basis_usd: null,
          avg_entry_price: null,
          price_usd: null,
          realized_pnl_usd: null,
          unrealized_pnl_usd: null,
          fetched_at: fetchedAt,
        });
        continue;
      }
      const position: FomoPosition = {
        ca,
        chain: target.chain,
        tradeId: evidence.trade_id,
        status: 'active',
        amount: detail.amount,
        costBasisUsd: detail.costBasisUsd,
        avgEntryPrice: detail.avgEntryPrice,
        priceUsd: null,
        realizedPnlUsd: detail.realizedPnlUsd,
        unrealizedPnlUsd: null,
      };
      recovered.push(position);
      resolved.push({
        fomo_user_id: fomoUserId,
        ca,
        chain: target.chain,
        trade_id: evidence.trade_id,
        status: 'active',
        amount: detail.amount,
        cost_basis_usd: detail.costBasisUsd,
        avg_entry_price: detail.avgEntryPrice,
        price_usd: null,
        realized_pnl_usd: detail.realizedPnlUsd,
        unrealized_pnl_usd: null,
        fetched_at: fetchedAt,
      });
    }
  }
  syncFomoPositionsSnapshot(fomoUserId, resolved, fetchedAt);
  for (const position of [...recovered, ...closed]) {
    clearFomoPositionPrice(fomoUserId, position.ca, position.chain);
  }
  cancelFomoPositionCooldownRefresh(fomoUserId);
  return [...positions, ...recovered];
}

async function refreshFomoSwaps(fomoUserId: string, identity: string): Promise<FomoSwap[] | null> {
  const now = Date.now();
  const state = getFomoApiRequestState(fomoUserId, 'swaps');
  if (state !== undefined && state.next_eligible_at > now) {
    recordFomoApiDeferred('swaps', now);
    return null;
  }
  const result = await fetchFomoSwaps(identity);
  saveFomoApiOutcome(fomoUserId, 'swaps', result.outcome, result.retryAfterMs, Date.now());
  return result.outcome === 'success' ? result.value : null;
}

async function refreshFomoPositionAlertBatch(
  fomoUserId: string,
  batch: FomoPositionAlertBatch,
): Promise<void> {
  const identity = batch.apiUserId ?? batch.handle;
  const positions = await refreshFomoBalances(fomoUserId, batch.handle, batch.apiUserId);
  type BuyTarget = {
    eventId: string;
    ca: string;
    chain: Chain;
    ts: number;
    tradeId: string | null;
    tradeUsd: number | null;
  };
  const buys: BuyTarget[] = [];
  for (const eventId of batch.eventIds) {
    const trade = getFomoTradeEnrichmentTarget(fomoUserId, eventId);
    if (trade === undefined || trade.type !== 'buy') continue;
    const position = positions?.find((p) => p.ca === trade.ca && p.chain === trade.chain);
    buys.push({
      eventId,
      ca: trade.ca,
      chain: trade.chain,
      ts: trade.ts,
      tradeId: position?.tradeId ?? null,
      tradeUsd: trade.trade_usd,
    });
  }
  if (buys.length === 0) return;
  const targets = buys.filter((buy) => buy.tradeUsd === null);
  // A BUY whose position is absent (or zero) from the balances page needs the
  // trade detail before we trust the omission: FOMO's balances page can omit an
  // open cross-chain position (FLOAT, 2026-10-22), and syncFomoPositionsSnapshot
  // must not leave the dashboard without a Bal.
  const missing = buys.filter((buy) =>
    !positions?.some((p) =>
      p.chain === buy.chain &&
      canonicalCa(p.ca, p.chain) === canonicalCa(buy.ca, buy.chain) &&
      p.amount != null && p.amount > 0,
    ),
  );
  if (targets.length === 0 && missing.length === 0) return;
  const swaps = await refreshFomoSwaps(fomoUserId, identity);
  if (swaps === null) return;
  if (targets.length > 0) {
    const amounts = matchFomoBuySwaps(targets, swaps);
    for (let i = 0; i < targets.length; i++) {
      const amount = amounts[i];
      if (amount !== null && amount !== undefined) updateFomoTradeUsd(fomoUserId, targets[i]!.eventId, amount);
    }
  }
  const checkedTrades = new Set<string>();
  for (const buy of missing) {
    const swapId = buy.eventId.startsWith('fomo-swap:')
      ? buy.eventId.slice('fomo-swap:'.length)
      : buy.eventId;
    const swap = swaps.find((s) => s.id === swapId);
    if (swap?.tradeIdOut == null || checkedTrades.has(swap.tradeIdOut)) continue;
    checkedTrades.add(swap.tradeIdOut);
    const detail = await fetchFomoTradeDetail(swap.tradeIdOut);
    if (detail === null || detail.closed || detail.amount <= 0) continue;
    if (
      detail.chain !== buy.chain ||
      canonicalCa(detail.ca, detail.chain) !== canonicalCa(buy.ca, buy.chain)
    ) continue;
    upsertFomoPosition({
      fomo_user_id: fomoUserId,
      ca: buy.ca,
      chain: buy.chain,
      trade_id: swap.tradeIdOut,
      status: 'active',
      amount: detail.amount,
      cost_basis_usd: detail.costBasisUsd,
      avg_entry_price: detail.avgEntryPrice,
      // A mark, not a fill price: live token_state must drive Bal.
      price_usd: null,
      realized_pnl_usd: detail.realizedPnlUsd,
      unrealized_pnl_usd: null,
      fetched_at: Date.now(),
    });
    clearFomoPositionPrice(fomoUserId, buy.ca, buy.chain);
  }
}

/** Coalesce one trader's alerts for five seconds into one positions/swaps API batch. */
export function kickFomoPositions(
  fomoUserId: string,
  handle: string,
  eventId?: string,
  apiUserId?: string,
): void {
  if (handle === '' || config.fomoProdUrl === '') return;
  const existing = fomoPositionAlertBatches.get(fomoUserId);
  if (existing !== undefined) {
    existing.handle = handle;
    if (apiUserId !== undefined) existing.apiUserId = apiUserId;
    if (eventId !== undefined) existing.eventIds.add(eventId);
    return;
  }
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const batch: FomoPositionAlertBatch = {
    handle,
    ...(apiUserId !== undefined ? { apiUserId } : {}),
    eventIds: new Set(),
    done,
    finish,
  };
  if (eventId !== undefined) batch.eventIds.add(eventId);
  fomoPositionAlertBatches.set(fomoUserId, batch);
  setTimeout(() => {
    const queued = fomoPositionAlertBatches.get(fomoUserId);
    if (queued !== batch) return;
    fomoPositionAlertBatches.delete(fomoUserId);
    const previous = fomoPositionUserDrains.get(fomoUserId) ?? Promise.resolve();
    const drain = previous
      .then(() => withFomoPositionSlot(() => refreshFomoPositionAlertBatch(fomoUserId, batch)))
      .catch((e) => log.error('[poller] fomo alert refresh', e));
    let settled!: Promise<void>;
    settled = drain.finally(() => {
      batch.finish();
      if (fomoPositionUserDrains.get(fomoUserId) === settled) fomoPositionUserDrains.delete(fomoUserId);
    });
    fomoPositionUserDrains.set(fomoUserId, settled);
  }, FOMO_ALERT_BATCH_MS);
}


/** Add hook shares the periodic cache gates; wallet links still get their scoped refresh. */
export function kickCAs(cas: readonly { address: string; chain: Chain }[]): void {
  if (!pollerDeps) return;
  if (pollerScope !== 'wallets') {
    for (const c of cas) {
      void kickToken(pollerDeps.provider, c.address, c.chain).then(() => {
        kickSetupEarly([c]);
      });
    }
  }
  if (pollerScope !== 'market') kickWalletHoldingsFor(cas);
}

// Newly-added tokens enter the same queue as chart and background refreshes.
const earlySetupPending = new Map<string, { address: string; chain: Chain }>();
let earlySetupDrain: Promise<void> = Promise.resolve();

export function kickSetupEarly(cas: readonly { address: string; chain: Chain }[]): void {
  if (!config.crawlEnabled) return; // crawl off ⇒ no door, no setupSweep either — nothing to front-run
  for (const c of cas) earlySetupPending.set(cacheKey(c.address, c.chain), c);
  earlySetupDrain = earlySetupDrain.then(drainEarlySetup);
}

async function drainEarlySetup(): Promise<void> {
  const batch = [...earlySetupPending.values()];
  earlySetupPending.clear();
  await Promise.all(batch.map(async (c) => {
    try {
      await refreshSeries(c.address, c.chain);
    } catch (e) {
      log.error('[poller] earlySetup', c.address, e);
    }
  }));
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

/** Fill a new token's initial row once, then seed each dataset's durable cadence. */
const tokenInfoBootstraps = new Map<string, Promise<void>>();

function bootstrapMetricPatch(info: TokenInfo, kind: MetricKind): MetricPatch {
  if (kind === 'essential') {
    return {
      ...(typeof info.price === 'number' && info.price > 0 ? { price: info.price } : {}),
      ...(typeof info.marketCap === 'number' && info.marketCap > 0 ? { marketCap: info.marketCap } : {}),
      ...(info.supply > 0 ? { supply: info.supply } : {}),
      ...(info.liquidity > 0 ? { liquidity: info.liquidity } : {}),
      ...(info.holders > 0 ? { holders: info.holders } : {}),
      ...(info.symbol !== undefined ? { symbol: info.symbol } : {}),
      ...(info.deployedAt !== undefined ? { deployedAt: info.deployedAt } : {}),
    };
  }
  if (kind === 'volume') {
    return {
      volume24h: info.volume24h,
      buyVol24h: info.buyVol24h,
      sellVol24h: info.sellVol24h,
      ...(info.volume1h !== undefined ? { volume1h: info.volume1h } : {}),
    };
  }
  return info.nansenStats
    ? {
        nansenHolders: info.nansenStats.holders,
        nansenFreshPct: info.nansenStats.freshSupplyPct,
        ...(info.nansenStats.t100SupplyPct !== undefined ? { nansenT100Pct: info.nansenStats.t100SupplyPct } : {}),
        ...(info.nansenStats.medianBalanceUsd !== undefined ? { nansenMedianUsd: info.nansenStats.medianBalanceUsd } : {}),
      }
    : {};
}

function bootstrapMarketPatch(info: TokenInfo): MetricPatch {
  return {
    ...bootstrapMetricPatch(info, 'essential'),
    ...bootstrapMetricPatch(info, 'volume'),
  };
}

function metricIntervalFor(kind: MetricKind): number {
  if (kind === 'essential') return MIN_MARKET_CAP_QUERY_INTERVAL_MS;
  if (kind === 'volume') return metricInterval(kind, config.pollVolumeMs);
  return config.pollSetupMs;
}

async function bootstrapTokenInfo(provider: MarketDataProvider, address: string, chain: Chain): Promise<void> {
  const key = `${chain}:${address}`;
  const active = tokenInfoBootstraps.get(key);
  if (active) return active;
  if (METRIC_KINDS.some((kind) => getMetricPollCache(address, chain, kind))) return;

  const now = Date.now();
  const intervals = new Map(METRIC_KINDS.map((kind) => [kind, metricIntervalFor(kind)]));
  const resourceReservation = sharedMarketMetric('essential')
    ? reserveMetricPoll(address, chain, GMGN_MARKET_CACHE_KIND, now, MIN_MARKET_CAP_QUERY_INTERVAL_MS)
    : undefined;
  if (resourceReservation && !resourceReservation.claimed) return;
  const reservations = new Map<MetricKind, MetricPollReservation>();
  for (const kind of METRIC_KINDS) {
    reservations.set(kind, reserveMetricPoll(address, chain, kind, now, intervals.get(kind)!));
  }
  if ([...reservations.values()].some((reservation) => !reservation.claimed)) return;

  const request = (async () => {
    try {
      const info = await provider.tokenInfo(address, chain);
      const responseAt = Date.now();
      if (resourceReservation) {
        saveMetricPollResponse(
          address, chain, GMGN_MARKET_CACHE_KIND, responseAt,
          responseAt + MIN_MARKET_CAP_QUERY_INTERVAL_MS, bootstrapMarketPatch(info),
        );
      }
      upsertTokenInfo(info);
      if (info.nansenStats) {
        updateNansenHolders(address, chain, info.nansenStats);
        if (Number.isFinite(info.nansenStats.freshSupplyPct)) {
          stampSetupCacheField(address, chain, 'info_at', responseAt);
        }
      }
      for (const kind of METRIC_KINDS) {
        const intervalMs = intervals.get(kind)!;
        const patch = bootstrapMetricPatch(info, kind);
        if (kind === 'gini' && patch.nansenFreshPct === undefined) {
          failMetricPoll(address, chain, kind, responseAt + config.pollSetupRetryMs);
        } else {
          saveMetricPollResponse(address, chain, kind, responseAt, responseAt + intervalMs, patch);
        }
      }
    } catch (error) {
      const transientFwFailure = error instanceof NansenDoorError && error.transient;
      const retryAt = Date.now() + Math.min(config.pollSetupSweepMs, METRIC_RECOVERY_RETRY_MS);
      for (const kind of METRIC_KINDS) {
        const intervalMs = intervals.get(kind)!;
        const previousFailures = reservations.get(kind)?.row?.failure_count ?? 0;
        if (kind === 'gini' && transientFwFailure) {
          deferMetricPoll(address, chain, kind, retryAt);
        } else {
          failMetricPoll(
            address,
            chain,
            kind,
            failureNextAllowedAt(previousFailures, metricFailureInterval(kind, intervalMs), Date.now()),
          );
        }
      }
      if (resourceReservation) {
        failMetricPoll(
          address,
          chain,
          GMGN_MARKET_CACHE_KIND,
          failureNextAllowedAt(
            resourceReservation.row?.failure_count ?? 0,
            MIN_MARKET_CAP_QUERY_INTERVAL_MS,
            Date.now(),
          ),
        );
      }
      if (transientFwFailure) log.info('[collector] fw_finish', {
        ca: address, chain, outcome: 'door_retry', retryClass: 'transient',
        nextAllowedAt: retryAt, lastSuccessAt: reservations.get('gini')?.row?.response_at ?? null,
        failures: reservations.get('gini')?.row?.failure_count ?? 0,
      });
      throw error;
    }
  })();
  tokenInfoBootstraps.set(key, request);
  try {
    await request;
  } finally {
    if (tokenInfoBootstraps.get(key) === request) tokenInfoBootstraps.delete(key);
  }
}

async function applyDueMetric(
  provider: MarketDataProvider,
  address: string,
  chain: Chain,
  kind: MetricKind,
): Promise<void> {
  const result = await cachedMetric(provider, address, chain, kind, metricIntervalFor(kind));
  if (!result.fetched || !result.patch) return;
  applyMetricPatch(address, chain, kind, result.patch);
  if (kind === 'gini' && typeof result.patch.nansenFreshPct === 'number' && result.responseAt !== null) {
    log.info('[collector] fw_applied', {
      ca: address, chain, source: 'upstream', responseAt: result.responseAt,
      freshPct: result.patch.nansenFreshPct,
    });
  }
  if (kind === 'gini' && typeof result.patch.nansenFreshPct === 'number' && result.responseAt !== null) {
    stampSetupCacheField(address, chain, 'info_at', result.responseAt);
  }
}

/** Rebuild token_state from persisted provider responses without another request. */
function rehydrateCachedToken(ca: string, chain: Chain): void {
  const marketRow = sharedMarketMetric('essential')
    ? getMetricPollCache(ca, chain, GMGN_MARKET_CACHE_KIND)
    : undefined;
  const marketPatch = cachedPatch(marketRow);
  const essentialRow = getMetricPollCache(ca, chain, 'essential');
  const essential = cachedPatch(essentialRow)
    ?? (marketPatch ? metricProjection(marketPatch, ESSENTIAL_FIELDS) : null);
  if (essential) {
    const price = typeof essential.price === 'number' && Number.isFinite(essential.price) && essential.price > 0
      ? essential.price
      : undefined;
    const supply = typeof essential.supply === 'number' && Number.isFinite(essential.supply) && essential.supply >= 0
      ? essential.supply
      : undefined;
    const marketCap = price !== undefined && supply !== undefined && Number.isFinite(price * supply)
      ? price * supply
      : undefined;
    updateTokenMetrics(
      ca,
      chain,
      { ...essential, price, supply, marketCap },
      essentialRow?.response_at ?? marketRow?.response_at ?? Date.now(),
    );
  }

  const volumeRow = getMetricPollCache(ca, chain, 'volume');
  const volume = cachedPatch(volumeRow)
    ?? (marketPatch ? metricProjection(marketPatch, VOLUME_FIELDS) : null);
  if (volume && hasMetricFields(volume)) {
    const responseAt = volumeRow?.response_at ?? marketRow?.response_at ?? Date.now();
    updateTokenMetrics(
      ca,
      chain,
      {
        ...volume,
        ...(volume.volume24h !== undefined
          ? { vol24hPrev: volume.volume24h, vol24hPrevAt: responseAt }
          : {}),
      },
      responseAt,
    );
  }

  const giniRow = getMetricPollCache(ca, chain, 'gini');
  const gini = cachedPatch(giniRow);
  if (gini && hasMetricFields(gini)) {
    updateTokenMetrics(ca, chain, gini, giniRow?.response_at ?? Date.now());
  }
}

/** Cold CA add queries once; re-adds restore cached state and fetch only datasets due. */
export function kickToken(provider: MarketDataProvider, address: string, chain: Chain): Promise<void> {
  return (async () => {
    try {
      if (!METRIC_KINDS.some((kind) => getMetricPollCache(address, chain, kind))) {
        await bootstrapTokenInfo(provider, address, chain);
        return;
      }
      if (!getTokenState(address, chain)) rehydrateCachedToken(address, chain);
      await Promise.all(METRIC_KINDS.map(async (kind) => {
        try {
          await applyDueMetric(provider, address, chain, kind);
        } catch (error) {
          log.error('[poller] kickToken', kind, address, error);
        }
      }));
    } catch (e) {
      log.error('[poller] kickToken', address, e);
    }
  })();
}

/** Cache one CA's Nansen balance series (one full-series fetch, 3 sliced windows) now. */
export function kickNansen(address: string, chain: Chain): void {
  if (pollerScope === 'wallets') return;
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
 * `anchorAt + n × intervalMs` boundary at or after `now` — setupSweep cadence
 * boundaries count from the systemDeployAt setting, so restarts RE-PHASE to the same
 * boundaries instead of drifting. `now` exactly on a boundary (incl. a fresh
 * deploy, anchor == now) fires immediately: that instant IS boundary n.
 */
export function nextPhaseDelayMs(anchorAt: number, now: number, intervalMs: number): number {
  const n = Math.ceil((now - anchorAt) / intervalMs);
  return Math.max(0, anchorAt + n * intervalMs - now);
}

/** Starts the sweeps with staggered initial delays (20s apart, in this order). */
export function startPoller(
  provider: MarketDataProvider,
  nansenApi: NansenApiClient | null,
  tokenFlows?: TokenFlowsClient | null,
  scope: PollerScope = 'all',
  gmgnIconProvider?: GmgnIconProvider,
): void {
  pollerScope = scope;
  setPollerDeps(provider, nansenApi, tokenFlows);
  const tasks: PollTask[] = [];
  if (scope !== 'wallets') {
    tasks.push(
      { name: 'essentialSweep', intervalMs: config.pollEssentialMs, fn: () => metricSweep(provider, 'essential', config.pollEssentialMs) },
      {
        name: 'essentialGapSweep',
        intervalMs: config.pollEssentialGapMs,
        fn: () =>
          metricSweep(
            provider,
            'essential',
            config.pollEssentialGapMs,
            listCaTargetsMissingEssential().filter((c) => !isTooNewToken(c.address, c.chain, Date.now())),
          ),
      },
      { name: 'volumeSweep', intervalMs: config.pollVolumeMs, fn: () => metricSweep(provider, 'volume', config.pollVolumeMs) },
      { name: 'flowsSweep', intervalMs: config.pollFlowsMs, fn: () => flowsSweep() },
      { name: 'symbolBackfillSweep', intervalMs: config.pollSymbolBackfillMs, fn: () => symbolBackfillSweep(provider) },
      { name: 'dexMarketSweep', intervalMs: config.pollIconMs, fn: () => dexMarketSweep() },
    );
    if (gmgnIconProvider) {
      tasks.push({ name: 'gmgnIconSweep', intervalMs: config.pollIconMs, fn: () => gmgnIconSweep(gmgnIconProvider) });
    }
  }
  if (scope !== 'market') {
    tasks.push({ name: 'walletSweep', intervalMs: config.pollWalletsMs, fn: () => walletSweep(provider) });
  }
  if (scope !== 'wallets' && config.crawlEnabled) {
    // F1=(b) (plan setup-fill-on-add T5): the marks count from the SYSTEM deploy
    // anchor in settings (written once by db.open(), never overwritten), not from
    // process boot.
    const rawAnchor = Number(getSetting('systemDeployAt'));
    const anchorAt = Number.isFinite(rawAnchor) ? rawAnchor : Date.now();
    const delay = nextPhaseDelayMs(anchorAt, Date.now(), config.pollSetupSweepMs);
    tasks.push({ name: 'setupSweep', intervalMs: config.pollSetupSweepMs, initialDelayMs: delay, fn: () => setupSweep(provider) });
    log.info(`[poller] setupSweep anchored to systemDeployAt=${new Date(anchorAt).toISOString()} — cadence=${config.pollSetupSweepMs}ms, next pass in ${Math.round(delay / 1000)}s`);
  }
  log.info(`[poller] setup sweep cadence=${config.pollSetupSweepMs}ms; failed-field retry base=${config.pollSetupRetryMs}ms; Fresh TTL=${config.pollSetupMs}ms`);
  tasks.forEach((task, i) => {
    setTimeout(() => {
      void run(task);
    }, task.initialDelayMs ?? i * 20_000);
  });
}
