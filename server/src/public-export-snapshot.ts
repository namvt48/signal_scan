import { Worker } from 'node:worker_threads';
import type { PublicFomoToken, PublicToken } from './public-api-contract.js';

export interface PublicExportSnapshot {
  generatedAt: number;
  tokens: PublicToken[];
  fomoTokens: PublicFomoToken[];
  findToken(chain: string, ca: string): PublicToken | undefined;
  findFomoToken(chain: string, ca: string): PublicFomoToken | undefined;
}

interface WorkerSnapshot { generatedAt: number; tokens: PublicToken[]; fomoTokens: PublicFomoToken[] }

export class PublicExportSnapshotManager {
  private current: { snapshot: WorkerSnapshot; tokensByKey: Map<string, PublicToken>; fomoByKey: Map<string, PublicFomoToken> } | null = null;
  private refreshFlight: Promise<void> | null = null;
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly workerUrl = new URL(import.meta.url.endsWith('.ts') ? './public-export-snapshot-worker.ts' : './public-export-snapshot-worker.js', import.meta.url),
    private readonly refreshMs = 15_000,
    private readonly maxAgeMs = 60_000,
    private readonly timeoutMs = 55_000,
    private readonly now: () => number = Date.now,
  ) {
    if (![refreshMs, maxAgeMs, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError('snapshot timing bounds must be positive integers');
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.refreshMs);
    this.timer.unref();
    void this.refresh().catch(() => undefined);
  }

  async get(): Promise<PublicExportSnapshot> {
    if (this.stopped) throw new Error('snapshot manager stopped');
    this.start();
    if (!this.isReady()) await this.refresh();
    const cached = this.current;
    if (!cached || !this.isReady()) throw new Error('snapshot unavailable');
    return {
      ...cached.snapshot,
      findToken: (chain, ca) => cached.tokensByKey.get(`${chain}:${ca}`),
      findFomoToken: (chain, ca) => cached.fomoByKey.get(`${chain}:${ca}`),
    };
  }

  isReady(): boolean {
    return !this.stopped && this.current !== null && this.now() - this.current.snapshot.generatedAt < this.maxAgeMs;
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('snapshot manager stopped'));
    if (this.refreshFlight) return this.refreshFlight;
    const promise = this.loadSnapshot();
    this.refreshFlight = promise.catch((error: unknown) => {
      console.warn('[public-export] snapshot refresh failed', error instanceof Error ? error.name : 'unknown');
      throw error;
    }).finally(() => { this.refreshFlight = null; });
    return this.refreshFlight;
  }

  private loadSnapshot(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 384 } });
      this.worker = worker;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().then(() => {
          if (this.worker === worker) this.worker = null;
          if (error) reject(error); else resolve();
        }, reject);
      };
      const timer = setTimeout(() => finish(new Error('snapshot refresh timed out')), this.timeoutMs);
      worker.once('message', (value: unknown) => {
        if (settled) return;
        if (!validSnapshot(value) || value.generatedAt > this.now() || this.now() - value.generatedAt >= this.maxAgeMs) {
          finish(new Error('snapshot refresh returned invalid or expired data'));
          return;
        }
        this.current = {
          snapshot: value,
          tokensByKey: new Map(value.tokens.map((item) => [`${item.chain}:${item.ca}`, item])),
          fomoByKey: new Map(value.fomoTokens.map((item) => [`${item.chain}:${item.ca}`, item])),
        };
        finish();
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => finish(new Error(`snapshot worker exited before delivery (${code})`)));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    if (this.worker) await this.worker.terminate();
    await this.refreshFlight?.catch(() => undefined);
  }
}

function validSnapshot(value: unknown): value is WorkerSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const snapshot = value as Partial<WorkerSnapshot>;
  const validTokens = (tokens: unknown): tokens is PublicToken[] => Array.isArray(tokens) && tokens.every(
    (token: unknown) => token !== null && typeof token === 'object' &&
      typeof (token as PublicToken).chain === 'string' && typeof (token as PublicToken).ca === 'string',
  );
  return Number.isSafeInteger(snapshot.generatedAt) && (snapshot.generatedAt ?? 0) > 0 &&
    validTokens(snapshot.tokens) && validTokens(snapshot.fomoTokens);
}
