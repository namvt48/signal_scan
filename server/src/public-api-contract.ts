import type { Chain } from './shared/chain.js';
import type { Tier } from './shared/tier.js';

export interface HistoryPoint { t: number; value: number }
export interface T100HistoryPoint extends HistoryPoint { peakBalance?: number; troughBalance?: number }
export interface BalanceRange { peak: number; trough: number }
export interface PublicToken {
  id: string;
  ca: string;
  chain: Chain;
  symbol: string | null;
  tier: Tier | null;
  /** Token avatar path, relative to the API origin. */
  iconUrl: string | null;
  /** X (Twitter) handle without '@'. */
  xHandle: string | null;
  market: {
    price: number | null;
    marketCap: number | null;
    holders: number | null;
    volume24h: number | null;
    volume1h: number | null;
    buyVol24h: number | null;
    sellVol24h: number | null;
    dataUpdatedAt: { marketCap: number | null; volume24h: number | null; holders: number | null; fresh: number | null; symbol: number | null; icon: number | null };
  };
  metrics: {
    score: number;
    pass: { fresh: boolean; t100: boolean; lf: boolean };
    /** Gated Fresh-wallet supply percentage emitted by the dashboard; null when the factor is hidden. */
    fresh: number | null;
    /** Ungated measured Fresh-wallet supply percentage. */
    rawFresh: number | null;
    freshCurrent: boolean;
    freshUpdatedAt: number | null;
    t100: { pct: number; multiple: number | null } | null;
    lf: number | null;
    /** Tracked-wallet holding as a percentage of token supply. */
    trackedHolding: number;
    /** Net USD tracked wallets put in over the trailing 24h (buys − sells); may be negative. */
    trackedInflow: number;
    /** Newest tracked watch trade timestamp (epoch ms); 0 = no tracked activity yet. */
    trackedActivityAt: number;
  };
  /** Balance-distribution extremes per lookback window; null when no snapshot data exists. */
  balanceRange: { d1: BalanceRange | null; d7: BalanceRange | null; d30: BalanceRange | null } | null;
  history: { marketCap: HistoryPoint[]; holders: HistoryPoint[]; fresh: HistoryPoint[]; t100: T100HistoryPoint[] };
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
  snapshot: {
    capturedAt: number; symbol: string | null; marketCap: number | null; marketCapAt: number | null;
    freshPct: number | null; t100Multiple: number | null; lf: number | null; trackedHoldingPct: number | null;
    iconUrl: string | null; xHandle: string | null;
  };
}
export interface PublicTop100Holder {
  address: string;
  percentOwnership: number;
  balance: number;
  balanceUsd: number;
  addrType: number;
  isNew: boolean;
  chg24h: number | null;
  name: string | null;
}
export interface PublicTokenDetail {
  ca: string;
  chain: Chain;
  price: number;
  supply: number;
  holders: number;
  freshSupplyPct: number | null;
  top100SupplyPct: number | null;
  medianHolderAmount: number | null;
  medianHolderUsd: number | null;
  top100: PublicTop100Holder[];
  snapshotAt: number | null;
}
export interface PublicBalancePoint { t: number; total: number; totalUsd: number | null; holders: number | null; inflow: number | null }
export interface PublicBalanceSeries { source: 'nansen' | 'snapshots'; points: PublicBalancePoint[]; cachedAt: number | null }
export interface PublicFomoUser {
  id: string;
  /** FOMO handle — the identity the alert stream matches on. */
  handle: string;
  name: string;
  tags: string[];
  clan: string | null;
  userId: string | null;
  walletSolana: string | null;
  walletEvm: string | null;
  source: string;
}
export interface PublicFomoUserStat {
  handle: string;
  name?: string;
  tags?: string[];
  clan?: string;
  /** Trailing-24h BUY spend; null when any in-window BUY amount is unresolved. */
  buyUsd: number | null;
  /** Trailing-24h SELL gross proceeds; null when any in-window SELL amount is unresolved. */
  sellUsd: number | null;
  buys: number;
  sells: number;
  trades: number;
  /** Newest trade timestamp (epoch ms); 0 when only the position row proves membership. */
  lastTs: number;
  holdingAmount?: number;
  /** Position value ÷ market cap × 100. */
  holdingPct?: number;
  balUsd?: number;
}
export interface PublicFomoTrade {
  id: number;
  userId: string;
  handle: string;
  eventId: string;
  ca: string;
  chain: Chain;
  side: 'buy' | 'sell';
  /** Type-dependent: post-fill position value for a buy, signed realised PnL for a sell. */
  usdValue: number | null;
  /** USD actually traded (both directions); the only basis for a Buy-$ sum. */
  tradeUsd: number | null;
  price: number | null;
  token: string | null;
  ts: number;
  source: string;
}
export interface PublicFomoHolding {
  source: 'api' | 'rpc';
  amount: number | null;
  pct: number | null;
  capturedAt: number;
  /** RPC measurements only: the wallet that produced the row. */
  wallet?: string;
}
export interface PublicFomoPosition {
  ca: string;
  chain: Chain;
  tradeId: string | null;
  status: string | null;
  amount: number | null;
  /** Money actually spent, not the alert's mark-to-market value. */
  costBasisUsd: number | null;
  avgEntryPrice: number | null;
  priceUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  fetchedAt: number;
  /** Stored balance measurements for the same (user, ca, chain). */
  holdings: PublicFomoHolding[];
}
/** A FOMO-instance token: the same shape as `PublicToken` plus the FOMO table. */
export interface PublicFomoToken extends PublicToken {
  /** Per-token FOMO watch-list stats — the dashboard's FOMO sub-table. */
  fomoUsers: PublicFomoUserStat[];
}
export interface PublicFomoBalanceFreshness {
  /** When the FOMO API balance refresh last ran. */
  checkedAt: number;
  /** When the upstream balance snapshot was captured; null when unknown. */
  capturedAt: number | null;
  /** False when the FOMO API returned a partial balance list. */
  complete: boolean;
  /** True when the upstream row cap truncated the balance list. */
  truncated: boolean;
  /** False when the user's balances could not be read at all. */
  available: boolean;
}
export interface PublicFomoFreshness {
  /** Balance-refresh metadata; null when never refreshed. */
  balances: PublicFomoBalanceFreshness | null;
  /** Position-refresh metadata; null when never refreshed. */
  positions: { checkedAt: number } | null;
}
export interface PublicFomoPositionsPage {
  data: PublicFomoPosition[];
  freshness: PublicFomoFreshness;
}
export interface TradePage { data: PublicTrade[]; nextId: number | null }
export interface AlertPage {
  data: PublicAlert[]; nextId: number; oldestAvailableId: number | null;
  /** True when a non-zero cursor predates the archive's retained range. */
  gap: boolean;
}
