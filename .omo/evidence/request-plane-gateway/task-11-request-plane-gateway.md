# Task 11 — Selective TTL cache + single-flight dedupe — Evidence

- Plan: `.omo/plans/request-plane-gateway.md` (todo 11)
- Commit: `feat(gateway): add selective TTL cache with single-flight dedupe`
- Branch: `feat/fomo-user-watch`

## Scope delivered
- `server/src/gateway/cache.ts` — `GatewayCache`, `classifyRequest`, `cacheKey`
  (caller-scoped key for credit-bearing Nansen endpoints), `Preflight` seam,
  `runUncached`; applies ONLY to deterministic-param endpoints (Nansen
  `token-information`/`holders`, DexScreener tokens/pairs/search); EXCLUDES GMGN
  and time-windowed Nansen flows.
- `server/src/gateway/app.ts` — cache lookup + single-flight inserted BEFORE the
  DexScreener and Nansen-credit limiters; `preflight` seam defaults to no-op
  (todo 19 will wire the real budget accounting); injectable `cache`.
- `server/test/gateway/cache.test.ts` — acceptance (a)-(k) + a normalization test.

## Provenance
Worker session `ses_f0e332f29ffeS3LBHmW4nUGkQv` wrote `cache.ts`, the `app.ts`
wiring and `cache.test.ts`, then crashed at its final report turn with the known
provider fault (`The content[].thinking in the thinking mode must be passed back
to the API`). The orchestrator re-ran the verification below against the on-disk
tree and recorded this evidence.

## Verification

### `cd server && npx tsc --noEmit`
exit 0.

### `npm test`
```
ℹ tests 500
ℹ suites 0
ℹ pass 500
ℹ fail 0
```

### cache specs (verbatim)
```
✔ (a) N concurrent identical SAME-CALLER Nansen token-information calls collapse to ONE upstream (159.652292ms)
✔ (b) a second same-caller call within TTL is a HIT (0 upstream) (123.585303ms)
✔ (c) after TTL expiry the next call goes upstream again (41.738523ms)
✔ (d) a 4xx/5xx upstream is never cached (29.429478ms)
✔ (e) two identical GMGN calls produce TWO upstream calls (never cached) (18.359981ms)
✔ (f) two identical time-windowed Nansen flows calls produce TWO upstream calls (not deduped) (24.71924ms)
✔ (g) N concurrent identical DexScreener calls from DIFFERENT callers collapse to ONE upstream (54.722803ms)
✔ (h) two concurrent identical Nansen credit calls from DIFFERENT callers are NOT collapsed (49.771347ms)
✔ (i) a cross-caller Nansen credit request WITHIN TTL is NOT a cache hit (2 upstream, 2 charges) (18.376087ms)
✔ (j) N concurrent identical SAME-CALLER Nansen credit calls → ONE upstream and ONE charge (40.066504ms)
✔ (k) an over-budget caller still returns a cached 0-credit body (hit short-circuits BEFORE pre-flight) (24.635683ms)
✔ cacheKey normalization: order-independent, priority-excluded, caller-scoped for credit (0.665087ms)
```

## Acceptance mapping
- (a) same-caller credit single-flight → 1 upstream; (j) charges exactly ONE. PASS
- (b)(c) TTL hit / expiry. PASS
- (d) non-2xx never cached. PASS
- (e) GMGN never cached/deduped. PASS
- (f) time-windowed Nansen flows not deduped. PASS
- (g) cross-caller non-credit (DexScreener) dedupe allowed. PASS
- (h)(i) cross-caller credit NOT collapsed / NOT a TTL hit → 2 upstream + 2 charges. PASS
- (k) cache hit short-circuits BEFORE the budget pre-flight. PASS

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-11-request-plane-gateway.md
