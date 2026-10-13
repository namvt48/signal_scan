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
  for (const api of ['gmgn', 'solana-rpc', 'evm-rpc', 'evm-rpc-fallback', 'nansen-credit', 'nansen-door', 'dexscreener']) {
    assert.ok(s[api], `missing spec for ${api}`);
  }
  assert.equal(s.gmgn.weightBucket?.capacity, 3, 'gmgn capacity tracks plan weight');
});

test('buildSpecs: EVM RPC endpoints have independent bounded gates and retries', () => {
  const primary = buildSpecs(3)['evm-rpc'];
  const fallback = buildSpecs(3)['evm-rpc-fallback'];
  for (const spec of [primary, fallback]) {
    assert.equal(spec?.window?.max, 300);
    assert.equal(spec?.maxConcurrency, 4);
    assert.deepEqual(spec?.gate?.statuses, [429]);
    assert.deepEqual(spec?.gate?.statusesWithCooldown, [{ status: 403, cooldownMs: 60_000 }]);
    assert.equal(spec?.retry?.retries, 1);
    assert.equal(spec?.retry?.retryOn(429), true);
    assert.equal(spec?.retry?.retryOn(500), true);
    assert.equal(spec?.retry?.retryOn(400), false);
  }
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
test('buildSpecs: GMGN egress limiter caps aggregate traffic to one request per second', () => {
  const s = buildSpecs(5, 2);
  assert.deepEqual(s['gmgn-egress']?.weightBucket, {
    capacity: 1,
    refillPerSec: 1,
    defaultWeight: 1,
  });
  assert.equal(s['gmgn-egress']?.maxConcurrency, 1);
  assert.equal(s['gmgn-egress']?.gate?.header, 'x-ratelimit-reset');
  assert.deepEqual(s['gmgn-egress']?.gate?.statusesWithCooldown, [{ status: 403, cooldownMs: 600_000 }]);
  assert.equal(s['gmgn-egress']?.gate?.fallbackCooldownMs, 60_000);
  assert.equal(s.gmgn.retry?.retries, 1, 'per-key limiter owns one bounded retry');
  assert.equal(s.gmgn.retry?.path, '/v1/token/info', 'only token-info retries automatically');
  assert.equal(s.gmgn.retry?.retryOn(429), true);
  assert.equal(s.gmgn.retry?.retryOn(500), true);
  assert.equal(s.gmgn.retry?.retryOn(401), false);
  assert.equal(s.gmgn.retry?.retryOn(400), false);
  assert.equal(s['gmgn-egress']?.retry, undefined, 'egress only enforces shared quota/gating');
  assert.equal(s.gmgn.deferGate, undefined);
  assert.equal(s['gmgn-egress']?.deferGate, true);
  assert.equal(s.gmgn.queueMax, 256);
  assert.equal(s.gmgn['queueMaxAgeMs'], 300_000);
  assert.equal(s['gmgn-egress']?.weightBucket?.capacity, 1, 'shared egress quota is unchanged');
});

test('buildSpecs clamps environment retry counts to bounded attempts', () => {
  const oldSolana = process.env.RL_SOLANA_RPC_RETRIES;
  const oldNansen = process.env.RL_NANSEN_CREDIT_RETRIES;
  process.env.RL_SOLANA_RPC_RETRIES = '999';
  process.env.RL_NANSEN_CREDIT_RETRIES = '999';
  try {
    const specs = buildSpecs(5);
    assert.equal(specs['solana-rpc']?.retry?.retries, 5);
    assert.equal(specs['nansen-credit']?.retry?.retries, 10);
  } finally {
    if (oldSolana === undefined) delete process.env.RL_SOLANA_RPC_RETRIES;
    else process.env.RL_SOLANA_RPC_RETRIES = oldSolana;
    if (oldNansen === undefined) delete process.env.RL_NANSEN_CREDIT_RETRIES;
    else process.env.RL_NANSEN_CREDIT_RETRIES = oldNansen;
  }
});
