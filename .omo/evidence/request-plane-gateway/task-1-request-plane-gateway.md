# Evidence — request-plane-gateway · Todo 1: Gateway entrypoint + build target

Plan: `.omo/plans/request-plane-gateway.md` → Wave 1 → `- [ ] 1. Gateway entrypoint + build target`
Date: 2026-09-30 (Asia/Ho_Chi_Minh)
Repo: `/home/namvt/Desktop/dev-space/signal_scan`, branch `feat/fomo-user-watch` (direct mode, no worktree).

## Files (only the todo-1 surface was touched)

| File | Change |
|---|---|
| `server/src/gateway/main.ts` | NEW. HTTP listener on `GATEWAY_PORT` (default 8130), fail-loud port parse, SIGTERM/SIGINT clean exit, direct-execution guard so importing it never binds a port. Imports only `../log.js` (which pulls `config.ts`). |
| `server/Dockerfile.gateway` | NEW. `node:20-slim` → `npm ci` → `npm run build` → `CMD ["node","dist/gateway/main.js"]`. |
| `server/package.json` | scripts only: `+ "gateway:build": "tsc"`, test glob `+ test/gateway/*.test.ts` (2 insertions, 1 deletion). |
| `server/test/gateway/smoke.test.ts` | NEW. Placeholder smoke test exercising `parsePort`; proves the new glob executes it. |

Not touched: `server/src/index.ts`, `server/src/config.ts`, `server/src/crawl.ts`, providers, `docker-compose.yml`, `Makefile`. No new npm dependency. No commit created.

### package.json diff (verbatim)
```diff
diff --git a/server/package.json b/server/package.json
index 1559aaa..984541a 100644
--- a/server/package.json
+++ b/server/package.json
@@ -6,8 +6,9 @@
   "scripts": {
     "dev": "tsx watch src/index.ts",
     "build": "tsc",
+    "gateway:build": "tsc",
     "start": "node dist/index.js",
-    "test": "tsx --test test/*.test.ts test/ratelimit/*.test.ts"
+    "test": "tsx --test test/*.test.ts test/ratelimit/*.test.ts test/gateway/*.test.ts"
   },
   "dependencies": {
     "better-sqlite3": "^11.10.0",
```

---

## V1 — typecheck (acceptance: `npx tsc --noEmit` exits 0)

```
$ cd server && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

## V2 — `npm run gateway:build` produces `server/dist/gateway/main.js` (acceptance)

```
$ cd server && npm run gateway:build 2>&1; echo "BUILD_EXIT=$?"; ls -l dist/gateway/main.js

> signal-scan-server@0.1.0 gateway:build
> tsc

BUILD_EXIT=0
-rw-rw-r-- 1 namvt namvt 2101 Sep 30 16:17 dist/gateway/main.js
```

(`dist/gateway/main.js` refreshed at 16:17, from the tsconfig `rootDir: src` → `outDir: dist` mapping.)

## V3 — `npm test` green, gateway spec EXECUTED (acceptance: placeholder runs)

```
$ cd server && npm test > /tmp/opencode/npmtest-final-green.log 2>&1; echo "TEST_EXIT=$?"
TEST_EXIT=0
$ grep -n "gateway smoke" /tmp/opencode/npmtest-final-green.log
247:✔ gateway smoke: GATEWAY_PORT parses, defaults and fails loud (2.432705ms)
$ tail -8 /tmp/opencode/npmtest-final-green.log
ℹ tests 439
ℹ suites 0
ℹ pass 439
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30848.941425
```

The gateway spec is listed among the run's tests (line 247) — it was previously impossible for a file under `test/gateway/` to be picked up at all.

## V4 — glob is load-bearing (acceptance: temporarily failing assertion makes `npm test` non-zero, then revert)

Added `assert.equal(1, 2, 'TEMP GLOB PROOF: this must fail while the glob is wired');` to the smoke test, ran, then reverted (file is back to its V3 form — re-run V3 above is the post-revert green run).

```
$ cd server && npm test > /tmp/opencode/npmtest-globproof.log 2>&1; echo "TEST_EXIT=$?"
TEST_EXIT=1
$ grep -nE "TEMP GLOB PROOF|gateway smoke|fail [0-9]" /tmp/opencode/npmtest-globproof.log | head -20
247:✖ gateway smoke: GATEWAY_PORT parses, defaults and fails loud (10.948557ms)
784:ℹ fail 1
793:✖ gateway smoke: GATEWAY_PORT parses, defaults and fails loud (10.948557ms)
794:  AssertionError [ERR_ASSERTION]: TEMP GLOB PROOF: this must fail while the glob is wired
```

Exit 1 with the gateway spec as the sole failure proves the glob executes `test/gateway/*.test.ts`.

## V5 — happy path: boot, log line, clean SIGTERM (acceptance)

```
$ cd server && GATEWAY_PORT=8130 node dist/gateway/main.js > /tmp/opencode/gw-boot-happy.log 2>&1 &
$ PID=$!; sleep 1.5; kill -TERM $PID; wait $PID; echo "SIGTERM_EXIT=$?"
SIGTERM_EXIT=0
$ cat /tmp/opencode/gw-boot-happy.log
2026-09-30T09:20:04.394Z INFO  [gateway] listening on :8130 (request-plane skeleton)
2026-09-30T09:20:05.791Z INFO  [gateway] SIGTERM received, shutting down
```

## V6 — failure path: invalid `GATEWAY_PORT` → exit != 0 + error log (acceptance)

```
$ cd server && GATEWAY_PORT=notaport node dist/gateway/main.js > /tmp/opencode/gw-boot-badport.log 2>&1; echo "BADPORT_EXIT=$?"
BADPORT_EXIT=1
$ cat /tmp/opencode/gw-boot-badport.log
2026-09-30T09:20:09.556Z ERROR [gateway] bad config Error:GATEWAY_PORT="notaport" is not a valid port (integer 1-65535)
```

## V7 — listener is real (bonus observable)

```
$ GATEWAY_PORT=8130 node dist/gateway/main.js & PID=$!; sleep 1.2
$ curl -s -o /tmp/opencode/gw-curl-body.txt -w "HTTP_STATUS=%{http_code}\n" localhost:8130/health
HTTP_STATUS=404
$ echo "BODY=$(cat /tmp/opencode/gw-curl-body.txt)"
BODY={"error":"not_found"}
$ kill -TERM $PID; wait $PID; echo "CURLRUN_EXIT=$?"
CURLRUN_EXIT=0
```

## Scope / guardrail check

```
$ cd /home/namvt/Desktop/dev-space/signal_scan && git status --short -- server
 M server/package.json
?? server/Dockerfile.gateway
?? server/src/gateway/
?? server/test/gateway/
```

Only the todo-1 surface is modified/untracked; no commit was made (`git log -1` unchanged / nothing staged). `.omo/` state files shown by full `git status` are the orchestrator's, not touched here.

## Post-write review loop

- `server/src/gateway/main.ts`: 43 pure LOC (≤200 healthy). Single responsibility: gateway process boot. No `any`/`@ts-ignore`/`!`/unused locals or params; no defensive layer; no one-off helper beyond the two exports todo 6 will build on.
- `server/test/gateway/smoke.test.ts`: 12 pure LOC, one Given/When/Then test of the parse contract.
- Logging: reuses the project's `log` (no new logger), errors at `error`, boot/shutdown at `info`.
- No new dependency; no secret read or printed.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-1-request-plane-gateway.md
