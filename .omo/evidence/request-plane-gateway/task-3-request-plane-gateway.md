# Task 3 evidence - raw-payload proxy contract + types

Plan: `.omo/plans/request-plane-gateway.md`, todo `- [ ] 3. Raw-payload proxy contract + types`.
Scope: `server/src/gateway/contract.ts` (NEW), `server/src/gateway/app.ts` (minimal dispatch wiring),
`server/test/gateway/contract.test.ts` (NEW). No other files touched.

## Files

```
 M server/src/gateway/app.ts            (wire POST /v1/proxy through the contract)
?? server/src/gateway/contract.ts       (NEW: request/response types + builders + helpers)
?? server/test/gateway/contract.test.ts (NEW: 6 specs)
```

## Command 1 - `cd server && npx tsc --noEmit`

```
$ cd server && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

## Command 2 - `cd server && npm test` (full suite)

```
ℹ tests 456
ℹ suites 0
ℹ pass 456
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30716.353946
```

Count rose 450 -> 456 (+6), proving the new `test/gateway/*.test.ts` glob (todo 1)
actually ran the new spec.

## Command 3 - the contract spec, verbatim (`cd server && npx tsx --test test/gateway/contract.test.ts`)

```
✔ filterHeaders keeps only the four-entry allowlist (case-insensitive, Headers or map) (27.979423ms)
2026-09-30T09:40:43.346Z INFO  [gateway] method=POST path=/v1/proxy status=200 dur=17
✔ round-trips the raw upstream body byte-identically with the four allowlisted headers (65.569871ms)
2026-09-30T09:40:43.364Z INFO  [gateway] method=POST path=/v1/proxy status=200 dur=1
✔ the request body reaches upstream unchanged and priority reaches the limiter call (12.579873ms)
2026-09-30T09:40:43.374Z INFO  [gateway] method=POST path=/v1/proxy status=200 dur=1
✔ an upstream 429 rides INSIDE HTTP 200 as status:429 + x-ratelimit-reset, body null, no throw (9.714529ms)
2026-09-30T09:40:43.384Z INFO  [gateway] method=POST path=/v1/proxy status=200 dur=2
2026-09-30T09:40:43.390Z INFO  [gateway] method=POST path=/v1/proxy status=503 dur=2
✔ an armed limiter gate maps the next call to 503 {error:"gated"} + x-gateway-gated-until (15.582051ms)
2026-09-30T09:40:43.397Z INFO  [gateway] method=POST path=/proxy status=401 dur=0
2026-09-30T09:40:43.401Z INFO  [gateway] method=POST path=/v1/proxy status=400 dur=1
2026-09-30T09:40:43.404Z INFO  [gateway] method=POST path=/v1/proxy status=400 dur=1
✔ gateway-generated denials are non-200 {error:...} (13.07834ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 525.882355
```

## What the assertions pin (todo-3 acceptance)

The upstream is a stub and the limiter runner is injected, so the wire shape is
exercised end to end through the real `createGatewayApp` HTTP layer at
`POST /v1/proxy`.

**(a) raw body byte-identical.** Upstream fixture (whitespace + Unicode + nested JSON):

```
'{\n  "data": { "price": "1.2345", "symbol": "TEST", "note": "héllo 🚀" },\n  "ok": true\n}'
```

`assert.equal(env.body, RAW_BODY)` passes - no re-serialization, no renamed or
dropped field.

**(b) `status` + the four allowlisted headers propagate; (c) a header outside the
allowlist is dropped.** Upstream headers sent: `content-type`,
`retry-after`, `x-ratelimit-reset`, `x-nansen-credits-cost`,
`x-nansen-credits-remaining`, `set-cookie`. Asserted envelope:

```
env.headers == {
  'content-type': 'application/json; charset=utf-8',
  'retry-after': '7',
  'x-ratelimit-reset': '4102444800',
  'x-nansen-credits-cost': '5',
}
'x-nansen-credits-remaining' in env.headers === false
'set-cookie' in env.headers === false
```

**(d) `priority` reaches the limiter call.** `POST` with `priority: 0`; the
injected `runLimiter` recorded `{api:'nansen', opts:{priority:0, path:'/api/v1/tgm/flows'}}`.
Also asserts the request `body` (`{page:1, per_page:1000}`, the tgm-flows
pagination) arrives at the upstream unchanged.

**(e) upstream 429 -> `status:429` inside HTTP 200, `x-ratelimit-reset` in
`headers`, `body:null`, NO exception.** Observed: HTTP `200`; envelope
`{status:429, body:null, headers:{'content-type':'application/json',
'x-ratelimit-reset':'4102444800'}}`. The upstream error body (`{"error":"rate
limited"}`) is NOT forwarded. No throw.

**(f) a gateway-generated denial is a non-200 `{error:...}`.** Observed through
the app:
- 401 `{error:'unauthorized'}` (missing token),
- 400 `{error:'bad_request'}` (missing `endpoint`),
- 400 `{error:'bad_request'}` (body is not valid JSON),
- 503 `{error:'gated'}` + `x-gateway-gated-until` header, produced by a REAL
  `LimiterRegistry`: first request (gmgn, upstream 429 + `x-ratelimit-reset`)
  returns HTTP 200 `status:429` and arms the gmgn gate; the NEXT request hits
  `ratelimit/limiter.ts:58-59` and the handler maps it to the typed 503.

## Wire shape as implemented

- Request `{provider, endpoint, params?, body?, priority?}`; `body` is opaque
  JSON forwarded verbatim (GET-only upstreams omit it); the caller comes from the
  bearer token, never the body.
- Response: every request that reaches an upstream is HTTP 200 with
  `{status, body, headers}` where `status` is the UPSTREAM status and `headers`
  is the fixed four-entry allowlist. Non-2xx upstream error bodies are not
  forwarded (`body:null`) - the gateway throws `HttpError` to arm/retry, matching
  `nansen.ts:360-370`.
- Non-200 replies are gateway-generated `{error:...}` only: 401 / 400 / 429
  (`budget_exceeded`, todo 19) / 503 (`gated`).
- `x-nansen-credits-remaining` deliberately NOT forwarded; `x-nansen-credits-cost`
  IS (todo 19 uses the real per-call cost).

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-3-request-plane-gateway.md
