import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getTokenState, insertTrackedCa, open } from '../src/db.js';
import { fillTokenMetrics, updateNansenHolders, updateTokenMetrics, upsertTokenInfo } from '../src/ingest.js';
import { assembleSignals } from '../src/signals.js';
import type { TokenInfo } from '../src/providers/provider.js';

const CA = '0x1111111111111111111111111111111111111111';

function tokenInfo(ca: string, chain: 'sol' | 'base', holders: number): TokenInfo {
  return {
    ca,
    chain,
    price: 1,
    holders,
    volume24h: 0,
    buyVol24h: 0,
    sellVol24h: 0,
    marketCap: 100,
    liquidity: 0,
    supply: 1_000,
    freshCount: 0,
    top10Rate: 0,
  };
}

before(() => open(':memory:'));

test('holder history follows successful writes and surfaces chain-scoped signal data', () => {
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
  insertTrackedCa({ address: CA, chain: 'base', note: '' });
  upsertTokenInfo(tokenInfo(CA, 'sol', 1_000));

  const first = JSON.parse(getTokenState(CA, 'sol')?.holders_history_json ?? '[]') as { t: number; value: number }[];
  const sampledAt = (first[0]?.t ?? 0) + 1_000;
  updateTokenMetrics(CA, 'sol', { holders: 1_200 }, sampledAt);
  updateTokenMetrics(CA, 'sol', { holders: 1_200 }, sampledAt + 1_000);
  updateTokenMetrics(CA, 'sol', { price: 2 }, sampledAt + 2_000);
  updateTokenMetrics(CA, 'base', { holders: 850 }, sampledAt + 3_000);

  const solHistory = JSON.parse(getTokenState(CA, 'sol')?.holders_history_json ?? '[]') as { t: number; value: number }[];
  const baseHistory = JSON.parse(getTokenState(CA, 'base')?.holders_history_json ?? '[]') as { t: number; value: number }[];
  assert.deepEqual(solHistory.map((point) => point.value), [1_000, 1_200, 1_200]);
  assert.deepEqual(baseHistory.map((point) => point.value), [850]);

  const signal = assembleSignals(Date.now(), true).find((row) => row.ca === CA && row.chain === 'sol');
  assert.equal(signal?.holders, 1_200);
  assert.deepEqual(signal?.holdersHistory, solHistory);
});

test('Nansen fallback history records updates only when the primary count is zero', () => {
  const ca = `${CA}-nansen-fallback`;
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  updateTokenMetrics(ca, 'sol', { holders: 0, nansenHolders: 20 }, 1_000);
  updateTokenMetrics(ca, 'sol', { nansenHolders: 25 }, 2_000);
  updateNansenHolders(ca, 'sol', { holders: 30, freshSupplyPct: 12 });

  const history = JSON.parse(getTokenState(ca, 'sol')?.holders_history_json ?? '[]') as { t: number; value: number }[];
  assert.deepEqual(history.map((point) => point.value), [20, 25, 30]);
  const signal = assembleSignals(Date.now(), true).find((row) => row.ca === ca && row.chain === 'sol');
  assert.equal(signal?.holders, 30);
  assert.deepEqual(signal?.holdersHistory, history);
});

test('zero holder count without a Nansen fallback is not a measured chart point', () => {
  const ca = `${CA}-zero`;
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  updateTokenMetrics(ca, 'sol', { holders: 0 }, 1_000);
  assert.equal(getTokenState(ca, 'sol')?.holders_history_json, null);
});

test('fill-only history samples only the value it actually fills', () => {
  const ca = `${CA}-fill-only`;
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  fillTokenMetrics(ca, 'sol', { holders: 10 });
  fillTokenMetrics(ca, 'sol', { holders: 11 });

  const history = JSON.parse(getTokenState(ca, 'sol')?.holders_history_json ?? '[]') as { t: number; value: number }[];
  assert.deepEqual(history.map((point) => point.value), [10]);
});

test('holder history keeps the latest 256 samples and ignores unrelated writes', () => {
  const ca = `${CA}-bounded`;
  insertTrackedCa({ address: ca, chain: 'sol', note: '' });
  updateTokenMetrics(ca, 'sol', { price: 1 }, 1_000);
  assert.equal(getTokenState(ca, 'sol')?.holders_history_json, null);

  for (let value = 0; value < 260; value += 1) {
    updateTokenMetrics(ca, 'sol', { holders: value }, value + 2_000);
  }
  const history = JSON.parse(getTokenState(ca, 'sol')?.holders_history_json ?? '[]') as { t: number; value: number }[];
  assert.equal(history.length, 256);
  assert.equal(history[0]?.value, 4);
  assert.equal(history.at(-1)?.value, 259);
});
