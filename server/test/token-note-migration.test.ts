import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTrackedCa, getDb, open, setTrackedCaNote } from '../src/db.js';

test('migration preserves saved notes and tracking labels, while new user notes default empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-note-migration-'));
  const file = join(dir, 'state.db');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE tracked_cas (id TEXT PRIMARY KEY, address TEXT NOT NULL, chain TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', entry_usd REAL,
    UNIQUE(address, chain));`);
  const insert = legacy.prepare('INSERT INTO tracked_cas (id,address,chain,note,added_at) VALUES (?,?,?,?,?)');
  insert.run('a', 'saved', 'sol', 'My existing note', '2026-01-01');
  insert.run('b', 'auto-wallet', 'sol', 'wallet-trade', '2026-01-01');
  insert.run('c', 'auto-fomo', 'sol', 'fomo', '2026-01-01');
  const autoNote = 'auto:BUY by 9xoW7tmArozmTicuWeQybc9XyYHot8efMECgCDDZAPyF 3HLUZ32M2SXXa5rutGZaphs23K4qMD34Rm5qLDkoDUYGP1nVJ4M2E5HjrBZumcswjs17hgLp6vf3CdRQb414kqRm';
  insert.run('d', 'auto-buy', 'sol', autoNote, '2026-01-01');
  legacy.close();
  try {
    open(file);
    assert.equal(findTrackedCa('saved', 'sol')?.user_note, 'My existing note');
    assert.equal(findTrackedCa('auto-wallet', 'sol')?.user_note, '');
    assert.equal(findTrackedCa('auto-fomo', 'sol')?.user_note, '');
    assert.equal(findTrackedCa('auto-buy', 'sol')?.user_note, '');
    assert.equal(findTrackedCa('auto-buy', 'sol')?.note, autoNote);
    assert.equal(findTrackedCa('auto-wallet', 'sol')?.note, 'wallet-trade');
    assert.equal(findTrackedCa('auto-fomo', 'sol')?.note, 'fomo');
    setTrackedCaNote('auto-fomo', 'sol', 'fomo');
    getDb().close();
    open(file);
    assert.equal(findTrackedCa('auto-fomo', 'sol')?.user_note, 'fomo', 'user-authored text is never reclassified on restart');
    assert.equal(findTrackedCa('saved', 'sol')?.user_note, 'My existing note');
  } finally {
    getDb().close();
    rmSync(dir, { recursive: true });
  }
});

test('already migrated auto notes are cleared once, without changing edited notes or later saves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-note-repair-'));
  const file = join(dir, 'state.db');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE tracked_cas (id TEXT PRIMARY KEY, address TEXT NOT NULL, chain TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', user_note TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', entry_usd REAL, UNIQUE(address, chain));`);
  const insert = legacy.prepare('INSERT INTO tracked_cas (id,address,chain,note,user_note,added_at) VALUES (?,?,?,?,?,?)');
  for (const side of ['BUY', 'SELL']) {
    const label = `auto:${side} by wallet signature`;
    insert.run(side, side, 'sol', label, label, '2026-01-01');
  }
  insert.run('edited', 'edited', 'sol', 'auto:BUY by wallet signature', 'My saved note', '2026-01-01');
  legacy.close();
  try {
    open(file);
    assert.equal(findTrackedCa('BUY', 'sol')?.user_note, '');
    assert.equal(findTrackedCa('SELL', 'sol')?.user_note, '');
    assert.equal(findTrackedCa('edited', 'sol')?.user_note, 'My saved note');
    setTrackedCaNote('BUY', 'sol', 'auto:BUY by wallet signature');
    getDb().close();
    open(file);
    assert.equal(findTrackedCa('BUY', 'sol')?.user_note, 'auto:BUY by wallet signature');
  } finally {
    getDb().close();
    rmSync(dir, { recursive: true });
  }
});
