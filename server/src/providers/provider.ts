// MarketDataProvider — the extension seam. Poller + API only know this
// interface; live data comes from Nansen since 2026-09-09 (mock stays for
// MOCK mode).

import type { Chain } from '../shared/chain.js';
import type { AssetInfo } from './solana.js';

export interface TokenInfo {
  ca: string;
  chain: Chain;
  price: number;
  holders: number;
  /** DEX 24h volume, USD (buy+sell). */
  volume24h: number;
  buyVol24h: number;
  sellVol24h: number;
  /** DEX trailing-1h volume, USD. Absent when the 1h door failed for this CA. */
  volume1h?: number;
  marketCap: number;
  liquidity: number;
  supply: number;
  /** Token deploy time, epoch ms (Nansen essential-data.deployedTimestamp) — persisted write-once. */
  deployedAt?: number;
  /** Ticker from essential-data (e.g. "MINI"), stored as-is — FE uppercases for display. */
  symbol?: string;
  /** Optional wallet-count of fresh holders (mock only — Nansen gives supply %, not a count). */
  freshCount?: number;
  /** Optional; mock writes it, Nansen writes top10_rate from the holders-balances slot instead. */
  top10Rate?: number;
  /** Optional genesis top-100 cohort balance (token units). Mock synthesizes ~20% of
   * supply; for Nansen the holders slot gets it from the exchange LF (exchangeAnchorLf)
   * and writes it via updateTokenAnalytics — omit here so COALESCE keeps it. */
  genesisBal?: number;
  /** Set by the Nansen provider: authoritative gini-stats card set (nansen_* columns). */
  nansenStats?: { holders: number; freshSupplyPct: number; t100SupplyPct?: number; medianBalanceUsd?: number };
}

export interface HolderRow {
  address: string;
  /** 0-1 share of supply. */
  amountPct: number;
  /** legacy addr_type flag — Nansen rows are always 1 (no per-row exchange flag). */
  addrType: number;
  isNew: boolean;
  usdValue: number;
  /** Nansen "24h Chg" — delta of held token amount over last 24h (changeShortTimeframe). */
  chg24h?: number;
  /** Nansen holder label (entity/name string), informational. */
  name?: string;
}

export interface WalletActivity {
  tx: string;
  ts: number; // epoch ms
  side: 'buy' | 'sell';
  ca: string;
  chain: Chain;
  amountUsd: number;
  price: number;
}

export interface WalletTokenHolding {
  ca: string;
  /** Raw token amount held, in token units (NOT USD) — price-independent. */
  amount: number;
}

/** ONE free app-question = one endpoint. Each has its own poll cadence. */
export type MetricKind = 'essential' | 'volume' | 'gini';

/**
 * Partial write for one MetricKind — only the fields that endpoint owns.
 * `undefined` = "this endpoint says nothing about it", never "clear it"
 * (ingest.updateTokenMetrics writes the provided keys only).
 */
export interface MetricPatch {
  price?: number;
  supply?: number;
  marketCap?: number;
  liquidity?: number;
  deployedAt?: number;
  symbol?: string;
  /** Token logo URL (DexScreener icon sweep) — validated https + host allowlist BEFORE storage. */
  iconUrl?: string;
  /** X (Twitter) handle from GMGN token/info (data.link.twitter_username), normalized to a bare
   * alnum/underscore handle — the FE builds https://x.com/<handle>, so junk is dropped, not stored. */
  xHandle?: string;
  /** Holders count for the `holders` column (GMGN token/info holder_count). */
  holders?: number;
  volume24h?: number;
  buyVol24h?: number;
  sellVol24h?: number;
  /** Trailing-1h DEX volume (buy+sell, USD). GMGN returns it directly; Nansen mode
   * omits it and the poller derives it from volume24h growth between sweeps. */
  volume1h?: number;
  /** Previous volume24h + its epoch ms — written by the volume sweep to base the next delta. */
  vol24hPrev?: number;
  vol24hPrevAt?: number;
  nansenHolders?: number;
  nansenFreshPct?: number;
  nansenT100Pct?: number;
  nansenMedianUsd?: number;
}

export interface MarketDataProvider {
  readonly name: string;
  tokenInfo(ca: string, chain: Chain): Promise<TokenInfo>;
  /** ONE endpoint per kind — the poller runs each kind on its own cadence. */
  metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch>;
  /**
   * RPC-only floor for one mint: symbol/supply/price with NO browser door, so the
   * data still lands while Cloudflare or a sick Chrome sidecar blocks `metric`.
   * Optional — a provider with no direct chain RPC omits it.
   */
  assetInfo?(ca: string, chain: Chain): Promise<AssetInfo>;
  /**
   * Token units the wallet holds for each of `cas` — one query per (CA, wallet)
   * pair. Omitted `cas` = every tracked CA on that chain (the broad legacy call).
   */
  walletTokenHoldings(wallet: string, chain: Chain, cas?: readonly string[]): Promise<WalletTokenHolding[]>;
}
