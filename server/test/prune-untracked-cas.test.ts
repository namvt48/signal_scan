import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, getDb, getTokenState, insertTrackedCa, insertWallet, open, pruneUntrackedCas, setTier } from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 48 * HOUR; // CA_INFLOW_WINDOW_MS default
const STALE = 3 * DAY; // added_at beyond the window

const FRESH = 'caPrune-fresh';
const DEAD = 'caPrune-dead'; // no holding, no buy, older than window -> inactive
const HELD = 'caPrune-held'; // old BUY and positive holding -> inactive
const UNLINKED_HELD = 'caPrune-unlinked-held'; // positive balance does not extend BUY activity
const BOUGHT = 'caPrune-bought';
const FLIPPED = 'caPrune-flipped'; // old BUY -> inactive
const YOUNG = 'caPrune-young'; // hand-added, nothing bought yet, still inside the window
const TIERED = 'caPrune-tiered'; // non-P tier does not extend BUY activity
const LEGACY_NULL_ID = 'caPrune-legacy-null-id'; // imported row without a primary-key value
const TIERED_ACTIVE = 'caPrune-tiered-active'; // user-rated tier WITH recent inflow -> kept
const PASS_TIER = 'caPrune-pass'; // tier Pass -> dropped immediately upon setTier
const PASS_LEGACY = 'caPrune-pass-legacy'; // legacy row already tiered P in DB -> dropped by pruneUntrackedCas
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

test('pruneUntrackedCas expires old BUYs despite holdings and user tiers', () => {
  // Given: CAs and tracked wallets.
  for (const ca of [FRESH, DEAD, HELD, UNLINKED_HELD, BOUGHT, FLIPPED, YOUNG, TIERED, TIERED_ACTIVE, PASS_TIER]) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  }
  // Pre-seed token_tiers with P for PASS_LEGACY and insert directly into tracked_cas (simulating pre-existing row)
  getDb().prepare("INSERT INTO token_tiers (ca, chain, tier, updated_at) VALUES (?, 'sol', 'P', ?)").run(PASS_LEGACY, Date.now());
  getDb().prepare("INSERT INTO tracked_cas (id, address, chain, added_at, status) VALUES ('leg-id', ?, 'sol', ?, 'queued')").run(PASS_LEGACY, new Date().toISOString());
  getDb().prepare("INSERT INTO tracked_cas (id, address, chain, note, added_at, status) VALUES (NULL, ?, 'sol', 'legacy', ?, 'queued')")
    .run(LEGACY_NULL_ID, new Date(Date.now() - STALE).toISOString());
  const wallet = insertWallet({ address: 'wallet-prune', name: 'test_prune', tags: [], chain: 'sol', source: 'test' });

  // FRESH: added seconds ago -> kept by added_at grace.
  // HELD: an old positive holding does not extend the expired BUY window.
  replaceWalletBalances(wallet.id, 'sol', [{ ca: HELD, amount: 1_000 }]);
  insertTrades(wallet.id, [{ tx: 't-held', ts: Date.now() - 8 * DAY, side: 'buy', ca: HELD, chain: 'sol', amountUsd: 500, price: 1 }], 'watch');
  // BOUGHT: an old row with a buy inside the 48h window -> KEPT.
  insertTrades(wallet.id, [{ tx: 't-bought', ts: Date.now() - HOUR, side: 'buy', ca: BOUGHT, chain: 'sol', amountUsd: 500, price: 1 }]);
  // FLIPPED: bought 8 days ago -> deactivated.
  insertTrades(wallet.id, [{ tx: 't-flipped', ts: Date.now() - 8 * DAY, side: 'buy', ca: FLIPPED, chain: 'sol', amountUsd: 500, price: 1 }]);
  const stranger = insertWallet({ address: 'wallet-prune-stranger', name: 'test_stranger', tags: [], chain: 'sol', source: 'test' });
  replaceWalletBalances(stranger.id, 'sol', [{ ca: UNLINKED_HELD, amount: 9_000 }]);
  for (const ca of [DEAD, HELD, UNLINKED_HELD, BOUGHT, FLIPPED, TIERED, TIERED_ACTIVE]) backdate(ca, STALE);
  setTier(TIERED, 'sol', 'B+');
  setTier(TIERED_ACTIVE, 'sol', 'A');
  insertTrades(wallet.id, [{ tx: 't-tiered-active', ts: Date.now() - HOUR, side: 'buy', ca: TIERED_ACTIVE, chain: 'sol', amountUsd: 500, price: 1 }]);
  // PASS_TIER: setting tier P immediately removes it from tracked_cas
  setTier(PASS_TIER, 'sol', 'P');
  assert.equal(findTrackedCa(PASS_TIER, 'sol'), undefined, 'setTier P immediately deletes from tracked_cas');
  backdate(YOUNG, 20 * HOUR); // inside 48h window -> KEPT

  // token_state rows
  const insertState = getDb().prepare('INSERT INTO token_state (ca, chain, fetched_at) VALUES (?, ?, ?)');
  for (const ca of [DEAD, HELD, TIERED, ORPHAN]) insertState.run(ca, 'sol', Date.now());

  const dropped = pruneUntrackedCas(WINDOW).map((r) => r.address).sort();

  assert.deepEqual(dropped, [DEAD, FLIPPED, HELD, UNLINKED_HELD, TIERED, PASS_LEGACY, LEGACY_NULL_ID].sort());
  assert.equal(findTrackedCa(BOUGHT, 'sol')?.address, BOUGHT, 'recent buy survives');
  assert.equal(findTrackedCa(TIERED_ACTIVE, 'sol')?.address, TIERED_ACTIVE, 'tiered CA with recent buy survives');
  assert.equal(findTrackedCa(YOUNG, 'sol')?.address, YOUNG, 'young addition survives');
  for (const ca of [DEAD, FLIPPED, HELD, UNLINKED_HELD, TIERED]) {
    assert.equal(findTrackedCa(ca, 'sol', true)?.status, 'inactive');
  }
  assert.equal(findTrackedCa(LEGACY_NULL_ID, 'sol', true)?.status, 'inactive', 'legacy row without id still soft-deactivates');
  setTier(TIERED, 'sol', 'A');
  assert.equal(findTrackedCa(TIERED, 'sol', true)?.status, 'inactive', 'rating an expired CA does not reactivate polling');
  assert.equal(findTrackedCa(TIERED, 'sol'), undefined, 'inactive CA remains excluded from active tracking');
  assert.equal(findTrackedCa(PASS_LEGACY, 'sol'), undefined, 'legacy pass tier keeps its existing hard-delete behavior');
  assert.equal(
    (getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=? AND chain=?')
      .get(wallet.id, HELD, 'sol') as { token_amount: number }).token_amount,
    1_000,
    'deactivation preserves positive wallet history',
  );
  assert.equal(
    (getDb().prepare('SELECT COUNT(*) AS n FROM wallet_trades WHERE ca=? AND chain=?').get(HELD, 'sol') as { n: number }).n,
    1,
    'deactivation preserves BUY history',
  );
  assert.equal(findTrackedCa(PASS_TIER, 'sol'), undefined, 'Pass tier cannot be re-added');
  assert.throws(() => insertTrackedCa({ address: PASS_LEGACY, chain: 'sol', note: '' }), /tier is Pass/);
});
test('pending discovery does not extend the no-BUY grace window', () => {
  const pending = 'caPrune-discovery-pending';
  insertTrackedCa({ address: pending, chain: 'sol', note: '' });
  backdate(pending, STALE);
  const dropped = pruneUntrackedCas(WINDOW, Date.now());
  assert.equal(dropped.some((row) => row.address === pending), true);
  assert.equal(findTrackedCa(pending, 'sol', true)?.status, 'inactive');
});
