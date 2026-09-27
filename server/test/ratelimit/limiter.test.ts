import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../../src/ratelimit/limiter.js';
import { HttpError } from '../../src/ratelimit/types.js';

test('Limiter: maxConcurrency never exceeded', async () => {
  const l = new Limiter('t', { maxConcurrency: 2 });
  let inFlight = 0;
  let peak = 0;
  const gate = new Promise<void>((r) => setTimeout(r, 20));
  const job = () =>
    l.run({}, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
    });
  await Promise.all([job(), job(), job(), job()]);
  assert.equal(peak, 2);
});

test('Limiter: 429 arms the gate; the next run rejects immediately with a constant message', async () => {
  const l = new Limiter('t', { gate: { statuses: [429], header: 'x-ratelimit-reset' } });
  await assert.rejects(
    l.run({}, async () => {
      throw new HttpError(429, String(Math.floor((Date.now() + 60_000) / 1000)), 'gmgn 429');
    }),
    /429/,
  );
  const blocked = await l.run({}, async () => 'should-not-run').then(
    () => 'ran',
    (e: Error) => e.message,
  );
  assert.match(blocked, /gated until/);
});

test('Limiter: a retryable 5xx is retried then rejected when exhausted', async () => {
  const l = new Limiter('t', { retry: { retries: 2, backoff: 'exp', baseMs: 1, retryOn: (s) => s >= 500 } });
  let calls = 0;
  await assert.rejects(
    l.run({}, async () => {
      calls++;
      throw new HttpError(500, null, 'boom');
    }),
    /boom/,
  );
  assert.equal(calls, 3, 'initial + 2 retries');
});

test('Limiter: an aged queued job is still dispatched (aging does not strand it)', async () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (t: unknown) => {
      const i = timers.indexOf(t as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const l = new Limiter('t', { maxConcurrency: 1, priorityAgingMs: 10 }, clock);
  let release: () => void = () => {};
  const blocker = l.run({ priority: 0 }, () => new Promise<void>((r) => { release = r; }));
  const background = l.run({ priority: 2 }, async () => 'bg-done');
  now = 100;
  release();
  await blocker;
  assert.equal(await background, 'bg-done');
});

test('Limiter: a retry waits the backoff interval before re-attempting', async () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (t: unknown) => {
      const i = timers.indexOf(t as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const l = new Limiter('t', { retry: { retries: 2, backoff: 'exp', baseMs: 1000, retryOn: (s) => s >= 500 } }, clock);
  const at: number[] = [];
  const p = l
    .run({}, async () => {
      at.push(clock.now());
      throw new HttpError(500, null, 'boom');
    })
    .catch((e: Error) => e.message);
  for (;;) {
    await new Promise((r) => setImmediate(r)); // flush microtasks so handleError can arm its timer
    if (timers.length === 0) break;
    const t = timers.shift()!;
    if (t.at > now) now = t.at;
    t.fn();
  }
  assert.equal(await p, 'boom');
  assert.deepEqual(at, [0, 1000, 3000], 'attempts spaced by exponential backoff');
});

test('Limiter: a 403 quota status closes the gate for its cooldown', async () => {
  const l = new Limiter('nansen-credit', {
    gate: { statuses: [429], statusesWithCooldown: [{ status: 403, cooldownMs: 60_000 }] },
  });
  await assert.rejects(
    l.run({}, async () => {
      throw new HttpError(403, null, 'Insufficient credits');
    }),
    /Insufficient credits/,
  );
  const next = await l.run({}, async () => 'ran').then(
    () => 'ran',
    (e: Error) => e.message,
  );
  assert.match(next, /gated until/);
});
