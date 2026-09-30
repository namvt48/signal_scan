# Task 20 — Metrics / observability endpoint

Plan: `.omo/plans/request-plane-gateway.md` (block lines 249-255) · Branch `feat/fomo-user-watch` · Direct mode.
Date: 2026-09-30 (UTC).

## What shipped

- `server/src/gateway/app.ts` — `GET /metrics` now behind `requireCaller(tokens)` (any valid
  caller token `a|b|watcher`; absent/invalid Bearer = 401). Body combines
  `limiters.snapshot()` (EVERY limiter key), `credits.snapshot()` (`{day,budget,half,used:{a,b}}`)
  and `cache.stats()`. JSON by default, plus a `text` member carrying the plain-text summary;
  `?format=text` returns only the `text/plain` summary. Read-only. No metrics dependency.
- `server/src/gateway/cache.ts` — added `hits`/`misses` counters (incremented in the existing
  lookup path) + `stats(): CacheStats` = `{hits,misses,joined,size,inflight}`. Existing
  `size()/inflightCount()/joinedCount()` untouched.
- `server/test/gateway/metrics.test.ts` — new test (3 cases).

## Acceptance criteria (plan:253)

1. `curl -s -H "Authorization: Bearer $TOKEN" localhost:8130/metrics` returns JSON containing
   every limiter key plus `credits{a,b}` and the cache counters. — PROVEN below.
2. A test asserts the JSON shape. — PROVEN below.
3. Unauthenticated `/metrics` returns 401. — PROVEN below.

## Command 1 — typecheck

```
$ cd server && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

## Command 2 — focused metrics test (node:test via tsx)

```
$ cd server && npx tsx --test test/gateway/metrics.test.ts
2026-09-30T12:08:23.613Z INFO  [gateway] method=GET path=/metrics status=401 dur=4
2026-09-30T12:08:23.626Z INFO  [gateway] method=GET path=/metrics status=401 dur=1
✔ GET /metrics without or with a bogus Bearer is 401 (38.24415ms)
2026-09-30T12:08:23.631Z INFO  [gateway] method=GET path=/metrics status=200 dur=1
✔ GET /metrics returns every limiter key + credits{a,b} + cache counters (4.221496ms)
2026-09-30T12:08:23.651Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=12
2026-09-30T12:08:23.654Z INFO  [gateway] method=POST path=/v1/dexscreener status=200 dur=1
2026-09-30T12:08:23.657Z INFO  [gateway] method=GET path=/metrics status=200 dur=1
✔ a cacheable call increments cache.hits and ?format=text renders the figures (25.673972ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 721.666966

$ echo $?
0
```

## Command 3 — full suite (baseline was 523/523)

```
$ cd server && npm test; echo "NPM_TEST_EXIT=$?"
ℹ tests 526
ℹ pass 526
ℹ fail 0
NPM_TEST_EXIT=0
```

523 baseline + 3 new metrics tests = 526. Green.

## Command 4 — live HTTP proof on loopback :8130

Booted the REAL `createGatewayApp({ tokens })` on `127.0.0.1:8130` (temp runner
`/tmp/opencode/metrics-smoke.mts`, not committed), then curled.

```
$ curl -s -H "Authorization: Bearer e2e-token-a" http://127.0.0.1:8130/metrics \
    -o .omo/evidence/request-plane-gateway/task-20-metrics.json -w 'HTTP %{http_code}\n'
HTTP 200

$ curl -s http://127.0.0.1:8130/metrics -w ' (HTTP %{http_code})\n'
{"error":"unauthorized"} (HTTP 401)

$ curl -s -H "Authorization: Bearer bogus" http://127.0.0.1:8130/metrics -w ' (HTTP %{http_code})\n'
{"error":"unauthorized"} (HTTP 401)

$ curl -s -H "Authorization: Bearer e2e-token-w" "http://127.0.0.1:8130/metrics?format=text"
gateway ok=true caller=watcher
credits day=2026-09-30 budget=10 half=5 used_a=0 used_b=0
cache hits=0 misses=0 joined=0 size=0 inflight=0
limiter gmgn inFlight=0 queued=0 gateUntil=0 windowUsed=0
limiter solana-rpc inFlight=0 queued=0 gateUntil=0 windowUsed=0
limiter nansen-credit inFlight=0 queued=0 gateUntil=0 windowUsed=0
limiter nansen-door inFlight=0 queued=0 gateUntil=0 windowUsed=0
limiter dexscreener inFlight=0 queued=0 gateUntil=0 windowUsed=0
limiter dexscreener-profiles inFlight=0 queued=0 gateUntil=0 windowUsed=0
(HTTP 200)
```

Captured authed JSON artifact: `.omo/evidence/request-plane-gateway/task-20-metrics.json`

Verbatim body (single line, truncated nowhere):

```json
{"ok":true,"caller":"a","ratelimit":{"gmgn":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0},"solana-rpc":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0},"nansen-credit":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0},"nansen-door":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0},"dexscreener":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0},"dexscreener-profiles":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0}},"credits":{"day":"2026-09-30","budget":10,"half":5,"used":{"a":0,"b":0}},"cache":{"hits":0,"misses":0,"joined":0,"size":0,"inflight":0},"text":"gateway ok=true caller=a\ncredits day=2026-09-30 budget=10 half=5 used_a=0 used_b=0\ncache hits=0 misses=0 joined=0 size=0 inflight=0\nlimiter gmgn inFlight=0 queued=0 gateUntil=0 windowUsed=0\nlimiter solana-rpc inFlight=0 queued=0 gateUntil=0 windowUsed=0\nlimiter nansen-credit inFlight=0 queued=0 gateUntil=0 windowUsed=0\nlimiter nansen-door inFlight=0 queued=0 gateUntil=0 windowUsed=0\nlimiter dexscreener inFlight=0 queued=0 gateUntil=0 windowUsed=0\nlimiter dexscreener-profiles inFlight=0 queued=0 gateUntil=0 windowUsed=0"}
```

Observed in the artifact: all SIX limiter keys (`gmgn`, `solana-rpc`, `nansen-credit`,
`nansen-door`, `dexscreener`, `dexscreener-profiles` — the `dexscreener` key still exists),
`credits.used{a:0,b:0}`, and `cache{hits,misses,joined,size,inflight}`.

### Counter-move proof (from Command 2, the `?format=text` assertion)

After one DexScreener `tokens` call by caller `a` and one identical call by caller `b`, the
second was a cross-caller cache HIT (`dexscreener` limiter `windowUsed=1`, upstream calls=1).
The text summary asserted: `cache hits=1 misses=1 joined=0 size=1 inflight=0`.

## QA scenarios

- Happy: authenticated `/metrics` JSON contains every limiter key + credit counters + cache
  counters; `?format=text` yields the text/plain summary (Commands 2 & 4).
- Failure: unauthenticated `/metrics` (absent header AND bogus token) returns 401
  `{"error":"unauthorized"}` (Commands 2 & 4).

## Deviation / blocker

None. No metrics dependency added; route stays token-gated; GMGN caching untouched; no
secrets written; no git add/commit.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-20-request-plane-gateway.md
