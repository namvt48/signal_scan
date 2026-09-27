import { Limiter } from './limiter.js';
import type { ApiLimitSpec, LimiterSnapshot, Priority, Registry, RunOpts } from './types.js';

export class LimiterRegistry implements Registry {
  private readonly limiters = new Map<string, Limiter>();

  constructor(specs: Record<string, ApiLimitSpec>) {
    for (const [api, spec] of Object.entries(specs)) this.limiters.set(api, new Limiter(api, spec));
  }

  run<T>(api: string, opts: RunOpts, fn: () => Promise<T>): Promise<T> {
    const l = this.limiters.get(api);
    if (!l) return Promise.reject(new Error(`ratelimit: unknown api "${api}"`));
    return l.run(opts, fn);
  }

  snapshot(): Record<string, LimiterSnapshot> {
    const out: Record<string, LimiterSnapshot> = {};
    for (const [api, l] of this.limiters) out[api] = l.snapshot();
    return out;
  }
}

export type { Priority };
