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
  fallbackCooldownMs?: number;
  statusesWithCooldown?: { status: number; cooldownMs: number }[];
}
export interface RetrySpec {
  retries: number;
  backoff: 'fibo' | 'exp';
  baseMs: number;
  capMs?: number;
  jitterMs?: number;
  random?: () => number;
  /** Restrict automatic retries to this limiter path, if set. */
  path?: string;
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
  queueMax?: number;
  queueMaxAgeMs?: number;
  deferGate?: boolean;
}
export interface RunOpts {
  weight?: number;
  priority?: Priority;
  path?: string;
  caller?: string;
  deadlineAt?: number;
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

export type LimiterUnavailableReason = 'queue-full' | 'queue-expired' | 'gate';

/** A bounded scheduler declined work before an upstream request was made. */
export class LimiterUnavailableError extends Error {
  constructor(
    readonly api: string,
    readonly reason: LimiterUnavailableReason,
    readonly retryAt: number | null = null,
  ) {
    super(
      reason === 'gate' && retryAt !== null
        ? `ratelimit: ${api} gated until ${new Date(retryAt).toISOString()}`
        : `ratelimit: ${api} ${reason}`,
    );
    this.name = 'LimiterUnavailableError';
  }
}
