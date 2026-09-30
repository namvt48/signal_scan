// Selective TTL cache + single-flight dedupe for the gateway
// (plan request-plane-gateway, todo 11; draft Decisions 3 + 7).
//
// WHAT IS CACHED (deterministic params only)
//   * Nansen credit `token-information` + `holders`.
//   * DexScreener tokens / pairs / search.
// EXCLUDED BY CONSTRUCTION:
//   * GMGN - it mints a fresh `client_id`/`timestamp` per call (`gateway/gmgn.ts`,
//     `providers/gmgn.ts:176-177`), so a replayed body would fail AUTH_INVALID;
//     its route never reaches this module.
//   * Nansen `flows` - its params carry a MOVING `{from,to}` window, so caching
//     or deduping it would be a false hit (one key serving a different series);
//     `classifyRequest` returns null for it, and the normalization below never
//     rounds the window to fake a collision.
//   * DexScreener profiles / boosts - live lists, outside the todo-11 scope.
//
// CREDIT ATTRIBUTION (draft Decision 7)
//   For a CREDIT-bearing Nansen endpoint the key INCLUDES THE CALLER, so caller
//   a's credit call can never be collapsed with - nor TTL-hit by - caller b's.
//   Cross-caller sharing exists ONLY for the non-credit DexScreener class. The
//   initiator runs the limiter once and pays its own real cost; every joiner
//   (same-caller credit single-flight OR cross-caller non-credit dedupe) pays
//   ZERO because it never reaches the limiter/budget path. A same-caller credit
//   single-flight therefore charges the caller exactly ONE for N concurrent
//   identical calls.
//
// REQUEST ORDER (pinned)
//   auth -> cache lookup -> budget pre-flight (todo 19; the `preflight` seam) ->
//   limiters.run(...) -> upstream. A cache OR single-flight hit SHORT-CIRCUITS
//   here, BEFORE the pre-flight, so a 0-credit hit is never budget-denied. The
//   `preflight` hook defaults to a no-op; when todo 19 lands it returns a
//   `denial(429,'budget_exceeded')` to deny and `undefined` to allow.
//
// NORMALIZATION (deterministic; documented so keys never collide by accident)
//   key = `${provider}|${stableStringify(bodyMinusPriority)}|${credit?caller:'*'}`
//   * Object keys are sorted LEXICOGRAPHICALLY at every depth, so the key is
//     independent of property order.
//   * Array order is PRESERVED (it is semantic - e.g. an address list).
//   * Scalars use JSON.stringify; `undefined` object members are dropped.
//   * `priority` is EXCLUDED - it changes scheduling, never the upstream body.
//   * NO rounding / trimming / case-folding: a moving `{from,to}` window stays
//     distinct, so a time window can never be rounded into a fake hit.
//
// NO external store: a per-process `Map` (draft Decision 3 - Redis would force a
// distributed rewrite). Read-only; nothing is persisted, a restart starts cold.
// Only 2xx upstream results are stored: a non-2xx throws `UpstreamError` inside
// the limiter and maps to a non-2xx envelope, which `isCacheable` rejects.

import { config } from '../config.js';
import { NANSEN_CREDIT_LIMITER } from './nansen.js';
import { DEXSCREENER_LIMITER } from './dexscreener.js';
import type { Caller } from './auth.js';
import type { DispatchResult } from './contract.js';

/** Nansen credit path for token-information (`providers/nansen.ts:52`). */
const NANSEN_TOKEN_INFORMATION_PATH = '/api/v1/tgm/token-information';
/** Nansen credit path for holders (cost 5; 150 with `premium_labels`). */
const NANSEN_HOLDERS_PATH = '/api/v1/tgm/holders';
/** DexScreener endpoint names with DETERMINISTIC params (`gateway/dexscreener.ts`). */
const DEX_CACHEABLE_ENDPOINTS: ReadonlySet<string> = new Set(['tokens', 'pairs', 'search']);

/** TTL class -> the matching config knob (env-tunable, todo 6). */
export type CacheTtlClass = 'nansen' | 'dex';

export interface CachePolicy {
  /** Credit-bearing -> the caller is part of the key; a joiner pays 0. */
  credit: boolean;
  ttlClass: CacheTtlClass;
}

/**
 * Classify a gateway request as cacheable (with its credit/ttl class), or null
 * when it MUST NOT be cached/deduped. `provider` is the route class the HTTP
 * layer passes; the discriminating `endpoint` rides the request body (the
 * `endpoint` field of the todo-3 contract request).
 */
export function classifyRequest(provider: string, rawBody: unknown): CachePolicy | null {
  const endpoint = readEndpoint(rawBody);
  if (endpoint === null) return null;
  if (provider === NANSEN_CREDIT_LIMITER) {
    const path = endpointPath(endpoint);
    if (path === NANSEN_TOKEN_INFORMATION_PATH || path === NANSEN_HOLDERS_PATH) {
      return { credit: true, ttlClass: 'nansen' };
    }
    return null; // flows (moving window) + the dead profiler endpoints.
  }
  if (provider === DEXSCREENER_LIMITER) {
    if (DEX_CACHEABLE_ENDPOINTS.has(endpoint)) return { credit: false, ttlClass: 'dex' };
    return null; // profiles / boosts.
  }
  return null; // gmgn / the generic proxy: never cached.
}

/**
 * Budget pre-flight seam (todo 19). Called AFTER the cache lookup and BEFORE the
 * limiter. Return a denial (e.g. `denial(429,'budget_exceeded')`) to
 * short-circuit, or `undefined` to allow. Defaults to a no-op.
 */
export type Preflight = (
  provider: string,
  rawBody: unknown,
  caller: Caller,
) => DispatchResult | undefined | Promise<DispatchResult | undefined>;

export interface GatewayCacheOptions {
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number;
  /** Nansen TTL override; defaults to `config.cacheTtlNansenMs`. */
  ttlNansenMs?: number;
  /** DexScreener TTL override; defaults to `config.cacheTtlDexscreenerMs`. */
  ttlDexscreenerMs?: number;
}

interface Entry {
  expiresAt: number;
  result: DispatchResult;
}

/**
 * In-memory TTL cache + single-flight for deterministic-param endpoints. One
 * instance per gateway app; read-only with respect to everything downstream.
 */
export class GatewayCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<DispatchResult>>();
  private joined = 0;
  private readonly now: () => number;
  private readonly ttlNansenMs: number;
  private readonly ttlDexscreenerMs: number;

  constructor(opts: GatewayCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlNansenMs = opts.ttlNansenMs ?? config.cacheTtlNansenMs;
    this.ttlDexscreenerMs = opts.ttlDexscreenerMs ?? config.cacheTtlDexscreenerMs;
  }

  /**
   * Run one request through the pinned order. `run` is the limiter+upstream call
   * (built by the HTTP layer); it is invoked for the initiator only, so a hit or
   * a joiner performs no limiter call and no budget pre-flight.
   */
  async dispatch(
    provider: string,
    rawBody: unknown,
    caller: Caller,
    run: () => Promise<DispatchResult>,
    preflight?: Preflight,
  ): Promise<DispatchResult> {
    const policy = classifyRequest(provider, rawBody);
    if (policy === null) return this.runUncached(provider, rawBody, caller, run, preflight);

    const key = cacheKey(provider, rawBody, policy.credit, caller);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > this.now()) return cached.result; // HIT: before pre-flight
      this.entries.delete(key); // stale
    }
    const joined = this.inflight.get(key);
    if (joined !== undefined) {
      this.joined += 1;
      return joined; // joiner: zero cost, no pre-flight
    }

    const ttlMs = policy.ttlClass === 'nansen' ? this.ttlNansenMs : this.ttlDexscreenerMs;
    const promise = this.runInitiator(key, ttlMs, provider, rawBody, caller, run, preflight);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  /** Live cached-entry count (observability / tests). */
  size(): number {
    return this.entries.size;
  }

  /** In-flight single-flight count (observability / tests). */
  inflightCount(): number {
    return this.inflight.size;
  }

  /** Total requests that joined an in-flight call (observability / tests). */
  joinedCount(): number {
    return this.joined;
  }

  private async runUncached(
    provider: string,
    rawBody: unknown,
    caller: Caller,
    run: () => Promise<DispatchResult>,
    preflight?: Preflight,
  ): Promise<DispatchResult> {
    const denied = await preflight?.(provider, rawBody, caller);
    if (denied !== undefined) return denied;
    return run();
  }

  private async runInitiator(
    key: string,
    ttlMs: number,
    provider: string,
    rawBody: unknown,
    caller: Caller,
    run: () => Promise<DispatchResult>,
    preflight?: Preflight,
  ): Promise<DispatchResult> {
    const denied = await preflight?.(provider, rawBody, caller);
    if (denied !== undefined) return denied;
    const result = await run();
    if (isCacheable(result)) this.entries.set(key, { expiresAt: this.now() + ttlMs, result });
    return result;
  }
}

/** Build the deterministic cache key (see the NORMALIZATION note above). */
export function cacheKey(
  provider: string,
  rawBody: unknown,
  credit: boolean,
  caller: Caller,
): string {
  const scope = credit ? caller : '*';
  return `${provider}|${stableStringify(stripPriority(rawBody))}|${scope}`;
}

/** Only a 2xx upstream envelope is cacheable; a denial or non-2xx is not. */
function isCacheable(result: DispatchResult): boolean {
  if (result.status !== 200) return false;
  const payload = result.payload;
  if (!('status' in payload)) return false;
  return payload.status >= 200 && payload.status < 300;
}

function readEndpoint(rawBody: unknown): string | null {
  if (typeof rawBody !== 'object' || rawBody === null) return null;
  const value = (rawBody as Record<string, unknown>).endpoint;
  return typeof value === 'string' ? value : null;
}

function endpointPath(endpoint: string): string {
  const q = endpoint.indexOf('?');
  return q === -1 ? endpoint : endpoint.slice(0, q);
}

/** Drop the scheduling-only `priority` member so it cannot split the key. */
function stripPriority(rawBody: unknown): unknown {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return rawBody;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
    if (k !== 'priority') out[k] = v;
  }
  return out;
}

/** Stable JSON: object keys sorted at every depth; array order preserved. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v: unknown) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const member = obj[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(member)}`);
  }
  return `{${parts.join(',')}}`;
}
