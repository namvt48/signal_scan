# Task 10 — Relocate the DoorPool + door-stats endpoint (single authority)

Plan: `.omo/plans/request-plane-gateway.md` block `- [ ] 10.`
Branch: direct mode, repo `/home/namvt/Desktop/dev-space/signal_scan`, `server/`.

## Files created / modified

- NEW `server/src/gateway/door.ts` — DB-free relocation of `DoorPool`, `browserPostJson`, the browserless transport (`realConnect`/`inPageFetch`/`withTimeout`/`doorWsEndpoint`/`UA`/`TOKEN_GOD_MODE`), the ipify egress-IP probe, and the lazy pool singleton (`getPool`/`poolSingleton`/`setPoolForTest`/`poolStatsOrNull`). Imports: `node:fs`, `puppeteer-core`, `../config.js`, `../log.js` — no db, no sqlite.
- MOD `server/src/crawl.ts` — kept the DB-backed helpers (`BalancePoint`, `createCircuitBreaker`, `hourlyStatsToPoints`, `nansenSeries`, `balanceSeries`) and became a back-compat re-export shim (values via `export { ... }`, types via `export type { ... }`); added the local `import { browserPostJson } from './gateway/door.js'` so `nansenSeries` has a real binding. Import direction is one-way: crawl → door, no cycle.
- MOD `server/src/gateway/app.ts` — `/health` `doors: null` hook replaced with the relocated pool's `poolStatsOrNull()`; added `import { poolStatsOrNull } from './door.js'`; comment updated (no code-arch change).
- MOD `server/src/api.ts` — removed `import { poolStatsOrNull } from './crawl.js'`; `/api/health` now reads the gateway `/health` door table fail-open and STRIPS `egressIp` + proxy strings.
- NEW `server/test/gateway/door.test.ts` — 6 tests (a/b/c, DB-free grep, api feed+strip, api degrade).

## Command 1 — typecheck

```
$ cd server && npx tsc --noEmit; echo "tsc exit=$?"
tsc exit=0
```

## Command 2 — new door spec

```
$ cd server && npx tsx --test test/gateway/door.test.ts; echo "door.test exit=$?"
✔ (a) a door call is counted against the path + door budget (9.129266ms)
✔ (b) a quarantined door is skipped with a clear 503, no stuck wait (2.232835ms)
2026-09-30T09:47:18.933Z INFO  [gateway] method=GET path=/health status=200 dur=6
✔ (c) the gateway /health reports the relocated pool stats (39.107199ms)
✔ door.ts is DB-free (no db / better-sqlite3 import) (0.795297ms)
✔ instance a's /api/health door table is fed from the gateway, egressIp/proxy stripped (18.348287ms)
2026-09-30T09:47:18.968Z WARN  [api] gateway /health unreachable — doors degraded err=TypeError:fetch failed
✔ instance a /api/health degrades to doors:null when the gateway is down (never 500) (7.564838ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 922.192707
door.test exit=0
```

## Command 3 — full suite (`npm test`)

```
$ cd server && npm test > /tmp/omo_task10_npmtest.log 2>&1; echo "npm test exit=$?"
npm test exit=0
...
ℹ tests 462
ℹ suites 0
ℹ pass 462
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30700.532026
```

(`npm test` script globs `test/gateway/*.test.ts`, so `door.test.ts` was executed.)

## Command 4 — the 9 existing DoorPool-importing tests, run together (shim holds)

Files: `test/door-pool.test.ts test/setup-http-e2e.test.ts test/setup-early-kick.test.ts test/setup-rehydrate.test.ts test/setup-field-ttl.test.ts test/lf-write-once.test.ts test/setup-pass-cap.test.ts test/setup-sweep-prune.test.ts test/setup-retry-until-complete.test.ts`

```
$ cd server && npx tsx --test <the 9 files above> > /tmp/omo_task10_nine.log 2>&1; echo "9-door-tests exit=$?"
9-door-tests exit=0
...
ℹ tests 52
ℹ suites 0
ℹ pass 52
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2057.810826
```

None of those 9 files were edited (git diff shows only the 5 files listed above; see Command 6).

## DB-free assertion (raw grep + the test)

```
$ cd server && grep -nE "db\.js|better-sqlite3" src/gateway/door.ts; echo "grep-exit=$?"
grep-exit=1 (1 = no match, expected)
```

The test `door.ts is DB-free (no db / better-sqlite3 import)` in `test/gateway/door.test.ts` asserts the same by reading `src/gateway/door.ts` source at runtime and asserting `doesNotMatch /better-sqlite3/` and `/from\s+['"][^'"]*\/db\.js['"]/` — it passed (Command 2).

`door.ts` top-level imports:

```
import { readFileSync } from 'node:fs';
import puppeteer, { type Page } from 'puppeteer-core';
import { config } from '../config.js';
import { log, timed } from '../log.js';
```

## api fail-open + strip proof

The api-side read is fail-open: unset `GATEWAY_URL` → `null`; `fetch`/timeout/parse error → `null`; the handler never throws. Test output (Command 2):

- fed+strip: `instance a's /api/health door table is fed from the gateway, egressIp/proxy stripped` PASSED (asserts `doors[0].budgetUsed === 2` fed from the stub gateway, and `egressIp===undefined` + `proxy===undefined` + the raw strings absent from the JSON wire).
- degrade: `instance a /api/health degrades to doors:null when the gateway is down (never 500)` PASSED with the verbatim log line
  `WARN [api] gateway /health unreachable — doors degraded err=TypeError:fetch failed`, returning HTTP 200 + `doors:null`.

`api.ts` no longer imports the local crawl singleton:

```
$ grep -n "crawl" src/api.ts
45:// import { balanceSeries } from './crawl.js';      <- commented legacy line
845:   * /balance-chart was the heavy one: it drives the Nansen browser-sidecar crawl.
862:  // Balance chart (the yellow Nansen series): Nansen crawl via browser sidecar,
```

(no runtime import). `crawl.ts` references `poolStatsOrNull` only in the re-export shim:

```
$ grep -n "poolStatsOrNull" src/crawl.ts src/api.ts
src/crawl.ts:37:  poolStatsOrNull,
```

## Gateway wiring

```
$ grep -n "poolStatsOrNull\|door.js" src/gateway/app.ts
11:import { poolStatsOrNull } from './door.js';
106:      doors: poolStatsOrNull(),
```

## Scope / no second instance

- No new `DoorPool` instance in the api container: `api.ts` does not import `crawl.ts` (or `gateway/door.ts`), so it never constructs/uses a pool. The singleton lives only in `door.ts`, is lazy (`getPool` called only from `browserPostJson`), and `poolStatsOrNull()` is side-effect-free.
- No `crawl.ts ⇄ door.ts` cycle: only crawl.ts imports door.ts (plus app.ts).
- `nansen-door` limiter in `ratelimit/spec.ts:46-49` untouched and NOT wired.
- `contract.ts`, `auth.ts`, `main.ts`, providers, config, index, poller untouched.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-10-request-plane-gateway.md
