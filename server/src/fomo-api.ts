// FOMO API client (api.fomoapi.io): position holdings and per-fill enrichment.
//
// Position amounts are authoritative; marks are kept separate from token quantity.
// Calls return typed outcomes, not guessed empty data: poller callers preserve the
// last good snapshot unless a complete positions payload was received.

import { canonicalCa, type Chain } from './shared/chain.js';
import { config } from './config.js';

export type FomoApiEndpoint = 'positions' | 'swaps';
export type FomoApiOutcome =
  | 'success'
  | 'no_data'
  | 'incomplete'
  | 'invalid_payload'
  | 'http_error'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'upstream_down'
  | 'unconfigured'
  | 'deferred';
export type FomoHealthStatus = 'operational' | 'degraded' | 'down' | 'unknown';

export interface FomoApiResult<T> {
  outcome: FomoApiOutcome;
  value: T | null;
  status: number | null;
  attempts: number;
  attemptFailures: number;
  creditsCost: number;
  retryAfterMs: number | null;
}

export interface FomoApiEndpointUsage {
  endpoint: FomoApiEndpoint;
  operations: number;
  attemptedOperations: number;
  attempts: number;
  attemptFailures: number;
  successes: number;
  noData: number;
  incomplete: number;
  failures: number;
  deferred: number;
  creditsCost: number;
  lastOutcome: FomoApiOutcome | null;
  lastOutcomeAtMs: number | null;
}

export interface FomoApiUsageSnapshot {
  sampledAtMs: number;
  windowMs: number;
  upstream: {
    apiStatus: FomoHealthStatus;
    liveDataStatus: FomoHealthStatus;
    checkedAtMs: number | null;
  };
  endpoints: FomoApiEndpointUsage[];
}

export interface FomoPosition {
  ca: string;
  chain: Chain;
  tradeId: string | null;
  status: string | null;
  amount: number | null;
  costBasisUsd: number | null;
  avgEntryPrice: number | null;
  priceUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
}

// API chain names -> the repo's Chain union. A name outside the map (ethereum,
// hyperliquid) is a chain this repo cannot track -> the position is SKIPPED.
const CHAIN_BY_API_NAME: Record<string, Chain> = {
  solana: 'sol',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
};


export interface FomoSwapLeg {
  address: string;
  usd: number | null;
}

/** One on-chain fill from `/v2/users/{handle}/swaps`; unlike `trades`, this is
 *  an individual swap, not an aggregated position. */
export interface FomoSwap {
  chain: Chain;
  at: number;
  tradeIdOut: string | null;
  tokenIn: FomoSwapLeg;
  tokenOut: FomoSwapLeg;
}

export interface FomoBuySwapTarget {
  ca: string;
  chain: Chain;
  ts: number;
  tradeId: string | null;
}


function toSwapLeg(value: unknown): FomoSwapLeg | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('address' in value) || !('usd' in value)) return null;
  if (typeof value.address !== 'string' || value.address === '') return null;
  const usd = value.usd;
  if (usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)) return null;
  return { address: value.address, usd };
}

function toSwap(value: unknown): FomoSwap | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('chain' in value) || !('at' in value) || !('tokenIn' in value) || !('tokenOut' in value)) return null;
  if (typeof value.chain !== 'string') return null;
  const chain = CHAIN_BY_API_NAME[value.chain];
  if (chain === undefined) return undefined;
  const at = timestampMs(value.at);
  const tokenIn = toSwapLeg(value.tokenIn);
  const tokenOut = toSwapLeg(value.tokenOut);
  if (at === null || tokenIn === null || tokenOut === null) return null;
  return { chain, at, tradeIdOut: 'tradeIdOut' in value ? strOrNull(value.tradeIdOut) : null, tokenIn, tokenOut };
}

/** Resolve a BUY only when exactly one swap matches the FOMO position, token,
 *  chain, and alert's five-second timestamp bucket. `tokenIn.usd` is the USD
 *  value of what the trader spent; position marks are not used as fill size. */
export function matchFomoBuySwaps(targets: readonly FomoBuySwapTarget[], swaps: readonly FomoSwap[]): (number | null)[] {
  const matchesByTarget = targets.map((target) => {
    const ca = canonicalCa(target.ca, target.chain);
    return swaps.filter((swap) =>
      swap.chain === target.chain &&
      canonicalCa(swap.tokenOut.address, swap.chain) === ca &&
      (target.tradeId === null || swap.tradeIdOut === target.tradeId) &&
      swap.at >= target.ts &&
      swap.at < target.ts + 5_000,
    );
  });
  const candidateUseCount = new Map<FomoSwap, number>();
  for (const matches of matchesByTarget) {
    for (const swap of matches) candidateUseCount.set(swap, (candidateUseCount.get(swap) ?? 0) + 1);
  }
  return matchesByTarget.map((matches) => {
    if (matches.length !== 1) return null;
    const match = matches[0]!;
    if (candidateUseCount.get(match) !== 1 || match.tradeIdOut === null) return null;
    const amount = match.tokenIn.usd;
    return amount !== null && amount > 0 ? amount : null;
  });
}

/** Resolve one BUY only when exactly one swap matches its position, token, chain, and alert time. */
export function matchFomoBuySwap(target: FomoBuySwapTarget, swaps: readonly FomoSwap[]): number | null {
  return matchFomoBuySwaps([target], swaps)[0] ?? null;
}

/** One recent page of individual fills; pass FOMO's stable userId when known. */
export async function fetchFomoSwaps(identity: string): Promise<FomoApiResult<FomoSwap[]>> {
  const request = await requestFomoEndpoint('swaps', identity);
  if (request.outcome !== 'success') return finishFomoResult<FomoSwap[]>('swaps', request, request.outcome, null);
  if (!isRecord(request.body)) return finishFomoResult<FomoSwap[]>('swaps', request, 'invalid_payload', null);
  if (request.body.available === false) return finishFomoResult<FomoSwap[]>('swaps', request, 'no_data', null);
  if (request.body.partial === true || request.body.truncated === true) {
    return finishFomoResult<FomoSwap[]>('swaps', request, 'incomplete', null);
  }
  if (!Array.isArray(request.body.swaps)) return finishFomoResult<FomoSwap[]>('swaps', request, 'invalid_payload', null);
  const swaps: FomoSwap[] = [];
  for (const raw of request.body.swaps) {
    const swap = toSwap(raw);
    if (swap === null) return finishFomoResult<FomoSwap[]>('swaps', request, 'invalid_payload', null);
    if (swap !== undefined) swaps.push(swap);
  }
  return finishFomoResult('swaps', request, 'success', swaps);
}

const timestampMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 3_000;
const STATUS_CACHE_MS = 15_000;
const TELEMETRY_WINDOW_MS = 5 * 60_000;
const TELEMETRY_BUCKET_MS = 5_000;
const TELEMETRY_BUCKET_COUNT = TELEMETRY_WINDOW_MS / TELEMETRY_BUCKET_MS;

interface FomoApiRequest {
  outcome: FomoApiOutcome;
  body: unknown;
  status: number | null;
  attempts: number;
  attemptFailures: number;
  creditsCost: number;
  retryAfterMs: number | null;
}

interface TelemetryBucket {
  startAtMs: number;
  operations: number;
  attemptedOperations: number;
  attempts: number;
  attemptFailures: number;
  successes: number;
  noData: number;
  incomplete: number;
  failures: number;
  deferred: number;
  creditsCost: number;
  lastOutcome: FomoApiOutcome | null;
  lastOutcomeAtMs: number | null;
}

type CachedHealth = FomoApiUsageSnapshot['upstream'] & {
  base: string;
  checkedAtMs: number;
};

const telemetryBuckets: Record<FomoApiEndpoint, Array<TelemetryBucket | null>> = {
  positions: Array.from({ length: TELEMETRY_BUCKET_COUNT }, () => null),
  swaps: Array.from({ length: TELEMETRY_BUCKET_COUNT }, () => null),
};
let cachedHealth: CachedHealth | null = null;
let healthInFlight: { base: string; promise: Promise<FomoApiUsageSnapshot['upstream']> } | null = null;

function emptyBucket(startAtMs: number): TelemetryBucket {
  return {
    startAtMs,
    operations: 0,
    attemptedOperations: 0,
    attempts: 0,
    attemptFailures: 0,
    successes: 0,
    noData: 0,
    incomplete: 0,
    failures: 0,
    deferred: 0,
    creditsCost: 0,
    lastOutcome: null,
    lastOutcomeAtMs: null,
  };
}

function bucketFor(endpoint: FomoApiEndpoint, atMs: number): TelemetryBucket {
  const startAtMs = Math.floor(atMs / TELEMETRY_BUCKET_MS) * TELEMETRY_BUCKET_MS;
  const index = Math.floor(startAtMs / TELEMETRY_BUCKET_MS) % TELEMETRY_BUCKET_COUNT;
  const buckets = telemetryBuckets[endpoint];
  let bucket = buckets[index];
  if (bucket === null || bucket.startAtMs !== startAtMs) {
    bucket = emptyBucket(startAtMs);
    buckets[index] = bucket;
  }
  return bucket;
}

const FAILURE_OUTCOMES: Partial<Record<FomoApiOutcome, true>> = {
  invalid_payload: true,
  http_error: true,
  rate_limited: true,
  timeout: true,
  network_error: true,
  upstream_down: true,
  unconfigured: true,
};

function recordResult(endpoint: FomoApiEndpoint, result: FomoApiResult<unknown>, atMs = Date.now()): void {
  const bucket = bucketFor(endpoint, atMs);
  bucket.operations += 1;
  if (result.attempts > 0) bucket.attemptedOperations += 1;
  bucket.attempts += result.attempts;
  bucket.attemptFailures += result.attemptFailures;
  bucket.creditsCost += result.creditsCost;
  if (result.outcome === 'success') bucket.successes += 1;
  else if (result.outcome === 'no_data') bucket.noData += 1;
  else if (result.outcome === 'incomplete') bucket.incomplete += 1;
  else if (FAILURE_OUTCOMES[result.outcome] === true) bucket.failures += 1;
  bucket.lastOutcome = result.outcome;
  bucket.lastOutcomeAtMs = atMs;
}

/** Record an alert batch skipped by the persisted per-user endpoint backoff. */
export function recordFomoApiDeferred(endpoint: FomoApiEndpoint, atMs = Date.now()): void {
  const bucket = bucketFor(endpoint, atMs);
  bucket.operations += 1;
  bucket.deferred += 1;
  bucket.lastOutcome = 'deferred';
  bucket.lastOutcomeAtMs = atMs;
}

function usageFor(endpoint: FomoApiEndpoint, now: number): FomoApiEndpointUsage {
  const result: FomoApiEndpointUsage = {
    endpoint,
    operations: 0,
    attemptedOperations: 0,
    attempts: 0,
    attemptFailures: 0,
    successes: 0,
    noData: 0,
    incomplete: 0,
    failures: 0,
    deferred: 0,
    creditsCost: 0,
    lastOutcome: null,
    lastOutcomeAtMs: null,
  };
  for (const bucket of telemetryBuckets[endpoint]) {
    if (bucket === null || bucket.startAtMs <= now - TELEMETRY_WINDOW_MS || bucket.startAtMs > now) continue;
    result.operations += bucket.operations;
    result.attemptedOperations += bucket.attemptedOperations;
    result.attempts += bucket.attempts;
    result.attemptFailures += bucket.attemptFailures;
    result.successes += bucket.successes;
    result.noData += bucket.noData;
    result.incomplete += bucket.incomplete;
    result.failures += bucket.failures;
    result.deferred += bucket.deferred;
    result.creditsCost += bucket.creditsCost;
    if (bucket.lastOutcomeAtMs !== null &&
        (result.lastOutcomeAtMs === null || bucket.lastOutcomeAtMs > result.lastOutcomeAtMs)) {
      result.lastOutcome = bucket.lastOutcome;
      result.lastOutcomeAtMs = bucket.lastOutcomeAtMs;
    }
  }
  return result;
}

/** Low-cardinality, rolling five-minute counters; no user or URL identifiers. */
export function getFomoApiUsageSnapshot(now = Date.now()): FomoApiUsageSnapshot {
  const healthIsFresh = cachedHealth !== null &&
    cachedHealth.base === config.fomoApiBase &&
    now - cachedHealth.checkedAtMs <= 60_000;
  return {
    sampledAtMs: now,
    windowMs: TELEMETRY_WINDOW_MS,
    upstream: healthIsFresh && cachedHealth !== null
      ? {
        apiStatus: cachedHealth.apiStatus,
        liveDataStatus: cachedHealth.liveDataStatus,
        checkedAtMs: cachedHealth.checkedAtMs,
      }
      : { apiStatus: 'unknown', liveDataStatus: 'unknown', checkedAtMs: null },
    endpoints: [usageFor('positions', now), usageFor('swaps', now)],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusValue(value: unknown): FomoHealthStatus {
  return value === 'operational' || value === 'degraded' || value === 'down' ? value : 'unknown';
}

async function fomoUpstreamHealth(): Promise<FomoApiUsageSnapshot['upstream']> {
  const base = config.fomoApiBase;
  const now = Date.now();
  if (cachedHealth?.base === base && now - cachedHealth.checkedAtMs < STATUS_CACHE_MS) {
    return {
      apiStatus: cachedHealth.apiStatus,
      liveDataStatus: cachedHealth.liveDataStatus,
      checkedAtMs: cachedHealth.checkedAtMs,
    };
  }
  if (healthInFlight?.base === base) return healthInFlight.promise;
  const promise = (async (): Promise<FomoApiUsageSnapshot['upstream']> => {
    let state: FomoApiUsageSnapshot['upstream'] = {
      apiStatus: 'unknown',
      liveDataStatus: 'unknown',
      checkedAtMs: Date.now(),
    };
    try {
      const response = await fetch(new URL(`${base}/status`), {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (isRecord(payload) && isRecord(payload.components)) {
          const api = payload.components.api;
          const liveData = payload.components.liveData;
          state = {
            apiStatus: isRecord(api) ? statusValue(api.status) : 'unknown',
            liveDataStatus: isRecord(liveData) ? statusValue(liveData.status) : 'unknown',
            checkedAtMs: Date.now(),
          };
        }
      }
    } catch {
      // A failed keyless status probe must not prevent the alert-triggered read.
    }
    cachedHealth = { ...state, checkedAtMs: state.checkedAtMs ?? Date.now(), base };
    return state;
  })();
  healthInFlight = { base, promise };
  try {
    return await promise;
  } finally {
    if (healthInFlight?.promise === promise) healthInFlight = null;
  }
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function requestFomoEndpoint(endpoint: FomoApiEndpoint, identity: string): Promise<FomoApiRequest> {
  const empty: FomoApiRequest = {
    outcome: 'unconfigured',
    body: null,
    status: null,
    attempts: 0,
    attemptFailures: 0,
    creditsCost: 0,
    retryAfterMs: null,
  };
  if (config.fomoApiKey === '') return empty;

  const health = await fomoUpstreamHealth();
  if (health.apiStatus === 'down' || health.liveDataStatus === 'down') {
    return { ...empty, outcome: 'upstream_down' };
  }
  const maxAttempts = health.apiStatus === 'operational' && health.liveDataStatus === 'operational' ? ATTEMPTS : 1;
  const url = new URL(`${config.fomoApiBase}/v2/users/${encodeURIComponent(identity)}/${endpoint}`);
  if (endpoint === 'swaps') url.searchParams.set('limit', '100');
  let attempts = 0;
  let attemptFailures = 0;
  let creditsCost = 0;
  let status: number | null = null;
  let lastOutcome: FomoApiOutcome = 'network_error';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts += 1;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${config.fomoApiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      attemptFailures += 1;
      lastOutcome = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'timeout'
        : 'network_error';
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      return { ...empty, outcome: lastOutcome, attempts, attemptFailures, creditsCost };
    }

    status = response.status;
    const costHeader = response.headers.get('x-credits-cost');
    const parsedCost = costHeader === null ? NaN : Number(costHeader);
    if (Number.isFinite(parsedCost) && parsedCost >= 0) creditsCost += parsedCost;
    if (!response.ok) {
      attemptFailures += 1;
      const retryAfter = (status === 429 || status === 503)
        ? retryAfterMs(response.headers.get('retry-after'), Date.now())
        : null;
      if (status === 429) {
        return { ...empty, outcome: 'rate_limited', status, attempts, attemptFailures, creditsCost, retryAfterMs: retryAfter };
      }
      if (status !== 503 || retryAfter !== null || attempt === maxAttempts) {
        return { ...empty, outcome: 'http_error', status, attempts, attemptFailures, creditsCost, retryAfterMs: retryAfter };
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ...empty, outcome: 'invalid_payload', status, attempts, attemptFailures, creditsCost };
    }
    return { ...empty, outcome: 'success', body, status, attempts, attemptFailures, creditsCost };
  }
  return { ...empty, outcome: lastOutcome, status, attempts, attemptFailures, creditsCost };
}

function finishFomoResult<T>(
  endpoint: FomoApiEndpoint,
  request: FomoApiRequest,
  outcome: FomoApiOutcome,
  value: T | null,
): FomoApiResult<T> {
  const result: FomoApiResult<T> = {
    outcome,
    value,
    status: request.status,
    attempts: request.attempts,
    attemptFailures: request.attemptFailures,
    creditsCost: request.creditsCost,
    retryAfterMs: request.retryAfterMs,
  };
  recordResult(endpoint, result);
  return result;
}

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);


function toPosition(raw: Record<string, unknown>): FomoPosition | null | undefined {
  if (typeof raw.chain !== 'string') return null;
  const chain = CHAIN_BY_API_NAME[raw.chain];
  if (chain === undefined) return undefined;
  const token = raw.token as { address?: unknown } | undefined;
  const address = typeof token?.address === 'string' ? token.address : '';
  if (address === '') return null;
  const status = strOrNull(raw.status);
  const amount = numOrNull(raw.amount);
  if (status !== 'closed' && amount === null) return null;
  if (raw.amount != null && (amount === null || amount < 0)) return null;
  return {
    ca: canonicalCa(address, chain),
    chain,
    tradeId: strOrNull(raw.tradeId),
    status,
    // A closed position's amount describes historical traded size, not holdings.
    amount: status === 'closed' ? 0 : amount,
    costBasisUsd: numOrNull(raw.costBasisUsd),
    avgEntryPrice: numOrNull(raw.avgEntryPrice),
    priceUsd: numOrNull(raw.priceUsd),
    realizedPnlUsd: numOrNull(raw.realizedPnlUsd),
    unrealizedPnlUsd: numOrNull(raw.unrealizedPnlUsd),
  };
}

/** One page includes all open positions; older pages only add closed history. */
export async function fetchFomoPositions(identity: string): Promise<FomoApiResult<FomoPosition[]>> {
  const request = await requestFomoEndpoint('positions', identity);
  if (request.outcome !== 'success') return finishFomoResult<FomoPosition[]>('positions', request, request.outcome, null);
  if (!isRecord(request.body)) return finishFomoResult<FomoPosition[]>('positions', request, 'invalid_payload', null);
  if (request.body.available === false) return finishFomoResult<FomoPosition[]>('positions', request, 'no_data', null);
  if (request.body.partial === true || request.body.truncated === true) {
    return finishFomoResult<FomoPosition[]>('positions', request, 'incomplete', null);
  }
  if (!Array.isArray(request.body.trades)) return finishFomoResult<FomoPosition[]>('positions', request, 'invalid_payload', null);
  const positions: FomoPosition[] = [];
  const seen = new Set<string>();
  for (const raw of request.body.trades) {
    if (!isRecord(raw)) return finishFomoResult<FomoPosition[]>('positions', request, 'invalid_payload', null);
    const position = toPosition(raw);
    if (position === null) return finishFomoResult<FomoPosition[]>('positions', request, 'invalid_payload', null);
    if (position === undefined) continue;
    const key = `${position.chain}:${position.ca}`;
    if (seen.has(key)) return finishFomoResult<FomoPosition[]>('positions', request, 'invalid_payload', null);
    seen.add(key);
    positions.push(position);
  }
  return finishFomoResult('positions', request, 'success', positions);
}
