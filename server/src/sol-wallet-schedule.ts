import { log } from './log.js';
import { runSolWalletSync } from './sol-wallet-sync.js';

export function msUntilNextUtcMidnight(now = Date.now()): number {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return next - now;
}

export interface SolWalletScheduleOptions {
  now?: () => number;
  run?: () => Promise<unknown>;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Arms the first run for the next UTC midnight; returned stop function clears the timer. */
export function startSolWalletSync(options: SolWalletScheduleOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const run = options.run ?? runSolWalletSync;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (delay = msUntilNextUtcMidnight(now())) => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      void run().catch((error: unknown) => log.error('[sol-wallet-sync] scheduled run failed', error)).finally(() => arm());
    }, delay);
    timer.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
}
