import baseLogo from '../assets/chains/base.png';
import bscLogo from '../assets/chains/bsc.png';
import ethLogo from '../assets/chains/eth.svg';
import robinhoodLogo from '../assets/chains/robinhood.svg';
import solLogo from '../assets/chains/sol.png';
import type { JSX } from 'react';
import type { Chain } from '../types';

/** Chain → bundled logo + display name. `Record<Chain, …>` so a new chain is a compile error, not a blank badge. */
const CHAIN_LOGO: Record<Chain, { src: string; name: string }> = {
  sol: { src: solLogo, name: 'Solana' },
  base: { src: baseLogo, name: 'Base' },
  bsc: { src: bscLogo, name: 'BSC' },
  robinhood: { src: robinhoodLogo, name: 'Robinhood' },
  eth: { src: ethLogo, name: 'Ethereum' },
};

/** Small chain logo rendered under a token avatar or beside a chain filter option. */
interface ChainBadgeProps {
  chain: Chain;
  size?: 'sm' | 'md';
}

export function ChainBadge({ chain, size = 'md' }: ChainBadgeProps): JSX.Element {
  const { src, name } = CHAIN_LOGO[chain];
  const imageSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      decoding="async"
      className={`${imageSize} object-contain ring-2 ring-surface ${chain === 'robinhood' ? 'rounded-md' : 'rounded-full'}`}
    />
  );
}
