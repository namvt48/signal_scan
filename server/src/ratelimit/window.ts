import type { Constraint, RunOpts } from './types.js';

export class Window implements Constraint {
  private readonly ts: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private evict(now: number): void {
    while (this.ts.length > 0 && this.ts[0] + this.windowMs <= now) this.ts.shift();
  }

  readyAt(now: number, _opts: RunOpts): number {
    this.evict(now);
    if (this.ts.length < this.max) return now;
    return this.ts[0] + this.windowMs;
  }

  onStart(now: number, _opts: RunOpts): void {
    this.evict(now);
    this.ts.push(now);
  }

  get used(): number {
    return this.ts.length;
  }
}
