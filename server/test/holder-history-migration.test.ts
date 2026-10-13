import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, open } from '../src/db.js';

test('opening an older token_state database adds holders_history_json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-history-migration-'));
  const path = join(dir, 'state.sqlite');
  let databaseOpen = false;
  try {
    open(path);
    databaseOpen = true;
    getDb().exec('ALTER TABLE token_state DROP COLUMN holders_history_json');
    getDb().close();
    databaseOpen = false;

    open(path);
    databaseOpen = true;
    const columns = getDb().pragma('table_info(token_state)') as { name: string }[];
    assert.ok(columns.some((column) => column.name === 'holders_history_json'));
  } finally {
    if (databaseOpen) getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});
