// Runtime-adjustable Nansen factor thresholds — the three gates that decide the
// X/3 score in signals.ts, plus the USD entry-size gate that skips small CAs.
// Defaults come from config.ts (env-tunable at process start); overrides persist
// in the settings table and are read per call, so a PUT /api/settings takes
// effect on the next /api/signals without a restart.

import { FRESH_MIN_PCT, LF_MAX, LF_MIN, MAX_MC, MIN_MC, MIN_USD, T100_MIN_MULTIPLE } from './config.js';
import { getSetting, setSetting } from './db.js';

/** Score gates: fresh % min, t100 genesis→trough multiple min, LF absolute band [lfMin, lfMax] — plus the minUsd entry-size gate and the [minMc, maxMc] market-cap band. */
export interface NansenThresholds {
  freshMinPct: number;
  t100MinMultiple: number;
  lfMin: number;
  lfMax: number;
  minUsd: number;
  /** USD market-cap floor; a known market_cap below it drops the row (0 = gate off). */
  minMc: number;
  /** USD market-cap ceiling; above it drops the row. `-1` (or a legacy `0`) = no cap / unbounded above. */
  maxMc: number;
}

export const THRESHOLD_KEYS: readonly (keyof NansenThresholds)[] = ['freshMinPct', 't100MinMultiple', 'lfMin', 'lfMax', 'minUsd', 'minMc', 'maxMc'];

/**
 * Per-key PUT validation: freshMinPct stays 0..100; t100MinMultiple >= 1 (a
 * multiple below 1 means the top-100 cohort GREW — not a decrease); maxMc is
 * finite >= -1 (-1 = no cap sentinel); lfMin / lfMax / minUsd / minMc are
 * absolute values — finite >= 0, no upper bound.
 */
export function isThresholdValueFor(key: keyof NansenThresholds, v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (key === 'freshMinPct') return v >= 0 && v <= 100;
  if (key === 't100MinMultiple') return v >= 1;
  if (key === 'maxMc') return v >= -1;
  return v >= 0;
}

/** Per-key validation error text — mirrors isThresholdValueFor. */
export function thresholdValueError(key: keyof NansenThresholds): string {
  if (key === 'freshMinPct') return `${key} must be a finite number between 0 and 100`;
  if (key === 't100MinMultiple') return `${key} must be a finite number >= 1`;
  if (key === 'maxMc') return `${key} must be a finite number >= -1 (-1 = no cap)`;
  return `${key} must be a finite number >= 0`;
}

/** Defaults from config.ts constants — also the FE "reset" target. */
export function thresholdDefaults(): NansenThresholds {
  return {
    freshMinPct: FRESH_MIN_PCT,
    t100MinMultiple: T100_MIN_MULTIPLE,
    lfMin: LF_MIN,
    lfMax: LF_MAX,
    minUsd: MIN_USD,
    minMc: MIN_MC,
    maxMc: MAX_MC,
  };
}

/** Defaults overridden by persisted settings; unparseable values fall back to the default. */
export function getThresholds(): NansenThresholds {
  const out = thresholdDefaults();
  for (const key of THRESHOLD_KEYS) {
    const n = Number(getSetting(key));
    if (Number.isFinite(n)) out[key] = n;
  }
  // Legacy persisted rows may hold maxMc="0" (the pre-2026-09-21 off sentinel); normalize to -1 so the cap-off state always surfaces as -1.
  if (out.maxMc <= 0) out.maxMc = -1;
  return out;
}

/**
 * Validate (all-or-nothing), then persist ONLY the provided keys and return the
 * new effective set. Absent keys keep their current value. Stale pre-2026-09-17
 * rows (t100MinPct/lfMaxPct) are not in THRESHOLD_KEYS → never read, never written.
 */
export function updateThresholds(patch: Partial<NansenThresholds>): NansenThresholds | { error: string } {
  for (const key of THRESHOLD_KEYS) {
    const v: unknown = patch[key];
    if (v !== undefined && !isThresholdValueFor(key, v)) {
      return { error: thresholdValueError(key) };
    }
  }
  const next = getThresholds();
  for (const key of THRESHOLD_KEYS) {
    const v = patch[key];
    if (v === undefined) continue;
    next[key] = v;
  }
  // Band pair checks: only when the patch touches either edge AND the merged result is inverted.
  if ((patch.lfMin !== undefined || patch.lfMax !== undefined) && next.lfMin > next.lfMax) {
    return { error: `lfMin (${next.lfMin}) must be <= lfMax (${next.lfMax})` };
  }
  // Market cap differs from the LF band: -1 means the ceiling is OFF (unbounded), not a
  // real cap, so an inverted band is only an error once the ceiling is genuinely armed (> 0).
  if ((patch.minMc !== undefined || patch.maxMc !== undefined) && next.minMc > 0 && next.maxMc > 0 && next.minMc > next.maxMc) {
    return { error: `minMc (${next.minMc}) must be <= maxMc (${next.maxMc})` };
  }
  for (const key of THRESHOLD_KEYS) {
    const v = patch[key];
    if (v === undefined) continue;
    setSetting(key, String(v));
  }
  return next;
}

// --- debug: allFactors flag (a SEPARATE concern from the numeric thresholds
// above — when true, signals emits gate-failing factors that still have a value).

export const DEBUG_ALL_FACTORS_KEY = 'allFactors';

/** Read the `allFactors` debug flag; absent or anything but '1' → false. */
export function getDebugAllFactors(): boolean {
  return getSetting(DEBUG_ALL_FACTORS_KEY) === '1';
}

/** Persist the `allFactors` debug flag as '1'/'0'. */
export function setDebugAllFactors(on: boolean): void {
  setSetting(DEBUG_ALL_FACTORS_KEY, on ? '1' : '0');
}

/** Full GET/PUT /api/settings response shape (frozen FE contract: values + defaults + debug). */
export interface SettingsResponse {
  values: NansenThresholds;
  defaults: NansenThresholds;
  debug: { allFactors: boolean };
}

/** Build the /api/settings response from a values set (defaults + current debug flag). */
export function settingsResponse(values: NansenThresholds): SettingsResponse {
  return { values, defaults: thresholdDefaults(), debug: { allFactors: getDebugAllFactors() } };
}
