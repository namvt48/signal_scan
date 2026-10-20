import type { Chain } from './shared/chain.js';
import type { Tier } from './shared/tier.js';

export interface HistoryPoint { t: number; value: number }
export interface PublicToken {
  id: string;
  ca: string;
  chain: Chain;
  symbol: string | null;
  tier: Tier | null;
  market: {
    price: number | null;
    marketCap: number | null;
    holders: number | null;
    volume24h: number | null;
    volume1h: number | null;
    buyVol24h: number | null;
    sellVol24h: number | null;
    dataUpdatedAt: { marketCap: number | null; volume24h: number | null; holders: number | null };
  };
  metrics: {
    score: number;
    pass: { fresh: boolean; t100: boolean; lf: boolean };
    fresh: number | null;
    freshCurrent: boolean;
    freshUpdatedAt: number | null;
    t100: { pct: number; multiple: number | null } | null;
    lf: number | null;
  };
  history: { marketCap: HistoryPoint[]; holders: HistoryPoint[]; fresh: HistoryPoint[]; t100: HistoryPoint[] };
}
export interface PublicSnapshot { generatedAt: number; tokens: PublicToken[] }
export interface PublicWallet { id: string; address: string; chain: Chain; name: string; tags: string[]; clan: string | null }
export interface PublicTrade {
  id: number; walletId: string; ca: string; chain: Chain; ts: number;
  side: 'buy' | 'sell'; amountUsd: number | null; price: number | null; tx: string | null;
}
export interface PublicActivity {
  chain: Chain; ca: string; from: number; to: number;
  buys: number; sells: number; buyUsd: number; sellUsd: number; netInflowUsd: number;
}
export interface PublicAlert {
  id: number; ca: string; chain: Chain; metric: 'fresh' | 't100' | 'trackerBuy';
  value: number; responseAt: number;
  snapshot: { capturedAt: number; symbol: string | null; marketCap: number | null; marketCapAt: number | null; freshPct: number | null; t100Multiple: number | null; lf: number | null };
}
export interface TradePage { data: PublicTrade[]; nextId: number | null }
export interface AlertPage {
  data: PublicAlert[]; nextId: number; oldestAvailableId: number | null;
  /** True when a non-zero cursor predates the archive's retained range. */
  gap: boolean;
}
