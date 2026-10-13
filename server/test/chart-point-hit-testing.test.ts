import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNearestChartPointIndex } from '../../src/lib/chartPointHitTest.ts';

test('selects the nearest MC marker when a later FW marker overlaps its hit area', () => {
  const points = [
    { x: 82, y: 158, series: 'primary' as const },
    { x: 249.31, y: 158, series: 'secondary' as const },
    { x: 251, y: 158, series: 'primary' as const },
  ];

  assert.equal(findNearestChartPointIndex(points, 249.31, 158, 9), 1);
});

test('selects FW when its point is nearer than an overlapping MC point', () => {
  const points = [
    { x: 249.31, y: 158, series: 'secondary' as const },
    { x: 251, y: 158, series: 'primary' as const },
  ];

  assert.equal(findNearestChartPointIndex(points, 251, 158, 9), 1);
});

test('prefers the visible MC marker when points coincide exactly', () => {
  const points = [
    { x: 251, y: 90, series: 'primary' as const },
    { x: 251, y: 90, series: 'secondary' as const },
  ];

  assert.equal(findNearestChartPointIndex(points, 251, 90, 9), 1);
});

test('returns no hit when the pointer is outside every point radius', () => {
  assert.equal(findNearestChartPointIndex([
    { x: 100, y: 100, series: 'primary' as const },
    { x: 200, y: 200, series: 'secondary' as const },
  ], 150, 150, 9), null);
});
