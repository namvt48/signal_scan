# F2 — Code Quality Review: Request-Plane Gateway

Diff range: `639cdaa^..HEAD`. Scope: gateway files only (`server/`, `docker-compose.gateway.yml`, `watchers/`).
HEAD verified: `7ded8d6` (skeleton said `0c34369`; range still resolves — diffstat matches, 41 files).
Status: COMPLETE.

## Findings

### (i) Type suppressions — CLEAN
`grep -rnE "as any|@ts-ignore|@ts-expect-error|@ts-nocheck" server/src/gateway server/src/gateway-client.ts server/src/index.ts server/src/config.ts server/src/poller.ts server/src/api.ts server/src/crawl.ts` → exit 1, zero matches. No suppressions to flag.

### (ii) Duplicated limiter — CLEAN (one false-positive note)
- Exactly ONE limiter implementation exists: `server/src/ratelimit/` (limiter.ts, bucket/gate/window/semaphore/min-interval/registry/spec/types).
- Gateway IMPORTS it, never re-implements: `app.ts:8` + `contract.ts:50` import `../ratelimit/index.js`; `gmgn.ts:30`, `contract.ts:49`, `nansen.ts:29`, `dexscreener.ts:17` import `../ratelimit/types.js`.
- `grep -rn "class .*Limiter" server/src/gateway` returned ONE hit — `dexscreener.ts:9` — but that line is PROSE inside a comment ("...the profiles class gets the NEW key. A `Limiter` holds exactly one..."), not a class declaration. Confirmed no `class|function|new *Limiter`, `RateLimiter`, or `TokenBucket` in gateway. ⇒ ok.

### (iii) Double-governed door — CLEAN
- `grep -rn "nansen-door" server/src/gateway` → only explanatory comments: `app.ts:309` and `nansen.ts:14`, both stating the spec is never wired here.
- NO `limiters.run('nansen-door' ...)` in the door route or anywhere in gateway. Sole real `limiters.run(` call site is `contract.ts:245` via the injected `run` seam.
- Door route `app.ts:312-322` calls `handleNansenDoor({ postJson })` (relocated DoorPool) directly — DoorPool is the one budget owner. ⇒ ok.

### (iv) Dead code wired into prod — CLEAN
- Entrypoint graph: `main.ts` → `app.ts`; `app.ts` imports every gateway module — `auth`(:10), `door`(:11), `gmgn`(:20), `contract`(:12,:27), `cache`(:36), `credit`(:37), `dexscreener`(:27), `nansen`(:12). No orphan/legacy module exists in `server/src/gateway/` (dir = app, auth, cache, contract, credit, dexscreener, door, gmgn, main, nansen — all reachable).
- `crawl.ts` is the deliberate back-compat re-export shim importing `gateway/door.js` — by design, not flagged.

### (v) Secrets in the diff — CLEAN
- Scoped scan `git diff 639cdaa^..HEAD -- server/ docker-compose.gateway.yml watchers/` matched only non-secrets: test placeholders `GATEWAY_TOKEN_A: 'token-a'` / `GATEWAY_TOKEN_B: 'token-b'` (config test) and doc placeholder `GATEWAY_CALLER_TOKEN=<a-token>`.
- No `sk-…`, real `*_API_KEY=<20+ chars>`, or `BEGIN … PRIVATE KEY` in source. The unscoped `git log -p` matches were all `.omo/evidence/…` doc paths and placeholder env (`ta`/`tb`/`tw`/`nk`/`gk`) — no real secret. ⇒ ok.

### (vi) Empty/swallowed catches — CLEAN
`grep -rnE "catch \([^)]*\) \{\}" server/src/gateway` → exit 1, zero matches; broader `catch … {}` scan also zero. ⇒ ok.

## Verdict

APPROVE
