import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/api.js';
import { config } from '../src/config.js';
import { findTrackedCa, getDb, importWallets, insertFomoTrade, insertFomoUser, insertTrackedCa, insertWallet, listTrackedCas, listWallets, open, reactivateTrackedCa, syncFomoPositionsSnapshot } from '../src/db.js';
import { assembleSignals } from '../src/signals.js';
import { createTestAuth, TEST_SERVICE_TOKEN } from './auth-testkit.js';

const SOL_CA = '11111111111111111111111111111111';
const SOL_WALLET = '11111111111111111111111111111111';
const EVM_CA = `0x${'a'.repeat(40)}`;
const previousShowFomo = config.showFomo;
const previousFomoProdUrl = config.fomoProdUrl;
let dir = '';
let base = '';
let userId = '';
let adminToken = '';
let solWalletId = '';
let server: Server;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fomo-chain-policy-'));
  const path = join(dir, 'legacy.db');
  config.showFomo = false;
  open(path);
  insertTrackedCa({ address: SOL_CA, chain: 'sol', note: 'legacy', entryUsd: 100 });
  insertTrackedCa({ address: EVM_CA, chain: 'base', note: 'legacy', entryUsd: 100 });
  const solWallet = insertWallet({ address: SOL_WALLET, chain: 'sol', name: 'Legacy SOL', tags: [], source: 'test' });
  solWalletId = solWallet.id;
  userId = insertFomoUser({ handle: 'chain-policy-user' }).id;
  insertFomoTrade({ fomo_user_id: userId, event_id: 'legacy-sol-trade', ca: SOL_CA, chain: 'sol', type: 'buy', ts: Date.now() });
  getDb().close();
  config.showFomo = true;
  open(path);
  config.fomoProdUrl = '';
  const auth = await createTestAuth();
  adminToken = await auth.signToken(auth.adminEmail);
  server = createApp('fomo-chain-policy', auth.deps).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  getDb().close();
  config.fomoProdUrl = previousFomoProdUrl;
  config.showFomo = previousShowFomo;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function request(
  path: string,
  body?: unknown,
  token = TEST_SERVICE_TOKEN,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('FOMO startup deactivates legacy Solana tracking without deleting history or other chains', () => {
  assert.equal(findTrackedCa(SOL_CA, 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa(EVM_CA, 'base')?.status, 'queued');
  assert.equal((getDb().prepare('SELECT count(*) AS n FROM fomo_trades WHERE event_id = ?').get('legacy-sol-trade') as { n: number }).n, 1);
  assert.equal(listTrackedCas().some((ca) => ca.chain === 'sol'), false);
  assert.equal(listTrackedCas(true).some((ca) => ca.chain === 'sol'), false);
  assert.equal(assembleSignals(Date.now(), true).some((signal) => signal.chain === 'sol'), false);
  assert.equal(listWallets().some((wallet) => wallet.chain === 'sol'), false);
  assert.equal(reactivateTrackedCa(SOL_CA, 'sol'), undefined);
  syncFomoPositionsSnapshot(userId, [{ fomo_user_id: userId, ca: SOL_CA, chain: 'sol', trade_id: 'old-position', status: 'open', amount: 1, cost_basis_usd: 100, avg_entry_price: 1, price_usd: 1, fetched_at: Date.now() }], Date.now());
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM fomo_positions WHERE chain = 'sol'").get() as { n: number }).n, 0);
});

test('FOMO API drops Solana buys, sells, wallet events and direct enqueue before writes', async () => {
  for (const type of ['buy', 'sell']) {
    const result = await request('/api/fomo-watch/trades', { eventId: `disabled-sol-${type}`, trader: 'chain-policy-user', type, tokenAddress: SOL_CA, chain: 'sol', ts: Date.now(), tradeUsd: 100 });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { inserted: 0, skipped: 'chain-disabled' });
  }
  const enqueue = await request('/api/tracked-cas', { address: SOL_CA, chain: 'sol', note: 'manual' });
  assert.equal(enqueue.status, 200);
  assert.deepEqual(enqueue.body, { skipped: 'chain-disabled' });
  const walletEvent = await request('/api/wallet-watch/trades', { wallet: SOL_WALLET, tx: 'disabled-sol-tx', ca: SOL_CA, chain: 'sol', side: 'buy', ts: Date.now(), amountUsd: 100 });
  assert.equal(walletEvent.status, 200);
  assert.deepEqual(walletEvent.body, { inserted: 0, skipped: 'chain-disabled' });
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM fomo_trades WHERE event_id LIKE 'disabled-sol-%'").get() as { n: number }).n, 0);
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM wallet_trades WHERE tx = 'disabled-sol-tx'").get() as { n: number }).n, 0);
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM alert_metric_observations WHERE chain = 'sol'").get() as { n: number }).n, 0);
  assert.equal(findTrackedCa(SOL_CA, 'sol', true)?.status, 'inactive');
  const evm = await request('/api/fomo-watch/trades', { eventId: 'enabled-base-buy', trader: 'chain-policy-user', type: 'buy', tokenAddress: EVM_CA, chain: 'base', ts: Date.now(), usdValue: 100 });
  assert.equal(evm.status, 200);
  assert.deepEqual(evm.body, { inserted: 1 });
  const signals = await request('/api/signals?allFactors=1');
  assert.equal(signals.status, 200);
  assert.equal(signals.body.some((signal: { chain: string }) => signal.chain === 'sol'), false);
  assert.equal(signals.body.some((signal: { chain: string }) => signal.chain === 'base'), true);
});
test('FOMO wallet routes and imports expose only EVM wallets', async () => {
  const denied = await request('/api/wallets', { address: SOL_WALLET, name: 'new SOL', tags: [], chain: 'sol' }, adminToken);
  assert.equal(denied.status, 400);
  assert.equal((await request(`/api/wallets/${solWalletId}`, { name: 'hidden SOL' }, adminToken, 'PATCH')).status, 404);
  const imported = importWallets([{ address: SOL_WALLET, name: 'CSV SOL', tags: [], chain: 'sol', source: 'csv' }]);
  assert.deepEqual(imported, { added: 0, skipped: [{ row: 0, reason: 'Solana wallets are disabled on FOMO instance' }] });
  const created = await request('/api/wallets', { address: EVM_CA, name: 'EVM wallet', tags: [], chain: 'evm' }, adminToken);
  assert.equal(created.status, 201);
  const wallets = await request('/api/wallets');
  assert.deepEqual(wallets.body.map((wallet: { chain: string }) => wallet.chain), ['base', 'bsc', 'robinhood']);
});

test('instance A still tracks Solana and exposes its wallets', () => {
  config.showFomo = false;
  try {
    const row = insertTrackedCa({ address: SOL_CA, chain: 'sol', note: 'A remains enabled', entryUsd: 100 });
    assert.notEqual(row.status, 'inactive');
    assert.equal(listTrackedCas().some((ca) => ca.chain === 'sol'), true);
    assert.equal(assembleSignals(Date.now(), true).some((signal) => signal.chain === 'sol'), true);
    assert.equal(listWallets().some((wallet) => wallet.chain === 'sol'), true);
  } finally {
    config.showFomo = true;
  }
});
