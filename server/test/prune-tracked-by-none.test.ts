import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, getDb, getTokenState, insertTrackedCa, insertWallet, open, pruneTrackedByNone, setTier } from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 7 * DAY; // TRACKED_BY_WINDOW_MS default
const STALE = 9 * DAY; // added_at beyond the grace, no member buy

const IN_WINDOW = 'caTbn-in-window'; // watch buy inside window -> kept
const HELD_OLD = 'caTbn-held-old'; // held, but last watch buy outside window -> dropped
const NO_TRADE = 'caTbn-no-trade'; // never any wallet link, old -> dropped
const GRACE = 'caTbn-grace'; // just added, buy not posted yet -> kept
const TIERED = 'caTbn-tiered'; // no tracker, stale, but user-rated -> kept
const ORPHAN = 'caTbn-orphan'; // token_state left by an earlier drop

/** Backdate added_at so the grace gate is measured from it, not from insert time. */
function backdate(address: string, agoMs: number): void {
  getDb()
    .prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?')
    .run(new Date(Date.now() - agoMs).toISOString(), address);
}

before(() => {
  open(':memory:');
});

test('pruneTrackedByNone: drops a CA no wallet is Tracked by', () => {
  const wallet = insertWallet({ address: 'wallet-tbn', name: 'test_tbn', tags: [], chain: 'sol', source: 'test' });
  for (const ca of [IN_WINDOW, HELD_OLD, NO_TRADE, GRACE, TIERED]) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  }
  // IN_WINDOW: a watch buy an hour ago -> a tracker -> kept.
  insertTrades(wallet.id, [{ tx: 't-in', ts: Date.now() - HOUR, side: 'buy', ca: IN_WINDOW, chain: 'sol', amountUsd: 500, price: 1 }], 'watch');
  // HELD_OLD: holding row + a 9d-old watch buy -> outside the window, still dropped.
  replaceWalletBalances(wallet.id, 'sol', [{ ca: HELD_OLD, amount: 1_000 }]);
  insertTrades(wallet.id, [{ tx: 't-held', ts: Date.now() - STALE, side: 'buy', ca: HELD_OLD, chain: 'sol', amountUsd: 500, price: 1 }], 'watch');
  backdate(HELD_OLD, STALE);
  backdate(NO_TRADE, STALE);
  // TIERED: no tracker and stale like NO_TRADE, but the user rated it -> kept.
  backdate(TIERED, STALE);
  setTier(TIERED, 'sol', 'A');
  // GRACE: added a minute ago, wallet_watch has not POSTed its BUY yet.

  // token_state rows: IN_WINDOW and HELD_OLD own one, ORPHAN belongs to no tracked CA.
  const insertState = getDb().prepare('INSERT INTO token_state (ca, chain, fetched_at) VALUES (?, ?, ?)');
  for (const ca of [IN_WINDOW, HELD_OLD, TIERED, ORPHAN]) insertState.run(ca, 'sol', Date.now());

  const dropped = pruneTrackedByNone(WINDOW).map((r) => r.address).sort();

  assert.deepEqual(dropped, [HELD_OLD, NO_TRADE].sort());
  assert.notEqual(findTrackedCa(TIERED, 'sol'), undefined, 'a tier-rated CA must survive the tracked-by-none prune');
  assert.notEqual(getTokenState(TIERED, 'sol'), undefined, 'and keep its market data');
  assert.equal(getTokenState(HELD_OLD, 'sol'), undefined, 'a dropped CA takes its token_state with it');
  assert.notEqual(getTokenState(IN_WINDOW, 'sol'), undefined, 'a kept CA keeps its token_state');
  assert.equal(getTokenState(ORPHAN, 'sol'), undefined);
  const balRows = (ca: string) =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM wallet_token_state WHERE ca = ?').get(ca) as { c: number }).c;
  assert.equal(balRows(HELD_OLD), 0, 'a dropped CA must take its wallet balance rows with it');
  assert.equal(balRows(IN_WINDOW), 0, 'a kept CA never had one here');
});
