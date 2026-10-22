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
  /** Visible holder count when the observation was captured. */
  holders?: number | null;
  /** Earliest observed T100 multiple for this CA, used as the growth baseline. */
  t100First?: number | null;
  lf: number | null;
  trackedHoldingPct: number | null;
  /** Snapshot of the buyer for trackerBuy: wallet address for tracked wallets, handle-only for FOMO users. */
  trackerBuyer?: { name: string; address?: string };
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
