// Per-caller bearer auth for the gateway (plan request-plane-gateway, todo 2).
//
// THREE separate tokens map to THREE callers. A single shared token would make
// Nansen credit use unattributable, so each caller gets its own door:
//   GATEWAY_TOKEN_A       → 'a'
//   GATEWAY_TOKEN_B       → 'b'
//   GATEWAY_TOKEN_WATCHER → 'watcher' (host watchers; never touches the credit API)
//
// Deny by default: a missing/malformed/unknown token → 401, and a BLANK
// configured token disables that caller (the empty string never matches).

import type { RequestHandler } from 'express';
import { matchServiceToken } from '../auth.js';
import { config } from '../config.js';

/** The credit-attributable callers. `watcher` exists so host watchers get their
 *  own door; it never consumes a or b's credit half (todos 16/17). */
export type Caller = 'a' | 'b' | 'watcher';

/** Token surface — injected so tests never depend on process-wide env. */
export interface CallerTokens {
  a: string;
  b: string;
  watcher: string;
}

/** Live tokens from the gateway's OWN env (config.ts, todo 6 — the gateway must
 *  not silently inherit instance a's values). */
export function callerTokensFromConfig(): CallerTokens {
  return {
    a: config.gatewayTokenA,
    b: config.gatewayTokenB,
    watcher: config.gatewayTokenWatcher,
  };
}

/** `Authorization: Bearer <token>` → the token; null for a missing/malformed
 *  header (mirrors the api's auth.ts parser). */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] === '') return null;
  return parts[1];
}

/**
 * Resolve the CALLER from the Authorization header against the configured
 * tokens. Each comparison is constant-time (reuses auth.ts `matchServiceToken`);
 * a blank/unset token never matches the empty string. null → the caller must be
 * denied 401.
 */
export function resolveCaller(header: string | undefined, tokens: CallerTokens): Caller | null {
  const token = bearerToken(header);
  if (token === null) return null;
  // Compare against EVERY caller (no early return) so response timing does not
  // reveal which caller matched.
  const a = matchServiceToken(token, tokens.a);
  const b = matchServiceToken(token, tokens.b);
  const w = matchServiceToken(token, tokens.watcher);
  if (a) return 'a';
  if (b) return 'b';
  if (w) return 'watcher';
  return null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireCaller once the per-caller bearer token resolved. */
      caller?: Caller;
    }
  }
}

/**
 * Express middleware gating a route (or a mounted prefix) behind a caller token
 * and attaching `req.caller`. Always 401 on failure — there is no authenticated
 * identity to forbid, so a 403 would be misleading.
 */
export function requireCaller(tokens: CallerTokens = callerTokensFromConfig()): RequestHandler {
  return (req, res, next) => {
    const caller = resolveCaller(req.headers.authorization, tokens);
    if (caller === null) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.caller = caller;
    next();
  };
}
