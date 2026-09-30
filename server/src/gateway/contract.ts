// Raw-payload proxy contract for the gateway (plan request-plane-gateway, todo 3).
//
// This is the SINGLE request/response shape every provider route (todos 7/8/9)
// speaks. The gateway does NOT understand provider payloads: it forwards the
// upstream bytes and the upstream status unchanged. Parsing stays in the
// callers (instances a/b, host watchers), per the plan's "raw pass-through".
//
// REQUEST: `{provider, endpoint, params, body, priority}`.
//   - `body` is the RAW upstream JSON for POST upstreams (browser-door
//     `app-questions`, `token-information`, and the `tgm-flows` pagination
//     `{page:1, per_page:1000}`). It is forwarded byte-verbatim - never
//     renamed/transformed - so `tgm-flows` seams keep working. It is ABSENT for
//     GET-only upstreams.
//   - `params` is URL/query only.
//   - The CALLER is derived from the bearer token (`auth.ts`), NEVER from the
//     body: a request cannot impersonate another caller.
//
// RESPONSE (wire shape, pinned):
//   - Every request that REACHES an upstream gets **HTTP 200** whose JSON body is
//     the envelope `{status, body, headers}`:
//       * `status` = the UPSTREAM status (an upstream 429/403 rides INSIDE the
//         200 as `status:429/403`, with `body:null`).
//       * `body`   = the byte-identical raw upstream payload (2xx only).
//       * `headers`= the four-entry allowlist below.
//   - The ONLY non-200 replies are GATEWAY-GENERATED denials carrying
//     `{error:...}`: 401 (missing/bad token), 400 (malformed request),
//     429 (`{error:"budget_exceeded"}`, todo 19), and 503 (`{error:"gated"}` +
//     `x-gateway-gated-until`) mapped from the limiter's pre-existing
//     gate-already-blocked rejection (`ratelimit/limiter.ts:58-59`).
//   - The adapter (todo 13) MUST branch on this: `HTTP 200 + status:429` = the
//     UPSTREAM throttled (parse from `envelope.status`); `HTTP 429 + {error}` =
//     the GATEWAY budget denial (surfaces, never retries). Never conflate them.
//
// NON-2xx ERROR BODIES ARE NOT FORWARDED. A non-2xx that must arm a limiter gate
// (429/403) throws `HttpError(status, header, message)` - which by construction
// carries NO body (`ratelimit/types.ts:62-70`) - so the envelope's `body` is
// `null` for those arms and the arm header rides in `headers`. This matches the
// pre-gateway provider behavior (`nansen.ts:360-370`, `gmgn.ts:184-187`), and it
// also lets the limiter retry 429/5xx and gate 429/403.
//
// HEADERS: fixed allowlist of exactly four -
//   content-type, retry-after, x-ratelimit-reset, x-nansen-credits-cost.
// `x-nansen-credits-cost` is INCLUDED deliberately so credit accounting (todo 19)
// can use the REAL per-call cost (falling back to the cost table when absent).
// `x-nansen-credits-remaining` (read at `nansen.ts:380`) is deliberately NOT
// forwarded: nothing downstream needs it, and fewer forwarded fields is less
// leakage. Any header outside the allowlist is dropped.

import { HttpError, type Priority, type RunOpts } from '../ratelimit/types.js';
import { limiters } from '../ratelimit/index.js';

/** The credit-attributable callers (single source of truth: `auth.ts`). */
export type { Caller } from './auth.js';

/** Fixed response header allowlist - exactly these four, nothing else. */
export const HEADER_ALLOWLIST = [
  'content-type',
  'retry-after',
  'x-ratelimit-reset',
  'x-nansen-credits-cost',
] as const;

export type AllowedHeader = (typeof HEADER_ALLOWLIST)[number];

/** Filtered header map: only `HEADER_ALLOWLIST` entries can be present. */
export type AllowlistedHeaders = Partial<Record<AllowedHeader, string>>;

/** Upstream headers as either a `Headers` instance or a plain map. */
export type RawHeaders = Headers | Readonly<Record<string, string>>;

/** URL/query params only - never a place to smuggle a body. */
export type ParamMap = Record<string, string | number | boolean>;

/** The gateway proxy request. `body` is opaque JSON, forwarded verbatim. */
export interface GatewayRequest {
  provider: string;
  endpoint: string;
  params?: ParamMap;
  /** RAW upstream JSON, byte-verbatim. Absent for GET-only upstreams. */
  body?: unknown;
  priority?: Priority;
}

/** The HTTP-200 envelope. `status` is the UPSTREAM status. */
export interface GatewayEnvelope {
  status: number;
  /** Byte-identical raw upstream payload; `null` on any non-2xx. */
  body: string | null;
  headers: AllowlistedHeaders;
}

/**
 * A gateway-GENERATED denial body, distinct from a passthrough upstream error
 * (which rides inside a 200 envelope). `{error:"budget_exceeded"}`,
 * `{error:"gated"}`, `{error:"unauthorized"}`, `{error:"bad_request"}`.
 */
export interface GatewayError {
  error: string;
}

/** Header carrying the gate expiry on a 503 `{error:"gated"}` reply. */
export const GATED_HEADER = 'x-gateway-gated-until';

/** What the HTTP layer must send back: a status + an envelope or a denial. */
export interface DispatchResult {
  status: number;
  payload: GatewayEnvelope | GatewayError;
  /** Extra response headers (only the 503 gated header today). */
  headers?: Record<string, string>;
}

/** Raw upstream result handed back by an injected fetcher (todos 7/8/9). */
export interface UpstreamResponse {
  status: number;
  /** Raw upstream payload text (byte-verbatim), or null when empty. */
  body: string | null;
  headers: RawHeaders;
}

/** Injectable upstream transport - the test stub and the real provider fetchers. */
export type UpstreamFetch = (req: GatewayRequest, caller: import('./auth.js').Caller) => Promise<UpstreamResponse>;

/** Injectable limiter runner. Defaults to the process limiter registry. */
export type LimiterRun = <T>(api: string, opts: RunOpts, fn: () => Promise<T>) => Promise<T>;

export interface ProxyDeps {
  fetchUpstream: UpstreamFetch;
  /** Defaults to the shared `limiters` registry. */
  runLimiter?: LimiterRun;
  /** Extra limiter opts merged over request-derived ones (e.g. GMGN `weight`). */
  runOpts?: RunOpts;
}

/**
 * An upstream non-2xx. Extends `HttpError` so the limiter's `handleError`
 * recognizes it (`instanceof HttpError`) and arms/retries, while carrying the
 * allowlisted headers so the handler can still build the 200 envelope.
 */
export class UpstreamError extends HttpError {
  constructor(
    status: number,
    header: string | null,
    message: string,
    readonly headers: AllowlistedHeaders,
  ) {
    super(status, header, message);
    this.name = 'UpstreamError';
  }
}

function headerValue(raw: RawHeaders, name: string): string | null {
  if (typeof (raw as Headers).get === 'function') return (raw as Headers).get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(raw as Record<string, string>)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

/** Keep ONLY the allowlisted headers; drop everything else. */
export function filterHeaders(raw: RawHeaders): AllowlistedHeaders {
  const out: AllowlistedHeaders = {};
  for (const name of HEADER_ALLOWLIST) {
    const value = headerValue(raw, name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Build the HTTP-200 envelope. `body` is the raw payload (null on non-2xx). */
export function buildEnvelope(
  status: number,
  body: string | null,
  headers: AllowlistedHeaders,
): DispatchResult {
  return { status: 200, payload: { status, body, headers } };
}

/** Build a gateway-generated denial (the ONLY non-200 replies). */
export function denial(
  status: number,
  error: string,
  headers?: Record<string, string>,
): DispatchResult {
  return headers === undefined
    ? { status, payload: { error } }
    : { status, payload: { error }, headers };
}

/**
 * Match the limiter's pre-existing gate-already-blocked rejection
 * (`ratelimit/limiter.ts:58-59`, message `${api} gated until <ISO>`). The
 * limiter is out of scope for this todo, so the message is the only handle; the
 * format is pinned there and covered by the gate test below - if that message
 * ever changes, the test fails rather than silently unmapping.
 */
const GATED_RE = /^.+? gated until (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/;

/** Extract the ISO gate-until from a gate-blocked rejection, else null. */
export function parseGatedUntil(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const match = GATED_RE.exec(err.message);
  return match === null ? null : match[1];
}

/** The one header value that arms a gate (`x-ratelimit-reset`, else retry-after). */
function armHeaderValue(headers: AllowlistedHeaders): string | null {
  return headers['x-ratelimit-reset'] ?? headers['retry-after'] ?? null;
}

/**
 * Map a limiter rejection to a `DispatchResult`. An upstream non-2xx becomes a
 * 200 envelope carrying the upstream status; the gate-blocked rejection becomes
 * the typed 503 denial. Anything else is unexpected and rethrows to the
 * Express funnel.
 */
export function mapLimiterError(err: unknown): DispatchResult {
  if (err instanceof UpstreamError) {
    return buildEnvelope(err.status, null, err.headers);
  }
  if (err instanceof HttpError) {
    return buildEnvelope(err.status, null, {});
  }
  const gatedUntil = parseGatedUntil(err);
  if (gatedUntil !== null) {
    return denial(503, 'gated', { [GATED_HEADER]: gatedUntil });
  }
  throw err;
}

/**
 * Run one proxy request: limiter → upstream fetch → envelope (200) or denial.
 *
 * `priority` (and `endpoint` as the limiter `path`) reach the limiter call, so a
 * caller's urgency is honoured and per-path windows keep working. Non-2xx
 * upstream statuses throw `UpstreamError` INSIDE the limiter so the gate/retry
 * machinery runs; the rejection then maps to the 200 envelope (or the 503 gated
 * denial on a later call).
 */
export async function proxyRequest(
  req: GatewayRequest,
  caller: import('./auth.js').Caller,
  deps: ProxyDeps,
): Promise<DispatchResult> {
  const run: LimiterRun = deps.runLimiter ?? ((api, opts, fn) => limiters.run(api, opts, fn));
  const opts: RunOpts = { priority: req.priority ?? 1, path: req.endpoint, ...deps.runOpts };
  try {
    const envelope = await run(req.provider, opts, async () => {
      const upstream = await deps.fetchUpstream(req, caller);
      const headers = filterHeaders(upstream.headers);
      if (upstream.status >= 200 && upstream.status < 300) {
        return { status: upstream.status, body: upstream.body, headers };
      }
      // Arm/retry via HttpError; the upstream ERROR BODY is NOT forwarded.
      throw new UpstreamError(
        upstream.status,
        armHeaderValue(headers),
        `upstream ${upstream.status}`,
        headers,
      );
    });
    return { status: 200, payload: envelope };
  } catch (err) {
    return mapLimiterError(err);
  }
}

export type ParseResult = { ok: true; value: GatewayRequest } | { ok: false };

function isParamMap(value: unknown): value is ParamMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

/**
 * Validate an untrusted HTTP body into a `GatewayRequest` (trust boundary).
 * Rejects a missing/blank provider or endpoint, a bad priority, or params that
 * are not a flat scalar map. `body` is intentionally not inspected - it is an
 * opaque upstream payload.
 */
export function parseGatewayRequest(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (typeof o.provider !== 'string' || o.provider === '') return { ok: false };
  if (typeof o.endpoint !== 'string' || o.endpoint === '') return { ok: false };
  if (o.priority !== undefined && o.priority !== 0 && o.priority !== 1 && o.priority !== 2) {
    return { ok: false };
  }
  if (o.params !== undefined && !isParamMap(o.params)) return { ok: false };
  return {
    ok: true,
    value: {
      provider: o.provider,
      endpoint: o.endpoint,
      params: o.params as ParamMap | undefined,
      body: o.body,
      priority: o.priority as Priority | undefined,
    },
  };
}
