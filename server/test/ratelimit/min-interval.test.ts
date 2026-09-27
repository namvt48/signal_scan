import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinInterval } from '../../src/ratelimit/min-interval.js';

test('MinInterval: first is free, each next waits the interval after the previous start', () => {
  const m = new MinInterval(600);
  assert.equal(m.readyAt(0, {}), 0);
  m.onStart(0, {});
  assert.equal(m.readyAt(0, {}), 600);
  m.onStart(1_000, {});
  assert.equal(m.readyAt(1_000, {}), 1_600);
});
