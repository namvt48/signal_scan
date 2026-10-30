interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Two boolean modes only; cache an assembled response briefly across requests. */
export function createSignalResponseCache<T>(ttlMs = 1_000) {
  const entries = new Map<boolean, CacheEntry<T>>();
  const refreshing = new Set<boolean>();

  const get = (key: boolean, build: () => T, now = Date.now()): T => {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = build();
    entries.set(key, { expiresAt: now + ttlMs, value });
    return value;
  };

  return {
    get,
    /**
     * Stale-while-revalidate. An expired entry is returned immediately and
     * rebuilt on the next tick, so the multi-second assembleSignals pass never
     * blocks the request that discovers the expiry. A missing entry still
     * builds synchronously (cold start, or after invalidate()).
     */
    getStale(key: boolean, build: () => T, now = Date.now()): T {
      const hit = entries.get(key);
      if (!hit) return get(key, build, now);
      if (hit.expiresAt <= now && !refreshing.has(key)) {
        refreshing.add(key);
        const timer = setTimeout(() => {
          try {
            entries.set(key, { value: build(), expiresAt: Date.now() + ttlMs });
          } catch {
            // Keep serving the last good snapshot; the next request retries.
          } finally {
            refreshing.delete(key);
          }
        }, 0);
        timer.unref?.();
      }
      return hit.value;
    },
    invalidate(): void {
      entries.clear();
      refreshing.clear();
    },
  };
}
