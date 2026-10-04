// Composite market provider (MODE=gmgn, user 2026-09-24): GMGN owns the market
// core — price, market cap, ticker, holders, 24h/1h volume — while Nansen keeps
// the setup indicators GMGN cannot supply (fresh% / T100 / median) and the wallet
// paths (RPC holdings, T100 series). Routing is by MetricKind, so each sweep hits
// the provider that owns it without knowing this class exists.

import type { Chain } from '../shared/chain.js';
import type { GmgnProvider } from './gmgn.js';
import type { MarketDataProvider, MetricKind, MetricPatch, TokenInfo, WalletTokenHolding } from './provider.js';

export class CompositeProvider implements MarketDataProvider {
  readonly name: string;

  constructor(
    private readonly gmgn: GmgnProvider,
    private readonly nansen: MarketDataProvider,
  ) {
    this.name = `${gmgn.name}+${nansen.name}`;
  }

  /** gini (fresh/T100/median) → Nansen; volume → GMGN. essential → GMGN, falling
   * back to Nansen's free essential door when GMGN is gated/429: a GMGN-only
   * essential left supply/deployed_at NULL for ~60% of the FOMO queue, which
   * cascades to the LF denominator (2026-10-02). Any other GMGN failure still
   * propagates — GMGN owns volume. */
  async metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch> {
    if (kind === 'gini') return this.nansen.metric(ca, chain, kind);
    try {
      return await this.gmgn.metric(ca, chain, kind);
    } catch (e) {
      if (kind !== 'essential') throw e;
      return this.nansen.metric(ca, chain, kind);
    }
  }

  assetInfo(ca: string, chain: Chain) {
    return this.gmgn.assetInfo(ca, chain);
  }

  /** First-add kick: GMGN fills the market core, Nansen the fresh card. The
   * essential door is load-bearing (symbol/price/mc/holders/supply) — it routes
   * through `metric`, so a gated GMGN is backstopped by Nansen and only BOTH
   * failing leaves the CA owed (2026-10-02). A failed or missing volume/gini door
   * only omits ITS columns instead of discarding the market core (2026-10-01: a
   * Nansen gini 403/503 used to abort the whole kick, leaving fresh CAs
   * ticker-less). */
  async tokenInfo(ca: string, chain: Chain): Promise<TokenInfo> {
    const [essR, volR, giniR] = await Promise.allSettled([
      this.metric(ca, chain, 'essential'),
      this.gmgn.metric(ca, chain, 'volume'),
      this.nansen.metric(ca, chain, 'gini'),
    ]);
    if (essR.status === 'rejected') throw essR.reason;
    const ess = essR.value;
    const vol: MetricPatch = volR.status === 'fulfilled' ? volR.value : {};
    const gini: MetricPatch = giniR.status === 'fulfilled' ? giniR.value : {};
    const fresh = gini.nansenFreshPct;
    const holders = ess.holders ?? 0;
    const nansenHolders = gini.nansenHolders ?? 0;
    return {
      ca,
      chain,
      price: ess.price ?? 0,
      holders,
      volume24h: vol.volume24h ?? 0,
      buyVol24h: vol.buyVol24h ?? 0,
      sellVol24h: vol.sellVol24h ?? 0,
      ...(vol.volume1h !== undefined ? { volume1h: vol.volume1h } : {}),
      marketCap: ess.marketCap ?? 0,
      liquidity: ess.liquidity ?? 0,
      supply: ess.supply ?? 0,
      ...(ess.deployedAt !== undefined ? { deployedAt: ess.deployedAt } : {}),
      ...(ess.symbol !== undefined ? { symbol: ess.symbol } : {}),
      ...(fresh !== undefined
        ? {
            nansenStats: {
              holders: nansenHolders > 0 ? nansenHolders : holders,
              freshSupplyPct: fresh,
              ...(gini.nansenT100Pct !== undefined ? { t100SupplyPct: gini.nansenT100Pct } : {}),
              ...(gini.nansenMedianUsd !== undefined ? { medianBalanceUsd: gini.nansenMedianUsd } : {}),
            },
          }
        : {}),
    };
  }

  walletTokenHoldings(wallet: string, chain: Chain, cas?: readonly string[]): Promise<WalletTokenHolding[]> {
    return this.nansen.walletTokenHoldings(wallet, chain, cas);
  }
}
