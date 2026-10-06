import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentageInRange, volumeClass } from '../../src/lib/signalMetrics.js';

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

test('inflow keeps negative values unemphasized and applies strict positive boundaries', () => {
  assert.equal(volumeClass(-300_000, 'inflow'), '');
  assert.equal(volumeClass(10_000, 'inflow'), '');
  assert.ok(volumeClass(10_000.01, 'inflow').includes('metric-bold'));
  assert.equal(volumeClass(200_000, 'inflow').includes('metric-rainbow'), false);
  assert.ok(volumeClass(200_000.01, 'inflow').includes('metric-rainbow'));
  assert.equal(volumeClass(undefined, 'buy'), '');
});
