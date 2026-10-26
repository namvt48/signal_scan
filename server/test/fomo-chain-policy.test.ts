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

test('merged instance startup retains both Solana and EVM tracking and wallets', () => {
  assert.equal(findTrackedCa(SOL_CA, 'sol', true)?.status, 'queued');
  assert.equal(findTrackedCa(EVM_CA, 'base')?.status, 'queued');
  assert.equal((getDb().prepare('SELECT count(*) AS n FROM fomo_trades WHERE event_id = ?').get('legacy-sol-trade') as { n: number }).n, 1);
  assert.equal(listTrackedCas().some((ca) => ca.chain === 'sol'), true);
  assert.equal(listTrackedCas(true).some((ca) => ca.chain === 'sol'), true);
  assert.equal(listWallets().some((wallet) => wallet.chain === 'sol'), true);
});

test('merged API accepts Solana and EVM buys, wallet events and direct enqueue', async () => {
  const evmBuy = await request('/api/fomo-watch/trades', { eventId: 'enabled-base-buy', trader: 'chain-policy-user', type: 'buy', tokenAddress: EVM_CA, chain: 'base', ts: Date.now(), usdValue: 100, tradeUsd: 100 });
  assert.equal(evmBuy.status, 200);
  assert.deepEqual(evmBuy.body, { inserted: 1 });

  const enqueue = await request('/api/tracked-cas', { address: '22222222222222222222222222222222222222222222', chain: 'sol', note: 'manual', entryUsd: 150 });
  assert.equal(enqueue.status, 201);
  assert.equal(enqueue.body.chain, 'sol');

  const walletEvent = await request('/api/wallet-watch/trades', { wallet: SOL_WALLET, tx: 'sol-trade-tx', ca: SOL_CA, chain: 'sol', side: 'buy', ts: Date.now(), amountUsd: 100 });
  assert.equal(walletEvent.status, 200);
  assert.deepEqual(walletEvent.body, { inserted: 1 });

  const signals = await request('/api/signals?allFactors=1');
  assert.equal(signals.status, 200);
  assert.equal(signals.body.some((signal: { chain: string }) => signal.chain === 'sol'), true);
  assert.equal(signals.body.some((signal: { chain: string }) => signal.chain === 'base'), true);
});

test('merged wallet routes and imports expose both Solana and EVM wallets', async () => {
  const newSolWallet = '22222222222222222222222222222222222222222222';
  const createdSol = await request('/api/wallets', { address: newSolWallet, name: 'new SOL', tags: [], chain: 'sol' }, adminToken);
  assert.equal(createdSol.status, 201);

  const patchedSol = await request(`/api/wallets/${solWalletId}`, { name: 'renamed SOL' }, adminToken, 'PATCH');
  assert.equal(patchedSol.status, 200);

  const imported = importWallets([{ address: '44444444444444444444444444444444444444444444', name: 'CSV SOL', tags: [], chain: 'sol', source: 'csv' }]);
  assert.equal(imported.added, 1);
  assert.deepEqual(imported.skipped, []);

  const createdEvm = await request('/api/wallets', { address: EVM_CA, name: 'EVM wallet', tags: [], chain: 'evm' }, adminToken);
  assert.equal(createdEvm.status, 201);

  const wallets = await request('/api/wallets');
  const chains = new Set(wallets.body.map((wallet: { chain: string }) => wallet.chain));
  assert.ok(chains.has('sol'), 'wallets list must include Solana');
  assert.ok(chains.has('base'), 'wallets list must include Base');
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
