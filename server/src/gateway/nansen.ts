// Nansen provider routes for the gateway (plan request-plane-gateway, todo 7).
//
// Nansen has TWO DISTINCT outbound seams and BOTH are proxied here:
//
//   (i)  the CREDIT API — `POST https://api.nansen.ai<path>` with the
//        gateway-held `apikey` header, governed by
//        `limiters.run('nansen-credit', {priority})`. Covers every
//        `NansenApiClient` method: `tokenFlows` (the LIVE chart path via
//        `poller.ts` `crawlBalanceSeries → seriesAtRung`), `tokenInformation`,
//        `dexTrades`, `currentBalance`.
//   (ii) the FREE browser door — `POST https://app.nansen.ai/api/questions/<slug>`
//        through the relocated DoorPool (`gateway/door.ts`), today injected as
//        `providers/nansen.ts` `PostJson` (`browserPostJson`). The DoorPool owns
//        its own per-path + per-door budgets; the never-wired `nansen-door`
//        limiter spec stays unwired so it cannot double-govern (plan D8).
//
// Both seams return the RAW upstream payload inside the todo-3 envelope
// `{status, body, headers}`; the gateway does NOT parse provider payloads.
// Retries live INSIDE the limiter (nansen-credit fibo retry) — nothing here
// retries.
//
// DOOR RAW-BODY NOTE: the DoorPool's in-page transport JSON-parses the response
// once (by contract), so the door route re-serializes that parsed value to the
// raw string the envelope carries. This is byte-round-trip serialization, NOT
// provider parsing — `parseEssentialData`/`parseGiniStats`/… stay in the provider.

import { config } from '../config.js';
import { browserPostJson } from './door.js';
import type { Priority } from '../ratelimit/types.js';
import {
  buildEnvelope,
  denial,
  proxyRequest,
  type DispatchResult,
  type GatewayRequest,
  type LimiterRun,
  type UpstreamFetch,
} from './contract.js';
import type { Caller } from './auth.js';

/** Upstream credit API base. Every credit `endpoint` resolves under this host. */
export const NANSEN_API_BASE = 'https://api.nansen.ai';

/** Limiter key for the credit seam (reaches `limiters.run` via `proxyRequest`). */
export const NANSEN_CREDIT_LIMITER = 'nansen-credit';

/** Full route paths (mounted under the `/v1` auth prefix in `app.ts`). */
export const NANSEN_CREDIT_PATH = '/v1/nansen/credit';
export const NANSEN_DOOR_PATH = '/v1/nansen/door';

/** Free browser-door host + path prefix. */
export const NANSEN_QUESTION_BASE = 'https://app.nansen.ai/api/questions/';

/**
 * The free-door app-question slugs the LIVE `NansenMarketProvider` calls
 * (`providers/nansen.ts:47-49`, called at `:589`/`:616`/`:620`). This is the
 * URL→`endpoint` mapping pinned by the plan so the adapter (todo 13) need not
 * guess; the DoorPool's path budget keys on the same last-segment slug.
 */
export const NANSEN_DOOR_ENDPOINTS = [
  'tgm-essential-data',
  'tgm-volume-details',
  'tgm-holders-gini-stats',
] as const;

export type NansenDoorEndpoint = (typeof NANSEN_DOOR_ENDPOINTS)[number];

/** endpoint → full app-question URL (single source of truth for the door seam). */
export const NANSEN_DOOR_URLS: Record<NansenDoorEndpoint, string> = {
  'tgm-essential-data': `${NANSEN_QUESTION_BASE}tgm-essential-data`,
  'tgm-volume-details': `${NANSEN_QUESTION_BASE}tgm-volume-details`,
  'tgm-holders-gini-stats': `${NANSEN_QUESTION_BASE}tgm-holders-gini-stats`,
};

const URL_TO_ENDPOINT: Record<string, NansenDoorEndpoint | undefined> = Object.fromEntries(
  NANSEN_DOOR_ENDPOINTS.map((endpoint): [string, NansenDoorEndpoint] => [
    NANSEN_DOOR_URLS[endpoint],
    endpoint,
  ]),
);

/** Map a provider free-door URL to its gateway `endpoint` (adapter helper, todo 13). */
export function doorEndpointFor(url: string): NansenDoorEndpoint | null {
  return URL_TO_ENDPOINT[url] ?? null;
}

// ---------------------------------------------------------------------------
// Credit seam (i)
// ---------------------------------------------------------------------------

/** Credit route body: the Nansen API path + its opaque upstream JSON body. */
export interface NansenCreditParams {
  /** Absolute Nansen API path, e.g. `/api/v1/tgm/flows`. */
  endpoint: string;
  /** RAW upstream JSON, byte-verbatim (forwarded by `proxyRequest`). */
  body: unknown;
  priority?: Priority;
}

export type NansenCreditParse = { ok: true; value: NansenCreditParams } | { ok: false };

/**
 * Resolve `endpoint` to a path on `api.nansen.ai`, or null for anything that
 * would escape that host. This is the trust boundary: `new URL` normalizes `..`
 * and rejects an authority-swapping path (`//evil`, `https://evil`), and the
 * `host` check pins the SSRF target. Only the normalized path + query is kept.
 */
function resolveCreditPath(endpoint: string): string | null {
  if (!endpoint.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(endpoint, NANSEN_API_BASE);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.host !== 'api.nansen.ai') return null;
  return `${url.pathname}${url.search}`;
}

/**
 * Validate the untrusted credit body into `NansenCreditParams`. A malformed or
 * off-host path is a 400, never an upstream call.
 */
export function parseNansenCredit(raw: unknown): NansenCreditParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (typeof o.endpoint !== 'string') return { ok: false };
  const endpoint = resolveCreditPath(o.endpoint);
  if (endpoint === null) return { ok: false };
  if (o.priority !== undefined && o.priority !== 0 && o.priority !== 1 && o.priority !== 2) {
    return { ok: false };
  }
  return { ok: true, value: { endpoint, body: o.body, priority: o.priority } };
}

export interface NansenCreditDeps {
  fetchUpstream: UpstreamFetch;
  /** Limiter override (tests); defaults to the shared registry. */
  runLimiter?: LimiterRun;
}

/**
 * One credit call: validate → `limiters.run('nansen-credit', {priority})` →
 * upstream → envelope. The raw body rides the 200 envelope; a non-2xx upstream
 * throws `UpstreamError` INSIDE the limiter so its fibo retry + 403/429 gate run
 * before the status is surfaced.
 */
export async function handleNansenCredit(
  rawBody: unknown,
  caller: Caller,
  deps: NansenCreditDeps,
): Promise<DispatchResult> {
  const parsed = parseNansenCredit(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const req: GatewayRequest = {
    provider: NANSEN_CREDIT_LIMITER,
    endpoint: parsed.value.endpoint,
    body: parsed.value.body,
    priority: parsed.value.priority,
  };
  return proxyRequest(req, caller, {
    fetchUpstream: deps.fetchUpstream,
    runLimiter: deps.runLimiter,
  });
}

export interface NansenCreditUpstreamOpts {
  /** Transport override (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** API key override (tests); defaults to the gateway's own env. */
  apiKey?: string;
}

/**
 * The REAL credit fetcher: POSTs to `https://api.nansen.ai<path>` with the
 * gateway-held `apikey` header and returns the raw upstream payload + headers.
 * `proxyRequest` owns the status/envelope/gate decision.
 */
export function nansenCreditUpstream(opts: NansenCreditUpstreamOpts = {}): UpstreamFetch {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? config.nansenApiKey;
  return async (req) => {
    const res = await doFetch(`${NANSEN_API_BASE}${req.endpoint}`, {
      method: 'POST',
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
}

// ---------------------------------------------------------------------------
// Free browser door seam (ii)
// ---------------------------------------------------------------------------

/** The DoorPool transport seam — the frozen `browserPostJson` signature. */
export type DoorPost = (url: string, body: unknown) => Promise<{ status: number; json: unknown | null }>;

export interface NansenDoorParams {
  endpoint: NansenDoorEndpoint;
  body: unknown;
}

export type NansenDoorParse = { ok: true; value: NansenDoorParams } | { ok: false };

function isDoorEndpoint(value: unknown): value is NansenDoorEndpoint {
  return typeof value === 'string' && (NANSEN_DOOR_ENDPOINTS as readonly string[]).includes(value);
}

/**
 * Validate the untrusted door body into `NansenDoorParams`. `endpoint` must be
 * one of the pinned app-question slugs, so an authenticated caller can never
 * aim the browser at an arbitrary URL.
 */
export function parseNansenDoor(raw: unknown): NansenDoorParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (!isDoorEndpoint(o.endpoint)) return { ok: false };
  return { ok: true, value: { endpoint: o.endpoint, body: o.body } };
}

export interface NansenDoorDeps {
  /** Door transport; defaults to the relocated DoorPool's `browserPostJson`. */
  postJson?: DoorPost;
}

/**
 * One free-door call: validate → DoorPool `postJson` → envelope. The DoorPool
 * owns routing/budgets/quarantine and never throws; its status rides the
 * envelope (HTTP 200 `{status, body, headers}`) so a 429/503 stays a distinct
 * upstream-ish status rather than being conflated with a gateway denial.
 */
export async function handleNansenDoor(
  rawBody: unknown,
  deps: NansenDoorDeps = {},
): Promise<DispatchResult> {
  const parsed = parseNansenDoor(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const postJson = deps.postJson ?? browserPostJson;
  const { status, json } = await postJson(NANSEN_DOOR_URLS[parsed.value.endpoint], parsed.value.body);
  if (status !== 200 || json === null || json === undefined) {
    return buildEnvelope(status, null, {});
  }
  return buildEnvelope(200, JSON.stringify(json), {});
}
