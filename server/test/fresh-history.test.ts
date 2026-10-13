import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackedCa, getTokenState, insertTrackedCa, open, setTrackedCaNote } from '../src/db.js';
import { updateTokenAnalytics, updateTokenMetrics } from '../src/ingest.js';
import { assembleSignals } from '../src/signals.js';

const CA = 'fresh-history-regression-ca';
before(() => {
  open(':memory:');
});

test('Fresh snapshots include unchanged successful readings and appear in signal DTO', () => {
  updateTokenMetrics(CA, 'sol', { nansenFreshPct: 12 });
  const first = getTokenState(CA, 'sol');
  assert.equal(first?.nansen_fresh_pct, 12);
  const history = JSON.parse(first?.fresh_history_json ?? '[]') as { t: number; value: number }[];
  assert.deepEqual(history.map((p) => p.value), [12]);
  assert.ok(first?.fresh_updated_at);

  updateTokenMetrics(CA, 'sol', {});
  assert.deepEqual(JSON.parse(getTokenState(CA, 'sol')?.fresh_history_json ?? '[]'), history);
  updateTokenMetrics(CA, 'sol', { nansenFreshPct: 12 });
  assert.deepEqual(JSON.parse(getTokenState(CA, 'sol')?.fresh_history_json ?? '[]').map((p: { value: number }) => p.value), [12, 12]);
  updateTokenMetrics(CA, 'sol', { nansenFreshPct: 15 });
  const changed = JSON.parse(getTokenState(CA, 'sol')?.fresh_history_json ?? '[]') as { t: number; value: number }[];
  assert.deepEqual(changed.map((p) => p.value), [12, 12, 15]);
});

test('T100 analytics history carries peak/trough balances into signals', () => {
  const ca = `${CA}-t100`;
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  updateTokenMetrics(ca, 'sol', { supply: 1_000, price: 1, symbol: 'T100' });
  updateTokenAnalytics(ca, 'sol', { t100Pct: 40, t100Multiple: 1.67, t100BalanceDrawdown: { peak: 167, trough: 100 } }, 1_000);
  updateTokenAnalytics(ca, 'sol', { t100Pct: 25, t100Multiple: 1.33, t100BalanceDrawdown: { peak: 133, trough: 100 } }, 2_000);

  const state = getTokenState(ca, 'sol');
  const history = JSON.parse(state?.t100_history_json ?? '[]') as { t: number; value: number; peakBalance?: number; troughBalance?: number }[];
  assert.deepEqual(history, [
    { t: 1_000, value: 1.67, peakBalance: 167, troughBalance: 100 },
    { t: 2_000, value: 1.33, peakBalance: 133, troughBalance: 100 },
  ]);
  const signal = assembleSignals(Date.now(), true).find((row) => row.ca === ca && row.chain === 'sol');
  assert.deepEqual(signal?.nansen.t100History, history);
  assert.equal(signal?.nansen.t100?.multiple, 1.33);
});

test('T100 history stays empty without a successful series timestamp', () => {
  const ca = `${CA}-t100-no-sample`;
  updateTokenMetrics(ca, 'sol', { supply: 1_000, price: 1, symbol: 'EMPTY' });
  updateTokenAnalytics(ca, 'sol', { t100Pct: 40, t100Multiple: 1.67 });
  assert.equal(getTokenState(ca, 'sol')?.t100_history_json, null);
});

test('metric patches without Fresh never fabricate Fresh history', () => {
  updateTokenMetrics(`${CA}-absent`, 'sol', { price: 2 });
  const state = getTokenState(`${CA}-absent`, 'sol');
  assert.equal(state?.fresh_history_json, null);
  assert.equal(state?.fresh_updated_at, null);
});

test('invalid Fresh readings fail atomically without changing the last valid metric', () => {
  const ca = `${CA}-invalid`;
  updateTokenMetrics(ca, 'sol', { nansenFreshPct: 20, price: 1 });
  const before = getTokenState(ca, 'sol');
  for (const value of [NaN, Infinity, -1, 101]) {
    assert.throws(() => updateTokenMetrics(ca, 'sol', { nansenFreshPct: value, price: 999 }), /finite percentage/);
  }
  const after = getTokenState(ca, 'sol');
  assert.equal(after?.price, 1);
  assert.equal(after?.nansen_fresh_pct, 20);
  assert.equal(after?.fresh_history_json, before?.fresh_history_json);
  assert.equal(after?.fresh_updated_at, before?.fresh_updated_at);
});

test('tracked notes are scoped by chain and signals expose stored note and DEX volumes', () => {
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
  insertTrackedCa({ address: CA, chain: 'base', note: '' });
  setTrackedCaNote(CA, 'sol', 'Solana note');
  setTrackedCaNote(CA, 'base', 'Base note');
  updateTokenMetrics(CA, 'sol', { buyVol24h: 7, sellVol24h: 3 });
  assert.equal(findTrackedCa(CA, 'sol')?.user_note, 'Solana note');
  assert.equal(findTrackedCa(CA, 'base')?.user_note, 'Base note');
  const signal = assembleSignals().find((row) => row.ca === CA && row.chain === 'sol');
  assert.equal(signal?.note, 'Solana note');
  assert.equal(signal?.buyVol24h, 7);
  assert.equal(signal?.sellVol24h, 3);
  assert.deepEqual(signal?.nansen.freshHistory?.map((point) => point.value), [12, 12, 15]);
});
