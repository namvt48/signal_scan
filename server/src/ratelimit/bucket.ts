import type { Constraint, RunOpts } from './types.js';

export class Bucket implements Constraint {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly defaultWeight: number,
    now = 0,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private need(opts: RunOpts): number {
    return Math.min(opts.weight ?? this.defaultWeight, this.capacity);
  }

  readyAt(now: number, opts: RunOpts): number {
    const n = this.need(opts);
    const avail = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    if (avail >= n) return now;
    return now + Math.ceil(((n - avail) / this.refillPerSec) * 1000);
  }

  onStart(now: number, opts: RunOpts): void {
    const n = this.need(opts);
    const avail = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.tokens = Math.max(0, avail - n);
    this.last = now;
  }
}
