import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getWallet, importWallets, insertWallet, listWallets, open, updateWallet } from '../src/db.js';
import { insertTrades } from '../src/ingest.js';
import { trackedWalletStats } from '../src/signals.js';
import type { WalletActivity } from '../src/providers/provider.js';

// `clan` is a DISPLAY-ONLY label beside the wallet name (user 2026-09-24: "clan chỉ
// là một cái tên bên cạnh name của wallet"). These tests pin the two things that
// could silently break: it must persist/round-trip, and it must NEVER filter rows.

const CA = 'clanCa-001';
const ADDR_A = 'clanAddr-a';
const ADDR_B = 'clanAddr-b';

let aId = '';
let bId = '';

before(() => {
  open(':memory:');
  aId = insertWallet({ address: ADDR_A, name: 'CTA', tags: [], chain: 'sol', source: 'test', clan: 'a' }).id;
  bId = insertWallet({ address: ADDR_B, name: 'CTB', tags: [], chain: 'sol', source: 'test', clan: 'b' }).id;
});

after(() => {
  // in-memory DB: nothing to tear down
});

test('clan round-trips through insert/list — and never partitions the wallet list', () => {
  const rows = listWallets();
  assert.equal(rows.find((w) => w.id === aId)?.clan, 'a');
  assert.equal(rows.find((w) => w.id === bId)?.clan, 'b');
  // Both clans coexist in ONE list: the label must not become a filter key.
  assert.deepEqual(rows.map((w) => w.clan).sort(), ['a', 'b']);
});

test('updateWallet rewrites clan; a wallet created without one stores the empty string', () => {
  const updated = updateWallet(aId, { address: ADDR_A, name: 'CTA', tags: [], chain: 'sol', source: 'test', clan: 'squad-1' });
  assert.equal(updated?.clan, 'squad-1');
  const noClan = insertWallet({ address: 'clanAddr-none', name: 'CTN', tags: [], chain: 'sol', source: 'test' });
  assert.equal(noClan.clan, '', 'absent clan stores "" (unlabelled), not NULL/undefined');
});

test('importWallets stores the clan column, defaulting to "" when absent', () => {
  const res = importWallets([
    { address: 'So11111111111111111111111111111111111111112', name: 'I1', tags: [], chain: 'sol', source: 'csv', clan: 'b' },
    { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'I2', tags: [], chain: 'sol', source: 'csv' },
  ]);
  assert.equal(res.added, 2);
  const byAddr = new Map(listWallets().map((w) => [w.address, w.clan]));
  assert.equal(byAddr.get('So11111111111111111111111111111111111111112'), 'b');
  assert.equal(byAddr.get('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), '');
});

test('trackedWalletStats exposes clan beside the name (a clan-b wallet is still listed)', () => {
  const now = Date.now();
  const act: WalletActivity = { tx: 'clan-sig-1', ts: now, side: 'buy', ca: CA, chain: 'sol', amountUsd: 120, price: 0.01 };
  assert.equal(insertTrades(bId, [act], 'watch'), 1);
  const row = trackedWalletStats(CA, 'sol', now).find((s) => s.name === 'CTB');
  assert.ok(row, 'the clan-b wallet must be listed — clan never filters rows');
  assert.equal(row?.clan, 'b');
});

test('migration: a DB predating the clan column gets it backfilled to "a" on open()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clan-mig-'));
  const path = join(dir, 'legacy.db');
  try {
    // Given: a wallets table created before `clan` existed, holding one row.
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE wallets (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
         tags TEXT NOT NULL DEFAULT '[]', chain TEXT NOT NULL, source TEXT NOT NULL DEFAULT '')`,
    );
    legacy
      .prepare('INSERT INTO wallets (id, address, name, tags, chain, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run('w-legacy', 'addr-legacy', 'OLD', '[]', 'sol', 'manual');
    legacy.close();

    // When: the app opens it (SCHEMA + idempotent ALTER + backfill).
    open(path);

    // Then: the column exists and every pre-existing wallet reads as clan 'a'.
    assert.equal(getWallet('w-legacy')?.clan, 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
