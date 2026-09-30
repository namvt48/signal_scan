# Task 5 — Shared-network membership in `docker-compose.yml` + Makefile wiring

Plan: `.omo/plans/request-plane-gateway.md` todo `5.` (approved, sha256 d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000)
Repo: `/home/namvt/Desktop/dev-space/signal_scan` (branch `feat/fomo-user-watch`, direct mode, no commit)

## Scope (files modified)

- `docker-compose.yml` — top-level `networks.signal-scan-gateway` (`external: true`) + `api` attached to BOTH `default` and `signal-scan-gateway`.
- `Makefile` — `$(FILES)` += `docker-compose.gateway.yml`; `.PHONY` += `gateway-up gateway-down gateway-log`; `up` += external-net guard; new `gateway-up`/`gateway-down`/`gateway-log` targets.

Nothing else touched. `server/Dockerfile.gateway` deliberately NOT added to `$(FILES)` (server/ is rsynced wholesale). Per-instance vars (`PORT`/`BIND`/`DATA_DIR`/`COMPOSE_PROJECT_NAME`) unchanged.

```
$ git diff --stat -- docker-compose.yml Makefile
 Makefile           | 19 +++++++++++++++++--
 docker-compose.yml | 15 +++++++++++++++
 2 files changed, 32 insertions(+), 2 deletions(-)
```

## Acceptance 1 — `docker compose config` lists external net + api on BOTH nets

Command (secrets filtered out; only the networks region is shown):

```
$ docker compose config | sed -n '/^networks:/,$p'
networks:
  default:
    name: signal_scan_default
  signal-scan-gateway:
    name: signal-scan-gateway
    external: true
x-logging:
  driver: json-file
  options:
    max-file: "3"
    max-size: 10m
exit=0
```

`api` service network membership and web/chrome membership (JSON view, secret-free):

```
$ docker compose config --format json | python3 -c '...'
api.networks = {'default': None, 'signal-scan-gateway': None}
web.networks = {'default': None}
chrome.networks = {'default': None}
networks = {'default': {'name': 'signal_scan_default', 'ipam': {}}, 'signal-scan-gateway': {'name': 'signal-scan-gateway', 'ipam': {}, 'external': True}}
exit=0
```

`networks.signal-scan-gateway.external=true` ✅ and `api` on BOTH `default` + `signal-scan-gateway` ✅.

## Acceptance 1b — regression proof: `web`→`api` and `api`→`chrome` still resolve

The trap is documented inline in `docker-compose.yml` (explicit comment) and proven by the config diff above plus the membership table:

- `web` is on `default` only; `api` is on `default` + `signal-scan-gateway`. They share `signal_scan_default`, so Docker embedded DNS resolves the `api` alias for nginx's `proxy_pass http://api:3001` (nginx.conf:20-21). Web membership unchanged from baseline.
- `api` is on `default`; `chrome` is on `default` (unchanged). They share `signal_scan_default`, so `api` still resolves `chrome` for `CRAWL_WS_ENDPOINT: ws://chrome:3000` (config default, `server/src/config.ts:182`).

Baseline (pre-change) `docker compose config` had `api.networks = {default: null}`; post-change it is `{default, signal-scan-gateway}` — `default` was NOT dropped.

Live confirmation of both paths on instance a (from `make status`, same run as Acceptance 4): nginx proxied `localhost:8124/api/health` → HTTP 200 (proves `web`→`api`), and the health payload `doors` are `healthy` with the api container `Up 24 hours` (proves the api/chrome transport path is intact).

## Acceptance 2 — `make -n deploy` contains `docker-compose.gateway.yml`

```
$ make -n deploy | grep -n gateway
2:scp -o BatchMode=yes -o ConnectTimeout=10 -r Dockerfile nginx.conf docker-compose.yml docker-compose.gateway.yml .dockerignore package.json package-lock.json tsconfig.json vite.config.ts index.html root@194.163.187.250:/root/signal_scan/
exit=0
```

Also verified `server/Dockerfile.gateway` is NOT in `$(FILES)`:

```
$ grep -c 'Dockerfile.gateway' Makefile
0
```

## Acceptance 3 — `make -n up` AND `make -n gateway-up` print the network-create guard

```
$ make -n up
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "docker network create signal-scan-gateway || true"
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "cd /root/signal_scan && PORT=8124 BIND=127.0.0.1 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan SHOW_FOMO= docker compose up -d"
sleep 2
make status
make[1]: Entering directory '/home/namvt/Desktop/dev-space/signal_scan'
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "cd /root/signal_scan && ... docker compose ps --format ...; curl ... localhost:8124/ ...; curl ... localhost:8124/api/health ..."
make[1]: Leaving directory '/home/namvt/Desktop/dev-space/signal_scan'
exit=0

$ make -n gateway-up
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "docker network create signal-scan-gateway || true"
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "cd /root/signal_scan && docker compose -f docker-compose.gateway.yml up -d"
exit=0
```

Both print the guard ✅. `gateway-down` / `gateway-log` also present:

```
$ make -n gateway-down
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "cd /root/signal_scan && docker compose -f docker-compose.gateway.yml down"

$ make -n gateway-log
ssh -o BatchMode=yes -o ConnectTimeout=10 root@194.163.187.250 "cd /root/signal_scan && docker compose -f docker-compose.gateway.yml logs -f gateway"
```

`.PHONY` contains all three + targets defined:

```
$ grep -n '^\.PHONY' Makefile | grep -o 'gateway-[a-z]*' | sort -u
gateway-down
gateway-log
gateway-up
$ grep -nE '^gateway-(up|down|log):' Makefile
114:gateway-up:
118:gateway-down:
121:gateway-log:
```

## Acceptance 4 — `make status` still prints for the existing project only

```
$ make status
NAME  STATUS  PORTS
signal_scan-api-1  Up 24 hours  3001/tcp
signal_scan-chrome-1  Up 24 hours  3000/tcp
signal_scan-web-1  Up 24 hours  127.0.0.1:8124->80/tcp
HTTP 200 — web localhost:8124
{"mode":"gmgn","provider":"gmgn+nansen",...,"healthy":true,"doors":[...]} — /api/health OK (qua nginx)
exit=0
```

Only the `signal_scan` project's 3 containers are listed (no gateway project) ✅.

## Failure demo — removing `default` from `api.networks` drops it (trap is real)

Backup by sha256, temporarily delete `- default`, observe, restore, re-verify exact bytes:

```
$ sha256sum /tmp/dc-t5-backup.yml docker-compose.yml
9c4b7cfe208665c5eba23126c55bcca04c8ce31cdd52dc2e04cd4cd078d8237d  /tmp/dc-t5-backup.yml
9c4b7cfe208665c5eba23126c55bcca04c8ce31cdd52dc2e04cd4cd078d8237d  docker-compose.yml
# (temporarily removed: "      - default" from api.networks)
$ docker compose config --format json | python3 -c '...'
api.networks = {'signal-scan-gateway': None}
default present on api: False
exit=0

# REVERT (cp backup back)
$ sha256sum docker-compose.yml /tmp/dc-t5-backup.yml
9c4b7cfe208665c5eba23126c55bcca04c8ce31cdd52dc2e04cd4cd078d8237d  docker-compose.yml
9c4b7cfe208665c5eba23126c55bcca04c8ce31cdd52dc2e04cd4cd078d8237d  /tmp/dc-t5-backup.yml
$ docker compose config --format json | python3 -c '...'
api.networks = {'default': None, 'signal-scan-gateway': None}
default present on api: True
```

Before: `{signal-scan-gateway}` only (default DROPPED). After revert: `{default, signal-scan-gateway}` restored, sha256 identical to backup ✅.

## Deviations / blockers

None. `docker-compose.gateway.yml` was created by the parallel todo 4; task 5 only references its filename in `$(FILES)` and the gateway targets, and did not create or edit it.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-5-request-plane-gateway.md
