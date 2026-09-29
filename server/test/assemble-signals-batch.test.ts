import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { allTokenStates, getTokenState, insertTrackedCa, insertWallet, listTrackedCas, open } from '../src/db.js';
import { insertTrades, replaceWalletBalances, upsertTokenInfo } from '../src/ingest.js';
import { sumHoldingAmount, sumHoldingAmountByCa, trackedWalletStats, trackedWalletStatsByCa } from '../src/signals.js';
import { canonicalCa } from '../src/shared/chain.js';
import type { TokenInfo, WalletActivity } from '../src/providers/provider.js';

// Batched-vs-per-CA equivalence lock for the /api/signals N+1 fix: for EVERY
// tracked CA the batched map lookup must deep-equal the per-CA function result.

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

const CA1 = 'batchCa-001'; // active member + member with no trade in the 24h window
const CA2 = 'batchCa-002'; // 8d-old watch buy -> ever-bought member with zero 24h stats
const CA_EVM_UPPER = '0xAbC0000000000000000000000000000000000dEf'; // canonicalCa parity
const CA_EVM = canonicalCa(CA_EVM_UPPER, 'base');

let w1 = '';
let w2 = '';
let w3 = '';

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

function activity(tx: string, side: 'buy' | 'sell', amountUsd: number, ts: number, ca: string, chain: 'sol' | 'base' = 'sol'): WalletActivity {
  return { tx, ts, side, ca, chain, amountUsd, price: 0.001 };
}

before(() => {
  open(':memory:');

  w1 = insertWallet({ address: 'batchAddr-1', name: 'A1', tags: ['Unicon'], chain: 'sol', source: 'test', clan: 'x' }).id;
  w2 = insertWallet({ address: 'batchAddr-2', name: 'B2', tags: [], chain: 'sol', source: 'test' }).id;
  w3 = insertWallet({ address: 'batchAddr-3', name: 'C3', tags: [], chain: 'sol', source: 'test' }).id;

  insertTrackedCa({ address: CA1, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA2, chain: 'sol', note: '', entryUsd: 60 });
  insertTrackedCa({ address: CA_EVM_UPPER, chain: 'base', note: '', entryUsd: 60 });

  upsertTokenInfo(token(CA1));
  upsertTokenInfo(token(CA2));
  upsertTokenInfo(token(CA_EVM, 'base'));

  replaceWalletBalances(w1, 'sol', [
    { ca: CA1, amount: 1000 },
    { ca: CA2, amount: 2000 },
  ]);
  replaceWalletBalances(w2, 'sol', [{ ca: CA1, amount: 500 }]);
  replaceWalletBalances(w3, 'sol', [{ ca: CA1, amount: 999 }]); // NO watch buy -> not a member, not summed
  replaceWalletBalances(w1, 'base', [{ ca: CA_EVM, amount: 10 }]);

  // W1 on CA1: active inside the 24h stat window -> net inflow -500.
  insertTrades(w1, [
    activity('tx-b1', 'buy', 1000, NOW - 3_600_000, CA1),
    activity('tx-s1', 'sell', 1500, NOW - 1_800_000, CA1),
  ], 'watch');
  // W2 on CA1: member (watch buy 2d old, ever-bought) with
  // NO trade inside the 24h stat window -> zero-stat row + balUsd (LEFT JOIN lock).
  insertTrades(w2, [activity('tx-b2', 'buy', 700, NOW - 2 * DAY, CA1)], 'watch');
  // W3 on CA1: nansen buy only -> never a member.
  insertTrades(w3, [activity('tx-b3', 'buy', 100, NOW - 1000, CA1)], 'nansen');
  // W1 on CA2: watch buy 8d old -> still a member (ever-bought), zero 24h stats;
  // sumHoldingAmount has NO time bound -> holding counts.
  insertTrades(w1, [activity('tx-b4', 'buy', 400, NOW - 8 * DAY, CA2)], 'watch');
  // W1 on CA_EVM: mixed-case input canonicalized by insertTrades; inside both windows.
  insertTrades(w1, [activity('tx-b5', 'buy', 100, NOW - 600_000, CA_EVM_UPPER, 'base')], 'watch');
});

test('allTokenStates matches getTokenState for every tracked CA (canonicalCa parity)', () => {
  const all = allTokenStates();
  for (const c of listTrackedCas()) {
    assert.deepStrictEqual(all.get(`${c.chain}:${c.address}`), getTokenState(c.address, c.chain), `token_state ${c.chain}:${c.address}`);
  }
  // getTokenState resolves a mixed-case EVM input via canonicalCa — the map must too.
  assert.ok(all.get(`base:${CA_EVM}`), 'lowercase canonical key present');
  assert.deepStrictEqual(all.get(`base:${CA_EVM}`), getTokenState(CA_EVM_UPPER, 'base'));
});

test('sumHoldingAmountByCa matches sumHoldingAmount for every tracked CA', () => {
  const all = sumHoldingAmountByCa();
  for (const c of listTrackedCas()) {
    assert.equal(all.get(`${c.chain}:${c.address}`) ?? 0, sumHoldingAmount(c.address, c.chain), `holding ${c.chain}:${c.address}`);
  }
  assert.equal(all.get(`sol:${CA1}`) ?? 0, 1500, 'W1 1000 + W2 500; W3 (no watch buy) excluded');
  assert.equal(all.get(`sol:${CA2}`) ?? 0, 2000, 'watch buy with no time bound still counts the holding');
});

test('trackedWalletStatsByCa matches trackedWalletStats for every tracked CA', () => {
  const all = trackedWalletStatsByCa(NOW);
  for (const c of listTrackedCas()) {
    assert.deepStrictEqual(all.get(`${c.chain}:${c.address}`) ?? [], trackedWalletStats(c.address, c.chain, NOW), `stats ${c.chain}:${c.address}`);
  }
});

test('member with no trade in the 24h window keeps its zero-stat row + balUsd (LEFT JOIN lock)', () => {
  const rows = trackedWalletStatsByCa(NOW).get(`sol:${CA1}`) ?? [];
  assert.equal(rows.length, 2);
  // Active member leads (lastTs DESC), full conditional-spread shape.
  assert.deepStrictEqual(rows[0], {
    name: 'A1',
    clan: 'x',
    tags: ['Unicon'],
    inflow: -500,
    buys: 1,
    sells: 1,
    lastTs: NOW - 1_800_000,
    balUsd: 1,
  });
  // Member with NO window trade: zero stats, lastTs 0, balUsd still present.
  assert.deepStrictEqual(rows[1], {
    name: 'B2',
    tags: [],
    inflow: 0,
    buys: 0,
    sells: 0,
    lastTs: 0,
    balUsd: 0.5,
  });
  // CA2: the 8d-old watch buy makes W1 an ever-bought member -> zero-stat row
  // with balUsd (2000 tokens × 0.001), NOT an absent entry.
  assert.deepStrictEqual(trackedWalletStatsByCa(NOW).get(`sol:${CA2}`) ?? [], [
    { name: 'A1', clan: 'x', tags: ['Unicon'], inflow: 0, buys: 0, sells: 0, lastTs: 0, balUsd: 2 },
  ]);
});
