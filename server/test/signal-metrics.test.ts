import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holderCountClass, percentageInRange, sumKnownPercentages, sumKnownUsd, trackedHoldingClass, trackedUsdClass, volume24hClass, volumeClass } from '../../src/lib/signalMetrics.js';

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
