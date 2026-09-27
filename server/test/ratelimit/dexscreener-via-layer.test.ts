import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiters } from '../../src/ratelimit/index.js';

test('registry: dexscreener window spec is present (was unbounded)', () => {
  assert.ok('dexscreener' in limiters.snapshot());
});
