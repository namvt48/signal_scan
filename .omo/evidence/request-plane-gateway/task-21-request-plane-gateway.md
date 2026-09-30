# Task 21 — Deploy gateway to the host and connect a + b

Plan: `.omo/plans/request-plane-gateway.md` (todo 21, block at lines 257-263).
Host: `root@194.163.187.250` (vmi2958603). Date: 2026-09-30.
Repo HEAD (pre-cutover): `c6b75dd89efeba81d944951b835b2917aaefdff1`
(`feat(gateway): expose limiter and credit metrics`).
Deploy commit (this todo): `chore(deploy): deploy gateway and attach instances a and b` — sha filled after commit.
**No secret VALUE is written anywhere in this file — env-file PATHS + variable NAMES only; every
command output below is masked or reduced to names/ids.**

## Phases

- [x] 0. Evidence skeleton written
- [x] 1. Backup `server/.env` + rollback data recorded
- [x] 2. Gateway deployed (net + `/root/signal-scan-gateway/` + compose up) — see DEVIATION below
- [x] 3. Cut over a and b (host-only env; recreate api only)
- [x] 4. Acceptance verification (incl. failure case)
- [x] 5. Watcher `GATEWAY_TOKEN_WATCHER` pushed into systemd units + restart
- [x] 6. Commit + plan checkbox

## ROLLBACK data (phase 1)

- a's `server/.env` backup PATH (values never read/copied into this file):
  `/root/signal_scan/server/.env.bak.20260930T121642Z` (2217 B, mode 600, root-owned)
- b's `server/.env` backup PATH (defensive; cutover edits b's file too):
  `/root/signal_scan_b/server/.env.bak.20260930T121642Z` (2502 B, mode 600, root-owned)
- pre-cutover api image id:
  - a: `signal_scan-api` → `sha256:76c8db7ced942d8400d71b152eb09ed544762ca58ced38c87a33afa006ed9c6c`
  - b: `signal_scan_b-api` → `sha256:9fc2a73ae390c3aef2b5bd8cfcf4ded865bf9ca473d2de2aee8b47d62bf54046`
- pre-cutover commit sha (local HEAD before the deploy commit): `c6b75dd89efeba81d944951b835b2917aaefdff1`
- pre-todo-13 sha used by the rollback checkout: `1e9ee7f2550a8aaea1ec1e3081c002a3a94f202c`
  (`test(gateway): end-to-end route integration tests`; parent of todo-13 `59e7ae5`)
- pre-change container start-time snapshot (a + b) — chrome/web MUST stay unchanged
  (proves the cutover touched ONLY api):

  | container | pre-cutover StartedAt (UTC) |
  |---|---|
  | `signal_scan-api-1` | `2026-09-29T09:49:39.780143861Z` |
  | `signal_scan_b-api-1` | `2026-09-30T03:33:31.447545515Z` |
  | `signal_scan-web-1` | `2026-09-29T09:32:22.579098165Z` |
  | `signal_scan_b-web-1` | `2026-09-29T11:10:28.840589637Z` |
  | `signal_scan-chrome-1` | `2026-09-29T09:32:22.572306880Z` |
  | `signal_scan_b-chrome-1` | `2026-09-29T09:32:22.571698456Z` |

- host state BEFORE (clean): no `signal-scan-gateway` network (`docker network inspect` →
  `network ... not found`), no `/opt/signal-scan-gateway/`; `signal_scan-api-1` Up 26 h,
  `signal_scan_b-api-1` Up 9 h.

### The ONE exact rollback command

```
cp <env-backup> /root/signal_scan/server/.env && \
  git checkout 1e9ee7f -- server/ docker-compose.yml && \
  make deploy INSTANCE=a && make up INSTANCE=a
```

`Makefile deploy` runs `docker compose build` + syncs sources but does NOT recreate containers, so
the trailing `make up INSTANCE=a` (or `docker compose up -d --no-deps api` on the pinned prior image)
is required or the api keeps running the gateway build.

## STOP-GAP (labelled; NOT a data-path rollback)

Blank `GATEWAY_URL` / `GATEWAY_CALLER_TOKEN` in the host `server/.env` and
`docker compose up -d --no-deps api`: this halts gateway calls (`gatewayUrl===''` disables the
gateway client, todo 14) and the api constructs **no upstream client** and serves only its own
**STALE DB**. It is NOT a data-path rollback (the pre-gateway code still needs its keys restored).

## Accepted limitation (documented, NOT mitigated)

`docker compose up -d` RECREATES the single-replica api container, so the cutover costs a few
seconds of 502 through Caddy. Acceptable for this self-hosted dashboard. **NO zero-downtime claim
is made.**

## Evidence

(filled per phase below)

### Phase 1 — backup + rollback data (2026-09-30T12:16Z)

Backup taken BEFORE any host mutation:

```
$ STAMP=20260930T121642Z
$ cp -p /root/signal_scan/server/.env   /root/signal_scan/server/.env.bak.$STAMP
$ cp -p /root/signal_scan_b/server/.env /root/signal_scan_b/server/.env.bak.$STAMP
$ ls -l /root/signal_scan/server/.env*
-rw------- 1 root root 2217 Sep 29 10:26 /root/signal_scan/server/.env
-rw------- 1 root root 2217 Sep 29 10:26 /root/signal_scan/server/.env.bak.20260930T121642Z
$ ls -l /root/signal_scan_b/server/.env*
-rw------- 1 root root 2502 Sep 29 13:09 /root/signal_scan_b/server/.env
-rw------- 1 root root 2502 Sep 29 13:09 /root/signal_scan_b/server/.env.bak.20260930T121642Z
```

`docker inspect` image ids + start times before the change — recorded in the ROLLBACK
section above (a api `76c8db7c…`, b api `9fc2a73a…`; chrome/web/a-web/b-web start times
frozen there as the "unchanged" baseline). Env **variable NAMES only** observed in a's
`.env` (values never printed): `NANSEN_API_KEY`, `GMGN_API_KEY`, `CRAWL_PROXY_FILE`,
`SERVICE_TOKEN`, `SOLANA_RPC_URL`, `AUTH_USER_ROLES`, `FIREBASE_PROJECT_ID`, `MODE`,
`DB_PATH`, `PORT`, `GMGN_PLAN_WEIGHT`, `POLL_*`, `SWEEP_PACE_FACTOR`,
  `SOLANA_RPC_MIN_INTERVAL_MS` — **no `GATEWAY_*` present, no `RL_*` present** (RL_* keys
  are read by `ratelimit/spec.ts` with in-code defaults and are NOT mirrored into `.env`).

### Phase 2a — source/image deployment to host (2026-09-30T~12:19Z)

Resume note: `docker-compose.gateway.yml` / `server/Dockerfile.gateway` were **absent** from BOTH
host dirs (`ls` → `No such file or directory`); the host dirs are rsync targets, not git clones
(`git log` → `not a git repository`). The gateway compose file + gateway Dockerfile are part of the
repo `FILES` list, so a `make deploy` per instance shipped them and rebuilt the api/web images
(build only — no container recreate, so running containers keep the pre-cutover images).

```
$ make deploy INSTANCE=a   # exit 0
== deploy OK — instance=a port=8124 dir=/root/signal_scan
$ make deploy INSTANCE=b   # exit 0
== deploy OK — instance=b port=8125 dir=/root/signal_scan_b
```

Post-deploy host checks:

```
$ ls -la /root/signal_scan/docker-compose.gateway.yml /root/signal_scan/server/Dockerfile.gateway
-rw-r--r-- 1 root root 3082 Sep 30 14:19 docker-compose.gateway.yml
-rw-rw-r-- 1 1000 1000  369 Sep 30 11:16 server/Dockerfile.gateway

$ docker images --no-trunc (extract)
signal_scan-api:latest    sha256:426ed1a7d5f96acae32ffdfd83f11469f6acafb0016b0046bcf47ce1f9593f97
signal_scan-web:latest    sha256:27a221ba962ad07c35fd09dc40be97d8531f9f5026665ba0d7b5c24ae1b15d27
signal_scan_b-api:latest  sha256:c7470847f07ddecdaef2b5348fab6f129a24bb594cbd780ac17ba7eb7438f09c
signal_scan_b-web:latest  sha256:617a90994825d06d57bd9619022086d6b7c765b46c6ad4aa0ca97b16508359d4

$ docker inspect --format '{{.Name}} img={{.Image}}' signal_scan-api-1 signal_scan_b-api-1
/signal_scan-api-1   img=sha256:76c8db7ced942d8400d71b152eb09ed544762ca58ced38c87a33afa006ed9c6c  (pre-cutover, unchanged as of this step)
/signal_scan_b-api-1 img=sha256:9fc2a73ae390c3aef2b5bd8cfcf4ded865bf9ca473d2de2aee8b47d62bf54046  (pre-cutover, unchanged as of this step)
```

`gateway.env` required-key precheck (required = `nansenApiKey`, `gmgnApiKey`, `gatewayTokenA`,
`gatewayTokenB`, `gatewayTokenWatcher`): all five present and non-blank (names only; no values read).

### Phase 2b — gateway UP on host + `/opt` → `/root` DEVIATION (2026-09-30T12:25Z)

> **DEVIATION (host-specific, blocking workaround):** the host runs the **snap** build of docker
> (Ubuntu Core 24). `readlink -f "$(command -v docker)"` → `/usr/bin/snap`. Snap confinement
> CANNOT bind-mount from `/opt`; reproduced with a real container probe:

```
$ docker run --rm -v /opt/signal-scan-gateway/gateway.env:/probe.txt:ro \
    --entrypoint /bin/ls signal_scan-gateway /probe.txt
docker: Error response from daemon: error while creating mount source path
  '/opt/signal-scan-gateway/gateway.env': mkdir /opt/signal-scan-gateway: read-only file system

$ docker run --rm -v /root/signal-scan-gateway/gateway.env:/probe.txt:ro \
    --entrypoint /bin/ls signal_scan-gateway /probe.txt
/probe.txt
```

> **Resolution:** the gateway host dir was **RELOCATED `/opt/signal-scan-gateway/` →
> `/root/signal-scan-gateway/`**. Repo `docker-compose.gateway.yml` (already edited, commented at
> lines 11-17) now binds `/root/signal-scan-gateway/gateway.env` + `proxies.txt`. The **live env
> file is `/root/signal-scan-gateway/gateway.env`** (mode 600). A stale
> `/opt/signal-scan-gateway/gateway.env` copy (also 612 B) exists and is **UNUSED — ignore it.**

Gateway network + container UP proof:

```
$ docker network inspect signal-scan-gateway --format '{{.Id}} {{.Name}}'
e5877de717d326ab93be9eb1e1607e2462716223a7ec75a24c8524bb3a4654e7 signal-scan-gateway
$ docker network inspect signal-scan-gateway  →  containers: signal_scan-gateway-1,
  signal_scan-gateway-chrome-1   (a/b api NOT yet members — phase 3)

$ docker ps --format '{{.Names}}|{{.Status}}' | grep gateway
signal_scan-gateway-1|Up About a minute
signal_scan-gateway-chrome-1|Up 2 minutes
$ docker inspect --format '{{.Name}} restarts={{.RestartCount}} started={{.State.StartedAt}}' \
    signal_scan-gateway-1 signal_scan-gateway-chrome-1
/signal_scan-gateway-1        restarts=0 started=2026-09-30T12:24:31.336259289Z
/signal_scan-gateway-chrome-1 restarts=0 started=2026-09-30T12:23:16.002002827Z

$ curl -sf -w ' HTTP %{http_code}\n' http://127.0.0.1:8130/health
{"ok":true,"ratelimit":{"gmgn":{"inFlight":0,"queued":0,"gateUntil":0,"windowUsed":0},
 "solana-rpc":{...},"nansen-credit":{...},"nansen-door":{...},"dexscreener":{...},
 "dexscreener-profiles":{...}},"doors":null} HTTP 200
```

Every limiter key (`gmgn`, `solana-rpc`, `nansen-credit`, `nansen-door`, `dexscreener`,
`dexscreener-profiles`) is present in the body; `HTTP 200`. Gateway up, 0 restarts.

### Phase 3a — cut over instance **a** (`/root/signal_scan`) (2026-09-30T12:26Z)

Host-only `server/.env` edited (values never printed; only variable NAMES shown):
- ADDED `GATEWAY_URL=http://gateway:8130`, `GATEWAY_CALLER_TOKEN` (= `GATEWAY_TOKEN_A` read from
  `/root/signal-scan-gateway/gateway.env`, never echoed)
- REMOVED `NANSEN_API_KEY`, `GMGN_API_KEY`
- pre-cutover env re-backup: `/root/signal_scan/server/.env.bak.precutover.20260930T1225Z` (mode 600)

```
$ grep -oE '^[A-Z_]+=' server/.env | sort
AUTH_USER_ROLES= CRAWL_PROXY_FILE= DB_PATH= FIREBASE_PROJECT_ID= GATEWAY_CALLER_TOKEN=
GATEWAY_URL= GMGN_PLAN_WEIGHT= MODE= POLL_*  PORT= SERVICE_TOKEN= SOLANA_RPC_*  SWEEP_PACE_FACTOR=
$ checks: GATEWAY_CALLER_TOKEN set (non-empty) | GATEWAY_URL correct |
          NANSEN_API_KEY removed | GMGN_API_KEY removed | perms -rw------- 600
```

Recreate ONLY api (web + chrome start times frozen):

```
$ docker inspect --format 'PRE  {{.Name}} {{.State.StartedAt}}' api web chrome
PRE  /signal_scan-api-1    2026-09-29T09:49:39.780143861Z
PRE  /signal_scan-web-1    2026-09-29T09:32:22.579098165Z
PRE  /signal_scan-chrome-1 2026-09-29T09:32:22.572306880Z

$ docker compose up -d --no-deps api
 Container signal_scan-api-1 Recreate
 Container signal_scan-api-1 Recreated
 Container signal_scan-api-1 Starting
 Container signal_scan-api-1 Started

$ docker inspect --format 'POST {{.Name}} {{.State.StartedAt}}' api web chrome
POST /signal_scan-api-1    2026-09-30T12:26:52.586875218Z   <-- api RECREATED
POST /signal_scan-web-1    2026-09-29T09:32:22.579098165Z   <-- UNCHANGED
POST /signal_scan-chrome-1 2026-09-29T09:32:22.572306880Z   <-- UNCHANGED
```

> ⚠ `docker compose up` printed: `Found orphan containers (signal_scan-gateway-1,
> signal_scan-gateway-chrome-1) for this project`. The gateway compose file runs under the same
> Compose project name (`signal_scan`) as instance a, so a bare `up --remove-orphans` would delete
> the gateway containers. `up --no-deps api` (used here) does **not** remove them — gateway still Up.
> Recorded as an operational risk; NOT fixed (out of scope, would restart the gateway).

Connectivity from inside a's NEW api (`curl` absent from the image → Node 20 `fetch` used as the
equivalent of `curl -sf`, node exit 0):

```
$ docker exec signal_scan-api-1 getent hosts gateway
172.25.0.3      gateway
$ docker exec signal_scan-api-1 node -e 'fetch("http://gateway:8130/health").then(...)'
NODE_FETCH_OK ok=true limiters=gmgn,solana-rpc,nansen-credit,nansen-door,dexscreener,dexscreener-profiles

$ docker exec signal_scan-api-1 sh -c 'env | grep -oE "^(GATEWAY_URL|GATEWAY_CALLER_TOKEN|NANSEN_API_KEY|GMGN_API_KEY)="'
GATEWAY_URL=
GATEWAY_CALLER_TOKEN=          (NANSEN_API_KEY / GMGN_API_KEY absent)

$ curl -s -w 'HTTP %{http_code}' http://127.0.0.1:8124/api/health   (a, via web nginx)
HTTP 200 {"mode":"gmgn","provider":"gmgn+nansen","healthy":true,...}
```

### Phase 3b — cut over instance **b** (`/root/signal_scan_b`) (2026-09-30T12:37Z)

> Provenance: phases 2b-3a were done by a background worker that then died at its report turn
> (the recurring `content[].thinking …` provider fault); **phases 3b, 4 and 5 were completed by the
> orchestrator directly** after 3 worker crashes on this todo (the `/opt`→`/root` snap fix above was
> also the orchestrator's). Same commands, same masking discipline.

Host-only `server/.env` edited (NAMES only):
- ADDED `GATEWAY_URL=http://gateway:8130`, `GATEWAY_CALLER_TOKEN` (= `GATEWAY_TOKEN_B`)
- REMOVED `NANSEN_API_KEY`, `GMGN_API_KEY`

```
$ grep -oE '^(NANSEN_API_KEY|GMGN_API_KEY|GATEWAY_URL|GATEWAY_CALLER_TOKEN)=' server/.env | sort
GATEWAY_CALLER_TOKEN=
GATEWAY_URL=                                   (NANSEN/GMGN keys absent)
$ docker compose up -d --no-deps api
 Container signal_scan_b-api-1 Recreate / Recreated / Starting / Started
$ docker exec signal_scan_b-api-1 getent hosts gateway
172.25.0.3      gateway
$ docker exec signal_scan_b-api-1 node -e 'http.get("http://gateway:8130/health",...)'
gw_status 200
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8125/api/health   (b)
200
```

### Phase 4 — acceptance verification + failure case (2026-09-30T12:38Z)

```
$ docker network inspect signal-scan-gateway -f '{{range .Containers}}{{.Name}} {{end}}'
signal_scan-gateway-chrome-1 signal_scan-api-1 signal_scan-gateway-1 signal_scan_b-api-1

$ docker network inspect signal_scan_default  -f '...'   (a's DEFAULT net INTACT — dual-membership OK)
signal_scan-api-1 signal_scan-web-1 signal_scan-chrome-1
$ docker network inspect signal_scan_b_default -f '...'
signal_scan_b-web-1 signal_scan_b-chrome-1 signal_scan_b-api-1

$ docker exec signal_scan-api-1 node -e '...gateway:8130/health...'
gw_status 200
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8124/api/health   (a web -> api)
200
$ docker inspect -f '{{.Name}} started={{.State.StartedAt}}' signal_scan-web-1 signal_scan-chrome-1
/signal_scan-web-1    started=2026-09-29T09:32:22.579098165Z   (UNCHANGED vs phase 1)
/signal_scan-chrome-1 started=2026-09-29T09:32:22.572306880Z   (UNCHANGED vs phase 1)

FAILURE CASE (proves the wiring):
$ docker network disconnect signal-scan-gateway signal_scan-api-1
$ docker exec signal_scan-api-1 getent hosts gateway
                                       (empty -> resolution FAILS as expected)
$ docker network connect signal-scan-gateway signal_scan-api-1
$ docker exec signal_scan-api-1 getent hosts gateway
172.25.0.3      gateway                (restored)
```

### Phase 5 — watcher `GATEWAY_TOKEN_WATCHER` into systemd units (2026-09-30T12:39Z)

`GATEWAY_TOKEN_WATCHER` read from `/root/signal-scan-gateway/gateway.env` and written as
`GATEWAY_CALLER_TOKEN` into `/etc/systemd/system/wallet-watch.service.d/track.conf`,
`/opt/fomo-watch/fomo.env`, and `/etc/systemd/system/fomo-watch.service.d/gateway.conf`.

```
$ /proc/<MainPID>/environ  token_len (name+length only, value never printed):
wallet-watch pid=3463625 token_len=64
fomo-watch   pid=3463623 token_len=64
$ systemctl is-active wallet-watch fomo-watch
active
active
$ journalctl -u fomo-watch -n 12  -> clean restart 14:28:47, no errors
$ heartbeats (before -> +30 s):
/opt/wallet-watch/heartbeat   1790771358 -> 1790771388   (advancing)
/opt/fomo-watch/fomo_heartbeat 1790771357 -> 1790771387  (advancing)
```

### Phase 6 — commit + tick

```
$ git commit -m 'chore(deploy): deploy gateway and attach instances a and b'
plan checkbox 21 ticked; docker-compose.gateway.yml (/opt -> /root) + this evidence committed.
```

### Post-cutover operational notes (recorded, NOT fixed — out of scope)

- The gateway compose runs under the SAME Compose project name (`signal_scan`) as instance a, so a
  bare `docker compose up --remove-orphans` inside `/root/signal_scan` would delete the gateway
  containers. Always use `--no-deps <service>` (as done here). The gateway still shows Up.
- A stale `/opt/signal-scan-gateway/{gateway.env,proxies.txt}` copy remains (unused); the live files
  are `/root/signal-scan-gateway/*`. Safe to delete later.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-21-request-plane-gateway.md


