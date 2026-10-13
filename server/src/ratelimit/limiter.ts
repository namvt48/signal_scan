import { Bucket } from './bucket.js';
import { Window } from './window.js';
import { MinInterval } from './min-interval.js';
import { Semaphore } from './semaphore.js';
import { Gate } from './gate.js';
import { HttpError, LimiterUnavailableError, type ApiLimitSpec, type Constraint, type Limiter as ILimiter, type LimiterSnapshot, type Priority, type RetrySpec, type RunOpts, type WindowSpec } from './types.js';

interface Job {
  priority: Priority;
  enqueuedAt: number;
  opts: RunOpts;
  fn: () => Promise<unknown>;
  attempt: number;
  notBefore: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  lastError?: unknown;
}

const CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
};

export class Limiter implements ILimiter {
  private readonly queues: Job[][] = [[], [], []];
  private readonly constraints: Constraint[] = [];
  private readonly paths = new Map<string, Window>();
  private readonly sem: Semaphore | null;
  private readonly gate: Gate | null;
  private readonly agingMs: number;
  private readonly queueMax: number;
  private readonly queueMaxAgeMs: number;
  private readonly deferGate: boolean;
  private readonly lastCaller = new Map<Priority, string>();
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt: number | null = null;

  constructor(
    private readonly api: string,
    spec: ApiLimitSpec,
    private readonly clock = CLOCK,
  ) {
    if (spec.weightBucket) {
      const b = spec.weightBucket;
      this.constraints.push(new Bucket(b.capacity, b.refillPerSec, b.defaultWeight));
    }
    if (spec.window) this.constraints.push(new Window(spec.window.max, spec.window.windowMs));
    if (spec.minIntervalMs) this.constraints.push(new MinInterval(spec.minIntervalMs));
    this.sem = spec.maxConcurrency ? new Semaphore(spec.maxConcurrency) : null;
    this.gate = spec.gate ? new Gate(spec.gate) : null;
    this.agingMs = spec.priorityAgingMs ?? 30_000;
    this.retry = spec.retry ?? null;
    this.pathWindow = spec.pathWindow ?? null;
    this.queueMax = Math.min(10_000, Math.max(0, Math.floor(spec.queueMax ?? 256)));
    this.queueMaxAgeMs = Math.min(300_000, Math.max(1, spec.queueMaxAgeMs ?? 300_000));
    this.deferGate = spec.deferGate ?? false;
  }

  private readonly retry: RetrySpec | null;
  private readonly pathWindow: WindowSpec | null;

  run<T>(opts: RunOpts, fn: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    this.expireQueued(now);
    if (opts.deadlineAt !== undefined && opts.deadlineAt <= now) {
      return Promise.reject(new LimiterUnavailableError(this.api, 'queue-expired'));
    }

    const gateUntil = this.gate?.until ?? 0;
    const gateBlocked = this.gate?.blocked(now) ?? false;
    if (gateBlocked && !this.deferGate) {
      return Promise.reject(new Error(`${this.api} gated until ${new Date(gateUntil).toISOString()}`));
    }
    if (gateBlocked && !this.canWaitUntil(now, gateUntil, now, opts.deadlineAt)) {
      return Promise.reject(new LimiterUnavailableError(this.api, 'gate', gateUntil));
    }

    const priority = opts.priority ?? 1;
    const readyAt = this.readyAtFor(now, opts);
    const mustQueue = gateBlocked || this.queueLength > 0 || (this.sem?.full ?? false) || readyAt > now;
    if (mustQueue && this.queueLength >= this.queueMax && !this.makeRoom(priority, now)) {
      return Promise.reject(new LimiterUnavailableError(this.api, 'queue-full'));
    }
    if (mustQueue && !this.canWaitUntil(now, Math.max(readyAt, gateBlocked ? gateUntil : 0), now, opts.deadlineAt)) {
      return Promise.reject(new LimiterUnavailableError(this.api, 'queue-expired'));
    }

    return new Promise<T>((resolve, reject) => {
      this.queues[priority].push({
        priority,
        enqueuedAt: now,
        opts,
        fn: fn as () => Promise<unknown>,
        attempt: 0,
        notBefore: gateBlocked ? gateUntil : 0,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.kick();
    });
  }

  private get queueLength(): number {
    return this.queues.reduce((n, q) => n + q.length, 0);
  }

  private makeRoom(priority: Priority, now: number): boolean {
    let victim: Job | undefined;
    let victimQueue: Job[] | undefined;
    let victimIndex = -1;
    for (let p = priority + 1; p <= 2; p += 1) {
      const q = this.queues[p as Priority];
      for (let i = 0; i < q.length; i += 1) {
        const job = q[i];
        if (job === undefined || this.effectivePriority(job, now) <= priority) continue;
        if (victim === undefined || job.enqueuedAt < victim.enqueuedAt) {
          victim = job;
          victimQueue = q;
          victimIndex = i;
        }
      }
    }
    if (victim === undefined || victimQueue === undefined) return false;
    victimQueue.splice(victimIndex, 1);
    victim.reject(new LimiterUnavailableError(this.api, 'queue-full'));
    return true;
  }
  snapshot(): LimiterSnapshot {
    return {
      inFlight: this.sem?.count ?? 0,
      queued: this.queues.reduce((n, q) => n + q.length, 0),
      gateUntil: this.gate?.until ?? 0,
      windowUsed: (this.constraints.find((c) => c instanceof Window) as Window | undefined)?.used ?? 0,
    };
  }

  private effectivePriority(job: Job, now: number): Priority {
    if (job.priority === 0) return 0;
    const aged = now - job.enqueuedAt >= this.agingMs;
    return (aged ? job.priority - 1 : job.priority) as Priority;
  }

  private nextJob(now: number): Job | null {
    let best: Job | undefined;
    let bestEff = Number.POSITIVE_INFINITY;
    let bestQueue: Job[] | undefined;
    let bestIndex = -1;
    for (const q of this.queues) {
      for (let i = 0; i < q.length; i += 1) {
        const candidate = q[i];
        if (candidate === undefined) continue;
        const eff = this.effectivePriority(candidate, now);
        const last = this.lastCaller.get(eff);
        const bestIsLast = best !== undefined && (best.opts.caller ?? '') === last;
        const candidateIsLast = (candidate.opts.caller ?? '') === last;
        if (eff < bestEff || (eff === bestEff && bestIsLast && !candidateIsLast)) {
          best = candidate;
          bestEff = eff;
          bestQueue = q;
          bestIndex = i;
        }
      }
    }
    if (best === undefined || bestQueue === undefined) return null;
    bestQueue.splice(bestIndex, 1);
    this.lastCaller.set(bestEff as Priority, best.opts.caller ?? '');
    return best;
  }

  private pushBack(job: Job): void {
    this.queues[job.priority].push(job);
  }

  private canWaitUntil(now: number, until: number, enqueuedAt: number, deadlineAt?: number): boolean {
    if (until <= now) return true;
    const ageDeadline = enqueuedAt + this.queueMaxAgeMs;
    return until < ageDeadline && (deadlineAt === undefined || until < deadlineAt);
  }

  private expireQueued(now: number): void {
    for (const q of this.queues) {
      for (let i = q.length - 1; i >= 0; i -= 1) {
        const job = q[i];
        if (job === undefined) continue;
        const deadlineReached = job.opts.deadlineAt !== undefined && now >= job.opts.deadlineAt;
        const ageReached = now >= job.enqueuedAt + this.queueMaxAgeMs;
        if (!deadlineReached && !ageReached) continue;
        q.splice(i, 1);
        job.reject(job.lastError ?? new LimiterUnavailableError(this.api, 'queue-expired'));
      }
    }
  }

  private queueExpiryAt(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const q of this.queues) {
      for (const job of q) {
        earliest = Math.min(earliest, job.enqueuedAt + this.queueMaxAgeMs);
        if (job.opts.deadlineAt !== undefined) earliest = Math.min(earliest, job.opts.deadlineAt);
      }
    }
    return earliest;
  }

  private armAtOrExpiry(readyAt: number, now: number): void {
    const wakeAt = Math.min(readyAt, this.queueExpiryAt());
    if (!Number.isFinite(wakeAt)) return;
    this.arm(Math.max(1, wakeAt - now));
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  private readyAtFor(now: number, opts: RunOpts): number {
    let ready = now;
    for (const c of this.constraints) ready = Math.max(ready, c.readyAt(now, opts));
    if (this.pathWindow && opts.path) {
      const w = this.pathWindowFor(opts.path);
      ready = Math.max(ready, w.readyAt(now, opts));
    }
    return ready;
  }

  private pathWindowFor(path: string): Window {
    let w = this.paths.get(path);
    if (!w) {
      w = new Window(this.pathWindow!.max, this.pathWindow!.windowMs);
      this.paths.set(path, w);
    }
    return w;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      this.drain();
    } finally {
      this.draining = false;
    }
  }

  private drain(): void {
    let deferred = 0;
    for (;;) {
      const now = this.clock.now();
      this.expireQueued(now);
      if (this.sem?.full) {
        this.armAtOrExpiry(Number.POSITIVE_INFINITY, now);
        return;
      }
      const job = this.nextJob(now);
      if (job === null) {
        this.clearTimer();
        return;
      }
      if (this.gate?.blocked(now)) {
        const until = this.gate.until;
        if (this.deferGate && !this.canWaitUntil(now, until, job.enqueuedAt, job.opts.deadlineAt)) {
          job.reject(new LimiterUnavailableError(this.api, 'gate', until));
          continue;
        }
        job.notBefore = Math.max(job.notBefore, until);
        this.pushBack(job);
        this.armAtOrExpiry(until, now);
        return;
      }
      const readyAt = Math.max(this.readyAtFor(now, job.opts), job.notBefore);
      if (readyAt > now) {
        this.pushBack(job);
        deferred += 1;
        this.armAtOrExpiry(readyAt, now);
        if (deferred >= this.queueLength) return;
        continue;
      }
      deferred = 0;
      this.start(job);
    }
  }

  private start(job: Job): void {
    // Slots are stamped at DISPATCH time, not at scheduling time: a stale stamp evicts
    // before the real window expires, letting the actual request rate exceed the API
    // limit under load (surfaced as the 6-starts-in-1s integration.test.ts flake).
    const now = this.clock.now();
    for (const c of this.constraints) c.onStart(now, job.opts);
    if (this.pathWindow && job.opts.path) this.pathWindowFor(job.opts.path).onStart(now, job.opts);
    this.sem?.acquire();
    job
      .fn()
      .then(
        (v) => {
          this.sem?.release();
          job.resolve(v);
          this.kick();
        },
        (e) => {
          this.sem?.release();
          this.handleError(job, e);
        },
      );
  }

  private handleError(job: Job, e: unknown): void {
    const failedAt = this.clock.now();
    if (e instanceof HttpError) {
      this.gate?.note(e.status, e.header, failedAt);
      const retryable =
        e.status !== 400 &&
        e.status !== 401 &&
        e.status !== 403 &&
        this.retry !== null &&
        job.attempt < this.retry.retries &&
        (this.retry.path === undefined || this.retry.path === job.opts.path) &&
        this.retry.retryOn(e.status);
      if (retryable) {
        const attempt = job.attempt + 1;
        const retryAt = Math.max(failedAt + this.backoffDelay(attempt), this.gate?.until ?? 0);
        if (
          this.canWaitUntil(failedAt, retryAt, job.enqueuedAt, job.opts.deadlineAt) &&
          (this.queueLength < this.queueMax || this.makeRoom(job.priority, failedAt))
        ) {
          job.attempt = attempt;
          job.lastError = e;
          job.notBefore = retryAt;
          this.queues[job.priority].push(job);
          this.armAtOrExpiry(retryAt, failedAt);
          this.kick();
          return;
        }
      }
    }
    job.reject(e);
    this.kick();
  }

  private backoffDelay(attempt: number): number {
    const retry = this.retry!;
    let delay: number;
    if (retry.backoff === 'fibo') {
      let a = 1;
      let b = 1;
      for (let i = 1; i < attempt; i += 1) [a, b] = [b, a + b];
      delay = b * retry.baseMs;
    } else {
      delay = retry.baseMs * 2 ** (attempt - 1);
    }
    const jitterMs = retry.jitterMs ?? 0;
    if (jitterMs > 0) {
      const sample = (retry.random ?? Math.random)();
      delay += Math.floor(Math.min(1, Math.max(0, sample)) * jitterMs);
    }
    return Math.min(retry.capMs ?? Number.POSITIVE_INFINITY, delay);
  }

  private arm(ms: number): void {
    const due = this.clock.now() + Math.max(1, ms);
    if (this.timer !== null && this.timerAt !== null && this.timerAt <= due) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timerAt = due;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.timerAt = null;
      this.kick();
    }, due - this.clock.now());
  }
}
