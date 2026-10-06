// One series job per token, shared by first-add, chart fallback and sweeps.
// Service speed is governed by the gateway, never by the refresh TTL.
import type { Chain } from './shared/chain.js';

type Job = { priority: number; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };
const pending: Job[] = [];
const inFlight = new Map<string, Promise<void>>();
let running = false;
let urgentStreak = 0;

export function enqueueSetup(ca: string, chain: Chain, priority: number, run: () => Promise<void>): Promise<void> {
  const key = `${chain}:${ca}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const work = new Promise<void>((resolve, reject) => pending.push({ priority, run, resolve, reject }));
  const result = work.finally(() => { inFlight.delete(key); });
  inFlight.set(key, result);
  if (!running) {
    running = true;
    queueMicrotask(() => { void drain(); });
  }
  return result;
}

async function drain(): Promise<void> {
  while (pending.length > 0) {
    // After eight urgent jobs, service the oldest background job if any.
    let index = urgentStreak >= 8 ? pending.findIndex((job) => job.priority > 0) : -1;
    if (index < 0) index = pending.findIndex((job) => job.priority === 0);
    if (index < 0) index = 0;
    const [job] = pending.splice(index, 1);
    if (!job) continue;
    urgentStreak = job.priority === 0 ? urgentStreak + 1 : 0;
    try {
      await job.run();
      job.resolve();
    } catch (error) {
      job.reject(error);
    }
  }
  running = false;
  urgentStreak = 0;
}
