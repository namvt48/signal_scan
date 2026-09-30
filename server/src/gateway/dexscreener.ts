// DexScreener provider route for the gateway (plan request-plane-gateway, todo 9).
//
// DexScreener meters TWO CLASSES of endpoint at DIFFERENT rates, so one limiter
// key cannot govern both:
//   * pairs / tokens / search  → 300 req/min  (key `dexscreener`)
//   * profiles / boosts        →  60 req/min  (key `dexscreener-profiles`)
// The existing `dexscreener` key name is KEPT and now carries the STANDARD class
// (300/min) — the old single spec was 60/min and would wrongly throttle token
// lookups; the profiles class gets the NEW key. A `Limiter` holds exactly one
// `window` (`ratelimit/limiter.ts:44`), so two classes REQUIRE two keys. Both
// windows stay env-tunable (`ratelimit/spec.ts`).
//
// The route picks the limiter class from the request `endpoint` and returns the
// RAW upstream body via the shared `proxyRequest` contract (todo 3). Keyless:
// DexScreener needs no credentials.

import type { Priority } from '../ratelimit/types.js';
import {
  denial,
  proxyRequest,
  type DispatchResult,
  type GatewayRequest,
  type LimiterRun,
  type ParamMap,
  type UpstreamFetch,
} from './contract.js';
import type { Caller } from './auth.js';

/** Standard class limiter key (pairs/tokens/search, 300 req/min). */
export const DEXSCREENER_LIMITER = 'dexscreener';
/** Profiles class limiter key (profiles/boosts, 60 req/min). */
export const DEXSCREENER_PROFILES_LIMITER = 'dexscreener-profiles';

export type DexEndpoint = 'tokens' | 'pairs' | 'search' | 'profiles' | 'boosts';

const ENDPOINTS: readonly DexEndpoint[] = ['tokens', 'pairs', 'search', 'profiles', 'boosts'];

/** The class dimension: endpoint → limiter key. */
const LIMITER_BY_ENDPOINT: Record<DexEndpoint, string> = {
  tokens: DEXSCREENER_LIMITER,
  pairs: DEXSCREENER_LIMITER,
  search: DEXSCREENER_LIMITER,
  profiles: DEXSCREENER_PROFILES_LIMITER,
  boosts: DEXSCREENER_PROFILES_LIMITER,
};

/** Full route path (mounted under the `/v1` auth prefix in `app.ts`). */
export const DEXSCREENER_PATH = '/v1/dexscreener';

/** Upstream base — keyless and free (matches `providers/dexscreener.ts`). */
export const DEXSCREENER_BASE = 'https://api.dexscreener.com';

/** The route body: which DexScreener endpoint, its query params, at which urgency. */
export interface DexScreenerParams {
  endpoint: DexEndpoint;
  /** Endpoint-specific query params (e.g. `{addresses}` for tokens). */
  params?: ParamMap;
  priority?: Priority;
}

export type DexScreenerParse = { ok: true; value: DexScreenerParams } | { ok: false };

function isDexEndpoint(v: unknown): v is DexEndpoint {
  return typeof v === 'string' && (ENDPOINTS as readonly string[]).includes(v);
}

function isScalarMap(v: unknown): v is ParamMap {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every(
    (x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean',
  );
}

/**
 * Validate the untrusted HTTP body into `DexScreenerParams` (trust boundary).
 * An unknown endpoint is a 400, never an upstream call.
 */
export function parseDexScreener(raw: unknown): DexScreenerParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (!isDexEndpoint(o.endpoint)) return { ok: false };
  if (o.priority !== undefined && o.priority !== 0 && o.priority !== 1 && o.priority !== 2) {
    return { ok: false };
  }
  if (o.params !== undefined && !isScalarMap(o.params)) return { ok: false };
  return { ok: true, value: { endpoint: o.endpoint, params: o.params, priority: o.priority } };
}

export interface DexScreenerDeps {
  fetchUpstream: UpstreamFetch;
  /** Limiter override (tests); defaults to the shared registry. */
  runLimiter?: LimiterRun;
}

/**
 * One DexScreener call: validate → CLASS-correct limiter → upstream → envelope.
 * `provider` is the class limiter key and `endpoint` (the endpoint name) reaches
 * the limiter as its `path`; the raw upstream body rides in the 200 envelope.
 */
export async function handleDexScreener(
  rawBody: unknown,
  caller: Caller,
  deps: DexScreenerDeps,
): Promise<DispatchResult> {
  const parsed = parseDexScreener(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const { endpoint, params, priority } = parsed.value;
  const req: GatewayRequest = {
    provider: LIMITER_BY_ENDPOINT[endpoint],
    endpoint,
    params,
    priority,
  };
  return proxyRequest(req, caller, {
    fetchUpstream: deps.fetchUpstream,
    runLimiter: deps.runLimiter,
  });
}

/** Build the upstream URL from the endpoint + its query params. */
export function dexScreenerUrl(endpoint: DexEndpoint, params: ParamMap = {}): string {
  switch (endpoint) {
    // Comma-separated addresses (≤30 per call), matching providers/dexscreener.ts.
    case 'tokens':
      return `${DEXSCREENER_BASE}/latest/dex/tokens/${String(params.addresses ?? '')}`;
    case 'pairs':
      return `${DEXSCREENER_BASE}/latest/dex/pairs/${String(params.chainId ?? '')}/${String(params.pairId ?? '')}`;
    case 'search':
      return `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(String(params.q ?? ''))}`;
    case 'profiles':
      return `${DEXSCREENER_BASE}/token-profiles/latest/v1`;
    case 'boosts':
      return `${DEXSCREENER_BASE}/token-boosts/latest/v1`;
  }
}

export interface DexScreenerUpstreamOpts {
  /** Transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The REAL upstream fetcher: builds the URL for the requested endpoint and
 * returns the raw upstream payload + headers. `proxyRequest` owns the
 * status/envelope decision. Keyless — DexScreener needs no credentials.
 */
export function dexScreenerUpstream(opts: DexScreenerUpstreamOpts = {}): UpstreamFetch {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (req) => {
    const endpoint = req.endpoint as DexEndpoint;
    const res = await doFetch(dexScreenerUrl(endpoint, req.params));
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
}
