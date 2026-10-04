// GMGN multi-key pool (gateway-only). GMGN meters by plan weight per ACCOUNT and
// arms its 429 gate PER KEY, so a pool of keys from separate accounts multiplies
// capacity only if each key is governed by its OWN limiter. This module owns the
// selection: gate-aware round-robin over the per-key limiters, plus a health latch
// that parks a key which keeps answering 401 AUTH_INVALID (a revoked/expired key
// must not silently burn a call on every sweep and leave the row NULL).

import type { UpstreamFetch } from './contract.js';

export interface GmgnKey {
  readonly apiKey: string;
  readonly limiterKey: string;
  readonly weight: number;
}

export interface GmgnKeyPoolDeps {
  keys: readonly GmgnKey[];
  fetcherFor: (apiKey: string) => UpstreamFetch;
  gateUntilOf: (limiterKey: string) => number;
  now?: () => number;
  authFailThreshold?: number;
  downCooldownMs?: number;
  log?: (line: string) => void;
}

export interface GmgnKeyPick {
  index: number;
  limiterKey: string;
  upstream: UpstreamFetch;
}

export interface GmgnKeyStat {
  limiterKey: string;
  weight: number;
  served: number;
  authFails: number;
  downUntil: number;
}

export class GmgnKeyPool {
  private readonly keys: readonly GmgnKey[];
  private readonly upstreams: readonly UpstreamFetch[];
  private readonly gateUntilOf: (limiterKey: string) => number;
  private readonly nowFn: () => number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly logFn: (line: string) => void;
  private readonly served: number[];
  private readonly authFails: number[];
  private readonly downUntil: number[];
  private cursor = 0;

  constructor(deps: GmgnKeyPoolDeps) {
    this.keys = deps.keys;
    this.upstreams = deps.keys.map((k) => deps.fetcherFor(k.apiKey));
    this.gateUntilOf = deps.gateUntilOf;
    this.nowFn = deps.now ?? Date.now;
    this.threshold = deps.authFailThreshold ?? 3;
    this.cooldownMs = deps.downCooldownMs ?? 600_000;
    this.logFn = deps.log ?? (() => {});
    this.served = deps.keys.map(() => 0);
    this.authFails = deps.keys.map(() => 0);
    this.downUntil = deps.keys.map(() => 0);
  }

  get size(): number {
    return this.keys.length;
  }

  /**
   * Gate-aware round-robin: the next key whose per-key 429/403 gate is open AND that
   * is not parked `down` by repeated 401s. Advancing the cursor past the chosen key
   * spreads load evenly so no single account is exhausted first. null = all unavailable.
   */
  pick(): GmgnKeyPick | null {
    const now = this.nowFn();
    const n = this.keys.length;
    for (let i = 0; i < n; i++) {
      const index = (this.cursor + i) % n;
      if (this.available(index, now)) {
        this.cursor = (index + 1) % n;
        return { index, limiterKey: this.keys[index].limiterKey, upstream: this.upstreams[index] };
      }
    }
    return null;
  }

  /** Earliest instant any key becomes pickable — the honest `x-gateway-gated-until`. */
  nextAvailableAt(): number {
    const now = this.nowFn();
    let earliest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.keys.length; i++) {
      const ready = Math.max(this.downUntil[i], this.gateUntilOf(this.keys[i].limiterKey));
      if (ready < earliest) earliest = ready;
    }
    return Number.isFinite(earliest) ? Math.max(earliest, now) : now;
  }

  /**
   * Feed one upstream outcome back. 2xx clears the 401 streak; a 401 advances it and
   * parks the key `down` once the threshold is reached. 429/403 are the limiter's own
   * gate to arm (per key), so nothing is tracked here for them.
   */
  record(index: number, status: number): void {
    if (status >= 200 && status < 300) {
      this.served[index] += 1;
      this.authFails[index] = 0;
      this.downUntil[index] = 0;
      return;
    }
    if (status !== 401) return;
    this.authFails[index] += 1;
    if (this.authFails[index] < this.threshold) return;
    this.downUntil[index] = this.nowFn() + this.cooldownMs;
    this.logFn(
      `[gmgn-keys] key ${index} (${this.keys[index].limiterKey}) DOWN ${this.cooldownMs}ms after ${this.authFails[index]}x401`,
    );
  }

  stats(): GmgnKeyStat[] {
    return this.keys.map((k, i) => ({
      limiterKey: k.limiterKey,
      weight: k.weight,
      served: this.served[i],
      authFails: this.authFails[i],
      downUntil: this.downUntil[i],
    }));
  }

  private available(index: number, now: number): boolean {
    return this.downUntil[index] <= now && this.gateUntilOf(this.keys[index].limiterKey) <= now;
  }
}
