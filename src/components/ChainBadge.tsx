import baseLogo from '../assets/chains/base.png';
import bscLogo from '../assets/chains/bsc.png';
import robinhoodLogo from '../assets/chains/robinhood.svg';
import solLogo from '../assets/chains/sol.png';
import type { Chain } from '../types';

/** Chain → bundled logo + display name. `Record<Chain, …>` so a new chain is a compile error, not a blank badge. */
const CHAIN_LOGO: Record<Chain, { src: string; name: string }> = {
  sol: { src: solLogo, name: 'Solana' },
  base: { src: baseLogo, name: 'Base' },
  bsc: { src: bscLogo, name: 'BSC' },
  robinhood: { src: robinhoodLogo, name: 'Robinhood' },
};

/** Small chain logo rendered under a token avatar on the FOMO dashboard. */
export function ChainBadge({ chain }: { chain: Chain }) {
  const { src, name } = CHAIN_LOGO[chain];
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      className="h-5 w-5 rounded-full object-contain ring-2 ring-surface"
    />
  );
}
