import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignalResponseCache } from '../src/signal-response-cache.js';

test('signal response cache reuses values per mode until TTL expires', () => {
  const cache = createSignalResponseCache<string[]>(100);
  let builds = 0;
  const build = () => [`build-${++builds}`];

  const first = cache.get(false, build, 1_000);
  assert.strictEqual(cache.get(false, build, 1_099), first);
  assert.deepEqual(first, ['build-1']);
  assert.deepEqual(cache.get(true, build, 1_099), ['build-2']);
  assert.deepEqual(cache.get(false, build, 1_100), ['build-3']);
  assert.equal(builds, 3);
});

test('signal response cache invalidation and failed builds do not retain stale values', () => {
  const cache = createSignalResponseCache<string[]>(100);
  let builds = 0;
  const build = () => [`build-${++builds}`];

  cache.get(false, build, 1_000);
  cache.invalidate();
  assert.deepEqual(cache.get(false, build, 1_001), ['build-2']);
  assert.throws(() => cache.get(true, () => { throw new Error('build failed'); }, 1_002));
  assert.deepEqual(cache.get(true, build, 1_003), ['build-3']);
});
