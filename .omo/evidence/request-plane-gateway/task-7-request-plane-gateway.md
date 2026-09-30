# Task 7 — Nansen credit endpoint behind `nansen-credit` limiter (both seams)

Plan: `.omo/plans/request-plane-gateway.md` (todo 7, line 141). Direct mode.
Scope: NEW Nansen gateway module + minimal additive route registration in `app.ts` + NEW gateway spec.

## Files created / modified

- **NEW** `server/src/gateway/nansen.ts` — BOTH Nansen seams:
  - **(i) credit API** `POST /v1/nansen/credit`: body `{endpoint, body, priority?}`; `endpoint` is
    SSRF-resolved against `https://api.nansen.ai` (must start `/`, `new URL` normalizes, host must be
    `api.nansen.ai`, else 400). Runs through `proxyRequest` with `provider: 'nansen-credit'`, so the
    call reaches `limiters.run('nansen-credit', {priority})` (the `provider` field is the limiter key).
    Covers every `NansenApiClient` method: `tokenFlows` (LIVE chart path), `tokenInformation`,
    `dexTrades`, `currentBalance`. `nansenCreditUpstream()` POSTs to `api.nansen.ai<path>` with the
    gateway-held `apikey` header and returns the RAW upstream text.
  - **(ii) free browser door** `POST /v1/nansen/door`: body `{endpoint, body}`; `endpoint` is one of the
    three pinned app-question slugs (`tgm-essential-data`, `tgm-volume-details`,
    `tgm-holders-gini-stats`) — an allowlist, so an authenticated caller cannot aim the browser at an
    arbitrary URL. Dispatches through the RELOCATED DoorPool (`gateway/door.ts` `browserPostJson`),
    which owns its own per-path/per-door budgets. The never-wired `nansen-door` limiter spec stays
    unwired so it cannot double-govern. `doorEndpointFor(url)` + `NANSEN_DOOR_URLS` pin the URL→endpoint
    map for the todo-13 adapter.
  - Both seams return the RAW payload in the todo-3 envelope `{status, body, headers}`; no provider
    parsing is re-implemented (the door's in-page transport JSON-parses once, so the door route only
    re-serializes that already-parsed value — documented in the module header).
- **MODIFIED** `server/src/gateway/app.ts` (surgical, additive): imported `browserPostJson` alongside
  the existing `poolStatsOrNull`; added `nansenCreditUpstream?: UpstreamFetch` + `nansenDoor?: DoorPost`
  to `GatewayAppDeps`; registered the two `POST` routes after the DexScreener route and before the
  `/v1` 404, mirroring the GMGN/DexScreener route shape (`parseJson` → caller check → handler → `send`).
  GMGN/DexScreener routes untouched.
- **NEW** `server/test/gateway/nansen.test.ts` — 10 tests covering the plan acceptance criteria with
  stubbed upstreams.

No writes to `contract.ts` / `auth.ts` / `main.ts` / `door.ts` / `crawl.ts` / providers / config /
index / poller. No `git add` / commit.

## 1. `cd server && npx tsc --noEmit`

Command:
```
cd server && npx tsc --noEmit
```
Output (verbatim; empty = clean) + exit:
```
TSC_EXIT=0
```
Exit status: `0`.

## 2. `cd server && npm test` — full suite (green)

Command:
```
cd server && npm test
```
Nansen cases inside the full run (verbatim):
```
✔ parseNansenCredit validates the API path at the trust boundary (SSRF guard) (7.014578ms)
✔ parseNansenDoor allowlists the app-question endpoints (0.481792ms)
✔ (a) the credit route calls upstream ONCE, returns the raw body, and passes priority to nansen-credit (117.909033ms)
✔ (b) the free-door route calls the DoorPool ONCE and returns the raw body (25.305097ms)
✔ (c) an upstream 429 propagates status + x-ratelimit-reset and is NOT swallowed (24.360392ms)
✔ (c2) a DoorPool 429 propagates as a distinct envelope status (27.868877ms)
✔ (d) a second concurrent credit call is QUEUED by the concurrency cap — never dropped (53.119359ms)
✔ the real credit fetcher POSTs to api.nansen.ai with the gateway-held apikey (5.464223ms)
✔ both routes are caller-gated and reject a bad body without calling upstream (35.362236ms)
```
Tail (verbatim):
```
ℹ tests 488
ℹ suites 0
ℹ pass 488
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31716.14714
```
Exit status: `0` (`NPMTEST_EXIT=0`). Baseline before todo 7 was 478 tests; +10 = 488.

## 3. Isolated run of the new spec (verbatim)

Command:
```
cd server && npx tsx --test test/gateway/nansen.test.ts
```
Output (verbatim):
```
✔ parseNansenCredit validates the API path at the trust boundary (SSRF guard) (2.285256ms)
✔ parseNansenDoor allowlists the app-question endpoints (0.270033ms)
✔ doorEndpointFor maps the three provider URLs to their gateway endpoints (0.232569ms)
2026-09-30T10:10:27.989Z INFO  [gateway] method=POST path=/v1/nansen/credit status=200 dur=17
✔ (a) the credit route calls upstream ONCE, returns the raw body, and passes priority to nansen-credit (61.838336ms)
2026-09-30T10:10:28.008Z INFO  [gateway] method=POST path=/v1/nansen/door status=200 dur=2
✔ (b) the free-door route calls the DoorPool ONCE and returns the raw body (12.617333ms)
2026-09-30T10:10:28.015Z INFO  [gateway] method=POST path=/v1/nansen/credit status=200 dur=1
✔ (c) an upstream 429 propagates status + x-ratelimit-reset and is NOT swallowed (6.841418ms)
2026-09-30T10:10:28.022Z INFO  [gateway] method=POST path=/v1/nansen/door status=200 dur=1
✔ (c2) a DoorPool 429 propagates as a distinct envelope status (7.028406ms)
2026-09-30T10:10:28.038Z INFO  [gateway] method=POST path=/v1/nansen/credit status=200 dur=9
2026-09-30T10:10:28.044Z INFO  [gateway] method=POST path=/v1/nansen/credit status=200 dur=14
2026-09-30T10:10:28.044Z INFO  [gateway] method=POST path=/v1/nansen/credit status=200 dur=11
✔ (d) a second concurrent credit call is QUEUED by the concurrency cap — never dropped (22.714666ms)
✔ the real credit fetcher POSTs to api.nansen.ai with the gateway-held apikey (1.207774ms)
2026-09-30T10:10:28.053Z INFO  [gateway] method=POST path=/nansen/credit status=401 dur=0
2026-09-30T10:10:28.056Z INFO  [gateway] method=POST path=/nansen/door status=401 dur=0
2026-09-30T10:10:28.060Z INFO  [gateway] method=POST path=/v1/nansen/credit status=400 dur=1
2026-09-30T10:10:28.063Z INFO  [gateway] method=POST path=/v1/nansen/door status=400 dur=1
✔ both routes are caller-gated and reject a bad body without calling upstream (16.306529ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 842.662823
STANDALONE_EXIT=0
```
Exit status: `0`.

## Mapping acceptance criteria → observable

| Acceptance criterion (plan todo 7) | Test | Binary observable |
|---|---|---|
| credit route calls upstream exactly ONCE and returns the raw body | `(a)` | `calls === 1`; `envelope.body === '{"data":[{"date":"2026-09-30","value_usd":42}]}'` byte-verbatim; `rec.calls[0].api === 'nansen-credit'`, `opts.priority === 1`, `opts.path === '/api/v1/tgm/flows'`. |
| free-door route calls upstream exactly ONCE and returns the raw body | `(b)` | `seen.length === 1`; `seen[0].url === 'https://app.nansen.ai/api/questions/tgm-holders-gini-stats'`; `envelope.body === JSON.stringify({data:[{totalBalance:208428160}]})`. |
| upstream 429 propagates status + `x-ratelimit-reset` (not swallowed) | `(c)` | HTTP 200 envelope: `envelope.status === 429`, `envelope.body === null`, `envelope.headers['x-ratelimit-reset'] === '1700000000'`; transport header is null (allowlist rides the envelope); `calls === 1`. |
| DoorPool 429 propagates as a distinct status | `(c2)` | `envelope.status === 429`, `envelope.body === null`, `calls === 1`. |
| a SECOND CONCURRENT credit call is QUEUED by the concurrency cap (not dropped) | `(d)` | Real `Limiter` `maxConcurrency=2`: after 2 in-flight, `snapshot().inFlight === 2`; 3rd request → `snapshot().queued === 1` with `calls === 2`; after a slot frees `calls === 3` and ALL THREE resolve `envelope.status === 200` (never dropped). |
| both seams routed through the gateway, no direct upstream | `(a)`+`(b)` + git status | Neither route touches upstream directly; `app.ts` wires both behind `requireCaller`; only `gateway/nansen.ts` + `gateway/app.ts` changed. |
| trust boundary: bad body → 400, no upstream; missing token → 401 | last test | `creditCalls === 0`, `doorCalls === 0`; credit off-host path (`https://evil.example/x`) and unknown door slug both 400. |

## 4. Git status (no commit)

```
$ git status --porcelain -- server/
 M server/src/gateway/app.ts
?? server/src/gateway/nansen.ts
?? server/test/gateway/nansen.test.ts
```

Forbidden-path diff check (empty = untouched):
```
$ git status --porcelain -- server/src/gateway/gmgn.ts server/src/gateway/dexscreener.ts \
    server/src/gateway/contract.ts server/src/gateway/auth.ts server/src/gateway/main.ts \
    server/src/gateway/door.ts server/src/crawl.ts server/src/providers server/src/config.ts \
    server/src/index.ts server/src/poller.ts
(no output)
```

Deviation/blocker: none. `npx tsc --noEmit` typechecks `src` only (tsconfig excludes `test`); the new
spec is exercised via `tsx --test` above. Retries are NOT added outside the limiter — the credit seam
runs through `proxyRequest`, whose non-2xx throws `UpstreamError` INSIDE `limiters.run` so only the
`nansen-credit` limiter's fibo retry runs. The door route intentionally does not use a limiter key;
the relocated DoorPool budgets govern it.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-7-request-plane-gateway.md
