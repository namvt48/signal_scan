# Rate-control layer — design

**Status:** approved (approach 2) · 2026-09-26
**Owner:** namvt
**Trigger:** GMGN IP-ban (`429 RATE_LIMIT_BANNED`) + Nansen `403 Insufficient credits` — both are rate/quota control done four different bespoke ways. Goal: one configurable, per-API queue + filter that provably never exceeds any upstream limit.

> Note: this directory is **not a git repo**, so this spec is written but not committed.

---

## 1. Problem

Outbound calls to five upstreams are throttled by **four unrelated mechanisms**, none reusable, none sharing a config surface:

| Upstream | Current mechanism | File | Knob | Default |
|---|---|---|---|---|
| GMGN `openapi.gmgn.ai` | `WeightBucket` token bucket + `BanGate` (429 `x-ratelimit-reset`) | `providers/gmgn.ts:129-186` | `GMGN_PLAN_WEIGHT` | 5 (prod 3) |
| Solana JSON-RPC | min-interval FIFO + exp 429 backoff + endpoint retire | `providers/solana.ts:203-250` | `SOLANA_RPC_MIN_INTERVAL_MS` / `_MAX_RETRIES` / `_RETIRE_MS` | 600 / 3 / 3600000 |
| Nansen browser door | `DoorPool` sliding-window per-door(40/min) + per-path(30) + quarantine | `crawl.ts:411-489` | `CRAWL_DOOR_CAP_PER_MIN` / `CRAWL_PATH_BUDGET` / `CRAWL_BUDGET_WINDOW_MS` | 40 / 30 / 60000 |
| Nansen credit `api.nansen.ai` | **none** (fibonacci retry only) | `providers/nansen.ts:330-378` | `NANSEN_RETRIES` / `_RETRY_BASE_MS` | 6 / 1000 |
| DexScreener | **none** (sequential, never throws) | `providers/dexscreener.ts:113-133` | — | — |

Consequences observed in prod:
- GMGN ban never lapses because every poll during the ban **renews** the rolling window (`x-ratelimit-reset` = violation + 300 s). Fixed short-term by `BanGate` + widened cadence.
- Nansen credit `403 Insufficient credits` floods the log (no quota gate).
- No **concurrency cap** anywhere — unbounded `Promise.all` bursts at `providers/composite.ts:34`, `providers/nansen.ts:267,638`.
- No generic **queue** abstraction; no rate-limit library (`package.json` has no `p-limit`/`p-queue`/`bottleneck`).

## 2. Goals / non-goals

**Goals**
1. One layer every outbound call routes through: `registry.run(api, opts, fn)`.
2. Per-API, **composable** constraints: weight token-bucket · sliding window (max N / windowMs) · min-interval · max-concurrency.
3. Per-API **priority queues** with anti-starvation, so a bulk sweep can't starve a critical call.
4. **Gates** generalised: 429 (reset-header or cooldown) **and** quota (403/402 → cooldown).
5. **Retry** owned by the layer, re-enqueued so backoff respects the rate.
6. All **configurable** via one typed declared config file + env override.
7. Observability: per-API `{inFlight, queued, gateUntil, windowUsed}` in `/api/health`.

**Non-goals (YAGNI)**
- No distributed/persistent limits (single process only).
- No worker pool / per-endpoint queues beyond the priority levels.
- No runtime editing via dashboard (change config + restart).
- No inbound (client → server) rate limiting.
- No change to `pacedFor` sweep-level scheduling (`poller.ts:62-71`) — it stays.

## 3. Architecture

New module `server/src/ratelimit/`:

| File | Responsibility |
|---|---|
| `types.ts` | `Priority`, `ApiLimitSpec`, `RunOpts`, `Limiter`, `Registry` |
| `bucket.ts` | token bucket (moved from `WeightBucket`) |
| `window.ts` | sliding-window counter (+ per-path variant) |
| `semaphore.ts` | max-concurrency gate |
| `gate.ts` | 429/403 ban + quota gate (generalises `BanGate`) |
| `limiter.ts` | composes constraints + priority queue + scheduler + retry |
| `registry.ts` | `name → Limiter`; `run(api, opts, fn)`; `snapshot()` |
| `spec.ts` | declared per-API config + env override + validation |
| `index.ts` | build singleton registry from `spec.ts` |

### 3.1 Types

```ts
export type Priority = 0 | 1 | 2; // 0=critical, 1=normal, 2=bulk

export interface BucketSpec { capacity: number; refillPerSec: number; defaultWeight: number }
export interface WindowSpec { max: number; windowMs: number }
export interface GateSpec {
  statuses: number[];                                        // e.g. [429]
  header?: string;                                           // e.g. 'x-ratelimit-reset'
  statusesWithCooldown?: { status: number; cooldownMs: number }[]; // e.g. {403, 600000}
}
export interface RetrySpec {
  retries: number;
  backoff: 'fibo' | 'exp';
  baseMs: number;
  capMs?: number;                                            // clamp for 'exp'
  retryOn: (status: number) => boolean;
}
export interface ApiLimitSpec {
  weightBucket?: BucketSpec;
  window?: WindowSpec;
  pathWindow?: WindowSpec;     // nansen-door per-path
  minIntervalMs?: number;
  maxConcurrency?: number;
  gate?: GateSpec;
  retry?: RetrySpec;
  priorityAgingMs?: number;    // anti-starvation; default 30_000
}

export interface RunOpts { weight?: number; priority?: Priority; path?: string }

export interface Limiter {
  run<T>(opts: RunOpts, fn: () => Promise<T>): Promise<T>;
  snapshot(): { inFlight: number; queued: number; gateUntil: number; windowUsed: number };
}
export interface Registry {
  run<T>(api: string, opts: RunOpts, fn: () => Promise<T>): Promise<T>;
  snapshot(): Record<string, ReturnType<Limiter['snapshot']>>;
}
```

### 3.2 Scheduler (per limiter)

- A job is pushed into the queue for its `priority`.
- Drain loop: pick the **highest-priority non-empty** queue; within it FIFO.
- Anti-starvation: a job whose `now - enqueuedAt > priorityAgingMs` is promoted one level.
- For the head job compute `readyAt = max(bucketReady, windowReady, intervalReady)`; when `now >= readyAt` **and** a semaphore slot is free → dequeue, acquire slot, run `fn`, release in `finally`, record outcome, continue.
- Otherwise arm a timer for the earliest `readyAt` (and re-drain on semaphore release).
- **Gate closed** (`now < gateUntil`): `run` rejects immediately with a **constant** message (log-dedupe friendly; see §5).

### 3.3 Constraint maths

- **bucket** (reuse `WeightBucket`): `readyAt = last + (need - tokens)/refillPerSec` (clamped to capacity).
- **window**: ring buffer of timestamps; `readyAt = count < max ? now : oldest + windowMs`.
- **minInterval**: `readyAt = lastStartAt + minIntervalMs`.
- **semaphore**: slot count; `inFlight < maxConcurrency`.
- Combined `readyAt` = max of all enabled constraints.

### 3.4 Gate

Generalises `providers/gmgn.ts` `BanGate`:
- `statuses` + `header`: on that status read the header (unix seconds) → `gateUntil = reset*1000 + marginMs` (margin 2000).
- `statusesWithCooldown`: on that status → `gateUntil = now + cooldownMs`.
- Renewal semantics preserved: a further matching response pushes `gateUntil` out.

### 3.5 Retry

Owned by the layer; on a retryable failure the job is **re-enqueued** through the limiter (so the backoff waits behind the rate limits rather than sleeping inline inside a slot — today `poller.ts:204-216` `withRetry` sleeps 3 s *inside* the sweep slot).
- `fibo`: delay = fibo(n) × baseMs (matches Nansen today: `nansen.ts:330-339`).
- `exp`: delay = min(capMs, baseMs × 2^n) (matches Solana today: `solana.ts:44-49`).

## 4. Config (`ratelimit.config.ts` + env override)

Declared in TS so a misconfigured field is a **compile error**. Each numeric/boolean field is overridable by env `RL_<API>_<FIELD>` (API and field upper-snake), resolved with the same `num/posNum` guards as `src/config.ts`.

```ts
export const API_LIMITS: Record<string, ApiLimitSpec> = {
  gmgn: {
    weightBucket: { capacity: /*RL_GMGN_CAPACITY*/ 3, refillPerSec: 3, defaultWeight: 1 },
    gate: { statuses: [429], header: 'x-ratelimit-reset' },
    priorityAgingMs: 30_000,
    // intentionally no retry: GMGN relies on the next scheduled sweep (gmgn.ts:22-24)
  },
  'solana-rpc': {
    minIntervalMs: /*RL_SOLANA_RPC_MININTERVALMS*/ 600,
    gate: { statuses: [429] },
    retry: { retries: 3, backoff: 'exp', baseMs: 400, capMs: 2000, retryOn: (s) => s === 429 || s >= 500 },
  },
  'nansen-credit': {
    maxConcurrency: /*RL_NANSEN_CREDIT_MAXCONCURRENCY*/ 2,
    gate: { statuses: [429], statusesWithCooldown: [{ status: 403, cooldownMs: /*RL_NANSEN_CREDIT_403COOLDOWNMS*/ 600_000 }] },
    retry: { retries: 6, backoff: 'fibo', baseMs: 1000, retryOn: (s) => s === 429 || s >= 500 },
  },
  'nansen-door': {
    window: { max: /*RL_NANSEN_DOOR_MAX*/ 40, windowMs: 60_000 },
    pathWindow: { max: 30, windowMs: 60_000 },
    maxConcurrency: /* set at build = door pool size */,
  },
  dexscreener: {
    window: { max: /*RL_DEXSCREENER_MAX*/ 60, windowMs: 60_000 }, // was: no limit
  },
};
```

`gmgn` capacity should track `GMGN_PLAN_WEIGHT` so there is one source of truth after migration (`spec.ts` reads `config.gmgnPlanWeight` as the default).

## 5. Error handling

- Constraints **never throw** — they wait.
- Gate closed → reject with a **constant** message, e.g. `gmgn ip banned until <ISO>` / `nansen-credit quota cooling until <ISO>`; the ISO is fixed for the life of one gate window so `log.ts` dedupe folds the storm into one line (same technique already shipped in `gmgn.ts`).
- Retry exhausted → rethrow the last error.
- Unknown `api` name passed to `registry.run` → throw at call time (programmer error).

## 6. Observability

`registry.snapshot()` merged into `/api/health` (alongside `doors`) and/or a `/api/ratelimit` route:

```json
{ "ratelimit": { "gmgn": { "inFlight": 1, "queued": 3, "gateUntil": 0, "windowUsed": 0 } } }
```

## 7. Integration / migration (stepwise; each step its own deploy + evidence)

1. **Add module + unit tests.** No call-site change. Wire the registry at startup (`src/index.ts:29-46`) but leave unused. Verify: tests green, app boots.
2. **GMGN** (`providers/gmgn.ts`): replace `bucket.take()` (`:247`) + `BanGate` (`:169-186`) with `registry.run('gmgn', {weight:1, priority}, …)`; move `WeightBucket`/`BanGate` into `ratelimit/`. Priorities: `kickToken`/`symbolBackfill` = 0 (critical), `essential` = 1 (normal), `volume` = 2 (bulk). Verify: `token/info 429 = 0` over ≥30 min, `/api/health` healthy.
3. **Solana** (`providers/solana.ts`): `pace()` + 429 exp backoff + `retry-after` cap → `run('solana-rpc')`. Keep multi-endpoint retire (`:203-216`) in the provider (it is endpoint state, not aggregate rate).
4. **Nansen credit** (`providers/nansen.ts` `postJson` `:363-378`): wrap with `run('nansen-credit')`; fibonacci retry moves to `RetrySpec`; adds the **403 quota cooldown** that is missing today. Verify: `403` errors collapse (cooldown) rather than flood.
5. **Nansen door** (`crawl.ts`): the aggregate `doorCapPerMin` (`:418`) + `pathBudget` (`:419`) checks call the layer's `window`/`pathWindow`; `DoorPool` keeps proxy/state/least-outstanding/quarantine. Per-door quarantine stays in `DoorPool`.
6. **DexScreener**: wrap the sequential chunk loop (`:113-133`) with `run('dexscreener', {priority:2})`.

`pacedFor` (`poller.ts:62-71`) is untouched. `withRetry` (`poller.ts:204-216`) is replaced by the layer retry in step 4 (essential sweep already goes through Nansen/GMGN paths).

## 8. Testing

**Unit (pure, injected clock — same seam as the current `WeightBucket` test):**
- `bucket`: spend/refill/clamp (migrate existing `WeightBucket` case).
- `window`: allows up to `max`; the `max+1`-th waits exactly until `oldest + windowMs`.
- `semaphore`: never more than `maxConcurrency` in flight; releases in `finally` on throw.
- `minInterval`: `n`-th start is `(n-1)×minIntervalMs` after the first.
- `priority`: higher runs first; a bulk job older than `priorityAgingMs` gets promoted (no starvation).
- `gate`: 429+reset arms and renews; 403 cooldown arms; non-listed status ignored; blocked message is constant.
- `retry`: `fibo`/`exp` delay schedules; re-enqueue is rate-respecting.
- `spec`: env override wins over default; invalid value falls back to default (never throws).

**Integration:** a fake `fn` that records call timestamps + in-flight count; assert over a simulated minute that observed calls **never exceed** `window.max` and in-flight never exceeds `maxConcurrency` for a composed spec.

## 9. Rollout & verification

- Deploy per step via the existing `make deploy` (+ `docker compose up -d --force-recreate api` when `.env` changes). Prod is `root@194.163.187.250:/root/signal_scan`, instance a, port 8124.
- Evidence per step: build exit 0 + test counts + a log window proving the target metric (429=0 / 403 collapsed / never-exceed) + `/api/health`.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Refactor touches the hot poller path | Stepwise, one API per deploy, old code kept until the step is verified |
| Semaphore leak (fn never releases) | `try/finally` release; unit test that asserts release on throw |
| Priority starvation | `priorityAgingMs` promotion + test |
| Behaviour drift vs today's numbers | Keep today's defaults identical in `API_LIMITS`; one source of truth for `plannedWeight` |
| Log noise returns if gate message varies | Gate error message must be constant per window (test asserts) |

## 11. Open questions / assumptions

- **Config form:** declared TS file + env override — assumed approved (recommended in review).
- `priorityAgingMs` default 30_000 — confirm.
- GMGN keeps **no retry** (relies on next sweep) — confirm.
- Single-process only (no persistence) — confirmed as non-goal.
- DexScreener default `max` (proposed 60/60 s) is a guess — tune after measuring.

**Out of scope:** inbound rate limiting; distributed limits; runtime config editing; per-endpoint (vs per-API) queues; observability dashboards beyond the health snapshot.
