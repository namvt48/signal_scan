import type { Chain } from './types';

/**
 * Per-chain display links. FE-local copy of the server's chain map — this Vite build cannot
 * import `server/src/shared`. GMGN slugs verified: sol→sol, base→base, bsc→bsc.
 */
export const CHAIN_LINKS: Record<Chain, { gmgnSlug: string; explorerUrl: (ca: string) => string }> = {
  sol: { gmgnSlug: 'sol', explorerUrl: (ca) => `https://solscan.io/token/${ca}` },
  base: { gmgnSlug: 'base', explorerUrl: (ca) => `https://basescan.org/token/${ca}` },
  bsc: { gmgnSlug: 'bsc', explorerUrl: (ca) => `https://bscscan.com/token/${ca}` },
};
