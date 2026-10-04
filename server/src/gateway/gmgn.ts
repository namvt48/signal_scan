// GMGN token/info provider route for the gateway (plan request-plane-gateway,
// todo 8). The gateway is the SINGLE WRITER for GMGN, so it owns the upstream
// URL, the `X-APIKEY` header, and the MANDATORY fresh `client_id` + `timestamp`
// per call (`providers/gmgn.ts:14-17,176-177`: GMGN rejects a replay within 7s).
//
// TWO CONSEQUENCES, both load-bearing:
//   1. This route is EXCLUDED from the selective TTL cache AND single-flight
//      (todo 11). A cached/deduped response cannot carry a fresh client_id, so
//      caching it would replay the id and get 401 AUTH_INVALID. todo 11 must not
//      route `gmgn/token-info` through its cache/dedupe.
//   2. It passes the per-request endpoint WEIGHT (`GMGN_TOKEN_INFO_WEIGHT`) into
//      `limiters.run('gmgn', {weight, priority})`; GMGN meters by weight, not by
//      request (`providers/gmgn.ts:19-24`).
//
// 403 / GATE ASSUMPTION (plan todo 8, pinned): the shared `Gate` matches on
// NUMERIC STATUS ONLY (`ratelimit/gate.ts:21-31`, `ratelimit/types.ts:12-16`) and
// `Limiter.handleError` calls `gate.note(e.status, e.header, now)` WITHOUT the
// error body (`ratelimit/limiter.ts:182-184`), so "403-with-AUTH_IP_BLOCKED"
// cannot be targeted specifically. We therefore gate EVERY gmgn 403 on a fixed
// cooldown (`ratelimit/spec.ts` gmgn `statusesWithCooldown`), on the documented
// assumption that GMGN answers 403 ONLY for the egress-IP allowlist
// (`AUTH_IP_BLOCKED`), so a blocked egress backs off instead of hot-looping. The
// shared `Gate`/`HttpError` surface is deliberately NOT touched.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
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
import { GmgnKeyPool, type GmgnKey } from './gmgn-keys.js';
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
  /** Limiter override (tests); defaults to the shared registry. */
  runLimiter?: LimiterRun;
  /** Multi-key pool; absent = single-key legacy path (tests / single-key deploy). */
  pool?: GmgnKeyPool;
}

/**
 * One `gmgn/token-info` call: validate → key pick → weighted limiter → upstream →
 * envelope. With a POOL, the picked key's own limiter key is used as the request
 * `provider`, so its weight bucket and 429/403 gate are the only ones touched; when
 * every key is gated/down the call short-circuits to the 503 gated denial carrying the
 * EARLIEST availability. Without a pool it is the original single-key path.
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
  const result = await proxyRequest(req, caller, {
    fetchUpstream: pick?.upstream ?? deps.fetchUpstream,
    runLimiter: deps.runLimiter,
    runOpts,
  });
  if (pick) deps.pool?.record(pick.index, envelopeStatus(result));
  return result;
}

/** The upstream status a dispatch result carries: the envelope's `status` on a 200,
 *  else the denial status itself (e.g. 503 gated). */
function envelopeStatus(result: DispatchResult): number {
  const payload = result.payload as { status?: number };
  return result.status === 200 && typeof payload.status === 'number' ? payload.status : result.status;
}

export interface GmgnUpstreamOpts {
  /** Transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** API key override (tests); defaults to the gateway's own env. */
  apiKey?: string;
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
    const qs = new URLSearchParams({
      chain: String(req.params?.chain ?? ''),
      address: String(req.params?.address ?? ''),
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: randomUUID(),
    });
    const res = await doFetch(`${GMGN_TOKEN_INFO_URL}?${qs.toString()}`, {
      headers: { 'X-APIKEY': apiKey },
    });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
}

/** Build the key pool from config: one key per account, each with its own limiter key
 *  (spec key 0 = `gmgn`, i>0 = `gmgn:i`) and its own upstream fetcher. */
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
