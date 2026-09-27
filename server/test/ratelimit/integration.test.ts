import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../../src/ratelimit/limiter.js';

test('integration: composed window + concurrency never exceed the configured limits', async () => {
  const l = new Limiter('t', { window: { max: 5, windowMs: 1_000 }, maxConcurrency: 2 });
  const starts: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const jobs = Array.from({ length: 12 }, () =>
    l.run({}, async () => {
      starts.push(Date.now());
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    }),
  );
  await Promise.all(jobs);
  assert.equal(peak, 2, 'concurrency cap');
  // no 1000ms window may contain more than 5 starts
  for (const t of starts) {
    const inWindow = starts.filter((s) => s >= t && s < t + 1_000).length;
    assert.ok(inWindow <= 5, `window at ${t} had ${inWindow}`);
  }
});
