import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, getDb, getTokenState, insertTrackedCa, insertWallet, open, pruneUntrackedCas, setTier } from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 48 * HOUR; // CA_INFLOW_WINDOW_MS default
const STALE = 3 * DAY; // added_at beyond the window

const FRESH = 'caPrune-fresh';
const DEAD = 'caPrune-dead'; // no holding, no buy, older than window -> dropped
const HELD = 'caPrune-held';
const UNLINKED_HELD = 'caPrune-unlinked-held'; // held by a wallet with no watch buy -> dropped too
const BOUGHT = 'caPrune-bought';
const FLIPPED = 'caPrune-flipped'; // bought long ago (outside window), sold since -> pruned
const YOUNG = 'caPrune-young'; // hand-added, nothing bought it yet, still inside the window
const TIERED = 'caPrune-tiered'; // user-rated tier -> exempt from every auto-delete path
const ORPHAN = 'caPrune-orphan'; // token_state row left behind by an earlier drop

/** Backdate added_at so the window is measured from it, not from insert time. */
function backdate(address: string, agoMs: number): void {
  getDb()
    .prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?')
    .run(new Date(Date.now() - agoMs).toISOString(), address);
}

before(() => {
  open(':memory:');
});

test('pruneUntrackedCas: drops a CA nothing the CA is Tracked by holds or bought', () => {
  // Given: seven CAs and one tracked wallet.
  for (const ca of [FRESH, DEAD, HELD, UNLINKED_HELD, BOUGHT, FLIPPED, YOUNG, TIERED]) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  }
  const wallet = insertWallet({ address: 'wallet-prune', name: 'test_prune', tags: [], chain: 'sol', source: 'test' });

  // FRESH: added seconds ago, holdings not swept yet -> kept by added_at alone.
  // HELD: an old holding row whose wallet the CA is Tracked by — an 8d watch buy,
  // outside the window, so ONLY the holding clause can keep it.
  replaceWalletBalances(wallet.id, 'sol', [{ ca: HELD, amount: 1_000 }]);
  insertTrades(wallet.id, [{ tx: 't-held', ts: Date.now() - 8 * DAY, side: 'buy', ca: HELD, chain: 'sol', amountUsd: 500, price: 1 }], 'watch');
  // BOUGHT: an old row with a buy inside the window -> kept.
  insertTrades(wallet.id, [{ tx: 't-bought', ts: Date.now() - HOUR, side: 'buy', ca: BOUGHT, chain: 'sol', amountUsd: 500, price: 1 }]);
  // FLIPPED: bought 8 days ago (outside the window), so no current interaction.
  insertTrades(wallet.id, [{ tx: 't-flipped', ts: Date.now() - 8 * DAY, side: 'buy', ca: FLIPPED, chain: 'sol', amountUsd: 500, price: 1 }]);
  // UNLINKED_HELD: a second wallet holds it without ever watch-buying it, so the
  // holding row is not a Tracked-by row and must not keep the CA alive.
  const stranger = insertWallet({ address: 'wallet-prune-stranger', name: 'test_stranger', tags: [], chain: 'sol', source: 'test' });
  replaceWalletBalances(stranger.id, 'sol', [{ ca: UNLINKED_HELD, amount: 9_000 }]);
  for (const ca of [DEAD, HELD, UNLINKED_HELD, BOUGHT, FLIPPED, TIERED]) backdate(ca, STALE);
  // TIERED: identical to DEAD (stale, no holding, no buy) except the user rated a tier,
  // so every auto-delete path must spare it (user 2026-09-28).
  setTier(TIERED, 'sol', 'B+');
  backdate(YOUNG, 20 * HOUR); // inside the window: "nothing bought it" must not kill it yet

  // token_state rows: DEAD and HELD own one, ORPHAN belongs to no tracked CA.
  const insertState = getDb().prepare('INSERT INTO token_state (ca, chain, fetched_at) VALUES (?, ?, ?)');
  for (const ca of [DEAD, HELD, TIERED, ORPHAN]) insertState.run(ca, 'sol', Date.now());

  // When
  const dropped = pruneUntrackedCas(WINDOW).map((r) => r.address).sort();

  // Then
  assert.deepEqual(dropped, [DEAD, FLIPPED, UNLINKED_HELD].sort());
  assert.notEqual(findTrackedCa(TIERED, 'sol'), undefined, 'a tier-rated CA must survive the 48h inflow prune');
  assert.notEqual(getTokenState(TIERED, 'sol'), undefined, 'and keep its market data');
  // "Xoá hoàn toàn": the dropped CA's own market data goes with it, a kept CA's stays.
  assert.equal(getTokenState(DEAD, 'sol'), undefined);
  assert.notEqual(getTokenState(HELD, 'sol'), undefined);
  assert.equal(getTokenState(ORPHAN, 'sol'), undefined);
  // wallet_token_state carries no ca FK, so the prune must sweep balance rows too.
  const balRows = (ca: string) =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM wallet_token_state WHERE ca = ?').get(ca) as { c: number }).c;
  assert.equal(balRows(UNLINKED_HELD), 0, 'a pruned CA must take its wallet balance rows with it');
  assert.equal(balRows(HELD), 1, 'a kept CA keeps its wallet balance rows');
});
