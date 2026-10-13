import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAlertMetricObservations,
  getDb,
  getTokenState,
  getMetricPollCache,
  insertTrackedCa,
  open,
  reserveMetricPoll,
  saveMetricPollResponse,
} from '../src/db.js';
import { metricSweep, kickToken } from '../src/poller.js';
import { assembleSignals } from '../src/signals.js';
import type { MarketDataProvider, MetricKind, TokenInfo } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';
import { config } from '../src/config.js';

const MC_INTERVAL_MS = 30 * 60_000;

function tokenInfo(ca: string, chain: Chain = 'sol'): TokenInfo {
  return {
    ca,
    chain,
    price: 2,
    holders: 25,
    volume24h: 600,
    buyVol24h: 350,
    sellVol24h: 250,
    volume1h: 40,
    marketCap: 2_000,
    liquidity: 100,
    supply: 1_000,
    symbol: 'TEST',
    nansenStats: { holders: 20, freshSupplyPct: 12.5, t100SupplyPct: 30, medianBalanceUsd: 40 },
  };
}

function providerWithCalls(calls: MetricKind[] = [], options: { failMetric?: boolean } = {}): MarketDataProvider {
  return {
    name: 'metric-cache-test',
    tokenInfo: async (ca, chain) => tokenInfo(ca, chain),
    metric: async (_ca, _chain, kind) => {
      calls.push(kind);
      if (options.failMetric) throw Object.assign(new Error('upstream HTTP 429'), { status: 429 });
      if (kind === 'essential') return {
        price: 2, supply: 1_000, marketCap: 2_000, holders: 25, symbol: 'TEST',
        volume24h: 600, buyVol24h: 350, sellVol24h: 250, volume1h: 40,
      };
      if (kind === 'volume') return { volume24h: 600, buyVol24h: 350, sellVol24h: 250, volume1h: 40 };
      return { nansenHolders: 20, nansenFreshPct: 12.5 };
    },
    walletTokenHoldings: async () => [],
  };
}

test('metric poll reservation persists response and cadence across database reopen, isolated by chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-scan-metric-cache-'));
  const file = join(dir, 'cache.sqlite');
  const sampleAt = 10_000;
  try {
    open(file);
    assert.equal(reserveMetricPoll('same-ca', 'sol', 'essential', sampleAt, MC_INTERVAL_MS).claimed, true);
    saveMetricPollResponse('same-ca', 'sol', 'essential', sampleAt, sampleAt + MC_INTERVAL_MS, { marketCap: 1_234 });
    assert.equal(reserveMetricPoll('same-ca', 'base', 'essential', sampleAt, MC_INTERVAL_MS).claimed, true);
    getDb().close();

    open(file);
    const row = getMetricPollCache('same-ca', 'sol', 'essential');
    assert.equal(row?.response_at, sampleAt);
    assert.deepEqual(JSON.parse(row?.response_json ?? 'null'), { marketCap: 1_234 });
    assert.equal(reserveMetricPoll('same-ca', 'sol', 'essential', sampleAt + MC_INTERVAL_MS - 1, MC_INTERVAL_MS).claimed, false);
    assert.equal(reserveMetricPoll('same-ca', 'sol', 'essential', sampleAt + MC_INTERVAL_MS, MC_INTERVAL_MS).claimed, true);
    assert.equal(getMetricPollCache('same-ca', 'base', 'essential')?.response_at, null);
  } finally {
    try { getDb().close(); } catch { /* database may already be closed */ }
    rmSync(dir, { recursive: true, force: true });
    open(':memory:');
  }
});

test('MC metric sweep enforces the 30-minute floor and retains the last success on failure', async () => {
  open(':memory:');
  const ca = 'MC-CADENCE-CA';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
  const calls: MetricKind[] = [];
  await metricSweep(providerWithCalls(calls), 'essential', 1_000, [{ address: ca, chain: 'sol' }]);
  assert.deepEqual(calls, ['essential']);

  const successful = getMetricPollCache(ca, 'sol', 'essential');
  assert.ok(successful?.response_at);
  assert.ok((successful?.next_allowed_at ?? 0) >= (successful?.response_at ?? 0) + MC_INTERVAL_MS);

  if (config.mode === 'gmgn') {
    const sharedVolume = getMetricPollCache(ca, 'sol', 'volume');
    assert.equal(sharedVolume?.response_at, successful?.response_at);
    getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind = ?')
      .run(Date.now() - 1, ca, 'sol', 'volume');
    await metricSweep(providerWithCalls(calls), 'volume', 1_000, [{ address: ca, chain: 'sol' }]);
    assert.equal(calls.length, 1, 'the shared GMGN endpoint was queried again before its 30-minute gate');
  }

  getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind IN (?, ?)')
    .run(Date.now() + MC_INTERVAL_MS - 1, ca, 'sol', 'essential', 'gmgnMarket');
  await metricSweep(providerWithCalls(calls), 'essential', 1_000, [{ address: ca, chain: 'sol' }]);
  assert.equal(calls.length, 1, 'a metric query ran before the 30-minute boundary');

  getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind IN (?, ?)')
    .run(Date.now() - 1, ca, 'sol', 'essential', 'gmgnMarket');
  await metricSweep(providerWithCalls(calls, { failMetric: true }), 'essential', 1_000, [{ address: ca, chain: 'sol' }]);
  assert.equal(calls.length, 2);
  const afterFailure = getMetricPollCache(ca, 'sol', 'essential');
  assert.equal(afterFailure?.response_at, successful?.response_at);
  assert.equal(afterFailure?.response_json, successful?.response_json);
  assert.ok((afterFailure?.next_allowed_at ?? 0) > Date.now());
  const state = getDb().prepare('SELECT market_cap FROM token_state WHERE ca = ? AND chain = ?').get(ca, 'sol') as { market_cap: number } | undefined;
  assert.equal(state?.market_cap, 2_000);
});

test('first add seeds metric caches and a fresh repeated add makes no provider calls', async () => {
  open(':memory:');
  const ca = 'MC-FIRST-ADD-CA';
  const calls: MetricKind[] = [];
  let tokenInfoCalls = 0;
  const provider = providerWithCalls(calls);
  const firstAdd: MarketDataProvider = {
    ...provider,
    tokenInfo: async (address, chain) => {
      tokenInfoCalls += 1;
      return tokenInfo(address, chain);
    },
  };
  await kickToken(firstAdd, ca, 'sol');
  await kickToken(firstAdd, ca, 'sol');
  assert.equal(tokenInfoCalls, 1);
  assert.deepEqual(calls, []);
  assert.ok(getMetricPollCache(ca, 'sol', 'essential')?.response_at);
  assert.ok(getMetricPollCache(ca, 'sol', 'volume')?.response_at);
  assert.ok(getMetricPollCache(ca, 'sol', 'gini')?.response_at);
  assert.equal(getAlertMetricObservations(0, 10).length, 1, 'first successful Fresh response is captured once');
});

test('re-add rehydrates cached metric values at source timestamps without fresh samples', async () => {
  open(':memory:');
  const ca = 'MC-REHYDRATE-CA';
  const calls: MetricKind[] = [];
  let tokenInfoCalls = 0;
  const provider: MarketDataProvider = {
    ...providerWithCalls(calls),
    tokenInfo: async (address, chain) => {
      tokenInfoCalls += 1;
      return tokenInfo(address, chain);
    },
  };
  await kickToken(provider, ca, 'sol');
  const essentialAt = getMetricPollCache(ca, 'sol', 'essential')?.response_at;
  const volumeAt = getMetricPollCache(ca, 'sol', 'volume')?.response_at;
  const giniAt = getMetricPollCache(ca, 'sol', 'gini')?.response_at;
  assert.ok(essentialAt && volumeAt && giniAt);
  getDb().prepare('DELETE FROM token_state WHERE ca = ? AND chain = ?').run(ca, 'sol');

  await kickToken(provider, ca, 'sol');

  assert.equal(tokenInfoCalls, 1);
  assert.deepEqual(calls, []);
  const state = getTokenState(ca, 'sol');
  assert.equal(state?.vol_24h_prev_at, volumeAt);
  assert.deepEqual(JSON.parse(state?.market_cap_history_json ?? '[]'), [{ t: essentialAt, value: 2_000 }]);
  assert.deepEqual(JSON.parse(state?.fresh_history_json ?? '[]'), [{ t: giniAt, value: 12.5 }]);
});

test('signals expose the response timestamp of each cached dataset', () => {
  open(':memory:');
  const ca = 'MC-TIMESTAMP-DTO-CA';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
  const at = 1_700_000_000_000;
  for (const [kind, patch] of [
    ['essential', { marketCap: 2_000, holders: 25 }],
    ['volume', { volume24h: 600 }],
    ['gini', { nansenHolders: 20, nansenFreshPct: 12.5 }],
  ] as const) {
    assert.equal(reserveMetricPoll(ca, 'sol', kind, at, MC_INTERVAL_MS).claimed, true);
    saveMetricPollResponse(ca, 'sol', kind, at, at + MC_INTERVAL_MS, patch);
  }

  const signal = assembleSignals().find((row) => row.ca === ca);
  assert.deepEqual(signal?.dataUpdatedAt, {
    marketCap: at,
    holders: at,
    volume24h: at,
    fresh: at,
  });
});
