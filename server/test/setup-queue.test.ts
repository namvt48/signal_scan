import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueSetup } from '../src/setup-queue.js';
import type { Chain } from '../src/shared/chain.js';

const CHAIN: Chain = 'sol';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('setup queue serializes work and prioritizes urgent work over older background work', async () => {
  const started = deferred();
  const release = deferred();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const job = (name: string, wait?: Promise<void>) => async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(name);
    if (wait) {
      started.resolve();
      await wait;
    }
    active -= 1;
  };

  const blocker = enqueueSetup('QUEUE-SERIAL-BLOCKER', CHAIN, 1, job('active', release.promise));
  await started.promise;
  const background = enqueueSetup('QUEUE-SERIAL-BG', CHAIN, 1, job('background'));
  const urgent = enqueueSetup('QUEUE-SERIAL-URGENT', CHAIN, 0, job('urgent'));
  release.resolve();
  await Promise.all([blocker, background, urgent]);

  assert.deepEqual(order, ['active', 'urgent', 'background']);
  assert.equal(maxActive, 1, 'at most one setup task runs at a time');
});

test('setup queue serves oldest background work after eight urgent tasks', async () => {
  const started = deferred();
  const release = deferred();
  const order: string[] = [];
  const blocker = enqueueSetup('QUEUE-FAIR-BLOCKER', CHAIN, 1, async () => {
    started.resolve();
    await release.promise;
    order.push('blocker');
  });
  await started.promise;
  const background = enqueueSetup('QUEUE-FAIR-BACKGROUND', CHAIN, 1, async () => {
    order.push('background');
  });
  const urgent = Array.from({ length: 9 }, (_, index) => enqueueSetup(`QUEUE-FAIR-${index}`, CHAIN, 0, async () => {
    order.push(`urgent-${index}`);
  }));
  release.resolve();
  await Promise.all([blocker, background, ...urgent]);

  assert.equal(order[0], 'blocker');
  assert.deepEqual(order.slice(1, 9), Array.from({ length: 8 }, (_, index) => `urgent-${index}`));
  assert.equal(order[9], 'background', 'background work is not starved by urgent work');
  assert.equal(order[10], 'urgent-8');
});

test('identical setup keys join one job and rejected work can be retried', async () => {
  const started = deferred();
  const release = deferred();
  let attempts = 0;
  const first = enqueueSetup('QUEUE-JOIN-RETRY', CHAIN, 0, async () => {
    attempts += 1;
    started.resolve();
    await release.promise;
    throw new Error('first attempt');
  });
  await started.promise;
  const joined = enqueueSetup('QUEUE-JOIN-RETRY', CHAIN, 1, async () => {
    attempts += 1;
  });
  assert.strictEqual(joined, first, 'same key shares the in-flight promise');
  release.resolve();
  await assert.rejects(first, /first attempt/);
  await assert.rejects(joined, /first attempt/);

  await enqueueSetup('QUEUE-JOIN-RETRY', CHAIN, 0, async () => {
    attempts += 1;
  });
  assert.equal(attempts, 2, 'a rejection removes the in-flight key for a subsequent retry');
});
