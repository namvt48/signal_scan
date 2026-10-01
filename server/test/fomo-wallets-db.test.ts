// FOMO wallet + holdings tables — OFFLINE, deterministic (node:test, memory DB).

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteFomoUser,
  findFomoUserWallet,
  getDb,
  insertFomoTrade,
  insertFomoUser,
  insertFomoUserWallet,
  listFomoAlertTargets,
  listFomoWalletsForUser,
  open,
  upsertFomoHolding,
  type FomoUserWalletRow,
} from '../src/db.js';

const EVM_WALLET = '0xAbCd1234567890AbCdEf1234567890AbCdEf1234';
const EVM_WALLET_LC = EVM_WALLET.toLowerCase();

before(() => {
  open(':memory:');
});

test('insertFomoUserWallet: MANY wallets per user; identity is (user, chain, address)', () => {
  const user = insertFomoUser({ handle: '@multi', name: 'Multi' });
  assert.equal(insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: EVM_WALLET, source: 'fomo', tx_hash: '0x1' }), true);
  assert.equal(insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: '0x2222222222222222222222222222222222222222' }), true);
  assert.equal(insertFomoUserWallet({ fomo_user_id: user.id, chain: 'sol', address: 'SoWallet1' }), true);

  assert.equal(listFomoWalletsForUser(user.id, 'base').length, 2, 'two wallets on base');
  assert.equal(listFomoWalletsForUser(user.id, 'sol').length, 1, 'sol is a separate identity');
});

test('insertFomoUserWallet: a re-resolved wallet is a no-op (ON CONFLICT DO NOTHING)', () => {
  const user = insertFomoUser({ handle: '@dup', name: 'Dup' });
  assert.equal(insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: EVM_WALLET, tx_hash: '0x1' }), true);
  assert.equal(insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: EVM_WALLET, tx_hash: '0x2' }), false);
  assert.equal(listFomoWalletsForUser(user.id, 'base').length, 1);
});

test('insertFomoUserWallet / findFomoUserWallet: EVM address canonicalized for storage AND lookup', () => {
  const user = insertFomoUser({ handle: '@canon', name: 'Canon' });
  insertFomoUserWallet({ fomo_user_id: user.id, chain: 'base', address: EVM_WALLET });

  const row = getDb().prepare('SELECT address FROM fomo_user_wallets WHERE fomo_user_id = ?').get(user.id) as { address: string };
  assert.equal(row.address, EVM_WALLET_LC, 'stored folded');
  assert.ok(findFomoUserWallet(user.id, 'base', EVM_WALLET), 'lookup folds the mixed-case query');
});

test('insertFomoUserWallet: sol address is verbatim (base58 is case-sensitive)', () => {
  const user = insertFomoUser({ handle: '@solcase', name: 'Sol' });
  insertFomoUserWallet({ fomo_user_id: user.id, chain: 'sol', address: 'AbC123SolWallet' });
  assert.ok(findFomoUserWallet(user.id, 'sol', 'AbC123SolWallet'));
  assert.equal(findFomoUserWallet(user.id, 'sol', 'abc123solwallet'), undefined);
});

test('insertFomoUserWallet: unknown fomo_user_id violates the FK', () => {
  assert.throws(() => insertFomoUserWallet({ fomo_user_id: 'no-such-user', chain: 'sol', address: 'W1' }), /FOREIGN KEY/i);
});

test('upsertFomoHolding: ONE row per (user, ca, chain) — a re-measure overwrites; ca/wallet canonicalized', () => {
  const user = insertFomoUser({ handle: '@hold', name: 'Hold' });
  upsertFomoHolding({ fomo_user_id: user.id, ca: 'SoCa9', chain: 'sol', wallet: 'W1', amount: 12, pct: 3, measured_at: 100 });
  upsertFomoHolding({ fomo_user_id: user.id, ca: 'SoCa9', chain: 'sol', wallet: 'W2', amount: 20, pct: 5, measured_at: 200 });

  const rows = getDb().prepare('SELECT wallet, amount, pct, measured_at FROM fomo_holdings WHERE fomo_user_id = ?').all(user.id) as {
    wallet: string;
    amount: number;
    pct: number;
    measured_at: number;
  }[];
  assert.equal(rows.length, 1, 'overwrite, not a second row');
  assert.deepEqual(rows[0], { wallet: 'W2', amount: 20, pct: 5, measured_at: 200 });

  upsertFomoHolding({ fomo_user_id: user.id, ca: EVM_WALLET, chain: 'base', wallet: EVM_WALLET, amount: 1, pct: null, measured_at: 1 });
  const evmRow = getDb().prepare('SELECT ca, wallet FROM fomo_holdings WHERE chain = ?').get('base') as { ca: string; wallet: string };
  assert.equal(evmRow.ca, EVM_WALLET_LC, 'ca canonicalized');
  assert.equal(evmRow.wallet, EVM_WALLET_LC, 'wallet canonicalized');
});

test('listFomoAlertTargets: DISTINCT (user, ca, chain) from fomo_trades', () => {
  const user = insertFomoUser({ handle: '@targets', name: 'Targets' });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 't1', ca: 'CaA', chain: 'sol', type: 'buy', ts: 1 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 't2', ca: 'CaA', chain: 'sol', type: 'sell', ts: 2 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 't3', ca: 'CaB', chain: 'sol', type: 'buy', ts: 3 });

  const targets = listFomoAlertTargets().filter((t) => t.fomo_user_id === user.id);
  assert.equal(targets.length, 2, 'CaA collapsed to one target');
  assert.deepEqual(new Set(targets.map((t) => t.ca)), new Set(['CaA', 'CaB']));
});

test('deleteFomoUser: cascades to fomo_user_wallets AND fomo_holdings', () => {
  const user = insertFomoUser({ handle: '@cascade', name: 'Cascade' });
  insertFomoUserWallet({ fomo_user_id: user.id, chain: 'sol', address: 'W9' });
  upsertFomoHolding({ fomo_user_id: user.id, ca: 'Ca9', chain: 'sol', wallet: 'W9', amount: 1, pct: 1, measured_at: 1 });

  deleteFomoUser(user.id);

  const wallets = getDb().prepare('SELECT * FROM fomo_user_wallets WHERE fomo_user_id = ?').all(user.id) as FomoUserWalletRow[];
  const holdings = getDb().prepare('SELECT * FROM fomo_holdings WHERE fomo_user_id = ?').all(user.id);
  assert.equal(wallets.length, 0);
  assert.equal(holdings.length, 0);
});
