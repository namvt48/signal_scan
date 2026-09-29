import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  deleteFomoUser,
  findFomoUserByHandle,
  getDb,
  importFomoUsers,
  insertFomoTrade,
  insertFomoUser,
  open,
} from '../src/db.js';

const count = (table: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const countTrades = (where: string, ...args: unknown[]): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM fomo_trades WHERE ${where}`).get(...args) as { n: number }).n;

before(() => {
  open(':memory:');
});

// (a) duplicate handle is rejected by the UNIQUE index.
test('(a) insertFomoUser: duplicate handle throws per the UNIQUE index', () => {
  insertFomoUser({ handle: '@alice', name: 'Alice' });
  assert.throws(() => insertFomoUser({ handle: '@alice', name: 'Impostor' }), /UNIQUE/i);
  assert.equal(findFomoUserByHandle('@alice')?.name, 'Alice', 'the impostor row was not created');
});

// (b) the same event_id inserted twice creates ONE row; the replay reports not-created.
test('(b) insertFomoTrade: event_id is idempotent (INSERT OR IGNORE)', () => {
  const user = insertFomoUser({ handle: '@bob', name: 'Bob' });
  const trade = { fomo_user_id: user.id, event_id: 'evt-1', ca: 'SoCa1', chain: 'sol' as const, type: 'buy' as const, usd_value: 1200, ts: 1_758_000_000_000 };

  assert.equal(insertFomoTrade(trade), true, 'first insert reports created');
  assert.equal(insertFomoTrade(trade), false, 'replay reports NOT created');
  assert.equal(countTrades('event_id = ?', 'evt-1'), 1, 'exactly one row exists');
});

// insertFomoTrade canonicalizes ca (reuses canonicalCa) so ${chain}:${ca} keys line up.
test('insertFomoTrade: EVM ca is canonicalized to lowercase before storing', () => {
  const user = insertFomoUser({ handle: '@carol', name: 'Carol' });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'evt-evm', ca: '0xAbC00000000000000000000000000000000000FF', chain: 'base', type: 'sell', ts: 1 });
  const row = getDb().prepare('SELECT ca FROM fomo_trades WHERE event_id = ?').get('evt-evm') as { ca: string };
  assert.equal(row.ca, '0xabc00000000000000000000000000000000000ff');
});

// The type CHECK is a LOUD BACKSTOP: perp/thesis/listing are dropped upstream, so a
// perp-shaped row (no token address, no money field) that slips through must be rejected.
test('fomo_trades type CHECK rejects a perp-shaped insert (loud backstop)', () => {
  const user = insertFomoUser({ handle: '@perp', name: 'Perp' });
  assert.throws(
    () =>
      getDb()
        .prepare("INSERT INTO fomo_trades (fomo_user_id, event_id, ca, chain, type, ts, created_at) VALUES (?, ?, ?, ?, 'perp', ?, ?)")
        .run(user.id, 'evt-perp', 'PerpCa', 'sol', 1, Date.now()),
    /CHECK/i,
  );
});

// (c) deleting a fomo_users row cascades to its fomo_trades rows (FK ON DELETE CASCADE).
test('(c) deleteFomoUser: cascades to fomo_trades', () => {
  const user = insertFomoUser({ handle: '@dave', name: 'Dave' });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'evt-d1', ca: 'SoCa2', chain: 'sol', type: 'buy', ts: 1 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'evt-d2', ca: 'SoCa2', chain: 'sol', type: 'sell', ts: 2 });
  assert.equal(countTrades('fomo_user_id = ?', user.id), 2);

  deleteFomoUser(user.id);

  assert.equal(findFomoUserByHandle('@dave'), undefined);
  assert.equal(countTrades('fomo_user_id = ?', user.id), 0, "dave's trades removed by the FK cascade");
});

// (d) importFomoUsers skips an empty handle with a reason, mirroring importWallets.
test('(d) importFomoUsers: skips empty handle with a reason, imports the valid row', () => {
  const usersBefore = count('fomo_users');
  const result = importFomoUsers([
    { handle: '   ', name: 'No Handle' },
    { handle: '@erin', name: 'Erin' },
  ]);

  assert.equal(result.added, 1);
  assert.deepEqual(result.skipped, [{ row: 0, reason: 'handle is empty' }]);
  assert.equal(count('fomo_users'), usersBefore + 1);
  assert.ok(findFomoUserByHandle('@erin'), 'the valid row was imported');
});

// Upsert enrichment: a later CSV stage (userId column) fills the user_id of a
// handle an earlier stage (no userId column) already created.
test('importFomoUsers: re-import enriches user_id on an existing handle (updated, not skipped)', () => {
  const first = importFomoUsers([{ handle: '@x', name: 'X' }]);
  assert.equal(first.added, 1);
  assert.equal(first.updated, 0);

  const second = importFomoUsers([{ handle: '@x', user_id: 'u1' }]);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.deepEqual(second.skipped, []);

  const rows = getDb()
    .prepare('SELECT id, name, user_id FROM fomo_users WHERE handle = ?')
    .all('@x') as { id: string; name: string; user_id: string | null }[];
  assert.equal(rows.length, 1, 'still exactly ONE row');
  assert.equal(rows[0].user_id, 'u1', 'user_id enriched by the later stage');
  assert.equal(rows[0].name, 'X', 'existing name preserved');
});

test('importFomoUsers: empty incoming fields never erase learned values', () => {
  importFomoUsers([{ handle: '@y', user_id: 'u2', clan: 'c2' }]);

  const again = importFomoUsers([{ handle: '@y', user_id: '', clan: '', name: '' }]);
  assert.equal(again.updated, 0);
  assert.deepEqual(again.skipped, [{ row: 0, reason: 'duplicate handle (no new fields)' }]);

  const row = findFomoUserByHandle('@y');
  assert.equal(row?.user_id, 'u2', 'learned user_id survives an empty re-import');
  assert.equal(row?.clan, 'c2', 'learned clan survives an empty re-import');
});

// (e) a DB created before this change still opens (fomo tables added via IF NOT EXISTS).
test('(e) open(): a pre-change DB gains the fomo tables without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fomo-pre-'));
  try {
    const path = join(dir, 'legacy.db');
    // The pre-change shape: current chain-aware wallets + settings, NO fomo tables.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE wallets (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        name TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        chain TEXT NOT NULL DEFAULT 'sol',
        source TEXT NOT NULL DEFAULT '',
        clan TEXT,
        UNIQUE(address, chain)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    legacy
      .prepare('INSERT INTO wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('w1', 'addr-1', 'OLD-WALLET', '[]', 'sol', 'manual', 'a');
    legacy.close();

    assert.doesNotThrow(() => open(path));

    // Pre-existing data survived; both fomo tables now exist.
    assert.equal(count('wallets'), 1);
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fomo_users','fomo_trades') ORDER BY name")
      .all() as { name: string }[];
    assert.deepEqual(tables.map((t) => t.name), ['fomo_trades', 'fomo_users']);

    // The freshly-added tables are usable in the same opened DB.
    const u = insertFomoUser({ handle: '@legacy', name: 'Legacy' });
    assert.equal(insertFomoTrade({ fomo_user_id: u.id, event_id: 'evt-legacy', ca: 'SoCa3', chain: 'sol', type: 'buy', ts: 1 }), true);
    assert.equal(count('fomo_trades'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
