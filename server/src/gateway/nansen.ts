// Nansen provider routes for the gateway (plan request-plane-gateway, todo 7).
//
// Nansen has two outbound seams:
//
//   (i)  CREDIT API — `POST https://api.nansen.ai<path>` with the gateway-held
//        `apikey`, governed by `limiters.run('nansen-credit', {priority})`.
//        This covers `NansenApiClient` methods such as token flows,
//        token information, dex trades and current balance.
//   (ii) FREE browser questions — `POST https://app.nansen.ai/api/questions/<slug>`.
//        Essential/volume questions use the general DoorPool; Gini, which
//        supplies Fresh Wallet data, uses its own direct Browserless pool.
//        Each pool owns its budgets, quarantine and bounded admission queue.
//        `nansen-door` stays unwired so there is no second quota (plan D8).
//
// Both seams return raw upstream payloads in the `{status, body, headers}`
// envelope; the gateway does not parse provider payloads. Credit retries live
// inside the limiter; browser-door retries live inside their DoorPool.
//
// DOOR RAW-BODY NOTE: in-page transport JSON-parses once, so the door route
// re-serializes the parsed value for the envelope. Provider parsing
// (`parseEssentialData`, `parseGiniStats`, etc.) stays in the provider.

import { config } from '../config.js';
import type { Classification } from './door.js';
import { browserPostJson, freshWalletBrowserPostJson, type DoorRequestOptions } from './door.js';
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

/** DoorPool transport with authenticated caller and scheduling metadata. */
export type DoorPost = (
  url: string,
  body: unknown,
  options?: DoorRequestOptions,
) => Promise<{ status: number; json: unknown | null; classification?: Classification | 'unavailable' }>;

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
  /** Default transport override; production selects the pool by endpoint. */
  postJson?: DoorPost;
  /** Optional override for the dedicated Fresh Wallet pool in tests/consumers. */
  freshWalletPostJson?: DoorPost;
  /** Authenticated request owner; used for shared-quota fairness. */
  caller?: Caller;
}

/**
 * One free-door call: validate → path-specific DoorPool `postJson` → envelope.
 * Each pool owns routing/budgets/quarantine and never throws; its status rides
 * the envelope (HTTP 200 `{status, body, headers}`) so a 429/503 stays distinct
 * from a gateway denial.
 */
export async function handleNansenDoor(
  rawBody: unknown,
  deps: NansenDoorDeps = {},
): Promise<DispatchResult> {
  const parsed = parseNansenDoor(rawBody);
  if (!parsed.ok) return denial(400, 'bad_request');
  const priority: Priority =
    parsed.value.endpoint === 'tgm-essential-data' ? 0
      : parsed.value.endpoint === 'tgm-volume-details' ? 2
        : 1;
  const postJson = parsed.value.endpoint === 'tgm-holders-gini-stats'
    ? deps.freshWalletPostJson ?? deps.postJson ?? freshWalletBrowserPostJson
    : deps.postJson ?? browserPostJson;
  const { status, json, classification } = await postJson(
    NANSEN_DOOR_URLS[parsed.value.endpoint],
    parsed.value.body,
    { caller: deps.caller ?? 'internal', priority },
  );
  const doorClass = classification ?? (status === 200 ? 'ok' : status === 403 ? 'real403' : status === 429 ? 'throttle' : status >= 500 ? '5xx' : 'transport');
  const headers = { 'x-nansen-door-classification': doorClass };
  if (status !== 200 || json === null || json === undefined) {
    return buildEnvelope(status, null, headers);
  }
  return buildEnvelope(200, JSON.stringify(json), headers);
}
