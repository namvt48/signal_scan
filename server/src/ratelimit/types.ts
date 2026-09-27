export type Priority = 0 | 1 | 2; // 0=critical, 1=normal, 2=bulk

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
  defaultWeight: number;
}
export interface WindowSpec {
  max: number;
  windowMs: number;
}
export interface GateSpec {
  statuses: number[];
  header?: string;
  statusesWithCooldown?: { status: number; cooldownMs: number }[];
}
export interface RetrySpec {
  retries: number;
  backoff: 'fibo' | 'exp';
  baseMs: number;
  capMs?: number;
  retryOn: (status: number) => boolean;
}
export interface ApiLimitSpec {
  weightBucket?: BucketSpec;
  window?: WindowSpec;
  pathWindow?: WindowSpec;
  minIntervalMs?: number;
  maxConcurrency?: number;
  gate?: GateSpec;
  retry?: RetrySpec;
  priorityAgingMs?: number;
}
export interface RunOpts {
  weight?: number;
  priority?: Priority;
  path?: string;
}

/** A constraint contributes a ready time; it never throws. */
export interface Constraint {
  readyAt(now: number, opts: RunOpts): number;
  onStart(now: number, opts: RunOpts): void;
}

export interface LimiterSnapshot {
  inFlight: number;
  queued: number;
  gateUntil: number;
  windowUsed: number;
}
export interface Limiter {
  run<T>(opts: RunOpts, fn: () => Promise<T>): Promise<T>;
  snapshot(): LimiterSnapshot;
}
export interface Registry {
  run<T>(api: string, opts: RunOpts, fn: () => Promise<T>): Promise<T>;
  snapshot(): Record<string, LimiterSnapshot>;
}

/** Providers throw this so the layer owns gate + retry decisions. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly header: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
