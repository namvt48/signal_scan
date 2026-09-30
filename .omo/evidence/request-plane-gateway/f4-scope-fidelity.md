# F4 — Scope Fidelity (Must-NOT list)

- **Range:** `639cdaa^..HEAD` (22 commits, `feat(gateway): add standalone gateway entrypoint` → `test(e2e): verify …`)
- **Plan:** `.omo/plans/request-plane-gateway.md` (Must NOT have: lines 32-41; success criteria 287-300)
- **Mode:** READ-ONLY (no edits/commits/state changes in this review)
- **Date:** 2026-09-30T12:41Z

## Verdict table

| # | Constraint (plan) | Held | Evidence |
|---|---|---|---|
| C1 | NO stream/WS proxying — Solana WS / EVM WS / FOMO WSS stay in-process per instance (`watchers/fomo/feed.py:39`) | **Y** | `server/src/gateway/main.ts:71` `createServer(createGatewayApp())` — no `'upgrade'` handler; grep `upgrade|eventsource|text/event-stream|ws.Server` in `server/src/gateway/` → only `door.ts:629` (`spec.ws`, the OUTBOUND browserless transport URL moved from `crawl.ts`, not a proxied client stream); `git diff --name-only … -- watchers/` → `NO_FEED_CHANGES` (fomo/evm feed.py untouched) |
| C2 | NO RPC-over-HTTP in v1 — `solana-rpc`/`evm-rpc` stay local | **Y** | No `rpc` route in `server/src/gateway/` (grep `solana-rpc|evm-rpc|rpc` in gateway → none); `git diff --name-only … -- server/src/providers/solana.ts server/src/providers/evm.ts` → empty (untouched); `solana.ts:202` `limiters.run('solana-rpc', …)` still local |
| C3 | NO durable queue / job store / DB in gateway; NO `db.ts`/`better-sqlite3` import | **Y** | Full gateway import list (`app/auth/cache/contract/credit/door/gmgn/main/nansen`) = node builtins (`http`,`url`,`fs`,`crypto`), `express`, `puppeteer-core`, local `../ratelimit`, `../log`, `../config`, `../auth`, `../shared/*`, `../providers/gmgn` (constants only). grep `db.ts\|better-sqlite3\|sqlite\|redis\|queue\|job\|bull\|kafka` in `server/src/gateway/` → only a prose comment in `door.ts:7`; the only "queued" hit is the limiter snapshot field `app.ts:124` |
| C4 | NO caching or dedupe of GMGN responses | **Y** | `cache.ts:91` `return null; // gmgn / the generic proxy: never cached.`; GMGN routed via a dedicated non-cached route `app.ts:236-249` (comment: "EXCLUDED from the todo-11 cache/single-flight — mandates fresh `client_id`+timestamp") |
| C5 | NO second limiter implementation; NO double-governing of the browser door (DoorPool = THE ONE budget owner) | **Y** | Door route `app.ts:307-321` uses `browserPostJson` (DoorPool) with **no limiter key** (comment: "so the never-wired `nansen-door` spec cannot double-govern"); DoorPool owns `pathBudget`/`doorCapPerMin` (`door.ts:823,825`); `nansen-door` spec is referenced only in a comment, never `.run()`; no second limiter impl added (`server/src/ratelimit/*` diff only extends `spec.ts` windows, no new limiter engine) |
| C6 | NO a-side collateral changes (a's non-api services untouched) | **Y** | `.omo/evidence/.../task-21`: pre/post `StartedAt` — `signal_scan-api-1` RECREATED `…12:26:52Z`; `signal_scan-web-1` `2026-09-29T09:32:22.579098165Z` UNCHANGED; `signal_scan-chrome-1` `…09:32:22.572306880Z` UNCHANGED. `git diff … -- docker-compose.yml` adds ONLY api's `networks: [default, signal-scan-gateway]` + the external `networks:` block (no other service touched) |
| C7 | NO secrets / `.env` / `data/` / `data-b/` / `keys/` committed | **Y** | `git log --name-only 639cdaa^..HEAD \| grep -iE '\.env\|/data/\|data-b\|keys/\|proxies\.txt\|secret\|\.pem\|\.key'` → `NO_SECRET_PATHS`; added-line scan (`git diff \| grep '^+' \| grep -iE 'api[_-]?key=…\|token=…\|BEGIN …PRIVATE\|password=…\|sk-…'`) → `NO_SECRET_LITERALS_IN_DIFF`; `git ls-files` secret-shaped → only `.env.example`, `server/.env.example` (pre-existing, NOT in the diff range) |

## Notes (non-blocking, outside the Must-NOT list)

- Plan pinned host deploy dir `/opt/signal-scan-gateway/`; actual is `/root/signal-scan-gateway/` — documented in `docker-compose.gateway.yml:11-17` as a snap-docker confinement fix (cannot bind-mount `/opt`). Not a Must-NOT constraint; recorded for completeness.
- `dexscreener` window changed 60→300/min and a new `dexscreener-profiles` 60/min key added (`spec.ts`) — inside plan scope (todo 9), `dexscreener` key name preserved per success criterion 292.
- `nansen-door` limiter exists in the snapshot but is never `.run()` — pre-existing never-wired spec, unchanged by this work.

## Conclusion

Every Must-NOT constraint (C1-C7) **HELD**. No scope drift found.

APPROVE
