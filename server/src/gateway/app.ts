// Gateway HTTP layer (plan request-plane-gateway, todo 2): per-caller bearer
// auth + public /health + token-gated /metrics, mirroring the api.ts `createApp`
// shape. NO TLS: the listener is bound to loopback + the private
// `signal-scan-gateway` network (docker-compose.gateway.yml), never the public
// internet.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { limiters } from '../ratelimit/index.js';
import { log } from '../log.js';
import { callerTokensFromConfig, requireCaller, type CallerTokens } from './auth.js';
import { poolStatsOrNull } from './door.js';
import {
  denial,
  parseGatewayRequest,
  proxyRequest,
  type DispatchResult,
  type LimiterRun,
  type UpstreamFetch,
} from './contract.js';
import { GMGN_TOKEN_INFO_PATH, gmgnTokenInfoUpstream, handleGmgnTokenInfo } from './gmgn.js';
import { DEXSCREENER_PATH, dexScreenerUpstream, handleDexScreener } from './dexscreener.js';

/**
 * DoorPool stats now come from the relocated pool in `gateway/door.ts` (todo 10).
 * `poolStatsOrNull()` is side-effect-free: it returns null until a door has
 * actually been used, so `/health` never spawns a chrome pool. The stats include
 * `egressIp`, which the GMGN-allowlist check (todo 22) needs.
 *
 * WHY THE `egressIp` MAY BE DISCLOSED UNAUTHENTICATED: `/health` binds loopback +
 * the private `signal-scan-gateway` net only, so the egress IP is not public.
 * `/health` is NOT token-authenticated — do not describe it as such; the
 * disclosure is intentional and safe given those bindings (plan todo 2). The
 * PUBLIC api-side `/api/health` (instance a/b) STRIPS `egressIp` + proxy strings
 * before re-serving the table (api.ts).
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
  /** GMGN token/info upstream (todo 8); defaults to the real fetcher. Injectable
   *  so the weighted/403 route is testable with a stub. */
  gmgnUpstream?: UpstreamFetch;
  /** DexScreener upstream (todo 9); defaults to the real keyless fetcher.
   *  Injectable so the per-class limiter route is testable with a stub. */
  dexUpstream?: UpstreamFetch;
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
  // egressIp note above. `doors` is the relocated DoorPool's live stats (todo 10),
  // or null until a door call has built the pool.
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      ratelimit: limiters.snapshot(),
      doors: poolStatsOrNull(),
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

  // JSON body parser; a parse error becomes the contract's 400 denial (same as
  // the /v1/proxy route). Shared by the provider POST routes.
  const jsonBody = express.json({ limit: '2mb' });
  const parseJson = (req: Request, res: Response, next: NextFunction): void => {
    jsonBody(req, res, (err?: unknown) => {
      if (err !== undefined) {
        send(res, denial(400, 'bad_request'));
        return;
      }
      next();
    });
  };

  if (deps.upstream !== undefined) {
    const upstream = deps.upstream;
    app.post(PROXY_PATH, parseJson, (req: Request, res: Response) => {
      void handleProxy(req, res, upstream, deps.runLimiter);
    });
  }

  // GMGN token/info (todo 8): a DEDICATED route (not /v1/proxy) because it must
  // add the fresh client_id + timestamp GMGN mandates — so it is EXCLUDED from
  // the todo-11 cache/single-flight — and must pass GMGN_TOKEN_INFO_WEIGHT to
  // the `gmgn` limiter. The real fetcher holds the gateway-held X-APIKEY; tests
  // inject `gmgnUpstream`.
  const gmgnUpstream = deps.gmgnUpstream ?? gmgnTokenInfoUpstream();
  app.post(GMGN_TOKEN_INFO_PATH, parseJson, (req: Request, res: Response, next: NextFunction) => {
    const caller = req.caller;
    if (caller === undefined) {
      send(res, denial(401, 'unauthorized'));
      return;
    }
    void handleGmgnTokenInfo(req.body, caller, {
      fetchUpstream: gmgnUpstream,
      runLimiter: deps.runLimiter,
    }).then((result) => send(res, result), next);
  });

  // DexScreener (todo 9): a per-CLASS limiter route. The class is picked from
  // the request `endpoint` — profiles/boosts at 60/min, pairs/tokens/search at
  // 300/min (gateway/dexscreener.ts). Keyless upstream; tests inject `dexUpstream`.
  const dexUpstream = deps.dexUpstream ?? dexScreenerUpstream();
  app.post(DEXSCREENER_PATH, parseJson, (req: Request, res: Response, next: NextFunction) => {
    const caller = req.caller;
    if (caller === undefined) {
      send(res, denial(401, 'unauthorized'));
      return;
    }
    void handleDexScreener(req.body, caller, {
      fetchUpstream: dexUpstream,
      runLimiter: deps.runLimiter,
    }).then((result) => send(res, result), next);
  });

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
