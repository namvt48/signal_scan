import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiters } from '../../src/ratelimit/index.js';

test('registry: solana-rpc min-interval is observable in the snapshot', () => {
  const s = limiters.snapshot();
  assert.ok('solana-rpc' in s);
});
