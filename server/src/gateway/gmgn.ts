// GMGN token/info provider route for the gateway (plan request-plane-gateway,
// todo 8). The gateway is the SINGLE WRITER for GMGN, so it owns the upstream
// URL, the `X-APIKEY` header, and a fresh `client_id` + `timestamp` for each
// actual outbound request (`providers/gmgn.ts:17-19`).
//
// Concurrent identical public token reads may single-flight: only the initiator
// contacts GMGN and creates credentials; joiners share its response. The
// credentials are outbound query parameters, not part of the response. We do
// NOT retain a completed result, so the next request always gets fresh data and
// a fresh `client_id` + `timestamp`.
//
// Every actual call acquires the selected account's weighted limiter INSIDE the
// shared `gmgn-egress` limiter. Per-key quotas remain independent, while the
// shared one-request/second bucket and ban gate protect the common IP.
//
// 429 arms both gates until the upstream reset (or the bounded fallback); 403
// uses the configured cooldown on the key and shared egress gates. Reset and
// Retry-After headers are normalized before they reach the gate.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { canonicalCa } from '../shared/chain.js';
import { CHAIN_SLUGS, chainSlugs } from '../shared/chain-slugs.js';
import type { Chain } from '../shared/chain.js';
import { GMGN_TOKEN_INFO_URL, GMGN_TOKEN_INFO_WEIGHT } from '../providers/gmgn.js';
import type { Priority, RunOpts } from '../ratelimit/types.js';
import { limiters } from '../ratelimit/index.js';
import { gmgnLimiterKey } from '../ratelimit/spec.js';
import {
  denial,
  proxyRequest,
  GATED_HEADER,
  type DispatchResult,
  type GatewayRequest,
  type LimiterRun,
  type UpstreamFetch,
} from './contract.js';
import { GmgnKeyPool, type GmgnKey, type GmgnKeyPick } from './gmgn-keys.js';
import type { Caller } from './auth.js';
/** Re-exported so callers/tests read the weight from the ONE source of truth. */
export { GMGN_TOKEN_INFO_WEIGHT };

/** Full route path (mounted under the `/v1` auth prefix in `app.ts`). */
export const GMGN_TOKEN_INFO_PATH = '/v1/gmgn/token-info';

/** Limiter `path` (todo 3 contract) — the upstream endpoint this route proxies. */
export const GMGN_TOKEN_INFO_ENDPOINT = '/v1/token/info';

/** The route's request body: which token, on which chain, at which urgency. */
export interface GmgnTokenInfoParams {
  ca: string;
  chain: Chain;
  priority?: Priority;
}

export type GmgnTokenInfoParse = { ok: true; value: GmgnTokenInfoParams } | { ok: false };
/** GMGN wallet activity is a history query, charged at weight 3. */
export const GMGN_WALLET_ACTIVITY_PATH = '/v1/gmgn/wallet-activity';
export const GMGN_WALLET_ACTIVITY_URL = 'https://openapi.gmgn.ai/v1/user/wallet_activity';
export const GMGN_WALLET_ACTIVITY_ENDPOINT = '/v1/user/wallet_activity';
export const GMGN_WALLET_ACTIVITY_WEIGHT = 3;

export interface GmgnWalletActivityParams {
  wallet: string;
  chain: Chain;
  limit: number;
  cursor?: string;
  priority?: Priority;
}

export type GmgnWalletActivityParse =
  | { ok: true; value: GmgnWalletActivityParams }
  | { ok: false };

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const EVM_CHAINS: Partial<Record<Chain, true>> = { base: true, bsc: true, eth: true, robinhood: true };
const MAX_CURSOR_LENGTH = 2048;

export function parseGmgnWalletActivity(raw: unknown): GmgnWalletActivityParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (typeof o.wallet !== 'string' || !EVM_ADDRESS.test(o.wallet)) return { ok: false };
  if (!isChain(o.chain) || EVM_CHAINS[o.chain] !== true) return { ok: false };
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || (o.limit as number) < 1 || (o.limit as number) > 100)) return { ok: false };
  if (o.cursor !== undefined && (typeof o.cursor !== 'string' || o.cursor.length > MAX_CURSOR_LENGTH)) return { ok: false };
  if (o.priority !== undefined && o.priority !== 0 && o.priority !== 1 && o.priority !== 2) return { ok: false };
  return {
    ok: true,
    value: {
      wallet: o.wallet,
      chain: o.chain,
      limit: (o.limit as number | undefined) ?? 20,
      ...(o.cursor !== undefined ? { cursor: o.cursor as string } : {}),
      ...(o.priority !== undefined ? { priority: o.priority as Priority } : {}),
    },
  };
}

function toWalletActivityRequest(p: GmgnWalletActivityParams): GatewayRequest {
  return {
    provider: 'gmgn',
    endpoint: GMGN_WALLET_ACTIVITY_ENDPOINT,
    params: {
      chain: chainSlugs(p.chain).gmgn,
      wallet_address: p.wallet,
      limit: p.limit,
      ...(p.cursor !== undefined ? { cursor: p.cursor } : {}),
    },
    priority: p.priority,
  };
}

export async function handleGmgnWalletActivity(
  rawBody: unknown,
  caller: Caller,
  deps: GmgnTokenInfoDeps,
): Promise<DispatchResult> {
  const parsed = parseGmgnWalletActivity(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const runOpts: RunOpts = { weight: GMGN_WALLET_ACTIVITY_WEIGHT, priority: parsed.value.priority };
  const req = toWalletActivityRequest(parsed.value);
  const pick = deps.pool?.pick();
  if (deps.pool && !pick) return denial(503, 'gated', { [GATED_HEADER]: new Date(deps.pool.nextAvailableAt()).toISOString() });
  if (pick) req.provider = pick.limiterKey;
  const runKeyLimiter: LimiterRun = deps.runLimiter ?? ((api, opts, job) => limiters.run(api, opts, job));
  const runEgressLimiter: LimiterRun = deps.runEgressLimiter ??
    ((api, opts, job) => limiters.run(api, opts, job));
  const runLimiter: LimiterRun = (api, opts, job) =>
    runKeyLimiter(api, opts, () => runEgressLimiter('gmgn-egress', opts, job));
  const fetchUpstream = pick ? trackPoolUpstream(deps.pool!, pick) : deps.fetchUpstream;
  return proxyRequest(req, caller, { fetchUpstream, runLimiter, runOpts });
}


function isChain(value: unknown): value is Chain {
  return typeof value === 'string' && value in CHAIN_SLUGS;
}

/**
 * Validate the untrusted HTTP body into `GmgnTokenInfoParams` (trust boundary).
 * `chain` must be a known chain so the upstream slug lookup can never throw a
 * 500; a bad body is a 400, never an upstream call.
 */
export function parseGmgnTokenInfo(raw: unknown): GmgnTokenInfoParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (typeof o.ca !== 'string' || o.ca === '') return { ok: false };
  if (!isChain(o.chain)) return { ok: false };
  if (o.priority !== undefined && o.priority !== 0 && o.priority !== 1 && o.priority !== 2) {
    return { ok: false };
  }
  return { ok: true, value: { ca: o.ca, chain: o.chain, priority: o.priority } };
}

export interface GmgnSingleFlightSnapshot {
  joined: number;
  inflight: number;
}

/**
 * Share only currently-running public token-info calls. A settled result is
 * never cached; the next request creates new upstream credentials and fetches
 * fresh data. Priority and caller are omitted from the key because they do not
 * alter the public token payload.
 */
export class GmgnTokenInfoSingleFlight {
  private readonly inflight = new Map<string, Promise<DispatchResult>>();
  private joined = 0;

  async run(
    rawBody: unknown,
    operation: () => Promise<DispatchResult>,
  ): Promise<DispatchResult> {
    const parsed = parseGmgnTokenInfo(rawBody);
    if (!parsed.ok) return operation();

    const key = JSON.stringify([
      parsed.value.chain,
      canonicalCa(parsed.value.ca, parsed.value.chain),
    ]);
    const active = this.inflight.get(key);
    if (active !== undefined) {
      this.joined += 1;
      return active;
    }

    const request = Promise.resolve().then(operation);
    this.inflight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.inflight.get(key) === request) this.inflight.delete(key);
    }
  }

  snapshot(): GmgnSingleFlightSnapshot {
    return { joined: this.joined, inflight: this.inflight.size };
  }
}

/** Build the contract request: `params` are the upstream QUERY params (chain
 *  already mapped to its gmgn slug); the fetcher adds timestamp + client_id. */
function toGatewayRequest(p: GmgnTokenInfoParams): GatewayRequest {
  return {
    provider: 'gmgn',
    endpoint: GMGN_TOKEN_INFO_ENDPOINT,
    params: { chain: chainSlugs(p.chain).gmgn, address: p.ca },
    priority: p.priority,
  };
}

export interface GmgnTokenInfoDeps {
  fetchUpstream: UpstreamFetch;
  /** Per-key limiter override (tests); defaults to the shared registry. */
  runLimiter?: LimiterRun;
  /** Aggregate egress limiter override (tests); defaults to the shared registry. */
  runEgressLimiter?: LimiterRun;
  /** Multi-key pool; absent = single-key legacy path (tests / single-key deploy). */
  pool?: GmgnKeyPool;
}

/**
 * One call: validate → key pick → per-account quota → shared egress for each
 * outbound attempt → upstream → envelope. The selected key keeps its own
 * weighted quota and gate; aggregate traffic and ban state are shared. When
 * every key is gated/down, return 503 gated with the EARLIEST availability.
 */
export async function handleGmgnTokenInfo(
  rawBody: unknown,
  caller: Caller,
  deps: GmgnTokenInfoDeps,
): Promise<DispatchResult> {
  const parsed = parseGmgnTokenInfo(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const runOpts: RunOpts = { weight: GMGN_TOKEN_INFO_WEIGHT };
  const req = toGatewayRequest(parsed.value);
  const pick = deps.pool?.pick();
  if (deps.pool && !pick) {
    const until = new Date(deps.pool.nextAvailableAt()).toISOString();
    return denial(503, 'gated', { [GATED_HEADER]: until });
  }
  if (pick) req.provider = pick.limiterKey;
  const runKeyLimiter: LimiterRun =
    deps.runLimiter ?? ((api, opts, job) => limiters.run(api, opts, job));
  const runEgressLimiter: LimiterRun =
    deps.runEgressLimiter ?? ((api, opts, job) => limiters.run(api, opts, job));
  const runLimiter: LimiterRun = (api, opts, job) =>
    runKeyLimiter(api, opts, () => runEgressLimiter('gmgn-egress', opts, job));
  const fetchUpstream = pick === undefined || pick === null
    ? deps.fetchUpstream
    : deps.pool === undefined ? pick.upstream : trackPoolUpstream(deps.pool, pick);
  return proxyRequest(req, caller, {
    fetchUpstream,
    runLimiter,
    runOpts,
  });
}

function trackPoolUpstream(pool: GmgnKeyPool, pick: GmgnKeyPick): UpstreamFetch {
  return async (request, caller) => {
    pool.recordAttempt(pick.index);
    try {
      const response = await pick.upstream(request, caller);
      pool.record(pick.index, response.status);
      return response;
    } catch (error) {
      pool.recordFailure(pick.index);
      throw error;
    }
  };
}

export interface GmgnUpstreamOpts {
  /** Transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** API key override (tests); defaults to the gateway's own env. */
  apiKey?: string;
}
/** Reduce untrusted upstream errors to a safe category; never log the raw body. */
export function gmgnErrorHint(body: string): string {
  let message = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      message = [value.error, value.message, value.code]
        .filter((field): field is string => typeof field === 'string')
        .join(' ')
        .toLowerCase();
    }
  } catch {
    return 'unclassified';
  }
  if (/api.?key|credential|unauthoriz|auth/.test(message)) return 'auth_rejected';
  if (/timestamp|client.?id|signature/.test(message)) return 'request_auth_rejected';
  if (/chain/.test(message)) return 'chain_rejected';
  if (/wallet|address/.test(message)) {
    if (/missing|required|empty/.test(message)) return 'wallet_missing';
    if (/not found|unknown|does not exist/.test(message)) return 'wallet_unknown';
    if (/invalid|format|checksum/.test(message)) return 'wallet_invalid';
    if (/unsupported|not supported/.test(message)) return 'wallet_unsupported';
    return 'wallet_rejected';
  }
  if (/limit|cursor|type|parameter|query/.test(message)) return 'request_parameter_rejected';
  if (/plan|upgrade|weight/.test(message)) return 'plan_restricted';
  return 'unclassified';
}


/**
 * The REAL upstream fetcher: builds the GET URL with a FRESH `client_id` +
 * `timestamp` on every call and sends the gateway-held `X-APIKEY`. Returns the
 * raw upstream payload + headers; `proxyRequest` owns the status/envelope/gate
 * decision (non-2xx bodies are never forwarded).
 */
export function gmgnTokenInfoUpstream(opts: GmgnUpstreamOpts = {}): UpstreamFetch {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? config.gmgnApiKey;
  return async (req) => {
    const url = req.endpoint === GMGN_TOKEN_INFO_ENDPOINT ? GMGN_TOKEN_INFO_URL
      : req.endpoint === GMGN_WALLET_ACTIVITY_ENDPOINT ? GMGN_WALLET_ACTIVITY_URL
      : undefined;
    if (url === undefined) throw new Error('unsupported GMGN endpoint');
    const qs = new URLSearchParams({
      chain: String(req.params?.chain ?? ''),
      ...(req.endpoint === GMGN_TOKEN_INFO_ENDPOINT
        ? { address: String(req.params?.address ?? '') }
        : {
          wallet_address: String(req.params?.wallet_address ?? ''),
          limit: String(req.params?.limit ?? 20),
          ...(req.params?.cursor !== undefined ? { cursor: String(req.params.cursor) } : {}),
        }),
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: randomUUID(),
    });
    const res = await doFetch(`${url}?${qs.toString()}`, {
      headers: { 'X-APIKEY': apiKey },
    });
    const body = await res.text();
    if (req.endpoint === GMGN_WALLET_ACTIVITY_ENDPOINT && res.status === 400) {
      const reason = gmgnErrorHint(body);
      log.warn(`GMGN wallet activity upstream rejected: ${reason}`, { status: res.status });
    }
    return { status: res.status, body, headers: res.headers };
  };
}

/** Build the key pool from config: one key per account, each with its own limiter key
 *  (spec key 0 = `gmgn`, i>0 = `gmgn:1`..`gmgn:N-1`) and its own upstream fetcher. */
export function createGmgnKeyPool(): GmgnKeyPool {
  const keys: GmgnKey[] = config.gmgnApiKeys.map((apiKey, i) => ({
    apiKey,
    limiterKey: gmgnLimiterKey(i),
    weight: config.gmgnPlanWeights[i] ?? config.gmgnPlanWeight,
  }));
  return new GmgnKeyPool({
    keys,
    fetcherFor: (apiKey) => gmgnTokenInfoUpstream({ apiKey }),
    gateUntilOf: (limiterKey) => limiters.snapshot()[limiterKey]?.gateUntil ?? 0,
    log: (line) => log.info(line),
  });
}

