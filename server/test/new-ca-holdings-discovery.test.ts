import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/api.js';
import { config } from '../src/config.js';
import { getDb, insertFomoUser, insertTrackedCa, insertWallet, open } from '../src/db.js';
import { enqueueFomoDiscovery, fomoDiscoveryIdle, stopFomoDiscovery } from '../src/fomo-balance-discovery.js';
import { fomoUserStats, trackedWalletStats } from '../src/signals.js';
import { SPL_TOKEN_PROGRAM_ID } from '../src/providers/solana.js';
import { configureWalletDiscovery, enqueueAllWalletDiscoveries, walletDiscoveryIdle } from '../src/wallet-holdings-discovery.js';
import { createTestAuth } from './auth-testkit.js';

const SOL_CA = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const SOL_A = '3aR2xbqmWd8vxkFNraWMCYb6vUEgLvW4bJTo7bjWGdAu';
const SOL_B = '3bzaJd5yZG73EVDz8xosQb7gfZm2LN5auFGh6wnP1n1f';
const EVM_A = `0x${'a'.repeat(40)}`;
const EVM_B = `0x${'b'.repeat(40)}`;
const CA1 = `0x${'1'.repeat(40)}`;
const CA2 = `0x${'2'.repeat(40)}`;
let adminToken = '';
const originalFetch = globalThis.fetch;
const originalShowFomo = config.showFomo;
const originalUrl = config.fomoProdUrl;
let server: Server;
let base: string;

beforeEach(async () => {
  open(':memory:');
  config.showFomo = true;
  config.fomoProdUrl = '';
  const auth = await createTestAuth();
  adminToken = await auth.signToken(auth.adminEmail);
  server = createApp('ca-discovery-test', auth.deps).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.showFomo = originalShowFomo;
  config.fomoProdUrl = originalUrl;
  stopFomoDiscovery();
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
});

async function addCa(address: string, chain: string): Promise<void> {
  const response = await originalFetch(`${base}/api/tracked-cas`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ address, chain, note: '' }),
  });
  assert.equal(response.status, 201, await response.text());
}
function quote(ca: string, chain: string): void {
  getDb().prepare('INSERT INTO token_state(ca,chain,price,supply,market_cap,fetched_at) VALUES(?,?,2,1000,2000,?)')
    .run(ca, chain, Date.now());
}

test('adding a SOL CA discovers every long-held wallet and FOMO user without creating trades', async () => {
  const a = insertWallet({ address: SOL_A, name: 'long-held-A', tags: ['keep'], chain: 'sol', source: 'manual' });
  insertWallet({ address: SOL_B, name: 'long-held-B', tags: [], chain: 'sol', source: 'manual' });
  const evm = insertWallet({ address: EVM_A, name: 'unrelated', tags: [], chain: 'base', source: 'manual' });
  insertFomoUser({ handle: 'quiet-one', user_id: 'quiet-one-id' });
  insertFomoUser({ handle: 'quiet-two', user_id: 'quiet-two-id' });
  configureWalletDiscovery({ walletTokenHoldings: async () => { throw new Error('SOL add must not query EVM'); } }, {
    sleep: async () => {},
    solRpc: { getTokenAccountsByOwner: async (wallet, filter) => {
      if (typeof filter === 'object' && 'mint' in filter && filter.mint === SOL_CA) {
        return new Map([[SOL_CA, wallet === SOL_A ? 7 : 11]]);
      }
      return new Map(filter === SPL_TOKEN_PROGRAM_ID ? [[SOL_CA, wallet === SOL_A ? 7 : 11]] : []);
    } },
  });
  enqueueAllWalletDiscoveries();
  await walletDiscoveryIdle(); // Pre-existing wallets have completed their empty discovery.
  config.fomoProdUrl = 'https://new-ca-fomo.test';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.startsWith(config.fomoProdUrl)) return originalFetch(input, init);
    if (url.endsWith('/health')) return new Response('{"ok":true}');
    assert.ok(url.endsWith('/balances'));
    const amount = url.includes('quiet-one-id') ? 13 : 19;
    return new Response(JSON.stringify({ success: true, responseObject: { balances: [{
      tokenFilterResult: { token: { address: SOL_CA, networkId: 1399811149 }, priceUSD: '2' },
      userToken: { humanAmountRemaining: amount, totalCostBasisUsd: 0 },
    }] } }));
  }) as typeof fetch;
  await addCa(SOL_CA, 'sol');
  quote(SOL_CA, 'sol');
  await walletDiscoveryIdle();
  await fomoDiscoveryIdle();
  const wallets = trackedWalletStats(SOL_CA, 'sol', Date.now());
  assert.deepEqual(wallets.map((row) => [row.name, row.holdingAmount, row.balUsd]).sort(), [
    ['long-held-A', 7, 14], ['long-held-B', 11, 22],
  ]);
  assert.deepEqual(fomoUserStats(SOL_CA, 'sol', Date.now()).map((row) => [row.handle, row.holdingAmount, row.balUsd]).sort(), [
    ['quiet-one', 13, 26], ['quiet-two', 19, 38],
  ]);
  assert.deepEqual(JSON.parse((getDb().prepare('SELECT tags FROM wallets WHERE id=?').get(a.id) as {tags:string}).tags), ['keep']);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM wallet_token_state WHERE wallet_id=?').get(evm.id) as {n:number}).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM wallet_trades').get() as {n:number}).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades').get() as {n:number}).n, 0);
});

test('adding a CA during an inflight discovery retains both CAs for every same-chain wallet', async () => {
  const a = insertWallet({ address: EVM_A, name: 'A', tags: [], chain: 'base', source: 'manual' });
  const b = insertWallet({ address: EVM_B, name: 'B', tags: [], chain: 'base', source: 'manual' });
  insertWallet({ address: EVM_A, name: 'BSC', tags: [], chain: 'bsc', source: 'manual' });
  enqueueAllWalletDiscoveries();
  configureWalletDiscovery({ walletTokenHoldings: async () => [] }, { sleep: async () => {} });
  await walletDiscoveryIdle();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let first = true;
  configureWalletDiscovery({ walletTokenHoldings: async (_wallet, chain, cas) => {
    assert.equal(chain, 'base');
    if (first) { first = false; started(); await blocked; }
    return (cas ?? []).map((ca) => ({ ca, amount: ca === CA1 ? 5 : 9 }));
  } }, { sleep: async () => {} });
  await addCa(CA1, 'base');
  const sweep = walletDiscoveryIdle();
  await entered;
  try { await addCa(CA2, 'base'); } finally { release(); }
  await sweep;
  for (const [ca, amount] of [[CA1, 5], [CA2, 9]] as const) {
    const rows = getDb().prepare("SELECT wallet_id,token_amount FROM wallet_token_state WHERE chain='base' AND ca=? ORDER BY wallet_id").all(ca);
    assert.deepEqual(rows, [{ wallet_id: a.id, token_amount: amount }, { wallet_id: b.id, token_amount: amount }].sort((x, y) => x.wallet_id.localeCompare(y.wallet_id)));
  }
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM wallet_token_state WHERE chain='bsc'").get() as {n:number}).n, 0);
});

test('reactivating an inactive CA rescans wallets with no BUY history', async () => {
  const wallet = insertWallet({ address: EVM_A, name: 'legacy', tags: [], chain: 'eth', source: 'manual' });
  const ca = insertTrackedCa({ address: CA1, chain: 'eth', note: '' });
  enqueueAllWalletDiscoveries();
  configureWalletDiscovery({ walletTokenHoldings: async (_address, _chain, cas) => (cas ?? []).map((address) => ({ ca: address, amount: 0 })) }, { sleep: async () => {} });
  await walletDiscoveryIdle();
  getDb().prepare("UPDATE tracked_cas SET status='inactive' WHERE id=?").run(ca.id);
  configureWalletDiscovery({ walletTokenHoldings: async (_address, chain, cas) => {
    assert.equal(chain, 'eth');
    return (cas ?? []).map((address) => ({ ca: address, amount: 21 }));
  } }, { sleep: async () => {} });
  await addCa(CA1, 'eth');
  await walletDiscoveryIdle();
  assert.equal((getDb().prepare("SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=? AND chain='eth'").get(wallet.id, CA1) as {token_amount:number}|undefined)?.token_amount, 21);
});
test('balance discovery ignores CAs added before deployment even while still tracked', async () => {
  const wallet = insertWallet({ address: SOL_A, name: 'tracked-wallet', tags: [], chain: 'sol', source: 'manual' });
  const fomo = insertFomoUser({ handle: 'old-holder', user_id: 'old-holder-id' });
  insertTrackedCa({ address: SOL_CA, chain: 'sol', note: 'pre-tracked' });
  const historical = insertTrackedCa({ address: SOL_B, chain: 'sol', note: 'legacy-note' });
  getDb().prepare("UPDATE tracked_cas SET added_at='2020-01-02T03:04:05.000Z' WHERE id=?").run(historical.id);
  const trackedBefore = getDb().prepare('SELECT id,address,chain,note,added_at,status FROM tracked_cas ORDER BY address').all();

  configureWalletDiscovery({ walletTokenHoldings: async () => [] }, {
    sleep: async () => {},
    solRpc: { getTokenAccountsByOwner: async (_address, filter) => {
      assert.deepEqual(filter, { mint: SOL_CA });
      return new Map([[SOL_CA, 7], [SOL_B, 99]]);
    } },
  });
  config.fomoProdUrl = 'https://old-holdings-fomo.test';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.startsWith(config.fomoProdUrl)) return originalFetch(input, init);
    if (url.endsWith('/health')) return new Response('{"ok":true}');
    assert.ok(url.endsWith('/balances'));
    return new Response(JSON.stringify({ success: true, responseObject: { balances: [
      { tokenFilterResult: { token: { address: SOL_CA, networkId: 1399811149 }, priceUSD: '2' },
        userToken: { humanAmountRemaining: 8, totalCostBasisUsd: 0 } },
      { tokenFilterResult: { token: { address: SOL_B, networkId: 1399811149 }, priceUSD: '2' },
        userToken: { humanAmountRemaining: 99, totalCostBasisUsd: 0 } },
    ] } }));
  }) as typeof fetch;

  enqueueAllWalletDiscoveries();
  await walletDiscoveryIdle();
  enqueueFomoDiscovery(fomo);
  await fomoDiscoveryIdle();
  const outcome = getDb().prepare("SELECT last_outcome FROM fomo_api_request_state WHERE fomo_user_id=? AND endpoint='balances'")
    .get(fomo.id) as { last_outcome: string } | undefined;
  assert.equal(outcome?.last_outcome, 'success');

  assert.deepEqual(getDb().prepare('SELECT id,address,chain,note,added_at,status FROM tracked_cas ORDER BY address').all(),
    trackedBefore);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM wallet_token_state WHERE wallet_id=? AND ca=?')
    .get(wallet.id, SOL_B) as { n: number }).n, 0);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM fomo_api_holdings WHERE fomo_user_id=? AND ca=?')
    .get(fomo.id, SOL_B) as { n: number }).n, 0);
  assert.equal((getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=?')
    .get(wallet.id, SOL_CA) as { token_amount: number }).token_amount, 7);
  assert.equal((getDb().prepare('SELECT amount FROM fomo_api_holdings WHERE fomo_user_id=? AND ca=?')
    .get(fomo.id, SOL_CA) as { amount: number }).amount, 8);
});
