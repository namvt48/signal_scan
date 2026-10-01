// FOMO wallet holdings — resolve a trader's wallet from an alert's txHash,
// remember it (MANY wallets per user), then measure that user's balance of the
// alerted CA and store the holding % per (user, CA, chain).
//
// CREDIT-FREE: every read goes through the chain's own JSON-RPC (evm.ts /
// solana.ts) — never Nansen/GMGN (credits exhausted, NANSEN_CRAWL=off on prod).
// FOMO users are NOT wallets: this module touches only the fomo_user_wallets /
// fomo_holdings tables, never the `wallets` / wallet_trades state.
//
// Resolution is OPPORTUNISTIC: no txHash, an unknown tx, or an unparseable body
// is a silent no-op (no error, no row) — a wallet is never fabricated.

import { chainSlugs } from './shared/chain-slugs.js';
import { canonicalCa, type Chain } from './shared/chain.js';
import { EvmRpcClient, evmRpcEndpoints } from './providers/evm.js';
import { SolanaRpcClient, solanaRpcEndpoints } from './providers/solana.js';
import { insertFomoUserWallet, listFomoWalletsForUser, upsertFomoHolding } from './db.js';
import { log } from './log.js';

export interface FomoRpcDeps {
  readonly evm: EvmRpcClient;
  readonly sol: SolanaRpcClient;
}

let defaultDeps: FomoRpcDeps | null = null;

/** Lazily-built shared clients. Tests pass their own deps; production uses these. */
export function fomoRpcDeps(): FomoRpcDeps {
  return (defaultDeps ??= { evm: new EvmRpcClient(evmRpcEndpoints), sol: new SolanaRpcClient(solanaRpcEndpoints()) });
}

/** EVM ⟺ this chain has an EVM chainId (the ONE chain map — no hardcoded list). */
function isEvmChain(chain: Chain): boolean {
  return chainSlugs(chain).chainId !== null;
}

/** txHash → the trader's wallet (canonicalized), or null when unresolvable. */
export async function resolveFomoWallet(chain: Chain, txHash: string, deps: FomoRpcDeps = fomoRpcDeps()): Promise<string | null> {
  if (txHash === '') return null;
  const address = isEvmChain(chain) ? await deps.evm.transactionFrom(txHash, chain) : await deps.sol.getTransactionOwner(txHash);
  return address === null || address === '' ? null : canonicalCa(address, chain);
}

/** The wallet's balance of one CA in token units; null when the read failed
 *  (never a guessed 0). A wallet that simply holds none is a real 0. */
async function walletAmount(deps: FomoRpcDeps, wallet: string, chain: Chain, ca: string): Promise<number | null> {
  if (isEvmChain(chain)) {
    const rows = await deps.evm.walletTokenHoldings(wallet, chain, [ca]);
    if (rows.length === 0) return null;
    return rows.reduce((sum, r) => sum + r.amount, 0);
  }
  const byMint = await deps.sol.getTokenAccountsByOwner(wallet, { mint: ca });
  return [...byMint.values()].reduce((sum, v) => sum + v, 0);
}

async function tokenSupply(deps: FomoRpcDeps, chain: Chain, ca: string): Promise<number | null> {
  return isEvmChain(chain) ? deps.evm.tokenSupply(ca, chain) : deps.sol.getTokenSupply(ca);
}

/** Re-measure one (user, ca, chain): Σ the user's wallets on that chain, then
 *  upsert ONE fomo_holdings row. `supplyCache` (keyed chain:ca) is the sweep's
 *  per-pass memo. No wallet, or no successful wallet read → nothing written. */
export async function refreshFomoHolding(
  fomoUserId: string,
  chain: Chain,
  ca: string,
  deps: FomoRpcDeps = fomoRpcDeps(),
  supplyCache?: Map<string, number | null>,
): Promise<void> {
  const wallets = listFomoWalletsForUser(fomoUserId, chain);
  if (wallets.length === 0) return;
  const supplyKey = `${chain}:${ca}`;
  let supply = supplyCache?.get(supplyKey);
  if (supply === undefined) {
    supply = await tokenSupply(deps, chain, ca);
    supplyCache?.set(supplyKey, supply);
  }
  let total = 0;
  let measured = false;
  for (const w of wallets) {
    const amount = await walletAmount(deps, w.address, chain, ca);
    if (amount !== null) {
      total += amount;
      measured = true;
    }
  }
  if (!measured) return;
  const pct = supply !== null && supply > 0 ? (total / supply) * 100 : null;
  upsertFomoHolding({
    fomo_user_id: fomoUserId,
    ca,
    chain,
    wallet: wallets[0]!.address,
    amount: total,
    pct,
    measured_at: Date.now(),
  });
}

const inFlight = new Set<string>();

/**
 * Ingest hook: resolve + persist + measure for ONE alert. Fire-and-forget from
 * the API — swallows every failure with a warn (never rejects into the request
 * path). An in-flight guard collapses a burst on the same (user, ca) to one pass.
 */
export async function trackFomoWalletFromTx(
  fomoUserId: string,
  chain: Chain,
  ca: string,
  txHash: string,
  deps: FomoRpcDeps = fomoRpcDeps(),
): Promise<void> {
  if (txHash === '') return;
  const key = `${fomoUserId}:${chain}:${canonicalCa(ca, chain)}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const wallet = await resolveFomoWallet(chain, txHash, deps);
    if (wallet === null) return;
    insertFomoUserWallet({ fomo_user_id: fomoUserId, chain, address: wallet, source: 'fomo', tx_hash: txHash, first_seen_ts: Date.now() });
    await refreshFomoHolding(fomoUserId, chain, ca, deps);
  } catch (e) {
    log.warn('[fomo-holdings] track failed', e instanceof Error ? e.message : String(e));
  } finally {
    inFlight.delete(key);
  }
}
