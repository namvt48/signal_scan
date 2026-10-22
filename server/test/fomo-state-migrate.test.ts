import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getDb, open } from '../src/db.js';

test('legacy FOMO positions backoff state migrates to the balances endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fomo-state-migrate-'));
  const path = join(dir, 'legacy.db');
  try {
    open(path);
    getDb().prepare(
      'INSERT INTO fomo_users (id, handle, name, source, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('user-1', 'legacy', 'Legacy', 'manual', 1);
    getDb().close();

    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE fomo_api_request_state;
      CREATE TABLE fomo_api_request_state (
        fomo_user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL CHECK(endpoint IN ('positions', 'swaps')),
        last_attempt_at INTEGER NOT NULL,
        next_eligible_at INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_outcome TEXT NOT NULL,
        PRIMARY KEY (fomo_user_id, endpoint),
        FOREIGN KEY (fomo_user_id) REFERENCES fomo_users(id) ON DELETE CASCADE
      );
    `);
    legacy.prepare(`
      INSERT INTO fomo_api_request_state
        (fomo_user_id, endpoint, last_attempt_at, next_eligible_at, consecutive_failures, last_outcome)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-1', 'positions', 10, 70, 2, 'http_error');
    legacy.prepare(`
      INSERT INTO fomo_api_request_state
        (fomo_user_id, endpoint, last_attempt_at, next_eligible_at, consecutive_failures, last_outcome)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-1', 'swaps', 20, 80, 1, 'no_data');
    legacy.close();

    open(path);
    const rows = getDb().prepare(
      'SELECT endpoint, consecutive_failures, last_outcome FROM fomo_api_request_state WHERE fomo_user_id = ? ORDER BY endpoint',
    ).all('user-1');
    assert.deepEqual(rows, [
      { endpoint: 'balances', consecutive_failures: 2, last_outcome: 'http_error' },
      { endpoint: 'swaps', consecutive_failures: 1, last_outcome: 'no_data' },
    ]);
  } finally {
    try {
      getDb().close();
    } catch {
      // A failed setup may already have closed the handle.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
