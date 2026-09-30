# Task 22 — End-to-end verification (dedupe, split, fail-open, GMGN egress)

Plan: `.omo/plans/request-plane-gateway.md` (todo 22, block at lines 265-271).
Host: `root@194.163.187.250`. Date: 2026-09-30.
Repo HEAD (pre-commit): `6590a23` (`chore(deploy): deploy gateway and attach instances a and b`).
Commit (this todo): `test(e2e): verify dedupe, credit split, fail-open and GMGN egress`.
**No secret VALUE is written here — caller tokens are never read into this file; only counters,
HTTP statuses, limiter snapshots, and public IPs. Proxy URLs are never printed (IPs only).**
Instrument: `GET /metrics` (token-gated) exposes `ratelimit[...].{windowUsed,gateUntil}`,
`credits{a,b}`, and `cache{hits,misses,joined,size}` — the upstream-call delta counter.

## Phases

- [x] 1. (a) dedupe — DexScreener cross-caller dedupe + credit/GMGN/flows never-collapsed
- [x] 2. (b) Nansen credit equal split + over-half soft-deny (caller-scoped)
- [x] 3. (c) fail-open — gateway stopped, both instances keep serving
- [x] 4. (d) egress — d1 gateway NAT (host IP, GMGN allowlist) vs d2 door/proxy IP, recorded separately
- [x] 5. Commit + plan checkbox

**Note on live traffic**: instances a + b run LIVE pollers that also drive the gateway, so
per-counter deltas are read inside tight (sub-second) windows around each proof pair; the
`hits=0` DexScreener start + the flat flows counters below isolate the intended signal.

## (a) Dedupe proof

### a-i. DexScreener tokens — CROSS-CALLER dedupe (one upstream call for two callers)
```
before: hits=1 miss=36 join=0 size=34
caller a POST /v1/dexscreener {"endpoint":"tokens",params:{addresses:EPjFWdd...}} -> HTTP 200
caller b POST /v1/dexscreener (identical)                                          -> HTTP 200
after : hits=2 miss=37 join=0 size=35
```
Delta `misses +1, hits +1` ⇒ **2 callers / 1 upstream call** (b joined the cached a response).

### a-ii. Nansen credit (token-information) — CROSS-CALLER never collapsed
```
before: hits=1 miss=34 join=0 size=32
caller b POST /v1/nansen/credit {"endpoint":"/api/v1/tgm/token-information",...USDC} -> HTTP 200
watcher  POST /v1/nansen/credit (identical)                                        -> HTTP 200
after : hits=1 miss=36 join=0 size=34
```
Delta `misses +2, hits +0, joined +0` ⇒ **two upstream calls** — credit is per-caller, never
collapsed or TTL-shared. (Caller `a` was already at its 5/10 half cap from proof (b); only a/b
are billable, so the second caller used the unbilled watcher token so BOTH calls stayed un-denied.)

### a-iii. GMGN — never cached (live attempt blocked by upstream throttle)
```
before: hits=2 miss=38 join=0 size=36
A POST /v1/gmgn/token-info -> HTTP 200, envelope {"status":429,...}  (upstream GMGN leaky-bucket)
A POST /v1/gmgn/token-info -> HTTP 503, envelope {"error":"gated"}   (gate armed by the 429)
after : hits=2 miss=38 join=0 size=36                               (NO hit, NO size growth)
```
GMGN produced **no cache hit and no cache entry**. GMGN is unconditionally uncacheable:
`classifyRequest` returns `null` for the gmgn provider (`cache.ts:91`), unit test
`(e) two identical GMGN calls produce TWO upstream calls (never cached)`
(`test/gateway/cache.test.ts:245`). The live upstream currently 429s (documented GMGN leaky
bucket `rate=10 cap=10`, `drafts:92`), so a live 2xx pair could not be produced; the 429 envelope
is itself non-cacheable (`isCacheable` rejects non-2xx, `cache.ts:261`). Recorded as environment
state, not a cache behaviour.

### a-iv. time-windowed Nansen flows — never deduped
```
before: hits=2 miss=39 join=0 size=37
watcher POST /v1/nansen/credit {"endpoint":"/api/v1/tgm/flows",... window 2026-05-01..07} -> HTTP 200
watcher POST /v1/nansen/credit {"endpoint":"/api/v1/tgm/flows",... window 2026-05-08..14} -> HTTP 200
after : hits=2 miss=39 join=0 size=37
```
**Counters unchanged** ⇒ no dedupe/cache entry. Flows are UNCACHEABLE by design
(`classifyRequest` → `null`, `cache.ts:85` "flows (moving window)"; `app.ts:292`), unit test
`(f) two identical time-windowed Nansen flows calls produce TWO upstream calls (not deduped)`
+ `cache.size() === 0` (`test/gateway/cache.test.ts:264-285`).
**Delta note**: the plan's literal "flows ⇒ misses +2" is NOT measurable because uncacheable
requests bypass the cache counters entirely — the implementation gives the STRICTER guarantee
"never cached/collapsed" (the plan's intent: "not falsely deduped"). Observable proof =
counters unchanged + the two upstream assertions in test (f).

## (b) Nansen credit equal split + over-half soft-deny (caller-scoped)
```
credits before: {budget:10, half:5, used:{a:4, b:0}}
A POST /v1/nansen/credit (token-information BONK) -> HTTP 200  ; used.a 4->5   (charged 1 credit)
A POST /v1/nansen/credit (token-information BONK) -> HTTP 429  body {"error":"budget_exceeded"}
                                                  header x-gateway-budget: exceeded
B POST /v1/nansen/credit (token-information BONK) -> HTTP 200  ; used.b 0->1   (b unaffected)
nansen-credit limiter (throughout): {inFlight:0, queued:0, gateUntil:0, windowUsed:0}
final: credits {a:5, b:5}
```
`a` at its equal half (5) is soft-denied; `b` still allowed ⇒ split is per-caller and exact. The
denial is a gateway 429 (non-200, never retried) and did **NOT** arm the shared limiter gate
(`gateUntil` stayed 0). Non-credit routes unaffected (proof a-i).

## (c) Fail-open — gateway stopped, both instances keep serving
```
health BEFORE (a:8124 / b:8125):   a=200 b=200
docker compose -f docker-compose.gateway.yml stop gateway ; gw_state=false
health DURING outage:              a=200 b=200
restart counts:  a-api restarts=0 running=true ; b-api restarts=0 running=true   (no crash loop)
api log: 2026-09-30T12:38:18.191Z WARN [api] gateway /health unreachable — doors degraded
         err=TypeError:fetch failed
docker compose ... start gateway ; gateway_health=200 ; a=200 b=200
```
Both instances served HTTP 200 with the gateway down, warned once, did not crash-loop, and
recovered cleanly on restart (stale-but-uncorrupted own DB).

## (d) Egress IPs — CORRECT path (do not conflate)

### d1. GMGN/DexScreener egress = gateway container NAT = HOST public IP (unchanged)
```
gateway container GET https://api.ipify.org  -> 194.163.187.250
host                GET https://api.ipify.org  -> 194.163.187.250
```
The gateway egresses via its own NAT = the host public IP `194.163.187.250` — the SAME IP the api
containers already used, so the GMGN allowlist still matches (`drafts:92`: GMGN allowlist
`403 AUTH_IP_BLOCKED`; unchanged). The live GMGN response was `429` (rate), NOT `403
AUTH_IP_BLOCKED` (IP rejected) — consistent with "allowlisted but throttled".

### d2. Browser-DOOR egress = PROXY IP (separate path, NOT used for the allowlist check)
```
door route: watcher POST /v1/nansen/door {"endpoint":"tgm-essential-data",...} -> HTTP 200
            envelope body {"clickhouseQueryId":"d9f908fc-...)"  (proxy path works)
door proxies  : 2 entries in host-only /root/signal-scan-gateway/proxies.txt
proxy #1 egress IP = 167.86.101.228      (== door/proxy egress, DIFFERENT from d1)
proxy #2 egress IP = <unreachable/blocked>
```
d2 = `167.86.101.228` ≠ d1 = `194.163.187.250`. The door egress is the proxy's IP (a different
path; ipify probe lives in `gateway/door.ts:740`, logged at connect `door.ts:514`); it is recorded
separately and NOT used for the GMGN-allowlist comparison. (The DoorPool WS connect that logs the
IP at INFO did not run for this free-question call, so the proxy egress IP was measured directly
through the proxy; proxy URLs/credentials are never printed.)

## Raw metric snapshots
```
BEFORE (proof b): credits{used:{a:5,b:0}} cache{hits:0,misses:27,size:27} nansen{gateUntil:0,windowUsed:0}
MID    (proof b): credits{used:{a:5,b:1}} cache{hits:0,misses:31,size:29}
FINAL          : credits{used:{a:5,b:5},budget:10,half:5}
ratelimit: gmgn{gateUntil:0,windowUsed:0} nansen-credit{gateUntil:0,windowUsed:0} dexscreener{windowUsed:3}
```

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-22-request-plane-gateway.md
