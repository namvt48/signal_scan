# Task 9 — DexScreener endpoint with per-class windows

Plan: `.omo/plans/request-plane-gateway.md` (todo 9).
Scope: NEW `server/src/gateway/dexscreener.ts` + surgical `server/src/gateway/app.ts` route wiring + `server/src/ratelimit/spec.ts` class split + NEW `server/test/gateway/dexscreener.test.ts`. No commit.

## Files created / modified

- **NEW** `server/src/gateway/dexscreener.ts` — the `POST /v1/dexscreener` route. The request body is `{endpoint, params?, priority?}`; the limiter key is picked from the endpoint CLASS:
  - `tokens | pairs | search` → `dexscreener` (300/min)
  - `profiles | boosts` → `dexscreener-profiles` (60/min)
  It returns the RAW upstream body through the shared `proxyRequest` contract (200 envelope). `dexScreenerUpstream()` is the real keyless fetcher (DexScreener needs no credentials).
- **MODIFIED** `server/src/gateway/app.ts` (surgical, additive) — added `dexUpstream?: UpstreamFetch` to `GatewayAppDeps` and registered `POST /v1/dexscreener` behind `requireCaller`, mirroring the gmgn route. Nothing else touched.
- **MODIFIED** `server/src/ratelimit/spec.ts` — the `dexscreener` key's window default became **300/min** (was 60/min, which wrongly throttled token lookups) and a NEW **`dexscreener-profiles`** key at **60/min** was added. Both env-tunable (`RL_DEXSCREENER_MAX`, `RL_DEXSCREENER_PROFILES_MAX`). The literal `dexscreener` key name is KEPT (todo 9 pin); two keys are required because a `Limiter` holds exactly one `window` (`limiter.ts:44`).
- **NEW** `server/test/gateway/dexscreener.test.ts` — 9 tests covering the plan acceptance criteria.

No writes to `gmgn.ts` / `nansen` / `contract.ts` / `auth.ts` / `main.ts` / `door.ts` / providers / config / index / poller / `crawl.ts`. No commit.

## 1. `cd server && npx tsc --noEmit`

Command:
```
cd server && npx tsc --noEmit
```
Output (verbatim; empty = clean):
```

```
Exit status: `0`
```
TSC_EXIT=0
```

## 2. New spec, isolated (`npx tsx --test test/gateway/dexscreener.test.ts`) — 9/9 green

Command:
```
cd server && npx tsx --test test/gateway/dexscreener.test.ts
```
Output (verbatim):
```
✔ parseDexScreener validates endpoint / params / priority at the trust boundary (2.211433ms)
2026-09-30T10:02:27.015Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=16
2026-09-30T10:02:27.029Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=2
2026-09-30T10:02:27.033Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=1
✔ (a) a pairs/tokens/search endpoint picks the `dexscreener` limiter (300/min class) (70.4381ms)
2026-09-30T10:02:27.044Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=1
2026-09-30T10:02:27.048Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=1
✔ (b) a profiles/boosts endpoint picks the `dexscreener-profiles` limiter (60/min class) (14.494527ms)
2026-09-30T10:02:27.054Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=1
✔ (c) the raw upstream body is returned byte-identical over the HTTP route (6.265441ms)
✔ (d) the windows are class-correct and the literal `dexscreener` key survives (1.177623ms)
✔ each class throttles at its own window: 300 pass / #301 waits; 60 pass / #61 waits (71.60343ms)
2026-09-30T10:02:27.132Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=1
✔ an upstream 500 surfaces as envelope status:500 with a null body (no swallow) (5.406516ms)
✔ the real fetcher builds the tokens URL and returns the raw body (1.223466ms)
2026-09-30T10:02:27.140Z INFO  [gateway] method=POST path=/dexscreener status=401 dur=0
2026-09-30T10:02:27.144Z INFO  [gateway] method=POST path=/v1/dexscreener status=400 dur=1
✔ the route is caller-gated and rejects a bad endpoint without calling upstream (10.549044ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 953.536356
```
Exit status: `0` (`STANDALONE_EXIT=0`).

## 3. Boundary observables: 300/#301 and 60/#61 (verbatim, deterministic fake clock)

The burst test drives the REAL `Limiter` over an injected fake clock, so the
window waits are observed without waiting a real minute. A temporary script
(removed after capture) printed the concrete counts:

```
standard 300/min: 300/300 → HTTP 200, upstream calls=300, elapsed=5ms
standard: #301 settled before window rolls? false (upstream calls still 300)
standard: #301 settled after +60s clock roll? true (status=200, upstream calls=301)
profiles 60/min: 60/60 → HTTP 200, upstream calls=361
profiles: #61 settled before window rolls? false (upstream calls still 361)
profiles: #61 settled after +60s clock roll? true (status=200, upstream calls=362)
```

## 4. The two unchanged specs still pass

Command:
```
cd server && npx tsx --test test/ratelimit/spec.test.ts test/ratelimit/dexscreener-via-layer.test.ts
```
Output (verbatim):
```
✔ registry: dexscreener window spec is present (was unbounded) (1.212318ms)
✔ resolveNum: env override wins, invalid falls back to default (1.146338ms)
✔ buildSpecs: every external API is present with a shape (0.511723ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 185.758227
```
Exit status: `0` (`UNCHANGED_EXIT=0`).

`spec.test.ts:16` requires the literal `dexscreener` spec and
`dexscreener-via-layer.test.ts:6` requires `'dexscreener' in limiters.snapshot()`
— both pass UNCHANGED because the `dexscreener` key name was kept (only its
window default changed, from 60/min to 300/min; neither spec asserts a 60
default). The new `dexscreener-profiles` key is asserted separately in the new spec.

## 5. Full suite (`cd server && npm test`) — 478/478 green (was 469; +9)

Command:
```
cd server && npm test
```
Tail (verbatim):
```
✔ zeroScoreGate: deletes the same 0/3 CA once its wallet has dumped the position (3.102381ms)
ℹ tests 478
ℹ suites 0
ℹ pass 478
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31390.253646
```
Exit status: `0` (`NPMTEST_EXIT=0`).

## Mapping acceptance criteria → observable

| Acceptance criterion | Test | Binary observable |
|---|---|---|
| (a) tokens-class burst of 300 passes immediately, #301 waits | `each class throttles…` | 300 concurrent `tokens` calls → all HTTP 200, upstream calls=300; #301 `settled=false` after 30ms, `settled=true` (status 200) after the +60s clock roll, calls=301. |
| (b) profiles-class burst of 60 passes, #61 waits | `each class throttles…` | 60 concurrent `profiles` calls → all HTTP 200, calls=361; #61 `settled=false` after 30ms, `settled=true` after the roll, calls=362. |
| (c) the raw body is returned | `(c) …byte-identical…` + `dexScreenerUpstream` | HTTP 200 envelope `{status:200, body:<raw string>, headers:{content-type}}` — `env.body === raw`; real fetcher returns the exact upstream text. |
| (d) the literal `dexscreener` key still exists in `limiters.snapshot()` | `(d) …literal `dexscreener` key survives` + `dexscreener-via-layer.test.ts` | `'dexscreener' in limiters.snapshot()` true; `'dexscreener-profiles'` present; default windows 300 and 60; env overrides 321 / 17. |
| class is picked by endpoint | `(a)` / `(b)` | recorded limiter `api`: `tokens|pairs|search → 'dexscreener'`; `profiles|boosts → 'dexscreener-profiles'`; `opts.path` = endpoint name. |
| upstream error propagates | `upstream 500…` | HTTP 200 envelope `status:500`, `body:null` (not swallowed). |
| trust boundary | `parseDexScreener…` + auth test | unknown endpoint / bad params / bad priority → HTTP 400; no token → HTTP 401; 0 upstream + 0 limiter calls. |

## 6. `spec.ts` after the edit (verbatim)

```ts
    // DexScreener meters TWO endpoint classes at different rates, and a
    // `Limiter` holds a single `window` (`limiter.ts:44`), so each class needs
    // its own key (todo 9 pin):
    //   pairs/tokens/search → `dexscreener`          300/min
    //   profiles/boosts     → `dexscreener-profiles`  60/min
    // The `dexscreener` key name is KEPT (its window is the standard class).
    // Both windows stay env-tunable.
    dexscreener: {
      window: { max: resolveNum('RL_DEXSCREENER_MAX', 300), windowMs: 60_000 },
    },
    'dexscreener-profiles': {
      window: { max: resolveNum('RL_DEXSCREENER_PROFILES_MAX', 60), windowMs: 60_000 },
    },
```

## 7. Git status (no commit)

```
$ git status --porcelain -- server/
 M server/src/gateway/app.ts
 M server/src/ratelimit/spec.ts
?? server/src/gateway/dexscreener.ts
?? server/test/gateway/dexscreener.test.ts
```

Deviation/blocker: none. `npx tsc --noEmit` typechecks `src` only (tsconfig
excludes `test`), so the new spec is exercised via `tsx --test` (shown above).
The temporary boundary script was deleted after capture (`ls` confirms absent).
The `dexscreener` key name and its 300/min window satisfy the pinned mapping;
`gmgn` / `nansen` / `contract` / `auth` / `main` / `door` / providers / config /
index / poller / `crawl.ts` are untouched.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-9-request-plane-gateway.md
