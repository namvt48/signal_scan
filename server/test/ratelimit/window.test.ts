import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from '../../src/ratelimit/window.js';

test('Window: allows up to max, then waits exactly until the oldest exits', () => {
  const w = new Window(3, 60_000);
  for (let i = 0; i < 3; i++) {
    assert.equal(w.readyAt(i * 1000, {}), i * 1000);
    w.onStart(i * 1000, {});
  }
  assert.equal(w.readyAt(3_000, {}), 60_000, 'full -> oldest(0) + windowMs');
});

test('Window: frees a slot once the old timestamp ages out', () => {
  const w = new Window(1, 1_000);
  w.onStart(0, {});
  assert.equal(w.readyAt(500, {}), 1_000);
  assert.equal(w.readyAt(1_000, {}), 1_000, 'at the boundary it is free again');
});
