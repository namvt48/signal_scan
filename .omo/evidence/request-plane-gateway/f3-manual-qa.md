# F3 — Independent manual QA: re-run of the four live proofs (todo 22)

Independently re-derived on the production host by F3. This is **NOT** copied
from `task-22-request-plane-gateway.md` — every block below is raw output from
commands F3 ran itself on `root@194.163.187.250`.

- Host: `root@194.163.187.250` (host local `CEST` = UTC+2; gateway logs are UTC).
- Gateway: `127.0.0.1:8130` (`signal_scan-gateway-1`, compose
  `/root/signal_scan/docker-compose.gateway.yml`, project `signal_scan`).
- Instances: a = `signal_scan-api-1` (`127.0.0.1:8124`), b = `signal_scan_b-api-1` (`127.0.0.1:8125`).
- Instrument: `GET /metrics` (Bearer, any caller) → `cache{hits,misses,joined,size}`,
  `credits{a,b}`, `ratelimit[...]`.
- Tokens: sourced from `/root/signal-scan-gateway/gateway.env` inside the remote
  shell; **never printed**. Proxy URLs **never printed** (IPs only).
- Probes: DexScreener `POST /v1/dexscreener {"endpoint":"tokens","params":{"addresses":"<mint>"}}`;
  Nansen credit `POST /v1/nansen/credit {"endpoint":"/api/v1/tgm/token-information","body":{...}}`;
  GMGN `POST /v1/gmgn/token-info`; flows `POST /v1/nansen/credit {"endpoint":"/api/v1/tgm/flows",...}`.

Baseline at the start of F3 (gateway had restarted ~12:38 UTC, cold cache):
```
gateway ok=true caller=a
credits day=2026-09-30 budget=10 half=5 used_a=0 used_b=0
cache hits=0 misses=0 joined=0 size=0 inflight=0
health a=200 b=200
```

> Live pollers on a + b also drive the gateway, so every counter delta below is
> read in a tight window immediately around each proof pair. The noisy first
> credit pass was repeated inside a **verified quiet window**.

## (a) Dedupe proof

### a-i. DexScreener `tokens` — CROSS-CALLER dedupe (one upstream call for two callers)
```
===== (a) START metrics =====
gateway ok=true caller=a
credits day=2026-09-30 budget=10 half=5 used_a=1 used_b=0
cache hits=0 misses=2 joined=0 size=2 inflight=0
===== a-i DexScreener tokens cross-caller (a then b, IDENTICAL) =====
  caller a:
    HTTP 200 in 0.087072s
    envelope.status=200 body_len=37380
  caller b:
    HTTP 200 in 0.010358s
    envelope.status=200 body_len=37380
  metrics after a-i:
gateway ok=true caller=a
credits day=2026-09-30 budget=10 half=5 used_a=1 used_b=0
cache hits=1 misses=3 joined=0 size=3 inflight=0
```
Delta `hits +1, misses +1` ⇒ **2 callers / 1 upstream call** (caller b hit caller a's cached response, fast 0.010s vs a's 0.087s). No credit consumed.

### a-ii. Nansen credit `token-information` — CROSS-CALLER never collapsed (miss +2)
First pass (noisy — a poller added one concurrent miss); re-run in a verified quiet window:
```
===== credit non-collapse attempt 1 (quiet_window=1) =====
BEFORE:
credits day=2026-09-30 budget=10 half=5 used_a=2 used_b=2
cache hits=1 misses=12 joined=0 size=12 inflight=0
  caller a:
    HTTP 200 in 0.284926s
    envelope.status=200 body_len=701
  caller b:
    HTTP 200 in 0.181829s
    envelope.status=200 body_len=701
AFTER:
credits day=2026-09-30 budget=10 half=5 used_a=3 used_b=3
cache hits=1 misses=14 joined=0 size=12 inflight=0
===== credit non-collapse attempt 2 (quiet_window=1) =====
BEFORE:
credits day=2026-09-30 budget=10 half=5 used_a=3 used_b=3
cache hits=1 misses=14 joined=0 size=12 inflight=0
  caller a:
    HTTP 200 in 0.003684s
    envelope.status=200 body_len=701
  caller b:
    HTTP 200 in 0.005019s
    envelope.status=200 body_len=701
AFTER:
credits day=2026-09-30 budget=10 half=5 used_a=3 used_b=3
cache hits=3 misses=14 joined=0 size=12 inflight=0
===== limiter nansen-credit after pair =====
limiter nansen-credit inFlight=0 queued=0 gateUntil=0 windowUsed=0
```
Attempt 1 (cold): `misses +2, hits +0, joined +0` **and** `used_a +1, used_b +1` ⇒ **two distinct upstream calls**, one per caller — credit is per-caller and never collapsed/TTL-shared. Attempt 2 (same callers, warm): both served in <5 ms, `hits +2`, credits unchanged ⇒ each caller has its OWN cache key (a's key ≠ b's key), so the cross-caller calls can never merge. `nansen-credit` limiter `gateUntil=0` throughout.

### a-iii. GMGN `token-info` x2 — NEVER cached (counters unchanged)
```
===== a-iii GMGN token-info x2 (caller a) =====
  call 1:
    HTTP 200 in 0.216142s
    envelope.status=429 body_len=None
  call 2:
    HTTP 503 in 0.012965s
    envelope.status=None body_len=None
  metrics after a-iii:
gateway ok=true caller=a
credits day=2026-09-30 budget=10 half=5 used_a=2 used_b=2
cache hits=1 misses=6 joined=0 size=6 inflight=0
```
`cache` counters **unchanged** by both calls (hits/misses/size identical pre/post). GMGN is unconditionally uncacheable (`cache.ts:91`: `classifyRequest` → `null` for gmgn) because it mints a fresh `client_id`/`timestamp` per call (`gmgn.ts`). Call 1 saw upstream `status:429` (GMGN leaky bucket), which armed the gmgn gate → call 2 returned gateway `503 {"error":"gated"}`. This is live environment state, not a cache defect; a 429 envelope is non-cacheable regardless (`isCacheable` rejects non-2xx, `cache.ts:261`).

### a-iv. Nansen `flows` x2 (distinct time windows) — NEVER deduped (counters unchanged)
```
===== a-iv Nansen flows x2 (watcher, DISTINCT windows) =====
  flows #1:
    HTTP 200 in 0.230507s
    envelope.status=422 body_len=None
  flows #2:
    HTTP 200 in 0.240045s
    envelope.status=422 body_len=None
  metrics after a-iv:
gateway ok=true caller=a
credits day=2026-09-30 budget=10 half=5 used_a=2 used_b=2
cache hits=1 misses=6 joined=0 size=6 inflight=0
```
`cache` counters **unchanged** across both flows calls. Flows bypass the cache by construction (`cache.ts:85`: `classifyRequest` → `null`, "flows (moving window)"), so two time-windowed calls can never be falsely deduped. (The synthetic date windows were rejected upstream with `422`; a non-2xx is never cached either, and the counter evidence is the observable proof that flows take no cache path.) Run under the unbilled `watcher` token — flows never touched a/b credit.

## (b) Nansen credit equal split + over-half soft-deny (caller-scoped)
```
===== (b) START =====
BEFORE:
credits day=2026-09-30 budget=10 half=5 used_a=3 used_b=3
cache hits=3 misses=14 joined=0 size=12 inflight=0
limiter nansen-credit inFlight=0 queued=0 gateUntil=0 windowUsed=0
--- drive caller a: +BONK ---
    a/BONK HTTP 200 in 0.668225s
    envelope.status=200 body_len=725
--- drive caller a: +WIF ---
    a/WIF HTTP 200 in 0.503120s
    envelope.status=200 body_len=726
after drives:
credits day=2026-09-30 budget=10 half=5 used_a=5 used_b=3
cache hits=3 misses=16 joined=0 size=14 inflight=0
--- caller a at half: attempt over-half (PYTH, fresh key) ---
    a/PYTH HTTP 429 in 0.009737s
    response headers (budget marker):
HTTP/1.1 429 Too Many Requests
x-gateway-budget: exceeded
    response body:
{"error":"budget_exceeded"}
after a-denied:
credits day=2026-09-30 budget=10 half=5 used_a=5 used_b=3
cache hits=3 misses=17 joined=0 size=14 inflight=0
limiter nansen-credit inFlight=0 queued=0 gateUntil=0 windowUsed=0
--- caller b UNAFFECTED (PYTH, fresh key for b) ---
    b/PYTH HTTP 200 in 0.760070s
    envelope.status=200 body_len=733
FINAL:
credits day=2026-09-30 budget=10 half=5 used_a=5 used_b=4
cache hits=3 misses=18 joined=0 size=15 inflight=0
limiter nansen-credit inFlight=0 queued=0 gateUntil=0 windowUsed=0
===== (b) DONE =====
```
Caller a driven to exactly its half (5), then soft-denied with **HTTP 429 `{"error":"budget_exceeded"}` + `x-gateway-budget: exceeded`**; `used_a` froze at 5. Caller b, on the same endpoint, still got **HTTP 200** and its counter advanced (3→4) ⇒ the split is per-caller and exact (budget 10 / half 5). The shared `nansen-credit` limiter stayed untouched (`gateUntil=0`, `windowUsed=0`) throughout — the denial is a gateway pre-flight, never routed through the limiter, so it cannot degrade b.

## (c) Fail-open — gateway stopped, both instances keep serving
```
===== (c) START =====
health BEFORE : a=200 b=200 gateway=running
restart counts BEFORE: a-api restarts=0 running=true | b-api restarts=0 running=true
--- stopping gateway ---
 Container signal_scan-gateway-1 Stopping
 Container signal_scan-gateway-1 Stopped
gateway state after stop: exited
--- health DURING outage ---
health DURING : a=200 b=200
health DURING (2nd): a=200 b=200
restart counts DURING: a-api restarts=0 running=true | b-api restarts=0 running=true
--- api logs during outage (gateway warning) ---
2026-09-30T12:44:41.584Z WARN  [api] gateway /health unreachable — doors degraded err=TypeError:fetch failed
2026-09-30T12:44:41.621Z WARN  [api] gateway /health unreachable — doors degraded err=TypeError:fetch failed
--- restarting gateway ---
 Container signal_scan-gateway-1 Starting
 Container signal_scan-gateway-1 Started
gateway state after start: running
gateway health: 200
health AFTER  : a=200 b=200
restart counts AFTER: a-api restarts=0 running=true | b-api restarts=0 running=true
===== (c) DONE =====
```
Both instances returned HTTP 200 while the gateway was stopped, logged the `gateway /health unreachable — doors degraded` warning, did **not** crash-loop (`restarts=0`, `running=true` throughout), and recovered cleanly once the gateway was restarted (`gateway health=200`, a=200 b=200). The gateway was left running (restart guaranteed).

## (d) Egress IPs — CORRECT path (kept separate, never conflated)

### d1. GMGN/DexScreener egress = gateway container NAT = HOST public IP
```
===== (d) START =====
--- d1: host public IP ---
194.163.187.250
--- d1: gateway container egress IP (NAT of the gateway container) ---
194.163.187.250
--- d1: gateway container -> ipinfo (org) ---
{
  "ip": "194.163.187.250",
  "hostname": "vmi2958603.contaboserver.net",
  "city": "Lauterbourg",
  "region": "Grand Est",
  "country": "FR",
  "loc": "48.9751,8.1785",
  "org": "AS51167 Contabo GmbH",
  "postal": "67630",
  "timezone": "Europe/Paris",
  "readme": "https://ipinfo.io/missingauth"
}
```
d1 = `194.163.187.250`, identical to the host public IP (unchanged from today). The gateway egresses via its own NAT = the host public IP, so the GMGN allowlist still matches. The live GMGN response was `429` (rate), never `403 AUTH_IP_BLOCKED` (IP rejected) — consistent with "allowlisted but throttled".

### d2. Browser-DOOR egress = PROXY IP (separate path, NOT used for the allowlist check)
```
--- d2: door/proxy hosts (IPs only, never URLs) ---
proxy_entries=2
proxy#1 host_ip=167.86.101.228
proxy#2 host_ip=UNPARSED
proxy#1 egress_ip=167.86.101.228
proxy#2 egress_ip=UNREACHABLE(URLError)
```
d2 = `167.86.101.228` (measured egress through door proxy #1) ≠ d1 = `194.163.187.250`. Proxy #2 has no IPv4 literal and did not reach ipify (URLError); it is recorded as a separate unreachable entry. Proxy URLs/credentials were never printed.

## Findings / notes

1. All four proofs reproduced independently and match the plan's acceptance criteria.
2. Live pollers on a + b add concurrent counter noise; the credit cross-caller proof was captured inside a **verified quiet window** (metrics read stable over 2 s before and after), giving a clean `misses +2 / used_a +1 / used_b +1`.
3. `flows` upstream returned `422` for the synthetic date windows — environment/request-shape, not a cache defect. The observable proof that flows are never deduped/cached is the **unchanged cache counters** plus `cache.ts:85`.
4. A live GMGN upstream `429` armed the gmgn gate (call 2 → `503 gated`); this is environment (leaky bucket), not a defect. GMGN produced no cache hit and no cache entry (`cache.ts:91`).
5. The `(c)` gateway restart reset the in-memory credit/cache counters; proof `(b)` was captured **before** that restart, so its numbers are valid for that run.
6. Quota respected: caller a ended at its half (5) only because proof `(b)` requires driving it there; charged calls driven by F3 were a=4, b=3 (plus pre-existing poller usage), all ≤ the 5/caller guidance; flows ran under the unbilled `watcher` token.

## Verdict

- (a) dedupe — **PASS**: DexScreener cross-caller `miss+1/hit+1`; credit cross-caller `miss+2` with `used_a+1/used_b+1`; GMGN and flows leave `cache` counters unchanged.
- (b) credit split — **PASS**: a at half → `429 {"error":"budget_exceeded"}` + `x-gateway-budget: exceeded`; b still `200`; `nansen-credit` `gateUntil=0`.
- (c) fail-open — **PASS**: a/b `200` with the gateway stopped, `restarts=0`, warning logged, clean recovery.
- (d) egress — **PASS**: d1 = `194.163.187.250` = host public IP; d2 = `167.86.101.228` recorded separately.

APPROVE

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/f3-manual-qa.md
