import type { Chain } from './shared/chain.js';
import type { TokenSignal } from './signals.js';
import type { PeriodicScanSettings } from './periodic-scan-settings.js';

export interface PeriodicScanItem {
  chain: Chain;
  ca: string;
  symbol?: string;
  marketCap?: number;
  iconUrl?: string;
  xHandle?: string;
  nansen: {
    freshCurrent: boolean;
    freshUpdatedAt?: number;
    t100?: { multiple?: number };
    lf?: number;
    fresh?: number;
    rawFresh?: number;
  };
  volume24h: number;
  trackedHolding: number;
}


export function selectPeriodicScanSignals(
  signals: readonly TokenSignal[],
  settings: PeriodicScanSettings,
): TokenSignal[] {
  if (!settings.enabled) return [];
  return signals.filter((signal) => {
    const lowFloat = signal.nansen.lf;
    return signal.dataUpdatedAt?.volume24h !== undefined &&
      Number.isFinite(signal.volume24h) &&
      lowFloat !== undefined &&
      Number.isFinite(lowFloat) &&
      signal.volume24h < settings.maxVolume24hUsd &&
      lowFloat < settings.maxLowFloatTokens;
  });
}

export function toPeriodicScanItem(signal: TokenSignal): PeriodicScanItem {
  return {
    chain: signal.chain,
    ca: signal.ca,
    ...(signal.symbol !== undefined ? { symbol: signal.symbol } : {}),
    ...(signal.marketCap !== undefined ? { marketCap: signal.marketCap } : {}),
    ...(signal.iconUrl !== undefined ? { iconUrl: signal.iconUrl } : {}),
    ...(signal.xHandle !== undefined ? { xHandle: signal.xHandle } : {}),
    nansen: {
      freshCurrent: signal.nansen.freshCurrent,
      ...(signal.nansen.freshUpdatedAt !== undefined ? { freshUpdatedAt: signal.nansen.freshUpdatedAt } : {}),
      ...(signal.nansen.t100 !== undefined ? { t100: signal.nansen.t100 } : {}),
      ...(signal.nansen.lf !== undefined ? { lf: signal.nansen.lf } : {}),
      ...(signal.nansen.fresh !== undefined ? { fresh: signal.nansen.fresh } : {}),
      ...(signal.nansen.rawFresh !== undefined ? { rawFresh: signal.nansen.rawFresh } : {}),
    },
    volume24h: signal.volume24h,
    trackedHolding: signal.trackedHolding,
  };
}
