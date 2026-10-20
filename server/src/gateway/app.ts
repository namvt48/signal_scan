// Gateway HTTP layer (plan request-plane-gateway, todo 2): per-caller bearer
// auth + public /health + token-gated /metrics and private monitor telemetry.
// NO TLS: the listener is bound to loopback + the private
// `signal-scan-gateway` network (docker-compose.gateway.yml), never the public
// internet.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { matchServiceToken } from '../auth.js';
import { limiters } from '../ratelimit/index.js';
import type { LimiterSnapshot } from '../ratelimit/types.js';
import { log } from '../log.js';
import { callerTokensFromConfig, requireCaller, type Caller, type CallerTokens } from './auth.js';
import { poolStatsOrNull, freshWalletPoolStatsOrNull } from './door.js';
import {
  denial,
  parseGatewayRequest,
  proxyRequest,
  type DispatchResult,
  type LimiterRun,
  type UpstreamFetch,
} from './contract.js';
import {
  GMGN_TOKEN_INFO_PATH,
  GmgnTokenInfoSingleFlight,
  createGmgnKeyPool,
  gmgnTokenInfoUpstream,
  handleGmgnTokenInfo,
} from './gmgn.js';
import type { GmgnKeyPool } from './gmgn-keys.js';
import {
  DEXSCREENER_LIMITER,
  DEXSCREENER_PATH,
  dexScreenerUpstream,
  handleDexScreener,
} from './dexscreener.js';
import {
  NANSEN_CREDIT_LIMITER,
  NANSEN_CREDIT_PATH,
  NANSEN_DOOR_PATH,
  handleNansenCredit,
  handleNansenDoor,
  nansenCreditUpstream,
  type DoorPost,
} from './nansen.js';
import { GatewayCache, type CacheStats, type Preflight } from './cache.js';
import { CreditAccountant, type CreditSnapshot } from './credit.js';
import { CHAINS, EVM_ADDRESS, canonicalCa, isSolanaAddress, type Chain } from '../shared/chain.js';
import { acknowledgeMarketAlertDelivery, replaceMarketSubscriptions, type CaTarget, type MarketAlertCaller } from '../db.js';

/**
 * DoorPool stats now come from `gateway/door.ts` (todo 10). Both health fields
 * are side-effect-free: they return null until their pool has received a call,
 * so `/health` never spawns a browser. The internal table includes egress IPs;
 * public `/api/health` intentionally exposes only the general pool's sanitized
 * fields.
 */
export interface GatewayAppDeps {
  /** Token surface; defaults to the gateway's own env (config.ts, todo 6). */
  tokens?: CallerTokens;
  /** Dedicated token for the read-only monitor scrape; grants no gateway caller role. */
  monitorToken?: string;
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
  /** GMGN multi-key pool (multi-account). Injectable for tests; when absent the app
   *  builds one from `config.gmgnApiKeys` iff no `gmgnUpstream` stub was injected. */
  gmgnPool?: GmgnKeyPool;
  /** DexScreener upstream (todo 9); defaults to the real keyless fetcher.
   *  Injectable so the per-class limiter route is testable with a stub. */
  dexUpstream?: UpstreamFetch;
  /** Nansen credit-API upstream (todo 7); defaults to the real fetcher that
   *  carries the gateway-held `apikey`. Injectable for tests. */
  nansenCreditUpstream?: UpstreamFetch;
  /** Optional override for the Nansen free-door transport.
   *  Production dispatches Gini to the dedicated Fresh Wallet pool. */
  nansenDoor?: DoorPost;
  /** Limiter runner override (tests); defaults to the shared registry. */
  runLimiter?: LimiterRun;
  /** Aggregate GMGN egress limiter override (tests). */
  runEgressLimiter?: LimiterRun;
  /**
   * Selective in-memory cache + single-flight. Shared public CA market data is
   * reusable across callers; wallet/user-scoped data is not. GMGN has
   * single-flight only, with no completed-response TTL.
   */
  cache?: GatewayCache;
  /** Per-app GMGN in-flight coalescer; injectable to inspect counters in tests. */
  gmgnSingleFlight?: GmgnTokenInfoSingleFlight;
  /**
   * Budget pre-flight seam (todo 19). Runs AFTER the cache lookup and BEFORE the
   * limiter, so a cache/single-flight hit skips it. Defaults to the app's
   * per-caller `CreditAccountant` (equal a/b split, soft-deny at half). Supplied
   * here only to override the budget in tests.
   */
  preflight?: Preflight;
  /**
   * Nansen credit ledger (todo 19). Injectable so tests can pin the budget/clock;
   * defaults to a fresh accountant over `config.nansenDailyCreditBudget`. The
   * accountant also wraps the credit upstream to charge the REAL per-call cost.
   */
  credits?: CreditAccountant;
  /** Immediate poll hook for newly subscribed shared tokens. */
  onMarketTargetsAdded?: (targets: readonly CaTarget[]) => void;
}

/** The raw-payload proxy route (todo 3). Provider routes (7/8/9) reuse the
 *  `proxyRequest` helper directly. */
export const PROXY_PATH = '/v1/proxy';

/** Read-only metrics: limiter queues, per-caller credit usage, cached market
 *  data, and GMGN single-flight joins. */
export interface GatewayMetrics {
  ok: true;
  caller: Caller | null;
  ratelimit: Record<string, LimiterSnapshot>;
  credits: CreditSnapshot;
  cache: CacheStats;
  gmgnSingleFlight: { joined: number; inflight: number };
  text: string;
}

/** Plain-text rendering of `GatewayMetrics` (one line per section). */
export function formatMetricsText(m: Omit<GatewayMetrics, 'text'>): string {
  const lines = [
    `gateway ok=${m.ok} caller=${m.caller ?? 'none'}`,
    `credits day=${m.credits.day} budget=${m.credits.budget} half=${m.credits.half} used_a=${m.credits.used.a} used_b=${m.credits.used.b}`,
    `cache hits=${m.cache.hits} misses=${m.cache.misses} joined=${m.cache.joined} size=${m.cache.size} inflight=${m.cache.inflight}`,
    `gmgn-singleflight joined=${m.gmgnSingleFlight.joined} inflight=${m.gmgnSingleFlight.inflight}`,
  ];
  for (const [key, s] of Object.entries(m.ratelimit)) {
    lines.push(
      `limiter ${key} inFlight=${s.inFlight} queued=${s.queued} gateUntil=${s.gateUntil} windowUsed=${s.windowUsed}`,
    );
  }
  return lines.join('\n');
}

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
  const cache = deps.cache ?? new GatewayCache();
  const gmgnSingleFlight = deps.gmgnSingleFlight ?? new GmgnTokenInfoSingleFlight();
  const credits = deps.credits ?? new CreditAccountant();
  const app = express();

  // Request log — same shape as api.ts. NEVER logs headers, so no token leaks.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      log.info('[gateway]', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        caller: req.caller ?? null,
        dur: Date.now() - t0,
      });
    });
    next();
  });

  // The gateway listener is private; its pool inventory retains egress fields
  // for internal diagnostics. The public API health proxy strips them.
  app.get('/health', (_req, res) => {
    const doors = poolStatsOrNull();
    res.json({
      ok: true,
      ratelimit: limiters.snapshot(),
      doors,
      freshWalletDoors: freshWalletPoolStatsOrNull(),
      nansen: {
        browserReady: doors === null ? null : doors.some(({ state }) => state === 'healthy' || state === 'probation'),
      },
    });
  });

  // Token-gated, READ-ONLY (todo 20): every limiter key + per-caller credit
  // usage + cache counters. JSON by default (with a `text` summary member);
  // `?format=text` returns just the plain-text summary. Any valid caller token
  // (a|b|watcher) may read; absent/invalid → 401. No metrics dependency.
  app.get('/metrics', requireCaller(tokens), (req, res) => {
    const snapshot: Omit<GatewayMetrics, 'text'> = {
      ok: true,
      caller: req.caller ?? null,
      ratelimit: limiters.snapshot(),
      credits: credits.snapshot(),
      cache: cache.stats(),
      gmgnSingleFlight: gmgnSingleFlight.snapshot(),
    };
    const text = formatMetricsText(snapshot);
    if (req.query.format === 'text') {
      res.type('text/plain').send(text);
      return;
    }
    const body: GatewayMetrics = { ...snapshot, text };
    res.json(body);
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

  app.post('/v1/market/subscriptions', parseJson, (req: Request, res: Response) => {
    const caller = req.caller;
    if (caller !== 'a' && caller !== 'b') {
      send(res, denial(403, 'market_subscriptions_forbidden'));
      return;
    }
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || !('tokens' in body)) {
      send(res, denial(400, 'bad_request'));
      return;
    }
    const raw = (body as { tokens?: unknown }).tokens;
    if (!Array.isArray(raw) || raw.length > 10_000) {
      send(res, denial(400, 'bad_request'));
      return;
    }
    const targets: CaTarget[] = [];
    for (const item of raw) {
      if (item === null || typeof item !== 'object') {
        send(res, denial(400, 'bad_request'));
        return;
      }
      const { ca, chain } = item as { ca?: unknown; chain?: unknown };
      if (typeof ca !== 'string' || typeof chain !== 'string' || !CHAINS.includes(chain as Chain)) {
        send(res, denial(400, 'bad_request'));
        return;
      }
      if (chain === 'sol' ? !isSolanaAddress(ca) : !EVM_ADDRESS.test(ca)) {
        send(res, denial(400, 'bad_request'));
        return;
      }
      targets.push({ address: canonicalCa(ca, chain as Chain), chain: chain as Chain });
    }
    const added = replaceMarketSubscriptions(caller, targets);
    deps.onMarketTargetsAdded?.(added);
    res.json({ status: 200, body: JSON.stringify({ ok: true, added }), headers: {} });
  });

  app.post('/v1/market/alerts/ack', parseJson, (req: Request, res: Response) => {
    const caller = req.caller;
    if (caller !== 'a' && caller !== 'b') {
      send(res, denial(403, 'market_alert_ack_forbidden'));
      return;
    }
    const body: unknown = req.body;
    const throughId = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? Reflect.get(body, 'throughId')
      : undefined;
    if (typeof throughId !== 'number' || !Number.isSafeInteger(throughId) || throughId < 0) {
      send(res, denial(400, 'bad_request'));
      return;
    }
    if (!acknowledgeMarketAlertDelivery(caller as MarketAlertCaller, throughId)) {
      send(res, denial(409, 'market_alert_ack_out_of_range'));
      return;
    }
    res.json({ status: 200, body: '{}', headers: {} });
  });

  if (deps.upstream !== undefined) {
    const upstream = deps.upstream;
    app.post(PROXY_PATH, parseJson, (req: Request, res: Response) => {
      void handleProxy(req, res, upstream, deps.runLimiter);
    });
  }

  // add the fresh client_id + timestamp GMGN mandates on each actual upstream
  // call, so it has no completed-response cache; only simultaneous identical CA
  // reads single-flight in this gateway. The initiator's priority controls the
  // single execution. The real fetcher holds the gateway-held X-APIKEY; tests
  // inject `gmgnUpstream`.
  const gmgnPool =
    deps.gmgnPool ??
    (deps.gmgnUpstream === undefined && config.gmgnApiKeys.length > 0
      ? createGmgnKeyPool()
      : undefined);
  const gmgnUpstream = deps.gmgnUpstream ?? gmgnTokenInfoUpstream();
  app.get('/monitor/metrics', (req, res) => {
    const authorization = req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!matchServiceToken(token, deps.monitorToken ?? config.monitorApiToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ ok: true, credits: credits.snapshot(), gmgnKeys: gmgnPool?.stats() ?? [] });
  });
  app.post(GMGN_TOKEN_INFO_PATH, parseJson, (req: Request, res: Response, next: NextFunction) => {
    const caller = req.caller;
    if (caller === undefined) {
      send(res, denial(401, 'unauthorized'));
      return;
    }
    void gmgnSingleFlight
      .run(req.body, () => handleGmgnTokenInfo(req.body, caller, {
        fetchUpstream: gmgnUpstream,
        runLimiter: deps.runLimiter,
        runEgressLimiter: deps.runEgressLimiter,
        pool: gmgnPool,
      }))
      .then((result) => send(res, result), next);
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
    const routeDeps = { fetchUpstream: dexUpstream, runLimiter: deps.runLimiter };
    // Cache lookup + single-flight BEFORE `handleDexScreener`'s limiter (todo 11);
    // profiles/boosts are classified uncacheable inside the cache.
    void cache
      .dispatch(
        DEXSCREENER_LIMITER,
        req.body,
        caller,
        () => handleDexScreener(req.body, caller, routeDeps),
        deps.preflight,
      )
      .then((result) => send(res, result), next);
  });

  // Nansen credit API (todo 7 seam i): `NansenApiClient` methods (tokenFlows —
  // the LIVE chart path — tokenInformation, dexTrades, currentBalance) behind
  // `limiters.run('nansen-credit', {priority})`. The gateway holds NANSEN_API_KEY;
  // tests inject `nansenCreditUpstream`.
  const creditUpstream = credits.wrap(deps.nansenCreditUpstream ?? nansenCreditUpstream());
  const creditPreflight = deps.preflight ?? credits.preflight;
  app.post(NANSEN_CREDIT_PATH, parseJson, (req: Request, res: Response, next: NextFunction) => {
    const caller = req.caller;
    if (caller === undefined) {
      send(res, denial(401, 'unauthorized'));
      return;
    }
    const routeDeps = { fetchUpstream: creditUpstream, runLimiter: deps.runLimiter };
    // Cache lookup + single-flight BEFORE `handleNansenCredit`'s limiter (todo 11);
    // public CA flows are cached only for exact range/label parameters. The
    // per-caller budget pre-flight runs only for the initiating cache miss.
    void cache
      .dispatch(
        NANSEN_CREDIT_LIMITER,
        req.body,
        caller,
        () => handleNansenCredit(req.body, caller, routeDeps),
        creditPreflight,
      )
      .then((result) => send(res, result), next);
  });

  app.post(NANSEN_DOOR_PATH, parseJson, (req: Request, res: Response, next: NextFunction) => {
    const caller = req.caller;
    if (caller === undefined) {
      send(res, denial(401, 'unauthorized'));
      return;
    }
    void cache
      .dispatch(
        NANSEN_DOOR_PATH,
        req.body,
        caller,
        () => handleNansenDoor(req.body, { postJson: deps.nansenDoor, caller }),
      )
      .then((result) => send(res, result), next);
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
