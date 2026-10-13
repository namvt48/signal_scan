// Selective TTL cache + single-flight for public market queries.
// Nansen CA queries share across callers; the initiator alone pays/preflights.
// Wallet/profile APIs remain uncached. GMGN single-flight is implemented separately.
// Keys preserve exact semantic ranges/labels, strip scheduling priority, and
// normalize only known CA fields for known EVM chains. Solana stays case-sensitive.
// Stored results are bounded in memory and require successful non-null JSON bodies.

import { EVM_ADDRESS } from '../shared/chain.js';
import { config } from '../config.js';
import { NANSEN_CREDIT_LIMITER, NANSEN_DOOR_PATH } from './nansen.js';
import { DEXSCREENER_LIMITER } from './dexscreener.js';
import type { Caller } from './auth.js';
import type { DispatchResult } from './contract.js';

const NANSEN_MARKET_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/tgm/token-information',
  '/api/v1/tgm/holders',
  '/api/v1/tgm/flows',
]);
const NANSEN_DOOR_ENDPOINTS: ReadonlySet<string> = new Set([
  'tgm-essential-data', 'tgm-volume-details', 'tgm-holders-gini-stats',
]);
const DEX_CACHEABLE_ENDPOINTS: ReadonlySet<string> = new Set(['tokens', 'pairs', 'search', 'profiles', 'boosts']);
const EVM_CHAINS = new Set(['ethereum', 'base', 'bsc', 'arbitrum', 'polygon', 'optimism', 'avalanche', 'linea', 'zksync']);
const TOKEN_FIELDS = new Set(['tokenAddress', 'token_address', 'contractAddress', 'contract_address', 'pairId']);

export type CacheTtlClass = 'nansen' | 'flows' | 'door' | 'dex';
export interface CachePolicy { credit: boolean; ttlClass: CacheTtlClass }

export function classifyRequest(provider: string, rawBody: unknown): CachePolicy | null {
  const endpoint = readEndpoint(rawBody);
  if (endpoint === null) return null;
  if (provider === NANSEN_CREDIT_LIMITER) {
    const path = endpointPath(endpoint);
    if (NANSEN_MARKET_PATHS.has(path)) {
      return { credit: true, ttlClass: path === '/api/v1/tgm/flows' ? 'flows' : 'nansen' };
    }
    return null;
  }
  if (provider === NANSEN_DOOR_PATH && NANSEN_DOOR_ENDPOINTS.has(endpoint)) {
    return { credit: false, ttlClass: 'door' };
  }
  if (provider === DEXSCREENER_LIMITER && DEX_CACHEABLE_ENDPOINTS.has(endpoint)) {
    return { credit: false, ttlClass: 'dex' };
  }
  return null;
}

export type Preflight = (provider: string, rawBody: unknown, caller: Caller) =>
  DispatchResult | undefined | Promise<DispatchResult | undefined>;

export interface GatewayCacheOptions {
  now?: () => number;
  ttlNansenMs?: number;
  ttlDexscreenerMs?: number;
  ttlFlowsMs?: number;
  ttlDoorMs?: number;
  maxEntries?: number;
  maxInflight?: number;
}

interface Entry { expiresAt: number; result: DispatchResult }
export interface CacheStats {
  hits: number; misses: number; joined: number; size: number; inflight: number;
}



/**
 * Bounded per-process TTL cache + single-flight. Cacheable requests are public CA
 * market data, so cache keys intentionally omit caller while retaining full body.
 */
export class GatewayCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<DispatchResult>>();
  private hits = 0;
  private misses = 0;
  private joined = 0;
  private readonly now: () => number;
  private readonly ttlNansenMs: number;
  private readonly ttlDexscreenerMs: number;
  private readonly ttlFlowsMs: number;
  private readonly ttlDoorMs: number;
  private readonly maxEntries: number;
  private readonly maxInflight: number;

  constructor(opts: GatewayCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlNansenMs = opts.ttlNansenMs ?? config.cacheTtlNansenMs;
    this.ttlDexscreenerMs = opts.ttlDexscreenerMs ?? config.cacheTtlDexscreenerMs;
    this.ttlFlowsMs = opts.ttlFlowsMs ?? 30_000;
    this.ttlDoorMs = opts.ttlDoorMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.maxInflight = opts.maxInflight ?? 256;
  }

  async dispatch(provider: string, rawBody: unknown, caller: Caller,
    run: () => Promise<DispatchResult>, preflight?: Preflight): Promise<DispatchResult> {
    const policy = classifyRequest(provider, rawBody);
    if (policy === null) return this.runUncached(provider, rawBody, caller, run, preflight);
    const key = cacheKey(provider, rawBody, false, caller);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > this.now()) {
        this.hits += 1;
        return cached.result;
      }
      this.entries.delete(key);
    }
    const joined = this.inflight.get(key);
    if (joined !== undefined) {
      this.joined += 1;
      return joined;
    }
    if (this.inflight.size >= this.maxInflight) {
      return { status: 503, payload: { error: 'cache_inflight_limit' } };
    }
    this.misses += 1;
    const ttlMs = policy.ttlClass === 'flows' ? this.ttlFlowsMs
      : policy.ttlClass === 'door' ? this.ttlDoorMs
        : policy.ttlClass === 'nansen' ? this.ttlNansenMs : this.ttlDexscreenerMs;
    const promise = this.runInitiator(key, ttlMs, provider, rawBody, caller, run, preflight);
    this.inflight.set(key, promise);
    try { return await promise; }
    finally { if (this.inflight.get(key) === promise) this.inflight.delete(key); }
  }

  size(): number { return this.entries.size; }
  inflightCount(): number { return this.inflight.size; }
  joinedCount(): number { return this.joined; }
  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, joined: this.joined,
      size: this.entries.size, inflight: this.inflight.size };
  }

  private async runUncached(provider: string, rawBody: unknown, caller: Caller,
    run: () => Promise<DispatchResult>, preflight?: Preflight): Promise<DispatchResult> {
    const denied = await preflight?.(provider, rawBody, caller);
    if (denied !== undefined) return denied;
    return run();
  }

  private async runInitiator(key: string, ttlMs: number, provider: string, rawBody: unknown,
    caller: Caller, run: () => Promise<DispatchResult>, preflight?: Preflight): Promise<DispatchResult> {
    const denied = await preflight?.(provider, rawBody, caller);
    if (denied !== undefined) return denied;
    const result = await run();
    if (isCacheable(result) && this.maxEntries > 0) {
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      this.entries.set(key, { expiresAt: this.now() + ttlMs, result });
    }
    return result;
  }
}


/** Semantic key; caller scope is intentionally omitted for public market data. */
export function cacheKey(provider: string, rawBody: unknown, _credit: boolean, _caller: Caller): string {
  return `${provider}|${stableStringify(stripPriority(rawBody))}`;
}

function isCacheable(result: DispatchResult): boolean {
  if (result.status !== 200 || !('status' in result.payload)) return false;
  const { status, body } = result.payload;
  if (status < 200 || status >= 300 || body === null) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    return record.error == null && !(typeof record.status === 'number' && record.status >= 400) &&
      !(typeof record.code === 'number' && record.code !== 0);
  } catch { return false; }
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

function normalizeAddressList(addresses: string): string {
  return addresses
    .split(',')
    .map((address) => (EVM_ADDRESS.test(address) ? address.toLowerCase() : address))
    .join(',');
}

function stripPriority(rawBody: unknown): unknown {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return rawBody;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawBody as Record<string, unknown>)) {
    if (k !== 'priority') out[k] = v;
  }
  return out;
}

function stableStringify(value: unknown, inheritedChain?: string): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, inheritedChain)).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const obj = value as Record<string, unknown>;
  const chain = typeof obj.chain === 'string'
    ? obj.chain.toLowerCase()
    : typeof obj.chainId === 'string'
      ? obj.chainId.toLowerCase()
      : inheritedChain;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const member = obj[key];
    if (member === undefined) continue;
    const normalized =
      key === 'addresses' && typeof member === 'string'
        ? normalizeAddressList(member)
        : TOKEN_FIELDS.has(key) &&
            typeof member === 'string' &&
            EVM_ADDRESS.test(member) &&
            chain !== undefined &&
            EVM_CHAINS.has(chain)
          ? member.toLowerCase()
          : member;
    parts.push(`${JSON.stringify(key)}:${stableStringify(normalized, chain)}`);
  }
  return `{${parts.join(',')}}`;
}
