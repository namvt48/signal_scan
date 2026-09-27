import type { ApiLimitSpec } from './types.js';

export function resolveNum(env: string, def: number): number {
  const v = process.env[env];
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : def;
}

export function buildSpecs(gmgnPlanWeight: number): Record<string, ApiLimitSpec> {
  return {
    gmgn: {
      weightBucket: {
        capacity: gmgnPlanWeight,
        refillPerSec: gmgnPlanWeight,
        defaultWeight: 1,
      },
      gate: { statuses: [429], header: 'x-ratelimit-reset' },
      priorityAgingMs: resolveNum('RL_PRIORITY_AGING_MS', 30_000),
    },
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
    dexscreener: {
      window: { max: resolveNum('RL_DEXSCREENER_MAX', 60), windowMs: 60_000 },
    },
  };
}
