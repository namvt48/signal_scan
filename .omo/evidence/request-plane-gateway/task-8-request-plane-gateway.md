# Task 8 — GMGN endpoint behind `gmgn` weight bucket (NEVER cached)

Plan: `.omo/plans/request-plane-gateway.md` (todo 8, approved round 9).
Scope: new GMGN gateway module + minimal route registration + gmgn 403 cooldown in the spec.

## Files created / modified

- **NEW** `server/src/gateway/gmgn.ts` — the `gmgn/token-info` route: parses `{ca, chain, priority}`, maps chain → gmgn slug, runs the call through `proxyRequest` with `runOpts: {weight: GMGN_TOKEN_INFO_WEIGHT}` (so `limiters.run('gmgn', {weight, priority})`), and exposes `gmgnTokenInfoUpstream()` which adds a FRESH `client_id` + `timestamp` and the gateway-held `X-APIKEY`. Documented as EXCLUDED from the todo-11 cache/single-flight.
- **MODIFIED** `server/src/gateway/app.ts` (surgical, additive) — added `gmgnUpstream?: UpstreamFetch` to `GatewayAppDeps`, hoisted one shared JSON-body middleware (parse error → 400 like `/v1/proxy`), and registered `POST /v1/gmgn/token-info` behind `requireCaller` mirroring the `/v1/proxy` pattern. GMGN 403 flows through `proxyRequest` → `UpstreamError` → `Limiter.handleError` → `Gate.note(403)` (gate armed).
- **MODIFIED** `server/src/ratelimit/spec.ts` — gmgn gate now carries `statusesWithCooldown: [{ status: 403, cooldownMs: resolveNum('RL_GMGN_403COOLDOWNMS', 600_000) }]`. Comment states the plan-mandated assumption (GMGN returns 403 only for the egress-IP allowlist `AUTH_IP_BLOCKED`) and that the shared `Gate`/`HttpError` surface is deliberately untouched. 429 keeps its `x-ratelimit-reset` header arm unchanged.
- **NEW** `server/test/gateway/gmgn.test.ts` — 7 tests covering the plan acceptance criteria.

No writes to `contract.ts` / `auth.ts` / `main.ts` / `door.ts`; no DexScreener/Nansen route touched; no commit.

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

## 2. `cd server && npm test` — full suite (green)

Command:
```
cd server && npm test
```
Tail (verbatim):
```
✔ zeroScoreGate: deletes the same 0/3 CA once its wallet has dumped the position (2.168563ms)
ℹ tests 469
ℹ suites 0
ℹ pass 469
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32455.512281
```
Exit status: `0` (`NPMTEST_EXIT=0`).

GMGN cases inside the full run (verbatim):
```
✔ (a) the weight + priority reach the gmgn limiter call (142.102626ms)
✔ (b) a weight-1 call consumes the bucket; the next call is DELAYED, not rejected (1031.948417ms)
✔ (c) two identical GMGN calls produce TWO upstream calls (never cached/deduped) (61.301374ms)
✔ (d) the real fetcher adds a FRESH client_id + timestamp and sends X-APIKEY (15.410235ms)
✔ (e) an upstream 403 surfaces as status:403 AND arms the gate; the next call backs off (26.696014ms)
✔ the route is caller-gated and rejects a bad body without calling upstream (25.215291ms)
```

## 3. Isolated run of the new spec (verbatim, with the observable delays)

Command:
```
cd server && npx tsx --test test/gateway/gmgn.test.ts
```
Output (verbatim):
```
✔ parseGmgnTokenInfo validates ca / chain / priority at the trust boundary (2.252065ms)
2026-09-30T09:54:59.606Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=200 dur=15
✔ (a) the weight + priority reach the gmgn limiter call (58.627888ms)
2026-09-30T09:54:59.624Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=200 dur=1
2026-09-30T09:55:00.625Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=200 dur=997
✔ (b) a weight-1 call consumes the bucket; the next call is DELAYED, not rejected (1012.688846ms)
2026-09-30T09:55:00.633Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=200 dur=1
2026-09-30T09:55:00.634Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=200 dur=0
✔ (c) two identical GMGN calls produce TWO upstream calls (never cached/deduped) (9.280507ms)
✔ (d) the real fetcher adds a FRESH client_id + timestamp and sends X-APIKEY (2.214696ms)
2026-09-30T09:55:00.644Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=200 dur=2
2026-09-30T09:55:00.647Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=503 dur=1
✔ (e) an upstream 403 surfaces as status:403 AND arms the gate; the next call backs off (10.575353ms)
2026-09-30T09:55:00.653Z INFO  [gateway] method=POST path=/gmgn/token-info status=401 dur=1
2026-09-30T09:55:00.657Z INFO  [gateway] method=POST path=/v1/gmgn/token-info status=400 dur=1
✔ the route is caller-gated and rejects a bad body without calling upstream (9.227489ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1772.866507
```
Exit status: `0` (`STANDALONE_EXIT=0`).

## Mapping acceptance criteria → observable

| Acceptance criterion | Test | Binary observable |
|---|---|---|
| weight-1 request consumes 1 token; empty bucket DELAYS (not rejects) | `(b)` | `buildSpecs(1)` ⇒ capacity 1/refill 1/s. First POST `dur=1ms`; second POST `dur=997ms` and **status=200** (queued, not rejected). |
| two identical GMGN requests → TWO upstream calls (no cache/dedupe) | `(c)` | two concurrent identical POSTs → `seen.length === 2`; both `status=200`. |
| upstream 403 → distinct status AND arms gate; next call backs off | `(e)` | 1st POST HTTP 200 `envelope.status=403` (`body:null`); `snapshot().gmgn.gateUntil > now`; 2nd POST HTTP **503** `{error:"gated"}` + `x-gateway-gated-until`; `calls === 1` (blocked egress NOT retried). |
| fresh `client_id` + timestamp preserved (excluded from cache/single-flight) | `(d)` + `(c)` | `(d)`: two fetcher calls → distinct `client_id`, `timestamp > 0`, `X-APIKEY` sent. `(c)`: no single-flight collapse. |
| per-request weight passes through `limiters.run('gmgn', {weight, priority})` | `(a)` | recorded limiter call: `api='gmgn'`, `opts.weight=GMGN_TOKEN_INFO_WEIGHT`, `opts.priority=0`, `opts.path='/v1/token/info'`. |

## 4. gmgn 403 cooldown spec (verbatim)

`server/src/ratelimit/spec.ts` gmgn gate after the edit:
```ts
      gate: {
        statuses: [429],
        statusesWithCooldown: [
          { status: 403, cooldownMs: resolveNum('RL_GMGN_403COOLDOWNMS', 600_000) },
        ],
        header: 'x-ratelimit-reset',
      },
```

## 5. Git status (no commit)

```
$ git status --porcelain -- server/
 M server/src/gateway/app.ts
 M server/src/ratelimit/spec.ts
?? server/src/gateway/gmgn.ts
?? server/test/gateway/gmgn.test.ts
```

Deviation/blocker: none. `npx tsc --noEmit` typechecks `src` only (tsconfig excludes `test`), so the new spec is exercised via `tsx --test` (shown above). The 403 gate matches numeric status only, so the code comment records the plan-mandated assumption that GMGN 403 means the egress-IP allowlist.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-8-request-plane-gateway.md
