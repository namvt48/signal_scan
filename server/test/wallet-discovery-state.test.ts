import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDb, insertTrackedCa, insertWallet, open, updateWallet } from '../src/db.js';
import {
  commitDiscoveryBatch,
  ensureDiscoveryWallet,
  initializeDiscoveryState,
  nextDiscoveryRunAt,
  pendingDiscoveryPairs,
  readDiscoveryBatch,
  syncDiscoveryTargets,
  pruneDiscoveryTargets,
} from '../src/wallet-discovery-state.js';

const ca = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const wallet = (chain: 'base' | 'sol' = 'base') => insertWallet({
  address: chain === 'sol' ? '11111111111111111111111111111111' : `0x${'a'.repeat(40)}`,
  name: 'W',
  tags: [],
  chain,
  source: 'manual',
});

test('legacy migration preserves partial progress, removes orphan jobs, and is idempotent', () => {
  open(':memory:');
  const current = wallet();
  const staleIdentity = insertWallet({
    address: `0x${'b'.repeat(40)}`,
    name: 'stale',
    tags: [],
    chain: 'base',
    source: 'manual',
  });
  const completedBefore = ca(1);
  const stillPending = ca(2);
  const completedAfter = ca(4);
  const outsideLegacyScope = ca(3);
  insertTrackedCa({ address: outsideLegacyScope, chain: 'base', note: '' });

  getDb().exec(`
    CREATE TABLE wallet_holdings_discovery (
      wallet_id TEXT PRIMARY KEY, address TEXT, chain TEXT, cas TEXT, done TEXT,
      generation INTEGER, retry_at INTEGER, attempts INTEGER
    )
  `);
  const insertLegacy = getDb().prepare('INSERT INTO wallet_holdings_discovery VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertLegacy.run(current.id, current.address, current.chain, JSON.stringify([completedBefore, stillPending, completedAfter]),
    JSON.stringify([completedBefore, completedAfter]), 2, 0, 0);
  insertLegacy.run('orphan', current.address, current.chain, '[]', '[]', 1, 0, 0);
  insertLegacy.run(staleIdentity.id, `0x${'c'.repeat(40)}`, staleIdentity.chain,
    JSON.stringify([completedBefore]), JSON.stringify([completedBefore]), 1, 0, 0);

  initializeDiscoveryState();
  initializeDiscoveryState();
  assert.equal(getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='wallet_holdings_discovery'").get(), undefined);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM wallet_discovery_wallets').get() as { n: number }).n, 2);

  const batch = readDiscoveryBatch(current.id, 100, Infinity);
  assert.ok(batch);
  assert.deepEqual(batch.targets.map(({ ca: address }) => address).sort(), [outsideLegacyScope, stillPending].sort());
  assert.equal(batch.targets.some(({ ca: address }) => address === completedBefore || address === completedAfter), false);
  const staleBatch = readDiscoveryBatch(staleIdentity.id, 100, Infinity);
  assert.ok(staleBatch);
  assert.ok(staleBatch.targets.some(({ ca: address }) => address === completedBefore));
});

test('chain-scoped targets let an in-flight commit survive an unrelated CA addition', () => {
  open(':memory:');
  const evm = wallet('base');
  const sol = wallet('sol');
  const first = ca(10);
  syncDiscoveryTargets([{ address: first, chain: 'base' }]);
  ensureDiscoveryWallet(evm);
  ensureDiscoveryWallet(sol);
  const batch = readDiscoveryBatch(evm.id, 1, 10);
  assert.ok(batch);

  const added = ca(11);
  syncDiscoveryTargets([{ address: added, chain: 'base' }]);
  assert.equal(commitDiscoveryBatch(batch, [{ ca: first, amount: 5 }], () => {}, 2), true);
  assert.ok(readDiscoveryBatch(evm.id, 3, 10)?.targets.some(({ ca: address }) => address === added));
  assert.equal(readDiscoveryBatch(sol.id, 3, 10), undefined);
});

test('same-CA refreshes remain pending and omitted rows retry without erasing old balances', () => {
  open(':memory:');
  const current = wallet();
  const first = ca(20);
  const omitted = ca(21);
  insertTrackedCa({ address: first, chain: 'base', note: '' });
  insertTrackedCa({ address: omitted, chain: 'base', note: '' });
  syncDiscoveryTargets([{ address: first, chain: 'base' }, { address: omitted, chain: 'base' }]);
  ensureDiscoveryWallet(current);
  getDb().prepare(`
    INSERT INTO wallet_token_state(wallet_id, ca, balance_usd, token_amount, chain)
    VALUES (?, ?, NULL, 9, ?)
  `).run(current.id, omitted, 'base');

  const batch = readDiscoveryBatch(current.id, 10, 10);
  assert.ok(batch);
  assert.equal(commitDiscoveryBatch(batch, [{ ca: first, amount: 0 }], () => {}, 10), true);
  assert.equal(pendingDiscoveryPairs().has(`base:${omitted}`), true);
  assert.equal((getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=?')
    .get(current.id, omitted) as { token_amount: number }).token_amount, 9);
  assert.equal(readDiscoveryBatch(current.id, 20, 10), undefined);
  assert.equal(nextDiscoveryRunAt(), 30_010);

  syncDiscoveryTargets([{ address: first, chain: 'base' }], true);
  assert.equal(pendingDiscoveryPairs().has(`base:${first}`), true);
});

test('an identity change away and back invalidates an earlier batch by epoch', () => {
  open(':memory:');
  const current = wallet();
  const target = ca(30);
  insertTrackedCa({ address: target, chain: 'base', note: '' });
  syncDiscoveryTargets([{ address: target, chain: 'base' }]);
  const original = ensureDiscoveryWallet(current);
  const batch = readDiscoveryBatch(current.id, 1, 10);
  assert.ok(batch);

  const away = updateWallet(current.id, {
    address: `0x${'b'.repeat(40)}`,
    name: current.name,
    tags: [],
    chain: 'base',
    source: current.source,
  });
  assert.ok(away);
  ensureDiscoveryWallet(away);
  const back = updateWallet(current.id, {
    address: current.address,
    name: current.name,
    tags: [],
    chain: 'base',
    source: current.source,
  });
  assert.ok(back);
  ensureDiscoveryWallet(back);

  assert.equal(commitDiscoveryBatch(batch, [{ ca: target, amount: 7 }], () => {}, 2), false);
  assert.ok(ensureDiscoveryWallet(back).epoch > original.epoch);
  assert.equal(pendingDiscoveryPairs().has(`base:${target}`), true);
});

test('inactive CAs lose queued targets and late discovery results cannot be applied', () => {
  open(':memory:');
  const target = insertTrackedCa({ address: ca(7), chain: 'base', note: '' });
  const member = wallet();
  initializeDiscoveryState();
  const batch = readDiscoveryBatch(member.id, Date.now(), Infinity);
  assert.ok(batch);
  assert.ok(batch.targets.some(({ ca: address }) => address === target.address));

  getDb().prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?").run(target.id);
  pruneDiscoveryTargets();
  const applied: { ca: string; amount: number }[] = [];
  assert.equal(commitDiscoveryBatch(batch, [{ ca: target.address, amount: 10 }], (rows) => applied.push(...rows), Date.now()), true);
  assert.deepEqual(applied, []);
  assert.equal(
    (getDb().prepare('SELECT COUNT(*) AS n FROM wallet_discovery_targets WHERE chain=? AND ca=?').get('base', target.address) as { n: number }).n,
    0,
  );
});
