import { clearZeroHolding, getDb } from './db.js';
import { getTrackingSinceMs } from './settings.js';
import { replaceWalletBalances } from './ingest.js';
import type { WalletTokenHolding } from './providers/provider.js';

/** Persist a complete, successfully observed SOL wallet snapshot and its independent holding membership. */
export function saveSolWalletHoldings(walletId: string, rows: WalletTokenHolding[], expectedAddress?: string): boolean {
  const db = getDb();
  const save = db.transaction(() => {
    const wallet = db.prepare('SELECT address,chain FROM wallets WHERE id = ?').get(walletId) as { address:string; chain:string } | undefined;
    if (wallet?.chain !== 'sol' || (expectedAddress !== undefined && wallet.address !== expectedAddress)) return false;

    const cutoff = new Date(getTrackingSinceMs()).toISOString();
    const trackedCas = new Set((db.prepare(
      "SELECT address FROM tracked_cas WHERE chain = 'sol' AND added_at >= ? AND status != 'inactive'",
    ).all(cutoff) as { address: string }[]).map(({ address }) => address));
    const validRows = rows.filter((row) => trackedCas.has(row.ca));
    const trackedBuys = new Set((db.prepare(
      "SELECT DISTINCT ca FROM wallet_trades WHERE wallet_id = ? AND chain = 'sol' AND side = 'buy' AND source = 'watch'",
    ).all(walletId) as { ca: string }[]).map(({ ca }) => ca));
    const rowsToPersist = validRows.filter((row) => row.amount > 0 || trackedBuys.has(row.ca));

    const existingMemberships = new Set((db.prepare(
      "SELECT ca FROM sol_wallet_holding_membership WHERE wallet_id = ? AND chain = 'sol'",
    ).all(walletId) as { ca: string }[]).map(({ ca }) => ca));
    const existingStates = new Set((db.prepare(
      "SELECT ca FROM wallet_token_state WHERE wallet_id = ? AND chain = 'sol'",
    ).all(walletId) as { ca: string }[]).map(({ ca }) => ca));
    const existingZeros = new Set((db.prepare(
      "SELECT ca FROM zero_holdings WHERE member_type = 'wallet' AND member_id = ? AND chain = 'sol'",
    ).all(walletId) as { ca: string }[]).map(({ ca }) => ca));

    replaceWalletBalances(walletId, 'sol', rowsToPersist);

    const removeMembership = db.prepare(
      "DELETE FROM sol_wallet_holding_membership WHERE wallet_id = ? AND ca = ? AND chain = 'sol'",
    );
    const insertMembership = db.prepare(
      "INSERT OR IGNORE INTO sol_wallet_holding_membership (wallet_id, ca, chain) VALUES (?, ?, 'sol')",
    );
    const removeState = db.prepare(
      "DELETE FROM wallet_token_state WHERE wallet_id = ? AND ca = ? AND chain = 'sol'",
    );
    for (const row of validRows) {
      if (row.amount > 0) {
        if (!existingMemberships.has(row.ca)) insertMembership.run(walletId, row.ca);
        if (existingZeros.has(row.ca)) clearZeroHolding('wallet', walletId, row.ca, 'sol');
        continue;
      }
      if (existingMemberships.has(row.ca)) removeMembership.run(walletId, row.ca);
      if (trackedBuys.has(row.ca)) continue;
      if (existingStates.has(row.ca)) removeState.run(walletId, row.ca);
      if (existingZeros.has(row.ca)) clearZeroHolding('wallet', walletId, row.ca, 'sol');
    }
    return true;
  });
  return save();
}
