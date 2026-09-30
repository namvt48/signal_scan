// Gateway transport — the ONE egress seam for the TS providers (todo 13).
//
// The api process no longer talks to any upstream directly: it POSTs to the
// request-plane gateway, which owns rate-control, caching and credential
// injection. Every upstream response comes back as HTTP 200 with the todo-3
// envelope `{status, body, headers}`; a non-200 answer is a GATEWAY denial
// (401/400/429 budget/503 gated) and becomes an HttpError so the existing
// typed-error paths keep working.
//
// Base URL + caller token are INJECTABLE (todo 14 wires them from config);
// `gatewayClientFromEnv` is only a stopgap so providers keep a default the same
// way they read env today. There is deliberately NO loopback default here.

import { HttpError } from './ratelimit/types.js';

/** Route paths on the gateway. Duplicated literals: importing `gateway/*.ts`
 *  would drag the DoorPool -> crawl -> providers graph in and cycle. Both sides
 *  are pinned by tests. */
export const GW_NANSEN_CREDIT_PATH = '/v1/nansen/credit';
export const GW_NANSEN_DOOR_PATH = '/v1/nansen/door';
export const GW_GMGN_TOKEN_INFO_PATH = '/v1/gmgn/token-info';
export const GW_DEXSCREENER_PATH = '/v1/dexscreener';

/** Header the gateway sets on a 503 gate denial (mirror of gateway/contract.ts GATED_HEADER). */
const GATED_HEADER = 'x-gateway-gated-until';

export interface GatewayCallResult {
  /** Upstream status from the envelope (2xx for a body, non-2xx for an upstream error). */
  status: number;
  /** Raw upstream payload as a string (2xx only), else null. */
  body: string | null;
  /** The four allowlisted response headers, lowercased. */
  headers: Record<string, string>;
}

export interface GatewayClientOptions {
  baseUrl: string;
  callerToken: string;
  /** Injectable for tests; resolved per call so a late `globalThis.fetch` stub is honoured. */
  fetchImpl?: typeof fetch;
}

/** POST `payload` to one gateway route and unwrap the envelope. Throws HttpError
 *  on a gateway denial (non-200 answer) so callers keep one typed-error path. */
export class GatewayClient {
  constructor(private readonly opts: GatewayClientOptions) {}

  async call(routePath: string, payload: unknown): Promise<GatewayCallResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`${this.opts.baseUrl.replace(/\/$/, '')}${routePath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.callerToken}`,
      },
      body: JSON.stringify(payload),
    });
    const raw = (await res.json().catch(() => null)) as unknown;
    if (res.status !== 200 || raw === null || typeof raw !== 'object') {
      const err = raw && typeof raw === 'object' ? (raw as { error?: unknown }).error : undefined;
      throw new HttpError(
        res.status,
        res.headers.get(GATED_HEADER),
        `gateway ${routePath} ${res.status}${err !== undefined ? `: ${String(err)}` : ''}`.slice(0, 200),
      );
    }
    const env = raw as { status?: unknown; body?: unknown; headers?: unknown };
    if (typeof env.status !== 'number' || (env.body !== null && typeof env.body !== 'string')) {
      throw new HttpError(res.status, null, `gateway ${routePath}: malformed envelope`);
    }
    const headers: Record<string, string> = {};
    if (env.headers !== null && typeof env.headers === 'object') {
      for (const [k, v] of Object.entries(env.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
    }
    return { status: env.status, body: (env.body ?? null) as string | null, headers };
  }
}

/** Stopgap default: env-read only, NO loopback default. Todo 14 replaces this
 *  with config wiring. */
export function gatewayClientFromEnv(): GatewayClient {
  return new GatewayClient({
    baseUrl: process.env.GATEWAY_URL ?? '',
    callerToken: process.env.GATEWAY_CALLER_TOKEN ?? '',
  });
}
