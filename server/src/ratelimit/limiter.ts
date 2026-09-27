import { Bucket } from './bucket.js';
import { Window } from './window.js';
import { MinInterval } from './min-interval.js';
import { Semaphore } from './semaphore.js';
import { Gate } from './gate.js';
import { HttpError, type ApiLimitSpec, type Constraint, type Limiter as ILimiter, type LimiterSnapshot, type Priority, type RunOpts } from './types.js';

interface Job {
  priority: Priority;
  enqueuedAt: number;
  opts: RunOpts;
  fn: () => Promise<unknown>;
  attempt: number;
  notBefore: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
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
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

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
  }

  private readonly retry;
  private readonly pathWindow;

  run<T>(opts: RunOpts, fn: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    if (this.gate?.blocked(now)) {
      return Promise.reject(new Error(`${this.api} gated until ${new Date(this.gate.until).toISOString()}`));
    }
    return new Promise<T>((resolve, reject) => {
      const priority = opts.priority ?? 1;
      this.queues[priority].push({
        priority,
        enqueuedAt: now,
        opts,
        fn: fn as () => Promise<unknown>,
        attempt: 0,
        notBefore: 0,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.kick();
    });
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
    let best: Job | null = null;
    let bestEff = Number.POSITIVE_INFINITY;
    for (const q of this.queues) {
      if (q.length === 0) continue;
      const eff = this.effectivePriority(q[0], now);
      if (eff < bestEff) {
        bestEff = eff;
        best = q[0];
      }
    }
    if (best) this.queues[best.priority].shift();
    return best;
  }

  private pushBack(job: Job): void {
    this.queues[job.priority].unshift(job);
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
    for (;;) {
      const now = this.clock.now();
      const job = this.nextJob(now);
      if (!job) return;
      const readyAt = Math.max(this.readyAtFor(now, job.opts), job.notBefore);
      if (readyAt > now) {
        this.pushBack(job);
        this.arm(readyAt - now);
        return;
      }
      if (this.sem?.full) {
        this.pushBack(job);
        return; // kick() is called again on release
      }
      this.start(job, now);
    }
  }

  private start(job: Job, now: number): void {
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
          this.handleError(job, e, now);
        },
      );
  }

  private handleError(job: Job, e: unknown, now: number): void {
    if (e instanceof HttpError) {
      this.gate?.note(e.status, e.header, now);
      if (this.gate?.blocked(now)) {
        // the call that TRIGGERED the ban surfaces its real error; only the calls that follow
        // get the constant `${api} gated until <ISO>` message (run()'s pre-flight) for log dedupe.
        job.reject(e);
        this.kick();
        return;
      }
      if (this.retry && job.attempt < this.retry.retries && this.retry.retryOn(e.status)) {
        job.attempt++;
        const delay = this.backoffDelay(job.attempt);
        job.notBefore = now + delay;
        this.queues[job.priority].push(job); // rejoin at the BACK so the backoff does not block peers
        this.arm(delay);
        this.kick();
        return;
      }
    }
    job.reject(e);
    this.kick();
  }

  private backoffDelay(attempt: number): number {
    const r = this.retry!;
    if (r.backoff === 'fibo') {
      let a = 1;
      let b = 1;
      for (let i = 1; i < attempt; i++) [a, b] = [b, a + b];
      return b * r.baseMs;
    }
    return Math.min(r.capMs ?? Number.POSITIVE_INFINITY, r.baseMs * 2 ** (attempt - 1));
  }

  private arm(ms: number): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(1, ms));
  }
}
