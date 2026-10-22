import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgeAlertMetricObservations,
  appendAlertMetricObservation,
  getAlertMetricObservations,
  getDb,
  getMetricPollCache,
  insertTrackedCa,
  open,
  saveMetricPollResponse,
} from '../src/db.js';
import { updateTokenAnalytics, updateTokenMetrics } from '../src/ingest.js';

function resetDb(): void {
  try { getDb().close(); } catch { /* no database open yet */ }
  open(':memory:');
}

test('Fresh cache success and observation commit atomically with exact snapshot fields', () => {
  resetDb();
  const ca = 'FreshAlertMint111111111111111111111111111111';
  try {
    insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
    const db = getDb();
    db.prepare(`INSERT INTO token_state (ca, chain, symbol, market_cap, supply, holders, nansen_fresh_pct, t100_multiple, genesis_bal)
      VALUES (?, 'sol', 'ALERT', 25000, 1000, 123, 10, 1.5, 80)`).run(ca);
    db.prepare(`INSERT INTO wallets (id, address, name, chain, source)
      VALUES ('wallet-1', 'wallet-1', 'tracked', 'sol', 'manual')`).run();
    db.prepare(`INSERT INTO wallet_token_state (wallet_id, ca, chain, token_amount)
      VALUES ('wallet-1', ?, 'sol', 125)`).run(ca);
    db.prepare(`INSERT INTO wallet_trades (wallet_id, ca, chain, side, source)
      VALUES ('wallet-1', ?, 'sol', 'buy', 'watch')`).run(ca);

    db.exec(`CREATE TRIGGER reject_alert_observation BEFORE INSERT ON alert_metric_observations
      BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
    assert.throws(() => saveMetricPollResponse(ca, 'sol', 'gini', 1000, 2000, { nansenFreshPct: 42 }), /test rollback/);
    assert.equal(getMetricPollCache(ca, 'sol', 'gini'), undefined, 'cache upsert rolled back with observation failure');
    assert.deepEqual(getAlertMetricObservations(0, 10), []);

    db.exec('DROP TRIGGER reject_alert_observation');
    saveMetricPollResponse(ca, 'sol', 'gini', 1000, 2000, { nansenFreshPct: 42 });
    updateTokenMetrics(ca, 'sol', { nansenFreshPct: 42 }, 1000);
    updateTokenAnalytics(ca, 'sol', { t100Pct: 30, t100Multiple: 1.25, genesisBal: 80 }, 1100);

    const observations = getAlertMetricObservations(0, 10);
    assert.equal(observations.length, 2);
    assert.deepEqual(
      observations.map(({ metric, value, responseAt }) => ({ metric, value, responseAt })),
      [
        { metric: 'fresh', value: 42, responseAt: 1000 },
        { metric: 't100', value: 1.25, responseAt: 1100 },
      ],
    );
    assert.equal(observations[0]?.snapshot.freshPct, 42);
    assert.equal(observations[0]?.snapshot.t100Multiple, 1.5);
    assert.equal(observations[0]?.snapshot.holders, 123);
    assert.equal(observations[0]?.snapshot.trackedHoldingPct, 12.5);
    assert.equal(observations[1]?.snapshot.t100Multiple, 1.25);
    assert.equal(observations[1]?.snapshot.t100First, 1.25);
    assert.equal(observations[1]?.snapshot.lf, 80);

    assert.equal(acknowledgeAlertMetricObservations(observations[0]?.id ?? 0), true);
    assert.equal(getAlertMetricObservations(0, 10).length, 1);
    assert.equal(acknowledgeAlertMetricObservations(observations[0]?.id ?? 0), true, 'repeated ack is idempotent');
    assert.equal(acknowledgeAlertMetricObservations(999), false, 'cannot ack observations not yet produced');
  } finally {
    getDb().close();
    open(':memory:');
  }
});

test('cached state rehydration and non-Gini cache writes do not create Fresh observations', () => {
  resetDb();
  try {
    saveMetricPollResponse('cache-only', 'sol', 'essential', 2000, 3000, { marketCap: 100 });
    saveMetricPollResponse('cache-only', 'sol', 'gini', 2000, 3000, { nansenHolders: 10 });
    updateTokenMetrics('cache-only', 'sol', { nansenFreshPct: 42 }, 2000);
    assert.deepEqual(getAlertMetricObservations(0, 10), []);
  } finally {
    getDb().close();
    open(':memory:');
  }
});

test('T100 baseline stays at the first recorded observation after history pruning', () => {
  resetDb();
  const ca = 'T100FirstMint1111111111111111111111111111111';
  try {
    insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
    const db = getDb();
    db.prepare("INSERT INTO token_state (ca, chain) VALUES (?, 'sol')").run(ca);

    updateTokenAnalytics(ca, 'sol', { t100Multiple: 1.25 }, 1_000);
    db.prepare('UPDATE token_state SET t100_history_json = ? WHERE ca = ? AND chain = ?')
      .run(JSON.stringify([{ t: 1_500, value: 2 }]), ca, 'sol');
    updateTokenAnalytics(ca, 'sol', { t100Multiple: 2.2 }, 2_000);

    const t100 = getAlertMetricObservations(0, 10).filter((observation) => observation.metric === 't100');
    assert.deepEqual(t100.map((observation) => observation.snapshot.t100First), [1.25, 1.25]);
    assert.deepEqual(
      db.prepare('SELECT first_multiple FROM t100_first_observations WHERE ca = ? AND chain = ?')
        .get(ca, 'sol'),
      { first_multiple: 1.25 },
    );
  } finally {
    getDb().close();
    open(':memory:');
  }
});

test('legacy alert-feed migration keeps the acknowledged ID high-water mark after all rows were pruned', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alert-feed-migration-'));
  const path = join(directory, 'legacy.db');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE alert_metric_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ca TEXT NOT NULL,
      chain TEXT NOT NULL,
      metric TEXT NOT NULL CHECK(metric IN ('fresh', 't100')),
      value REAL NOT NULL,
      response_at INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE alert_metric_feed_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      acknowledged_id INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO alert_metric_feed_state (singleton, acknowledged_id) VALUES (1, 100);
    INSERT INTO alert_metric_observations
      (id, ca, chain, metric, value, response_at, snapshot_json)
    VALUES (100, 'legacy-ca', 'sol', 'fresh', 20, 1, '{}');
    DELETE FROM alert_metric_observations;
  `);
  legacy.close();
  try {
    open(path);
    assert.equal(acknowledgeAlertMetricObservations(100), true);
    appendAlertMetricObservation(getDb(), 'tracker-buy-ca', 'sol', 'trackerBuy', 51_000, 2);
    const observations = getAlertMetricObservations(100, 10);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.id, 101);
    assert.equal(observations[0]?.metric, 'trackerBuy');
  } finally {
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
    open(':memory:');
  }
});
