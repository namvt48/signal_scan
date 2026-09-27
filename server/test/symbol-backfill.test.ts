import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertTrackedCa, listCaTargetsMissingSymbol, open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';

const WINDOW_MS = 3_600_000;

before(() => {
  open(':memory:');
  insertTrackedCa({ address: 'caNoTicker', chain: 'sol', note: '', entryUsd: 100 });
  insertTrackedCa({ address: 'caTicker', chain: 'sol', note: '', entryUsd: 100 });
  // Given: one CA already has a ticker, the other is the backfill's target.
  updateTokenMetrics('caTicker', 'sol', { symbol: 'MINI' });
});

test('listCaTargetsMissingSymbol: only ticker-less tracked CAs, and the set empties once written', () => {
  assert.deepEqual(
    listCaTargetsMissingSymbol(WINDOW_MS).map((c) => c.address),
    ['caNoTicker'],
  );
  updateTokenMetrics('caNoTicker', 'sol', { symbol: 'BACKFILL' });
  assert.deepEqual(listCaTargetsMissingSymbol(WINDOW_MS), []);
});

test('symbol backfill write creates the token_state row for a CA no sweep ever reached', () => {
  insertTrackedCa({ address: 'caFresh', chain: 'sol', note: '', entryUsd: 100 });
  assert.deepEqual(
    listCaTargetsMissingSymbol(WINDOW_MS).map((c) => c.address),
    ['caFresh'],
  );
  updateTokenMetrics('caFresh', 'sol', { symbol: 'FRESH' });
  assert.deepEqual(listCaTargetsMissingSymbol(WINDOW_MS), [], 'the upsert created the row, no prior token_state needed');
});

test('listCaTargetsMissingSymbol: a CA older than the window drops out even with symbol NULL', () => {
  insertTrackedCa({ address: 'caStuck', chain: 'sol', note: '', entryUsd: 100 });
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(old, 'caStuck');
  assert.deepEqual(listCaTargetsMissingSymbol(WINDOW_MS), [], 'expired CA must not be retried forever');
});
