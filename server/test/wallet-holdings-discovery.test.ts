import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDb, insertTrackedCa, insertWallet, open } from '../src/db.js';
import { walletDiscoveryIdle, enqueueWalletDiscovery, enqueueWalletDiscoveriesForCas, enqueueAllWalletDiscoveries, configureWalletDiscovery, pendingWalletDiscoveryPairs } from '../src/wallet-holdings-discovery.js';
import { readDiscoveryBatch } from '../src/wallet-discovery-state.js';
import { trackedWalletStats } from '../src/signals.js';

const SOL_CA = 'sol-discovery-no-buy-111111111111111111111111111111';
const ca = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const provider = (fn: (wallet: string, chain: string, cas: readonly string[]) => Promise<{ca:string;amount:number}[]>) => ({
  walletTokenHoldings: fn as never,
});
const idleDeps = { sleep: async () => undefined };

function setup() {
  open(':memory:');
  const wallet = insertWallet({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'EVM', tags: [], chain: 'base', source: 'manual' });
  return wallet;
}

test('discovers no-BUY SOL and EVM positive holdings as dashboard members', async () => {
  open(':memory:');
  insertTrackedCa({ address: SOL_CA, chain: 'sol', note: '' });
  const sol = insertWallet({ address: '11111111111111111111111111111111', name: 'SOL', tags: [], chain: 'sol', source: 'manual' });
  configureWalletDiscovery(provider(async () => []), { ...idleDeps, solRpc: { getTokenAccountsByOwner: async () => new Map([[SOL_CA, 8]]) } as never });
  enqueueWalletDiscovery(sol);
  assert.equal(pendingWalletDiscoveryPairs().has(`sol:${SOL_CA}`), true);
  await walletDiscoveryIdle();
  assert.equal(pendingWalletDiscoveryPairs().has(`sol:${SOL_CA}`), false);
  const evmCa = ca(1);
  insertTrackedCa({ address: evmCa, chain: 'base', note: '' });
  const evm = insertWallet({ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'EVM', tags: [], chain: 'base', source: 'manual' });
  configureWalletDiscovery(provider(async (_wallet, _chain, cas) => cas.map((address) => ({ ca: address, amount: 3 })) as never), idleDeps);
  enqueueWalletDiscovery(evm);
  await walletDiscoveryIdle();
  assert.equal(trackedWalletStats(evmCa, 'base', Date.now()).length, 1);
});

test('full discovery scopes each wallet to its own chain', () => {
  open(':memory:');
  const solCa = SOL_CA;
  const baseCa = ca(2);
  insertTrackedCa({ address: solCa, chain: 'sol', note: '' });
  insertTrackedCa({ address: baseCa, chain: 'base', note: '' });
  const sol = insertWallet({ address: '11111111111111111111111111111111', name: 'SOL', tags: [], chain: 'sol', source: 'manual' });
  const evm = insertWallet({ address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'EVM', tags: [], chain: 'base', source: 'manual' });
  enqueueWalletDiscovery(sol);
  enqueueWalletDiscovery(evm);
  assert.equal(enqueueAllWalletDiscoveries(), 2);

  const solBatch = readDiscoveryBatch(sol.id, Date.now(), Infinity);
  const evmBatch = readDiscoveryBatch(evm.id, Date.now(), Infinity);
  assert.deepEqual(solBatch?.targets.map(({ ca: address }) => address), [solCa]);
  assert.deepEqual(evmBatch?.targets.map(({ ca: address }) => address), [baseCa]);
});

test('EVM batches of 100 drain automatically through the complete CA scope', async () => {
  const wallet = setup();
  const cas = Array.from({ length: 205 }, (_, index) => ca(index + 1));
  for (const address of cas) insertTrackedCa({ address, chain: 'base', note: '' });
  const batchSizes: number[] = [];
  configureWalletDiscovery(provider(async (_address, _chain, requested) => {
    batchSizes.push(requested.length);
    return requested.map((address) => ({ ca: address, amount: 1 })) as never;
  }), idleDeps);
  enqueueWalletDiscovery(wallet);
  await walletDiscoveryIdle();
  assert.deepEqual(batchSizes, [100, 100, 5]);
  const progress = getDb().prepare('SELECT frontier FROM wallet_discovery_wallets WHERE wallet_id=?').get(wallet.id) as {frontier:number};
  const latestTarget = getDb().prepare("SELECT MAX(revision) AS revision FROM wallet_discovery_targets WHERE chain='base'").get() as {revision:number};
  const retries = (getDb().prepare('SELECT COUNT(*) AS n FROM wallet_discovery_exceptions WHERE wallet_id=?').get(wallet.id) as {n:number}).n;
  assert.equal(progress.frontier, latestTarget.revision);
  assert.equal(retries, 0, 'successful CA rows are represented by the frontier, not per-CA completion records');
  assert.equal(pendingWalletDiscoveryPairs().size, 0);
});

test('provider failures and omitted rows preserve balances and retry incomplete pairs', async () => {
  const wallet = setup();
  const token = ca(77);
  insertTrackedCa({ address: token, chain: 'base', note: '' });
  getDb().prepare('INSERT INTO wallet_token_state(wallet_id,ca,balance_usd,token_amount,chain) VALUES(?,?,NULL,9,?)').run(wallet.id, token, 'base');
  configureWalletDiscovery(provider(async () => { throw new Error('offline'); }), idleDeps);
  enqueueWalletDiscovery(wallet);
  await walletDiscoveryIdle();
  assert.equal((getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=?').get(wallet.id, token) as {token_amount:number}).token_amount, 9);
  const walletState = getDb().prepare('SELECT retry_at FROM wallet_discovery_wallets WHERE wallet_id=?').get(wallet.id) as {retry_at:number};
  assert.ok(walletState.retry_at > Date.now());

  getDb().prepare('UPDATE wallet_discovery_wallets SET retry_at=0 WHERE wallet_id=?').run(wallet.id);
  configureWalletDiscovery(provider(async () => []), idleDeps);
  await walletDiscoveryIdle();
  assert.equal((getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=?').get(wallet.id, token) as {token_amount:number}).token_amount, 9);
  const exception = getDb().prepare('SELECT completed,retry_at FROM wallet_discovery_exceptions WHERE wallet_id=? AND ca=?').get(wallet.id, token) as {completed:number;retry_at:number};
  assert.deepEqual(exception.completed, 0);
  assert.ok(exception.retry_at > Date.now());
});

test('adding a CA during an in-flight read keeps its valid result and drains the new target', async () => {
  const wallet = setup();
  const first = ca(88), second = ca(89);
  insertTrackedCa({ address: first, chain: 'base', note: '' });
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let blocked = true;
  configureWalletDiscovery(provider(async (_address, _chain, requested) => {
    if (blocked) {
      blocked = false;
      started();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return requested.map((address) => ({ ca: address, amount: address === first ? 4 : 9 })) as never;
  }), idleDeps);
  enqueueWalletDiscovery(wallet);
  const sweep = walletDiscoveryIdle();
  await startedPromise;
  insertTrackedCa({ address: second, chain: 'base', note: '' });
  enqueueWalletDiscoveriesForCas([{ address: second, chain: 'base' }]);
  release();
  await sweep;

  const rows = getDb().prepare('SELECT ca,token_amount FROM wallet_token_state WHERE wallet_id=? ORDER BY ca').all(wallet.id);
  assert.deepEqual(rows, [{ ca: first, token_amount: 4 }, { ca: second, token_amount: 9 }]);
  assert.equal(pendingWalletDiscoveryPairs().size, 0);
});

test('a wallet identity change rejects the old response before scanning the new identity', async () => {
  const wallet = setup();
  const token = ca(90);
  const changedAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
  insertTrackedCa({ address: token, chain: 'base', note: '' });
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const queried: string[] = [];
  configureWalletDiscovery(provider(async (address, _chain, requested) => {
    queried.push(address);
    if (address === wallet.address) {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return requested.map((ca) => ({ ca, amount: 99 })) as never;
    }
    return requested.map((ca) => ({ ca, amount: 5 })) as never;
  }), idleDeps);
  enqueueWalletDiscovery(wallet);
  const sweep = walletDiscoveryIdle();
  await startedPromise;
  getDb().prepare('UPDATE wallets SET address=? WHERE id=?').run(changedAddress, wallet.id);
  release();
  await sweep;

  assert.deepEqual(queried, [wallet.address, changedAddress]);
  assert.equal((getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=?').get(wallet.id, token) as {token_amount:number}).token_amount, 5);
});
