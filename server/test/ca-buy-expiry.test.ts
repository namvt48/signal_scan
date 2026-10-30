import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  findTrackedCa,
  getDb,
  insertFomoTrade,
  insertFomoUser,
  insertTrackedCa,
  insertWallet,
  listTrackedCas,
  open,
  pruneUntrackedCas,
  setTier,
  upsertFomoPosition,
} from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';

const HOUR = 3_600_000;
const WINDOW = 48 * HOUR;

beforeEach(() => open(':memory:'));
afterEach(() => getDb().close());

function addCa(address: string, chain: 'sol' | 'base', addedAt: number): void {
  insertTrackedCa({ address, chain, note: '' });
  getDb().prepare('UPDATE tracked_cas SET added_at=? WHERE address=? AND chain=?')
    .run(new Date(addedAt).toISOString(), address, chain);
}

test('48h expiry uses the latest BUY without holdings or tier exemptions and preserves history', () => {
  const now = Date.now();
  const wallet = insertWallet({ address: 'wallet-expiry', name: 'expiry', tags: [], chain: 'sol', source: 'watch' });
  const fomo = insertFomoUser({ handle: 'expiry-fomo', user_id: 'expiry-fomo-id' });
  const aged = now - 72 * HOUR;
  const expired = ['expired-held-tiered', 'old-buy-new-added-at', 'exact-cutoff', 'sell-only', 'no-buy-expired'];
  for (const ca of expired) addCa(ca, 'sol', aged);
  addCa('recent-wallet-buy', 'sol', aged);
  addCa('recent-fomo-buy', 'sol', aged);
  addCa('no-buy-young', 'sol', now - 24 * HOUR);

  insertTrades(wallet.id, [
    { tx: 'expired-buy', ts: now - 80 * HOUR, side: 'buy', ca: 'expired-held-tiered', chain: 'sol', amountUsd: 5, price: 1 },
    { tx: 'old-buy', ts: now - 72 * HOUR, side: 'buy', ca: 'old-buy-new-added-at', chain: 'sol', amountUsd: 5, price: 1 },
    { tx: 'boundary-buy', ts: now - WINDOW, side: 'buy', ca: 'exact-cutoff', chain: 'sol', amountUsd: 5, price: 1 },
    { tx: 'sell-only', ts: now - HOUR, side: 'sell', ca: 'sell-only', chain: 'sol', amountUsd: 5, price: 1 },
    { tx: 'recent-buy', ts: now - HOUR, side: 'buy', ca: 'recent-wallet-buy', chain: 'sol', amountUsd: 5, price: 1 },
  ], 'watch');
  getDb().prepare('UPDATE tracked_cas SET added_at=? WHERE address=? AND chain=?')
    .run(new Date(now - 24 * HOUR).toISOString(), 'old-buy-new-added-at', 'sol');
  replaceWalletBalances(wallet.id, 'sol', [{ ca: 'expired-held-tiered', amount: 12 }]);
  setTier('expired-held-tiered', 'sol', 'A');
  upsertFomoPosition({
    fomo_user_id: fomo.id, ca: 'expired-held-tiered', chain: 'sol', trade_id: 'old-position', status: 'open',
    amount: 3, cost_basis_usd: 3, avg_entry_price: 1, price_usd: 1, realized_pnl_usd: 0,
    unrealized_pnl_usd: 0, fetched_at: now,
  });
  insertFomoTrade({
    fomo_user_id: fomo.id, event_id: 'recent-fomo-buy', ca: 'recent-fomo-buy', chain: 'sol', type: 'buy', ts: now - HOUR,
  });

  const deactivated = pruneUntrackedCas(WINDOW, now).map((row) => row.address).sort();
  assert.deepEqual(deactivated, [...expired].sort());
  for (const ca of expired) assert.equal(findTrackedCa(ca, 'sol')?.status, undefined);
  assert.equal(findTrackedCa('expired-held-tiered', 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa('old-buy-new-added-at', 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa('exact-cutoff', 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa('sell-only', 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa('no-buy-expired', 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa('recent-wallet-buy', 'sol')?.status, 'queued');
  assert.equal(findTrackedCa('recent-fomo-buy', 'sol')?.status, 'queued');
  assert.equal(findTrackedCa('no-buy-young', 'sol')?.status, 'queued');
  assert.equal(listTrackedCas().some((row) => row.address === 'expired-held-tiered'), false);
  assert.equal((getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=? AND chain=?')
    .get(wallet.id, 'expired-held-tiered', 'sol') as { token_amount: number }).token_amount, 12);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM wallet_trades WHERE ca=? AND chain=?')
    .get('expired-held-tiered', 'sol') as { n: number }).n, 1);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_positions WHERE ca=? AND chain=?')
    .get('expired-held-tiered', 'sol') as { n: number }).n, 1);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades WHERE event_id=?')
    .get('recent-fomo-buy') as { n: number }).n, 1);
});

test('BUY activity and expiry remain scoped to the chain', () => {
  const now = Date.now();
  const address = 'shared-chain-ca';
  addCa(address, 'sol', now - 72 * HOUR);
  addCa(address, 'base', now - 72 * HOUR);
  const wallet = insertWallet({ address: 'wallet-sol-only', name: 'sol', tags: [], chain: 'sol', source: 'watch' });
  insertTrades(wallet.id, [{ tx: 'sol-buy', ts: now - HOUR, side: 'buy', ca: address, chain: 'sol', amountUsd: 5, price: 1 }], 'watch');

  const deactivated = pruneUntrackedCas(WINDOW, now);
  assert.deepEqual(deactivated.map((row) => `${row.chain}:${row.address}`), [`base:${address}`]);
  assert.equal(findTrackedCa(address, 'sol')?.status, 'queued');
  assert.equal(findTrackedCa(address, 'base', true)?.status, 'inactive');
});
