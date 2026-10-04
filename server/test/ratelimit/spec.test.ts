import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecs, gmgnLimiterKey, resolveNum } from '../../src/ratelimit/spec.js';

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

test('buildSpecs: multi-key pool gets one limiter per key with its own weight', () => {
  assert.equal(gmgnLimiterKey(0), 'gmgn');
  assert.equal(gmgnLimiterKey(1), 'gmgn:1');
  const s = buildSpecs(5, 2);
  assert.equal(s.gmgn.weightBucket?.capacity, 5);
  assert.equal(s['gmgn:1'].weightBucket?.capacity, 5);
  const w = buildSpecs(5, 2, [7, 20]);
  assert.equal(w.gmgn.weightBucket?.capacity, 7);
  assert.equal(w['gmgn:1'].weightBucket?.capacity, 20);
  assert.equal(w['gmgn:2'], undefined, 'no limiter beyond the key count');
});
