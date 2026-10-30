import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshDisplayValue, holderCountClass, netInflowUsd, percentageInRange, sumKnownPercentages, sumKnownUsd, totalBalanceUsd, trackedHoldingClass, trackedUsdClass, volume24hClass, volumeClass } from '../../src/lib/signalMetrics.js';
import { sortTrackedWalletsByBalance } from '../../src/lib/walletSort.js';
import type { TrackedWalletStat } from '../../src/types.js';

test('percentage ranges are inclusive, preserve zero, and exclude unknown only when armed', () => {
  assert.equal(percentageInRange(undefined, '', ''), true);
  assert.equal(percentageInRange(undefined, '0', ''), false);
  assert.equal(percentageInRange(0, '0', '0'), true);
  assert.equal(percentageInRange(12.5, '12.5', '20'), true);
  assert.equal(percentageInRange(20, '12.5', '20'), true);
  assert.equal(percentageInRange(20.01, '', '20'), false);
  assert.equal(percentageInRange(12.49, '12.5', ''), false);
  assert.equal(percentageInRange(15, '20', '10'), false);
  assert.equal(percentageInRange(15, 'bad', ''), false);
  assert.equal(percentageInRange(15, '-1', ''), false);
  assert.equal(percentageInRange(15, '', '101'), false);
});

test('dashboard Fresh cell hides below-threshold values but keeps threshold equality and debug values', () => {
  assert.equal(freshDisplayValue(11.99, 12, false), undefined);
  assert.equal(freshDisplayValue(12, 12, false), 12);
  assert.equal(freshDisplayValue(12.01, 12, false), 12.01);
  assert.equal(freshDisplayValue(50, 12, false), 50, 'stale high historical readings may stay visible');
  assert.equal(freshDisplayValue(11.99, 12, true), 11.99, 'all-factors debug remains ungated');
  assert.equal(freshDisplayValue(11.99, null, false), undefined, 'unknown thresholds fail closed in normal mode');
  assert.equal(freshDisplayValue(undefined, 12, true), undefined);
});

test('tracked-wallet Bal sort is per-list, stable for ties, and keeps unknown balances last', () => {
  const wallets: TrackedWalletStat[] = [
    { name: 'high-first', balUsd: 100, inflow: 0, buys: 0, sells: 0, lastTs: 0 },
    { name: 'low-first', balUsd: 5, inflow: 0, buys: 0, sells: 0, lastTs: 0 },
    { name: 'high-second', balUsd: 100, inflow: 0, buys: 0, sells: 0, lastTs: 0 },
    { name: 'low-second', balUsd: 5, inflow: 0, buys: 0, sells: 0, lastTs: 0 },
    { name: 'unknown-first', inflow: 0, buys: 0, sells: 0, lastTs: 0 },
    { name: 'unknown-second', balUsd: Number.NaN, inflow: 0, buys: 0, sells: 0, lastTs: 0 },
  ];
  const names = (direction: 'asc' | 'desc' | null) => sortTrackedWalletsByBalance(wallets, direction).map((wallet) => wallet.name);
  assert.deepEqual(names('desc'), ['high-first', 'high-second', 'low-first', 'low-second', 'unknown-first', 'unknown-second']);
  assert.deepEqual(names('asc'), ['low-first', 'low-second', 'high-first', 'high-second', 'unknown-first', 'unknown-second']);
  assert.deepEqual(names(null), ['high-first', 'low-first', 'high-second', 'low-second', 'unknown-first', 'unknown-second']);
  assert.deepEqual(wallets.map((wallet) => wallet.name), ['high-first', 'low-first', 'high-second', 'low-second', 'unknown-first', 'unknown-second']);
});

test('FOMO holding totals stay unknown until a user has a measured percentage', () => {
  assert.equal(sumKnownPercentages([]), undefined);
  assert.equal(sumKnownPercentages([undefined, undefined]), undefined);
  assert.equal(sumKnownPercentages([undefined, 2.5, 0]), 2.5);
  assert.equal(sumKnownPercentages([0]), 0, 'a measured zero remains distinct from unknown');
  assert.equal(sumKnownPercentages([Number.NaN]), undefined);
});

test('Buy totals are unknown if any member amount is unresolved', () => {
  assert.equal(sumKnownUsd([]), 0);
  assert.equal(sumKnownUsd([0, 5]), 5);
  assert.equal(sumKnownUsd([null]), null);
  assert.equal(sumKnownUsd([60, null]), null);
  assert.equal(sumKnownUsd([Number.NaN]), null);
});

test('Total balance sums all native and FOMO balances, including members beyond the preview', () => {
  const wallets = Array.from({ length: 6 }, (_, i) => ({ balUsd: i + 1 }));
  const users = [{ balUsd: 10.25 }, { balUsd: 0 }];
  assert.equal(totalBalanceUsd(wallets, users), 31.25);
  assert.equal(totalBalanceUsd(wallets, []), 21);
  assert.equal(totalBalanceUsd([], users), 10.25);
  assert.equal(totalBalanceUsd([], []), 0);
  assert.equal(totalBalanceUsd([{ balUsd: 0 }], [{ balUsd: 0 }]), 0);
});

test('Total balance never presents incomplete or invalid member balances as a complete sum', () => {
  assert.equal(totalBalanceUsd([{}], []), undefined);
  assert.equal(totalBalanceUsd([{ balUsd: 100 }], [{}]), undefined);
  assert.equal(totalBalanceUsd([{}, { balUsd: 100 }], []), undefined);
  assert.equal(totalBalanceUsd([], [{ balUsd: Number.NaN }]), undefined);
  assert.equal(totalBalanceUsd([{ balUsd: Infinity }], []), undefined);
  assert.equal(totalBalanceUsd([{ balUsd: Number.MAX_VALUE }, { balUsd: Number.MAX_VALUE }], []), undefined);
});

test('FOMO inflow subtracts sell proceeds, preserving signed flows and measured zero', () => {
  assert.equal(netInflowUsd(400, 250), 150);
  assert.equal(netInflowUsd(500, 900), -400);
  assert.equal(netInflowUsd(0, 90), -90);
  assert.equal(netInflowUsd(0, 0), 0);
});

test('FOMO inflow stays unknown when either flow total is incomplete or non-finite', () => {
  assert.equal(netInflowUsd(null, 250), null);
  assert.equal(netInflowUsd(400, null), null);
  assert.equal(netInflowUsd(null, null), null);
  assert.equal(netInflowUsd(Number.NaN, 0), null);
  assert.equal(netInflowUsd(400, Number.POSITIVE_INFINITY), null);
});

test('buy volume uses raw strictly-greater thresholds and rainbow takes priority over yellow', () => {
  assert.equal(volumeClass(10_000, 'buy').includes('metric-bold'), false);
  assert.ok(volumeClass(10_000.01, 'buy').includes('metric-large'));
  assert.equal(volumeClass(50_000, 'buy').includes('metric-yellow'), false);
  assert.ok(volumeClass(50_000.01, 'buy').includes('metric-yellow'));
  assert.ok(volumeClass(100_000, 'buy').includes('metric-yellow'));
  assert.ok(volumeClass(100_000.01, 'buy').includes('metric-rainbow'));
  assert.equal(volumeClass(100_000.01, 'buy').includes('metric-yellow'), false);
});

test('sell stays red, becomes bold above 5K, and larger only above 10K', () => {
  assert.equal(volumeClass(0, 'sell'), 'metric-sell');
  assert.equal(volumeClass(5_000, 'sell').includes('metric-bold'), false);
  assert.ok(volumeClass(5_000.01, 'sell').includes('metric-bold'));
  assert.equal(volumeClass(10_000, 'sell').includes('metric-large'), false);
  assert.ok(volumeClass(10_000.01, 'sell').includes('metric-large'));
});

test('inflow uses strict 5K, 10K, and 20K tiers and ignores missing or negative values', () => {
  assert.equal(volumeClass(-300_000, 'inflow'), '');
  assert.equal(volumeClass(5_000, 'inflow'), '');
  assert.equal(volumeClass(5_000.01, 'inflow'), 'metric-bold');
  assert.equal(volumeClass(10_000, 'inflow'), 'metric-bold');
  assert.equal(volumeClass(10_000.01, 'inflow'), 'metric-bold metric-large metric-yellow');
  assert.equal(volumeClass(20_000, 'inflow'), 'metric-bold metric-large metric-yellow');
  assert.equal(volumeClass(20_000.01, 'inflow'), 'metric-bold metric-large metric-rainbow');
  assert.equal(volumeClass(undefined, 'inflow'), '');
});

test('BAL and tracked inflow share strict USD emphasis thresholds', () => {
  assert.equal(trackedUsdClass(undefined), '');
  assert.equal(trackedUsdClass(Number.NaN), '');
  assert.equal(trackedUsdClass(-1), '');
  assert.equal(trackedUsdClass(5_000), '');
  assert.equal(trackedUsdClass(5_000.01), 'metric-bold');
  assert.equal(trackedUsdClass(10_000), 'metric-bold');
  assert.equal(trackedUsdClass(10_000.01), 'metric-bold metric-large metric-yellow');
  assert.equal(trackedUsdClass(20_000), 'metric-bold metric-large metric-yellow');
  assert.equal(trackedUsdClass(20_000.01), 'metric-bold metric-large metric-rainbow');
});

test('holder count, low 24h volume and tracked holding use strict cutoffs', () => {
  assert.equal(holderCountClass(1_000), '');
  assert.equal(holderCountClass(1_000.01), 'metric-bold');
  assert.equal(volume24hClass(299_999.99), 'metric-bold text-pos');
  assert.equal(volume24hClass(300_000), '');
  assert.equal(trackedHoldingClass(undefined), '');
  assert.equal(trackedHoldingClass(Number.NaN), '');
  assert.equal(trackedHoldingClass(3), '');
  assert.equal(trackedHoldingClass(3.01), 'metric-bold');
  assert.equal(trackedHoldingClass(4.5), 'metric-bold');
  assert.equal(trackedHoldingClass(4.51), 'metric-bold metric-rainbow');
});
