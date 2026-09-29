// Runtime configuration — env-driven so cadences/thresholds change without code edits.

import { dirname, join } from 'node:path';

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name}="${v}" is not a number`);
  return n;
}

function str(name: string, def: string): string {
  return process.env[name] || def;
}

/** Positive-number env: default on missing/blank/NaN/≤0 — never throws (unlike num()). */
function posNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export type ProviderMode = 'mock' | 'nansen' | 'gmgn';

function resolveMode(): ProviderMode {
  const raw = str('MODE', 'nansen');
  if (raw === 'mock') return 'mock';
  if (raw === 'gmgn') return 'gmgn';
  return 'nansen';
}

const dbPath = str('DB_PATH', './data/signal_scan.db');

export const config = {
  port: num('PORT', 3001),
  dbPath,
  /** File cache for the setup indicators (t100/lf) — plan setup-fill-on-add §4.
   * Survives DB-table wipes and `make deploy` (rsync `--exclude data`). The
   * default resolves BESIDE the SQLite DB, so prod (DB_PATH=/data/signal_scan.db
   * through the ./data:/data bind mount) lands it at /data/nansen-cache.json.
   * `make ssh-rm` (Makefile:90) deletes REMOTE_DIR incl. data/ — cache dies
   * there, destructive-by-design. */
  setupCacheFile: str('SETUP_CACHE_FILE', join(dirname(dbPath), 'nansen-cache.json')),
  mode: resolveMode(),

  // Per-ENDPOINT poll cadences (ms). Pacing math per sweep: n×gap =
  // interval×SWEEP_PACE_FACTOR, so wall time = interval×0.8 + n×requestCost and a
  // shorter interval only tightens the gap (429/CF-403 risk — all 4 free
  // app-questions share ONE browser page).
  /** Market-cap refresh (essential-data) — hourly per user 2026-09-22. supply/
   * deployed_at now land write-once via the credit token-information kick. */
  pollEssentialMs: num('POLL_ESSENTIAL_MS', 3_600_000),
  /** Gap re-ask for a CA the 1h pass has not reached yet, so a fresh CA is
   * complete in minutes instead of hours. Only `supply IS NULL`. */
  pollEssentialGapMs: num('POLL_ESSENTIAL_GAP_MS', 300_000),
  /** How long a CA stays eligible for that re-ask — a mint Nansen never indexes
   * must not be retried forever (the 1h pass still covers it). */
  essentialGapWindowMs: num('ESSENTIAL_GAP_WINDOW_MS', 3_600_000),
  /** 24H Volume column + the Entry 🟢 gate. 15 min so both volume columns stay
   * fresh (user 2026-09-24); in MODE=gmgn this rides GMGN's own rate limit, not
   * the shared browser page. */
  pollVolumeMs: num('POLL_VOLUME_MS', 900_000),
  // The 3 Nansen setup indicators — fresh% (gini) + T100 multiple and LF (the
  // hourly-stats series) — are refreshed TOGETHER on ONE cadence (user 2026-09-22;
  // hourly since 2026-09-24), so the shared browser page carries them hourly.
  /** Setup-indicator cadence: gini + series + LF in one pass per CA. Also the
   * freshness TTL of a setup cache entry (isSetupCacheFresh). 6h (was 1h): every
   * tgm/flows call costs 1 credit, and the setup T100 series on a token older
   * than 7 days is DAILY data — an hourly re-fetch only re-reads the same buckets. */
  pollSetupMs: num('POLL_SETUP_MS', 21_600_000),
  /** Retry cadence while a CA's setup is INCOMPLETE; a COMPLETE CA with a fresh
   * cache entry sits out until that entry goes stale (POLL_SETUP_MS). Also the
   * setupSweep scheduler interval. */
  pollSetupRetryMs: num('POLL_SETUP_RETRY_MS', 3_600_000),
  /** A token THIS young that has no data yet gets no faster than an hourly retry:
   * Nansen has not indexed it yet, so a faster re-ask is pure spam. */
  newTokenMinAgeMs: posNum('NEW_TOKEN_MIN_AGE_MS', 4 * 3_600_000),
  /** Flat retry spacing for a too-new token (see newTokenMinAgeMs). */
  newTokenRetryMs: posNum('NEW_TOKEN_RETRY_MS', 3_600_000),
  /** Max CAs one setupSweep may query — each CA costs ≥1 credit, so a cold cache
   * must trickle (capped per pass) rather than burst a full backfill. */
  setupPassCap: posNum('SETUP_PASS_CAP', 40),
  /** A CA added inside this window jumps the queue on every free sweep, so a
   * fresh add is not stuck behind a long paced list (user 2026-09-22). */
  newCaPriorityMs: num('NEW_CA_PRIORITY_MS', 3_600_000),
  /** Retries inside ONE essential pass — the only source of supply/deployed_at. */
  essentialRetries: num('ESSENTIAL_RETRIES', 3),
  /** Symbol floor: ONE Solana RPC getAsset per ticker-less CA, no browser door. */
  pollSymbolBackfillMs: num('POLL_SYMBOL_BACKFILL_MS', 300_000),
  /** How long a CA stays eligible for the symbol floor — getAsset costs 10 DAS
    * credits per call, so a mint that never resolves must not be retried forever
    * (the 24h essential pass still covers it). */
  symbolBackfillWindowMs: num('SYMBOL_BACKFILL_WINDOW_MS', 3_600_000),
  /** Icon backfill (DexScreener /latest/dex/tokens): keyless + free, ONE batch
    * call covers ≤30 CAs, so a slow cadence is plenty even for a big queue. */
  pollIconMs: num('POLL_ICON_MS', 900_000),
  /** How long a CA stays eligible for the icon sweep. Generous by design: a
    * no-pair mint costs a share of one free batch call per sweep, unlike the
    * credit-bound symbol floor — the window only trims ancient dead rows. */
  iconWindowMs: num('ICON_WINDOW_MS', 30 * 86_400_000),
  /** Wallet HOLDINGS sweep — credit-free on EVERY chain since T5: sol via Solana
   * RPC (getTokenAccountsByOwner), base/bsc via one Multicall3 eth_call per wallet. */
  pollWalletsMs: num('POLL_WALLETS_MS', 900_000),
  /** Official tgm/flows (credit-only) refresh — T100 multiple, LF, the bal_* chart
   * windows. Now ALSO the T100-series cache TTL (isSeriesFresh) AND the flowsSweep
   * walk pace, so one knob means "series TTL = walk pace". 24h (was 6h, 15 min
   * before): each call costs 1 credit and the series on a token older than 7 days
   * is DAILY data, so a faster re-fetch only re-reads the same buckets.
   * Deliberately separate from the gini cadence (POLL_SETUP_MS, 6h). */
  pollFlowsMs: posNum('POLL_FLOWS_MS', 86_400_000),
  /** Credit-door retry: NANSEN_RETRIES attempts, spaced 1,1,2,3,5,8,13,… ×
   * NANSEN_RETRY_BASE_MS (fibonacci). 6 retries ≈ 20s/call, 7 ≈ 33s. */
  nansenRetries: num('NANSEN_RETRIES', 6),
  nansenRetryBaseMs: posNum('NANSEN_RETRY_BASE_MS', 1_000),

  // Logging (zero-dep logger, src/log.ts). LOG_LEVEL gates verbosity; per-call
  // lines sit at `debug`, so the default is one line per sweep (user 2026-09-24).
  // LOG_CALL_MS>0 ALSO raises a call to `info` when slower than this — the "which
  // query is slow" knob, without per-call spam. LOG_DEDUPE_MS collapses repeated
  // identical errors into one line + a (xN) count (86 CA × one bad key = 1 line).
  logLevel: str('LOG_LEVEL', 'info'),
  logDedupeMs: num('LOG_DEDUPE_MS', 60_000),
  logCallMs: num('LOG_CALL_MS', 0),

  // Solana JSON-RPC endpoint(s) for wallet holdings — comma/whitespace separated,
  // tried in order (same convention as scripts/wallet_watch.py: SOLANA_RPC_URL
  // → RPC_HTTP). No hardcoded endpoint in the provider.
  solanaRpcUrl: str('SOLANA_RPC_URL', str('RPC_HTTP', 'https://api.mainnet-beta.solana.com')),
  /** Solana RPC rate limit: minimum ms between request STARTS — ONE client-wide
   * FIFO, so concurrent callers queue instead of bursting. Raise it when the
   * endpoint 429s (the public mainnet endpoint is the aggressive one). */
  solanaRpcMinIntervalMs: num('SOLANA_RPC_MIN_INTERVAL_MS', 600),
  /** Solana RPC 429 retry budget per logical call: one backoff entry per retry
   * (400·2^n), so a transient 429 is absorbed instead of dropping the request.
   * A persistent 429 still rejects — the next wallet sweep is the durable retry,
   * so a huge budget would only stall the sweep. */
  solanaRpcMaxRetries: num('SOLANA_RPC_MAX_RETRIES', 3),
  /** Cooldown (ms) for an endpoint that reported Helius credit exhaustion
   * (JSON-RPC -32429 "max usage reached") — retired in-memory per client until
   * now + this, so a dead key is skipped instead of re-burned every sweep. */
  solanaRpcRetireMs: posNum('SOLANA_RPC_RETIRE_MS', 3_600_000),

  // EVM JSON-RPC primaries (plan evm-base-bsc D3): env override per chain (e.g. a
  // shared Alchemy URL). Empty → the keyless public endpoint in providers/evm.ts
  // is the primary; set → evm.ts appends the keyless endpoint as the fail-over (R2).
  baseRpcUrl: str('BASE_RPC_URL', ''),
  bscRpcUrl: str('BSC_RPC_URL', ''),

  // Pacing: spread each sweep's requests evenly across SWEEP_PACE_FACTOR of its
  // interval (0.8 = dùng 80% chu kỳ, nghỉ 20%). Scale = tăng interval hoặc thêm
  // CA — gap tự co giãn, không bao giờ dồn batch.
  sweepPaceFactor: Math.min(1, Math.max(0.1, num('SWEEP_PACE_FACTOR', 0.8))),

  // Gates the browser-transport sweeps (series + LF): the sidecar must be up.
  crawlEnabled: str('NANSEN_CRAWL', 'off') === 'on',
  nansenApiKey: str('NANSEN_API_KEY', ''),
  /** GMGN official OpenAPI key (gmgn.ai/ai). Absent -> MODE=gmgn falls back to nansen. */
  gmgnApiKey: str('GMGN_API_KEY', ''),
  /** GMGN plan weight — Free 5 / Plus 20 / Pro 50 (gmgn.ai/ai). Calls/sec allowed
   * = this / the endpoint's weight, enforced by the rate-control layer
   * (ratelimit/spec.ts weightBucket for the 'gmgn' limiter). */
  gmgnPlanWeight: posNum('GMGN_PLAN_WEIGHT', 5),

  // Auth (AUTH CONTRACT v1, src/auth.ts). All three default to '' = FAIL CLOSED:
  // no project id → browser tokens rejected; no roles → nobody is admin/viewer;
  // no service token → the daemon path is disabled. Never allow-by-default.
  /** Firebase project whose Google ID tokens are accepted (aud/iss) — expected
   * `trading-auth-67772`. Public JWKS verification only; no private key here. */
  firebaseProjectId: str('FIREBASE_PROJECT_ID', ''),
  /** `email:role` CSV ("a@b.com:admin,c@d.com:viewer") — roles admin|viewer,
   * emails case-insensitive + trimmed, unknown role strings ignored. */
  authUserRoles: str('AUTH_USER_ROLES', ''),
  /** Static Bearer token for the wallet_watch daemon (role 'service'). A long
   * random secret; compared in constant time (auth.ts matchServiceToken). */
  serviceToken: str('SERVICE_TOKEN', ''),
  // Mốc backfill lịch sử trades (ISO date) — 'từ lúc token được phát hiện'.
  nansenBackfillFrom: str('NANSEN_BACKFILL_FROM', '2026-08-01'),
  crawlWsEndpoint: str('CRAWL_WS_ENDPOINT', 'ws://chrome:3000'),
  /** Browser circuit breaker: consecutive THROWN transport failures before the
   * door fast-fails for a cooldown instead of burning 30–45s per CA. */
  crawlBreakerFailures: num('CRAWL_BREAKER_FAILURES', 5),
  crawlBreakerCooldownMs: num('CRAWL_BREAKER_COOLDOWN_MS', 60_000),

  // Door pool / proxy routing (plan nansen-proxy-routing D2, D6). One proxy IP per
  // door; '' → single-door fallback built from crawlWsEndpoint (current behaviour).
  /** Path to the proxy list: one `http://user:pass@host:port` per line (# / blank skipped). */
  crawlProxyFile: str('CRAWL_PROXY_FILE', ''),
  /** Per-(door,path) sliding-window budget — max requests to ONE path per window. */
  crawlPathBudget: posNum('CRAWL_PATH_BUDGET', 30),
  crawlBudgetWindowMs: posNum('CRAWL_BUDGET_WINDOW_MS', 60_000),
  /** Total requests per door per minute — just under the measured ~43/min page ceiling. */
  crawlDoorCapPerMin: posNum('CRAWL_DOOR_CAP_PER_MIN', 40),
  /** Cloudflare warmup wait: goto token-god-mode → poll title/cf_clearance until this. */
  crawlWarmupTimeoutMs: posNum('CRAWL_WARMUP_TIMEOUT_MS', 30_000),
  /** One in-page fetch timeout; a thrown timeout classifies as TRANSPORT (D4). */
  crawlRequestTimeoutMs: posNum('CRAWL_REQUEST_TIMEOUT_MS', 45_000),
  /** Max random jitter added on top of a 429 retry-after quarantine (D3). */
  crawlQuarantineJitterMs: posNum('CRAWL_QUARANTINE_JITTER_MS', 30_000),
};

/** Framework01 spec column 9: 24h volume below this = entry available (🟢). */
export const ENTRY_VOLUME_THRESHOLD = 300_000;

/** Top-100 snapshot diff window (ms) used for the "T100 decrease" setup. */
export const T100_WINDOW_MS = num('T100_WINDOW_MS', 86_400_000);

/** holder_snapshots older than this are pruned by the holders sweep. */
export const SNAPSHOT_RETENTION_MS = num('SNAPSHOT_RETENTION_MS', 72 * 3_600_000);

/** Retention window for pruneTrackedByNone (poller.ts) ONLY — a tracked CA whose
 * members' watch buys are ALL older than this is dropped. NO LONGER feeds the
 * `trackedWallets` column: wallet membership is ever-bought (permanent, no window). */
export const TRACKED_BY_WINDOW_MS = num('TRACKED_BY_WINDOW_MS', 7 * 86_400_000);

/** Auto-prune window (user 2026-09-20): a tracked CA with no tracked-wallet BUY
 * inflow inside this window — measured from the last inflow, or from added_at
 * when there is none — is deleted. Deliberately SEPARATE from
 * TRACKED_BY_WINDOW_MS, which feeds pruneTrackedByNone; shortening that one would
 * silently narrow the prune too. */
export const CA_INFLOW_WINDOW_MS = num('CA_INFLOW_WINDOW_MS', 48 * 3_600_000);

// Nansen factor PASS thresholds (Metis placeholders awaiting T's sign-off —
// env-tunable so changing them needs no code edit).
/** fresh% must reach this to pass the Fresh Wallet factor. */
export const FRESH_MIN_PCT = num('FRESH_MIN_PCT', 10);
/**
 * Top100 Decrease factor passes when the genesis-to-trough MULTIPLE (A/B, the
 * same number the FE cell shows as "T100 1.239") reaches this. multiple < 1 =
 * cohort GREW (no decrease) → settings.ts rejects a threshold below 1.
 * Replaced the old T100_MIN_PCT (decrease %) 2026-09-17 — the gate must be in
 * the unit the dashboard displays.
 */
export const T100_MIN_MULTIPLE = num('T100_MIN_MULTIPLE', 1.2);
/**
 * Low float: factor passes when the LF value lies inside this ABSOLUTE band
 * [LF_MIN, LF_MAX]. LF = token_state.genesis_bal, the top-100 cohort balance at
 * price=0 in TOKEN UNITS (the leftmost point of the exchange chart; see
 * exchangeAnchorLf) — i.e. exactly what the FE cell renders as `LF ${compact(lf)}`.
 * Replaced the old supply-share gate (lf/supply ≤ LF_MAX_PCT) 2026-09-17.
 */
export const LF_MIN = num('LF_MIN', 1_000_000);
export const LF_MAX = num('LF_MAX', 300_000_000);
/** Entry-size gate: CAs with entry_usd below this — or NULL — are skipped by assembleSignals. */
export const MIN_USD = num('MIN_USD', 50);
/**
 * Market-cap gate (user 2026-09-21): CAs with a KNOWN market_cap below this are
 * skipped by assembleSignals — the MC column doubles as a size filter. 0 = gate
 * OFF (the default), so the MC column ships without silently hiding anything.
 */
export const MIN_MC = num('MIN_MC', 0);
/**
 * Market-cap CEILING (user 2026-09-21): CAs with a KNOWN market_cap ABOVE this are
 * skipped by assembleSignals — the upper half of the MC band the FE renders under the
 * MC header. -1 = no cap (gate OFF, the default), so only the floor arms on its own.
 */
export const MAX_MC = num('MAX_MC', -1);
