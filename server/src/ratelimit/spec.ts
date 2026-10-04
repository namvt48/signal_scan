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

/**
 * One GMGN limiter PER KEY: GMGN meters by plan weight per ACCOUNT, so each key needs
 * its own weight bucket AND its own 429/403 gate — a shared limiter would let one
 * account's 429 gate the others (defeating the whole point of a key pool). Key 0 is
 * named `gmgn`; keys 1..N-1 are `gmgn:1`..`gmgn:N-1`.
 */
export function buildSpecs(
  gmgnPlanWeight: number,
  gmgnKeyCount = 1,
  gmgnPlanWeights: readonly number[] = [],
): Record<string, ApiLimitSpec> {
  const specs: Record<string, ApiLimitSpec> = {};
  for (let i = 0; i < Math.max(1, gmgnKeyCount); i++) {
    const weight = gmgnPlanWeights[i] ?? gmgnPlanWeight;
    specs[gmgnLimiterKey(i)] = {
      weightBucket: {
        capacity: weight,
        refillPerSec: weight,
        defaultWeight: 1,
      },
      // 429 arms via `x-ratelimit-reset`. 403 arms a FIXED cooldown: the shared
      // Gate matches numeric status only (`gate.ts:21-31`, `types.ts:12-16`) and
      // `Limiter.handleError` passes no body (`limiter.ts:182-184`), so the plan
      // gates ALL gmgn 403s (todo 8) on the documented assumption that GMGN
      // returns 403 ONLY for the egress-IP allowlist (`AUTH_IP_BLOCKED`) — a
      // blocked egress then backs off instead of hot-looping.
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_GMGN_403COOLDOWNMS', 600_000) },
        ],
        header: 'x-ratelimit-reset',
      },
      priorityAgingMs: resolveNum('RL_PRIORITY_AGING_MS', 30_000),
    };
  }
  return {
    ...specs,
    'solana-rpc': {
      minIntervalMs: resolveNum('RL_SOLANA_RPC_MININTERVALMS', 600),
      gate: { statuses: [429] },
      retry: {
        retries: resolveNum('RL_SOLANA_RPC_RETRIES', 3),
        backoff: 'exp',
        baseMs: 400,
        capMs: 2_000,
        retryOn: (s) => s === 429 || s >= 500,
      },
    },
    'nansen-credit': {
      maxConcurrency: resolveNum('RL_NANSEN_CREDIT_MAXCONCURRENCY', 2),
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_NANSEN_CREDIT_403COOLDOWNMS', 600_000) },
        ],
      },
      retry: {
        retries: resolveNum('RL_NANSEN_CREDIT_RETRIES', 6),
        backoff: 'fibo',
        baseMs: resolveNum('RL_NANSEN_CREDIT_BASEMS', 1_000),
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
