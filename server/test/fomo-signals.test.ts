import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertFomoTrade, insertFomoUser, insertTrackedCa, listTrackedCas, open } from '../src/db.js';
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

let alice = '';
let bob = '';
let carol = '';
let dave = '';
let erin = '';

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
  // name ''/clan NULL -> keys OMITTED (deepStrictEqual fails on undefined-valued keys).
  assert.deepStrictEqual(b, { handle: '@bob', buyUsd: 0, sellPnlUsd: 0, buys: 0, sells: 0, trades: 0, lastTs: 0 });
  assert.deepEqual(Object.keys(b ?? {}), ['handle', 'buyUsd', 'sellPnlUsd', 'buys', 'sells', 'trades', 'lastTs']);
});

test('fomoUserStats: a sell-only user is NOT listed (membership is ever-bought)', () => {
  const rows = fomoUserStats(CA_F, 'sol', NOW);
  assert.ok(!rows.some((r) => r.handle === '@carol'), 'carol never bought this (ca, chain) — absent');
  assert.equal(rows.length, 2); // her 90 USD sell moves nothing
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
