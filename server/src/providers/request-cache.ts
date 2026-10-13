export interface RequestCacheOptions {
  now?: () => number;
  maxEntries?: number;
  maxInflight?: number;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Per-process TTL cache and single-flight for safe, read-only provider requests. */
export class RequestCache {
  private readonly values = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxInflight: number;
  private hits = 0;
  private misses = 0;
  private joined = 0;

  constructor(options: RequestCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxInflight = options.maxInflight ?? 256;
  }

  async run<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    shouldCache: (value: T) => boolean = () => true,
  ): Promise<T> {
    const cached = this.values.get(key) as CacheEntry<T> | undefined;
    if (cached !== undefined) {
      if (cached.expiresAt > this.now()) {
        this.hits += 1;
        return cached.value;
      }
      this.values.delete(key);
    }
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending !== undefined) {
      this.joined += 1;
      return pending;
    }
    this.misses += 1;
    if (this.inflight.size >= this.maxInflight) return load();

    const promise = Promise.resolve().then(load).then((value) => {
      if (ttlMs > 0 && this.maxEntries > 0 && shouldCache(value)) {
        while (this.values.size >= this.maxEntries) {
          const oldest = this.values.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.values.delete(oldest);
        }
        this.values.set(key, { expiresAt: this.now() + ttlMs, value });
      }
      return value;
    }).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.values.clear();
    this.inflight.clear();
    this.hits = 0;
    this.misses = 0;
    this.joined = 0;
  }

  stats(): { hits: number; misses: number; joined: number; size: number; inflight: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      joined: this.joined,
      size: this.values.size,
      inflight: this.inflight.size,
    };
  }
}

export const providerRequestCache = new RequestCache();
