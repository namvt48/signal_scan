# Todo 19 — Nansen credit accounting + equal a/b split + exceeded-half soft-deny

Plan block: `.omo/plans/request-plane-gateway.md:241-247` (Wave 4; blocked by 7,11;
blocks 20,22). Branch `feat/fomo-user-watch`, direct mode. No commit made.

## What changed

- **NEW `server/src/gateway/credit.ts`** — `CreditAccountant`:
  - `preflight(provider, rawBody, caller)` returns `undefined` to allow or
    `denial(429,'budget_exceeded',{'x-gateway-budget':'exceeded'})` to deny.
    Denies only the `nansen-credit` provider and only callers `a`/`b` (a `watcher`
    is never capped); denies once `used[caller] >= budget/2` (equal split).
  - `wrap(inner)` composes around the credit upstream and charges the caller the
    REAL `x-nansen-credits-cost` when present, else `creditCostFor(endpoint, body)`
    on a 2xx; a headerless non-2xx is not charged.
  - Daily reset on the UTC day of an injected clock (`opts.now`).
  - Exports `creditCostFor`, `BUDGET_HEADER='x-gateway-budget'`,
    `BUDGET_EXCEEDED='exceeded'`, and `snapshot()` for tests/metrics.
- **`server/src/gateway/app.ts`** — wires it in: `credits.wrap(deps.nansenCreditUpstream
  ?? nansenCreditUpstream())` and `cache.dispatch(..., deps.preflight ?? credits.preflight)`
  for the Nansen credit route only. The budget pre-flight therefore runs AFTER the
  cache lookup and BEFORE the limiter (cache.ts pinned order) and returns directly
  — it never enters `limiters.run('nansen-credit', ...)`, so it can neither arm the
  shared gate nor feed the fibo retry. `deps.credits` is injectable.
- **NEW `server/test/gateway/credit.test.ts`** — 4 tests booting the REAL gateway
  app over an ephemeral port with only upstream bytes stubbed.

## Acceptance (a)-(f) → proof

| # | Criterion | Test | Assertion |
|---|---|---|---|
| a | each side capped at half | `(a)(b)(c)(e) equal split…` | `a1`,`a2` 200 → `snapshot().used.a === 2` (half of budget 4); `b1` 200 → `used.b === 1` |
| b | over-cap → `budget_exceeded` to THAT caller only | same | 3rd a call: `status 429`, `json {error:'budget_exceeded'}`, `headers['x-gateway-budget']==='exceeded'`; `up.calls()===2` (denied never reached upstream) |
| c | other side + door/GMGN/DexScreener unaffected | same | `b1` 200; DexScreener/GMGN/door all 200 for the over-cap `a`; `preflight('gmgn'→undefined)`, `preflight('dexscreener'→undefined)`, `preflight('nansen-credit','watcher'→undefined)` |
| d | counters reset on day rollover | `(d) counters reset…` | budget 2, `clock.advance(86_400_000)` → `snapshot().day==='2026-01-02'`, `used.a===1` (was exhausted on day 1) |
| e | denial does NOT arm the shared gate; other caller's limiter unchanged | `(a)(b)(c)(e)…` | `rec.calls.length===2` after the denial (pre-flight never reached the limiter); `registry.snapshot()['nansen-credit'].gateUntil===0`, `inFlight===0`, `queued===0` |
| f | cache hit adds 0 credits | `(f) a cache hit…` | same body twice: `up.calls()===1`, `used.a===1` after both |

Cost rules proven in `cost rules: the real upstream header wins…`:
`x-nansen-credits-cost: 7` → `used.a===7`; `creditCostFor` table
(`token-information`=1, `flows`=1, `holders`=5, `holders`+`premium_labels`=150,
unknown=1); a headerless upstream 500 → `used.a` unchanged.

## Commands + verbatim output

### 1. Typecheck (`server/`) — exit 0

```
$ npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

### 2. Focused todo-19 test — 4/4 pass

```
$ npx tsx --test test/gateway/credit.test.ts
✔ (a)(b)(c)(e) equal split: each side capped at half; denial is caller-scoped, gate-free and route-scoped (83.783618ms)
✔ (d) counters reset at the UTC day boundary of the injected clock (18.815994ms)
✔ (f) a cache hit adds 0 to the caller credit count (8.533994ms)
✔ cost rules: the real upstream header wins, else the table; a headerless non-2xx is not charged (8.487061ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
ℹ duration_ms 797.406404
```

### 3. Full server suite — 523/523 pass (baseline was 519; +4)

```
$ npm test
ℹ tests 523
ℹ suites 0
ℹ pass 523
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32964.685816
```

### 4. Files touched

```
$ git status --short -- server/src/gateway/credit.ts server/src/gateway/app.ts server/test/gateway/credit.test.ts
 M server/src/gateway/app.ts
?? server/src/gateway/credit.ts
?? server/test/gateway/credit.test.ts
```

## Notes / deliberate limits

- **Optimistic soft cap, not a hard cap.** The real cost is known only after the
  response, so the check is check-then-act (draft N10): two racing calls at
  half−1 can both pass and slightly overshoot. This is by design and asserted as
  soft (no exact-cap assertion).
- **Reverse-only denial marker**: `x-gateway-budget: exceeded` + HTTP 429
  distinguishes the gateway budget denial from a genuine upstream 429, which the
  todo-3 contract rides inside a 200 envelope as `{status:429, body:null}`.
- **Cache ordering**: a hit/joiner short-circuits in `GatewayCache.dispatch`
  before the pre-flight, so a 0-credit hit is never budget-denied (acceptance f).
- `watcher` has no credit half and is not capped (per plan, watchers never hit
  this route).
- No commit / no `git add` performed; scope confined to the three files above.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-19-request-plane-gateway.md
