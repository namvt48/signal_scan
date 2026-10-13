import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../../src/ratelimit/limiter.js';
import { HttpError, LimiterUnavailableError } from '../../src/ratelimit/types.js';

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
test('Limiter: same-priority jobs rotate callers under shared concurrency', async () => {
  const l = new Limiter('fair', { maxConcurrency: 1 });
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = l.run({ caller: 'a', priority: 1 }, async () => {
    order.push('first-a');
    await held;
  });
  const a1 = l.run({ caller: 'a', priority: 1 }, async () => { order.push('second-a'); });
  const b1 = l.run({ caller: 'b', priority: 1 }, async () => { order.push('first-b'); });
  release();
  await Promise.all([first, a1, b1]);
  assert.deepEqual(order, ['first-a', 'first-b', 'second-a']);
});

test('Limiter: critical work displaces queued background work at capacity', async () => {
  const l = new Limiter('bounded', { maxConcurrency: 1, queueMax: 1 });
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const blocker = l.run({ caller: 'a', priority: 0 }, async () => { await held; });
  const background = l.run({ caller: 'b', priority: 2 }, async () => 'background');
  const critical = l.run({ caller: 'a', priority: 0 }, async () => 'critical');
  release();
  await blocker;
  await assert.rejects(background, LimiterUnavailableError);
  assert.equal(await critical, 'critical');
});

test('Limiter: queued work expires on age or caller deadline', async () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: unknown) => {
      const index = timers.indexOf(timer as { at: number; fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const l = new Limiter('expiry', { maxConcurrency: 1, queueMaxAgeMs: 10 }, clock);
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const blocker = l.run({}, async () => { await held; });
  const ageExpired = l.run({ caller: 'a' }, async () => 'not-run');
  const deadlineExpired = l.run({ caller: 'b', deadlineAt: 5 }, async () => 'not-run');
  const ageResult = assert.rejects(ageExpired, LimiterUnavailableError);
  const deadlineResult = assert.rejects(deadlineExpired, LimiterUnavailableError);
  const deadlineTimer = timers.shift();
  assert.ok(deadlineTimer);
  now = deadlineTimer.at;
  deadlineTimer.fn();
  await deadlineResult;
  const ageTimer = timers.shift();
  assert.ok(ageTimer);
  now = ageTimer.at;
  ageTimer.fn();
  await ageResult;
  release();
  await blocker;
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

test('Limiter: 400, 401, and 403 are never retried, even if a policy matches them', async () => {
  for (const status of [400, 401, 403]) {
    const l = new Limiter('permanent', {
      retry: { retries: 4, backoff: 'exp', baseMs: 1, retryOn: () => true },
    });
    let calls = 0;
    await assert.rejects(
      l.run({}, async () => {
        calls += 1;
        throw new HttpError(status, null, `permanent ${status}`);
      }),
      new RegExp(`permanent ${status}`),
    );
    assert.equal(calls, 1, `status ${status} gets no retry`);
  }
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
  const l = new Limiter('t', {
    retry: {
      retries: 2,
      backoff: 'exp',
      baseMs: 1_000,
      jitterMs: 500,
      random: () => 0.5,
      retryOn: (s) => s >= 500,
    },
  }, clock);
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
  assert.deepEqual(at, [0, 1_250, 3_500], 'exponential backoff includes deterministic jitter');
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
test('Limiter: a 429 gates queued jobs until the shared reset deadline', async () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: unknown) => {
      const index = timers.indexOf(timer as { at: number; fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const l = new Limiter('gmgn-egress', {
    maxConcurrency: 1,
    gate: { statuses: [429], fallbackCooldownMs: 40 },
  }, clock);
  const failed = Promise.withResolvers<never>();
  const firstStarted = Promise.withResolvers<void>();
  let calls = 0;
  const first = l.run({}, () => {
    firstStarted.resolve();
    return failed.promise;
  });
  const second = l.run({}, async () => {
    calls++;
    return 'second';
  });
  await firstStarted.promise;
  failed.reject(new HttpError(429, null, 'rate limited'));
  await assert.rejects(first, /rate limited/);
  assert.equal(calls, 0, 'queued request must not bypass an armed gate');
  const timer = timers.shift();
  assert.ok(timer, 'the gate must schedule the queued request for its reset');
  now = timer.at;
  timer.fn();
  assert.equal(await second, 'second');
  assert.equal(calls, 1);
});
test('Limiter: deferred gate admission waits for reset without bypassing the gate', async () => {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: unknown) => {
      const index = timers.indexOf(timer as { at: number; fn: () => void });
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const l = new Limiter('deferred', {
    gate: { statuses: [429], fallbackCooldownMs: 20 },
    deferGate: true,
    queueMaxAgeMs: 100,
  }, clock);
  await assert.rejects(l.run({}, async () => { throw new HttpError(429, null, 'limited'); }), /limited/);
  let calls = 0;
  const delayed = l.run({}, async () => { calls += 1; return 'ok'; });
  assert.equal(calls, 0, 'a gated request is deferred, not dispatched');
  const timer = timers.shift();
  assert.ok(timer);
  now = timer.at;
  timer.fn();
  assert.equal(await delayed, 'ok');
  assert.equal(calls, 1);
});

test('Limiter: deferred gate admission rejects when reset exceeds queue age', async () => {
  const l = new Limiter('deferred', {
    gate: { statuses: [429], fallbackCooldownMs: 20 },
    deferGate: true,
    queueMaxAgeMs: 10,
  });
  await assert.rejects(l.run({}, async () => { throw new HttpError(429, null, 'limited'); }), /limited/);
  await assert.rejects(
    l.run({}, async () => 'not-run'),
    (error: unknown) => error instanceof LimiterUnavailableError && error.reason === 'gate',
  );
});
