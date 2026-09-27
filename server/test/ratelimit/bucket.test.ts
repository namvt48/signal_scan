import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bucket } from '../../src/ratelimit/bucket.js';

test('Bucket: a full budget is ready now; the next call waits for its refill', () => {
  const b = new Bucket(5, 5, 1);
  assert.equal(b.readyAt(0, {}), 0);
  for (let i = 0; i < 5; i++) b.onStart(0, {});
  assert.equal(b.readyAt(0, {}), 200, '6th token needs 1/5s');
});

test('Bucket: weight above capacity is clamped (never spins forever)', () => {
  const b = new Bucket(5, 5, 1);
  assert.equal(b.readyAt(0, { weight: 99 }), 0, 'clamped to capacity = already available');
});
