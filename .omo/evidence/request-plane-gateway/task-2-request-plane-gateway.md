# Todo 2 evidence — gateway HTTP layer, per-caller bearer auth, /health

> Provenance: the todo-2 worker (session `ses_f0e578d63ffeFhd9NgCVOBeDLC`, bg `bg_8191ec1a`) wrote
> the code and passed acceptance, but its final report turn died with the recurring provider error
> (`content[].thinking ... must be passed back`). The orchestrator re-ran and captured the commands
> below verbatim. Code was NOT modified by the orchestrator.

## Files
- NEW `server/src/gateway/auth.ts` — bearer-token -> `Caller` (`a`|`b`|`watcher`) resolution from the three separate tokens.
- NEW `server/src/gateway/app.ts` — the gateway HTTP app (reuses the `server/src/api.ts` `createApp` pattern); `/v1/*` requires bearer auth, `GET /health` is public, `GET /metrics` is token-gated.
- `server/src/gateway/main.ts` — starts the HTTP layer on `config.gatewayPort`.
- NEW `server/test/gateway/auth.test.ts`.

DoorPool stats are `null` for now — todo 10 OWNS the DoorPool relocation; the `/health` hook is left in place. `egressIp` disclosure is intentional (loopback + private `signal-scan-gateway` net only).

## Commands + verbatim results

### `cd server && npx tsc --noEmit`
```
tsc exit=0
```

### `cd server && npm test`
```
test exit=0
ℹ tests 450
ℹ pass 450
ℹ fail 0
```
(todo 6 baseline 445; +5 from `auth.test.ts`.)

### Live boot + probes (`GATEWAY_PORT=8137`, tokens set)
```
$ GATEWAY_TOKEN_A=ta GATEWAY_TOKEN_B=tb GATEWAY_TOKEN_WATCHER=tw NANSEN_API_KEY=nk GMGN_API_KEY=gk GATEWAY_PORT=8137 node dist/gateway/main.js
2026-09-30T09:34:42.628Z INFO  [gateway] listening on :8137

-- GET /health (no auth) --
http=200
{"ok":true,"ratelimit":{"gmgn":{...},"solana-rpc":{...},"nansen-credit":{...},"nansen-door":{...},"dexscreener":{...}},"doors":null}

-- GET /v1/x  (no token) --
http=401
{"error":"unauthorized"}

-- GET /v1/x  (Bearer ta) --
http=404
{"error":"not_found"}      # passed auth (caller a resolved); only the route is absent until todos 3/7/8/9

-- GET /v1/x  (Bearer tb) --
http=404
{"error":"not_found"}      # caller b resolved

-- GET /metrics (no token) --
http=401
{"error":"unauthorized"}
```

Caller resolution itself is asserted in `server/test/gateway/auth.test.ts` (green in the suite above).

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-2-request-plane-gateway.md
