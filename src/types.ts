export const CHAINS = ['sol', 'base', 'bsc', 'robinhood', 'eth'] as const;
export type Chain = (typeof CHAINS)[number];
// Wallet-group import networks; adding `evm` expands to every supported EVM chain.
export const EVM_CHAINS = ['base', 'bsc', 'robinhood', 'eth'] as const satisfies readonly Chain[];
export type WalletScope = Chain | 'evm';

export const TIERS = ['S+', 'S', 'A+', 'A', 'B+', 'B', 'P'] as const;
export type Tier = (typeof TIERS)[number];
/** Tiers shown on the Rated tab — P is dashboard-only, never enters Rated (user 2026-09-29). */
export const RATED_TIERS = TIERS.filter((t) => t !== 'P');

export interface Wallet {
  id: string;
  address: string;
  name: string;
  tags: string[];
  chain: Chain;
  source: string;
  /** Display-only clan label (user 2026-09-24). Absent/empty = unlabelled. */
  clan?: string;
  /** PnL cohort metadata, refreshed hourly by the server. */
  rank?: string;
  groups?: string[];
}

/** One FOMO trader on the watch list (mirrors server `fomo_users`). */
export interface FomoUser {
  id: string;
  /** FOMO handle — the identity the alert stream matches on. Unique. */
  handle: string;
  /** Display name (CSV `displayName`); may be empty. */
  name: string;
  /** Display chips (CSV `tags`, `;`-separated like wallets); [] when untagged. */
  tags: string[];
  /** Display-only clan label (CSV `clanName`). Absent/empty = unlabelled. */
  clan?: string;
  /** FOMO user id; absent until learned from the stream or seeded from CSV. */
  userId?: string;
  walletSolana?: string;
  walletEvm?: string;
  /** Where the row came from ('manual', 'csv', …). Server defaults to 'manual'. */
  source?: string;
}

export interface NansenSetup {
  /** How many of the 3 Nansen setups hit (fresh wallet, T100 decrease, low float). */
  score: number;
  /**
   * Per-factor gate result under the thresholds in force for THIS response.
   * false = the factor has a value but misses the current threshold (only
   * visible when the allFactors debug flag is on, and rendered struck-through).
   * A factor with no value at all is false too — `fresh`/`t100`/`lf` stay absent.
   */
  pass: { fresh: boolean; t100: boolean; lf: boolean };
  /** Percent of holders that are fresh wallets. */
  fresh?: number;
  /** Ungated measured Fresh %, for explicit range filters even when the setup fails. */
  rawFresh?: number;
  /** Top100 sliding max drawdown: pct = max (peak−trough)/peak×100, multiple = peak/trough (optional until first series write). */
  t100?: { pct: number; multiple?: number };
  /** Timestamped T100 multiple observations; legacy samples may lack balance provenance. */
  t100History?: { t: number; value: number; peakBalance?: number; troughBalance?: number }[];
  /**
   * Low float: the top-100 cohort balance AT price=0 (genesis series A), in
   * TOKEN UNITS — not a market cap (semantics changed 2026-09-10).
   */
  lf?: number;
}

/** Peak/trough holder balance (USD, exchange-classified rows included) inside a window. */
export interface BalRange {
  peak: number;
  trough: number;
}

/** One tracked wallet's activity on a token, within the watch window. */
export interface TrackedWalletStat {
  /** Wallet display name. */
  name: string;
  /** Display-only clan label (user 2026-09-24). Absent/empty = unlabelled. */
  clan?: string;
  /** Wallet tags, so the FE can style the name (e.g. "Unicon" → rainbow). */
  tags?: string[];
  /** PnL cohort rank and all qualifying behavior groups, refreshed hourly. */
  rank?: string;
  groups?: string[];
  /** Net USD this wallet put into the CA over the window: Σ buys − Σ sells. May be negative. */
  inflow: number;
  /** watch BUY count in the window. */
  buys: number;
  /** watch SELL count in the window. */
  sells: number;
  /** Current token balance USD; 0 when zero_holding confirms empty; absent when unmeasured or a positive holding lacks price. */
  balUsd?: number;
  /** Current held token units; 0 when zero_holding confirms empty; absent when unmeasured. */
  holdingAmount?: number;
  /** Current token balance as a share of total supply; absent when balance/supply is unknown. */
  holdingPct?: number;
  /** Epoch ms of the wallet's newest watch trade for this CA; 0 = none. */
  lastTs: number;
}

/**
 * One watched FOMO trader's activity on a token. buyUsd is BUY spend for the
 * trailing 24h and sellUsd is SELL proceeds, both null if any in-window amount
 * is unresolved; never netted. balUsd is the current position value and
 * holdingPct is that value divided by the CA market cap.
 */
export interface FomoUserStat {
  handle: string;
  name?: string;
  /** Display chips (mirrors FomoUser.tags); absent when the user has none. */
  tags?: string[];
  clan?: string;
  buyUsd: number | null;
  /** Σ sell proceeds in the window; null when any SELL amount is unresolved. */
  sellUsd: number | null;
  buys: number;
  sells: number;
  trades: number;
  lastTs: number;
  /** Σ token units the user's wallets hold of this CA; absent until measured. */
  holdingAmount?: number;
  /** Position value ÷ CA market cap × 100; absent when either is unknown. */
  holdingPct?: number;
  /** Current position value (amount × price); 0 only for a measured zero. */
  balUsd?: number;
}

export interface TokenSignal {
  id: string;
  ca: string;
  chain: Chain;
  /** Ticker (Nansen essential-data, as-is e.g. "MINI") — table uppercases it; absent until first sweep. */
  symbol?: string;
  /** CA-keyed API avatar URL; returns the verified source image or a deterministic CA identicon. */
  iconUrl?: string;
  /** X (Twitter) handle for the token's account, no leading '@'; absent → the CA cell falls back to an X search link. */
  xHandle?: string;
  /** Tracked-wallet activity for this CA. */
  trackedWallets: TrackedWalletStat[];
  /** FOMO watch-list activity for this CA. */
  fomoUsers: FomoUserStat[];
  note?: string;
  buyVol24h?: number;
  sellVol24h?: number;
  nansen: NansenSetup & { freshCurrent: boolean; freshHistory?: { t: number; value: number }[]; freshUpdatedAt?: number; t100History?: { t: number; value: number; peakBalance?: number; troughBalance?: number }[] };
  holders: number;
  /** Historical displayed holder counts, from successful existing metric writes. */
  holdersHistory?: { t: number; value: number }[];
  /** Market cap USD (price × circulating supply); absent until a sweep writes one. */
  marketCap?: number;
  /** Historical market-cap readings from existing market-data updates (epoch ms). */
  marketCapHistory?: { t: number; value: number }[];
  /** Last successful upstream response times for displayed market datasets (epoch ms). */
  dataUpdatedAt?: {
    marketCap?: number;
    volume24h?: number;
    holders?: number;
    fresh?: number;
    symbol?: number;
    icon?: number;
  };
  /** Net USD tracked wallets put in over the last 24h (buys − sells); may be negative. */
  trackedInflow: number;
  /**
   * Epoch ms of the newest buy OR sell from a displayed native wallet in the 24h window;
   * chain-scoped, with 0 when no displayed member trade exists.
   * Dashboard A uses this as its default sort key; FOMO-user activity is merged by the UI.
   */
  trackedActivityAt: number;
  /** Latest captured FOMO buy/sell or native watch trade for this (chain, CA), across all history. */
  fomoActivityAt?: number;
  /** Percentage of token supply held across linked tracked wallets; native-wallet metric. */
  trackedHolding: number;
  /** DEX 24h buy + sell volume in USD. */
  volume24h: number;
  /** Trailing-1h DEX volume, USD. Absent until the 1h sweep has written one. */
  volume1h?: number;
  tier: Tier | null;
  /** Balance-distribution extremes per lookback window (absent window = no snapshot data yet). */
  balanceRange?: { d1?: BalRange; d7?: BalRange; d30?: BalRange };
}


/** One top-100 holder row (CA detail page). Includes exchange-classified rows (addrType 2). */
export interface Top100Holder {
  address: string;
  percentOwnership: number;
  balance: number;
  balanceUsd: number;
  addrType: number;
  isNew: boolean;
  chg24h?: number;
}

export interface TokenDetail {
  ca: string;
  chain: Chain;
  price: number;
  supply: number;
  holders: number;
  freshSupplyPct?: number;
  top100SupplyPct?: number;
  medianHolderAmount?: number;
  medianHolderUsd?: number;
  top100: Top100Holder[];
  snapshotAt?: number;
}

export interface BalanceChartPoint {
  t: number | string;
  total: number;
  totalUsd?: number;
  /** totalHolders of the top-100 cohort at this hour (may be absent). */
  holders?: number;
  /** Σ totalInflows this hour, TOKEN UNITS (may be absent). */
  inflow?: number;
}

export interface BalanceChart {
  source: 'nansen' | 'snapshots';
  points: BalanceChartPoint[];
  /** Epoch ms when the cached Nansen series was crawled (absent = fallback). */
  cachedAt?: number;
}

export interface NansenThresholds {
  /** fresh-wallet % — factor PASSES when value >= this. */
  freshMinPct: number;
  /** top-100 genesis→trough multiple (A/B) — factor PASSES when value >= this (always >= 1). */
  t100MinMultiple: number;
  /** low-float band, TOKEN UNITS — factor PASSES when lfMin <= lf <= lfMax, where lf is the value the LF cell displays. */
  lfMin: number;
  /** low-float band upper edge (inclusive). */
  lfMax: number;
  /** minimum USD threshold — values below this $ are filtered out. */
  minUsd: number;
  /** Market-cap floor in USD; rows with a known marketCap below it are filtered out (0 = off). */
  minMc: number;
  /** Market-cap ceiling in USD; rows with a known marketCap above it are filtered out (-1 = no cap). */
  maxMc: number;
}

export interface Settings {
  values: NansenThresholds;
  defaults: NansenThresholds;
  /** Debug flags echoed by GET /api/settings (absent on older servers). */
  debug: { allFactors: boolean };
}

/** PUT /api/settings body: threshold patch plus the debug flags. */
export type SettingsPatch = Partial<NansenThresholds> & { allFactors?: boolean };

export interface TelegramAlertRules {
  fwGrowthPct: number;
  minFwPct: number;
  t100GrowthPct: number;
  /** Min market cap in thousands of USD; -1 disables this bound. */
  minMcK: number;
  /** Max market cap in thousands of USD; -1 disables this bound. */
  maxMcK: number;
  /** Min holder count; -1 disables this bound. */
  minHolders: number;
  /** Max holder count; -1 disables this bound. */
  maxHolders: number;
  /** Thousands of USD; 0 disables Tracker Buying alerts. */
  trackerBuyingK: number;
}

export interface PeriodicScanSettings {
  enabled: boolean;
  intervalHours: number;
  maxVolume24hUsd: number;
  maxLowFloatTokens: number;
}
