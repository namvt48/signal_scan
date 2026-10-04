import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, getDb, getTokenState, insertFomoTrade, insertFomoUser, insertTrackedCa, insertWallet, open, pruneTrackedByNone, pruneUntrackedCas, setTier } from '../src/db.js';
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
const FOMO_BUY = 'caTbn-fomo-buy'; // fomo user's buy inside window -> kept (no wallet link)
const FOMO_STALE = 'caTbn-fomo-stale'; // fomo buy outside window -> dropped
const FOMO_SELL = 'caTbn-fomo-sell'; // fomo SELL inside window, no buy at all -> dropped (buy-only rule)
const FOMO_SELL_STALE = 'caTbn-fomo-sell-stale'; // fomo sell outside window -> dropped

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
  for (const ca of [IN_WINDOW, HELD_OLD, NO_TRADE, GRACE, TIERED, FOMO_BUY, FOMO_STALE, FOMO_SELL, FOMO_SELL_STALE]) {
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
  // FOMO_BUY: a fomo user's BUY an hour ago counts as a tracker (no wallet link) -> kept.
  // FOMO_STALE: same, but the fomo BUY is 9d old -> outside the window -> dropped.
  backdate(FOMO_BUY, STALE);
  backdate(FOMO_STALE, STALE);
  backdate(FOMO_SELL, STALE);
  backdate(FOMO_SELL_STALE, STALE);
  const fomoUser = insertFomoUser({ handle: 'tbn-fomo' });
  insertFomoTrade({ fomo_user_id: fomoUser.id, event_id: 'evt-tbn-1', ca: FOMO_BUY, chain: 'sol', type: 'buy', ts: Date.now() - HOUR, usd_value: 500 });
  insertFomoTrade({ fomo_user_id: fomoUser.id, event_id: 'evt-tbn-2', ca: FOMO_STALE, chain: 'sol', type: 'buy', ts: Date.now() - STALE, usd_value: 500 });
  insertFomoTrade({ fomo_user_id: fomoUser.id, event_id: 'evt-tbn-3', ca: FOMO_SELL, chain: 'sol', type: 'sell', ts: Date.now() - HOUR, usd_value: 500 });
  insertFomoTrade({ fomo_user_id: fomoUser.id, event_id: 'evt-tbn-4', ca: FOMO_SELL_STALE, chain: 'sol', type: 'sell', ts: Date.now() - STALE, usd_value: 500 });
  // GRACE: added a minute ago, wallet_watch has not POSTed its BUY yet.

  // token_state rows: IN_WINDOW and HELD_OLD own one, ORPHAN belongs to no tracked CA.
  const insertState = getDb().prepare('INSERT INTO token_state (ca, chain, fetched_at) VALUES (?, ?, ?)');
  for (const ca of [IN_WINDOW, HELD_OLD, TIERED, ORPHAN]) insertState.run(ca, 'sol', Date.now());

  const dropped = pruneTrackedByNone(WINDOW).map((r) => r.address).sort();

  assert.deepEqual(dropped, [FOMO_SELL, FOMO_SELL_STALE, FOMO_STALE, HELD_OLD, NO_TRADE].sort());
  assert.notEqual(findTrackedCa(FOMO_BUY, 'sol'), undefined, 'a fomo-watched buy inside the window must survive the tracked-by-none prune');
  assert.equal(findTrackedCa(FOMO_SELL, 'sol'), undefined, 'a sell-only fomo CA reads `none` on the FOMO dash, so it must be pruned');
  assert.notEqual(findTrackedCa(TIERED, 'sol'), undefined, 'a tier-rated CA must survive the tracked-by-none prune');
  assert.notEqual(getTokenState(TIERED, 'sol'), undefined, 'and keep its market data');
  assert.notEqual(getTokenState(HELD_OLD, 'sol'), undefined, 'a deactivated CA preserves its token_state');
  assert.notEqual(getTokenState(IN_WINDOW, 'sol'), undefined, 'a kept CA keeps its token_state');
  assert.equal(findTrackedCa(HELD_OLD, 'sol'), undefined, 'deactivated CA is removed from tracking');
});

test('pruneUntrackedCas: a FOMO BUY inside the window keeps the CA, a lone SELL does not', () => {
  const KEPT = 'caUc-fomo-buy';
  const SELL_ONLY = 'caUc-fomo-sell';
  const STALE_ONLY = 'caUc-fomo-stale';
  const DEAD = 'caUc-no-fomo';
  for (const ca of [KEPT, SELL_ONLY, STALE_ONLY, DEAD]) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
    backdate(ca, 3 * DAY);
  }
  const u = insertFomoUser({ handle: 'uc-fomo' });
  insertFomoTrade({ fomo_user_id: u.id, event_id: 'evt-uc-1', ca: KEPT, chain: 'sol', type: 'buy', ts: Date.now() - HOUR, usd_value: 1 });
  insertFomoTrade({ fomo_user_id: u.id, event_id: 'evt-uc-3', ca: SELL_ONLY, chain: 'sol', type: 'sell', ts: Date.now() - HOUR, usd_value: 1 });
  insertFomoTrade({ fomo_user_id: u.id, event_id: 'evt-uc-2', ca: STALE_ONLY, chain: 'sol', type: 'buy', ts: Date.now() - 5 * DAY, usd_value: 1 });

  const dropped = pruneUntrackedCas(2 * DAY).filter((r) => r.address.startsWith('caUc-')).map((r) => r.address).sort();

  assert.deepEqual(dropped, [DEAD, SELL_ONLY, STALE_ONLY].sort());
  assert.notEqual(findTrackedCa(KEPT, 'sol'), undefined, 'a fomo BUY inside the inflow window must survive the 48h prune');
});
