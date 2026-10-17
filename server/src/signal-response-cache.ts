interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Two boolean modes only; cache an assembled response briefly across requests. */
export function createSignalResponseCache<T>(ttlMs = 1_000) {
  const entries = new Map<boolean, CacheEntry<T>>();

  return {
    get(key: boolean, build: () => T, now = Date.now()): T {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now) return hit.value;

      const value = build();
      entries.set(key, { expiresAt: now + ttlMs, value });
      return value;
    },
    invalidate(): void {
      entries.clear();
    },
  };
}
