import { getSetting, setSetting } from './db.js';

export const PERIODIC_SCAN_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

export interface PeriodicScanSettings {
  enabled: boolean;
  intervalHours: number;
  maxVolume24hUsd: number;
  maxLowFloatTokens: number;
}

export const DEFAULT_PERIODIC_SCAN_SETTINGS: PeriodicScanSettings = {
  enabled: true,
  intervalHours: 6,
  maxVolume24hUsd: 300_000,
  maxLowFloatTokens: 69_000_000,
};

export function getPeriodicScanSettings(): PeriodicScanSettings {
  const defaults = DEFAULT_PERIODIC_SCAN_SETTINGS;
  const enabled = getSetting('periodicScan.enabled');
  const intervalHours = Number(getSetting('periodicScan.intervalHours'));
  const maxVolume24hUsd = Number(getSetting('periodicScan.maxVolume24hUsd'));
  const maxLowFloatTokens = Number(getSetting('periodicScan.maxLowFloatTokens'));
  return {
    enabled: enabled === undefined ? defaults.enabled : enabled === 'true',
    intervalHours: (PERIODIC_SCAN_INTERVAL_HOURS as readonly number[]).includes(intervalHours)
      ? intervalHours
      : defaults.intervalHours,
    maxVolume24hUsd: Number.isFinite(maxVolume24hUsd) && maxVolume24hUsd >= 0
      ? maxVolume24hUsd
      : defaults.maxVolume24hUsd,
    maxLowFloatTokens: Number.isFinite(maxLowFloatTokens) && maxLowFloatTokens >= 0
      ? maxLowFloatTokens
      : defaults.maxLowFloatTokens,
  };
}

export function updatePeriodicScanSettings(raw: unknown): PeriodicScanSettings | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'body must be a JSON object' };
  }
  const values = raw as Record<string, unknown>;
  const keys = ['enabled', 'intervalHours', 'maxVolume24hUsd', 'maxLowFloatTokens'] as const;
  if (Object.keys(values).some((key) => !(keys as readonly string[]).includes(key))) {
    return { error: 'unknown periodic scan setting' };
  }
  if (typeof values.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
  if (typeof values.intervalHours !== 'number' ||
      !(PERIODIC_SCAN_INTERVAL_HOURS as readonly number[]).includes(values.intervalHours)) {
    return { error: `intervalHours must be one of ${PERIODIC_SCAN_INTERVAL_HOURS.join(', ')}` };
  }
  for (const key of ['maxVolume24hUsd', 'maxLowFloatTokens'] as const) {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { error: `${key} must be a finite number >= 0` };
    }
  }
  setSetting('periodicScan.enabled', String(values.enabled));
  setSetting('periodicScan.intervalHours', String(values.intervalHours));
  setSetting('periodicScan.maxVolume24hUsd', String(values.maxVolume24hUsd));
  setSetting('periodicScan.maxLowFloatTokens', String(values.maxLowFloatTokens));
  return getPeriodicScanSettings();
}

