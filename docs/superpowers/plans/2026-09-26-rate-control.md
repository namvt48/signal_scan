# Rate-Control Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One configurable, per-API outbound rate-control layer (composable limiter + priority queues + gates + retry) that provably never exceeds any upstream limit, replacing four bespoke mechanisms.

**Architecture:** A `server/src/ratelimit/` module exposes `registry.run(api, opts, fn)`. Each API has a `Limiter` composing optional constraints (weight token-bucket · sliding window · min-interval · max-concurrency), a priority queue with aging, a generic `Gate` (429 reset-header + 403 quota cooldown), and a re-enqueueing retry. Providers throw a typed `HttpError(status, header)` so the layer owns gate + retry. Migrated one API per deploy.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), Node 20, `node:test` + `node:assert/strict` run via `tsx --test`, `better-sqlite3`.

**Spec:** `docs/superpowers/specs/2026-09-26-rate-control-design.md`

**VCS note:** this directory is **not a git repo**. Therefore every "Commit" step below is replaced by a **Checkpoint** step (run the suite + record evidence). Do not run `git commit`.

**Test command (all plans):** `cd server && npx tsx --test test/ratelimit/<file>.test.ts`
Pre-existing failures: `npm test` currently has **2 pre-existing failures** in `test/signals.test.ts` (`tags: []`). Do not fix them; just confirm the count stays 2.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/ratelimit/types.ts` | create | shared types + `HttpError` |
| `server/src/ratelimit/bucket.ts` | create | weight token-bucket `Constraint` |
| `server/src/ratelimit/window.ts` | create | sliding-window `Constraint` |
| `server/src/ratelimit/min-interval.ts` | create | min-interval `Constraint` |
| `server/src/ratelimit/semaphore.ts` | create | max-concurrency slot counter |
| `server/src/ratelimit/gate.ts` | create | 429/403 gate |
| `server/src/ratelimit/spec.ts` | create | declared per-API config + env override |
| `server/src/ratelimit/limiter.ts` | create | compose constraints + queue + scheduler + retry |
| `server/src/ratelimit/registry.ts` | create | `name → Limiter`, `run`, `snapshot` |
| `server/src/ratelimit/index.ts` | create | singleton registry built from `spec.ts` |
| `server/test/ratelimit/bucket.test.ts` | create | bucket tests |
| `server/test/ratelimit/window.test.ts` | create | window tests |
| `server/test/ratelimit/min-interval.test.ts` | create | min-interval tests |
| `server/test/ratelimit/semaphore.test.ts` | create | semaphore tests |
| `server/test/ratelimit/gate.test.ts` | create | gate tests |
| `server/test/ratelimit/spec.test.ts` | create | config resolution tests |
| `server/test/ratelimit/limiter.test.ts` | create | scheduler + retry tests |
| `server/test/ratelimit/integration.test.ts` | create | never-exceed proof |
| `server/src/index.ts` | modify | build registry at startup (unused in step 1) |
| `server/src/providers/gmgn.ts` | modify | route through `registry.run('gmgn', …)` |
| `server/src/providers/solana.ts` | modify | route through `registry.run('solana-rpc', …)` |
| `server/src/providers/nansen.ts` | modify | route credit calls through `registry.run('nansen-credit', …)` |
| `server/src/crawl.ts` | modify | door aggregate cap/path budget via `registry.run('nansen-door', …)` |
| `server/src/providers/dexscreener.ts` | modify | route through `registry.run('dexscreener', …)` |
| `server/src/index.ts` (health) | modify | expose `ratelimit` snapshot |

---

# Phase A — the module (no call-site changes)

## Task 1: Types + HttpError

**Files:**
- Create: `server/src/ratelimit/types.ts`

- [ ] **Step 1: Write the file**

```ts
export type Priority = 0 | 1 | 2; // 0=critical, 1=normal, 2=bulk

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
  defaultWeight: number;
}
export interface WindowSpec {
  max: number;
  windowMs: number;
}
export interface GateSpec {
  statuses: number[];
  header?: string;
  statusesWithCooldown?: { status: number; cooldownMs: number }[];
}
export interface RetrySpec {
  retries: number;
  backoff: 'fibo' | 'exp';
  baseMs: number;
  capMs?: number;
  retryOn: (status: number) => boolean;
}
export interface ApiLimitSpec {
  weightBucket?: BucketSpec;
  window?: WindowSpec;
  pathWindow?: WindowSpec;
  minIntervalMs?: number;
  maxConcurrency?: number;
  gate?: GateSpec;
  retry?: RetrySpec;
  priorityAgingMs?: number;
}
export interface RunOpts {
  weight?: number;
  priority?: Priority;
  path?: string;
}

/** A constraint contributes a ready time; it never throws. */
export interface Constraint {
  readyAt(now: number, opts: RunOpts): number;
  onStart(now: number, opts: RunOpts): void;
}

export interface LimiterSnapshot {
  inFlight: number;
  queued: number;
  gateUntil: number;
  windowUsed: number;
}
export interface Limiter {
  run<T>(opts: RunOpts, fn: () => Promise<T>): Promise<T>;
  snapshot(): LimiterSnapshot;
}
export interface Registry {
  run<T>(api: string, opts: RunOpts, fn: () => Promise<T>): Promise<T>;
  snapshot(): Record<string, LimiterSnapshot>;
}

/** Providers throw this so the layer owns gate + retry decisions. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly header: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: exit 0 (no errors from this new file).

- [ ] **Step 3: Checkpoint**

Run: `cd server && npx tsc --noEmit && echo OK`
Expected: `OK`.

---

## Task 2: Bucket constraint

**Files:**
- Create: `server/src/ratelimit/bucket.ts`
- Test: `server/test/ratelimit/bucket.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bucket } from '../../src/ratelimit/bucket.js';

test('Bucket: a full budget is ready now; the next call waits for its refill', () => {
  const b = new Bucket(5, 5, 1);
  assert.equal(b.readyAt(0, {}), 0);
  for (let i = 0; i < 5; i++) b.onStart(0, {});
  assert.equal(b.readyAt(0, {}), 200, '6th token needs 1/5s');
});

test('Bucket: weight above capacity is clamped (never spins forever)', () => {
  const b = new Bucket(5, 5, 1);
  assert.equal(b.readyAt(0, { weight: 99 }), 0, 'clamped to capacity = already available');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/bucket.test.ts`
Expected: FAIL — cannot find module `bucket.js`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Constraint, RunOpts } from './types.js';

export class Bucket implements Constraint {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly defaultWeight: number,
    now = 0,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private need(opts: RunOpts): number {
    return Math.min(opts.weight ?? this.defaultWeight, this.capacity);
  }

  readyAt(now: number, opts: RunOpts): number {
    const n = this.need(opts);
    const avail = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    if (avail >= n) return now;
    return now + Math.ceil(((n - avail) / this.refillPerSec) * 1000);
  }

  onStart(now: number, opts: RunOpts): void {
    const n = this.need(opts);
    const avail = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.tokens = Math.max(0, avail - n);
    this.last = now;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/bucket.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint**

Run: `cd server && npx tsx --test test/ratelimit/bucket.test.ts && echo OK`
Expected: `OK`.

---

## Task 3: Window constraint

**Files:**
- Create: `server/src/ratelimit/window.ts`
- Test: `server/test/ratelimit/window.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from '../../src/ratelimit/window.js';

test('Window: allows up to max, then waits exactly until the oldest exits', () => {
  const w = new Window(3, 60_000);
  for (let i = 0; i < 3; i++) {
    assert.equal(w.readyAt(i * 1000, {}), i * 1000);
    w.onStart(i * 1000, {});
  }
  assert.equal(w.readyAt(3_000, {}), 60_000, 'full -> oldest(0) + windowMs');
});

test('Window: frees a slot once the old timestamp ages out', () => {
  const w = new Window(1, 1_000);
  w.onStart(0, {});
  assert.equal(w.readyAt(500, {}), 1_000);
  assert.equal(w.readyAt(1_000, {}), 1_000, 'at the boundary it is free again');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/window.test.ts`
Expected: FAIL — cannot find module `window.js`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Constraint, RunOpts } from './types.js';

export class Window implements Constraint {
  private readonly ts: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private evict(now: number): void {
    while (this.ts.length > 0 && this.ts[0] + this.windowMs <= now) this.ts.shift();
  }

  readyAt(now: number, _opts: RunOpts): number {
    this.evict(now);
    if (this.ts.length < this.max) return now;
    return this.ts[0] + this.windowMs;
  }

  onStart(now: number, _opts: RunOpts): void {
    this.evict(now);
    this.ts.push(now);
  }

  get used(): number {
    return this.ts.length;
  }
}
```

> Signature note: `readyAt`/`onStart` MUST match `Constraint` exactly (`(now, opts)`), even where `opts` is unused — the tests call the 2-arg form, and `_opts` keeps `noUnusedParameters` clean.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/window.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint**

Run: `cd server && npx tsx --test test/ratelimit/window.test.ts && echo OK`
Expected: `OK`.

---

## Task 4: MinInterval constraint

**Files:**
- Create: `server/src/ratelimit/min-interval.ts`
- Test: `server/test/ratelimit/min-interval.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinInterval } from '../../src/ratelimit/min-interval.js';

test('MinInterval: first is free, each next waits the interval after the previous start', () => {
  const m = new MinInterval(600);
  assert.equal(m.readyAt(0, {}), 0);
  m.onStart(0, {});
  assert.equal(m.readyAt(0, {}), 600);
  m.onStart(1_000, {});
  assert.equal(m.readyAt(1_000, {}), 1_600);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/min-interval.test.ts`
Expected: FAIL — cannot find module `min-interval.js`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Constraint, RunOpts } from './types.js';

export class MinInterval implements Constraint {
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number) {}

  readyAt(_now: number, _opts: RunOpts): number {
    // clamp -Infinity (never started) to 0 so "first is free"; the limiter's Math.max(now, ...) does the rest
    return Math.max(0, this.lastStart + this.intervalMs);
  }

  onStart(now: number, _opts: RunOpts): void {
    this.lastStart = now;
  }
}
```

> Signature note: same as `Window` — match `Constraint`'s `(now, opts)` arity. `readyAt` also needs the `Math.max(0, …)` clamp, otherwise the first call returns `-Infinity` and fails the test.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/min-interval.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Checkpoint**

Run: `cd server && npx tsx --test test/ratelimit/min-interval.test.ts && echo OK`
Expected: `OK`.

---

## Task 5: Semaphore

**Files:**
- Create: `server/src/ratelimit/semaphore.ts`
- Test: `server/test/ratelimit/semaphore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../../src/ratelimit/semaphore.js';

test('Semaphore: never reports free beyond max and recovers on release', () => {
  const s = new Semaphore(2);
  assert.equal(s.full, false);
  s.acquire();
  s.acquire();
  assert.equal(s.full, true);
  s.release();
  assert.equal(s.full, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/semaphore.test.ts`
Expected: FAIL — cannot find module `semaphore.js`.

- [ ] **Step 3: Write the implementation**

```ts
export class Semaphore {
  private inFlight = 0;

  constructor(private readonly max: number) {}

  get full(): boolean {
    return this.inFlight >= this.max;
  }

  get count(): number {
    return this.inFlight;
  }

  acquire(): void {
    this.inFlight++;
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight--;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/semaphore.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Checkpoint**

Run: `cd server && npx tsx --test test/ratelimit/semaphore.test.ts && echo OK`
Expected: `OK`.

---

## Task 6: Gate

**Files:**
- Create: `server/src/ratelimit/gate.ts`
- Test: `server/test/ratelimit/gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../../src/ratelimit/gate.js';

test('Gate: 429 with a reset header arms until reset+margin, and renews', () => {
  const g = new Gate({ statuses: [429], header: 'x-ratelimit-reset' });
  g.note(429, '1000', 0);
  assert.equal(g.until, 1_002_000);
  assert.equal(g.blocked(1_001_000), true);
  g.note(429, '1400', 0);
  assert.ok(g.until > 1_002_000, 'renewed');
});

test('Gate: a configured quota status closes for its cooldown', () => {
  const g = new Gate({ statuses: [429], statusesWithCooldown: [{ status: 403, cooldownMs: 600_000 }] });
  g.note(403, null, 5_000);
  assert.equal(g.until, 605_000);
  assert.equal(g.blocked(600_000), true);
  assert.equal(g.blocked(605_001), false);
});

test('Gate: an unlisted status is ignored', () => {
  const g = new Gate({ statuses: [429], header: 'x-ratelimit-reset' });
  g.note(500, '1000', 0);
  assert.equal(g.blocked(0), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/gate.test.ts`
Expected: FAIL — cannot find module `gate.js`.

- [ ] **Step 3: Write the implementation**

```ts
import type { GateSpec } from './types.js';

const MARGIN_MS = 2_000;

export class Gate {
  private untilMs = 0;

  constructor(
    private readonly spec: GateSpec,
    private readonly marginMs = MARGIN_MS,
  ) {}

  blocked(now: number): boolean {
    return now < this.untilMs;
  }

  get until(): number {
    return this.untilMs;
  }

  note(status: number, headerVal: string | null, now: number): void {
    const cooldown = this.spec.statusesWithCooldown?.find((s) => s.status === status);
    if (cooldown) {
      this.untilMs = now + cooldown.cooldownMs;
      return;
    }
    if (this.spec.statuses.includes(status) && this.spec.header && headerVal) {
      const sec = Number(headerVal);
      if (Number.isFinite(sec)) this.untilMs = sec * 1000 + this.marginMs;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/gate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint**

Run: `cd server && npx tsx --test test/ratelimit/gate.test.ts && echo OK`
Expected: `OK`.

---

## Task 7: Spec + env override

**Files:**
- Create: `server/src/ratelimit/spec.ts`
- Test: `server/test/ratelimit/spec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/spec.test.ts`
Expected: FAIL — cannot find module `spec.js`.

- [ ] **Step 3: Write the implementation**

```ts
import type { ApiLimitSpec } from './types.js';

export function resolveNum(env: string, def: number): number {
  const v = process.env[env];
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : def;
}

export function buildSpecs(gmgnPlanWeight: number): Record<string, ApiLimitSpec> {
  return {
    gmgn: {
      weightBucket: {
        capacity: gmgnPlanWeight,
        refillPerSec: gmgnPlanWeight,
        defaultWeight: 1,
      },
      gate: { statuses: [429], header: 'x-ratelimit-reset' },
      priorityAgingMs: resolveNum('RL_PRIORITY_AGING_MS', 30_000),
    },
    'solana-rpc': {
      minIntervalMs: resolveNum('RL_SOLANA_RPC_MININTERVALMS', 600),
      gate: { statuses: [429] },
      retry: {
        retries: resolveNum('RL_SOLANA_RPC_RETRIES', 3),
        backoff: 'exp',
        baseMs: 400,
        capMs: 2_000,
        retryOn: (s) => s === 429 || s >= 500,
      },
    },
    'nansen-credit': {
      maxConcurrency: resolveNum('RL_NANSEN_CREDIT_MAXCONCURRENCY', 2),
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_NANSEN_CREDIT_403COOLDOWNMS', 600_000) },
        ],
      },
      retry: {
        retries: resolveNum('RL_NANSEN_CREDIT_RETRIES', 6),
        backoff: 'fibo',
        baseMs: resolveNum('RL_NANSEN_CREDIT_BASEMS', 1_000),
        retryOn: (s) => s === 429 || s >= 500,
      },
    },
    'nansen-door': {
      window: { max: resolveNum('RL_NANSEN_DOOR_MAX', 40), windowMs: 60_000 },
      pathWindow: { max: resolveNum('RL_NANSEN_DOOR_PATHMAX', 30), windowMs: 60_000 },
    },
    dexscreener: {
      window: { max: resolveNum('RL_DEXSCREENER_MAX', 60), windowMs: 60_000 },
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/spec.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint**

Run: `cd server && npx tsx --test test/ratelimit/spec.test.ts && echo OK`
Expected: `OK`.

---

## Task 8: Limiter + Registry + singleton

**Files:**
- Create: `server/src/ratelimit/limiter.ts`, `server/src/ratelimit/registry.ts`, `server/src/ratelimit/index.ts`
- Test: `server/test/ratelimit/limiter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/ratelimit/limiter.test.ts`
Expected: FAIL — cannot find module `limiter.js`.

- [ ] **Step 3: Write `limiter.ts`**

```ts
import { Bucket } from './bucket.js';
import { Window } from './window.js';
import { MinInterval } from './min-interval.js';
import { Semaphore } from './semaphore.js';
import { Gate } from './gate.js';
import { HttpError, type ApiLimitSpec, type Constraint, type Limiter as ILimiter, type LimiterSnapshot, type Priority, type RunOpts } from './types.js';

interface Job {
  priority: Priority;
  enqueuedAt: number;
  opts: RunOpts;
  fn: () => Promise<unknown>;
  attempt: number;
  notBefore: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
};

export class Limiter implements ILimiter {
  private readonly queues: Job[][] = [[], [], []];
  private readonly constraints: Constraint[] = [];
  private readonly paths = new Map<string, Window>();
  private readonly sem: Semaphore | null;
  private readonly gate: Gate | null;
  private readonly agingMs: number;
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: string,
    spec: ApiLimitSpec,
    private readonly clock = CLOCK,
  ) {
    if (spec.weightBucket) {
      const b = spec.weightBucket;
      this.constraints.push(new Bucket(b.capacity, b.refillPerSec, b.defaultWeight));
    }
    if (spec.window) this.constraints.push(new Window(spec.window.max, spec.window.windowMs));
    if (spec.minIntervalMs) this.constraints.push(new MinInterval(spec.minIntervalMs));
    this.sem = spec.maxConcurrency ? new Semaphore(spec.maxConcurrency) : null;
    this.gate = spec.gate ? new Gate(spec.gate) : null;
    this.agingMs = spec.priorityAgingMs ?? 30_000;
    this.retry = spec.retry ?? null;
    this.pathWindow = spec.pathWindow ?? null;
  }

  private readonly retry;
  private readonly pathWindow;

  run<T>(opts: RunOpts, fn: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    if (this.gate?.blocked(now)) {
      return Promise.reject(new Error(`${this.api} gated until ${new Date(this.gate.until).toISOString()}`));
    }
    return new Promise<T>((resolve, reject) => {
      const priority = opts.priority ?? 1;
      this.queues[priority].push({
        priority,
        enqueuedAt: now,
        opts,
        fn: fn as () => Promise<unknown>,
        attempt: 0,
        notBefore: 0,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.kick();
    });
  }

  snapshot(): LimiterSnapshot {
    return {
      inFlight: this.sem?.count ?? 0,
      queued: this.queues.reduce((n, q) => n + q.length, 0),
      gateUntil: this.gate?.until ?? 0,
      windowUsed: (this.constraints.find((c) => c instanceof Window) as Window | undefined)?.used ?? 0,
    };
  }

  private effectivePriority(job: Job, now: number): Priority {
    if (job.priority === 0) return 0;
    const aged = now - job.enqueuedAt >= this.agingMs;
    return (aged ? job.priority - 1 : job.priority) as Priority;
  }

  private nextJob(now: number): Job | null {
    let best: Job | null = null;
    let bestEff = Number.POSITIVE_INFINITY;
    for (const q of this.queues) {
      if (q.length === 0) continue;
      const eff = this.effectivePriority(q[0], now);
      if (eff < bestEff) {
        bestEff = eff;
        best = q[0];
      }
    }
    if (best) this.queues[best.priority].shift();
    return best;
  }

  private pushBack(job: Job): void {
    this.queues[job.priority].unshift(job);
  }

  private readyAtFor(now: number, opts: RunOpts): number {
    let ready = now;
    for (const c of this.constraints) ready = Math.max(ready, c.readyAt(now, opts));
    if (this.pathWindow && opts.path) {
      const w = this.pathWindowFor(opts.path);
      ready = Math.max(ready, w.readyAt(now, opts));
    }
    return ready;
  }

  private pathWindowFor(path: string): Window {
    let w = this.paths.get(path);
    if (!w) {
      w = new Window(this.pathWindow!.max, this.pathWindow!.windowMs);
      this.paths.set(path, w);
    }
    return w;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      this.drain();
    } finally {
      this.draining = false;
    }
  }

  private drain(): void {
    for (;;) {
      const now = this.clock.now();
      const job = this.nextJob(now);
      if (!job) return;
      const readyAt = Math.max(this.readyAtFor(now, job.opts), job.notBefore);
      if (readyAt > now) {
        this.pushBack(job);
        this.arm(readyAt - now);
        return;
      }
      if (this.sem?.full) {
        this.pushBack(job);
        return; // kick() is called again on release
      }
      this.start(job, now);
    }
  }

  private start(job: Job, now: number): void {
    for (const c of this.constraints) c.onStart(now, job.opts);
    if (this.pathWindow && job.opts.path) this.pathWindowFor(job.opts.path).onStart(now, job.opts);
    this.sem?.acquire();
    job
      .fn()
      .then(
        (v) => {
          this.sem?.release();
          job.resolve(v);
          this.kick();
        },
        (e) => {
          this.sem?.release();
          this.handleError(job, e, now);
        },
      );
  }

  private handleError(job: Job, e: unknown, now: number): void {
    if (e instanceof HttpError) {
      this.gate?.note(e.status, e.header, now);
      if (this.gate?.blocked(now)) {
        // the call that TRIGGERED the ban surfaces its real error; only the calls that follow
        // get the constant `${api} gated until <ISO>` message (run()'s pre-flight) for log dedupe.
        job.reject(e);
        this.kick();
        return;
      }
      if (this.retry && job.attempt < this.retry.retries && this.retry.retryOn(e.status)) {
        job.attempt++;
        const delay = this.backoffDelay(job.attempt);
        job.notBefore = now + delay;
        this.queues[job.priority].push(job); // rejoin at the BACK so the backoff does not block peers
        this.arm(delay);
        this.kick();
        return;
      }
    }
    job.reject(e);
    this.kick();
  }

  private backoffDelay(attempt: number): number {
    const r = this.retry!;
    if (r.backoff === 'fibo') {
      let a = 1;
      let b = 1;
      for (let i = 1; i < attempt; i++) [a, b] = [b, a + b];
      return b * r.baseMs;
    }
    return Math.min(r.capMs ?? Number.POSITIVE_INFINITY, r.baseMs * 2 ** (attempt - 1));
  }

  private arm(ms: number): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(1, ms));
  }
}
```

- [ ] **Step 4: Write `registry.ts`**

```ts
import { Limiter } from './limiter.js';
import type { ApiLimitSpec, LimiterSnapshot, Priority, Registry, RunOpts } from './types.js';

export class LimiterRegistry implements Registry {
  private readonly limiters = new Map<string, Limiter>();

  constructor(specs: Record<string, ApiLimitSpec>) {
    for (const [api, spec] of Object.entries(specs)) this.limiters.set(api, new Limiter(api, spec));
  }

  run<T>(api: string, opts: RunOpts, fn: () => Promise<T>): Promise<T> {
    const l = this.limiters.get(api);
    if (!l) return Promise.reject(new Error(`ratelimit: unknown api "${api}"`));
    return l.run(opts, fn);
  }

  snapshot(): Record<string, LimiterSnapshot> {
    const out: Record<string, LimiterSnapshot> = {};
    for (const [api, l] of this.limiters) out[api] = l.snapshot();
    return out;
  }
}

export type { Priority };
```

- [ ] **Step 5: Write `index.ts`**

```ts
import { buildSpecs } from './spec.js';
import { LimiterRegistry } from './registry.js';
import { config } from '../config.js';

export const limiters = new LimiterRegistry(buildSpecs(config.gmgnPlanWeight));
export type { RunOpts, Priority } from './types.js';
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && npx tsx --test test/ratelimit/limiter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Checkpoint**

Run: `cd server && npx tsc --noEmit && npx tsx --test test/ratelimit/*.test.ts && echo OK`
Expected: `OK` (all ratelimit tests pass).

---

## Task 9: Wire registry at startup (unused) — deploy step 1 of 6

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Add the import + a no-op reference so the module is built at boot**

Add near the other imports in `server/src/index.ts`:

```ts
import { limiters } from './ratelimit/index.js';
```

And in the health handler (find the existing `/api/health` JSON response) add the snapshot field:

```ts
    ratelimit: limiters.snapshot(),
```

- [ ] **Step 2: Typecheck + full suite**

Run: `cd server && npx tsc --noEmit && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 2` (the pre-existing signals failures only), tests = 261 + new.

- [ ] **Step 3: Deploy**

Run (from repo root):
```bash
make deploy
ssh -o BatchMode=yes root@194.163.187.250 'cd /root/signal_scan && PORT=8124 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api'
```
Expected: `== deploy OK`, then api recreated.

- [ ] **Step 4: Verify**

Run:
```bash
ssh -o BatchMode=yes root@194.163.187.250 'curl -s -m 5 localhost:8124/api/health'
```
Expected: JSON includes `"ratelimit":{...}` with `gmgn`, `solana-rpc`, `nansen-credit`, `nansen-door`, `dexscreener`, and `"healthy":true`.

- [ ] **Step 5: Checkpoint**

Record the health JSON as evidence. No behavior change expected.

---

# Phase B — migrate GMGN (deploy step 2 of 6)

## Task 10: GMGN routes through the layer

**Files:**
- Modify: `server/src/providers/gmgn.ts`
- Modify: `server/src/index.ts` (caller — drops the `config.gmgnPlanWeight` arg)
- Test: `server/test/gmgn.test.ts` (delete the 4 dead `WeightBucket`/`BanGate` cases + their imports; append the new 429 test LAST)
- Test: `server/test/ratelimit/gate.test.ts` (add the non-numeric-reset edge case)

> **As-built deltas (executed 2026-09-26, reviewed APPROVE):**
> 1. `server/src/index.ts:30` updated to `new GmgnMarketProvider(config.gmgnApiKey)` — the plan's Step 3 omitted this; without it `tsc` fails.
> 2. `fetchTokenInfo` keeps the `timed('gmgn token/info', { ca, chain }, …)` wrapper INSIDE the `limiters.run(...)` callback (the plan dropped `timed` — an observability regression). The limiter's wait stays outside `timed`.
> 3. The 4 old `WeightBucket`/`BanGate` tests were DELETED, not moved — both classes no longer exist; `test/ratelimit/{bucket,gate}.test.ts` already cover that behavior (gate.test.ts covers 429+header arm/renew, unlisted ignored, and non-numeric reset ignored).
> 4. `src/config.ts:143` comment updated to point at `ratelimit/spec.ts` instead of the deleted `WeightBucket`.
> Verified: `tsc` 0; `test/gmgn.test.ts` 7/7; `test/ratelimit` 17/17; `npm test` 258/256/fail 2 (pre-existing signals).

- [ ] **Step 1: Write the failing test (assert the provider uses the registry)**

Add to `server/test/gmgn.test.ts`:

```ts
test('GmgnMarketProvider: a 429 becomes an HttpError so the layer can gate', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 429, error: 'RATE_LIMIT_BANNED' }), {
      status: 429,
      headers: { 'x-ratelimit-reset': '9999999999' },
    })) as typeof fetch;
  try {
    const { GmgnMarketProvider } = await import('../src/providers/gmgn.js');
    const p = new GmgnMarketProvider('k');
    await assert.rejects(p.metric('ca', 'sol', 'essential'), (e: unknown) => {
      return e instanceof Error && (e as { status?: number }).status === 429;
    });
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx tsx --test test/gmgn.test.ts`
Expected: FAIL — thrown error is a plain `Error`, not one with `.status === 429`.

- [ ] **Step 3: Modify `fetchTokenInfo` in `server/src/providers/gmgn.ts`**

Replace the `BanGate` usage and the raw `throw` with the registry + `HttpError`:

```ts
import { limiters } from '../ratelimit/index.js';
import { HttpError } from '../ratelimit/types.js';
import type { Priority } from '../ratelimit/types.js';
```

Replace `metric()` and `assetInfo()` bodies so they pass a priority:

```ts
  async metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch> {
    if (kind === 'gini') return {};
    const priority: Priority = kind === 'volume' ? 2 : 1;
    const p = await this.fetchTokenInfo(ca, chain, priority);
    if (kind === 'volume') {
      return {
        volume24h: p.volume24h ?? 0,
        buyVol24h: p.buyVol24h ?? 0,
        sellVol24h: p.sellVol24h ?? 0,
        volume1h: p.volume1h ?? 0,
      };
    }
    return {
      ...(p.price !== undefined ? { price: p.price } : {}),
      ...(p.supply !== undefined ? { supply: p.supply } : {}),
      ...(p.marketCap !== undefined ? { marketCap: p.marketCap } : {}),
      ...(p.liquidity !== undefined ? { liquidity: p.liquidity } : {}),
      ...(p.holders !== undefined ? { holders: p.holders } : {}),
      ...(p.symbol !== undefined ? { symbol: p.symbol } : {}),
      ...(p.deployedAt !== undefined ? { deployedAt: p.deployedAt } : {}),
    };
  }

  async assetInfo(ca: string, chain: Chain): Promise<AssetInfo> {
    const p = await this.fetchTokenInfo(ca, chain, 0); // critical: ticker backfill
    return {
      ...(p.symbol !== undefined ? { symbol: p.symbol } : {}),
      ...(p.supply !== undefined ? { supply: p.supply } : {}),
      ...(p.price !== undefined ? { price: p.price } : {}),
    };
  }

  private async fetchTokenInfo(ca: string, chain: Chain, priority: Priority): Promise<MetricPatch> {
    return limiters.run('gmgn', { weight: GMGN_TOKEN_INFO_WEIGHT, priority }, async () => {
      const qs = new URLSearchParams({
        chain: gmgnChain(chain),
        address: ca,
        timestamp: String(Math.floor(Date.now() / 1000)),
        client_id: randomUUID(),
      });
      const res = await fetch(`${GMGN_TOKEN_INFO_URL}?${qs.toString()}`, {
        headers: { 'X-APIKEY': this.apiKey },
      });
      const json = (await res.json().catch(() => null)) as GmgnTokenInfoResponse | null;
      if (!res.ok || !json) {
        throw new HttpError(
          res.status,
          res.headers.get('x-ratelimit-reset'),
          `gmgn token/info ${res.status}: ${json?.error ?? ''} ${json?.message ?? ''}`.slice(0, 200),
        );
      }
      return parseTokenInfo(json);
    });
  }
```

Delete the now-unused `WeightBucket` and `BanGate` classes from `gmgn.ts` (they live in `ratelimit/` now) and the `private readonly bucket` / `private readonly ban` fields, and the `planWeight` constructor param (the layer owns weight). If `WeightBucket` was exported and used elsewhere, keep a re-export: `export { WeightBucket } from '../ratelimit/bucket.js';` only if a grep shows other importers.

- [ ] **Step 4: Run the tests**

Run: `cd server && npx tsc --noEmit && npx tsx --test test/gmgn.test.ts`
Expected: PASS, including the new 429→HttpError test.

- [ ] **Step 5: Deploy + verify (the key step)**

```bash
make deploy
ssh -o BatchMode=yes root@194.163.187.250 'cd /root/signal_scan && PORT=8124 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api'
```
Then after ≥10 minutes:
```bash
ssh -o BatchMode=yes root@194.163.187.250 'echo "429=$(docker logs signal_scan-api-1 2>&1 | grep -c "token/info 429")"; curl -s -m5 localhost:8124/api/health'
```
Expected: `429=0` (or a small number that the gate then freezes — never a growing flood), `healthy:true`, and `/api/health` `ratelimit.gmgn` shows sane `queued`/`gateUntil`.

- [ ] **Step 6: Checkpoint**

Record the 429 count + health JSON.

---

# Phase C — migrate Solana RPC (deploy step 3 of 6)

## Task 11: Solana routes through the layer

**Files:**
- Modify: `server/src/providers/solana.ts` (pace at `:218-224`, retry schedule `:44-49`, post loop `:229-250`)

- [ ] **Step 1: Write the failing test**

Add `server/test/ratelimit/solana-via-layer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiters } from '../../src/ratelimit/index.js';

test('registry: solana-rpc min-interval is observable in the snapshot', () => {
  const s = limiters.snapshot();
  assert.ok('solana-rpc' in s);
});
```

- [ ] **Step 2: Run to verify it passes already (smoke) then modify**

Run: `cd server && npx tsx --test test/ratelimit/solana-via-layer.test.ts`
Expected: PASS (spec exists). This test guards the registry wiring while you refactor.

- [ ] **Step 3: Modify `post()` in `server/src/providers/solana.ts`**

Wrap the fetch/parse inside `limiters.run('solana-rpc', { priority }, …)`, and replace the manual `pace()`/`retrySchedule`/`retryAfter` logic with the layer's retry by throwing `HttpError(status, retryAfterHeader, msg)`. Keep the multi-endpoint retire block (`:203-216`) unchanged, but only run it when the thrown `HttpError.status` indicates credit exhaustion. Import:

```ts
import { limiters } from '../ratelimit/index.js';
import { HttpError } from '../ratelimit/types.js';
```

Delete the `minIntervalMs` field, `pace()`, `retrySchedule()`, and `retryAfterMs` clamp; the layer owns them. If an endpoint is retired, throw a plain `Error` (not `HttpError`) so it is not retried by the layer.

- [ ] **Step 4: Run the tests**

Run: `cd server && npx tsc --noEmit && npx tsx --test test/ratelimit/solana-via-layer.test.ts test/solana.test.ts`
Expected: PASS.

- [ ] **Step 5: Deploy + verify**

```bash
make deploy
ssh -o BatchMode=yes root@194.163.187.250 'cd /root/signal_scan && PORT=8124 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api'
```
After ~10 min:
```bash
ssh -o BatchMode=yes root@194.163.187.250 'docker logs --since=10m signal_scan-api-1 2>&1 | grep -cE "solana|rpc" ; curl -s -m5 localhost:8124/api/health'
```
Expected: no RPC 429 flood; `healthy:true`.

- [ ] **Step 6: Checkpoint**

Record evidence.

**As-built deltas (Task 11):**
- `post()` throws `HttpError` for **429 only**, not `status >= 500`. The spec's `retryOn: (s) => s === 429 || s >= 500` is therefore inert for solana: a dead (5xx) endpoint must fall through to the next endpoint immediately, matching the pre-layer contract locked by `test/solana.test.ts` :72/:174 ("counts one request per call" on a dead endpoint). Retrying 5xx burned 4 attempts on the dead endpoint and failed both locks.
- Removed ctor params `minIntervalMs`/`retryDelayMs`: the 7 timing/retry tests inject them positionally, but `tsx` ignores extra args and the shared `limiters` spec (minInterval 600, retries 3) satisfies every assertion. `tsc` excludes `test`, so no type error surfaces — expected.
- `fetchOwnerAccounts` catch whitelists `HttpError` (alongside `SafeRpcError`) so the layer's rejection keeps `solana rpc 429` in the final message while still never leaking the endpoint/token.
- Verified: `tsc` exit 0; `test/ratelimit/solana-via-layer.test.ts` + `test/solana.test.ts` = 22/22; full `npm test` = 258/256/fail 2. Deployed step 3/6 (api restarted 13:24:32Z): health `solana-rpc` queued:1 (layer routing live), 429=0, `healthy:true`.

---

# Phase D — migrate Nansen credit + add 403 quota cooldown (deploy step 4 of 6)

## Task 12: Nansen credit routes through the layer

**Files:**
- Modify: `server/src/providers/nansen.ts` (fibo `:330-339`, retryable `:351-354`, post loop `:363-378`)

- [ ] **Step 1: Write the failing test**

Add to `server/test/ratelimit/limiter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it passes (gate already implemented) — this locks the requirement**

Run: `cd server && npx tsx --test test/ratelimit/limiter.test.ts`
Expected: PASS.

- [ ] **Step 3: Modify `postJson()` in `server/src/providers/nansen.ts`**

Wrap the POST in `limiters.run('nansen-credit', { priority: 1 }, …)`; delete `fiboDelayMs`/`isRetryable`/the local retry loop and instead throw `HttpError(status, null, msg)` for every non-ok response. Import:

```ts
import { limiters } from '../ratelimit/index.js';
import { HttpError } from '../ratelimit/types.js';
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx tsc --noEmit && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 2` (pre-existing only).

- [ ] **Step 5: Deploy + verify**

```bash
make deploy
ssh -o BatchMode=yes root@194.163.187.250 'cd /root/signal_scan && PORT=8124 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api'
```
After ~10 min:
```bash
ssh -o BatchMode=yes root@194.163.187.250 'echo "403=$(docker logs --since=10m signal_scan-api-1 2>&1 | grep -c "403: Insufficient")"; curl -s -m5 localhost:8124/api/health'
```
Expected: `403` count is **≤ a few** (the gate suppresses the repeat flood), `healthy:true`, and `ratelimit.nansen-credit.gateUntil > 0` while credits are out.

- [ ] **Step 6: Checkpoint**

Record before/after 403 counts. This is the direct fix for the credits flood.

**As-built deltas (Task 12):**
- The plan's "modify `postJson()`" is a naming slip: the retry/concurrency target is `NansenApiClient.post()` (the credit door). `postJson` belongs to the separate `NansenWebCrawler` injected seam and is untouched.
- `fiboDelayMs` is **KEPT** (exported, locked by `test/nansen.test.ts :5` — the only fibo coverage). The plan's "delete fiboDelayMs" would break that test for no behavioral gain. `isRetryable`, `sleep`, and the `NansenApiError` class ARE deleted.
- `postOnce` now throws `HttpError(res.status, null, msg)` instead of `NansenApiError` (message format verbatim). `NansenApiError` had exactly one throw site and zero `instanceof` checks → safe swap.
- The layer only retries `HttpError`, but the old `isRetryable` also retried status-less transport/parse failures. To preserve that resilience, `post()` converts a non-`HttpError` throw into `HttpError(503, null, e.name)` so it stays retryable; the raw error (which can echo the URL) never escapes.
- `config` import dropped from `nansen.ts` (only the deleted loop used it).
- Verified: `tsc` exit 0; `test/ratelimit/limiter.test.ts` + `test/nansen.test.ts` = 31/31; full `npm test` = 258/256/fail 2.

---

# Phase E — migrate Nansen door aggregate rate (deploy step 5 of 6)

## Task 13: DoorPool aggregate cap + path budget via the layer

**Files:**
- Modify: `server/src/crawl.ts` (cap check `:418`, pathBudget `:419`)

- [ ] **Step 1: Write the failing test**

Add `server/test/ratelimit/door-via-layer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiters } from '../../src/ratelimit/index.js';

test('registry: nansen-door window spec is present', () => {
  assert.ok('nansen-door' in limiters.snapshot());
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx tsx --test test/ratelimit/door-via-layer.test.ts`
Expected: PASS.

- [ ] **Step 3: Modify `crawl.ts`**

In `DoorPool.dispatch` (around `:411-429`), replace the manual `doorCapPerMin` / `pathBudget` arithmetic with a call that routes the *acquire* through the layer:

```ts
import { limiters } from './ratelimit/index.js';
```
- Keep `DoorPool`'s per-door state, least-outstanding routing, quarantine, and penalized ladder.
- Before handing out a door, gate the dispatch slot with `limiters.run('nansen-door', { priority: 2, path }, async () => {})` — i.e. awaiting the aggregate window/path budget. Remove the local `budgetUsed`/`hits` counting that duplicates it.
- Per-door quarantine and the backoff ladder remain untouched.

- [ ] **Step 4: Run the tests**

Run: `cd server && npx tsc --noEmit && npx tsx --test test/ratelimit/door-via-layer.test.ts test/door-pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Deploy + verify**

```bash
make deploy
ssh -o BatchMode=yes root@194.163.187.250 'cd /root/signal_scan && PORT=8124 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api'
```
After ~10 min:
```bash
ssh -o BatchMode=yes root@194.163.187.250 'docker logs --since=10m signal_scan-api-1 2>&1 | grep -c "429\|blocked" ; curl -s -m5 localhost:8124/api/health'
```
Expected: no door 429 flood; `healthy:true`; `ratelimit.nansen-door.windowUsed` ≤ 40.

- [ ] **Step 6: Checkpoint**

Record evidence.

**As-built deltas (Task 13) — NOT MIGRATED (frozen-contract conflict):**
- `crawl.ts` is left UNCHANGED. The local D6 budget (`Door.hits` sliding window, `crawlDoorCapPerMin=40`/door, `crawlPathBudget=30`/door+path, window 60s) already enforces exactly the cap this task wanted the layer to provide.
- Blocker: `test/door-pool.test.ts` is a FROZEN CONTRACT ("TURN this file GREEN WITHOUT editing it") driven by a purely INJECTED fake clock (`deps.now`/`deps.sleep`, lines 145-146); it does NOT patch global `Date.now`. The layer's `Window` uses `ratelimit/limiter.ts`'s module-level real `CLOCK`. Routing the acquire through `limiters.run('nansen-door', …)` makes :246/:274 fire 30-41 requests in real-time ms, filling the layer's real-clock window; the 31st/41st would then block on a real 60s timer the virtual clock cannot advance → both assertions fail. No implementation satisfies (unmodified frozen tests) + (layer owns the budget) simultaneously.
- Delivered: the `nansen-door` spec remains defined and visible in the health snapshot; `test/ratelimit/door-via-layer.test.ts` guards that wiring. Wiring an AGGREGATE-only gate (no `path`, window max = sum of per-door caps) is possible only behind a `doors.length > 1` guard and would still need a real-clock-safe test path — deferred pending user decision.

---

# Phase F — migrate DexScreener (deploy step 6 of 6)

## Task 14: DexScreener routes through the layer

**Files:**
- Modify: `server/src/providers/dexscreener.ts` (sequential loop `:113-133`)

- [ ] **Step 1: Write the failing test**

Add `server/test/ratelimit/dexscreener-via-layer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limiters } from '../../src/ratelimit/index.js';

test('registry: dexscreener window spec is present (was unbounded)', () => {
  assert.ok('dexscreener' in limiters.snapshot());
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx tsx --test test/ratelimit/dexscreener-via-layer.test.ts`
Expected: PASS.

- [ ] **Step 3: Modify `dexscreener.ts`**

Wrap each chunk request in `limiters.run('dexscreener', { priority: 2 }, …)`; the function already never throws, keep that.

```ts
import { limiters } from '../ratelimit/index.js';
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx tsc --noEmit && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 2` (pre-existing only).

- [ ] **Step 5: Deploy + verify (optional — free API, low risk)**

```bash
make deploy
ssh -o BatchMode=yes root@194.163.187.250 'cd /root/signal_scan && PORT=8124 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api'
```

- [ ] **Step 6: Checkpoint**

Record evidence.

**As-built deltas (Task 14):**
- `fetchIcons` wraps each chunk fetch in `limiters.run('dexscreener', { priority: 2 }, () => fetch(…))`; the sequential loop and the never-throws contract are unchanged. No dexscreener tests exist, so nothing regressed.
- Verified: `tsc` exit 0; `test/ratelimit/dexscreener-via-layer.test.ts` passes; full `npm test` = `fail 2`.

---

## Task 15: Final integration test + spec self-review

**Files:**
- Test: `server/test/ratelimit/integration.test.ts`

- [ ] **Step 1: Write the never-exceed proof**

```ts
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
```

- [ ] **Step 2: Run it**

Run: `cd server && npx tsx --test test/ratelimit/integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite**

Run: `cd server && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 2` (pre-existing signals only).

- [ ] **Step 4: Spec coverage self-review**

Walk `docs/superpowers/specs/2026-09-26-rate-control-design.md` §2 Goals 1-7 and §7 steps 1-6; confirm each maps to a Task above. Fix any gap inline.

**As-built deltas (Task 15) — self-review result:**
- GAP FOUND & FIXED: `npm test` was `tsx --test test/*.test.ts`, which EXCLUDES `test/ratelimit/` — all 22 layer tests were invisible to the default suite and to CI. Changed `server/package.json` to `tsx --test test/*.test.ts test/ratelimit/*.test.ts`. Suite is now 280 tests / 278 pass / `fail 2` (the pre-existing signals-only failures).
- Coverage of spec §2 Goals: G1-4 (per-API queues/constraints) → Tasks 1-8; G5 (priority+aging) → Task 8; G6 (gate incl. 403 cooldown) → Tasks 6/12; G7 (observability/health) → Task 9. §7 steps 1-6 → Tasks 9,10,11,12,13,14, with step 5 (door) DEMOTED (local D6 already covers it — see Task 13 deltas).
- Deviation summary (all test-preserving, all recorded inline above): T10 gmgn (as-built), T11 solana (429-only layer retry), T12 nansen (`fiboDelayMs` kept; transport→503), T13 door (NOT migrated — frozen-contract conflict), T14 dexscreener (as-planned).

---

## Self-review (author)

- **Spec coverage:** Goals 1-7 → Tasks 8/10-14 (registry), 2/3/4/5 (constraints), 8 (priority+aging), 6 (gate incl. 403), 8 (retry), 7 (config), 9 (observability). §7 steps 1-6 → Tasks 9,10,11,12,13,14. Covered.
- **Placeholders:** none — every code step has full code; the only "?" is DexScreener's `max` default (60), decided in `spec.ts` and flagged tunable by measurement.
- **Type consistency:** `Constraint.readyAt(now, opts)` / `onStart(now, opts)` used identically in `bucket`/`window`/`min-interval`; `Limiter.run(opts, fn)` / `snapshot()` match `types.ts`; `HttpError(status, header, message)` used identically in Tasks 10/11/12; `resolveNum` / `buildSpecs(gmgnPlanWeight)` match between Task 7 and `index.ts`.
- **VCS:** no git in repo → Checkpoint steps instead of commits.
