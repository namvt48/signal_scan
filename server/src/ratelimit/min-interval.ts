import type { Constraint, RunOpts } from './types.js';

export class MinInterval implements Constraint {
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number) {}

  readyAt(_now: number, _opts: RunOpts): number {
    // ponytail: clamp -Infinity (never started) to 0 so "first is free"; Math.max in the limiter handles now
    return Math.max(0, this.lastStart + this.intervalMs);
  }

  onStart(now: number, _opts: RunOpts): void {
    this.lastStart = now;
  }
}
