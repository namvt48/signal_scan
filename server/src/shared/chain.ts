// Chain union shared between frontend and server (kept in sync with src/types.ts).

export const CHAINS = ['sol', 'base', 'bsc', 'robinhood'] as const;
export type Chain = (typeof CHAINS)[number];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Folds EVM addresses (`0x` + 40 hex, case-insensitive) to lowercase; anything else
 *  verbatim — sol base58 IS case-sensitive, folding it would merge distinct accounts. */
export function canonicalCa(ca: string, chain: Chain): string {
  return chain !== 'sol' && EVM_ADDRESS.test(ca) ? ca.toLowerCase() : ca;
}
