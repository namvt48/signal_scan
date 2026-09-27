import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecs, resolveNum } from '../../src/ratelimit/spec.js';

test('resolveNum: env override wins, invalid falls back to default', () => {
  process.env.RL_TEST_X = '42';
  assert.equal(resolveNum('RL_TEST_X', 7), 42);
  process.env.RL_TEST_X = 'nope';
  assert.equal(resolveNum('RL_TEST_X', 7), 7);
  delete process.env.RL_TEST_X;
  assert.equal(resolveNum('RL_TEST_X', 7), 7);
});

test('buildSpecs: every external API is present with a shape', () => {
  const s = buildSpecs(3);
  for (const api of ['gmgn', 'solana-rpc', 'nansen-credit', 'nansen-door', 'dexscreener']) {
    assert.ok(s[api], `missing spec for ${api}`);
  }
  assert.equal(s.gmgn.weightBucket?.capacity, 3, 'gmgn capacity tracks plan weight');
});
