import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertFomoTrade, insertFomoUser, insertTrackedCa, listTrackedCas, open, upsertFomoPosition } from '../src/db.js';
import { upsertTokenInfo } from '../src/ingest.js';
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

  // alice: in-window buy (500 = post-fill size) + sell (120 = realised PnL).
  insertFomoTrade({ fomo_user_id: alice, event_id: 'fe-1', ca: CA_F, chain: 'sol', type: 'buy', usd_value: 500, ts: NOW - 3_600_000 });
  insertFomoTrade({ fomo_user_id: alice, event_id: 'fe-2', ca: CA_F, chain: 'sol', type: 'sell', usd_value: 120, ts: NOW - 1_800_000 });
  // bob: ONLY a 2d-old buy — ever-bought member, zero stats inside the window.
  insertFomoTrade({ fomo_user_id: bob, event_id: 'fe-3', ca: CA_F, chain: 'sol', type: 'buy', usd_value: 700, ts: NOW - 2 * DAY });
  // carol: sell only — never bought -> NO membership, sell uncounted.
  insertFomoTrade({ fomo_user_id: carol, event_id: 'fe-4', ca: CA_F, chain: 'sol', type: 'sell', usd_value: 90, ts: NOW - 600_000 });
  // dave: the SAME ca string on two chains — each (ca, chain) identity stands alone.
  insertFomoTrade({ fomo_user_id: dave, event_id: 'fx-1', ca: CA_X, chain: 'sol', type: 'buy', usd_value: 100, ts: NOW - 600_000 });
  insertFomoTrade({ fomo_user_id: dave, event_id: 'fx-2', ca: CA_X, chain: 'base', type: 'buy', usd_value: 50, ts: NOW - 300_000 });
  // erin: in-window buy + NEGATIVE sell (realised loss) — the sell must not reduce buyUsd.
  insertFomoTrade({ fomo_user_id: erin, event_id: 'fn-1', ca: CA_N, chain: 'sol', type: 'buy', usd_value: 400, ts: NOW - 1_200_000 });
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
  // pia: no fill resolved at all -> documented fallback to the position value.
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
  // ANTI-CATEGORY-ERROR lock: 500 (buy size), the sell's 120 lands in sellPnlUsd — NOT 620 (500+120) and NOT 380 (500−120).
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
  // carol (sell-only, NO position) stays out (lock above); frank (position
  // cost_basis 1234.5) is in with buys 0 — the buy happened, its alert did not.
  const [r] = fomoUserStats(CA_Q, 'sol', NOW);
  assert.deepStrictEqual(r, {
    handle: '@frank',
    name: 'Frank',
    buyUsd: 1234.5,
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
  insertFomoTrade({ fomo_user_id: tagged, event_id: 'tags-1', ca: CA_TAGS, chain: 'sol', type: 'buy', usd_value: 100, ts: NOW - 1000 });

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

test('fomoUserStats: with NO trade_usd the fallback is the position value (MAX), never a SUM', () => {
  const [p] = fomoUserStats(CA_P, 'sol', NOW);
  assert.ok(p);
  assert.equal(p.buyUsd, 250); // the post-fill position, not 100 + 250
  assert.equal(p.buys, 2);
});

test('fomoUserStats: with only SOME fills resolved buyUsd is the KNOWN spend (SUM skips the NULL trade_usd)', () => {
  const [m] = fomoUserStats(CA_M, 'sol', NOW);
  assert.ok(m);
  assert.equal(m.buyUsd, 60); // the one resolved fill — the unresolved 100 is not invented
  assert.equal(m.buys, 2);
});

test('fomoUserStatsByCa: the per-CA map shares the same trade_usd basis', () => {
  const [z] = fomoUserStatsByCa(NOW).get(`sol:${CA_Z}`) ?? [];
  assert.ok(z);
  assert.equal(z.buyUsd, 4975.3 + 4975.22);
});

test('fomoUserStats: a stored FOMO API position cost basis OUTRANKS the alert-derived buyUsd', () => {
  const CA = 'fomoCa-apicost-008';
  insertTrackedCa({ address: CA, chain: 'sol', note: '', entryUsd: 0 });
  const costio = insertFomoUser({ handle: '@costio', name: 'Costio' }).id;
  insertFomoTrade({ fomo_user_id: costio, event_id: 'evt-cost-1', ca: CA, chain: 'sol', type: 'buy', ts: NOW - 3_600_000, usd_value: 100 });
  insertFomoTrade({ fomo_user_id: costio, event_id: 'evt-cost-2', ca: CA, chain: 'sol', type: 'buy', ts: NOW - 1_800_000, usd_value: 250 });

  const [beforeApi] = fomoUserStats(CA, 'sol', NOW);
  assert.ok(beforeApi);
  assert.equal(beforeApi.buyUsd, 250);

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
  assert.equal(after.buyUsd, 59_844.66);
  assert.equal(after.holdingAmount, 27_003_562.7);
  assert.deepStrictEqual(fomoUserStatsByCa(NOW).get(`sol:${CA}`), [after]);
});

test('FOMO default sort timestamps use latest BUY only and stay chain-scoped', () => {
  const rows = assembleSignals(NOW, true);
  const find = (ca: string, chain = 'sol') => rows.find((s) => s.ca === ca && s.chain === chain)!;
  assert.equal(find(CA_F).fomoBuyAt, NOW - 3_600_000, 'newer sells never promote a token');
  assert.equal(find(CA_X).fomoBuyAt, NOW - 600_000);
  assert.equal(find(CA_X, 'base').fomoBuyAt, NOW - 300_000);
  assert.equal(find(CA_E).fomoBuyAt, 0, 'no captured BUY sinks to the end');
  const ca = 'fomo-sort-stale-buy';
  insertTrackedCa({ address: ca, chain: 'sol', note: '', entryUsd: 60 });
  insertFomoTrade({ fomo_user_id: bob, event_id: 'sort-old-buy', ca, chain: 'sol', type: 'buy', ts: NOW - 2 * DAY });
  assert.equal(assembleSignals(NOW, true).find((s) => s.ca === ca)?.fomoBuyAt, NOW - 2 * DAY, 'sorting is not capped at the stats window');
});
