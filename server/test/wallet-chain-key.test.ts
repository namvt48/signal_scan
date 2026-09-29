import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { findWalletByAddress, getDb, insertWallet, open } from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';
import { createApp } from '../src/api.js';
import type { WalletActivity } from '../src/providers/provider.js';
// AUTH CONTRACT v1: POST/PATCH /api/wallets are admin-only — sign a REAL admin
// ID token against the testkit's local JWKS (production middleware path, no bypass).
import { createTestAuth } from './auth-testkit.js';

// T4 (plan evm-base-bsc): the wallet identity key is (address, chain) —
// wallets UNIQUE(address,chain), wallet_token_state PK(wallet_id,ca,chain),
// wallet_trades UNIQUE(wallet_id,ca,chain,tx,side). These tests pin: same
// address on 2 chains = 2 distinct wallets (db + HTTP boundary), duplicate
// (address,chain) = 409, trades/balances carry chain, and a sol balance sweep
// never deletes the same wallet's base rows.

const ADDR = '0x6A2f9C4e1B7d3F8a5E0c2D6b9A4f7C1e3D5b8E2a';

let adminAuth = '';

const jsonHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: adminAuth,
});

let server: Server;
let base = '';

async function postWallet(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/wallets`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function patchWallet(id: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/wallets/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const balanceRows = (walletId: string) =>
  getDb()
    .prepare('SELECT ca, chain, token_amount FROM wallet_token_state WHERE wallet_id = ? ORDER BY chain')
    .all(walletId) as { ca: string; chain: string; token_amount: number }[];

before(async () => {
  open(':memory:');
  const auth = await createTestAuth();
  adminAuth = `Bearer ${await auth.signToken(auth.adminEmail)}`;
  server = createApp('test', auth.deps).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('same address on 2 chains = 2 distinct wallets, resolved by (address, chain)', () => {
  const sol = insertWallet({ address: ADDR, name: 'EVM-SOL', tags: [], chain: 'sol', source: 'test' });
  const evm = insertWallet({ address: ADDR, name: 'EVM-BASE', tags: [], chain: 'base', source: 'test' });
  assert.notEqual(sol.id, evm.id);
  assert.equal(findWalletByAddress(ADDR, 'sol')?.id, sol.id);
  assert.equal(findWalletByAddress(ADDR, 'base')?.id, evm.id);
  assert.equal(findWalletByAddress(ADDR, 'bsc'), undefined);
});

test('POST /api/wallets: same address + different chain is allowed, same (address,chain) is 409', async () => {
  const addr2 = '0xAnotherAddressForHttpBoundaryTests0000000001';
  const first = await postWallet({ address: addr2, name: 'W1', tags: [], chain: 'sol', source: 'test' });
  assert.equal(first.status, 201);
  const second = await postWallet({ address: addr2, name: 'W2', tags: [], chain: 'base', source: 'test' });
  assert.equal(second.status, 201);
  assert.notEqual(second.json.id, first.json.id);
  const dup = await postWallet({ address: addr2, name: 'W3', tags: [], chain: 'base', source: 'test' });
  assert.equal(dup.status, 409);
});

test('PATCH /api/wallets/:id: moving a wallet onto an existing (address,chain) is 409', async () => {
  const res = await patchWallet(findWalletByAddress(ADDR, 'sol')!.id, { chain: 'base' });
  assert.equal(res.status, 409);
  assert.equal(findWalletByAddress(ADDR, 'sol')?.name, 'EVM-SOL'); // unchanged
});

test('insertTrades writes chain; the same (wallet,ca,tx,side) on 2 chains stays 2 rows', () => {
  const w = insertWallet({ address: 'trade-chain-wallet', name: 'TW', tags: [], chain: 'base', source: 'test' });
  const act = (chain: 'sol' | 'base'): WalletActivity => ({
    tx: 'tx-chain-key', ts: 1_758_000_000_000, side: 'buy', ca: 'CA-X', chain, amountUsd: 100, price: 1,
  });
  assert.equal(insertTrades(w.id, [act('base')], 'watch'), 1);
  assert.equal(insertTrades(w.id, [act('sol')], 'watch'), 1);
  const rows = getDb()
    .prepare("SELECT chain FROM wallet_trades WHERE tx = 'tx-chain-key' ORDER BY chain")
    .all() as { chain: string }[];
  assert.deepEqual(rows.map((r) => r.chain), ['base', 'sol']);
  // Repost on the SAME chain dedupes (chain is part of the UNIQUE key).
  assert.equal(insertTrades(w.id, [act('base')], 'watch'), 0);
});

test('replaceWalletBalances: a sol sweep never deletes the same wallet\'s base rows', () => {
  const w = insertWallet({ address: 'bal-chain-wallet', name: 'BW', tags: [], chain: 'sol', source: 'test' });
  replaceWalletBalances(w.id, 'base', [{ ca: 'CA-B', amount: 10 }]);
  replaceWalletBalances(w.id, 'sol', [{ ca: 'CA-B', amount: 5 }]);
  assert.deepEqual(balanceRows(w.id), [
    { ca: 'CA-B', chain: 'base', token_amount: 10 },
    { ca: 'CA-B', chain: 'sol', token_amount: 5 },
  ]);
  // sol sweep comes back empty (sold out) — only the sol row may decay.
  replaceWalletBalances(w.id, 'sol', [{ ca: 'CA-B', amount: 0 }]);
  assert.deepEqual(balanceRows(w.id), [{ ca: 'CA-B', chain: 'base', token_amount: 10 }]);
});
