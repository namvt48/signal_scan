// Gateway HTTP layer (plan request-plane-gateway, todo 2): per-caller bearer
// auth + public /health + token-gated /metrics, mirroring the api.ts `createApp`
// shape. NO TLS: the listener is bound to loopback + the private
// `signal-scan-gateway` network (docker-compose.gateway.yml), never the public
// internet.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { limiters } from '../ratelimit/index.js';
import { log } from '../log.js';
import { callerTokensFromConfig, requireCaller, type CallerTokens } from './auth.js';

/**
 * DoorPool stats are unavailable in THIS process until todo 10 relocates the
 * DoorPool to `gateway/door.ts`: today `poolStatsOrNull()` lives in crawl.ts,
 * which pulls in the whole browser/DB graph — importing it here would build a
 * SECOND pool inside the gateway container, the exact bug todo 10 avoids.
 * HOOK (todo 10): replace the `doors: null` below with the relocated pool's
 * `stats()`. Those stats include `egressIp`, which the GMGN-allowlist check
 * (todo 22) needs.
 *
 * WHY THE (FUTURE) `egressIp` MAY BE DISCLOSED UNAUTHENTICATED: `/health` binds
 * loopback + the private `signal-scan-gateway` net only, so the egress IP is not
 * public. `/health` is NOT token-authenticated — do not describe it as such; the
 * disclosure is intentional and safe given those bindings (plan todo 2).
 */
export interface GatewayAppDeps {
  /** Token surface; defaults to the gateway's own env (config.ts, todo 6). */
  tokens?: CallerTokens;
}

export function createGatewayApp(deps: GatewayAppDeps = {}): Express {
  const tokens = deps.tokens ?? callerTokensFromConfig();
  const app = express();

  // Request log — same shape as api.ts. NEVER logs headers, so no token leaks.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      log.info('[gateway]', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        dur: Date.now() - t0,
      });
    });
    next();
  });

  // PUBLIC health probe (acceptance: `{ok:true}`). No auth by design — see the
  // egressIp note above. `doors` is null until todo 10 (HOOK above).
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      ratelimit: limiters.snapshot(),
      doors: null,
    });
  });

  // Token-gated. Todo 20 fills the real metrics; until then it also reports the
  // caller its token resolved to — the observable proof of credit attribution.
  app.get('/metrics', requireCaller(tokens), (req, res) => {
    res.json({ ok: true, caller: req.caller ?? null });
  });

  // Every /v1/* route sits behind a caller token. Todo 3 defines the actual
  // proxy contract and replaces this placeholder; it exists now so a token-less
  // call is 401 (not 404) and a valid token is not rejected.
  app.use('/v1', requireCaller(tokens));
  app.use('/v1', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Public 404 + error funnel, mirroring api.ts. The message is generic so an
  // upstream/gateway error can never echo a token.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('[gateway] unhandled', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
