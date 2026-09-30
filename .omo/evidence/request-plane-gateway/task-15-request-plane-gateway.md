# Task 15 — TS fail-open / degrade on gateway failure

Plan block: `.omo/plans/request-plane-gateway.md:207-213` (todo 15).
Commit (planned): `feat(server): degrade gracefully when the gateway is unavailable` — **NOT** committed (direct mode; no git add/commit per instructions).

## Deliverable (from the plan)

- Reconcile with the pinned wire shape (todo 3): an upstream non-2xx arrives as **HTTP 200 + `envelope.status`** non-2xx.
- **FAIL-OPEN ONLY on a gateway TRANSPORT failure** (connection error / timeout): log a warning and SKIP that sweep so `poller.ts` continues; the instance keeps serving from its OWN DB (the gateway is read-only). No cross-process stale-cache claim.
- Do **NOT** swallow an upstream non-2xx (`envelope.status` 4xx/5xx) — a real upstream error, surfaced via the typed-error path.
- A gateway-GENERATED 429 (`{error:"budget_exceeded"}`) surfaces as a typed error, is **NEVER retried and NEVER fail-open**.

## Files

| file | change |
|---|---|
| `server/src/gateway-client.ts` | Added the transport error typing. `GatewayTransportError extends Error` is thrown when `fetch` itself rejects (connection refused / reset / DNS / AbortError timeout) — the ONLY fail-open category. `GatewayDenialError extends HttpError` (with the denial `error` code) is thrown on a non-200 gateway answer (401/400/429 budget/503 gated). A malformed 200 envelope stays a plain `HttpError`. |
| `server/src/poller.ts` | `runGatewaySweep(where, body)` — sweep-level guard: catches `GatewayTransportError`, logs `gateway unreachable — sweep skipped` at warn, and skips the whole sweep; rethrows every other error so the existing `run()` typed-error path surfaces it. `logProviderError(e, where, ...fields)` — per-CA guard: rethrows gateway-owned / `HttpError` failures up to `runGatewaySweep`, keeps the pre-existing log-and-continue for everything else. Exported `metricSweep` (test seam) and wrapped `metricSweep`, `symbolBackfillSweep`, `setupSweep`, `flowsSweep` in `runGatewaySweep`. `withRetry` no longer re-issues a `GatewayTransportError` / `GatewayDenialError` (budget 429 never retried). |
| `server/test/gateway/fail-open.test.ts` | NEW — the 4 tests below, driving the REAL `GmgnMarketProvider` → `GatewayClient` chain with an injected fetch. |

Not touched: `solana.ts` / `evm.ts` / `crawl.ts` / `gateway/*` route logic. `walletSweep` (Solana RPC, not gateway-backed) left unchanged.

## Commands + verbatim output

### 1. `cd server && npx tsc --noEmit`

```
TSC_EXIT=0
```

(no diagnostics printed; exit code 0)

### 2. `cd server && npx tsx --test test/gateway/fail-open.test.ts`

```
2026-09-30T10:55:53.748Z WARN  gmgn token/info ca=CA-FAILOPEN-111111111111111111111111111111 chain=sol dur=28 err=HttpError:gmgn token/info 400
✔ todo15: a fetch rejection is typed GatewayTransportError (the fail-open input) (2.006746ms)
✔ todo15: gateway UNREACHABLE → the sweep completes without throwing and warns (1.239913ms)
✔ todo15: upstream non-2xx (HTTP 200 + envelope.status 400) → the typed error IS raised (29.845563ms)
✔ todo15: gateway 429 {error:budget_exceeded} → typed error IS raised and NEVER retried (0.980889ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 337.160607
```

### 3. `cd server && npm test`

```
ℹ tests 519
ℹ pass 519
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
TEST_EXIT=0
```

Baseline was 515; the 4 new tests bring the suite to **519 pass / 0 fail**.

## The three acceptance cases (mapped to the plan)

| plan acceptance | test name | observable |
|---|---|---|
| gateway UNREACHABLE → sweep completes without throwing + warning logged | `todo15: gateway UNREACHABLE → the sweep completes without throwing and warns` | `metricSweep` resolves (`threw === undefined`) and the captured `log.warn` includes `gateway unreachable` |
| HTTP 200 + `envelope.status:400` → typed error IS raised (not swallowed) | `todo15: upstream non-2xx (HTTP 200 + envelope.status 400) → the typed error IS raised` | `assert.rejects` matches `e instanceof HttpError && e.status === 400` |
| HTTP 429 `{error:"budget_exceeded"}` → typed error IS raised + NO retry | `todo15: gateway 429 {error:budget_exceeded} → typed error IS raised and NEVER retried` | `assert.rejects` matches `e instanceof HttpError && e.status === 429`; fetch stub call count `=== 1` on the `essential` (withRetry) path |

The 4th test (`a fetch rejection is typed GatewayTransportError`) pins the fail-open input type itself, so case 1's classification is proven to come from the transport, not a coincidental message match.

## Notes / non-claims

- No cross-process stale cache is claimed anywhere; the fail-open path only warns and skips the sweep.
- A gateway-generated 429 is rethrown (`GatewayDenialError` → `HttpError`), never swallowed and never re-issued (verified by `calls === 1` through the `withRetry` path).
- `git status --short` shows only `server/src/gateway-client.ts`, `server/src/poller.ts` (modified) and `server/test/gateway/fail-open.test.ts` (new) from this task; the `.omo/run-continuation/*` / `.omo/start-work/ledger.jsonl` entries are harness-generated, not edited by this task.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-15-request-plane-gateway.md
