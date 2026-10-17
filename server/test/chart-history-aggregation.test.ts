import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateHistoryPoints, MAX_CHART_POINTS, MAX_MARKET_CAP_OVERLAY_POINTS } from '../../src/lib/chartHistory.ts';


test('empty and single-point histories remain valid', () => {
  assert.deepEqual(aggregateHistoryPoints([]), []);
  assert.deepEqual(aggregateHistoryPoints([{ t: 5, value: 12 }]), [
    { t: 5, value: 12, sampleCount: 1 },
  ]);
});
test('history under the cap is sorted, unchanged in value, and leaves input untouched', () => {
  const history = [{ t: 2, value: 20 }, { t: 0, value: 0 }, { t: 1, value: 10 }];
  const original = structuredClone(history);

  assert.deepEqual(aggregateHistoryPoints(history), [
    { t: 0, value: 0, sampleCount: 1 },
    { t: 1, value: 10, sampleCount: 1 },
    { t: 2, value: 20, sampleCount: 1 },
  ]);
  assert.deepEqual(history, original);
});

test('chart preparation preserves T100 balance drawdown details', () => {
  const history = [
    { t: 1, value: 1.67, peakBalance: 167, troughBalance: 100 },
    { t: 2, value: 1.33, peakBalance: 133, troughBalance: 100 },
  ];

  assert.deepEqual(
    aggregateHistoryPoints(history, 256).map(({ peakBalance, troughBalance }) => [peakBalance, troughBalance]),
    [[167, 100], [133, 100]],
  );
});

test('history at the cap keeps every observation', () => {
  const history = Array.from({ length: MAX_CHART_POINTS }, (_, t) => ({ t, value: t * 2 }));
  const result = aggregateHistoryPoints(history);

  assert.equal(result.length, MAX_CHART_POINTS);
  assert.deepEqual(result.map(({ t, value }) => ({ t, value })), history);
  assert.ok(result.every((point) => point.sampleCount === 1));
});


test('dense history averages time buckets, stays capped, and preserves endpoints', () => {
  const history = Array.from({ length: 100 }, (_, t) => ({ t, value: t * 10 }));
  const result = aggregateHistoryPoints(history);

  assert.equal(result.length, MAX_CHART_POINTS);
  assert.deepEqual(result[0], { t: 0, value: 0, sampleCount: 1 });
  assert.deepEqual(result[1], { t: 2, value: 20, sampleCount: 3 });
  assert.deepEqual(result.at(-1), { t: 99, value: 990, sampleCount: 1 });
  assert.equal(result.reduce((total, point) => total + point.sampleCount, 0), history.length);
  assert.deepEqual(history, Array.from({ length: 100 }, (_, t) => ({ t, value: t * 10 })));
});

test('custom limit keeps endpoints and counts every averaged overlay sample', () => {
  const history = Array.from({ length: 100 }, (_, t) => ({ t, value: t * 10 }));
  const result = aggregateHistoryPoints(history, MAX_MARKET_CAP_OVERLAY_POINTS);

  assert.equal(result.length, MAX_MARKET_CAP_OVERLAY_POINTS);
  assert.deepEqual(result[0], { t: 0, value: 0, sampleCount: 1 });
  assert.deepEqual(result.at(-1), { t: 99, value: 990, sampleCount: 1 });
  assert.equal(result.reduce((total, point) => total + point.sampleCount, 0), history.length);
  assert.deepEqual(history, Array.from({ length: 100 }, (_, t) => ({ t, value: t * 10 })));
});

test('custom limit preserves endpoints and all samples, and rejects limits below three', () => {
  const history = Array.from({ length: 5 }, (_, t) => ({ t, value: t * 10 }));
  const result = aggregateHistoryPoints(history, 3);

  assert.deepEqual(result, [
    { t: 0, value: 0, sampleCount: 1 },
    { t: 2, value: 20, sampleCount: 3 },
    { t: 4, value: 40, sampleCount: 1 },
  ]);
  assert.throws(() => aggregateHistoryPoints(history, 2), RangeError);
});

test('duplicate timestamps aggregate without invalid coordinates or losing sample counts', () => {
  const history = Array.from({ length: 100 }, (_, value) => ({ t: 500, value }));
  const result = aggregateHistoryPoints(history);

  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { t: 500, value: 0, sampleCount: 1 });
  assert.deepEqual(result[1], { t: 500, value: 49.5, sampleCount: 98 });
  assert.deepEqual(result[2], { t: 500, value: 99, sampleCount: 1 });
  assert.ok(result.every((point) => Number.isFinite(point.t) && Number.isFinite(point.value)));
});

test('non-finite timestamps and values are excluded before aggregation', () => {
  assert.deepEqual(aggregateHistoryPoints([
    { t: 2, value: 20 },
    { t: Number.NaN, value: 15 },
    { t: 3, value: Number.POSITIVE_INFINITY },
    { t: 1, value: 10 },
  ]), [
    { t: 1, value: 10, sampleCount: 1 },
    { t: 2, value: 20, sampleCount: 1 },
  ]);
});
