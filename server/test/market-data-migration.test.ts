import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getDb, getTokenState, listTrackedCas, open } from '../src/db.js';
import { migrateLegacyMarketDatabases } from '../src/market-data-migration.js';

test('legacy A/B migration merges public cache data but never imports private tracked rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-scan-market-migrate-'));
  try {
    const token = '11111111111111111111111111111111';
    const aPath = join(dir, 'a.db');
    open(aPath);
    const a = getDb();
    a.prepare('INSERT INTO token_state (ca, chain, price, market_cap, symbol, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, 'sol', 1, 10, 'OLDER', 1_000);
    a.prepare(`INSERT INTO metric_poll_cache
      (ca, chain, kind, last_attempt_at, response_at, next_allowed_at, failure_count, response_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, 'sol', 'essential', 1_000, 1_000, 2_000, 0, '{"symbol":"OLDER"}');
    a.prepare('INSERT INTO tracked_cas (id, address, chain, added_at) VALUES (?, ?, ?, ?)')
      .run('a-private-track', token, 'sol', new Date(1_000).toISOString());

    const bPath = join(dir, 'b.db');
    open(bPath);
    const b = getDb();
    b.prepare('INSERT INTO token_state (ca, chain, price, market_cap, symbol, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, 'sol', 2, 20, 'NEWER', 2_000);
    b.prepare(`INSERT INTO nansen_series (ca, chain, "window", taken_at, points_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(token, 'sol', 'day', 2_000, '[{"t":"2026-10-01","total":42}]');

    const marketPath = join(dir, 'market.db');
    open(marketPath);
    const market = getDb();
    migrateLegacyMarketDatabases([{ id: 'a', path: aPath }, { id: 'b', path: bPath }]);

    assert.equal(getTokenState(token, 'sol')?.symbol, 'NEWER');
    assert.equal(getTokenState(token, 'sol')?.market_cap, 20);
    const metric = market.prepare('SELECT response_at FROM metric_poll_cache WHERE ca = ? AND chain = ? AND kind = ?')
      .get(token, 'sol', 'essential') as { response_at: number } | undefined;
    assert.equal(metric?.response_at, 1_000);
    const series = market.prepare('SELECT points_json FROM nansen_series WHERE ca = ? AND chain = ? AND "window" = ?')
      .get(token, 'sol', 'day') as { points_json: string } | undefined;
    assert.equal(series?.points_json, '[{"t":"2026-10-01","total":42}]');
    assert.equal(listTrackedCas().length, 0, 'tracked lists remain per instance');

    assert.equal(migrateLegacyMarketDatabases([{ id: 'a', path: aPath }, { id: 'b', path: bPath }]), 0,
      'successful imports are not repeated on gateway restarts');
    const legacyA = new Database(aPath);
    legacyA.prepare('UPDATE token_state SET price = ?, symbol = ?, fetched_at = ? WHERE ca = ? AND chain = ?')
      .run(3, 'A-NEWEST', 3_000, token, 'sol');
    legacyA.close();
    assert.equal(getTokenState(token, 'sol')?.symbol, 'NEWER', 'default startup import does not repeat completed sources');
    assert.ok(migrateLegacyMarketDatabases([{ id: 'a', path: aPath }, { id: 'b', path: bPath }], { force: true }) > 0);
    assert.equal(getTokenState(token, 'sol')?.symbol, 'A-NEWEST', 'explicit reconciliation imports later legacy rows');
    assert.equal(getTokenState(token, 'sol')?.price, 3);
    assert.equal((market.prepare('SELECT COUNT(*) AS n FROM market_legacy_imports').get() as { n: number }).n, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
