import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestCache } from '../../src/providers/request-cache.js';

test('RequestCache coalesces identical reads, caches successes, and expires by TTL', async () => {
  let now = 100;
  const cache = new RequestCache({ now: () => now });
  let calls = 0;
  let release!: (value: { value: number }) => void;
  const blocked = new Promise<{ value: number }>((resolve) => { release = resolve; });
  const load = () => { calls += 1; return blocked; };

  const first = cache.run('chain:method:params', 10, load);
  const joined = cache.run('chain:method:params', 10, load);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ value: 7 });
  assert.deepEqual(await first, { value: 7 });
  assert.deepEqual(await joined, { value: 7 });
  assert.deepEqual(await cache.run('chain:method:params', 10, load), { value: 7 });
  assert.equal(calls, 1);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, joined: 1, size: 1, inflight: 0 });

  now += 10;
  await cache.run('chain:method:params', 10, async () => { calls += 1; return { value: 8 }; });
  assert.equal(calls, 2);
});

test('RequestCache never stores rejected or explicitly non-cacheable results', async () => {
  const cache = new RequestCache();
  let calls = 0;
  await assert.rejects(cache.run('failure', 100, async () => { calls += 1; throw new Error('upstream'); }), /upstream/);
  await cache.run('failure', 100, async () => { calls += 1; return 2; });
  await cache.run('empty', 100, async () => { calls += 1; return 0; }, (value) => value > 0);
  await cache.run('empty', 100, async () => { calls += 1; return 0; }, (value) => value > 0);
  assert.equal(calls, 4);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 4, joined: 0, size: 1, inflight: 0 });
});
