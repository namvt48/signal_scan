import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  clearZeroHolding,
  findTrackedCa,
  getDb,
  getTokenState,
  insertTrackedCa,
  listTrackedCas,
  open,
  pruneUntrackedCas,
  recordZeroHolding,
  setTier,
  upsertFomoHolding,
  upsertFomoPosition,
} from '../src/db.js';
import { insertTrades, replaceWalletBalances, upsertTokenInfo } from '../src/ingest.js';
import { assembleSignals, fomoUserStats, trackedWalletStats } from '../src/signals.js';
import { insertWallet, insertFomoUser, insertFomoTrade } from '../src/db.js';
import { setPollerDeps, walletSweep } from '../src/poller.js';
import type { MarketDataProvider } from '../src/providers/provider.js';

describe('CA Lifecycle (48h soft-deactivation) and 24h zero-holding membership', () => {
  beforeEach(() => {
    open(':memory:');
  });

  it('48h no inflow: deactivates CA without deleting data; reactivates on new BUY', () => {
    const CA = 'sol-test-lifecycle-ca-1111111111111111111';
    const PASS_CA = 'sol-test-pass-ca-22222222222222222222222';
    const TIERED_CA = 'sol-test-tiered-ca-33333333333333333333';

    // 1. Insert tracked CAs
    insertTrackedCa({ address: CA, chain: 'sol', note: 'auto:BUY' });
    insertTrackedCa({ address: PASS_CA, chain: 'sol', note: 'pass' });
    insertTrackedCa({ address: TIERED_CA, chain: 'sol', note: 'tiered' });

    setTier(TIERED_CA, 'sol', 'A');
    setTier(PASS_CA, 'sol', 'P'); // immediately deleted & blocked

    // Backdate CA and TIERED_CA to 50h ago (> 48h)
    const staleTime = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(staleTime, CA);
    getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(staleTime, TIERED_CA);

    // Upsert market data for CA
    upsertTokenInfo({
      ca: CA,
      chain: 'sol',
      symbol: 'TESTCA',
      price: 1.5,
      marketCap: 150_000,
      liquidity: 50_000,
      volume24h: 10_000,
      buyVol24h: 5_000,
      sellVol24h: 5_000,
      supply: 100_000,
      holders: 500,
    });

    assert.notEqual(getTokenState(CA, 'sol'), undefined, 'token_state must exist');

    // Run 48h prune
    const window48h = 48 * 3600 * 1000;
    const pruned = pruneUntrackedCas(window48h);
    const prunedAddrs = pruned.map((r) => r.address);

    assert.ok(prunedAddrs.includes(CA), 'CA older than 48h must be in pruned list');
    assert.ok(!prunedAddrs.includes(TIERED_CA), 'Tiered CA must never be pruned');

    // VERIFY: Data is NOT deleted!
    assert.notEqual(getTokenState(CA, 'sol'), undefined, 'token_state data MUST NOT be wiped on 48h deactivation');

    // VERIFY: Status is inactive and excluded from listTrackedCas() and assembleSignals()
    const activeCas = listTrackedCas().map((c) => c.address);
    assert.ok(!activeCas.includes(CA), 'Inactive CA must be excluded from active tracking');
    assert.ok(activeCas.includes(TIERED_CA), 'Tiered CA must remain active');

    const signals = assembleSignals(Date.now(), false);
    const signalCas = signals.map((s) => s.ca);
    assert.ok(!signalCas.includes(CA), 'Inactive CA must be removed from dashboard interface');
    assert.ok(signalCas.includes(TIERED_CA), 'Tiered CA must be present on dashboard interface');

    // VERIFY: Reactivation on new BUY
    const existing = findTrackedCa(CA, 'sol', true);
    assert.equal(existing?.status, 'inactive');

    // Simulate new BUY inflow: re-adding/enqueueing reactivates it
    const readded = insertTrackedCa({ address: CA, chain: 'sol', note: 'new-inflow-buy' });
    assert.equal(readded.status, 'queued');

    const activeCasAfter = listTrackedCas().map((c) => c.address);
    assert.ok(activeCasAfter.includes(CA), 'Reactivated CA must return to active tracking');

    const signalsAfter = assembleSignals(Date.now(), false);
    assert.ok(signalsAfter.map((s) => s.ca).includes(CA), 'Reactivated CA must reappear on dashboard interface');
  });

  it('Instance A Tracked by: wallet stays in Tracked by for 24h after holding hits 0%, removed after 24h', () => {
    const CA = 'sol-test-wallet-holding-ca-1111111111111';
    insertTrackedCa({ address: CA, chain: 'sol', note: '' });

    const wallet = insertWallet({ address: 'wallet-zero-hold-1', chain: 'sol', name: 'Whale1', tags: [], source: 'watch' });

    const now = Date.now();
    const HOUR = 3600 * 1000;

    // Wallet bought token 10 hours ago
    insertTrades(wallet.id, [{ tx: 'tx-buy-1', ts: now - 10 * HOUR, side: 'buy', ca: CA, chain: 'sol', amountUsd: 1000, price: 1 }], 'watch');

    // Holding is positive
    replaceWalletBalances(wallet.id, 'sol', [{ ca: CA, amount: 500 }]);
    let stats = trackedWalletStats(CA, 'sol', now);
    assert.equal(stats.length, 1, 'Wallet with positive holding must be in Tracked by');

    // Holding becomes 0 at now - 12h (12h at zero holding)
    const twelveHoursAgo = now - 12 * HOUR;
    replaceWalletBalances(wallet.id, 'sol', [{ ca: CA, amount: 0 }]);
    // Backdate zero_at to 12h ago
    getDb().prepare("UPDATE zero_holdings SET zero_at = ? WHERE member_type = 'wallet' AND member_id = ?").run(twelveHoursAgo, wallet.id);

    // At 12h at zero holding (< 24h): STILL in Tracked by!
    stats = trackedWalletStats(CA, 'sol', now);
    assert.equal(stats.length, 1, 'Wallet must remain in Tracked by when zero-holding is < 24h');
    assert.equal(stats[0]?.name, 'Whale1');

    // Holding has been 0 for 25 hours (> 24h)
    const twentyFiveHoursAgo = now - 25 * HOUR;
    getDb().prepare("UPDATE zero_holdings SET zero_at = ? WHERE member_type = 'wallet' AND member_id = ?").run(twentyFiveHoursAgo, wallet.id);

    // After 24h at zero holding: REMOVED from Tracked by!
    stats = trackedWalletStats(CA, 'sol', now);
    assert.equal(stats.length, 0, 'Wallet must be removed from Tracked by after holding is 0% for >= 24h');

    // If wallet buys again: holding becomes > 0
    replaceWalletBalances(wallet.id, 'sol', [{ ca: CA, amount: 200 }]);
    stats = trackedWalletStats(CA, 'sol', now);
    assert.equal(stats.length, 1, 'Wallet must return to Tracked by when buying again');
  });

  it('Instance B FOMO by: user stays in FOMO by for 24h after holding hits 0%, removed after 24h', () => {
    const CA = 'sol-test-fomo-holding-ca-2222222222222';
    insertTrackedCa({ address: CA, chain: 'sol', note: 'fomo' });

    const fomoUser = insertFomoUser({ handle: 'trader_fomo_1', name: 'Trader Fomo', tags: [], source: 'manual' });

    const now = Date.now();
    const HOUR = 3600 * 1000;

    // FOMO trade: buy
    insertFomoTrade({
      fomo_user_id: fomoUser.id,
      event_id: 'evt-buy-fomo-1',
      ca: CA,
      chain: 'sol',
      type: 'buy',
      usd_value: 500,
      ts: now - 10 * HOUR,
    });

    // Initial holding is positive
    upsertFomoHolding({
      fomo_user_id: fomoUser.id,
      ca: CA,
      chain: 'sol',
      wallet: 'sol-wallet-fomo-1',
      amount: 1000,
      pct: 1.5,
      measured_at: now - 10 * HOUR,
    });

    let stats = fomoUserStats(CA, 'sol', now);
    assert.equal(stats.length, 1, 'FOMO user with holding must be in FOMO by');

    // Holding drops to 0 at 10 hours ago (< 24h)
    const tenHoursAgo = now - 10 * HOUR;
    upsertFomoHolding({
      fomo_user_id: fomoUser.id,
      ca: CA,
      chain: 'sol',
      wallet: 'sol-wallet-fomo-1',
      amount: 0,
      pct: 0,
      measured_at: tenHoursAgo,
    });

    // At 10h at zero holding (< 24h): STILL in FOMO by!
    stats = fomoUserStats(CA, 'sol', now);
    assert.equal(stats.length, 1, 'FOMO user must remain in FOMO by when zero-holding is < 24h');
    assert.equal(stats[0]?.handle, 'trader_fomo_1');

    // Holding has been 0 for 26 hours (> 24h)
    const twentySixHoursAgo = now - 26 * HOUR;
    getDb().prepare("UPDATE zero_holdings SET zero_at = ? WHERE member_type = 'fomo' AND member_id = ?").run(twentySixHoursAgo, fomoUser.id);

    // After 24h at zero holding: REMOVED from FOMO by!
    stats = fomoUserStats(CA, 'sol', now);
    assert.equal(stats.length, 0, 'FOMO user must be removed from FOMO by after holding is 0% for >= 24h');

    // If position has positive amount again: returns to FOMO by
    upsertFomoPosition({
      fomo_user_id: fomoUser.id,
      ca: CA,
      chain: 'sol',
      trade_id: 't-1',
      status: 'open',
      amount: 500,
      cost_basis_usd: 300,
      avg_entry_price: 1,
      price_usd: 1.2,
      realized_pnl_usd: 0,
      unrealized_pnl_usd: 50,
      fetched_at: now,
    });

    stats = fomoUserStats(CA, 'sol', now);
    assert.equal(stats.length, 1, 'FOMO user must return to FOMO by when holding becomes positive again');
  });

  it('walletSweep: soft-deactivates 48h untracked CAs and score-0 CAs preserving token_state, hard-deletes Pass CAs', async () => {
    const CA_48H = 'sol-sweep-48h-1111111111111111111111111';
    const CA_SCORE_0 = 'sol-sweep-score0-2222222222222222222222';
    const CA_PASS = 'sol-sweep-pass-333333333333333333333333';
    const CA_ACTIVE = 'sol-sweep-active-4444444444444444444444';

    // Setup mock provider
    const provider: MarketDataProvider = {
      name: 'nansen',
      tokenInfo: async () => { throw new Error('unused'); },
      metric: async () => ({}),
      walletTokenHoldings: async () => [],
    };
    setPollerDeps(provider, {} as never);

    // 1. Insert CAs
    insertTrackedCa({ address: CA_48H, chain: 'sol', note: '48h test' });
    insertTrackedCa({ address: CA_SCORE_0, chain: 'sol', note: 'score-0 test' });
    insertTrackedCa({ address: CA_PASS, chain: 'sol', note: 'pass test' });
    insertTrackedCa({ address: CA_ACTIVE, chain: 'sol', note: 'active test' });

    // 2. Set token_state for all
    for (const ca of [CA_48H, CA_SCORE_0, CA_PASS, CA_ACTIVE]) {
      upsertTokenInfo({
        ca,
        chain: 'sol',
        symbol: ca.slice(10, 16),
        price: 1,
        marketCap: 100_000,
        liquidity: 50_000,
        volume24h: 5_000,
        buyVol24h: 2_500,
        sellVol24h: 2_500,
        supply: 100_000,
        holders: 100,
      });
    }

    // Configure CA_48H: added 50 hours ago (> 48h) with no buy in window
    const fiftyHoursAgo = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    getDb().prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ?').run(fiftyHoursAgo, CA_48H);

    // Configure CA_SCORE_0: complete 0/3 score (nansen_fresh_pct=0, t100_multiple=0, genesis_bal=999999)
    getDb().prepare(`
      UPDATE token_state 
         SET nansen_fresh_pct = 0, t100_multiple = 0, genesis_bal = 999999 
       WHERE ca = ?
    `).run(CA_SCORE_0);

    // Configure CA_PASS: tier Pass
    setTier(CA_PASS, 'sol', 'P');

    // Configure CA_ACTIVE: recent buy 1h ago
    const w = insertWallet({ address: 'w-active', chain: 'sol', name: 'WActive', tags: [], source: 'watch' });
    insertTrades(w.id, [{ tx: 'tx-act', ts: Date.now() - 3600 * 1000, side: 'buy', ca: CA_ACTIVE, chain: 'sol', amountUsd: 1000, price: 1 }], 'watch');
    replaceWalletBalances(w.id, 'sol', [{ ca: CA_ACTIVE, amount: 500 }]);

    // Run walletSweep (which executes pruneUntrackedCas, zeroScoreGate, pruneTrackedByNone)
    await walletSweep(provider as never);

    // VERIFY:
    // CA_48H: soft deactivated, token_state preserved!
    assert.equal(findTrackedCa(CA_48H, 'sol'), undefined, 'CA_48H must be inactive');
    assert.notEqual(getTokenState(CA_48H, 'sol'), undefined, 'CA_48H token_state MUST be preserved');

    // CA_SCORE_0: soft deactivated, token_state preserved!
    assert.equal(findTrackedCa(CA_SCORE_0, 'sol'), undefined, 'CA_SCORE_0 must be inactive');
    assert.notEqual(getTokenState(CA_SCORE_0, 'sol'), undefined, 'CA_SCORE_0 token_state MUST be preserved');

    // CA_PASS: hard deleted and swept!
    assert.equal(findTrackedCa(CA_PASS, 'sol'), undefined, 'CA_PASS must be deleted');
    assert.equal(getTokenState(CA_PASS, 'sol'), undefined, 'CA_PASS token_state MUST be swept');

    // CA_ACTIVE: active and kept!
    assert.notEqual(findTrackedCa(CA_ACTIVE, 'sol'), undefined, 'CA_ACTIVE must be active');
    assert.notEqual(getTokenState(CA_ACTIVE, 'sol'), undefined, 'CA_ACTIVE token_state must exist');

    // VERIFY REACTIVATION:
    // When new BUY arrives for CA_48H, it reactivates immediately!
    const reactivated = insertTrackedCa({ address: CA_48H, chain: 'sol', note: 'new-buy' });
    assert.equal(reactivated.status, 'queued');
    assert.notEqual(findTrackedCa(CA_48H, 'sol'), undefined, 'CA_48H must be active after reactivation');
  });
});
