// Chain union shared between frontend and server (kept in sync with src/types.ts).

export const CHAINS = ['sol', 'base', 'bsc', 'robinhood'] as const;
export type Chain = (typeof CHAINS)[number];

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True iff `addr` is a syntactically valid Solana pubkey: base58 over the
 *  Bitcoin alphabet decoding to exactly 32 bytes. No checksum — Solana keys
 *  carry none — so this rejects only non-base58 garbage (the ws `mentions`
 *  shard-killer), never a well-formed-but-unowned key. */
export function isSolanaAddress(addr: string): boolean {
  // 32 bytes ⇒ 32..44 base58 chars; the bound also caps the BigInt below.
  if (addr.length < 32 || addr.length > 44) return false;
  let n = 0n;
  for (const c of addr) {
    const d = B58_ALPHABET.indexOf(c);
    if (d < 0) return false;
    n = n * 58n + BigInt(d);
  }
  let bytes = 0;
  for (let m = n; m > 0n; m >>= 8n) bytes += 1;
  let lead = 0;
  while (lead < addr.length && addr[lead] === '1') lead += 1; // leading '1' = zero byte
  return bytes + lead === 32;
}

/** Folds EVM addresses (`0x` + 40 hex, case-insensitive) to lowercase; anything else
 *  verbatim — sol base58 IS case-sensitive, folding it would merge distinct accounts. */
export function canonicalCa(ca: string, chain: Chain): string {
  return chain !== 'sol' && EVM_ADDRESS.test(ca) ? ca.toLowerCase() : ca;
}
