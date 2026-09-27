import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDb, insertWallet, open } from '../src/db.js';

// T3 (plan evm-base-bsc): the 3 wallet tables became chain-aware —
// wallets UNIQUE(address, chain), wallet_token_state PK(wallet_id, ca, chain),
// wallet_trades UNIQUE(wallet_id, ca, chain, tx, side). SQLite cannot drop a
// UNIQUE/PK via ALTER, so open() rebuilds the tables ONCE (detected by the
// missing chain column) and backfills chain='sol'. These tests pin: no row
// loss, correct new keys, no-op on re-open, fresh DB born chain-aware.

/** The exact pre-T3 production shape of the 3 wallet tables. */
const OLD_DDL = `
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  chain TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  clan TEXT
);
CREATE TABLE wallet_token_state (
  wallet_id TEXT,
  ca TEXT,
  balance_usd REAL,
  token_amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet_id, ca),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);
CREATE TABLE wallet_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id TEXT,
  ca TEXT,
  ts INTEGER,
  side TEXT CHECK(side IN ('buy','sell')),
  amount_usd REAL,
  price REAL,
  tx TEXT,
  source TEXT NOT NULL DEFAULT 'nansen',
  UNIQUE(wallet_id, ca, tx, side),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);
CREATE INDEX idx_trades_ca ON wallet_trades(ca, side);
`;

interface ColInfo {
  name: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const cols = (table: string): ColInfo[] =>
  getDb().pragma(`table_info(${table})`) as ColInfo[];

const tableSql = (table: string): string =>
  (getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;

const count = (table: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function makeLegacyDb(path: string): void {
  const legacy = new Database(path);
  legacy.exec(OLD_DDL);
  legacy
    .prepare('INSERT INTO wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('w1', 'addr-1', 'OLD-WALLET', '["sniper"]', 'sol', 'manual', 'a');
  legacy
    .prepare('INSERT INTO wallet_token_state (wallet_id, ca, balance_usd, token_amount) VALUES (?, ?, ?, ?)')
    .run('w1', 'ca-1', 12.5, 100);
  legacy
    .prepare("INSERT INTO wallet_trades (wallet_id, ca, ts, side, amount_usd, price, tx, source) VALUES (?, ?, ?, 'buy', ?, ?, ?, 'watch')")
    .run('w1', 'ca-1', 1727000000000, 300, 3, 'tx-1');
  legacy.close();
}

test('migration: old prod-shape DB keeps every row, backfilled chain=sol', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wchain-mig-'));
  try {
    const path = join(dir, 'legacy.db');
    makeLegacyDb(path);

    open(path);

    // Rows preserved, chain backfilled.
    assert.equal(count('wallets'), 1);
    assert.equal(count('wallet_token_state'), 1);
    assert.equal(count('wallet_trades'), 1);
    const w = getDb().prepare('SELECT * FROM wallets WHERE id = ?').get('w1') as Record<string, unknown>;
    assert.equal(w.address, 'addr-1');
    assert.equal(w.name, 'OLD-WALLET');
    assert.equal(w.tags, '["sniper"]');
    assert.equal(w.chain, 'sol');
    assert.equal(w.clan, 'a');
    const s = getDb().prepare('SELECT * FROM wallet_token_state').get() as Record<string, unknown>;
    assert.deepEqual(
      { wallet_id: s.wallet_id, ca: s.ca, balance_usd: s.balance_usd, token_amount: s.token_amount, chain: s.chain },
      { wallet_id: 'w1', ca: 'ca-1', balance_usd: 12.5, token_amount: 100, chain: 'sol' },
    );
    const t = getDb().prepare('SELECT * FROM wallet_trades').get() as Record<string, unknown>;
    assert.equal(t.id, 1, 'autoincrement id survives the rebuild');
    assert.equal(t.tx, 'tx-1');
    assert.equal(t.side, 'buy');
    assert.equal(t.source, 'watch');
    assert.equal(t.chain, 'sol');

    // New key shapes.
    const wCols = cols('wallets');
    const chainCol = wCols.find((c) => c.name === 'chain');
    assert.ok(chainCol, 'wallets.chain exists');
    assert.equal(chainCol.notnull, 1);
    assert.equal(chainCol.dflt_value, "'sol'");
    assert.match(tableSql('wallets'), /UNIQUE\s*\(\s*address\s*,\s*chain\s*\)/i);
    const sPk = cols('wallet_token_state').filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(sPk, ['wallet_id', 'ca', 'chain']);
    assert.match(tableSql('wallet_trades'), /UNIQUE\s*\(\s*wallet_id\s*,\s*ca\s*,\s*chain\s*,\s*tx\s*,\s*side\s*\)/i);

    // FK cascade + index + CHECK survived the rebuild.
    const fks = getDb().pragma('foreign_key_list(wallet_trades)') as { table: string; on_delete: string }[];
    assert.equal(fks.length, 1);
    assert.equal(fks[0].table, 'wallets');
    assert.equal(fks[0].on_delete, 'CASCADE');
    const idx = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='wallet_trades' AND name='idx_trades_ca'").get();
    assert.ok(idx, 'idx_trades_ca recreated');
    assert.throws(
      () => getDb().prepare("INSERT INTO wallet_trades (wallet_id, ca, ts, side, amount_usd, price, tx) VALUES ('w1','ca-1',1,'hold',0,0,'tx-2')").run(),
      /CHECK/i,
    );

    // Same address on another chain now coexists; same (address, chain) still rejected.
    insertWallet({ address: 'addr-1', name: 'BASE-WALLET', tags: [], chain: 'base', source: 'test' });
    assert.equal(count('wallets'), 2);
    assert.throws(
      () => insertWallet({ address: 'addr-1', name: 'DUP', tags: [], chain: 'base', source: 'test' }),
      /UNIQUE/i,
    );
    // Trades: same (wallet, ca, tx, side) on a different chain is a distinct row.
    getDb()
      .prepare("INSERT INTO wallet_trades (wallet_id, ca, ts, side, amount_usd, price, tx, chain) VALUES ('w1','ca-1',1,'buy',1,1,'tx-1','base')")
      .run();
    assert.equal(count('wallet_trades'), 2);
    assert.throws(
      () => getDb().prepare("INSERT INTO wallet_trades (wallet_id, ca, ts, side, amount_usd, price, tx, chain) VALUES ('w1','ca-1',2,'buy',1,1,'tx-1','base')").run(),
      /UNIQUE/i,
    );

    // Second open() is a NO-OP: same DDL, same rows, no leftover *_new tables.
    const sqlBefore = [tableSql('wallets'), tableSql('wallet_token_state'), tableSql('wallet_trades')];
    open(path);
    assert.deepEqual([tableSql('wallets'), tableSql('wallet_token_state'), tableSql('wallet_trades')], sqlBefore);
    assert.deepEqual([count('wallets'), count('wallet_token_state'), count('wallet_trades')], [2, 1, 2]);
    const leftovers = getDb().prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all();
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh DB: open() on an empty path creates the chain-aware shape directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wchain-fresh-'));
  try {
    open(join(dir, 'fresh.db'));

    assert.ok(cols('wallets').some((c) => c.name === 'chain'));
    assert.match(tableSql('wallets'), /UNIQUE\s*\(\s*address\s*,\s*chain\s*\)/i);
    const sPk = cols('wallet_token_state').filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(sPk, ['wallet_id', 'ca', 'chain']);
    assert.match(tableSql('wallet_trades'), /UNIQUE\s*\(\s*wallet_id\s*,\s*ca\s*,\s*chain\s*,\s*tx\s*,\s*side\s*\)/i);
    const noRebuild = getDb().prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").all();
    assert.deepEqual(noRebuild, []);

    insertWallet({ address: 'addr-x', name: 'SOL', tags: [], chain: 'sol', source: 'test' });
    insertWallet({ address: 'addr-x', name: 'BSC', tags: [], chain: 'bsc', source: 'test' });
    assert.equal(count('wallets'), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
