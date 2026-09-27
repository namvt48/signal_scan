import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertTrackedCa, insertWallet, open } from '../src/db.js';
import { kickWallet, kickWalletHoldingsFor, pacedFor, setPollerDeps, walletSweep } from '../src/poller.js';
import { insertTrades, replaceWalletBalances, updateTokenMetrics } from '../src/ingest.js';
import type { MarketDataProvider } from '../src/providers/provider.js';

let walletId = '';

before(() => {
  open(':memory:');
  walletId = insertWallet({ address: 'wallet-addr-1', name: 'CT01', tags: [], chain: 'sol', source: 'test' }).id;
});

// walletSweep is holdings-only (free Solana RPC) and LINKED-ONLY (user 2026-09-23):
// it refreshes the wallets a tracked CA is `Tracked by` and never spends an RPC call
// on a wallet no tracked CA links to. Trades are not part of any sweep (the wallet-watch
// detector owns them), so this path is fully independent.
test('walletSweep: writes holdings for linked wallets only, never queries the rest', async () => {
  const seen: string[] = [];
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => ({}),
    walletTokenHoldings: async (address: string) => {
      seen.push(address);
      return [{ ca: 'CA1', amount: 123 }];
    },
  };
  setPollerDeps(provider, {} as never);

  insertTrackedCa({ address: 'CA1', chain: 'sol', note: 'test' });
  insertTrades(
    walletId,
    [{ tx: 'tx-sweep-1', ts: Date.now(), side: 'buy', ca: 'CA1', chain: 'sol', amountUsd: 100, price: 1 }],
    'watch',
  );
  const unlinkedId = insertWallet({ address: 'wallet-addr-unlinked', name: 'CT99', tags: [], chain: 'sol', source: 'test' }).id;

  await walletSweep(provider); // must resolve

  const row = getDb()
    .prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
    .get(walletId, 'CA1') as { token_amount: number } | undefined;
  assert.ok(row, 'wallet_token_state row missing — the RPC holdings write did not land');
  assert.equal(row?.token_amount, 123);
  assert.deepEqual(seen, ['wallet-addr-1'], 'walletSweep queried a wallet no tracked CA links to');
  assert.equal(
    getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ?').get(unlinkedId),
    undefined,
    'unlinked wallet got a holdings row',
  );
});

// The on-demand sibling caller: a user-triggered wallet kick writes the same
// credit-free RPC holdings immediately.
test('kickWallet: writes the credit-free RPC holdings', async () => {
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => ({}),
    walletTokenHoldings: async () => [{ ca: 'CA2', amount: 456 }],
  };
  setPollerDeps(provider, {} as never);

  const kickWalletId = insertWallet({ address: 'wallet-addr-2', name: 'CT02', tags: [], chain: 'sol', source: 'test' }).id;
  const row = () =>
    getDb()
      .prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
      .get(kickWalletId, 'CA2') as { token_amount: number } | undefined;

  kickWallet(provider, kickWalletId, 'kick-addr-1', 'sol', ['CA2']);
  for (let i = 0; i < 100 && !row(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(row()?.token_amount, 456, 'kickWallet: activity 403 gated the holdings write');
});

// Per-endpoint cadence split: each sweep writes ONLY the columns its endpoint
// owns, and the first write creates the row — a CA whose essential pass failed
// must still get its gini card instead of writing nowhere.
test('updateTokenMetrics: writes only the provided keys, creates the row', () => {
  const read = () =>
    getDb()
      .prepare('SELECT volume24h, nansen_holders, nansen_fresh_pct, nansen_t100_pct FROM token_state WHERE ca = ? AND chain = ?')
      .get('CA-METRICS', 'sol') as
      | { volume24h: number | null; nansen_holders: number | null; nansen_fresh_pct: number | null; nansen_t100_pct: number | null }
      | undefined;

  assert.equal(read(), undefined, 'precondition: the row must not exist yet');
  updateTokenMetrics('CA-METRICS', 'sol', { nansenHolders: 10, nansenFreshPct: 5 });
  assert.equal(read()?.nansen_holders, 10, 'the first write must create the row');

  updateTokenMetrics('CA-METRICS', 'sol', { volume24h: 7 });
  assert.equal(read()?.volume24h, 7);
  assert.equal(read()?.nansen_holders, 10, 'the volume sweep wiped the gini card');

  updateTokenMetrics('CA-METRICS', 'sol', { nansenT100Pct: 42 });
  updateTokenMetrics('CA-METRICS', 'sol', { nansenHolders: 11 });
  assert.equal(read()?.nansen_t100_pct, 42, 'an omitted optional gini field must keep its value');
});

// The writer the pair sweeps feed: a (wallet, CA) row is replaced in isolation, and a
// pair the RPC reports as 0 must be DELETED — a sold-out position that froze at its last
// nonzero value is the bug this scoping introduced.
test('replaceWalletBalances: pair-scoped — 0 deletes that pair and leaves the sibling CAs alone', () => {
  const id = insertWallet({ address: 'wallet-addr-pair', name: 'PAIR', tags: [], chain: 'sol', source: 'test' }).id;
  const read = (ca: string) =>
    getDb()
      .prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
      .get(id, ca) as { token_amount: number } | undefined;

  replaceWalletBalances(id, 'sol', [{ ca: 'P-1', amount: 5 }, { ca: 'P-2', amount: 7 }]);
  assert.equal(read('P-1')?.token_amount, 5);

  replaceWalletBalances(id, 'sol', [{ ca: 'P-1', amount: 0 }]);
  assert.equal(read('P-1'), undefined, 'a sold-out pair must decay to zero, not freeze');
  assert.equal(read('P-2')?.token_amount, 7, 'an unrelated CA of the same wallet was wiped');
});

// Pacing invariant: a request slower than its slot must EAT the slot, not have
// the slot added after it. Additive pacing made every pass cost 0.8×interval
// plus n×requestCost, so the 15m tiers overran their own interval (1007s vs 900s).
test('pacedFor: a slow request consumes its slot instead of adding the gap on top', async () => {
  // interval 300ms × pace 0.8 / 3 items = 80ms, which the 250ms floor raises to
  // 250ms — so a 300ms request is slower than its slot and must absorb it.
  const costMs = 300;
  const started = Date.now();
  await pacedFor([0, 1, 2], 300, async () => {
    await new Promise((r) => setTimeout(r, costMs));
  });
  const elapsed = Date.now() - started;

  // Fixed-rate: ~3×300=900ms. Additive: ~3×300 + 2×250=1400ms.
  assert.ok(elapsed < 1200, `the gap was added on top of the request: got ${elapsed}ms, expected ~${3 * costMs}ms`);
});

// Fast CA→wallet attach (A): on insert, refresh holdings immediately so the linked
// wallet's balance lands in ~1s instead of waiting out the 15m walletSweep. Only the
// wallets the watch BUY already linked are read; coalesced per chain, sol-only.
test("kickWalletHoldingsFor: reads only the CAs' linked wallets, coalesces per chain, skips non-sol", async () => {
  const calls: string[] = [];
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => ({}),
    walletTokenHoldings: async (wallet) => {
      calls.push(wallet);
      return wallet === 'hold-addr' ? [{ ca: 'CA-HOLD', amount: 777 }] : [];
    },
  };
  setPollerDeps(provider, {} as never);
  const solId = insertWallet({ address: 'hold-addr', name: 'HOLD1', tags: [], chain: 'sol', source: 'test' }).id;
  insertWallet({ address: 'idle-addr', name: 'IDLE', tags: [], chain: 'sol', source: 'test' });
  insertWallet({ address: 'hold-eth', name: 'HOLD-ETH', tags: [], chain: 'eth', source: 'test' });
  // The watch BUY IS the link (signals.trackedByNames) — the only thing that puts
  // this wallet in scope, which is why the kick never needs the other wallets.
  insertTrades(solId, [{ tx: 'tx-link', ts: Date.now(), side: 'buy', ca: 'CA-HOLD', chain: 'sol', amountUsd: 1, price: 1 }], 'watch');

  kickWalletHoldingsFor([{ address: 'CA-HOLD', chain: 'sol' }]);
  kickWalletHoldingsFor([{ address: 'CA-HOLD-2', chain: 'sol' }]); // same chain, still in flight
  kickWalletHoldingsFor([{ address: 'CA-ETH', chain: 'eth' }]);

  const row = () =>
    getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?').get(solId, 'CA-HOLD') as
      | { token_amount: number }
      | undefined;
  for (let i = 0; i < 100 && !row(); i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(row()?.token_amount, 777, 'the holding was not attached immediately');
  assert.equal(calls.filter((a) => a === 'hold-addr').length, 1, 'a second kick for the same chain must coalesce');
  assert.equal(calls.filter((a) => a === 'idle-addr').length, 0, 'a wallet with no watch BUY link must not be queried');
  assert.equal(calls.filter((a) => a === 'hold-eth').length, 0, 'the non-sol credit door must be skipped');
});
