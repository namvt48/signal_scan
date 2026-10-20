// One series job per token, shared by first-add, chart fallback and sweeps.
// Service speed is governed by the gateway, never by the refresh TTL.
import { log } from './log.js';
import type { Chain } from './shared/chain.js';

type Job = {
  id: number;
  ca: string;
  chain: Chain;
  key: string;
  priority: number;
  enqueuedAt: number;
  run: (signal: AbortSignal) => Promise<void>;
  timeoutMs: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};
const pending: Job[] = [];
const inFlight = new Map<string, { promise: Promise<void>; jobId: number }>();
let nextJobId = 1;
let running = false;
let urgentStreak = 0;

const DEFAULT_SETUP_JOB_TIMEOUT_MS = 30_000;

export function enqueueSetup(
  ca: string,
  chain: Chain,
  priority: number,
  run: (signal: AbortSignal) => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const key = `${chain}:${ca}`;
  const existing = inFlight.get(key);
  if (existing) {
    log.debug('[setup-queue] job joined', { jobId: existing.jobId, ca, chain });
    return existing.promise;
  }
  const jobId = nextJobId++;
  const enqueuedAt = Date.now();
  let job!: Job;
  const work = new Promise<void>((resolve, reject) => {
    job = { id: jobId, ca, chain, key, priority, enqueuedAt, run, timeoutMs: options.timeoutMs ?? DEFAULT_SETUP_JOB_TIMEOUT_MS, resolve, reject };
    pending.push(job);
  });
  const result = work.finally(() => { inFlight.delete(key); });
  inFlight.set(key, { promise: result, jobId });
  log.info('[setup-queue] job enqueued', { jobId, ca, chain, priority, queueDepth: pending.length, timeoutMs: job.timeoutMs });
  if (!running) {
    running = true;
    queueMicrotask(() => { void drain(); });
  }
  return result;
}

function timeoutError(): Error {
  return new Error('setup job timed out');
}

async function runBounded(job: Job): Promise<void> {
  const startedAt = Date.now();
  const waitMs = startedAt - job.enqueuedAt;
  log.info('[setup-queue] job started', { jobId: job.id, ca: job.ca, chain: job.chain, priority: job.priority, queueDepth: pending.length, waitMs, timeoutMs: job.timeoutMs });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      job.run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(timeoutError());
          reject(timeoutError());
        }, job.timeoutMs);
      }),
    ]);
    job.resolve();
    log.info('[setup-queue] job completed', { jobId: job.id, ca: job.ca, chain: job.chain, priority: job.priority, queueDepth: pending.length, waitMs, runMs: Date.now() - startedAt, timeoutMs: job.timeoutMs, outcome: 'success' });
  } catch (error) {
    controller.abort(error);
    job.reject(error);
    log.info('[setup-queue] job failed', { jobId: job.id, ca: job.ca, chain: job.chain, priority: job.priority, queueDepth: pending.length, waitMs, runMs: Date.now() - startedAt, timeoutMs: job.timeoutMs, outcome: timedOut ? 'timeout' : 'error' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function drain(): Promise<void> {
  while (pending.length > 0) {
    let index = urgentStreak >= 8 ? pending.findIndex((job) => job.priority > 0) : -1;
    if (index < 0) index = pending.findIndex((job) => job.priority === 0);
    if (index < 0) index = 0;
    const [job] = pending.splice(index, 1);
    if (!job) continue;
    urgentStreak = job.priority === 0 ? urgentStreak + 1 : 0;
    await runBounded(job);
  }
  running = false;
  urgentStreak = 0;
}
