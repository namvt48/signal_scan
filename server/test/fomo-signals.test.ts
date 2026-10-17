import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertFomoTrade, insertFomoUser, insertTrackedCa, insertWallet, listTrackedCas, open, syncFomoPositionsSnapshot, upsertFomoPosition } from '../src/db.js';
import { insertTrades, upsertTokenInfo } from '../src/ingest.js';
import { assembleSignals, fomoUserStats, fomoUserStatsByCa } from '../src/signals.js';
import type { TokenInfo } from '../src/providers/provider.js';

// FOMO stats mirror trackedWalletStats' membership-vs-window split:
// MEMBERSHIP = has EVER had a type='buy' row for this (ca, chain) (ever-bought,
// no time bound); the STATS cover the same 24h window (now - 86_400_000).
// buyUsd sums BUY usd_value only — a sell's usd_value is signed realised PnL,
// a different quantity that must never be combined (db.ts fomo_trades DDL).

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

const CA_F = 'fomoCa-main-001'; // alice (in-window buy+sell), bob (stale buy), carol (sell-only)
const CA_X = 'fomoCa-cross-002'; // same ca string on sol AND base — must not pool
const CA_E = 'fomoCa-empty-003'; // tracked, no fomo trades -> fomoUsers []
const CA_N = 'fomoCa-neg-004'; // erin: buy + negative sell (realised loss)
const CA_Z = 'fomoCa-tradeusd-005'; // zoe: 2 buys — usd_value is the running POSITION (the reported bug)
const CA_P = 'fomoCa-position-006'; // pia: 2 buys, NO trade_usd -> position-value fallback
const CA_M = 'fomoCa-mixed-007'; // mia: only the 2nd buy resolved a fill
const CA_Q = 'fomoCa-lostbuy-008'; // frank: sell-only alert + FOMO position (BUY alert lost)
const CA_TAGS = 'fomoCa-tags-009'; // tagged user — fomo_users.tags surfaces in stats

let alice = '';
let bob = '';
let carol = '';
let dave = '';
let erin = '';
let zoe = '';
let pia = '';
let mia = '';
let frank = '';

function token(ca: string, chain: 'sol' | 'base' = 'sol'): TokenInfo {
  return {
    ca,
    chain,
    price: 0.001,
    holders: 10,
    volume24h: 5000,
    buyVol24h: 3000,
    sellVol24h: 2000,
    marketCap: 1e6,
    liquidity: 5e4,
    supply: 1e9,
    freshCount: 1,
    top10Rate: 0.2,
  };
}

before(() => {
  open(':memory:');

  alice = insertFomoUser({ handle: '@alice', name: 'Alice', clan: 'fomolab' }).id;
  bob = insertFomoUser({ handle: '@bob' }).id; // name '' + clan NULL -> both keys omitted
  carol = insertFomoUser({ handle: '@carol', name: 'Carol' }).id;
  dave = insertFomoUser({ handle: '@dave', name: 'Dave' }).id;
  erin = insertFomoUser({ handle: '@erin', name: 'Erin' }).id;

  insertTrackedCa({ address: CA_F, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_X, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_X, chain: 'base', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_E, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_N, chain: 'sol', note: '', entryUsd: 60 });
  upsertTokenInfo(token(CA_F));

  // alice: in-window BUY with $500 known trade spend + sell (120 = realised PnL).
  insertFomoTrade({ fomo_user_id: alice, event_id: 'fe-1', ca: CA_F, chain: 'sol', type: 'buy', usd_value: 500, trade_usd: 500, ts: NOW - 3_600_000 });
  insertFomoTrade({ fomo_user_id: alice, event_id: 'fe-2', ca: CA_F, chain: 'sol', type: 'sell', usd_value: 120, ts: NOW - 1_800_000 });
  // bob: ONLY a 2d-old buy — ever-bought member, zero stats inside the window.
  insertFomoTrade({ fomo_user_id: bob, event_id: 'fe-3', ca: CA_F, chain: 'sol', type: 'buy', usd_value: 700, ts: NOW - 2 * DAY });
  // carol: sell only — never bought -> NO membership, sell uncounted.
  insertFomoTrade({ fomo_user_id: carol, event_id: 'fe-4', ca: CA_F, chain: 'sol', type: 'sell', usd_value: 90, ts: NOW - 600_000 });
  // dave: the SAME ca string on two chains — each (ca, chain) identity stands alone.
  insertFomoTrade({ fomo_user_id: dave, event_id: 'fx-1', ca: CA_X, chain: 'sol', type: 'buy', usd_value: 100, trade_usd: 100, ts: NOW - 600_000 });
  insertFomoTrade({ fomo_user_id: dave, event_id: 'fx-2', ca: CA_X, chain: 'base', type: 'buy', usd_value: 50, trade_usd: 50, ts: NOW - 300_000 });
  // erin: in-window buy + NEGATIVE sell (realised loss) — the sell must not reduce buyUsd.
  insertFomoTrade({ fomo_user_id: erin, event_id: 'fn-1', ca: CA_N, chain: 'sol', type: 'buy', usd_value: 400, trade_usd: 400, ts: NOW - 1_200_000 });
  insertFomoTrade({ fomo_user_id: erin, event_id: 'fn-2', ca: CA_N, chain: 'sol', type: 'sell', usd_value: -200, ts: NOW - 1_000_000 });

  // The reported bug (ZiyouCui's real shape): a buy's usd_value is the post-fill
  // POSITION, so SUM(usd_value) reads 14,954.24 for a 9,950.52 spend — inflated by
  // the buy count. buyUsd must come from trade_usd (user 2026-10-01).
  zoe = insertFomoUser({ handle: '@zoe' }).id;
  pia = insertFomoUser({ handle: '@pia' }).id;
  mia = insertFomoUser({ handle: '@mia' }).id;
  insertTrackedCa({ address: CA_Z, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_P, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_M, chain: 'sol', note: '', entryUsd: 60 });
  insertFomoTrade({ fomo_user_id: zoe, event_id: 'fz-1', ca: CA_Z, chain: 'sol', type: 'buy', usd_value: 4977.5, trade_usd: 4975.3, ts: NOW - 900_000 });
  insertFomoTrade({ fomo_user_id: zoe, event_id: 'fz-2', ca: CA_Z, chain: 'sol', type: 'buy', usd_value: 9976.74, trade_usd: 4975.22, ts: NOW - 800_000 });
  // pia: no trade_usd fill was resolved; usd_value is a position stock, not buy spend.
  insertFomoTrade({ fomo_user_id: pia, event_id: 'fp-1', ca: CA_P, chain: 'sol', type: 'buy', usd_value: 100, ts: NOW - 750_000 });
  insertFomoTrade({ fomo_user_id: pia, event_id: 'fp-2', ca: CA_P, chain: 'sol', type: 'buy', usd_value: 250, ts: NOW - 700_000 });
  // mia: only the 2nd buy carries trade_usd -> buyUsd is the KNOWN spend.
  insertFomoTrade({ fomo_user_id: mia, event_id: 'fm-1', ca: CA_M, chain: 'sol', type: 'buy', usd_value: 100, ts: NOW - 650_000 });
  insertFomoTrade({ fomo_user_id: mia, event_id: 'fm-2', ca: CA_M, chain: 'sol', type: 'buy', usd_value: 1000, trade_usd: 60, ts: NOW - 600_000 });

  // frank: FOMO recorded the bought position but the BUY alert never arrived —
  // the firehose has no backfill, so only his SELL is a fomo_trades row. He must
  // still be a member (user 2026-10-02 Nailoong: cryptokillua99/397397/EarlyBurry).
  frank = insertFomoUser({ handle: '@frank', name: 'Frank' }).id;
  insertTrackedCa({ address: CA_Q, chain: 'sol', note: '', entryUsd: 60 });
  insertFomoTrade({ fomo_user_id: frank, event_id: 'fq-1', ca: CA_Q, chain: 'sol', type: 'sell', usd_value: 90, ts: NOW - 600_000 });
  upsertFomoPosition({
    fomo_user_id: frank, ca: CA_Q, chain: 'sol', trade_id: null, status: 'open',
    amount: 1000, cost_basis_usd: 1234.5, avg_entry_price: 0.001, price_usd: 0.002,
    realized_pnl_usd: 0, unrealized_pnl_usd: 0, fetched_at: NOW,
  });
});

test('fomoUserStats: buyUsd sums BUYS only — the sell usd_value (realised PnL) is neither added nor subtracted', () => {
  const rows = fomoUserStats(CA_F, 'sol', NOW);
  // Newest-trade-first: alice's sell (NOW-30m) leads; bob has no in-window trade (lastTs 0).
  assert.deepEqual(rows.map((r) => r.handle), ['@alice', '@bob']);

  const a = rows[0];
  assert.ok(a);
  // 500 actual spend; the sell's 120 lands in sellPnlUsd — NOT 620 (500+120) and NOT 380 (500−120).
  assert.equal(a.buyUsd, 500);
  assert.equal(a.sellPnlUsd, 120);
  assert.equal(a.buys, 1);
  assert.equal(a.sells, 1);
  assert.equal(a.trades, 2);
  assert.equal(a.lastTs, NOW - 1_800_000);
  assert.deepStrictEqual(a, {
    handle: '@alice',
    name: 'Alice',
    clan: 'fomolab',
    buyUsd: 500,
    sellPnlUsd: 120,
    buys: 1,
    sells: 1,
    trades: 2,
    lastTs: NOW - 1_800_000,
  });
  // Key order must match the interface (JSON byte-stability).
  assert.deepEqual(Object.keys(a), ['handle', 'name', 'clan', 'buyUsd', 'sellPnlUsd', 'buys', 'sells', 'trades', 'lastTs']);
});

test('fomoUserStats: a buy older than 24h still lists the user with zero stats (ever-bought membership)', () => {
  const b = fomoUserStats(CA_F, 'sol', NOW).find((r) => r.handle === '@bob');
  // Handle-only user -> name mirrors the handle (user 2026-10-01); clan NULL -> key omitted.
  assert.deepStrictEqual(b, { handle: '@bob', name: '@bob', buyUsd: 0, sellPnlUsd: 0, buys: 0, sells: 0, trades: 0, lastTs: 0 });
  assert.deepEqual(Object.keys(b ?? {}), ['handle', 'name', 'buyUsd', 'sellPnlUsd', 'buys', 'sells', 'trades', 'lastTs']);
});

test('fomoUserStats: a sell-only user is NOT listed (membership is ever-bought)', () => {
  const rows = fomoUserStats(CA_F, 'sol', NOW);
  assert.ok(!rows.some((r) => r.handle === '@carol'), 'carol never bought this (ca, chain) — absent');
  assert.equal(rows.length, 2); // her 90 USD sell moves nothing
});

test('fomoUserStats: a sell-only user IS listed when FOMO recorded a bought position (lost BUY alert)', () => {
  // carol (sell-only, NO position) stays out; Frank's position keeps him listed,
  // but no missing BUY alert contributes to 24h Buy $.
  const [r] = fomoUserStats(CA_Q, 'sol', NOW);
  assert.deepStrictEqual(r, {
    handle: '@frank',
    name: 'Frank',
    buyUsd: 0,
    sellPnlUsd: 90,
    buys: 0,
    sells: 1,
    trades: 1,
    lastTs: NOW - 600_000,
    holdingAmount: 1000,
  });
  assert.deepStrictEqual(fomoUserStatsByCa(NOW).get(`sol:${CA_Q}`), [r]);
});

test('fomoUserStats: fomo_users.tags surface as a tags array (key present only when tagged)', () => {
  const tagged = insertFomoUser({ handle: '@tagged-fomo', name: 'Tagged', tags: ['Unicon'] }).id;
  insertTrackedCa({ address: CA_TAGS, chain: 'sol', note: '', entryUsd: 60 });
  insertFomoTrade({ fomo_user_id: tagged, event_id: 'tags-1', ca: CA_TAGS, chain: 'sol', type: 'buy', usd_value: 100, trade_usd: 100, ts: NOW - 1000 });

  const [r] = fomoUserStats(CA_TAGS, 'sol', NOW);
  assert.deepStrictEqual(r, {
    handle: '@tagged-fomo',
    name: 'Tagged',
    tags: ['Unicon'],
    buyUsd: 100,
    sellPnlUsd: 0,
    buys: 1,
    sells: 0,
    trades: 1,
    lastTs: NOW - 1000,
  });
  // tags sits between name and buyUsd, and only exists when non-empty.
  assert.deepEqual(Object.keys(r ?? {}), ['handle', 'name', 'tags', 'buyUsd', 'sellPnlUsd', 'buys', 'sells', 'trades', 'lastTs']);
  assert.deepStrictEqual(fomoUserStatsByCa(NOW).get(`sol:${CA_TAGS}`), [r]);
});

test('fomoUserStats: the same ca on two chains does not pool', () => {
  assert.deepStrictEqual(fomoUserStats(CA_X, 'sol', NOW), [
    { handle: '@dave', name: 'Dave', buyUsd: 100, sellPnlUsd: 0, buys: 1, sells: 0, trades: 1, lastTs: NOW - 600_000 },
  ]);
  assert.deepStrictEqual(fomoUserStats(CA_X, 'base', NOW), [
    { handle: '@dave', name: 'Dave', buyUsd: 50, sellPnlUsd: 0, buys: 1, sells: 0, trades: 1, lastTs: NOW - 300_000 },
  ]);
});

test('fomoUserStats: a NEGATIVE sell usd_value (realised loss) lands in sellPnlUsd and never touches buyUsd', () => {
  const [r] = fomoUserStats(CA_N, 'sol', NOW);
  assert.ok(r);
  assert.equal(r.buyUsd, 400);
  assert.equal(r.sellPnlUsd, -200);
  assert.equal(r.buys, 1);
  assert.equal(r.sells, 1);
  assert.deepEqual(Object.keys(r), ['handle', 'name', 'buyUsd', 'sellPnlUsd', 'buys', 'sells', 'trades', 'lastTs']);
  const byCa = fomoUserStatsByCa(NOW).get(`sol:${CA_N}`);
  assert.deepStrictEqual(byCa, [r]);
});

test('fomoUserStatsByCa matches fomoUserStats for every tracked CA', () => {
  const all = fomoUserStatsByCa(NOW);
  for (const c of listTrackedCas()) {
    assert.deepStrictEqual(
      all.get(`${c.chain}:${c.address}`) ?? [],
      fomoUserStats(c.address, c.chain, NOW),
      `fomo stats ${c.chain}:${c.address}`,
    );
  }
  // A CA with no fomo members is ABSENT from the map (callers read `?? []`).
  assert.equal(all.get(`sol:${CA_E}`), undefined);
});

test('assembleSignals: fomoUsers populated; FOMO trades leak nothing into the tracked-wallet path', () => {
  const sig = assembleSignals(NOW).find((s) => s.ca === CA_F);
  assert.ok(sig);
  assert.deepEqual(sig.fomoUsers.map((u) => u.handle), ['@alice', '@bob']);
  assert.deepStrictEqual(sig.fomoUsers[0], {
    handle: '@alice',
    name: 'Alice',
    clan: 'fomolab',
    buyUsd: 500,
    sellPnlUsd: 120,
    buys: 1,
    sells: 1,
    trades: 2,
    lastTs: NOW - 1_800_000,
  });
  // NO-LEAKAGE lock: this fixture has fomo trades but ZERO source='watch' trades —
  // every existing tracked-wallet field must sit at its no-data value.
  assert.deepStrictEqual(sig.trackedWallets, []);
  assert.equal(sig.trackedInflow, 0);
  assert.equal(sig.trackedActivityAt, 0);
  assert.equal(sig.trackedHolding, 0);

  // A tracked CA with no fomo trades defaults to [].
  const empty = assembleSignals(NOW).find((s) => s.ca === CA_E);
  assert.ok(empty);
  assert.deepStrictEqual(empty.fomoUsers, []);
});


test('fomoUserStats: buyUsd sums trade_usd — a buy usd_value is a POSITION, so summing it inflates by the buy count', () => {
  const [z] = fomoUserStats(CA_Z, 'sol', NOW);
  assert.ok(z);
  assert.equal(z.buyUsd, 4975.3 + 4975.22);
  assert.notEqual(z.buyUsd, 4977.5 + 9976.74); // the bug read 14,954.24 for a 9,950.52 spend
  assert.equal(z.buys, 2);
});

test('fomoUserStats: three unresolved 24h buys stay unknown despite position values and cost basis', () => {
  const CA = 'fomoCa-unresolved-three-buys';
  insertTrackedCa({ address: CA, chain: 'sol', note: '', entryUsd: 0 });
  const user = insertFomoUser({ handle: '@unresolved' }).id;
  for (const [i, usd_value] of [9950.06, 21043.91, 29829.77].entries()) {
    insertFomoTrade({
      fomo_user_id: user, event_id: `evt-unresolved-${i}`, ca: CA, chain: 'sol', type: 'buy',
      usd_value, ts: NOW - i * 60_000,
    });
  }
  upsertFomoPosition({
    fomo_user_id: user, ca: CA, chain: 'sol', trade_id: null, status: 'open',
    amount: 4_383_733.08, cost_basis_usd: 19_900.12, avg_entry_price: 0.00453954,
    price_usd: 0.004053, realized_pnl_usd: 0, unrealized_pnl_usd: -2132.42, fetched_at: NOW,
  });

  const [stat] = fomoUserStats(CA, 'sol', NOW);
  assert.ok(stat);
  assert.equal(stat.buyUsd, null);
  assert.equal(stat.buys, 3);
  assert.equal(stat.trades, 3);
});

test('fomoUserStats: partial fill amounts do not masquerade as a complete Buy $ total', () => {
  const [m] = fomoUserStats(CA_M, 'sol', NOW);
  assert.ok(m);
  assert.equal(m.buyUsd, null);
  assert.equal(m.buys, 2);
});

test('fomoUserStatsByCa: the per-CA map shares the same trade_usd basis', () => {
  const [z] = fomoUserStatsByCa(NOW).get(`sol:${CA_Z}`) ?? [];
  assert.ok(z);
  assert.equal(z.buyUsd, 4975.3 + 4975.22);
});

test('fomoUserStats: Buy $ is only known trade_usd from the inclusive trailing 24h', () => {
  const CA = 'fomoCa-24h-window-011';
  insertTrackedCa({ address: CA, chain: 'sol', note: '', entryUsd: 0 });
  const user = insertFomoUser({ handle: '@windowed' }).id;
  insertFomoTrade({
    fomo_user_id: user, event_id: 'evt-old', ca: CA, chain: 'sol', type: 'buy',
    trade_usd: 900, usd_value: 1100, ts: NOW - DAY - 1,
  });
  insertFomoTrade({
    fomo_user_id: user, event_id: 'evt-cutoff', ca: CA, chain: 'sol', type: 'buy',
    trade_usd: 40, usd_value: 1200, ts: NOW - DAY,
  });
  upsertFomoPosition({
    fomo_user_id: user, ca: CA, chain: 'sol', trade_id: null, status: 'open',
    amount: 100, cost_basis_usd: 99_999, avg_entry_price: 0.01, price_usd: 0.02,
    realized_pnl_usd: 0, unrealized_pnl_usd: 0, fetched_at: NOW,
  });

  const [single] = fomoUserStats(CA, 'sol', NOW);
  assert.ok(single);
  assert.equal(single.buyUsd, 40);
  assert.equal(single.buys, 1);
  assert.equal(single.trades, 1);
  const [batched] = fomoUserStatsByCa(NOW).get(`sol:${CA}`) ?? [];
  assert.deepStrictEqual(batched, single);
});

test('fomoUserStats: a stored FOMO API position does not enter 24h Buy $', () => {
  const CA = 'fomoCa-apicost-008';
  insertTrackedCa({ address: CA, chain: 'sol', note: '', entryUsd: 0 });
  const costio = insertFomoUser({ handle: '@costio', name: 'Costio' }).id;
  insertFomoTrade({ fomo_user_id: costio, event_id: 'evt-cost-1', ca: CA, chain: 'sol', type: 'buy', ts: NOW - 3_600_000, usd_value: 100 });
  insertFomoTrade({ fomo_user_id: costio, event_id: 'evt-cost-2', ca: CA, chain: 'sol', type: 'buy', ts: NOW - 1_800_000, usd_value: 250 });

  const [beforeApi] = fomoUserStats(CA, 'sol', NOW);
  assert.ok(beforeApi);
  assert.equal(beforeApi.buyUsd, null);

  upsertFomoPosition({
    fomo_user_id: costio,
    ca: CA,
    chain: 'sol',
    trade_id: 't-1',
    status: 'open',
    amount: 27_003_562.7,
    cost_basis_usd: 59_844.66,
    avg_entry_price: 0.00221618,
    price_usd: 0.00250932,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 7_916.05,
    fetched_at: NOW,
  });

  const [after] = fomoUserStats(CA, 'sol', NOW);
  assert.ok(after);
  assert.equal(after.buyUsd, null);
  assert.equal(after.holdingAmount, 27_003_562.7);
  assert.deepStrictEqual(fomoUserStatsByCa(NOW).get(`sol:${CA}`), [after]);
});


test('FOMO activity includes newer sells and native watch activity, remains chain-scoped', () => {
  const ca = 'fomo-activity-sort-regression';
  const user = insertFomoUser({ handle: '@activity-sort' });
  insertTrackedCa({ address: ca, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'activity-buy-sol', ca, chain: 'sol', type: 'buy', ts: NOW - 5000 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'activity-sell-sol', ca, chain: 'sol', type: 'sell', ts: NOW - 3000 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'activity-buy-base', ca, chain: 'base', type: 'buy', ts: NOW - 4000 });
  const wallet = insertWallet({ address: 'fomo-activity-native', name: 'Native', tags: [], chain: 'sol', source: 'test' });
  insertTrades(wallet.id, [
    { tx: 'activity-native-buy', ts: NOW - 2000, side: 'buy', ca, chain: 'sol', amountUsd: 20, price: 0.001 },
    { tx: 'activity-native-sell', ts: NOW - 1000, side: 'sell', ca, chain: 'sol', amountUsd: 10, price: 0.001 },
  ], 'watch');
  const staleCa = 'fomo-activity-old-sort-regression';
  insertTrackedCa({ address: staleCa, chain: 'sol', note: '', entryUsd: 60 });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'activity-stale-buy', ca: staleCa, chain: 'sol', type: 'buy', ts: NOW - 2 * DAY });
  const rows = assembleSignals(NOW, true);
  assert.equal(rows.find((row) => row.ca === ca && row.chain === 'sol')?.fomoActivityAt, NOW - 1000);
  assert.equal(rows.find((row) => row.ca === ca && row.chain === 'base')?.fomoActivityAt, NOW - 4000);
  assert.equal(rows.find((row) => row.ca === staleCa && row.chain === 'sol')?.fomoActivityAt, NOW - 2 * DAY, 'sorting activity is not capped at the stats window');
});

test('FOMO position amount and derived percentage beat a zero RPC holding in both aggregations', () => {
  const ca = 'fomo-api-holding-priority-012';
  const user = insertFomoUser({ handle: '@api-holding-priority' });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'api-holding-priority-buy', ca, chain: 'base', type: 'buy', usd_value: 10, ts: NOW - 1000 });
  upsertFomoPosition({
    fomo_user_id: user.id, ca, chain: 'base', trade_id: null, status: 'open',
    amount: 120, cost_basis_usd: 10, avg_entry_price: 1, price_usd: 1,
    realized_pnl_usd: 0, unrealized_pnl_usd: 0, fetched_at: NOW,
  });
  getDb().prepare('INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, pct, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, ca, 'base', '0x0000000000000000000000000000000000000abc', 0, 0, NOW);

  const direct = fomoUserStats(ca, 'base', NOW);
  const batched = fomoUserStatsByCa(NOW).get(`base:${ca}`);
  assert.equal(direct[0]?.holdingAmount, 120);
  assert.ok(Math.abs((direct[0]?.holdingPct ?? Number.NaN) - 0.000012) < 1e-18);
  assert.deepEqual(batched, direct);
});

test('FOMO measured zero position remains zero instead of falling back to positive RPC balance', () => {
  const ca = 'fomo-api-zero-position-013';
  const user = insertFomoUser({ handle: '@api-zero-position' });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'api-zero-position-buy', ca, chain: 'base', type: 'buy', usd_value: 10, ts: NOW - 1000 });
  upsertFomoPosition({
    fomo_user_id: user.id, ca, chain: 'base', trade_id: null, status: 'open',
    amount: 0, cost_basis_usd: 10, avg_entry_price: 1, price_usd: 1,
    realized_pnl_usd: 0, unrealized_pnl_usd: 0, fetched_at: NOW,
  });
  getDb().prepare('INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, pct, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, ca, 'base', '0x0000000000000000000000000000000000000def', 50, 0.000005, NOW);
  const direct = fomoUserStats(ca, 'base', NOW);
  assert.equal(direct[0]?.holdingAmount, 0);
  assert.equal(direct[0]?.holdingPct, 0);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), direct);
});

test('stale RPC holding is unknown rather than a current measured zero', () => {
  const ca = 'fomo-stale-rpc-holding-015';
  const user = insertFomoUser({ handle: '@stale-rpc-holding' });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'stale-rpc-holding-buy', ca, chain: 'base', type: 'buy', usd_value: 10, ts: NOW - 1000 });
  getDb().prepare('INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, pct, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, ca, 'base', '0x0000000000000000000000000000000000000beef', 0, 0, NOW);
  const recent = fomoUserStats(ca, 'base', NOW);
  assert.equal(recent[0]?.holdingAmount, 0, 'recently measured RPC zero remains a valid measurement');
  assert.equal(recent[0]?.holdingPct, 0);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), recent);
  getDb().prepare('UPDATE fomo_holdings SET measured_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW - 86_400_001, user.id, ca, 'base');
  const stale = fomoUserStats(ca, 'base', NOW);
  assert.equal(stale[0]?.holdingAmount, undefined);
  assert.equal(stale[0]?.holdingPct, undefined);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), stale);
});

for (const scenario of [
  { name: 'PILL balance with missing pct', supply: 1e9, amount: 19974625.93, pct: null, expected: 1.997462593 },
  { name: 'measured zero balance', supply: 1e9, amount: 0, pct: null, expected: 0 },
  { name: 'unknown supply', supply: null, amount: 100, pct: null, expected: undefined },
  { name: 'zero supply', supply: 0, amount: 100, pct: null, expected: undefined },
  { name: 'negative supply', supply: -100, amount: 100, pct: null, expected: undefined },
  { name: 'existing pct takes priority', supply: 1e9, amount: 100, pct: 0.25, expected: 0.25 },
  { name: 'existing zero pct takes priority', supply: 1e9, amount: 100, pct: 0, expected: 0 },
  { name: 'stale snapshot', supply: 1e9, amount: 100, pct: null, expected: undefined, age: DAY + 1 },
  { name: 'unavailable snapshot', supply: 1e9, amount: 100, pct: null, expected: undefined, available: 0 },
  { name: 'mismatched snapshot', supply: 1e9, amount: 100, pct: null, expected: undefined, mismatch: 1 },
]) {
  test(`API holding percentage: ${scenario.name} in both aggregations`, () => {
    const ca = `api-pct-${scenario.name.replaceAll(' ', '-')}`;
    const user = insertFomoUser({ handle: `@${ca}` });
    upsertTokenInfo(token(ca));
    getDb().prepare('UPDATE token_state SET supply = ? WHERE ca = ? AND chain = ?').run(scenario.supply, ca, 'sol');
    insertFomoTrade({ fomo_user_id: user.id, event_id: `${ca}-buy`, ca, chain: 'sol', type: 'buy', trade_usd: 10, ts: NOW - 1000 });
    const capturedAt = NOW - (scenario.age ?? 0);
    getDb().prepare('INSERT INTO fomo_api_holdings (fomo_user_id, ca, chain, amount, pct, captured_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, ca, 'sol', scenario.amount, scenario.pct, capturedAt);
    getDb().prepare('INSERT INTO fomo_api_balance_snapshots (fomo_user_id, checked_at, captured_at, complete, truncated, available) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, NOW, capturedAt + (scenario.mismatch ?? 0), 1, 0, scenario.available ?? 1);
    const direct = fomoUserStats(ca, 'sol', NOW);
    const batched = fomoUserStatsByCa(NOW).get(`sol:${ca}`);
    for (const rows of [direct, batched]) {
      assert.ok(rows?.[0]);
      if (scenario.expected === undefined) {
        assert.equal(rows[0].holdingPct, undefined);
      } else {
        assert.ok(Math.abs((rows[0].holdingPct ?? Number.NaN) - scenario.expected) < 1e-12);
      }
      if (!scenario.age && scenario.available !== 0 && !scenario.mismatch) {
        assert.equal(rows[0].holdingAmount, scenario.amount);
      }
    }
  });
}


test('fresh FOMO API balance beats position and RPC measurements in both aggregations', () => {
  const ca = 'fomo-api-balances-priority-014';
  const user = insertFomoUser({ handle: '@api-balances-priority' });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'api-balances-priority-buy', ca, chain: 'base', type: 'buy', usd_value: 10, ts: NOW - 1000 });
  upsertFomoPosition({
    fomo_user_id: user.id, ca, chain: 'base', trade_id: null, status: 'open',
    amount: 90, cost_basis_usd: 10, avg_entry_price: 1, price_usd: 1,
    realized_pnl_usd: 0, unrealized_pnl_usd: 0, fetched_at: NOW,
  });
  getDb().prepare('INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, pct, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, ca, 'base', '0x0000000000000000000000000000000000000aaa', 0, 0, NOW);
  getDb().prepare('INSERT INTO fomo_api_holdings (fomo_user_id, ca, chain, amount, pct, captured_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, ca, 'base', 150, 0.000015, NOW);
  getDb().prepare('INSERT INTO fomo_api_balance_snapshots (fomo_user_id, checked_at, captured_at, complete, truncated, available) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, NOW, NOW, 1, 0, 1);
  const direct = fomoUserStats(ca, 'base', NOW);
  const batched = fomoUserStatsByCa(NOW).get(`base:${ca}`);
  assert.equal(direct[0]?.holdingAmount, 150);
  assert.equal(direct[0]?.holdingPct, 0.000015);
  assert.equal(direct[0]?.balUsd, 0.15, 'Bal is current token units × the chain-scoped token price');
  assert.deepEqual(batched, direct);
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET complete = 0, truncated = 1 WHERE fomo_user_id = ?').run(user.id);
  assert.equal(fomoUserStats(ca, 'base', NOW)[0]?.holdingAmount, 150, 'a token present in a truncated API snapshot remains a valid measurement');
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET complete = 1, truncated = 0 WHERE fomo_user_id = ?').run(user.id);
  getDb().prepare('UPDATE fomo_positions SET amount = NULL, fetched_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW + 1, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_holdings SET captured_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW - 1000, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET captured_at = ? WHERE fomo_user_id = ?')
    .run(NOW - 1000, user.id);
  const apiWhenPositionUnknown = fomoUserStats(ca, 'base', NOW);
  assert.equal(apiWhenPositionUnknown[0]?.holdingAmount, 150, 'newer position rows with NULL amount do not suppress a valid balances value');
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), apiWhenPositionUnknown);
  getDb().prepare('UPDATE fomo_positions SET amount = 90, fetched_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_holdings SET captured_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW - 1000, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET captured_at = ? WHERE fomo_user_id = ?')
    .run(NOW - 1000, user.id);
  const newerPosition = fomoUserStats(ca, 'base', NOW);
  assert.equal(newerPosition[0]?.holdingAmount, 90, 'newer /trades data beats an older still-fresh /balances snapshot');
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), newerPosition);
  getDb().prepare('UPDATE fomo_api_holdings SET amount = 0, pct = 0, captured_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET captured_at = ? WHERE fomo_user_id = ?')
    .run(NOW, user.id);
  const apiZero = fomoUserStats(ca, 'base', NOW);
  assert.equal(apiZero[0]?.holdingAmount, 0, 'API-measured zero is not replaced by positive lower-priority sources');
  assert.equal(apiZero[0]?.holdingPct, 0);
  assert.equal(apiZero[0]?.balUsd, 0, 'a measured zero holding remains $0');
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), apiZero);
  getDb().prepare('UPDATE fomo_api_holdings SET captured_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW - 86_400_001, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET captured_at = ? WHERE fomo_user_id = ?')
    .run(NOW - 86_400_001, user.id);
  const staleApi = fomoUserStats(ca, 'base', NOW);
  assert.equal(staleApi[0]?.holdingAmount, 90, 'stale API rows fall back to position amount');
  assert.equal(staleApi[0]?.holdingPct, 0.000009);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), staleApi);
  getDb().prepare('UPDATE fomo_positions SET amount = NULL WHERE fomo_user_id = ? AND ca = ? AND chain = ?').run(user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_holdings SET captured_at = ? WHERE fomo_user_id = ? AND ca = ? AND chain = ?')
    .run(NOW - 1000, user.id, ca, 'base');
  getDb().prepare('UPDATE fomo_api_balance_snapshots SET captured_at = ?, complete = 0, truncated = 1 WHERE fomo_user_id = ?')
    .run(NOW - 500, user.id);
  const omittedByNewPartialSnapshot = fomoUserStats(ca, 'base', NOW);
  assert.equal(omittedByNewPartialSnapshot[0]?.holdingAmount, 0, 'a prior API row omitted by a newer partial snapshot is not current');
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), omittedByNewPartialSnapshot);
});
test('FOMO positions retain token amounts across unchanged snapshots and revalue Bal at live price', () => {
  const ca = 'fomo-position-live-price-023';
  const user = insertFomoUser({ handle: '@position-live-price' });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'position-live-price-buy', ca, chain: 'base', type: 'buy', ts: NOW });

  const position = (amount: number, fetched_at: number) => ({
    fomo_user_id: user.id,
    ca,
    chain: 'base' as const,
    trade_id: 'position-live-price-id',
    status: 'open',
    amount,
    cost_basis_usd: 50,
    avg_entry_price: 0.5,
    price_usd: 0.5,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    fetched_at,
  });

  syncFomoPositionsSnapshot(user.id, [position(100, NOW)], NOW);
  getDb().prepare('UPDATE token_state SET price = ? WHERE ca = ? AND chain = ?').run(0.001, ca, 'base');
  assert.equal(fomoUserStats(ca, 'base', NOW)[0]?.balUsd, 0.1);

  getDb().prepare('UPDATE token_state SET price = ? WHERE ca = ? AND chain = ?').run(0.002, ca, 'base');
  assert.equal(fomoUserStats(ca, 'base', NOW)[0]?.balUsd, 0.2, 'market price changes revalue the stored token amount');

  syncFomoPositionsSnapshot(user.id, [position(100, NOW + 1_000)], NOW + 1_000);
  const unchanged = getDb().prepare(
    'SELECT amount, fetched_at FROM fomo_positions WHERE fomo_user_id = ? AND ca = ? AND chain = ?',
  ).get(user.id, ca, 'base') as { amount: number; fetched_at: number };
  assert.deepEqual(unchanged, { amount: 100, fetched_at: NOW }, 'unchanged positions do not rewrite the stored position');
  assert.equal(fomoUserStats(ca, 'base', NOW + 1_000)[0]?.balUsd, 0.2, 'snapshot check time keeps the unchanged amount fresh');

  syncFomoPositionsSnapshot(user.id, [position(150, NOW + 2_000)], NOW + 2_000);
  const changed = getDb().prepare(
    'SELECT amount, fetched_at FROM fomo_positions WHERE fomo_user_id = ? AND ca = ? AND chain = ?',
  ).get(user.id, ca, 'base') as { amount: number; fetched_at: number };
  assert.deepEqual(changed, { amount: 150, fetched_at: NOW + 2_000 });
  assert.equal(fomoUserStatsByCa(NOW + 2_000).get(`base:${ca}`)?.[0]?.balUsd, 0.3);
});

test('positive position amount keeps a FOMO user visible when cost basis is absent', () => {
  const ca = 'fomo-position-no-cost-basis-024';
  const user = insertFomoUser({ handle: '@position-no-cost-basis' });
  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  syncFomoPositionsSnapshot(user.id, [{
    fomo_user_id: user.id,
    ca,
    chain: 'base',
    trade_id: null,
    status: 'open',
    amount: 12,
    cost_basis_usd: null,
    avg_entry_price: null,
    price_usd: 0.001,
    realized_pnl_usd: null,
    unrealized_pnl_usd: null,
    fetched_at: NOW,
  }], NOW);

  const direct = fomoUserStats(ca, 'base', NOW);
  assert.equal(direct[0]?.holdingAmount, 12);
  assert.equal(direct[0]?.balUsd, 0.012);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), direct);
});

test('FOMO Bal is chain-scoped and preserves unknown versus measured zero', () => {
  const ca = 'fomo-bal-chain-scope-020';
  const unknownCa = 'fomo-bal-unknown-021';
  const zeroCa = 'fomo-bal-zero-022';
  const known = insertFomoUser({ handle: '@bal-known' });
  const unknown = insertFomoUser({ handle: '@bal-unknown' });
  const zero = insertFomoUser({ handle: '@bal-zero' });

  insertTrackedCa({ address: ca, chain: 'base', note: '', entryUsd: 60 });
  insertTrackedCa({ address: ca, chain: 'bsc', note: '', entryUsd: 60 });
  insertTrackedCa({ address: unknownCa, chain: 'base', note: '', entryUsd: 60 });
  insertTrackedCa({ address: zeroCa, chain: 'robinhood', note: '', entryUsd: 60 });
  upsertTokenInfo(token(ca, 'base'));
  upsertTokenInfo({ ...token(ca, 'base'), chain: 'bsc', price: 0.002 });
  upsertTokenInfo(token(unknownCa, 'base'));

  insertFomoTrade({ fomo_user_id: known.id, event_id: 'bal-known-base', ca, chain: 'base', type: 'buy', ts: NOW - 1000 });
  insertFomoTrade({ fomo_user_id: known.id, event_id: 'bal-known-bsc', ca, chain: 'bsc', type: 'buy', ts: NOW - 1000 });
  insertFomoTrade({ fomo_user_id: unknown.id, event_id: 'bal-unknown-base', ca: unknownCa, chain: 'base', type: 'buy', ts: NOW - 1000 });
  insertFomoTrade({ fomo_user_id: zero.id, event_id: 'bal-zero-rh', ca: zeroCa, chain: 'robinhood', type: 'buy', ts: NOW - 1000 });

  getDb().prepare('INSERT INTO fomo_api_holdings (fomo_user_id, ca, chain, amount, pct, captured_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(known.id, ca, 'base', 100, null, NOW);
  getDb().prepare('INSERT INTO fomo_api_holdings (fomo_user_id, ca, chain, amount, pct, captured_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(known.id, ca, 'bsc', 100, null, NOW);
  getDb().prepare('INSERT INTO fomo_api_balance_snapshots (fomo_user_id, checked_at, captured_at, complete, truncated, available) VALUES (?, ?, ?, ?, ?, ?)')
    .run(known.id, NOW, NOW, 1, 0, 1);
  getDb().prepare('INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, pct, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(zero.id, zeroCa, 'robinhood', '0x0000000000000000000000000000000000000abc', 0, 0, NOW);

  const baseRows = fomoUserStats(ca, 'base', NOW);
  const bscRows = fomoUserStats(ca, 'bsc', NOW);
  assert.equal(baseRows.find((row) => row.handle === known.handle)?.balUsd, 0.1);
  assert.equal(bscRows.find((row) => row.handle === known.handle)?.balUsd, 0.2);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${ca}`), baseRows);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`bsc:${ca}`), bscRows);

  const unknownRows = fomoUserStats(unknownCa, 'base', NOW);
  assert.equal(unknownRows[0]?.holdingAmount, undefined);
  assert.equal(unknownRows[0]?.balUsd, undefined);
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`base:${unknownCa}`), unknownRows);

  const zeroRows = fomoUserStats(zeroCa, 'robinhood', NOW);
  assert.equal(zeroRows[0]?.holdingAmount, 0);
  assert.equal(zeroRows[0]?.balUsd, 0, 'zero is exact even when token price is unavailable');
  assert.deepEqual(fomoUserStatsByCa(NOW).get(`robinhood:${zeroCa}`), zeroRows);
});
