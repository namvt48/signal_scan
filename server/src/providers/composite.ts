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

  /** essential + volume → GMGN; gini (fresh/T100/median) → Nansen. */
  metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch> {
    return kind === 'gini' ? this.nansen.metric(ca, chain, kind) : this.gmgn.metric(ca, chain, kind);
  }

  assetInfo(ca: string, chain: Chain) {
    return this.gmgn.assetInfo(ca, chain);
  }

  /** First-add kick: GMGN fills the market core, Nansen the fresh card. The gini
   * call is the same strict contract as NansenMarketProvider.tokenInfo — no fresh
   * share throws, so the CA stays owed setup instead of landing half-filled. */
  async tokenInfo(ca: string, chain: Chain): Promise<TokenInfo> {
    const [ess, vol, gini] = await Promise.all([
      this.gmgn.metric(ca, chain, 'essential'),
      this.gmgn.metric(ca, chain, 'volume'),
      this.nansen.metric(ca, chain, 'gini'),
    ]);
    const fresh = gini.nansenFreshPct;
    if (fresh === undefined) throw new Error('nansen gini-stats: no fresh share');
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
      nansenStats: {
        holders: nansenHolders > 0 ? nansenHolders : holders,
        freshSupplyPct: fresh,
        ...(gini.nansenT100Pct !== undefined ? { t100SupplyPct: gini.nansenT100Pct } : {}),
        ...(gini.nansenMedianUsd !== undefined ? { medianBalanceUsd: gini.nansenMedianUsd } : {}),
      },
    };
  }

  walletTokenHoldings(wallet: string, chain: Chain, cas?: readonly string[]): Promise<WalletTokenHolding[]> {
    return this.nansen.walletTokenHoldings(wallet, chain, cas);
  }
}
