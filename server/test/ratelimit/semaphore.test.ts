import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../../src/ratelimit/semaphore.js';

test('Semaphore: never reports free beyond max and recovers on release', () => {
  const s = new Semaphore(2);
  assert.equal(s.full, false);
  s.acquire();
  s.acquire();
  assert.equal(s.full, true);
  s.release();
  assert.equal(s.full, false);
});
