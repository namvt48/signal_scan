import type { ApiLimitSpec } from './types.js';

export function resolveNum(env: string, def: number): number {
  const v = process.env[env];
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : def;
}

/** Limiter key for GMGN key `index` — index 0 keeps the bare `gmgn` name so the
 *  metrics/test surface for a single-key deploy is unchanged. */
export function gmgnLimiterKey(index: number): string {
  return index === 0 ? 'gmgn' : `gmgn:${index}`;
}

/** Each GMGN account gets its own weight bucket and 429/403 gate; one account's
 * quota must not block another account. A separate `gmgn-egress` limiter caps
 * aggregate traffic because all keys share the same IP. Key 0 is `gmgn`;
 * keys 1..N-1 are `gmgn:1`..`gmgn:N-1`.
 */
export function buildSpecs(
  gmgnPlanWeight: number,
  gmgnKeyCount = 1,
  gmgnPlanWeights: readonly number[] = [],
): Record<string, ApiLimitSpec> {
  const specs: Record<string, ApiLimitSpec> = {};
  const gmgn429FallbackMs = resolveNum('RL_GMGN_429_FALLBACK_MS', 60_000);
  for (let i = 0; i < Math.max(1, gmgnKeyCount); i++) {
    const weight = gmgnPlanWeights[i] ?? gmgnPlanWeight;
    specs[gmgnLimiterKey(i)] = {
      weightBucket: {
        capacity: weight,
        refillPerSec: weight,
        defaultWeight: 1,
      },
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_GMGN_403COOLDOWNMS', 600_000) },
        ],
        header: 'x-ratelimit-reset',
        fallbackCooldownMs: gmgn429FallbackMs,
      },
      priorityAgingMs: resolveNum('RL_PRIORITY_AGING_MS', 30_000),
      queueMax: resolveNum('RL_QUEUE_MAX', 256),
      queueMaxAgeMs: resolveNum('RL_QUEUE_MAX_AGE_MS', 300_000),
      retry: {
        path: '/v1/token/info',
        retries: 1,
        backoff: 'exp',
        baseMs: 1_000,
        capMs: 5_000,
        jitterMs: 500,
        retryOn: (status) => status === 429 || status >= 500,
      },
    };
  }
  const evmRpc: ApiLimitSpec = {
    window: { max: resolveNum('RL_EVM_RPC_MAX', 300), windowMs: 60_000 },
    maxConcurrency: resolveNum('RL_EVM_RPC_MAXCONCURRENCY', 4),
    gate: {
      statuses: [429],
      statusesWithCooldown: [{ status: 403, cooldownMs: resolveNum('RL_EVM_RPC_403COOLDOWNMS', 60_000) }],
    },
    retry: {
      retries: Math.min(3, Math.max(1, Math.floor(resolveNum('RL_EVM_RPC_RETRIES', 1)))),
      backoff: 'exp',
      baseMs: resolveNum('RL_EVM_RPC_BASEMS', 500),
      capMs: resolveNum('RL_EVM_RPC_CAPMS', 2_000),
      jitterMs: 250,
      retryOn: (s) => s === 429 || s >= 500,
    },
  };
  return {
    ...specs,
    'gmgn-egress': {
      weightBucket: { capacity: 1, refillPerSec: 1, defaultWeight: 1 },
      maxConcurrency: 1,
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_GMGN_403COOLDOWNMS', 600_000) },
        ],
        header: 'x-ratelimit-reset',
        fallbackCooldownMs: gmgn429FallbackMs,
      },
      queueMax: resolveNum('RL_QUEUE_MAX', 256),
      queueMaxAgeMs: resolveNum('RL_QUEUE_MAX_AGE_MS', 300_000),
      deferGate: true,
    },
    'solana-rpc': {
      minIntervalMs: resolveNum('RL_SOLANA_RPC_MININTERVALMS', 600),
      gate: { statuses: [429] },
      retry: {
        retries: Math.min(5, Math.max(1, Math.floor(resolveNum('RL_SOLANA_RPC_RETRIES', 3)))),
        backoff: 'exp',
        baseMs: 400,
        capMs: 2_000,
        jitterMs: 250,
        retryOn: (s) => s === 429 || s >= 500,
      },
    },
    'evm-rpc': evmRpc,
    'evm-rpc-fallback': evmRpc,
    'nansen-credit': {
      maxConcurrency: resolveNum('RL_NANSEN_CREDIT_MAXCONCURRENCY', 2),
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_NANSEN_CREDIT_403COOLDOWNMS', 600_000) },
        ],
      },
      retry: {
        retries: Math.min(10, Math.max(1, Math.floor(resolveNum('RL_NANSEN_CREDIT_RETRIES', 6)))),
        backoff: 'fibo',
        baseMs: resolveNum('RL_NANSEN_CREDIT_BASEMS', 1_000),
        jitterMs: 500,
        retryOn: (s) => s === 429 || s >= 500,
      },
    },
    'nansen-door': {
      window: { max: resolveNum('RL_NANSEN_DOOR_MAX', 40), windowMs: 60_000 },
      pathWindow: { max: resolveNum('RL_NANSEN_DOOR_PATHMAX', 30), windowMs: 60_000 },
    },
    // DexScreener meters TWO endpoint classes at different rates, and a
    // `Limiter` holds a single `window` (`limiter.ts:44`), so each class needs
    // its own key (todo 9 pin):
    //   pairs/tokens/search → `dexscreener`          300/min
    //   profiles/boosts     → `dexscreener-profiles`  60/min
    // The `dexscreener` key name is KEPT (its window is the standard class).
    // Both windows stay env-tunable.
    dexscreener: {
      window: { max: resolveNum('RL_DEXSCREENER_MAX', 300), windowMs: 60_000 },
    },
    'dexscreener-profiles': {
      window: { max: resolveNum('RL_DEXSCREENER_PROFILES_MAX', 60), windowMs: 60_000 },
    },
  };
}
