import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertTrackedCa, insertWallet, listCaScoreGateCandidates, open, pruneUntrackedCas } from '../src/db.js';
import { insertTrades, replaceWalletBalances, upsertTokenInfo } from '../src/ingest.js';
import { assembleSignals, sumHoldingAmount, sumHoldingAmountByCa, trackedWalletStats, trackedWalletStatsByCa } from '../src/signals.js';
import { getThresholds, type NansenThresholds } from '../src/settings.js';
import type { TokenInfo } from '../src/providers/provider.js';

// Chain-scope lock (user 2026-09-28): tracked_cas is UNIQUE(address, chain) and
// wallet_token_state is PK(wallet_id, ca, chain), so the SAME address tracked on two
// chains is two independent identities. Every reader that joins on `ca` ALONE merges
// them — inflating `% holding` on both rows and sparing a CA because of a position on
// the OTHER chain. This file pins the (chain, ca) identity for all five readers.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = 48 * HOUR; // CA_INFLOW_WINDOW_MS default
const STALE = 3 * DAY; // added_at beyond the window
const NOW = Date.parse('2026-09-28T12:00:00Z');

// All three addresses are tracked on base AND bsc (both EVM: same 0x space, so a
// shared address across those two chains is legitimate, not a typo).
const DUP = '0x1111111111111111111111111111111111111111'; // holding readers
const PDUP = '0x2222222222222222222222222222222222222222'; // 48h prune
const GDUP = '0x3333333333333333333333333333333333333333'; // zero-score gate

// Binary-exact numbers on purpose: 256/1024 = 25%, 512/1024 = 50%, price 0.5 keeps
// balance_usd exact too (128 / 256), so an equality assert cannot hide behind floats.
const SUPPLY = 1024;
const BASE_AMOUNT = 256;
const BSC_AMOUNT = 512;

let th: NansenThresholds;
let wBase = '';
let wBsc = '';

function token(ca: string, chain: 'base' | 'bsc'): TokenInfo {
  return {
    ca,
    chain,
    price: 0.5,
    holders: 10,
    volume24h: 5000,
    buyVol24h: 3000,
    sellVol24h: 2000,
    marketCap: 512,
    liquidity: 5e4,
    supply: SUPPLY,
  };
}

/** Complete-but-0/3 token_state on a chosen chain, values derived from live thresholds. */
function insertGateState(ca: string, chain: 'base' | 'bsc'): void {
  getDb()
    .prepare(
      `INSERT INTO token_state (ca, chain, symbol, supply, price, nansen_fresh_pct, t100_multiple, genesis_bal, fetched_at)
       VALUES (?, ?, 'GATE', 1000000000, 0.000001, ?, ?, ?, ?)`,
    )
    .run(ca, chain, th.freshMinPct - 1, th.t100MinMultiple - 0.1, th.lfMin - 1, Date.now());
}

function backdate(address: string, chain: string, agoMs: number): void {
  getDb()
    .prepare('UPDATE tracked_cas SET added_at = ? WHERE address = ? AND chain = ?')
    .run(new Date(Date.now() - agoMs).toISOString(), address, chain);
}

before(() => {
  open(':memory:');
  th = getThresholds();

  insertTrackedCa({ address: DUP, chain: 'base', note: 'chain-scope', entryUsd: 60 });
  insertTrackedCa({ address: DUP, chain: 'bsc', note: 'chain-scope', entryUsd: 60 });
  wBase = insertWallet({ address: 'dup-addr-base', name: 'DUPBASE', tags: [], chain: 'base', source: 'test' }).id;
  wBsc = insertWallet({ address: 'dup-addr-bsc', name: 'DUPBSC', tags: [], chain: 'bsc', source: 'test' }).id;

  // token_state first: replaceWalletBalances prices the row from it.
  upsertTokenInfo(token(DUP, 'base'));
  upsertTokenInfo(token(DUP, 'bsc'));

  // base holds 256 (=25% of supply), bsc holds 512 (=50%). Merged they read 768
  // (=75%) on BOTH rows — the exact symptom this file locks down.
  replaceWalletBalances(wBase, 'base', [{ ca: DUP, amount: BASE_AMOUNT }]);
  replaceWalletBalances(wBsc, 'bsc', [{ ca: DUP, amount: BSC_AMOUNT }]);
  insertTrades(wBase, [{ tx: 't-dup-base', ts: NOW - HOUR, side: 'buy', ca: DUP, chain: 'base', amountUsd: 100, price: 1 }], 'watch');
  insertTrades(wBsc, [{ tx: 't-dup-bsc', ts: NOW - HOUR, side: 'buy', ca: DUP, chain: 'bsc', amountUsd: 300, price: 1 }], 'watch');
});

test('sumHoldingAmountByCa: one bucket per (chain, ca), never merged', () => {
  const all = sumHoldingAmountByCa();
  assert.equal(all.get(`base:${DUP}`), BASE_AMOUNT, 'base bucket must hold only the base position');
  assert.equal(all.get(`bsc:${DUP}`), BSC_AMOUNT, 'bsc bucket must hold only the bsc position');
  assert.equal(sumHoldingAmount(DUP, 'base'), BASE_AMOUNT);
  assert.equal(sumHoldingAmount(DUP, 'bsc'), BSC_AMOUNT);
});

test('assembleSignals: trackedHolding comes from its own chain (25% base / 50% bsc)', () => {
  const byId = new Map(assembleSignals(NOW, true).map((r) => [r.id, r]));
  assert.equal(byId.get(`base:${DUP}`)?.trackedHolding, 25);
  assert.equal(byId.get(`bsc:${DUP}`)?.trackedHolding, 50);
});

test('trackedWalletStatsByCa: balUsd never crosses chains', () => {
  const all = trackedWalletStatsByCa(NOW);
  const baseRows = all.get(`base:${DUP}`) ?? [];
  const bscRows = all.get(`bsc:${DUP}`) ?? [];
  assert.equal(baseRows.length, 1, 'only the base wallet is a member of base:DUP');
  assert.equal(bscRows.length, 1, 'only the bsc wallet is a member of bsc:DUP');
  assert.equal(baseRows[0]!.balUsd, BASE_AMOUNT * 0.5);
  assert.equal(bscRows[0]!.balUsd, BSC_AMOUNT * 0.5);
  // The per-CA reference impl must agree with the batched map for the same (chain, ca).
  assert.deepStrictEqual(baseRows, trackedWalletStats(DUP, 'base', NOW));
  assert.deepStrictEqual(bscRows, trackedWalletStats(DUP, 'bsc', NOW));
});

test('pruneUntrackedCas: a position on ANOTHER chain must not spare a CA', () => {
  // PDUP/base: stale, nothing holds it on base, no base buy -> prunable.
  // PDUP/bsc: stale too, but a watch wallet holds AND bought it on bsc -> kept.
  insertTrackedCa({ address: PDUP, chain: 'base', note: 'chain-scope prune' });
  insertTrackedCa({ address: PDUP, chain: 'bsc', note: 'chain-scope prune' });
  replaceWalletBalances(wBsc, 'bsc', [{ ca: PDUP, amount: 500 }]);
  insertTrades(wBsc, [{ tx: 't-pdup-bsc', ts: NOW - 8 * DAY, side: 'buy', ca: PDUP, chain: 'bsc', amountUsd: 500, price: 1 }], 'watch');
  backdate(PDUP, 'base', STALE);
  backdate(PDUP, 'bsc', STALE);

  // When
  const dropped = pruneUntrackedCas(WINDOW).filter((r) => r.address === PDUP).map((r) => r.chain);

  // Then: only the chain with no position goes.
  assert.deepEqual(dropped, ['base'], 'the bsc position must not keep base:PDUP alive');
});

test('listCaScoreGateCandidates: a position on ANOTHER chain must not spare a 0/3 CA', () => {
  // GDUP is complete-but-0/3 on both chains; only the bsc side has a live position.
  insertTrackedCa({ address: GDUP, chain: 'base', note: 'chain-scope gate' });
  insertTrackedCa({ address: GDUP, chain: 'bsc', note: 'chain-scope gate' });
  insertGateState(GDUP, 'base');
  insertGateState(GDUP, 'bsc');
  replaceWalletBalances(wBsc, 'bsc', [{ ca: GDUP, amount: 700 }]);
  insertTrades(wBsc, [{ tx: 't-gdup-bsc', ts: NOW - 8 * DAY, side: 'buy', ca: GDUP, chain: 'bsc', amountUsd: 700, price: 1 }], 'watch');

  // When
  const candidates = new Set(listCaScoreGateCandidates().map((r) => `${r.chain}:${r.address}`));

  // Then: the base side is in scope, the bsc side is held and excluded.
  assert.equal(candidates.has(`base:${GDUP}`), true, 'base:GDUP has no position -> in gate scope');
  assert.equal(candidates.has(`bsc:${GDUP}`), false, 'bsc:GDUP is held -> out of scope');
});
