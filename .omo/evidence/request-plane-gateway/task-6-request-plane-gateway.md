# Todo 6 evidence — gateway env configuration surface

> Provenance: the todo-6 worker (session `ses_f0e60ce30ffe3c1m3kyI1s7nm0`, bg `bg_5c233a6d`)
> made all code changes on disk and passed the acceptance checks, but its final chat/report turn
> died with the recurring provider error (`content[].thinking ... must be passed back`). The
> orchestrator then re-ran and captured the acceptance commands below verbatim. Code was NOT
> modified by the orchestrator.

## Files changed
- `server/src/config.ts` — added the gateway config block (gatewayPort default 8130; `gatewayTokenA`/`gatewayTokenB`/`gatewayTokenWatcher`; `nansenDailyCreditBudget` default 10 credits/day; `cacheTtlNansenMs`/`cacheTtlDexscreenerMs`). Reuses existing `nansenApiKey`/`gmgnApiKey`/`gmgnPlanWeight`/`crawlWsEndpoint`/`crawlProxyFile`. **No `RL_*` fields added** (they are read directly from `process.env` in `server/src/ratelimit/spec.ts`) — trap avoided.
- `server/src/gateway/main.ts` — added `missingGatewayEnv()` + the fail-loud boot check (blank required keys -> `log.error` + `process.exit(1)`). No module-scope throw in `config.ts`.
- `server/test/gateway/config.test.ts` — NEW (defaults-when-unset + overrides-when-set incl. `GMGN_PLAN_WEIGHT` and `RL_*` reaching `buildSpecs`).

## Commands + verbatim results

### `cd server && npx tsc --noEmit`
```
tsc exit=0
```

### `cd server && npm run gateway:build`
```
exit=0
```

### `cd server && npm test`
```
test exit=0
ℹ tests 445
ℹ pass 445
ℹ fail 0
```
(todo 1 baseline was 439; +6 from `config.test.ts`, all pass.)

### Fail-loud: boot the gateway with NO env
```
$ env -i PATH="$PATH" HOME="$HOME" node dist/gateway/main.js
2026-09-30T09:31:41.442Z ERROR [gateway] missing required env: nansenApiKey, gmgnApiKey, gatewayTokenA, gatewayTokenB, gatewayTokenWatcher
exit=1
```

### No module-scope throw: `config.ts` loads with only a caller token
```
$ GATEWAY_TOKEN_A=x npx tsx -e "import('./src/config.js').then(m=>console.log('CONFIG_OK gatewayPort=',m.config.gatewayPort))"
CONFIG_OK gatewayPort= 8130
exit=0
```

## Trap checks
- `grep -n "RL_" server/src/config.ts` -> no matches (no dead limiter fields).
- Fail-loud lives in `server/src/gateway/main.ts`, NOT at module scope in `config.ts` (config import above does not throw).

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-6-request-plane-gateway.md
