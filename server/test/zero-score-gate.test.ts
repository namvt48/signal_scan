import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, getDb, getTokenState, insertTrackedCa, insertWallet, open, setTier } from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';
import { zeroScoreGate } from '../src/poller.js';
import { nansenScore } from '../src/signals.js';
import { getThresholds, type NansenThresholds } from '../src/settings.js';

const COMPLETE_DEAD = 'caGate-dead'; // full data, 0/3 -> the only deletion
const INCOMPLETE = 'caGate-incomplete'; // symbol NULL -> kept even at 0/3
const ONE_PASS = 'caGate-onepass'; // full data, exactly 1/3 -> kept
const HELD_DEAD = 'caGate-held-dead'; // full data 0/3, but a tracked wallet still HOLDS it
const DUMPED_DEAD = 'caGate-dumped-dead'; // full data 0/3, wallet dumped -> back in scope
const TIERED_DEAD = 'caGate-tiered-dead'; // full data 0/3 but user-rated -> never deleted

let th: NansenThresholds;
let holderId: string;

/** Failing/passing factor values derived from the LIVE thresholds, never hardcoded. */
function factorValues(): { failFresh: number; passFresh: number; failT100: number; failLf: number } {
  return {
    failFresh: th.freshMinPct - 1,
    passFresh: th.freshMinPct,
    failT100: th.t100MinMultiple - 0.1,
    failLf: th.lfMin - 1,
  };
}

function insertState(ca: string, state: { symbol: string | null; fresh: number; t100: number; lf: number }): void {
  getDb()
    .prepare(
      `INSERT INTO token_state (ca, chain, symbol, supply, price, nansen_fresh_pct, t100_multiple, genesis_bal, fetched_at)
       VALUES (?, 'sol', ?, 1000000000, 0.000001, ?, ?, ?, ?)`,
    )
    .run(ca, state.symbol, state.fresh, state.t100, state.lf, Date.now());
}

before(() => {
  open(':memory:');
  th = getThresholds();
  const v = factorValues();
  for (const ca of [COMPLETE_DEAD, INCOMPLETE, ONE_PASS, HELD_DEAD, DUMPED_DEAD, TIERED_DEAD]) {
    insertTrackedCa({ address: ca, chain: 'sol', note: 'gate test' });
  }
  // Given: one complete 0/3 row, one symbol-less 0/3 row, one complete 1/3 row.
  insertState(COMPLETE_DEAD, { symbol: 'DEAD', fresh: v.failFresh, t100: v.failT100, lf: v.failLf });
  insertState(INCOMPLETE, { symbol: null, fresh: v.failFresh, t100: v.failT100, lf: v.failLf });
  insertState(ONE_PASS, { symbol: 'ONE', fresh: v.passFresh, t100: v.failT100, lf: v.failLf });
  // Two more complete 0/3 rows, both held by the same tracked wallet: the position is
  // what makes them out of scope, so the same data must delete once amount hits 0.
  insertState(HELD_DEAD, { symbol: 'HELD', fresh: v.failFresh, t100: v.failT100, lf: v.failLf });
  insertState(DUMPED_DEAD, { symbol: 'DUMP', fresh: v.failFresh, t100: v.failT100, lf: v.failLf });
  // The same 0/3 data as COMPLETE_DEAD, but a stored tier puts it out of the gate's scope.
  insertState(TIERED_DEAD, { symbol: 'TIER', fresh: v.failFresh, t100: v.failT100, lf: v.failLf });
  setTier(TIERED_DEAD, 'sol', 'S+');
  holderId = insertWallet({ address: 'wallet-gate-holder', name: 'test_gate', tags: [], chain: 'sol', source: 'test' }).id;
  replaceWalletBalances(holderId, 'sol', [
    { ca: HELD_DEAD, amount: 1_000 },
    { ca: DUMPED_DEAD, amount: 1_000 },
  ]);
  for (const ca of [HELD_DEAD, DUMPED_DEAD]) {
    insertTrades(holderId, [{ tx: `t-${ca}`, ts: Date.now() - 8 * 24 * 3_600_000, side: 'buy', ca, chain: 'sol', amountUsd: 500, price: 1 }], 'watch');
  }
});

test('zeroScoreGate: deactivates a complete 0/3 CA and preserves its token_state', () => {
  // Given
  const s = nansenScore(getTokenState(COMPLETE_DEAD, 'sol'), th);
  assert.equal(s.complete, true);
  assert.equal(s.score, 0);

  // When
  zeroScoreGate();

  // Then: tracked row is inactive (findTrackedCa returns undefined), token_state is preserved.
  assert.equal(findTrackedCa(COMPLETE_DEAD, 'sol'), undefined);
  assert.notEqual(getTokenState(COMPLETE_DEAD, 'sol'), undefined);
});

test('zeroScoreGate: keeps a 0/3 CA whose data is incomplete (symbol NULL)', () => {
  // Given
  const s = nansenScore(getTokenState(INCOMPLETE, 'sol'), th);
  assert.equal(s.complete, false);
  assert.equal(s.score, 0);

  // When
  zeroScoreGate();

  // Then: untouched — the sweeps are still filling it.
  assert.notEqual(findTrackedCa(INCOMPLETE, 'sol'), undefined);
  assert.notEqual(getTokenState(INCOMPLETE, 'sol'), undefined);
});

test('zeroScoreGate: keeps a complete CA with exactly one passing factor', () => {
  // Given
  const s = nansenScore(getTokenState(ONE_PASS, 'sol'), th);
  assert.equal(s.complete, true);
  assert.equal(s.score, 1);

  // When
  zeroScoreGate();

  // Then
  assert.notEqual(findTrackedCa(ONE_PASS, 'sol'), undefined);
  assert.notEqual(getTokenState(ONE_PASS, 'sol'), undefined);
});

test('zeroScoreGate: keeps a complete 0/3 CA a tracked wallet still holds (user 2026-09-25)', () => {
  // Given: the same 0/3 data as COMPLETE_DEAD, plus a live position from a watch wallet.
  const s = nansenScore(getTokenState(HELD_DEAD, 'sol'), th);
  assert.equal(s.complete, true);
  assert.equal(s.score, 0);

  // When
  zeroScoreGate();

  // Then: the position keeps it on the dashboard.
  assert.notEqual(findTrackedCa(HELD_DEAD, 'sol'), undefined);
  assert.notEqual(getTokenState(HELD_DEAD, 'sol'), undefined);
});

test('zeroScoreGate: keeps a complete 0/3 CA the user rated a tier (user 2026-09-28)', () => {
  const s = nansenScore(getTokenState(TIERED_DEAD, 'sol'), th);
  assert.equal(s.complete, true);
  assert.equal(s.score, 0);

  zeroScoreGate();

  assert.notEqual(findTrackedCa(TIERED_DEAD, 'sol'), undefined);
  assert.notEqual(getTokenState(TIERED_DEAD, 'sol'), undefined);
});

test('zeroScoreGate: deactivates the same 0/3 CA once its wallet has dumped the position', () => {
  // Given: the identical 0/3 data, but the holdings row is now zero.
  replaceWalletBalances(holderId, 'sol', [{ ca: DUMPED_DEAD, amount: 0 }]);
  assert.equal(nansenScore(getTokenState(DUMPED_DEAD, 'sol'), th).score, 0);

  // When
  zeroScoreGate();

  // Then: nothing holds it, so it is deactivated while preserving token_state.
  assert.equal(findTrackedCa(DUMPED_DEAD, 'sol'), undefined);
  assert.notEqual(getTokenState(DUMPED_DEAD, 'sol'), undefined);
});
