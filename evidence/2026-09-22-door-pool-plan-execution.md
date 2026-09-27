# Evidence: Nansen Door Pool + Proxy Routing (plan execution, T1 to T7)

Date: 2026-09-22 (confirmed with `date +%F` → `2026-09-22`)
Plan: `.omo/plans/nansen-proxy-routing.md`
Repo: `/home/namvt/Desktop/dev-space/signal_scan` (not a git repo; no git commands used)
Author: T7 evidence worker. Every command below was executed in this session; outputs are pasted raw (only unrelated lines trimmed). Nothing is copied from the prompt without a matching run.

## (a) Context and goal

The old single page browser was stuck in a loop: 403 → invalidatePage() → fresh page → 403 again, roughly every 4.5s, with chrome growing to about 2.3GB of a 3GB limit. The plan replaces that single page with a pool of N browserless doors (one WS connection each, one dedicated egress IP each, one cookie jar / cf_clearance each), fed from a proxy file read once at boot. Goals: raise throughput in proportion to the number of dedicated IPs, stop burning IPs, never lose data (requery once on a dead door), and degrade smoothly when doors run out. Plus: fix the 429 passthrough, fix the hardcoded warmup sleep, design doc, compose notes, and a smoke harness.

Scope of this file (T7): consolidate the real evidence for T1 to T6 and record deviations, gaps, and owner-gated items.

## (b) File change table (mtime is the change receipt, since there is no git)

Command:

```bash
ls -l --time-style=+%F_T%H:%M server/src/*.ts server/test/*.ts
ls -l --time-style=+%F_T%H:%M server/src/providers/nansen.ts
ls -l --time-style=+%F_T%H:%M docker-compose.yml server/.env.example docs/proxy-routing-design.md .probe/door-pool-smoke.mjs
```

Result:

| File | mtime | Plan task | What changed |
|---|---|---|---|
| `server/src/config.ts` | 2026-09-22_T09:51 | T1 | new `crawl*` fields + `posNum` helper |
| `server/.env.example` | 2026-09-22_T09:51 | T1 | Door pool / proxy routing section, D12 cadence, rotate warning |
| `docker-compose.yml` | 2026-09-22_T09:51 | T5 | comment only (`mem_limit ≈ 1g + 0.7g×N`) |
| `docs/proxy-routing-design.md` | 2026-09-22_T09:53 | T4 | new, 246 lines |
| `server/test/door-pool.test.ts` | 2026-09-22_T10:12 | T2 | new, 13 tests |
| `.probe/door-pool-smoke.mjs` | 2026-09-22_T10:13 | T6 | new harness |
| `server/src/crawl.ts` | 2026-09-22_T11:45 | T3 | door pool, 803 lines (post-wave R1-R4/S1-S2) |
| `data/proxies.txt` | 2026-09-22_T10:46 | owner input | owner-provided proxy file (not code) |

Not touched (old mtimes prove it, addressing the stale-state class):

| File | mtime |
|---|---|
| `server/src/index.ts` | 2026-09-17_T15:13 |
| `server/src/providers/nansen.ts` | 2026-09-21_T15:37 |
| `server/src/poller.ts` | 2026-09-21_T21:41 |
| `server/src/snapshot.ts` | 2026-09-21_T21:41 |
| `server/src/api.ts` | 2026-09-21_T22:22 |

No new file was created under `server/src/` (only `crawl.ts` changed there). `crawl.ts` is 803 lines (`wc -l server/src/crawl.ts`) after the final-wave fixes (R1-R4, S1-S2), matching the deviation note in `issues.md`.

## (c) Test evidence (run raw in this session)

### c1. Build

```bash
cd server && npm run build; echo "BUILD_EXIT=$?"
```

```
> signal-scan-server@0.1.0 build
> tsc

BUILD_EXIT=0
```

### c2. door-pool suite, run 1 and run 2

```bash
cd server && npx tsx --test test/door-pool.test.ts 2>&1 | tail -15
```

Run 1 (tail; full per-test lines are in the session log):

```
✔ requery: transport failure on one door is retried exactly once on the other (total 2 fetches) (1.101633ms)
✔ requery: when the requery also fails → {status:502|original, json:null}, at most 2 fetches (0.834391ms)
✔ lifecycle: 2 consecutive transport failures retire a door (broken-proxy); exhausted pool degrades to 503 without throwing (0.975808ms)
✔ 429: quarantine for retryAfter (+jitter=0) → probation → first 200 promotes to healthy; request requeried immediately (1.121685ms)
✔ 403-real: invalidate + re-warm, request requeried; second real-403 after re-warm → penalized (1.323308ms)
✔ penalized: 2m backoff via fake clock → re-warm → probation → 200 → healthy (1.289356ms)
✔ fallback: empty proxy list → one door, connect spec {ws, proxy:null} without --proxy-server, 429 still quarantined (2.153714ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 653.970027
```

Run 2 (fresh, same command):

```
✔ requery: transport failure on one door is retried exactly once on the other (total 2 fetches) (1.502665ms)
✔ requery: when the requery also fails → {status:502|original, json:null}, at most 2 fetches (1.238974ms)
✔ lifecycle: 2 consecutive transport failures retire a door (broken-proxy); exhausted pool degrades to 503 without throwing (1.366232ms)
✔ 429: quarantine for retryAfter (+jitter=0) → probation → first 200 promotes to healthy; request requeried immediately (1.356743ms)
✔ 403-real: invalidate + re-warm, request requeried; second real-403 after re-warm → penalized (1.409371ms)
✔ penalized: 2m backoff via fake clock → re-warm → probation → 200 → healthy (1.184472ms)
✔ fallback: empty proxy list → one door, connect spec {ws, proxy:null} without --proxy-server, 429 still quarantined (2.355645ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 658.283405
```

13/13 pass twice, deterministic. `grep -c "^test(" server/test/door-pool.test.ts` → `13`.

### c3. Full suite

```bash
cd server && npm test 2>&1 | tail -12
```

```
[poller] zero-score gate: deleted 1/1 CAs
✔ zeroScoreGate: deletes a complete 0/3 CA and its orphan token_state (4.263175ms)
✔ zeroScoreGate: keeps a 0/3 CA whose data is incomplete (symbol NULL) (1.39952ms)
✔ zeroScoreGate: keeps a complete CA with exactly one passing factor (0.991972ms)
ℹ tests 155
ℹ suites 0
ℹ pass 155
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3456.793148
```

155 tests, 155 pass, 0 fail. No regression in the pre-existing suite.

### c4. RED then GREEN (honest scope note)

GREEN is above and was re-run by me this session. RED was observed by the T2 worker before T3 landed: `npx tsx --test test/door-pool.test.ts` ×3 failed with `SyntaxError: ... does not provide an export named 'DoorPool'` (recorded in `.omo/notepads/nansen-proxy-routing/learnings.md`, T2 section). I did NOT re-run RED in this session because reproducing it would require reverting T3, which is out of scope for T7 (and the plan forbids touching code). Treat RED as recorded-by-worker, GREEN as re-verified-by-me.

## (d) The three old bugs and their fixes (file:line in current `crawl.ts`)

### d1. 429 passed straight through (old bug at `crawl.ts:145` pre-pool)

Old code (per `issues.md`): `if (out.status !== 403 || attempt === 2) return out;` so a 429 escaped as if it were data, retry-after was never read, no quarantine.

Current code:

- `crawl.ts:150` `if (res.status === 429) return 'throttle';` (classifier).
- `crawl.ts:371-378` `case 'throttle':` reads `res.retryAfter`, falls back to `DEFAULT_QUARANTINE_S = 1800` (`crawl.ts:177`) when the header is missing, sets `quarantineUntil = now + retryAfter*1000 + jitter`, state `throttled`.
- `crawl.ts:522-527` reads `retry-after` inside the page (`r.headers.get('retry-after')`), guards `Number(null)`, returns `retryAfter: number | null`.
- `crawl.ts:705-707` documents the removal: "a 429 can no longer escape as data (the old non-403 passthrough bug at crawl.ts:145 pre-pool)."

Verified dead:

```bash
grep -n "sleep(4000)\|status !== 403" server/src/crawl.ts   # empty, exit 1
grep -c "retry-after" server/src/crawl.ts                    # 6
```

The first grep returned nothing (exit 1 = no match), so both the passthrough branch and the hardcoded sleep are gone. The six `retry-after` hits are the read + quarantine path + comments.

### d2. Warmup was `goto + sleep(4000)` (hardcoded)

Old code: fixed 4s sleep after goto, which raced the Cloudflare challenge (measured up to about 20s per `.probe/challenge-probe.mjs`).

Current code:

- `crawl.ts:570-583` `warm(page)`: `goto` then a poll loop every `WARM_POLL_MS = 2500` (`crawl.ts:179`), returns when `cf_clearance` cookie exists AND the title no longer matches `just a moment|attention required`, throws after `config.crawlWarmupTimeoutMs` (default 30s).
- `crawl.ts:567-569` comments the change and points at `issues.md`.

### d3. 403 rebuild loop (breaker only counted thrown errors)

Old behavior: 403 and 429 were returned as responses, so `createCircuitBreaker` never counted them, the page was invalidated and rebuilt on every 403, and the loop repeated every ~4.5s while chrome grew to 2.3GB/3GB.

Current code:

- `crawl.ts:383-387` `case 'real403':` increments `real403Streak`; first 403 re-warms, a repeat penalizes (backoff ladder `120s/600s/1800s` at `crawl.ts:172`).
- `crawl.ts:388-393` `5xx`/`transport` increment `transportFails`; two in a row retire the door with reason `broken-proxy`.
- `crawl.ts:644-646` documents that the pool supersedes the global breaker: "per-door transport-fail retirement replaces the global breaker + page-rebuild loop".
- `createCircuitBreaker` is still exported (`crawl.ts:648`) so `test/crawl-breaker.test.ts` keeps passing, but it is now unwired. Verified:

```bash
grep -rn "createCircuitBreaker" server/src/ server/test/
```

```
server/src/crawl.ts:648:export function createCircuitBreaker(failureLimit: number, cooldownMs: number) {
server/test/crawl-breaker.test.ts:3:import { createCircuitBreaker } from '../src/crawl.js';
server/test/crawl-breaker.test.ts:6:  const b = createCircuitBreaker(3, 60_000);
server/test/crawl-breaker.test.ts:21:  const b = createCircuitBreaker(2, 60_000);
```

Only the definition and its own test remain; no live-path caller.

## (e) Smoke harness `--simulate` output (fake transport, no chrome)

```bash
cd server && npx tsx ../.probe/door-pool-smoke.mjs --simulate; echo "SMOKE_EXIT=$?"
```

```
[pool] [pool] starting 3 doors (proxies=3)
[pool] [door 0] warmup-ok path=- status=- budget=0/40 outstanding=0 state=probation
[pool] [door 1] warmup-ok path=- status=- budget=0/40 outstanding=0 state=probation
[pool] [door 2] warmup-ok path=- status=- budget=0/40 outstanding=0 state=probation
[pool] [door 0] promoted path=tgm-essential-data status=200 budget=1/40 outstanding=0 state=healthy
req  1 tgm-essential-data -> 200
[pool] [door 1] transport-fail n=1 path=tgm-volume-details status=0 budget=1/40 outstanding=0 state=probation
[pool] [door 1] requery class=transport path=tgm-volume-details status=0 budget=1/40 outstanding=0 state=probation
[pool] [door 2] throttled retry-after=2s path=tgm-volume-details status=429 budget=1/40 outstanding=0 state=throttled
req  2 tgm-volume-details -> 502
req  3 tgm-holders-gini-stats -> 200
[pool] [door 1] transport-fail n=2 path=tgm-holders-change status=0 budget=2/40 outstanding=0 state=probation
[pool] [door 1] retired reason=broken-proxy path=- status=- budget=2/40 outstanding=0 state=retired
[pool] [door 1] requery class=transport path=tgm-holders-change status=0 budget=2/40 outstanding=0 state=retired
req  4 tgm-holders-change -> 200
req  5 tgm-holders-hourly-stats -> 200
req  6 wp4t-transactions -> 200
req  7 tgm-essential-data -> 200
req  8 tgm-volume-details -> 200
req  9 tgm-holders-gini-stats -> 200
req 10 tgm-holders-change -> 200
req 11 tgm-holders-hourly-stats -> 200
req 12 wp4t-transactions -> 200
id  state      proxy             egressIp     clearedAt  reqs  last  budget  retiredReason  200/403/429/threw  req/min
--  ---------  ----------------  -----------  ---------  ----  ----  ------  -------------  -----------------  -------
0   healthy    http://sim-ok:9   203.0.113.7  0.4s       11    200   11                     11/0/0/0                  
1   retired    http://sim-bad:9                          2     0     2       broken-proxy   0/0/0/2                   
2   throttled  http://sim-429:9  203.0.113.9  0.4s       1     429   1                      0/0/1/0                   
simulate: broken door retired as expected
cleanup: closed 2 doors
SMOKE_EXIT=0
```

Observations from the run: door 1 retired `reason=broken-proxy` after 2 transport fails; requery to door 2 hit a 429, so request 2 returned `502`; the next 10 requests returned 200. `cleanup: closed 2 doors`, not 3, because the pool already closed the retired door (documented deviation, see (f)).

## (f) Deviations and gaps (from `issues.md`, all 7 recorded)

1. **D3 vs test contradiction (403-real).** `decisions.md:41` says a real 403 while probation goes straight to `penalized`. Test 7b (`server/test/door-pool.test.ts:444-447`) pins: the FIRST real 403 re-warms and returns the door to `probation`; only a second consecutive real 403 (streak ≥ 2, reset on 200) penalizes (`door-pool.test.ts:433`). Implementation follows the test (streak-based, no healthy/probation distinction). Cost: a repeat offender costs one extra re-warm before backoff.
2. **`createCircuitBreaker` unwired.** Still exported (`crawl.ts:648`), `crawl-breaker.test.ts` green, but no live-path caller (grep in (d3)). The pool replaces it with per-door transport-fail retirement. Plan T3 said "breaker khong con rebuild loop", read as removing it from the live path. Cost: no global fast-fail; add by re-wiring inside `getPool()` if needed.
3. **`crawlWarmupTimeoutMs` used twice.** Used for the `goto` timeout AND for the budget poll measured from before `goto` (`crawl.ts:571-579`), so worst-case warmup is about 2× the configured 30s, vs the single 30s implied by D3. Not pinned by any test; accepted.
4. **Smoke `--simulate`: "cleanup: closed 2 doors" not 3.** The pool closes the retired door itself, so the harness skips a record that is already closed. Harness not modified (per instruction); exit 0 and the full door table print.
5. **`dispatch(d, url, body, path)` has 4 params** (`crawl.ts:342`). Private method; `path` is passed to avoid recomputing. A >3-param smell, not worth a value object.
6. **`crawl.ts` is 803 lines (691 non-comment-non-blank), above the 250 LOC ceiling** of the programming skill. The task mandates implementing inside `crawl.ts` and forbids new `src` files, so this is a deliberate, recorded deviation.
7. **Dirty-worktree check without git.** mtimes in (b) prove only `crawl.ts` changed in the implementation session (10:57), `config.ts` (09:51) is T1, `test/door-pool.test.ts` (10:12) is T2. `dist/*` is regenerated by the mandatory `npm run build` (derived, not source).

Additional pinned interpretations from `issues.md` (T2 contract gaps, not counted in the 7): `ProxySpec.url` semantics not frozen (test asserts host:port + exact creds); `DoorStat.budgetUsed` semantics not frozen (asserted only where both readings agree); single-door 429 requery returns `{status: original|502, json:null}` immediately per D5, and the next request waits for the slot per D7; a penalized door counts as a living door (waits out backoff, not an immediate 503).

## (g) Proxy reality (no credentials printed)

`data/proxies.txt` is 1349 bytes, mtime 2026-09-22_T10:46, created by the owner via `.probe/proxy-scan.mjs`. Counts only (command `awk` over the file, printing totals, never the lines):

```bash
awk 'BEGIN{t=0;h=0;n=0;c=0} {line=$0; sub(/^[ \t]+/,"",line); if(line==""){next} t++; if(line ~ /^#/){c++; next} if(line ~ /^https?:\/\//){h++} else {n++}} END{printf "total_nonblank=%d\nhttp_s=%d\nnon_http=%d\ncomments=%d\n", t,h,n,c}' data/proxies.txt
```

```
total_nonblank=39
http_s=3
non_http=32
comments=4
```

Reading: 39 non-blank lines including 4 comments, so 35 data lines = 3 `http(s)` + 32 non-http. Per D2 the 32 non-http lines are skipped (Chrome cannot auth SOCKS), so the pool boots 3 doors. Consequence: the effective throughput ceiling is 3 doors × budget, not the N the plan sized for. Whether those 3 http proxies are alive is unverified here (no real-chrome test run; F4). This is an open question for the owner.

## (h) Risks and owner-gated items

| Risk / item | Status | Evidence or reason |
|---|---|---|
| `NANSEN_API_KEY` exposed | Owner action, NOT verified | Outside plan scope; warning only in `.env.example` + design doc |
| RAM free on prod server (OQ1, caps N) | Verified 2026-09-22 | 50 GB total / about 37 GB available -> D9 leaves room for many doors |
| Real proxy liveness (3 free http rows) | Verified dead-ish | F4 real chrome: CF 403 interstitial via the 3 free proxies; 1 known-good door added later - section (k) |
| 3-door ceiling vs plan sizing | Verified (counts) / open question | `awk` counts in (g); 32 non-http skipped per D2 |
| `createCircuitBreaker` unwired | Verified | grep in (d3): no live caller; `crawl-breaker.test.ts` still green (155/155) |
| `crawl.ts` 803 lines over 250 LOC ceiling | Verified | `wc -l server/src/crawl.ts` → 803 (691 non-comment-non-blank) |
| Warmup worst-case about 2× timeout | NOT verified by test | Code inspection `crawl.ts:571-579`; accepted deviation #3 |
| D3 vs test 403 interpretation | Verified | test 7b green (`door-pool.test.ts:444-447`, run in c2) |
| Fake-clock budget window / quarantine | Verified | 13/13 door-pool tests pass; no real sleeps |

## (i) Verification commands summary

| Command | Result |
|---|---|
| `date +%F` | `2026-09-22` |
| `cd server && npm run build` | exit 0 |
| `npx tsx --test test/door-pool.test.ts` (×2) | 13 pass / 0 fail, twice |
| `npm test` | 155 pass / 0 fail, duration 3456.79ms |
| `npx tsx ../.probe/door-pool-smoke.mjs --simulate` | exit 0, door 1 retired broken-proxy, 10×200 after |
| `grep -n "sleep(4000)\|status !== 403" server/src/crawl.ts` | empty (exit 1) |
| `grep -c "retry-after" server/src/crawl.ts` | 6 |
| `ls -l --time-style=+%F_T%H:%M server/src/*.ts server/test/*.ts` | only config.ts/crawl.ts/door-pool.test.ts recent |
| `awk` counts over `data/proxies.txt` | 35 data lines = 3 http + 32 non-http |

## (j) Scope note

T7 only created this file and appended one line to `.omo/notepads/nansen-proxy-routing/learnings.md`. No code, test, config, compose, or plan file was modified. No git, no deploy, no ssh, no `docker compose up`. Final Wave F1 to F4 is run by the orchestrator, not approved here.

## (k) Post-plan (out of plan scope, owner-requested 2026-09-22): server egress proxy door

The plan scope ended at F4. The owner then asked to test `167.86.101.228` as an egress and to check whether the system still runs without any proxy. Both were measured; no plan file was changed.

| Step | Command / check | Result |
|---|---|---|
| No-proxy behaviour (set 1) | `CRAWL_PROXY_FILE` unset / ENOENT / empty / comment-only / all-socks / 1 dead http | every case: warn or silent skip, then `loaded 0 proxies -> 1 doors`, single fallback door from `CRAWL_WS_ENDPOINT`, no crash, no throw |
| No-proxy behaviour (set 2) | dead `CRAWL_WS_ENDPOINT` | `[door 0] warmup-fail ... state=retired` then `[pool] no door budget for token-god-mode - skip`, caller gets `{status:503,json:null}` |
| No-proxy behaviour (set 3) | live chrome, no proxy, real path `tgm-holders-hourly-stats` | warmup-ok, then 403 interstitial -> re-warm -> retire; caller `{status:403}`. Local IP is CF-challenged; that is the reason the pool exists |
| Port scan of the server | TCP probe 22/80/443/3000/3128/3129/8080/8888/8118/1080 | only `22` (ssh) and `3001` (web, 302 -> `/login`); no proxy service listening |
| Reuse an existing one? | `docker inspect market-data-service-proxy-router-1` | custom python app (`python -m app.main`, `PROXIES_CONFIG=/app/proxies.yaml`), `8888/tcp` NOT published, and not an HTTP CONNECT proxy (`curl -x` rc=56) -> not reusable as a door |
| Provision | `apt-get install -y tinyproxy` (1.11.1-3ubuntu0.1), `/etc/tinyproxy/tinyproxy.conf` = `Port 31128`, `Listen 0.0.0.0`, `BasicAuth nansen <40 hex>`, `Allow 127.0.0.1`, `Allow 118.71.50.141` | `systemctl is-active tinyproxy` = active, `ss -ltn` = `0.0.0.0:31128` |
| Egress proof (server side) | `curl --proxy http://127.0.0.1:31128 ... https://api.ipify.org` | `167.86.101.228` |
| Egress proof (from this machine) | `curl --proxy http://<auth>@167.86.101.228:31128 ... https://api.ipify.org` | `167.86.101.228` -> the provider does not block the port |
| Real chrome door test | `cd server && PROXY_FILE=/tmp/opencode/server-proxy.txt npx tsx ../.probe/door-pool-smoke.mjs --doors 1 --broken 0` | `starting 1 doors (proxies=1)`, warmup-ok, 4x 403 interstitial -> re-warm, `promoted path=tgm-holders-hourly-stats status=200`, `state=healthy`, table `2/4/0/0` (200/403/429/threw), `cleanup: closed 1 doors`, exit 0 |
| Parse after adding the line | `parseProxyFile(data/proxies.txt)` | 4 valid http specs (3 pre-existing free ones + the server door) |
| Activation state | `grep ^CRAWL_ server/.env` | not set (no `server/.env` exists) -> the running config still boots the single fallback door |

Interpretation: the server IP passes Cloudflare for Nansen (two HTTP 200). A freshly cooled door is not yet trusted for the XHR path, so the first probes come back to the caller as an interstitial 403 while the door re-warms; after promotion the same paths return 200. This is the first real-proxy door observed healthy - F4 only had CF-403 free proxies.

Owner actions for this proxy: rotate by rewriting `/etc/tinyproxy/tinyproxy.conf` and the matching line in `data/proxies.txt` (both hand-edited, list change = restart the system); disable with `systemctl disable --now tinyproxy`; remove with `apt-get purge -y tinyproxy`. The `Allow 118.71.50.141` rule is the owner's current home IP, so a dynamic-IP change breaks the door until the rule is updated. The password lives only in the server config and `data/proxies.txt` (checked: 0 occurrences outside `data/`).

Out-of-plan actions taken for this section: ssh to the owner server, one apt install, one service enable, one appended line in `data/proxies.txt`. No code, test, compose, or plan file touched.

EVIDENCE_RECORDED: /home/namvt/Desktop/dev-space/signal_scan/evidence/2026-09-22-door-pool-plan-execution.md
