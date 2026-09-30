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
import { CHAIN_SLUGS, chainSlugs } from '../shared/chain-slugs.js';
import type { Chain } from '../shared/chain.js';
import { GMGN_TOKEN_INFO_URL, GMGN_TOKEN_INFO_WEIGHT } from '../providers/gmgn.js';
import type { Priority, RunOpts } from '../ratelimit/types.js';
import {
  denial,
  proxyRequest,
  type DispatchResult,
  type GatewayRequest,
  type LimiterRun,
  type UpstreamFetch,
} from './contract.js';
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
}

/**
 * One `gmgn/token-info` call: validate → weighted limiter → upstream → envelope.
 * The `weight` is what makes this route consume the weight bucket; a non-2xx
 * upstream throws `UpstreamError` inside the limiter so the gmgn gate arms (a
 * 403 closes it for the configured cooldown), then maps to the 200 envelope.
 */
export async function handleGmgnTokenInfo(
  rawBody: unknown,
  caller: Caller,
  deps: GmgnTokenInfoDeps,
): Promise<DispatchResult> {
  const parsed = parseGmgnTokenInfo(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const runOpts: RunOpts = { weight: GMGN_TOKEN_INFO_WEIGHT };
  return proxyRequest(toGatewayRequest(parsed.value), caller, {
    fetchUpstream: deps.fetchUpstream,
    runLimiter: deps.runLimiter,
    runOpts,
  });
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
