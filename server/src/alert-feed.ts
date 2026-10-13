import type { Chain } from './shared/chain.js';

export type AlertMetric = 'fresh' | 't100' | 'trackerBuy';

export interface AlertTrackedGroup {
  names: string[];
  total: number;
}

export interface AlertTrackedMetadata {
  count: number;
  wallets: AlertTrackedGroup;
  fomoUsers: AlertTrackedGroup;
}

export interface AlertMetricSnapshot {
  capturedAt: number;
  symbol: string | null;
  marketCap: number | null;
  marketCapAt: number | null;
  freshPct: number | null;
  t100Multiple: number | null;
  lf: number | null;
  trackedHoldingPct: number | null;
  /** Snapshot of the tracked wallet that made a priced BUY; absent on legacy and other metric rows. */
  trackerBuyer?: { name: string; address: string };
  /** Dashboard token decoration and tracked-user counts captured with the alert feed response. */
  iconUrl?: string;
  xHandle?: string;
  tracked?: AlertTrackedMetadata;
}

export interface AlertMetricObservation {
  id: number;
  ca: string;
  chain: Chain;
  metric: AlertMetric;
  value: number;
  responseAt: number;
  snapshot: AlertMetricSnapshot;
}
