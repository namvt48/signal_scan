// GMGN multi-key pool (gateway/gmgn-keys): gate-aware round-robin selection + the
// per-key 401 down-latch. Pure unit test — fake clock, fake gate source, no HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmgnKeyPool, type GmgnKey } from '../../src/gateway/gmgn-keys.js';
import type { UpstreamFetch } from '../../src/gateway/contract.js';

const KEYS: GmgnKey[] = [
  { apiKey: 'k0', limiterKey: 'gmgn', weight: 5 },
  { apiKey: 'k1', limiterKey: 'gmgn:1', weight: 20 },
];

const okFetch: UpstreamFetch = async () => ({ status: 200, body: '{}', headers: {} });

function pool(gates: Record<string, number> = {}, now = 1000): GmgnKeyPool {
  return new GmgnKeyPool({
    keys: KEYS,
    fetcherFor: () => okFetch,
    gateUntilOf: (limiterKey) => gates[limiterKey] ?? 0,
    now: () => now,
  });
}

test('pool: round-robin cycles every open key', () => {
  const p = pool();
  assert.equal(p.pick()?.limiterKey, 'gmgn');
  assert.equal(p.pick()?.limiterKey, 'gmgn:1');
  assert.equal(p.pick()?.limiterKey, 'gmgn', 'wraps back to the first key');
});

test('pool: a gated key is skipped in favour of the open one', () => {
  const p = pool({ gmgn: 5000 });
  assert.equal(p.pick()?.limiterKey, 'gmgn:1');
  assert.equal(p.pick()?.limiterKey, 'gmgn:1', 'only one open key -> chosen again');
});

test('pool: 3x401 parks a key down; a later 2xx clears the latch', () => {
  const p = pool();
  p.record(0, 401);
  p.record(0, 401);
  p.record(0, 401);
  assert.equal(p.pick()?.limiterKey, 'gmgn:1', 'down key is skipped');
  p.record(0, 200);
  assert.equal(p.pick()?.limiterKey, 'gmgn', '2xx clears the down latch');
});

test('pool: all keys gated/down -> null pick + earliest availability', () => {
  const p = pool({ gmgn: 4000, 'gmgn:1': 9000 });
  assert.equal(p.pick(), null);
  assert.equal(p.nextAvailableAt(), 4000, 'min over gate/down, never in the past');
});

test('pool: stats expose per-key served/authFails/downUntil', () => {
  const p = pool();
  p.record(0, 200);
  p.record(0, 401);
  const s = p.stats();
  assert.equal(s[0].served, 1);
  assert.equal(s[0].authFails, 1);
  assert.equal(s[0].downUntil, 0, 'below threshold -> not parked');
  assert.equal(s[1].served, 0);
});
