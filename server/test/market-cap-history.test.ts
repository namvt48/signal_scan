import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getDb, getTokenState, insertTrackedCa, open } from '../src/db.js';
import { recomputeMarketCap, updateTokenMetrics, upsertTokenInfo } from '../src/ingest.js';
import { metricSweep } from '../src/poller.js';
import { assembleSignals } from '../src/signals.js';
import type { MarketDataProvider } from '../src/providers/provider.js';

const CA = 'F8aonWAvmijvWekzrE7LSdTEzwh8ahAkCv6kCMBGdZks';
const BOUNDED_CA = `${CA}-bounded`;
const EMPTY_CA = `${CA}-empty`;
const FIRST_ADD_CA = `${CA}-first-add`;
const NON_GMGN_CA = `${CA}-nansen`;

before(() => {
  open(':memory:');
  for (const address of [CA, BOUNDED_CA, EMPTY_CA, FIRST_ADD_CA, NON_GMGN_CA]) {
    insertTrackedCa({ address, chain: 'sol', note: '' });
  }
});

function clearMetricCache(ca: string): void {
  getDb().prepare('DELETE FROM metric_poll_cache WHERE ca = ? AND chain = ?').run(ca, 'sol');
}

test('market cap samples follow actual writes and surface through signal DTO', () => {
  updateTokenMetrics(CA, 'sol', { marketCap: 100 });
  updateTokenMetrics(CA, 'sol', { marketCap: 200 });
  updateTokenMetrics(CA, 'sol', { price: 3, supply: 100 });
  recomputeMarketCap(CA, 'sol');

  const state = getTokenState(CA, 'sol');
  const history = JSON.parse(state?.market_cap_history_json ?? '[]') as { t: number; value: number }[];
  assert.deepEqual(history.map((point) => point.value), [100, 200, 300]);
  assert.ok(history.every((point) => Number.isFinite(point.t) && point.t > 0));

  const signal = assembleSignals().find((row) => row.ca === CA && row.chain === 'sol');
  assert.equal(signal?.marketCap, 300);
  assert.deepEqual(signal?.marketCapHistory, history);
});

test('essential data without a fresh price clears current MC but keeps history', async () => {
  const stalePrice = 0.00011274277;
  const supply = 999_793_028.101399;
  updateTokenMetrics(CA, 'sol', { price: stalePrice, supply });
  recomputeMarketCap(CA, 'sol');
  const priorHistory = JSON.parse(getTokenState(CA, 'sol')?.market_cap_history_json ?? '[]') as { t: number; value: number }[];

  clearMetricCache(CA);
  const fallbackProvider: MarketDataProvider = {
    name: 'gmgn+nansen',
    tokenInfo: async () => { throw new Error('unused'); },
    metric: async (_ca, _chain, kind) => kind === 'essential' ? { supply, symbol: 'BANK' } : {},
    walletTokenHoldings: async () => [],
  };
  const previousMode = config.mode;
  config.mode = 'gmgn';
  try {
    await metricSweep(fallbackProvider, 'essential', 60_000, [{ address: CA, chain: 'sol' }]);
  } finally {
    config.mode = previousMode;
  }

  const unknown = getTokenState(CA, 'sol');
  assert.equal(unknown?.price, null);
  assert.equal(unknown?.market_cap, null);
  assert.equal(unknown?.supply, supply);
  assert.deepEqual(JSON.parse(unknown?.market_cap_history_json ?? '[]'), priorHistory);
  assert.equal(assembleSignals().find((row) => row.ca === CA)?.marketCap, undefined);
});
test('a failed GMGN essential request preserves current MC and history', async () => {
  const price = 0.00011274277;
  const supply = 999_793_028.101399;
  updateTokenMetrics(CA, 'sol', { price, supply });
  recomputeMarketCap(CA, 'sol');
  const priorHistory = JSON.parse(getTokenState(CA, 'sol')?.market_cap_history_json ?? '[]') as { t: number; value: number }[];
  clearMetricCache(CA);

  const unavailableProvider: MarketDataProvider = {
    name: 'gmgn+nansen',
    tokenInfo: async () => { throw new Error('unused'); },
    metric: async () => { throw new Error('GMGN and Nansen unavailable'); },
    walletTokenHoldings: async () => [],
  };
  const previousMode = config.mode;
  config.mode = 'gmgn';
  try {
    await metricSweep(unavailableProvider, 'essential', 60_000, [{ address: CA, chain: 'sol' }]);
  } finally {
    config.mode = previousMode;
  }

  const unchanged = getTokenState(CA, 'sol');
  assert.equal(unchanged?.price, price);
  assert.equal(unchanged?.market_cap, price * supply);
  assert.deepEqual(JSON.parse(unchanged?.market_cap_history_json ?? '[]'), priorHistory);
  assert.equal(assembleSignals().find((row) => row.ca === CA)?.marketCap, price * supply);
});

test('Nansen mode keeps its existing quote when essential has no new price', async () => {
  const price = 0.00011274277;
  const supply = 999_793_028.101399;
  updateTokenMetrics(NON_GMGN_CA, 'sol', { price, supply });
  recomputeMarketCap(NON_GMGN_CA, 'sol');

  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => { throw new Error('unused'); },
    metric: async (_ca, _chain, kind) => kind === 'essential' ? { supply } : {},
    walletTokenHoldings: async () => [],
  };
  const previousMode = config.mode;
  config.mode = 'nansen';
  try {
    await metricSweep(provider, 'essential', 60_000, [{ address: NON_GMGN_CA, chain: 'sol' }]);
  } finally {
    config.mode = previousMode;
  }

  assert.equal(getTokenState(NON_GMGN_CA, 'sol')?.price, price);
  assert.equal(getTokenState(NON_GMGN_CA, 'sol')?.market_cap, price * supply);
});
test('a later GMGN price restores current MC from its price and supply', async () => {
  const price = 0.00001695904;
  const supply = 999_793_028.101399;
  const provider: MarketDataProvider = {
    name: 'gmgn+nansen',
    tokenInfo: async () => { throw new Error('unused'); },
    metric: async (_ca, _chain, kind) => kind === 'essential' ? { price, supply } : {},
    walletTokenHoldings: async () => [],
  };
  clearMetricCache(CA);
  await metricSweep(provider, 'essential', 60_000, [{ address: CA, chain: 'sol' }]);
  const expected = price * supply;
  assert.equal(getTokenState(CA, 'sol')?.market_cap, expected);
  assert.equal(assembleSignals().find((row) => row.ca === CA)?.marketCap, expected);
});

test('first-add without a trusted quote stores MC as unknown, not zero', () => {
  upsertTokenInfo({
    ca: FIRST_ADD_CA,
    chain: 'sol',
    holders: 0,
    volume24h: 0,
    buyVol24h: 0,
    sellVol24h: 0,
    liquidity: 0,
    supply: 999_793_028.101399,
  });
  const state = getTokenState(FIRST_ADD_CA, 'sol');
  assert.equal(state?.price, null);
  assert.equal(state?.market_cap, null);
  assert.equal(assembleSignals().find((row) => row.ca === FIRST_ADD_CA)?.marketCap, undefined);
});

test('market cap history is bounded and unknown values do not create samples', () => {
  updateTokenMetrics(BOUNDED_CA, 'sol', { marketCap: 0 });
  for (let value = 1; value <= 110; value += 1) {
    updateTokenMetrics(BOUNDED_CA, 'sol', { marketCap: value });
  }
  const history = JSON.parse(getTokenState(BOUNDED_CA, 'sol')?.market_cap_history_json ?? '[]') as { t: number; value: number }[];
  assert.equal(history.length, 96);
  assert.equal(history[0]?.value, 15);
  assert.equal(history.at(-1)?.value, 110);

  updateTokenMetrics(EMPTY_CA, 'sol', { price: 1 });
  assert.equal(getTokenState(EMPTY_CA, 'sol')?.market_cap_history_json, null);
});
