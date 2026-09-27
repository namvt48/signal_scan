import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiters } from '../../src/ratelimit/index.js';

test('registry: nansen-door window spec is present', () => {
  assert.ok('nansen-door' in limiters.snapshot());
});
