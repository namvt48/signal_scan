// Gateway HTTP layer (plan request-plane-gateway, todo 2): per-caller bearer
// auth + public /health + token-gated /metrics, mirroring the api.ts `createApp`
// shape. NO TLS: the listener is bound to loopback + the private
// `signal-scan-gateway` network (docker-compose.gateway.yml), never the public
// internet.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { limiters } from '../ratelimit/index.js';
import { log } from '../log.js';
import { callerTokensFromConfig, requireCaller, type CallerTokens } from './auth.js';
import {
  denial,
  parseGatewayRequest,
  proxyRequest,
  type DispatchResult,
  type LimiterRun,
  type UpstreamFetch,
} from './contract.js';

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
  /**
   * Raw upstream transport for the `/v1/proxy` contract route (todos 7/8/9 wire
   * the real provider fetchers). Injectable so the contract is testable with a
   * stub. When absent the route is not wired and falls through to 404 — the
   * pre-todo-3 placeholder behavior.
   */
  upstream?: UpstreamFetch;
  /** Limiter runner override (tests); defaults to the shared registry. */
  runLimiter?: LimiterRun;
}

/** The raw-payload proxy route (todo 3). Provider routes (7/8/9) reuse the
 *  `proxyRequest` helper directly. */
export const PROXY_PATH = '/v1/proxy';

function send(res: Response, result: DispatchResult): void {
  if (result.headers !== undefined) {
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  }
  res.status(result.status).json(result.payload);
}

async function handleProxy(
  req: Request,
  res: Response,
  upstream: UpstreamFetch,
  runLimiter: LimiterRun | undefined,
): Promise<void> {
  const parsed = parseGatewayRequest(req.body);
  if (!parsed.ok) {
    send(res, denial(400, 'bad_request'));
    return;
  }
  const caller = req.caller;
  if (caller === undefined) {
    send(res, denial(401, 'unauthorized'));
    return;
  }
  const deps = runLimiter === undefined
    ? { fetchUpstream: upstream }
    : { fetchUpstream: upstream, runLimiter };
  send(res, await proxyRequest(parsed.value, caller, deps));
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

  // Every /v1/* route sits behind a caller token. The raw-payload proxy
  // contract (todo 3) is `POST /v1/proxy`; without a wired upstream it falls
  // through to the 404 below (the pre-todo-3 placeholder behavior).
  app.use('/v1', requireCaller(tokens));
  if (deps.upstream !== undefined) {
    const upstream = deps.upstream;
    const jsonBody = express.json({ limit: '2mb' });
    app.post(
      PROXY_PATH,
      (req, res, next) => {
        jsonBody(req, res, (err?: unknown) => {
          if (err !== undefined) {
            send(res, denial(400, 'bad_request'));
            return;
          }
          next();
        });
      },
      (req: Request, res: Response) => {
        void handleProxy(req, res, upstream, deps.runLimiter);
      },
    );
  }
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
