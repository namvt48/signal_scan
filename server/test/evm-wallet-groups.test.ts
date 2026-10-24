import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { findEvmWalletGroup, getDb, insertWallet, open } from '../src/db.js';
import { createApp } from '../src/api.js';
import { createTestAuth, type TestAuth } from './auth-testkit.js';

const ADDRESS_A = `0x${'a'.repeat(40)}`;
const ADDRESS_B = `0x${'b'.repeat(40)}`;
const ADDRESS_C = `0x${'c'.repeat(40)}`;
const EXPECTED_CHAINS = ['base', 'bsc', 'robinhood'];

let auth: TestAuth;
let server: Server;
let base = '';
let admin = '';
let migrationDir = '';

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${admin}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

before(async () => {
  config.showFomo = true;
  open(':memory:');
  auth = await createTestAuth();
  admin = await auth.signToken(auth.adminEmail);
  server = createApp('evm-wallet-groups-test', auth.deps).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  getDb().close();
  if (migrationDir) rmSync(migrationDir, { recursive: true, force: true });
  config.showFomo = false;
});

test('one EVM add creates all three chain rows and duplicate addresses are case-insensitive', async () => {
  const created = await req('POST', '/api/wallets', {
    address: ADDRESS_A,
    name: 'CT-EVM-A',
    tags: ['early'],
    chain: 'evm',
    source: 'manual',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.chain, 'base');
  assert.equal(created.json.address, ADDRESS_A);
  assert.deepEqual(findEvmWalletGroup(ADDRESS_A).map((row) => row.chain), EXPECTED_CHAINS);
  assert.ok(findEvmWalletGroup(ADDRESS_A).every((row) => row.name === 'CT-EVM-A' && row.tags === '["early"]'));

  const duplicate = await req('POST', '/api/wallets', {
    address: ADDRESS_A.toUpperCase().replace('0X', '0x'),
    name: 'duplicate',
    chain: 'evm',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(findEvmWalletGroup(ADDRESS_A).length, 3);
});

test('EVM group edits propagate to all chains and reject an address collision atomically', async () => {
  const baseRow = findEvmWalletGroup(ADDRESS_A).find((row) => row.chain === 'base');
  assert.ok(baseRow);
  const imported = await req('POST', '/api/wallets/import', {
    rows: [{ address: ADDRESS_B, name: 'CT-EVM-B', tags: [], chain: 'evm', source: 'csv' }],
  });
  assert.deepEqual(imported.json, { added: 1, skipped: [] });

  const collision = await req('PATCH', `/api/wallets/${baseRow.id}`, {
    address: ADDRESS_B,
    chain: 'evm',
    name: 'should-not-write',
    tags: ['changed'],
    source: 'manual',
  });
  assert.equal(collision.status, 409);
  assert.ok(findEvmWalletGroup(ADDRESS_A).every((row) => row.name === 'CT-EVM-A'));

  const updated = await req('PATCH', `/api/wallets/${baseRow.id}`, {
    address: ADDRESS_C,
    chain: 'evm',
    name: 'CT-EVM-C',
    tags: ['changed'],
    source: 'manual',
  });
  assert.equal(updated.status, 200);
  const group = findEvmWalletGroup(ADDRESS_C);
  assert.deepEqual(group.map((row) => row.chain), EXPECTED_CHAINS);
  assert.ok(group.every((row) => row.name === 'CT-EVM-C' && row.tags === '["changed"]' && row.address === ADDRESS_C));
});

test('EVM CSV import is idempotent and delete removes the full group', async () => {
  const duplicate = await req('POST', '/api/wallets/import', {
    rows: [
      { address: ADDRESS_C.toUpperCase().replace('0X', '0x'), name: 'dup', tags: [], chain: 'evm', source: 'csv' },
      { address: 'not-an-evm-address', name: 'bad', tags: [], chain: 'evm', source: 'csv' },
    ],
  });
  assert.equal(duplicate.json.added, 0);
  assert.deepEqual(duplicate.json.skipped, [
    { row: 0, reason: 'duplicate address' },
    { row: 1, reason: 'invalid EVM address (expected 0x + 40 hex characters)' },
  ]);

  const row = findEvmWalletGroup(ADDRESS_C).find((wallet) => wallet.chain === 'robinhood');
  assert.ok(row);
  const removed = await req('DELETE', `/api/wallets/${row.id}`);
  assert.equal(removed.status, 204);
  assert.deepEqual(findEvmWalletGroup(ADDRESS_C), []);
});

test('generic EVM is disabled outside the FOMO API instance', async () => {
  config.showFomo = false;
  const response = await req('POST', '/api/wallets', { address: ADDRESS_A, name: 'A-only', chain: 'evm' });
  config.showFomo = true;
  assert.equal(response.status, 400);
  assert.deepEqual(response.json, { error: 'invalid chain (expected one of sol, base, bsc, robinhood, eth)' });
});

test('opening the FOMO DB backfills each existing EVM wallet to the other chains', () => {
  getDb().close();
  migrationDir = mkdtempSync(join(tmpdir(), 'evm-wallet-group-'));
  const path = join(migrationDir, 'legacy.db');
  config.showFomo = false;
  open(path);
  insertWallet({ address: ADDRESS_A, name: 'legacy', tags: [], chain: 'bsc', source: 'manual' });
  getDb().close();

  config.showFomo = true;
  open(path);
  assert.deepEqual(findEvmWalletGroup(ADDRESS_A).map((row) => row.chain), EXPECTED_CHAINS);
});
