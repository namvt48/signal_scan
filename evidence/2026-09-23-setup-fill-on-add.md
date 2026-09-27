# Evidence — setup-fill-on-add (plan `.omo/plans/setup-fill-on-add.md`, APPROVED 2026-09-23)

## T2 — Cache store + record shape (`server/src/setup-cache.ts`, `server/src/config.ts`, new tests)

Scope executed: file cache module + config entry + 9 tests ONLY. No wiring into poller/crawl/api (T3).
Files changed: `server/src/setup-cache.ts` (NEW, 185 pure LOC), `server/src/config.ts` (+`setupCacheFile`,
dbPath hoisted to const), `server/test/setup-cache.test.ts` (NEW, 9 tests). Files NOT touched:
poller.ts, api.ts, crawl.ts, snapshot.ts, providers/nansen.ts, FE, docker-compose.yml, .env.example,
docs, `server/test/door-pool.test.ts`. No new dependencies. No git. No ssh/deploy (250 paused).

### Baseline (measured BEFORE any edit, 2026-09-23)

```
> signal-scan-server@0.1.0 build
> tsc
BUILD_EXIT=0
ℹ tests 152
ℹ pass 152
ℹ fail 0
ℹ duration_ms 15322.744247
```

Baseline = **152 pass / 0 fail** — matches plan §5.

### RED (test file written first; module + config field absent)

`npx tsx --test test/setup-cache.test.ts`:

```
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///home/namvt/Desktop/dev-space/signal_scan/server/src/setup-cache.js'
}
Node.js v25.8.1
✖ test/setup-cache.test.ts (217.102501ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

LSP at RED (same two facts): `Cannot find module '../src/setup-cache.js'` +
`Property 'setupCacheFile' does not exist on type '{ port: number; dbPath: string; … }'`.
Failure reason = feature missing (module not found), not a typo.

### GREEN (after implementing config.setupCacheFile + setup-cache.ts)

Single file — `npx tsx --test test/setup-cache.test.ts`:

```
✔ round-trip: put → version-1 envelope on disk → load preserves every field
✔ put upserts: second put for the same (ca, chain) replaces the record
✔ isSetupCacheFresh: age == POLL_SETUP_MS is stale, age == POLL_SETUP_MS - 1 is fresh
✔ missing file: load → empty map, never throws; put then creates dir + file
✔ corrupt / empty / wrong-envelope file: load → empty map, never throws
✔ malformed entries are skipped; the valid sibling survives
✔ put leaves no *.tmp behind — success path and blocked-target failure path
✔ pruneSetupCache drops untracked keys and entries older than 7×POLL_SETUP_MS, and persists
✔ config: setupCacheFile defaults beside dbPath (prod DB_PATH=/data/… → /data/nansen-cache.json)
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Full gate — `npm run build && npm test`:

```
> tsc
BUILD_EXIT=0
ℹ tests 161
ℹ pass 161
ℹ fail 0
ℹ duration_ms 15123.307191
```

161 = 152 baseline + 9 new. 0 fail.

### Frozen-file check

`server/test/door-pool.test.ts`: `grep -c "^test(" ` → **13**; md5 `0eb56449b9c28faf4585189afa5c3eeb`
(untouched, 13/13 pass inside the full run).

### Acceptance criteria (plan §6 T2)

- [x] `cd server && npm run build` → exit 0
- [x] New tests RED first (ERR_MODULE_NOT_FOUND captured above), GREEN after
- [x] Atomic write (`<file>.tmp` → `renameSync`, `mkdirSync recursive`); corrupt/missing file →
      empty map, never throws (tests 4–6); no stale `*.tmp` on success OR failure (test 7)
- [x] Record shape = plan §4 verbatim; envelope `{version:1, entries:[…]}`; key `` `${chain}:${ca}` ``
- [x] Freshness boundary: `now - taken_at == POLL_SETUP_MS` → stale; `- 1` → fresh (test 3)
- [x] Prune: untracked keys dropped; age > 7×POLL_SETUP_MS dropped (exactly 7× survives); persists (test 8)
- [x] `setupCacheFile` default lands beside the DB: local `data/nansen-cache.json`; prod
      (DB_PATH=/data/signal_scan.db, docker-compose.yml:34) → `/data/nansen-cache.json` (test 9)
- [x] Tests use mkdtempSync temp dirs only — real `data/` untouched (verified: no `data/nansen-cache.json`)
- [x] Leaf module: runtime imports = config.js + shared/chain.js only; no poller/api/crawl import
- [x] Plan §5 integration cases #2/#3 (DB-wipe → rehydrate → 0-fetch) — deferred to T3; **done in T3 below**

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md

## T3+T5 — rehydrate/fill-on-add, door-guard, phase-anchored cadence (2026-09-23)

Decisions honored: F1=(b) (setupSweep phase-locks to `systemDeployAt`), F3=queue (fresh entry with
no row applies on a later pass), F2 exports (`refreshSeries`, `cacheSeriesWindows`,
`nextPhaseDelayMs`, `setPoolForTest`).

### Files changed (5 src, 3 new tests — nothing else touched)

- `server/src/setup-cache.ts` — C1 `loaded`/`ensureLoaded()` lazy hydrate before first persist;
  C2 `pruneSetupCache` returns 0 against an EMPTY tracked set (no persist); C3 `isStorable()`
  refuses records parseEntry would drop (non-finite numerics, empty series/exchange, empty ca,
  bad chain) with one warn line — never throws.
- `server/src/db.ts` — `open()` writes `systemDeployAt` ONCE when absent (beside the lfRule
  marker); never overwritten.
- `server/src/poller.ts` —
  - `refreshSeries` EXPORTED (awaits, one CA), door-guarded: fresh entry →
    `applySetupCacheEntry` (zero fetches) → early return; completed passes end by offering
    `putSetupCacheEntry` (raw series+exchange points, `window`/`series_from` from the fetch,
    derived fields; incomplete passes refused by the C3 guard).
  - `seriesAtRung` → `{points, from, window}` (SeriesFetch); `exchangeLf` → `{total, points}`.
  - `applySetupCacheEntry`: row missing → log + no-op (F3=queue); row present → replay windows
    through `cacheSeriesWindows(e.series, e.taken_at)` + `updateTokenAnalytics` straight-through.
  - `crawlBalanceSeries` (kickNansen path): same fresh-entry guard — never hits the door behind
    a fresh cache entry.
  - `setupSweep`: prunes the file cache against current tracked keys after the pass.
  - `nextPhaseDelayMs(anchorAt, now, intervalMs)` = delay to the next `anchor + n×interval`
    boundary ≥ now (on-boundary fires immediately — fresh deploy = boundary n=0, keeping the old
    boot-time first pass while phase-locking); startPoller schedules setupSweep with
    `initialDelayMs` from `systemDeployAt`, other tasks keep the `i*20s` stagger.
- `server/src/crawl.ts` — `setPoolForTest()` seam; `balanceSeries` falls back to a FRESH
  file-cache entry (replayed through the SAME `cacheSeriesWindows` slicer) when `nansen_series`
  is empty, before degrading to snapshots.
- `server/src/index.ts` — startup `loadSetupCache()` once + prune against `listTrackedCas()`
  keys, logs `loaded N entries (pruned M)`.

### RED (before implementation)

`cd server && npm test` →

```
✖ C1: put with NO prior load lazily loads — 3 on-disk entries + 1 put = 4, nothing clobbered
✖ C2: prune against an EMPTY tracked set is a no-op — a DB reset cannot wipe the cache
✖ C3: unparseable entries are never stored — non-finite derived fields or empty point arrays are refused
✖ test/setup-cadence.test.ts   (ERR: poller.js has no exported member 'nextPhaseDelayMs')
✖ test/setup-rehydrate.test.ts (ERR: crawl.js no 'setPoolForTest'; poller.js 'refreshSeries' not exported)
ℹ tests 166  pass 161  fail 5
```

### GREEN (after implementation)

```
npm run build → exit 0 (tsc)
npm test      → ℹ tests 171  pass 171  fail 0
door-pool.test.ts alone → ℹ tests 13  pass 13  fail 0
lsp_diagnostics(error) → clean: setup-cache.ts, db.ts, poller.ts, crawl.ts, index.ts,
                         setup-cache-safety.test.ts, setup-rehydrate.test.ts, setup-cadence.test.ts
```

171 = 161 baseline + 10 new (3 safety + 5 rehydrate + 2 cadence).

### New tests

- `server/test/setup-cache-safety.test.ts` (3) — C1: 3-entry file + first put of a process with no
  load → 4 on disk; C2: prune(empty set) → 0 dropped, file bytes identical; C3: 9 refused writes
  (NaN/Inf on each of the 6 numeric fields, empty series, empty exchange, empty ca) → map +
  reloaded file hold only the good entry. Env `SETUP_CACHE_FILE` set before the dynamic import →
  the module default never touches the real `./data`.
- `server/test/setup-rehydrate.test.ts` (5) — fake-door harness: `DoorPool` over a fake `DoorConn`
  counting `NANSEN_HOURLY_STATS_URL` fetches (`warm()` never fetches — counter starts clean after
  a `setImmediate` tick), installed via `setPoolForTest`.
  1. fill-on-add: ONE pass → t100_pct 33.33 / t100_multiple 1.5 / genesis_bal 120 /
     anchor_at == deployed_at, exactly 2 door fetches, entry on disk (3 series + 2 exchange pts,
     window 'week', series_from == deployed_at), nansen_series week ≥ 3 rows.
  2. rehydrate: fresh entry → DELETE FROM nansen_series + token_state (the reset) → reload cache,
     re-seed bare row → refreshSeries applies with ZERO door fetches, columns + week rows restored.
  3. row-missing: fresh entry + no row → no-op, 0 fetches; row appears → next pass applies, still
     0 fetches (F3=queue).
  4. stale: taken_at = now − (POLL_SETUP_MS + 1s) → exactly 2 door fetches, entry + file refreshed.
  5. balanceSeries: empty nansen_series + fresh entry → source 'nansen', 3 points, 0 fetches,
     replay fills the table.
- `server/test/setup-cadence.test.ts` (2) — boundary math (2.5 intervals → 0.5 delay, on-boundary
  → 0, fresh deploy → 0, frac sweep {0.1,0.5,0.9,1.7,12.3} all land on `anchor + n×POLL` within
  ≤ one interval); `open()` twice → systemDeployAt unchanged, live schedule from the STORED
  anchor lands on a boundary.

### Frozen-file check

- `server/test/door-pool.test.ts` — untouched, 13/13 pass.
- `server/src/snapshot.ts`, `server/src/providers/nansen.ts`, `server/src/api.ts`, FE `src/**`,
  `docker-compose.yml`, `.env.example`, `docs/**` — untouched.
- `config.pollSetupMs` (43_200_000) unchanged.

### Acceptance criteria (plan §5/§6 T3+T5)

- [x] Fresh entry + row → derived fields applied + windows replayed, ZERO door requests (rehydrate 2/3/5)
- [x] Fresh entry + no row → never fetches; a later pass applies (rehydrate 3, F3=queue)
- [x] Stale entry (age ≥ POLL_SETUP_MS) → refetch + entry/file refreshed (rehydrate 4)
- [x] Fetch pass persists raw series+exchange + derived fields (rehydrate 1)
- [x] balanceSeries file-cache fallback when nansen_series empty (rehydrate 5)
- [x] C1 put-before-load never clobbers (safety 1); C2 empty tracked set never wipes (safety 2);
      C3 unparseable never stored (safety 3)
- [x] Prune wired at startup (index.ts) + end of setupSweep, against currently-tracked keys
- [x] systemDeployAt written once, never overwritten (cadence 2)
- [x] setupSweep fires on systemDeployAt + n×POLL_SETUP_MS boundaries; restarts re-phase
      (cadence 1/2; startPoller initialDelayMs = nextPhaseDelayMs)
- [x] Build exit 0; full suite 171/171; door-pool 13/13; lsp clean on all changed files

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md

## T4 (2026-09-23) — early paced setup trigger on add DONE

Baseline measured before T4: **171 pass / 0 fail** (full `npm test` run).

Change (poller.ts ONLY — api.ts untouched):
- `kickToken` now RETURNS its promise (resolves after `upsertTokenInfo`, never rejects).
- `kickCAs`: `void kickToken(...).then(() => kickSetupEarly([c]))` — the early pass is
  chained on row creation, so `refreshSeries` can never fire before the `token_state`
  row exists (it no-ops without it; the chain IS the ordering proof).
- New `kickSetupEarly(cas)` + module-private `drainEarlySetup()`: gated on
  `config.crawlEnabled`; pending-list + ONE serialized promise chain (never N
  simultaneous passes); each batch paced by the EXISTING `pacedFor(batch,
  config.newCaPriorityMs, ...)` — queue-jump window (1h) ⇒ 2 req/CA spread far under
  30/min/path + 40/min/door; pool budgets remain the hard cap. Best-effort: every
  error caught inside, an add can never fail on the early pass.
- Log line: `[poller] early setup pass <ca8> (<chain>)`.
- Test seam exported: `earlySetupIdle(): Promise<void>`.

RED (test/setup-early-kick.test.ts, before implementation):
```
✖ early kick: 2 CAs in one call → ONE paced setup pass each, after the row exists (23.2ms)
  TypeError: earlySetupIdle is not a function
✖ early kick: a fresh file-cache entry costs ZERO door fetches (9.1ms)
  TypeError: earlySetupIdle is not a function
ℹ tests 2  ℹ pass 0  ℹ fail 2
```

GREEN (after implementation):
```
✔ early kick: 2 CAs in one call → ONE paced setup pass each, after the row exists (431.0ms)
✔ early kick: a fresh file-cache entry costs ZERO door fetches (409.3ms)
ℹ tests 2  ℹ pass 2  ℹ fail 0
```

Fetch counts asserted (fake-door harness, no wall-clock sleep assertions):
- 2 CAs, no cache: `doorFetches === 6` (early pass 2/CA: series + `label='exchange'`;
  + the pre-existing kickNansen series 1/CA), `exchangeFetches === 2` (= exactly ONE
  early pass per CA — exchange is fetched only by refreshSeries), `maxActiveExchange
  === 1` (passes never overlap — paced, not a burst).
- Ordering proof: `t100_multiple=1.5`, `genesis_bal=120`, `anchor_at=deployedAt` filled
  for BOTH CAs — refreshSeries returns early when the row is missing, so filled columns
  prove the pass ran strictly AFTER kickToken/upsertTokenInfo.
- Fresh file-cache entry (2 CAs): `doorFetches === 0`, `exchangeFetches === 0`, columns
  applied from cache (`[setup-cache] applied … 0 door requests` ×2).
- Test env (set before src imports, one process per test file): `NANSEN_CRAWL=on`,
  `NEW_CA_PRIORITY_MS=1000` (shrinks the pacedFor slot to test size; assertions are counts).

Final gates: `npm run build` exit 0; full suite **173 pass / 0 fail** (171 baseline + 2 new);
`test/door-pool.test.ts` untouched (md5 0eb56449b9c28faf4585189afa5c3eeb, 13/13 inside the suite).
No deploy, no ssh — server 250 stays paused.

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md

## T6 — verification tổng (2026-09-23)

T6 re-ran every gate itself from the current working tree (T6 changes no source). All output
below is pasted verbatim from THIS run; nothing is copied from the T2/T3+T5/T4 sections above.

### Measured gates (re-run now)

`cd server && npm run build`:

```
> signal-scan-server@0.1.0 build
> tsc

BUILD_EXIT=0
```

`cd server && npm test` (tail):

```
ℹ tests 173
ℹ suites 0
ℹ pass 173
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 25798.883937
```

**173 pass / 0 fail** — counted here, not copied.

`md5sum server/test/door-pool.test.ts`:

```
0eb56449b9c28faf4585189afa5c3eeb  server/test/door-pool.test.ts
```

Matches the frozen digest `0eb56449b9c28faf4585189afa5c3eeb` (13/13 tests).

### RED→GREEN baseline chain (as measured per task)

**152** (baseline after trackedBy) → **161** (T2, +9 cache tests) → **171** (T3+T5, +10 tests)
→ **173** (T4, +2 tests). `0 fail` at every step.

### Changed-file list

`find server/src server/test -newermt '2026-09-23 10:00' -printf '%TH:%TM %p\n' | sort`:

```
10:25 server/test/setup-cache.test.ts
10:26 server/src/config.ts
11:06 server/test/setup-cache-safety.test.ts
11:07 server/test/setup-rehydrate.test.ts
11:08 server/test/setup-cadence.test.ts
11:11 server/src/setup-cache.ts
11:12 server/src/db.ts
11:16 server/src/crawl.ts
11:16 server/src/index.ts
11:46 server/test/setup-early-kick.test.ts
11:47 server/src/poller.ts
```

One line each (what the change is for):

- `test/setup-cache.test.ts` — T2: round-trip / upsert / freshness boundary / atomic write / prune (9).
- `src/config.ts` — T2: `setupCacheFile` default beside `dbPath` → prod `/data/nansen-cache.json`.
- `src/setup-cache.ts` — T2/T3: NEW file cache (atomic tmp+rename, never throws) + C1 lazy-load, C2 empty-set prune no-op, C3 storable guard.
- `test/setup-cache-safety.test.ts` — T3: the C1/C2/C3 safety guards (3).
- `test/setup-rehydrate.test.ts` — T3: fill-on-add, wipe→rehydrate (0 fetch), row-missing, stale, balanceSeries fallback (5).
- `test/setup-cadence.test.ts` — T5: `nextPhaseDelayMs` boundary math + `systemDeployAt` write-once (2).
- `src/db.ts` — T5: `open()` writes `systemDeployAt` ONCE when absent (never overwritten).
- `src/crawl.ts` — T3: `setPoolForTest` seam + file-cache fallback when `nansen_series` empty.
- `src/index.ts` — T3: startup `loadSetupCache()` + prune, logs `loaded N (pruned M)`.
- `test/setup-early-kick.test.ts` — T4: 2-CA paced early pass + fresh-cache 0 fetch (2).
- `src/poller.ts` — T3/T4/T5: door-guarded `refreshSeries`/`cacheSeriesWindows`, phase-locking `nextPhaseDelayMs`, `kickToken` returns promise, `kickCAs` early-pass chain, `kickSetupEarly`/`drainEarlySetup`.

### Verification matrix — 4 user requirements → evidence

| Yêu cầu user (verbatim) | Chứng minh bằng (measured) |
|---|---|
| "CA mới thêm CALL 1 lần đủ thông tin" | T3 `setup-rehydrate.test.ts` test #1 (one pass fills `t100_pct 33.33` / `t100_multiple 1.5` / `genesis_bal 120` / `anchor_at`, exactly 2 door fetches) + T4 `setup-early-kick.test.ts` (early pass runs strictly after the row exists, `exchangeFetches === 2`, columns filled for BOTH CAs) |
| "cache lại, reset không mất" | T2 `setup-cache.test.ts` test #2 + T3 `setup-rehydrate.test.ts` test #2 (wipe `token_state`+`nansen_series` → reload → columns + rows restored, **0 door fetches**); T3 safety C2 (prune on an empty tracked set is a no-op, reset cannot wipe the file) |
| "định kì crawl lại mốc 12h" | T5 `setup-cadence.test.ts` (fractions {0.1, 0.5, 0.9, 1.7, 12.3} land on `anchor + n×POLL_SETUP_MS`) + boundary `43_200_000` (`config.pollSetupMs`, `config.ts:56`; age == 12h → stale, strict `<`) |
| "từ giờ mặc định là khoảng thời gian kể từ thời điểm deploy hệ thống" | F1=(b) + F1b=(i): `systemDeployAt` write-once in `db.ts open()` (T5 `setup-cadence.test.ts` test #2 — `open()` twice → unchanged) + `nextPhaseDelayMs(anchorAt = systemDeployAt, …)` drives the `setupSweep` schedule (T3/T5) |

### Frozen-file proof (these were NOT modified by this workstream)

`stat -c '%y %n'` — all four predate the 2026-09-23 10:00 change window:

```
2026-09-21 21:41:07.772338678 +0700 server/src/snapshot.ts
2026-09-21 22:22:26.021751532 +0700 server/src/api.ts
2026-09-22 20:51:10.632537997 +0700 server/src/providers/nansen.ts
2026-09-22 10:12:05.484554966 +0700 server/test/door-pool.test.ts
```

- `snapshot.ts` — frozen; F1=(b) needs no anchor change (`seriesFromMs` / `exchangeAnchorLf` kept verbatim).
- `api.ts` — frozen; **deliberately left untouched by T4** (queue-jump `newCasFirst` already existed, so the early trigger went into `poller.ts` only).
- `providers/nansen.ts` — frozen, untouched.
- `door-pool.test.ts` — frozen; md5 `0eb56449b9c28faf4585189afa5c3eeb` (13/13, matches above).

### Deploy checklist (for LATER — user has NOT authorised a deploy; 250 stays PAUSED)

User has not said resume/deploy; this is preparation only. When the user gives the word:

1. **`data/nansen-cache.json` survives `make deploy`, and is WIPED by `make ssh-rm`.**
   `make deploy` excludes `data/` (`Makefile:50` `rsync … --exclude data`) → the file persists across
   a deploy. `make ssh-rm` (`Makefile:90`) deletes the whole REMOTE_DIR incl. `data/` → the cache is
   DESTROYED by design. Confirm the file still exists after `make deploy`, and expect it GONE after
   `make ssh-rm`.
2. **Startup log**: `[setup-cache] loaded N entries from /data/nansen-cache.json (pruned N)` — proves
   the file loaded at boot and prune ran against current tracked keys.
3. **Scheduler log**: `[poller] setupSweep anchored to systemDeployAt=<iso> — next pass in Ns` — proves
   cadence is phase-locked to the deploy time (F1=(b)).
4. **On a CA add**: `[poller] early setup pass <ca8> (<chain>)` then, on the next pass,
   `[setup-cache] applied <ca8> (sol) from file cache — 0 door requests` — proves the paced early
   trigger fired and a fresh cache entry costs zero door calls.
5. **Gate**: build 0 + 173/173 was verified LOCALLY, **NOT yet on 250**. Re-run `make deploy` then
   `cd server && npm run build && npm test` on the server before trusting the rollout.

### Known observations carried forward (NOT fixed by T6 — recorded only)

1. Each new CA costs one extra series fetch: `kickNansen` and the early pass both fetch the series
   (~2 door requests/CA, zero Nansen credit, inside the per-path 30/min + per-door 40/min budget).
   Pre-existing in T3/T4 by design; not a regression.
2. `earlySetupDrain` chain has no defensive `.catch()` — currently UNREACHABLE because the per-item
   `fn` is try/caught; flagged as future hardening, not a bug.
3. Production burst spacing = `newCaPriorityMs(1h) × sweepPaceFactor(0.8) / batch.length` per CA,
   while a single add runs immediately (last item never waits). Recorded for the deploy-time pacing check.

### T6 acceptance criteria (plan §6)

- [x] This file exists with REAL pasted output (build, full suite, md5, changed-file list) — all re-run by T6.
- [x] Numbers are T6-measured: build exit 0, **173 pass / 0 fail**, md5 `0eb56449b9c28faf4585189afa5c3eeb`.
- [x] No file under `server/src/` or `server/test/` modified by T6.
- [x] Verification matrix maps all 4 user requirements to concrete evidence.
- [x] Deploy checklist + known observations recorded; server 250 untouched (no ssh, no deploy).

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md

## Final Wave F3 — HTTP-level e2e QA (2026-09-23)

Reviewer F3: hands-on end-to-end QA at the HTTP level. Gap closed: every prior test drove
`kickCAs`/`refreshSeries` DIRECTLY; nothing proved a real `POST /api/tracked-cas` request reaches
the early setup pass. New file: **`server/test/setup-http-e2e.test.ts`** (3 tests, no new deps,
real `createApp` booted on an ephemeral port, TEMP db via `DB_PATH` + `open()`, `SETUP_CACHE_FILE`
on a temp file, fake counting door via `setPoolForTest`, `setPollerDeps` mirroring `startPoller`'s
wiring, `NANSEN_CRAWL=on`, `NEW_CA_PRIORITY_MS=1000`).

### GREEN — `cd server && npx tsx --test test/setup-http-e2e.test.ts` (real output)

```
✔ POST /api/tracked-cas: the real route drives ONE paced early pass → token_state filled, no 12h wait (70.902679ms)
✔ two concurrent POSTs: both CAs filled, the early passes stay serialized (paced, never a burst) (15.4901ms)
✔ re-add after a DB reset: the FILE cache entry the first HTTP add wrote absorbs everything — ZERO door fetches (6.485591ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Server log during the run confirms the production chain fired from the HTTP request:
`[poller] early setup pass CA-HTTP- (sol)` and, on the re-add,
`[setup-cache] applied CA-HTTP- (sol) from file cache — 0 door requests`.

### RED — trigger dependency proof (temporary edit, then byte-exact restore)

Experiment: `kickCAs` (`server/src/poller.ts:572-574`) temporarily reduced to a bare
`void kickToken(pollerDeps.provider, c.address, c.chain);` — i.e. `.then(() => kickSetupEarly([c]))`
removed. Real output:

```
✖ POST /api/tracked-cas: the real route drives ONE paced early pass → token_state filled, no 12h wait (85.721059ms)
  AssertionError [ERR_ASSERTION]: CA-HTTP-1 t100_multiple filled by the early pass
✖ two concurrent POSTs: both CAs filled, the early passes stay serialized (paced, never a burst) (19.687359ms)
  AssertionError [ERR_ASSERTION]: CA-HTTP-2 t100_multiple filled by the early pass
✖ re-add after a DB reset: the FILE cache entry the first HTTP add wrote absorbs everything — ZERO door fetches (9.718412ms)
  AssertionError [ERR_ASSERTION]: a fresh file-cache entry must absorb the whole add
ℹ tests 3
ℹ pass 0
ℹ fail 3
```

(Test 3's RED failure is a genuine cascade: with the trigger removed, test 1 never WRITES a cache
entry, so the re-add's `kickNansen` hits the door — `doorFetches !== 0`.)

Restore verified byte-exact: `md5sum server/src/poller.ts` = `6c118e96eda4214f5105d4cf498ade18`
BEFORE the experiment, AFTER the restore, and after the final full suite. GREEN re-captured after
restore: `tests 3 / pass 3 / fail 0`.

### Full gate (real output)

- `cd server && npm run build` → `tsc` exit **0**.
- `npm test` (`tsx --test test/*.test.ts`) → **tests 176, pass 176, fail 0** (baseline 173 + the 3
  new HTTP e2e tests — count legitimately raised, not forced).
- Frozen check: `md5sum server/test/door-pool.test.ts` = `0eb56449b9c28faf4585189afa5c3eeb` — UNCHANGED.
- Files changed by F3: `server/test/setup-http-e2e.test.ts` (new) + this evidence append. Nothing
  under `server/src/` permanently modified (the single temporary `poller.ts` edit was restored
  byte-exact, md5-verified). No git, no ssh, no deploy — server 250 stays PAUSED.

### What this PROVED

1. The suspected weak link is FALSIFIED: the real route (`api.ts:345-374`, body `{address, chain}` →
   201 `{id, address, chain, note, addedAt, status:'queued'}`) reaches
   `kickCAs → kickToken().then(kickSetupEarly) → drainEarlySetup → refreshSeries`; `token_state`
   fills (`t100_multiple=1.5`, `genesis_bal=120`, `anchor_at=deployedAt`) WITHOUT the 12h sweep.
   `api.ts` needs NO change. The only wiring precondition is `pollerDeps`, which production sets via
   `startPoller → setPollerDeps` (`poller.ts:521-524`) before the server takes requests; the test
   mirrors that with `setPollerDeps` directly.
2. Pacing holds at the HTTP level (counts, never wall-clock): one add = `exchangeFetches 1`,
   `doorFetches 3` (2 early pass + 1 kickNansen), `maxActiveExchange 1`; TWO concurrent POSTs =
   `2 / 6 / 1` — serialized, never a burst.
3. Cache lifecycle end-to-end through HTTP: first add writes the file-cache entry → tables wiped
   (`tracked_cas`, `token_state`, `nansen_series`) → `loadSetupCache()` re-reads from DISK → re-add
   costs **ZERO** door fetches and refills the columns.

### What this could NOT prove

1. The real browser door transport — fake counting door by design (real one needs browserless + CF
   clearance; same boundary every other test in the suite uses).
2. Production pacing SPREAD — `NEW_CA_PRIORITY_MS=1000` (test-sized) vs 1h in prod; counts proven,
   wall-clock spacing deliberately not asserted (carried observation #3 above still stands for the
   deploy-time check).
3. `index.ts` boot itself (startPoller + listen in one live process) — the test injects the same
   deps `startPoller` injects; equivalence rests on `poller.ts:521-524`, not on a booted `index.ts`.
4. Duplicate-409 / below-min-usd-skip HTTP paths — already covered by `min-usd-gate.test.ts` and
   `tracked-ca-entry-usd.test.ts`; not re-tested here.

VERDICT: APPROVE — the HTTP flow genuinely drives the feature; removing the trigger turns all 3
HTTP-level tests RED, restoring it (byte-exact) turns them GREEN, and the full suite is 176/176
with every frozen md5 intact.

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md

## F2 fix — prune dùng tracked set tươi (2026-09-23)

**Finding (F2, verbatim substance):** the file-cache prune in `setupSweep` used a stale
snapshot of the tracked-CA set (`const cas = newCasFirst(listTrackedCas())` taken at sweep
START, reused at the closing `pruneSetupCache(Date.now(), new Set(cas.map(...)))`). Because
`pacedFor` spreads the sweep across `POLL_SETUP_MS × 0.8` (~9.6h), a CA added mid-sweep via
`POST /api/tracked-cas` → `kickCAs` → `kickSetupEarly` → `drainEarlySetup` → `refreshSeries`
→ `putSetupCacheEntry` had its fresh, legitimate entry DELETED by the prune (key absent from
the start snapshot) — voiding the wipe-resilience promise for every CA added in that window.

**Fix (one fresh read + comment, `server/src/poller.ts`):** the prune now reads
`listTrackedCas()` FRESH at prune time —
`const trackedKeysNow = new Set(listTrackedCas().map((c) => cacheKey(c.address, c.chain)));`
immediately followed by `pruneSetupCache(Date.now(), trackedKeysNow)` in the SAME synchronous
block (no `await` between → no new race window; verified by re-reading the diff, poller.ts
lines 268-269). The sweep-start `cas` still drives the `pacedFor` iteration (unchanged);
`newCasFirst` NOT reintroduced at prune time (ordering is irrelevant to set membership);
prune SEMANTICS in `setup-cache.ts` untouched (C2 empty-set guard + 7×POLL max-age intact).
`setupSweep` was EXPORTED (previously module-private) as the test seam, mirroring the
existing `refreshSeries`/`pacedFor` export precedent — no restructuring.

**Regression test:** `server/test/setup-sweep-prune.test.ts` (1 test) — runs the real
`setupSweep` (POLL_SETUP_MS=1000 → 400ms paced slot, 2 seeded CAs), adds a CA mid-sweep
through the REAL `kickCAs` path (fake DoorPool harness copied from `setup-early-kick.test.ts`),
asserts the early pass wrote the entry (precondition: `t100_multiple=1.5`, `genesis_bal=120`),
then asserts the entry SURVIVES the closing prune. Counts/state only, never wall-clock.

**RED (against unfixed code, verbatim):**
```
[poller] early setup pass CA-SWEEP (sol)
[poller] kickNansen CA-SWEEP: cached + extremes updated
[setup-cache] pruned 1 entries
✖ setupSweep prune: a CA added mid-sweep keeps its fresh cache entry (stale snapshot must not prune it) (418.568277ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
  AssertionError [ERR_ASSERTION]: mid-sweep add: the fresh cache entry must SURVIVE the setupSweep prune (stale snapshot deletes it)
      actual: undefined, expected: true, operator: '=='
```
(Red for the RIGHT reason: precondition assertions passed, `[setup-cache] pruned 1 entries`
proves the stale snapshot deleted the entry — not a compile/import error.)

**GREEN (after fix, verbatim):**
```
[poller] early setup pass CA-SWEEP (sol)
[poller] kickNansen CA-SWEEP: cached + extremes updated
✔ setupSweep prune: a CA added mid-sweep keeps its fresh cache entry (stale snapshot must not prune it) (415.373887ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

**Measured gates (this session, not copied):**
- Baseline BEFORE the change: `npm test` → **176 pass / 0 fail** (duration_ms 26124.54), exit 0.
- After: `npm run build` → tsc clean, **exit 0**.
- After: `npm test` → **177 pass / 0 fail** (duration_ms 25791.77), exit 0.
- `md5sum server/test/door-pool.test.ts` → `0eb56449b9c28faf4585189afa5c3eeb` (frozen, intact).

**Files changed:** `server/src/poller.ts` (export seam + 2-line prune fix + comment),
`server/test/setup-sweep-prune.test.ts` (new, 1 regression test). Nothing else touched —
no frozen file, no prune-semantics change, no dependency added, no git/deploy/250 action.

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md

## symbolBackfillSweep quota leak — window bound (2026-09-23)

**Leak:** `listCaTargetsMissingSymbol()` had NO time bound, so every tracked CA whose
symbol never resolved stayed in the set forever. `symbolBackfillSweep` fires every
`POLL_SYMBOL_BACKFILL_MS` (5 min default) → `provider.assetInfo` → `getAssetInfo` →
Solana DAS `getAsset` = **10 credits/call**. 288 calls/day × 10 cr = **2,880
credits/day per permanently-stuck CA, forever** (≈8.64% of the free pool each,
scales linearly with stuck-CA count). Survives a crawl pause: the sweep is the only
poll task pushed outside the `crawlEnabled` block.

**Asymmetry:** the sibling selector `listCaTargetsMissingEssential(withinMs)` already
carried exactly this bound (`t.added_at >= ?`, docstring "must not be retried
forever"). The symbol selector was the only unbounded one.

**Fix:** symmetric window bound, nothing else.
- `server/src/config.ts` — new `symbolBackfillWindowMs: num('SYMBOL_BACKFILL_WINDOW_MS', 3_600_000)`
  next to `pollSymbolBackfillMs`, default 1h mirroring `essentialGapWindowMs`.
- `server/src/db.ts` — `listCaTargetsMissingSymbol(withinMs: number)`: `const since =
  new Date(Date.now() - withinMs).toISOString()` + `AND t.added_at >= ?` with `.all(since)`,
  line-for-line mirroring the essential selector; `(s.symbol IS NULL OR trim(s.symbol) = '')`
  unchanged (parenthesized for the added AND); docstring states the bound + expiry tradeoff
  (the 24h essential pass still covers an expired CA).
- `server/src/poller.ts` — sweep passes `config.symbolBackfillWindowMs`; stale "no credits"
  comment corrected: no browser, no *Nansen* credits, but getAsset costs 10 DAS credits/call —
  hence the window bound.

**New test:** `server/test/symbol-backfill.test.ts` — "a CA older than the window drops out
even with symbol NULL": inserts `caStuck`, backdates `added_at` via direct
`UPDATE tracked_cas SET added_at = ?` to now−2h (ISO string; comparison is textual, ISO-8601
ordering makes `>=` correct), asserts the 1h-window selector returns `[]`. The two existing
tests updated to the new signature (assert unchanged) and still prove now-stamped rows stay
inside the window.

**Measured gates:**
- Baseline before change: 177 pass / 0 fail.
- `cd server && npm run build` → tsc clean, **exit 0**.
- `cd server && npm test` → **178 pass / 0 fail** (duration_ms 26426.35) — delta is exactly
  the 1 new test; updating the 2 existing calls changes no count.
- `md5sum server/test/door-pool.test.ts` → `0eb56449b9c28faf4585189afa5c3eeb` (frozen, intact).
- `.env.example` NOT touched (frozen); cadence `pollSymbolBackfillMs` unchanged; no retry
  counter / column / migration / dependency; sweep remains unconditional (not gated on
  `crawlEnabled` — deliberate, it exists to work while the browser door is dead).

**Recorded, not fixed (bounded by this window):** non-sol CAs return `{}` from `assetInfo`
with no network call — 0 credits but they can never leave the set; `getAssetInfo` loops over
ALL configured RPC endpoints, so a stuck sol mint can cost 10 cr × endpoint count per sweep.

EVIDENCE_RECORDED: evidence/2026-09-23-setup-fill-on-add.md
