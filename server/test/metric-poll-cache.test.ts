import { test } from 'node:test';
import Database from 'better-sqlite3';
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
  metricPollNextAllowedAt,
  METRIC_RECOVERY_RETRY_MS,
  open,
  reserveMetricPoll,
  saveMetricPollResponse,
  failMetricPoll,
  deferMetricPoll,
} from '../src/db.js';
import { metricSweep, kickToken } from '../src/poller.js';
import { assembleSignals } from '../src/signals.js';
import type { MarketDataProvider, MetricKind, TokenInfo } from '../src/providers/provider.js';
import type { Chain } from '../src/shared/chain.js';
import { NansenDoorError } from '../src/shared/nansen-door.js';
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

function providerWithCalls(
  calls: MetricKind[] = [],
  options: { failMetric?: boolean; metricError?: Error } = {},
): MarketDataProvider {
  return {
    name: 'metric-cache-test',
    tokenInfo: async (ca, chain) => tokenInfo(ca, chain),
    metric: async (_ca, _chain, kind) => {
      calls.push(kind);
      if (options.metricError) throw options.metricError;
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

test('opening a pre-retry-class database preserves cache rows and probes legacy FW failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-scan-legacy-metric-cache-'));
  const file = join(dir, 'cache.sqlite');
  const now = Date.now();
  const oldAttemptAt = now - 24 * 60 * 60_000;
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE metric_poll_cache (
    ca TEXT NOT NULL, chain TEXT NOT NULL, kind TEXT NOT NULL,
    last_attempt_at INTEGER NOT NULL, response_at INTEGER, next_allowed_at INTEGER NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0, response_json TEXT,
    PRIMARY KEY (ca, chain, kind)
  )`);
  legacy.prepare(`INSERT INTO metric_poll_cache
    (ca, chain, kind, last_attempt_at, response_at, next_allowed_at, failure_count, response_json)
    VALUES (?, 'sol', 'gini', ?, ?, ?, 5, ?)`)
    .run('FW-LEGACY-MIGRATION-CA', oldAttemptAt, oldAttemptAt - 1_000, now + 24 * 60 * 60_000, JSON.stringify({ nansenFreshPct: 8 }));
  legacy.close();

  try {
    open(file);
    const migrated = getMetricPollCache('FW-LEGACY-MIGRATION-CA', 'sol', 'gini');
    assert.equal(migrated?.retry_class, null);
    assert.equal(migrated?.failure_count, 5);
    assert.deepEqual(JSON.parse(migrated?.response_json ?? 'null'), { nansenFreshPct: 8 });
    assert.equal(reserveMetricPoll('FW-LEGACY-MIGRATION-CA', 'sol', 'gini', now, config.pollSetupMs).claimed, true);
    assert.equal(getMetricPollCache('FW-LEGACY-MIGRATION-CA', 'sol', 'gini')?.retry_class, 'legacy_probe');
  } finally {
    try { getDb().close(); } catch { /* database may already be closed */ }
    rmSync(dir, { recursive: true, force: true });
    open(':memory:');
  }
});

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
test('gini reservation honors a shortened cadence for an existing success', () => {
  const now = 10_000;
  const oldCadenceMs = 6 * 60 * 60_000;
  const newCadenceMs = 3 * 60 * 60_000;
  open(':memory:');
  reserveMetricPoll('fresh-ca', 'sol', 'gini', now, oldCadenceMs);
  saveMetricPollResponse('fresh-ca', 'sol', 'gini', now, now + oldCadenceMs, { nansenFreshPct: 12 });

  assert.equal(reserveMetricPoll('fresh-ca', 'sol', 'gini', now + newCadenceMs - 1, newCadenceMs).claimed, false);
  const shortened = reserveMetricPoll('fresh-ca', 'sol', 'gini', now + newCadenceMs, newCadenceMs);
  assert.equal(shortened.claimed, true);
  assert.equal(reserveMetricPoll('fresh-ca', 'sol', 'gini', now + newCadenceMs, newCadenceMs).claimed, false);
});

test('legacy FW backoff is probed once within a bounded recovery window', () => {
  open(':memory:');
  const ca = 'FW-LEGACY-RETRY-CA';
  const now = 100_000_000;
  const intervalMs = 3 * 60 * 60_000;
  const oldAttemptAt = now - 24 * 60 * 60_000;
  reserveMetricPoll(ca, 'sol', 'gini', oldAttemptAt, intervalMs);
  saveMetricPollResponse(ca, 'sol', 'gini', oldAttemptAt, oldAttemptAt + intervalMs, { nansenFreshPct: 12 });
  failMetricPoll(ca, 'sol', 'gini', now + 24 * 60 * 60_000);
  getDb().prepare('UPDATE metric_poll_cache SET retry_class = NULL, last_attempt_at = ?, next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind = ?')
    .run(oldAttemptAt, now + 24 * 60 * 60_000, ca, 'sol', 'gini');
  const legacy = getMetricPollCache(ca, 'sol', 'gini');

  assert.equal(metricPollNextAllowedAt(legacy!, intervalMs), oldAttemptAt + 5 * 60_000);
  assert.equal(reserveMetricPoll(ca, 'sol', 'gini', now, intervalMs).claimed, true);
  assert.equal(getMetricPollCache(ca, 'sol', 'gini')?.retry_class, 'legacy_probe');
  assert.equal(reserveMetricPoll(ca, 'sol', 'gini', now + 5 * 60_000 - 1, intervalMs).claimed, false);
  assert.equal(reserveMetricPoll(ca, 'sol', 'gini', now + 5 * 60_000, intervalMs).claimed, true);
});

test('transient FW retry keeps the last good sample and does not grow exponential failure backoff', () => {
  open(':memory:');
  const ca = 'FW-TRANSIENT-RETRY-CA';
  const now = 200_000_000;
  const intervalMs = 3 * 60 * 60_000;
  reserveMetricPoll(ca, 'sol', 'gini', now, intervalMs);
  saveMetricPollResponse(ca, 'sol', 'gini', now, now + intervalMs, { nansenFreshPct: 12 });
  reserveMetricPoll(ca, 'sol', 'gini', now + intervalMs, intervalMs);
  deferMetricPoll(ca, 'sol', 'gini', now + intervalMs + 5 * 60_000);

  const transient = getMetricPollCache(ca, 'sol', 'gini');
  assert.equal(transient?.failure_count, 0);
  assert.equal(transient?.retry_class, 'transient');
  assert.equal(transient?.response_at, now);
  assert.deepEqual(JSON.parse(transient?.response_json ?? 'null'), { nansenFreshPct: 12 });
  assert.equal(metricPollNextAllowedAt(transient!, intervalMs), now + intervalMs + 5 * 60_000);
  assert.equal(reserveMetricPoll(ca, 'sol', 'gini', now + intervalMs + 5 * 60_000 - 1, intervalMs).claimed, false);
  assert.equal(reserveMetricPoll(ca, 'sol', 'gini', now + intervalMs + 5 * 60_000, intervalMs).claimed, true);
});

test('permanent FW failures retain their configured durable backoff', () => {
  open(':memory:');
  const ca = 'FW-PERMANENT-RETRY-CA';
  const now = 300_000_000;
  const intervalMs = 3 * 60 * 60_000;
  reserveMetricPoll(ca, 'sol', 'gini', now, intervalMs);
  const nextAllowedAt = now + 24 * 60 * 60_000;
  failMetricPoll(ca, 'sol', 'gini', nextAllowedAt, 'permanent');
  const permanent = getMetricPollCache(ca, 'sol', 'gini');

  assert.equal(permanent?.retry_class, 'permanent');
  assert.equal(metricPollNextAllowedAt(permanent!, intervalMs), nextAllowedAt);
  assert.equal(reserveMetricPoll(ca, 'sol', 'gini', now + 5 * 60_000, intervalMs).claimed, false);
});

test('FW sweep retries a classified Door interstitial quickly but keeps real 403 on durable backoff', async () => {
  open(':memory:');
  const intervalMs = config.pollSetupMs;
  const transientCa = 'FW-DOOR-INTERSTITIAL-CA';
  insertTrackedCa({ address: transientCa, chain: 'sol', note: 'test' });
  const calls: MetricKind[] = [];
  await metricSweep(providerWithCalls(calls), 'gini', intervalMs, [{ address: transientCa, chain: 'sol' }]);
  const priorSuccess = getMetricPollCache(transientCa, 'sol', 'gini');
  assert.ok(priorSuccess?.response_at);

  getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind = ?')
    .run(Date.now() - 1, transientCa, 'sol', 'gini');
  const transientStartedAt = Date.now();
  await metricSweep(
    providerWithCalls(calls, { metricError: new NansenDoorError(403, 'interstitial') }),
    'gini',
    intervalMs,
    [{ address: transientCa, chain: 'sol' }],
  );
  const transient = getMetricPollCache(transientCa, 'sol', 'gini');
  assert.equal(transient?.retry_class, 'transient');
  assert.equal(transient?.failure_count, 0);
  assert.equal(transient?.response_at, priorSuccess?.response_at);
  assert.ok(transient?.next_allowed_at && transient.next_allowed_at > transientStartedAt);
  assert.ok((transient?.next_allowed_at ?? 0) <= transientStartedAt + METRIC_RECOVERY_RETRY_MS + 2_000);

  const permanentCa = 'FW-DOOR-REAL-403-CA';
  insertTrackedCa({ address: permanentCa, chain: 'sol', note: 'test' });
  await metricSweep(providerWithCalls(calls), 'gini', intervalMs, [{ address: permanentCa, chain: 'sol' }]);
  getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind = ?')
    .run(Date.now() - 1, permanentCa, 'sol', 'gini');
  const permanentStartedAt = Date.now();
  await metricSweep(
    providerWithCalls(calls, { metricError: new NansenDoorError(403, 'real403') }),
    'gini',
    intervalMs,
    [{ address: permanentCa, chain: 'sol' }],
  );
  const permanent = getMetricPollCache(permanentCa, 'sol', 'gini');
  assert.equal(permanent?.retry_class, 'permanent');
  assert.equal(permanent?.failure_count, 1);
  assert.ok((permanent?.next_allowed_at ?? 0) > permanentStartedAt + METRIC_RECOVERY_RETRY_MS);
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
test('metric sweep skips a cached target that became inactive and retains its prior cache', async () => {
  open(':memory:');
  const ca = 'MC-INACTIVE-SWEEP-CA';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
  const calls: MetricKind[] = [];
  await metricSweep(providerWithCalls(calls), 'essential', 1_000, [{ address: ca, chain: 'sol' }]);
  const prior = getMetricPollCache(ca, 'sol', 'essential');
  assert.ok(prior?.response_at);

  getDb().prepare("UPDATE tracked_cas SET status = 'inactive' WHERE address = ? AND chain = ?").run(ca, 'sol');
  getDb().prepare('UPDATE metric_poll_cache SET next_allowed_at = ? WHERE ca = ? AND chain = ? AND kind = ?')
    .run(Date.now() - 1, ca, 'sol', 'essential');
  const callsBefore = calls.length;
  await metricSweep(providerWithCalls(calls), 'essential', 1_000, [{ address: ca, chain: 'sol' }]);

  assert.equal(calls.length, callsBefore, 'inactive cached targets make no provider request');
  const after = getMetricPollCache(ca, 'sol', 'essential');
  assert.equal(after?.response_at, prior?.response_at, 'inactive target keeps its last successful response');
  assert.equal(after?.response_json, prior?.response_json);
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
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
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
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
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
