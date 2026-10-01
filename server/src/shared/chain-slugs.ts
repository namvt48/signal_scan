// Per-provider chain-slug mapping (the ONE place chain → provider slug lives).
//
// Slugs verified live (do not invent):
//   sol  → gmgn `sol`,   nansen `solana`, dexscreener `solana` (gmgn `solana` 404s, probed 2026-09-24)
//   base → gmgn `base`,  nansen `base`,   dexscreener `base`,   chainId 8453, native ETH
//   bsc  → gmgn `bsc`,   nansen `bnb`,    dexscreener `bsc`,    chainId 56,   native BNB
//   robinhood → gmgn `robinhood`, nansen `robinhood`, dexscreener `robinhood`,
//               chainId 4663, native ETH (nansen docs list `robinhood` for
//               netflow/dex/holdings/flows; dexscreener verified live 2026-09-30)

import type { Chain } from './chain.js';

export interface ChainSlugs {
  readonly gmgn: string;
  readonly nansen: string;
  readonly dexscreener: string;
  readonly chainId: number | null;
  readonly nativeSymbol: string;
  readonly explorer: (ca: string) => string;
}

export const CHAIN_SLUGS: Record<Chain, ChainSlugs> = {
  sol: {
    gmgn: 'sol',
    nansen: 'solana',
    dexscreener: 'solana',
    chainId: null,
    nativeSymbol: 'SOL',
    explorer: (ca) => `https://solscan.io/token/${ca}`,
  },
  base: {
    gmgn: 'base',
    nansen: 'base',
    dexscreener: 'base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    explorer: (ca) => `https://basescan.org/token/${ca}`,
  },
  bsc: {
    gmgn: 'bsc',
    nansen: 'bnb',
    dexscreener: 'bsc',
    chainId: 56,
    nativeSymbol: 'BNB',
    explorer: (ca) => `https://bscscan.com/token/${ca}`,
  },
  robinhood: {
    gmgn: 'robinhood',
    nansen: 'robinhood',
    dexscreener: 'robinhood',
    chainId: 4663,
    nativeSymbol: 'ETH',
    explorer: (ca) => `https://robinhoodchain.blockscout.com/token/${ca}`,
  },
};

/** Lookup by runtime string; throws on an unknown chain (same contract as before). */
export function chainSlugs(chain: string): ChainSlugs {
  if (chain in CHAIN_SLUGS) return CHAIN_SLUGS[chain as Chain];
  throw new Error(`unsupported chain ${chain}`);
}
