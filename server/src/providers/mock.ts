// Deterministic mock provider — the whole pipeline (poller → DB → API → UI)
// runs without any API key. Data is a pure function of (key, time bucket):
// same key+bucket always yields the same numbers, buckets tick every 5 minutes
// so the dashboard shows movement over time.

import type { Chain } from '../shared/chain.js';
import type {
  MarketDataProvider,
  MetricKind,
  MetricPatch,
  TokenInfo,
  WalletTokenHolding,
} from './provider.js';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** 5-minute buckets — mock data drifts in sync with the poll cadence. */
function timeBucket(): number {
  return Math.floor(Date.now() / 300_000);
}

/**
 * Shared pool of mock CAs. The DB seed uses the first 4 as tracked_cas and all
 * wallet activity/balances are generated against this pool — without it the
 * mock-mode demo would show empty Tracked By / Inflow / Holding columns.
 */
export const MOCK_CA_POOL: string[] = [
  '0xdemo00000000000000000000000000000000ca01',
  '0xdemo00000000000000000000000000000000ca02',
  '0xdemo00000000000000000000000000000000ca03',
  '0xdemo00000000000000000000000000000000ca04',
  '0xdemo00000000000000000000000000000000ca05',
  '0xdemo00000000000000000000000000000000ca06',
];

/** Deterministic per-wallet rotation: each wallet touches 3 of the 6 pool CAs. */
function poolFor(wallet: string): string[] {
  const offset = hash(wallet) % MOCK_CA_POOL.length;
  return [0, 1, 2].map((i) => MOCK_CA_POOL[(offset + i) % MOCK_CA_POOL.length]);
}

export class MockProvider implements MarketDataProvider {
  readonly name = 'mock';

  async tokenInfo(ca: string, _chain: Chain): Promise<TokenInfo> {
    const r = rng(hash(ca) ^ timeBucket());
    const holders = 1_500 + Math.floor(r() * 18_000);
    // ponytail: price scale picked so mock mc (5M-100M) stays plausible vs mock
    // wallet balances (<=60k) — otherwise demo holding% exceeds 100
    const price = 0.005 + r() * 0.095;
    const supply = 10 ** 9;
    const mc = price * supply;
    const volume24h = 30_000 + r() * 650_000;
    const buyShare = 0.35 + r() * 0.3;
    return {
      ca,
      chain: _chain,
      price,
      holders,
      volume24h,
      buyVol24h: volume24h * buyShare,
      sellVol24h: volume24h * (1 - buyShare),
      volume1h: (volume24h / 24) * (0.3 + r() * 1.4),
      marketCap: mc,
      liquidity: 30_000 + r() * 400_000,
      supply,
      // Stable pseudo-ticker per CA (no timeBucket — tickers must not drift): 'MOCK' + 3 base36 chars.
      symbol: `MOCK${(hash(ca) % 46656).toString(36).toUpperCase().padStart(3, '0')}`,
      freshCount: Math.floor(holders * (0.08 + r() * 0.16)),
      top10Rate: 0.1 + r() * 0.45,
      // Genesis cohort balance ~15–25% of supply → LF gate (≤30%) passes for
      // the whole demo pool; LF semantics unified with Nansen (token units).
      genesisBal: supply * (0.15 + r() * 0.1),
    };
  }

  /** Mock has no per-endpoint doors: one synthesized snapshot serves every kind. */
  async metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch> {
    const info = await this.tokenInfo(ca, chain);
    switch (kind) {
      case 'essential':
        return {
          price: info.price,
          supply: info.supply,
          marketCap: info.marketCap,
          liquidity: info.liquidity,
          ...(info.symbol !== undefined ? { symbol: info.symbol } : {}),
        };
      case 'volume':
        return {
          volume24h: info.volume24h,
          buyVol24h: info.buyVol24h,
          sellVol24h: info.sellVol24h,
          ...(info.volume1h !== undefined ? { volume1h: info.volume1h } : {}),
        };
      case 'gini': {
        const s = info.nansenStats;
        if (!s) return {};
        return {
          nansenHolders: s.holders,
          nansenFreshPct: s.freshSupplyPct,
          ...(s.t100SupplyPct !== undefined ? { nansenT100Pct: s.t100SupplyPct } : {}),
          ...(s.medianBalanceUsd !== undefined ? { nansenMedianUsd: s.medianBalanceUsd } : {}),
        };
      }
    }
  }

  async walletTokenHoldings(wallet: string, _chain: Chain): Promise<WalletTokenHolding[]> {
    const out: WalletTokenHolding[] = [];
    for (const ca of poolFor(wallet)) {
      const r = rng(hash('bal:' + wallet + ca) ^ timeBucket());
      if (r() < 0.4) continue;
      // Token units, not USD: tokenInfo supply is 1e9 for the whole pool, so
      // 0.02–1.22% of supply keeps the demo holding% in the same range the old
      // balanceUsd/marketCap ratio produced.
      out.push({ ca, amount: 1e9 * (0.0002 + r() * 0.012) });
    }
    return out;
  }
}
