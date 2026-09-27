import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker } from '../src/crawl.js';

test('circuit breaker: stays closed below the limit, opens at it, and does not close early on success', () => {
  const b = createCircuitBreaker(3, 60_000);
  assert.equal(b.open(), false);

  b.fail();
  b.fail();
  assert.equal(b.open(), false, 'below the limit the door stays open for traffic');

  b.fail();
  assert.equal(b.open(), true, 'reaching the limit fast-fails for the cooldown');

  b.ok();
  assert.equal(b.open(), true, 'one success mid-cooldown must not reopen the door');
});

test('circuit breaker: the failure count restarts after it opens', () => {
  const b = createCircuitBreaker(2, 60_000);
  b.fail();
  b.fail();
  assert.equal(b.open(), true);
  // One more failure alone must not re-arm the cooldown (the counter was reset).
  b.fail();
  b.ok();
  assert.equal(b.open(), true);
});
