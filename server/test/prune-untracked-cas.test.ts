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
const TIERED = 'caPrune-tiered'; // user-rated tier without inflow in 48h -> dropped
const TIERED_ACTIVE = 'caPrune-tiered-active'; // user-rated tier WITH inflow in 48h -> kept
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

test('pruneUntrackedCas: drops CAs with no inflow in 48h (including tiered/held) and drops Pass tier', () => {
  // Given: CAs and tracked wallets.
  for (const ca of [FRESH, DEAD, HELD, UNLINKED_HELD, BOUGHT, FLIPPED, YOUNG, TIERED, TIERED_ACTIVE, PASS_TIER]) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  }
  // Pre-seed token_tiers with P for PASS_LEGACY and insert directly into tracked_cas (simulating pre-existing row)
  getDb().prepare("INSERT INTO token_tiers (ca, chain, tier, updated_at) VALUES (?, 'sol', 'P', ?)").run(PASS_LEGACY, Date.now());
  getDb().prepare("INSERT INTO tracked_cas (id, address, chain, added_at, status) VALUES ('leg-id', ?, 'sol', ?, 'queued')").run(PASS_LEGACY, new Date().toISOString());
  const wallet = insertWallet({ address: 'wallet-prune', name: 'test_prune', tags: [], chain: 'sol', source: 'test' });

  // FRESH: added seconds ago -> kept by added_at grace.
  // HELD: an old holding row whose wallet bought 8d ago -> outside 48h window -> DROPPED.
  replaceWalletBalances(wallet.id, 'sol', [{ ca: HELD, amount: 1_000 }]);
  insertTrades(wallet.id, [{ tx: 't-held', ts: Date.now() - 8 * DAY, side: 'buy', ca: HELD, chain: 'sol', amountUsd: 500, price: 1 }], 'watch');
  // BOUGHT: an old row with a buy inside the 48h window -> KEPT.
  insertTrades(wallet.id, [{ tx: 't-bought', ts: Date.now() - HOUR, side: 'buy', ca: BOUGHT, chain: 'sol', amountUsd: 500, price: 1 }]);
  // FLIPPED: bought 8 days ago (outside window) -> DROPPED.
  insertTrades(wallet.id, [{ tx: 't-flipped', ts: Date.now() - 8 * DAY, side: 'buy', ca: FLIPPED, chain: 'sol', amountUsd: 500, price: 1 }]);
  // UNLINKED_HELD: held with no buy -> DROPPED.
  const stranger = insertWallet({ address: 'wallet-prune-stranger', name: 'test_stranger', tags: [], chain: 'sol', source: 'test' });
  replaceWalletBalances(stranger.id, 'sol', [{ ca: UNLINKED_HELD, amount: 9_000 }]);
  for (const ca of [DEAD, HELD, UNLINKED_HELD, BOUGHT, FLIPPED, TIERED, TIERED_ACTIVE]) backdate(ca, STALE);
  // TIERED: user-rated tier -> user rule: tiered CAs (non-Pass) are never pruned, kept on dashboard.
  setTier(TIERED, 'sol', 'B+');
  // TIERED_ACTIVE: stale added_at, but bought 1h ago -> KEPT.
  setTier(TIERED_ACTIVE, 'sol', 'A');
  insertTrades(wallet.id, [{ tx: 't-tiered-active', ts: Date.now() - HOUR, side: 'buy', ca: TIERED_ACTIVE, chain: 'sol', amountUsd: 500, price: 1 }]);
  // PASS_TIER: setting tier P immediately removes it from tracked_cas
  setTier(PASS_TIER, 'sol', 'P');
  assert.equal(findTrackedCa(PASS_TIER, 'sol'), undefined, 'setTier P immediately deletes from tracked_cas');
  backdate(YOUNG, 20 * HOUR); // inside 48h window -> KEPT

  // token_state rows
  const insertState = getDb().prepare('INSERT INTO token_state (ca, chain, fetched_at) VALUES (?, ?, ?)');
  for (const ca of [DEAD, HELD, TIERED, ORPHAN]) insertState.run(ca, 'sol', Date.now());

  // When
  const dropped = pruneUntrackedCas(WINDOW).map((r) => r.address).sort();

  // Then: untiered CAs with no inflow in 48h are dropped, plus legacy PASS_LEGACY. Tiered non-Pass CAs are KEPT.
  assert.deepEqual(dropped, [DEAD, FLIPPED, HELD, PASS_LEGACY, UNLINKED_HELD].sort());
  // Kept CAs
  assert.notEqual(findTrackedCa(BOUGHT, 'sol'), undefined, 'recent buy survives');
  assert.notEqual(findTrackedCa(TIERED, 'sol'), undefined, 'tiered CA survives even if no recent inflow');
  assert.notEqual(findTrackedCa(TIERED_ACTIVE, 'sol'), undefined, 'tiered with recent buy survives');
  assert.notEqual(findTrackedCa(YOUNG, 'sol'), undefined, 'young addition survives');
  assert.notEqual(findTrackedCa(FRESH, 'sol'), undefined, 'fresh addition survives');
  // Pruned CAs
  assert.equal(findTrackedCa(HELD, 'sol'), undefined, 'held CA without tier and without inflow in 48h is pruned');
  assert.equal(findTrackedCa(HELD, 'sol'), undefined, 'held CA without inflow in 48h is pruned');
  assert.equal(findTrackedCa(PASS_LEGACY, 'sol'), undefined, 'legacy pass tier CA is pruned');
  // Pass tier CA cannot be re-added
  assert.throws(() => insertTrackedCa({ address: PASS_TIER, chain: 'sol', note: '' }), /tier is Pass/);
  assert.throws(() => insertTrackedCa({ address: PASS_LEGACY, chain: 'sol', note: '' }), /tier is Pass/);
});
