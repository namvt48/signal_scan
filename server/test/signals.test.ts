import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getTokenState, insertTrackedCa, insertWallet, open } from '../src/db.js';
import { insertSnapshot, insertTrades, replaceWalletBalances, updateNansenHolders, updateTokenAnalytics, upsertTokenInfo } from '../src/ingest.js';
import { assembleSignals, computeBalanceRanges, computeT100Pct, sanitizeSymbol, sumHoldingAmount } from '../src/signals.js';
import { setDebugAllFactors, thresholdDefaults, updateThresholds } from '../src/settings.js';
import type { HolderRow, TokenInfo, WalletActivity } from '../src/providers/provider.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-08T12:00:00Z');

const CA_A = 'caA-test-0001';
const CA_B = 'caB-zero-mc-002';
const CA_T = 'caT-snapshot-003'; // snapshot pairing only, not a tracked CA

let w1Id = '';
let w2Id = '';

function token(ca: string, overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    ca,
    chain: 'sol',
    price: 0.001,
    holders: 0,
    volume24h: 0,
    buyVol24h: 0,
    sellVol24h: 0,
    marketCap: 0,
    liquidity: 0,
    supply: 1e9,
    freshCount: 0,
    top10Rate: 0,
    ...overrides,
  };
}

function holder(address: string, amountPct: number): HolderRow {
  return { address, amountPct, addrType: 1, isNew: false, usdValue: amountPct * 1e6 };
}

function activity(tx: string, side: 'buy' | 'sell', amountUsd: number, ts: number, ca: string): WalletActivity {
  return { tx, ts, side, ca, chain: 'sol', amountUsd, price: 0.001 };
}

before(() => {
  open(':memory:');

  w1Id = insertWallet({ address: 'wallet-addr-1', name: 'CT01', tags: [], chain: 'sol', source: 'test' }).id;
  w2Id = insertWallet({ address: 'wallet-addr-2', name: 'CT02', tags: [], chain: 'sol', source: 'test' }).id;

  insertTrackedCa({ address: CA_A, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_B, chain: 'sol', note: '', entryUsd: 60 });

  // CA_A: fresh 15% (pass >=10), t100 multiple 1.5 (pass >=1.2), lf = genesis 4e7 inside [1e6, 3e8] (pass) -> score 3.
  upsertTokenInfo(token(CA_A, { holders: 1000, freshCount: 150, marketCap: 50e6, volume24h: 123456, volume1h: 3210, symbol: 'mini' }));
  updateTokenAnalytics(CA_A, 'sol', { t100Pct: 20, t100Multiple: 1.5, genesisBal: 4e7 });
  replaceWalletBalances(w1Id, 'sol', [{ ca: CA_A, amount: 1e7 }]); // 1e7 / 1e9 supply = 1%
  replaceWalletBalances(w2Id, 'sol', []);

  // Watcher provenance: membership counts only source='watch' BUYs (2026-09-22);
  // per-wallet stats count watch buys AND sells — net inflow (2026-09-24).
  insertTrades(w1Id, [
    activity('tx1', 'buy', 1000, NOW - 1000, CA_A),
    activity('tx2', 'buy', 2300, NOW - 900, CA_A),
    activity('tx3', 'sell', 999, NOW - 800, CA_A), // sells SUBTRACT from net inflow
  ], 'watch');
  // CT02: old buy (2 days) — inside the 7d membership window, OUTSIDE the 24h
  // stat window -> listed with zero stats (lastTs 0); no balance.
  insertTrades(w2Id, [activity('tx4', 'buy', 700, NOW - 2 * DAY, CA_A)], 'watch');

  // CA_B: marketCap 0 + holders 0 -> every guarded path; CT02 buy is 8 days old (outside window).
  upsertTokenInfo(token(CA_B, { holders: 0, freshCount: 5, marketCap: 0 }));
  replaceWalletBalances(w1Id, 'sol', [{ ca: CA_A, amount: 1e7 }, { ca: CA_B, amount: 1000 }]);
  insertTrades(w2Id, [activity('tx5', 'buy', 400, NOW - 8 * DAY, CA_B)]);
  // CA_B's holding is only counted for a wallet the CA is Tracked by (sumHoldingAmount
  // joins a watch buy). CT01's link is 8d old — outside the window, so `Tracked by`
  // stays empty while the holding row still counts.
  insertTrades(w1Id, [activity('tx6', 'buy', 400, NOW - 8 * DAY, CA_B)], 'watch');

  // CA_T snapshots for pairing: newest + one older than the 24h window.
  insertSnapshot(CA_T, 'sol', [holder('h1', 0.5)], NOW - 25 * 3_600_000);
  insertSnapshot(CA_T, 'sol', [holder('h1', 0.4)], NOW);
});

// Settings are global per file — reset, else "at the defaults" tests assert the previous test's band.
beforeEach(() => {
  updateThresholds(thresholdDefaults());
  setDebugAllFactors(false);
});

test('assembleSignals: fresh%, pass-based score, t100, lf for CA_A', () => {
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_A);
  assert.ok(sig, 'CA_A missing from signals');
  assert.equal(sig.id, `sol:${CA_A}`);
  assert.equal(sig.symbol, 'mini'); // stored + emitted as-is (FE uppercases)
  assert.equal(sig.holders, 1000);
  assert.ok(Math.abs((sig.nansen.fresh ?? 0) - 15) < 1e-9, `fresh expected 15, got ${sig.nansen.fresh}`);
  assert.equal(sig.nansen.score, 3); // fresh 15>=10, t100 multiple 1.5>=1.2, lf 4e7 inside [1e6, 3e8]
  assert.ok(sig.nansen.t100);
  assert.equal(sig.nansen.t100?.pct, 20);
  assert.equal(sig.nansen.t100?.multiple, 1.5); // the genesis pair write carries the multiple
  assert.equal(sig.nansen.lf, 4e7); // token units — the genesis cohort balance itself
  assert.equal(sig.volume24h, 123456);
  assert.equal(sig.volume1h, 3210);
  assert.equal(sig.tier, null);
});

test('assembleSignals: holding% is the token-amount share of supply, inflow is 24h NET buys − sells', () => {
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_A);
  assert.ok(sig);
  // 1e7 / 1e9 * 100 = 1% — price cancelled out (amount×price / price×supply)
  assert.ok(Math.abs(sig.trackedHolding - 1) < 1e-9, `holding expected 1, got ${sig.trackedHolding}`);
  // 24h window: tx1+tx2 buys (1000+2300) − tx3 sell (999) = 2301; tx4 (700) is 2 days old -> outside.
  assert.equal(sig.trackedInflow, 2301);
});

test('insertTrades dedupes on (wallet, ca, tx, side) — inflow unchanged', () => {
  const before = assembleSignals(NOW).find((s) => s.ca === CA_A);
  const inserted = insertTrades(w1Id, [
    activity('tx1', 'buy', 1000, NOW - 1000, CA_A),
    activity('tx2', 'buy', 2300, NOW - 900, CA_A),
    activity('tx3', 'sell', 999, NOW - 800, CA_A),
  ]);
  assert.equal(inserted, 0);
  const after = assembleSignals(NOW).find((s) => s.ca === CA_A);
  assert.ok(before && after);
  assert.equal(after.trackedInflow, before.trackedInflow);
});

test('assembleSignals: trackedWallets = watch-buy members only, per-wallet 24h stats', () => {
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_A);
  assert.ok(sig);
  // Single source (2026-09-22): a wallet lights this column up ONLY via a
  // source='watch' buy inside the membership window. CT01's buys are seconds old;
  // CT02's watcher buy is 2d old (<7d) — still a member, but its buy is outside
  // the 24h stat window -> zero stats and lastTs 0. CT01's holding is NOT what qualifies it.
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), ['CT01', 'CT02']);
  // CT02: balUsd key OMITTED (no wallet_token_state row) — deepStrictEqual fails on an undefined-valued key.
  assert.deepEqual(sig.trackedWallets[1], { name: 'CT02', inflow: 0, buys: 0, sells: 0, lastTs: 0 });
  // CT01: net 1000+2300−999; lastTs = newest watch TRADE (the sell); balUsd = 1e7 tokens × price 0.001.
  const ct01 = sig.trackedWallets[0];
  assert.ok(ct01);
  assert.equal(ct01.inflow, 2301);
  assert.equal(ct01.buys, 2);
  assert.equal(ct01.sells, 1);
  assert.equal(ct01.lastTs, NOW - 800);
  assert.equal(ct01.balUsd, 1e7 * 0.001);
  // Token total = Σ rows (contract: the FE's rows always add up to the token figure).
  assert.equal(sig.trackedInflow, sig.trackedWallets.reduce((sum, w) => sum + w.inflow, 0));
});

test('trackedWallets: sell subtracts from wallet AND token net, counts, balUsd present/omitted, sell-only wallet absent', () => {
  const CA_NET = 'caNet-stats-023';
  const wBuyer = insertWallet({ address: 'wallet-addr-net-buyer', name: 'CTNET1', tags: [], chain: 'sol', source: 'test' }).id;
  const wNoBal = insertWallet({ address: 'wallet-addr-net-nobal', name: 'CTNET2', tags: [], chain: 'sol', source: 'test' }).id;
  const wSeller = insertWallet({ address: 'wallet-addr-net-seller', name: 'CTNET3', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_NET, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_NET, { price: 0.5 }));

  // CTNET1: membership buy 2d old (inside 7d, OUTSIDE 24h) + in-window buy & sell.
  insertTrades(wBuyer, [
    activity('txn1', 'buy', 2000, NOW - 2 * DAY, CA_NET),
    activity('txn2', 'buy', 1500, NOW - 3_600_000, CA_NET),
    activity('txn3', 'sell', 500, NOW - 1_800_000, CA_NET),
  ], 'watch');
  // CTNET2: in-window buy only, wallet_token_state never measured.
  insertTrades(wNoBal, [activity('txn4', 'buy', 250, NOW - 600_000, CA_NET)], 'watch');
  // CTNET3: WATCH sell only, never a watch buy -> no membership, sell uncounted.
  insertTrades(wSeller, [activity('txn5', 'sell', 4000, NOW - 60_000, CA_NET)], 'watch');
  // Measured balance for CTNET1: 3000 tokens × price 0.5 = 1500 USD.
  replaceWalletBalances(wBuyer, 'sol', [{ ca: CA_NET, amount: 3000 }]);

  const sig = assembleSignals(NOW).find((s) => s.ca === CA_NET);
  assert.ok(sig);
  // Newest trade first (user 2026-09-24): CTNET2 bought 10m ago, CTNET1 sold 30m ago.
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), ['CTNET2', 'CTNET1']);

  const buyer = sig.trackedWallets.find((w) => w.name === 'CTNET1');
  const noBal = sig.trackedWallets.find((w) => w.name === 'CTNET2');
  assert.ok(buyer && noBal);
  // (a) sell subtracts: 1500 − 500 = 1000 (txn1 outside the 24h stat window)
  assert.equal(buyer.inflow, 1000);
  // (b) counts + lastTs = newest watch TRADE (the sell)
  assert.equal(buyer.buys, 1);
  assert.equal(buyer.sells, 1);
  assert.equal(buyer.lastTs, NOW - 1_800_000);
  // (c) balUsd emitted when measured ...
  assert.equal(buyer.balUsd, 1500);
  // (c) ... and OMITTED (key absent, not undefined) when never measured
  assert.ok(!('balUsd' in noBal), 'unmeasured balUsd must be absent, not undefined');
  assert.deepEqual(noBal, { name: 'CTNET2', inflow: 250, buys: 1, sells: 0, lastTs: NOW - 600_000 });

  // (a)+(d) token total = Σ rows; CTNET3's excluded 4000 sell moves nothing
  assert.equal(sig.trackedInflow, 1250);
});

test('trackedWallets: an UNPRICED holding emits no balUsd (FE "—"), never a fake $0', () => {
  const CA_NP = 'caNoPrice-bal-024';
  const wId = insertWallet({ address: 'wallet-addr-noprice', name: 'CTNP', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_NP, chain: 'sol', note: '', entryUsd: 60 });
  insertTrades(wId, [activity('txnp1', 'buy', 300, NOW - 300_000, CA_NP)], 'watch');
  // The holding IS measured, but this CA has no token_state row -> no price exists.
  replaceWalletBalances(wId, 'sol', [{ ca: CA_NP, amount: 5_000_000 }]);

  // The raw row must keep token_amount (Holding % depends on it) and store NULL, not 0.
  const row = getDb()
    .prepare('SELECT balance_usd, token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
    .get(wId, CA_NP) as { balance_usd: number | null; token_amount: number };
  assert.equal(row.token_amount, 5_000_000);
  assert.equal(row.balance_usd, null);

  const sig = assembleSignals(NOW).find((s) => s.ca === CA_NP);
  assert.ok(sig);
  const w = sig.trackedWallets.find((x) => x.name === 'CTNP');
  assert.ok(w);
  assert.ok(!('balUsd' in w), 'unpriced balUsd must be absent (FE renders —), never 0');
});

test("trackedWallets and trackedInflow read only source='watch' trades", () => {
  const CA_S = 'caS-source-split-015';
  const wNansen = insertWallet({ address: 'wallet-addr-nansen', name: 'CTN', tags: [], chain: 'sol', source: 'test' }).id;
  const wWatch = insertWallet({ address: 'wallet-addr-watch', name: 'CTW', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_S, chain: 'sol', note: '', entryUsd: 60 });
  insertTrades(wNansen, [activity('txs1', 'buy', 500, NOW - 60_000, CA_S)], 'nansen');
  insertTrades(wWatch, [activity('txs2', 'buy', 900, NOW - 60_000, CA_S)], 'watch');

  const sig = assembleSignals(NOW).find((s) => s.ca === CA_S);
  assert.ok(sig);
  // A non-watch row alone must not light `Tracked by` up.
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), ['CTW']);
  // Inflow follows the same watch-source rule: only the watch buy counts.
  assert.equal(sig.trackedInflow, 900);
});

test('trackedWallets: a watch buy INSIDE the window is returned', () => {
  const CA_R = 'caR-inside-window-018';
  const wIn = insertWallet({ address: 'wallet-addr-in', name: 'CTIN', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_R, chain: 'sol', note: '', entryUsd: 60 });
  insertTrades(wIn, [activity('txr1', 'buy', 800, NOW - DAY, CA_R)], 'watch');
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_R);
  assert.ok(sig);
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), ['CTIN']);
});

test('trackedWallets: a watch buy OLDER than the window is NOT returned, even while holding', () => {
  const CA_Q = 'caQ-out-of-window-019';
  const wOld = insertWallet({ address: 'wallet-addr-old', name: 'CTOLD', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_Q, chain: 'sol', note: '', entryUsd: 60 });
  insertTrades(wOld, [activity('txq1', 'buy', 300, NOW - 8 * DAY, CA_Q)], 'watch');
  // Holds too: the holding half used to rescue this row. It no longer does.
  replaceWalletBalances(wOld, 'sol', [{ ca: CA_Q, amount: 5e6 }]);
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_Q);
  assert.ok(sig);
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), []);
});

test('assembleSignals: genesis_bal null -> lf absent; holders=0 -> fresh absent; holding from amount/supply', () => {
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_B);
  assert.ok(sig);
  // 1000 / 1e9 * 100 = 1e-4 — the guard is supply>0, NOT marketCap (CA_B mc=0)
  assert.ok(Math.abs(sig.trackedHolding - 1e-4) < 1e-12, `holding expected 1e-4, got ${sig.trackedHolding}`);
  assert.ok(Number.isFinite(sig.trackedHolding));
  assert.equal(sig.symbol, undefined); // no sweep ever wrote a ticker
  assert.equal(sig.nansen.lf, undefined);
  assert.equal(sig.nansen.fresh, undefined);
  assert.equal(sig.nansen.score, 0);
  assert.equal(sig.nansen.t100, undefined);
  assert.equal(sig.tier, null);
});

test('trackedWallets: a holding wallet outside the window is NOT returned', () => {
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_B);
  assert.ok(sig);
  // CT01 HOLDS CA_B (token_amount 1000) and its watch buy is 8d old (> 7d window);
  // CT02's CA_B buy is 8d old too and it holds nothing -> nobody qualifies.
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), []);
});

test('sumHoldingAmount: counts a CA’s holders, never an unlinked wallet’s leftover rows', () => {
  const CA_H = 'caH-unlinked-holder-020';
  insertTrackedCa({ address: CA_H, chain: 'sol', note: '' });
  const wUn = insertWallet({ address: 'wallet-addr-unlinked-h', name: 'CTUH', tags: [], chain: 'sol', source: 'test' }).id;
  replaceWalletBalances(wUn, 'sol', [{ ca: CA_H, amount: 7_000_000 }]);
  assert.equal(sumHoldingAmount(CA_H), 0, 'an unlinked wallet holding must not be summed');
  insertTrades(wUn, [activity('txh1', 'buy', 100, NOW - DAY, CA_H)], 'watch');
  assert.equal(sumHoldingAmount(CA_H), 7_000_000, 'a linked holder must be summed');
});

test('trackedWallets: a wallet holding a CA with NO token_state is NOT returned (holding no longer lights it up)', () => {
  const CA_P = 'caP-noprice-014';
  const w3Id = insertWallet({ address: 'wallet-addr-3', name: 'CT03', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_P, chain: 'sol', note: '', entryUsd: 60 });
  // CT03 HOLDS 2e6 tokens but has NO watch buy -> not in `Tracked by`. Holding
  // still feeds trackedHolding below (sumHoldingAmount is untouched).
  replaceWalletBalances(w3Id, 'sol', [{ ca: CA_P, amount: 2e6 }]);
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_P);
  assert.ok(sig);
  assert.deepEqual(sig.trackedWallets.map((w) => w.name), []);
  assert.equal(sig.trackedHolding, 0); // supply unknown -> guarded to 0, never NaN
  assert.ok(Number.isFinite(sig.trackedHolding));
});

test('assembleSignals: rows order by NEWEST tracked inflow first — the amount is ignored', () => {
  const CA_NEW = 'caOrder-new-inflow-020';
  const CA_OLD = 'caOrder-old-inflow-021';
  const CA_NONE = 'caOrder-no-inflow-022';
  const wOrder = insertWallet({ address: 'wallet-addr-order', name: 'CTO', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_NEW, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_OLD, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_NONE, chain: 'sol', note: '', entryUsd: 60 });
  // A small-but-recent buy outranks a large-but-stale one: recency is the key, not size.
  insertTrades(wOrder, [activity('txo1', 'buy', 55, NOW - 1_000, CA_NEW)], 'watch');
  insertTrades(wOrder, [activity('txo2', 'buy', 9_000, NOW - 6 * 3_600_000, CA_OLD)], 'watch');
  insertTrades(wOrder, [activity('txo3', 'sell', 5_000, NOW - 500, CA_NONE)], 'watch'); // sell-only: no membership buy -> unlisted, sell uncounted

  const sigs = assembleSignals(NOW);
  const [iNew, iOld, iNone] = [CA_NEW, CA_OLD, CA_NONE].map((ca) => sigs.findIndex((s) => s.ca === ca));
  assert.ok(iNew >= 0 && iOld >= 0 && iNone >= 0, 'seeded CAs missing from signals');
  assert.ok(iNew < iOld, `newest inflow must come first (${iNew} vs ${iOld})`);
  assert.ok(iOld < iNone, `a zero-inflow row must sink below every inflow row (${iOld} vs ${iNone})`);

  const newSig = sigs.find((s) => s.ca === CA_NEW);
  assert.equal(newSig?.trackedActivityAt, NOW - 1_000); // newest trade of this CA
  assert.equal(newSig?.trackedInflow, 55); // still the 24h NET amount, untouched by the ordering
  const noneSig = sigs.find((s) => s.ca === CA_NONE);
  assert.equal(noneSig?.trackedActivityAt, 0); // no member trade at all -> the 0 sentinel
  assert.equal(noneSig?.trackedInflow, 0);
});

test('assembleSignals: a member SELL lifts its CA above a CA whose buy is older', () => {
  const CA_SELL = 'caOrder-sell-bump-023';
  const CA_BUY = 'caOrder-older-buy-024';
  const wSeller = insertWallet({ address: 'wallet-addr-sellbump', name: 'CTS', tags: [], chain: 'sol', source: 'test' }).id;
  const wBuyer = insertWallet({ address: 'wallet-addr-buyolder', name: 'CTB', tags: [], chain: 'sol', source: 'test' }).id;
  insertTrackedCa({ address: CA_SELL, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_BUY, chain: 'sol', note: '', entryUsd: 60 });
  insertTrades(wSeller, [
    activity('txsb1', 'buy', 1_000, NOW - 10_800_000, CA_SELL),
    activity('txsb2', 'sell', 400, NOW - 120_000, CA_SELL),
  ], 'watch');
  insertTrades(wBuyer, [activity('txbo1', 'buy', 5_000, NOW - 1_200_000, CA_BUY)], 'watch');

  const sigs = assembleSignals(NOW);
  const sellSig = sigs.find((s) => s.ca === CA_SELL);
  const buySig = sigs.find((s) => s.ca === CA_BUY);
  assert.ok(sellSig && buySig);
  assert.equal(sellSig.trackedActivityAt, NOW - 120_000); // the sell, not the older buy
  assert.equal(sellSig.trackedInflow, 600); // still NET: 1000 − 400
  assert.ok(
    sigs.findIndex((s) => s.ca === CA_SELL) < sigs.findIndex((s) => s.ca === CA_BUY),
    'a member sell must lift CA_SELL above CA_BUY',
  );
});

test('computeT100Pct pairs newest snapshot with newest one older than the window', () => {
  const pct = computeT100Pct(CA_T, 'sol', NOW);
  assert.ok(pct !== undefined, 'expected a paired measurement');
  // (0.5 - 0.4) / 0.5 * 100 = 20
  assert.ok(Math.abs(pct - 20) < 1e-9, `expected 20, got ${pct}`);
});

test('computeT100Pct: no previous snapshot in window -> undefined', () => {
  const fresh = 'caT-fresh-only';
  insertSnapshot(fresh, 'sol', [holder('h1', 0.3)], NOW);
  assert.equal(computeT100Pct(fresh, 'sol', NOW), undefined);

  // Single snapshot older than the window: "prev" would pair with itself -> undefined.
  const stale = 'caT-stale-only';
  insertSnapshot(stale, 'sol', [holder('h1', 0.3)], NOW - 2 * DAY);
  assert.equal(computeT100Pct(stale, 'sol', NOW), undefined);
});

test('signals exist for tracked CAs without token_state as zeros', () => {
  insertTrackedCa({ address: 'caC-no-state-004', chain: 'sol', note: '', entryUsd: 60 });
  const sig = assembleSignals(NOW).find((s) => s.ca === 'caC-no-state-004');
  assert.ok(sig);
  assert.equal(sig.holders, 0);
  assert.equal(sig.volume24h, 0);
  assert.equal(sig.volume1h, undefined); // never measured -> absent, so the FE renders '—' not $0
  assert.equal(sig.trackedInflow, 0);
  assert.equal(sig.trackedHolding, 0);
  assert.equal(sig.nansen.score, 0);
  assert.equal(sig.tier, null);
});

test('computeBalanceRanges: peak/trough per window, exchanges included, empty windows absent', () => {
  const CA_BAL = 'caBal-range-004'; // own CA — before() seeds CA_T snapshots too
  // 2h ago: whale 50K + LP row 500K (included -> peak is the pool row) + floor 1K
  insertSnapshot(CA_BAL, 'sol', [
    { ...holder('whale', 0.05) },
    { ...holder('lp-pool', 0.5), addrType: 2 },
    { ...holder('floor', 0.001) },
  ], NOW - 2 * 3_600_000);
  // 6 days ago: bigger whale 600K — only visible in the 30d window
  insertSnapshot(CA_BAL, 'sol', [{ ...holder('old-whale', 0.6) }], NOW - 8 * DAY);

  const r = computeBalanceRanges(CA_BAL, 'sol', NOW);
  assert.deepEqual(r.d1, { peak: 500_000, trough: 1_000 });
  assert.deepEqual(r.d7, { peak: 500_000, trough: 1_000 });
  // coverage gate: oldest snapshot is 8d old -> 30d window not fully covered -> absent
  assert.equal(r.d30, undefined);

  // fresh CA with no snapshots -> every window absent
  const empty = computeBalanceRanges('ca-no-snaps', 'sol', NOW);
  assert.equal(empty.d1, undefined);
  assert.equal(empty.d7, undefined);
  assert.equal(empty.d30, undefined);
});

test('upsertTokenInfo: tokenSweep pass (no bal/t100) must not wipe precomputed columns', () => {
  const CA_C = 'caC-coalesce-005';
  insertTrackedCa({ address: CA_C, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_C, { holders: 100 }), {
    t100Pct: 7.5,
    bal: { d1: { peak: 50_000, trough: 1_000 }, d7: { peak: 60_000, trough: 2_000 } },
  });
  // simulates tokenSweep: refreshes market fields, omits precomputed opts
  upsertTokenInfo(token(CA_C, { holders: 101, volume24h: 123 }), {});
  const st = getTokenState(CA_C, 'sol');
  assert.equal(st?.volume24h, 123); // market fields refreshed
  assert.equal(st?.t100_pct, 7.5); // precomputed survived
  assert.equal(st?.bal_peak_24h, 50_000);
  assert.equal(st?.bal_trough_24h, 1_000);
  assert.equal(st?.bal_peak_7d, 60_000);
});

test('updateTokenAnalytics: authoritative write — undefined clears stale window values', () => {
  const CA_D = 'caD-auth-006';
  insertTrackedCa({ address: CA_D, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_D, { genesisBal: 5e8 }), { t100Pct: 9, bal: { d1: { peak: 1, trough: 1 }, d7: { peak: 2, trough: 1 } } });
  // next sweep loses 7d coverage + t100 pair + genesis_bal -> those must CLEAR, d1 stays
  updateTokenAnalytics(CA_D, 'sol', { bal: { d1: { peak: 3, trough: 1 } } });
  const st = getTokenState(CA_D, 'sol');
  assert.equal(st?.t100_pct, null);
  assert.equal(st?.genesis_bal, null);
  assert.equal(st?.bal_peak_24h, 3);
  assert.equal(st?.bal_peak_7d, null);
});

test('assembleSignals: t100 multiple + genesis_bal pass through from token_state', () => {
  const CA_M = 'caM-multiple-009';
  insertTrackedCa({ address: CA_M, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_M, { marketCap: 50e6 }));
  // genesis write: pct 40 (A=1000→B=600), multiple A/B = 1.667 (>= 1.2), genesisA 4e7 inside band [1e6, 3e8]
  updateTokenAnalytics(CA_M, 'sol', { t100Pct: 40, t100Multiple: 1000 / 600, genesisBal: 4e7 });
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_M);
  assert.ok(sig?.nansen.t100);
  assert.equal(sig.nansen.t100?.pct, 40);
  assert.ok(Math.abs((sig.nansen.t100?.multiple ?? 0) - 1000 / 600) < 1e-12);
  assert.equal(sig.nansen.lf, 4e7);
  assert.equal(sig.nansen.score, 2); // t100 multiple 1.667>=1.2 + lf 4e7 in band; fresh absent
});

test('assembleSignals LF gate: failing value hidden at default, revealed by allFactors; below band floor → no pass', () => {
  const CA_H = 'caH-lfhigh-011';
  insertTrackedCa({ address: CA_H, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_H, { genesisBal: 3.1e8 })); // above lfMax 3e8 → fails the band

  // Default (allFactors=false): a gate-FAILING factor is hidden; score still reflects the failure.
  let sig = assembleSignals(NOW).find((s) => s.ca === CA_H);
  assert.equal(sig?.nansen.lf, undefined);
  assert.equal(sig?.nansen.score, 0); // lf outside band → not counted
  assert.equal(sig?.nansen.pass.lf, false); // the flag is what the FE strikes through, even while hidden

  // allFactors=true: the failing factor is revealed in token units; score is display-only → unchanged.
  setDebugAllFactors(true);
  sig = assembleSignals(NOW).find((s) => s.ca === CA_H);
  assert.equal(sig?.nansen.lf, 3.1e8);
  assert.equal(sig?.nansen.score, 0);
  assert.equal(sig?.nansen.pass.lf, false);
  setDebugAllFactors(false);

  // supply no longer feeds the gate — this value fails on the band floor alone (1000 < lfMin 1e6)
  const CA_Z = 'caZ-lfzero-012';
  insertTrackedCa({ address: CA_Z, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_Z, { supply: 0, genesisBal: 1000 }));
  sig = assembleSignals(NOW).find((s) => s.ca === CA_Z);
  assert.equal(sig?.nansen.score, 0);
  assert.equal(sig?.nansen.pass.lf, false);
});

test('assembleSignals: pass flags track the live thresholds — a PUT re-scores the same token', () => {
  const CA_P = 'caP-threshflip-014';
  insertTrackedCa({ address: CA_P, chain: 'sol', note: '', entryUsd: 60 });
  // fresh 12% >= 10, t100 multiple 1.5 >= 1.2, lf 4e7 inside [1e6, 3e8] -> all three pass at the defaults.
  upsertTokenInfo(token(CA_P, { holders: 100 }));
  updateTokenAnalytics(CA_P, 'sol', { t100Pct: 6, t100Multiple: 1.5, genesisBal: 4e7 });
  updateNansenHolders(CA_P, 'sol', { holders: 100, freshSupplyPct: 12 });

  let sig = assembleSignals(NOW).find((s) => s.ca === CA_P);
  assert.deepEqual(sig?.nansen.pass, { fresh: true, t100: true, lf: true });
  assert.equal(sig?.nansen.score, 3);

  // Tighten every gate past the token's values: the SAME rows must flip, no restart, no new data.
  updateThresholds({ freshMinPct: 20, t100MinMultiple: 2, lfMin: 5e7, lfMax: 3e8 });
  sig = assembleSignals(NOW).find((s) => s.ca === CA_P);
  assert.deepEqual(sig?.nansen.pass, { fresh: false, t100: false, lf: false });
  assert.equal(sig?.nansen.score, 0);
  assert.deepEqual(
    [sig?.nansen.fresh, sig?.nansen.t100, sig?.nansen.lf],
    [undefined, undefined, undefined], // display gate hides every failing factor
  );

  updateThresholds({ freshMinPct: 10, t100MinMultiple: 1.2, lfMin: 1e6, lfMax: 3e8 });
  sig = assembleSignals(NOW).find((s) => s.ca === CA_P);
  assert.equal(sig?.nansen.score, 3); // restored
});

test('assembleSignals: T100 gate flips on t100_multiple; LF gate flips at both band edges', () => {
  const CA_X = 'caX-gates-015';
  insertTrackedCa({ address: CA_X, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_X, {}));
  // multiple 1.5 >= default 1.2 passes; genesis 4e7 inside the default band [1e6, 3e8].
  updateTokenAnalytics(CA_X, 'sol', { t100Pct: 33.3, t100Multiple: 1.5, genesisBal: 4e7 });

  let sig = assembleSignals(NOW).find((s) => s.ca === CA_X);
  assert.equal(sig?.nansen.pass.t100, true);
  assert.equal(sig?.nansen.t100?.multiple, 1.5);
  assert.equal(sig?.nansen.pass.lf, true);
  assert.equal(sig?.nansen.score, 2); // fresh absent — contributes nothing

  // Raise the threshold above the token's multiple: t100 flips off, score drops by exactly 1.
  updateThresholds({ t100MinMultiple: 1.6 });
  sig = assembleSignals(NOW).find((s) => s.ca === CA_X);
  assert.equal(sig?.nansen.pass.t100, false);
  assert.equal(sig?.nansen.score, 1);
  updateThresholds({ t100MinMultiple: 1.2 });

  // Floor edge: 4e7 < lfMin 5e7 → out.
  updateThresholds({ lfMin: 5e7, lfMax: 3e8 });
  sig = assembleSignals(NOW).find((s) => s.ca === CA_X);
  assert.equal(sig?.nansen.pass.lf, false);
  assert.equal(sig?.nansen.score, 1);

  // Ceiling edge: band [1e6, 3e7] puts 4e7 above lfMax → out.
  updateThresholds({ lfMin: 1e6, lfMax: 3e7 });
  sig = assembleSignals(NOW).find((s) => s.ca === CA_X);
  assert.equal(sig?.nansen.pass.lf, false);

  // Back inside [1e6, 5e7] → in.
  updateThresholds({ lfMax: 5e7 });
  sig = assembleSignals(NOW).find((s) => s.ca === CA_X);
  assert.equal(sig?.nansen.pass.lf, true);
  assert.equal(sig?.nansen.score, 2);

  // No genesis_bal → "no data", never an out-of-band FAIL: pass.lf false and lf absent even in allFactors debug.
  const CA_Y = 'caY-nogenesis-016';
  insertTrackedCa({ address: CA_Y, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_Y, {}));
  setDebugAllFactors(true);
  sig = assembleSignals(NOW).find((s) => s.ca === CA_Y);
  assert.equal(sig?.nansen.pass.lf, false);
  assert.equal(sig?.nansen.lf, undefined);
  setDebugAllFactors(false);
});

test('upsertTokenInfo: genesis_bal COALESCE — Nansen pass (omitted) keeps the holders-slot value', () => {
  const CA_G = 'caG-lfcoalesce-013';
  insertTrackedCa({ address: CA_G, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_G, { genesisBal: 2e8 })); // mock-style write
  upsertTokenInfo(token(CA_G, { price: 3 })); // Nansen-style: genesisBal omitted
  assert.equal(getTokenState(CA_G, 'sol')?.genesis_bal, 2e8);
});

test('assembleSignals: live GMGN holders win; the Nansen gini count is the fallback (user 2026-09-24)', () => {
  const CA_N = 'caN-nansen-007';
  insertTrackedCa({ address: CA_N, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_N, { holders: 1000, freshCount: 100, marketCap: 50e6 }));
  updateNansenHolders(CA_N, 'sol', { holders: 2819, freshSupplyPct: 19.217039, t100SupplyPct: 57.3, medianBalanceUsd: 13.74 });
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_N);
  assert.ok(sig);
  assert.equal(sig.holders, 1000, 'GMGN holder_count must win over the Nansen gini count');
  assert.ok(Math.abs((sig.nansen.fresh ?? 0) - 19.217039) < 1e-6, `fresh=${sig.nansen.fresh}`);
  const stN = getTokenState(CA_N, 'sol');
  assert.equal(stN?.nansen_t100_pct, 57.3);
  assert.equal(stN?.nansen_median_usd, 13.74);

  // No GMGN count yet (column 0) -> the Nansen gini figure still shows.
  const CA_F = 'caF-nansen-fallback-014';
  insertTrackedCa({ address: CA_F, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_F));
  updateNansenHolders(CA_F, 'sol', { holders: 2819, freshSupplyPct: 19.2 });
  assert.equal(assembleSignals(NOW).find((s) => s.ca === CA_F)?.holders, 2819);
});

test('upsertTokenInfo: Nansen pass (freshCount/top10Rate omitted) COALESCE-keeps last values', () => {
  const CA_K = 'caK-coalesce-008';
  insertTrackedCa({ address: CA_K, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_K, { freshCount: 42, top10Rate: 33.3 }));
  // Nansen token sweep omits both — columns must keep their last values.
  const nansenPass = { ...token(CA_K, { price: 9 }), freshCount: undefined, top10Rate: undefined };
  upsertTokenInfo(nansenPass);
  upsertTokenInfo({ ...nansenPass, price: 10 });
  const st = getTokenState(CA_K, 'sol');
  assert.equal(st?.fresh_count, 42);
  assert.ok(Math.abs((st?.top10_rate ?? 0) - 33.3) < 1e-9);
  assert.equal(st?.price, 10);
});

test('upsertTokenInfo: deployed_at write-once — later upserts without the value keep it', () => {
  const CA_DP = 'caDP-deploy-010';
  insertTrackedCa({ address: CA_DP, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo({ ...token(CA_DP), deployedAt: 1_757_363_280_000 });
  upsertTokenInfo(token(CA_DP, { price: 2 })); // no deployedAt — must NOT wipe
  assert.equal(getTokenState(CA_DP, 'sol')?.deployed_at, 1_757_363_280_000);
});

test('sanitizeSymbol: strips emoji embedded in raw token tickers', () => {
  assert.equal(sanitizeSymbol('🌱 FART'), 'FART');
  assert.equal(sanitizeSymbol('⚠️ SMART'), 'SMART');
  assert.equal(sanitizeSymbol('🚀 MOON'), 'MOON');
  assert.equal(sanitizeSymbol('MHRD'), 'MHRD'); // no emoji → unchanged
  assert.equal(sanitizeSymbol('🌱'), ''); // emoji-only → nothing left
  assert.equal(sanitizeSymbol('  $ABC  '), '$ABC'); // ASCII kept, whitespace collapsed
});

test('assembleSignals: emits the SANITIZED symbol, not the raw emoji ticker', () => {
  const CA_E = 'caE-emoji-011';
  insertTrackedCa({ address: CA_E, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_E, { symbol: '⚠️ SMART' }));
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_E);
  assert.equal(sig?.symbol, 'SMART');
});
