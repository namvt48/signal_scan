# task-4 — request-plane-gateway: gateway compose project

Scope: NEW file `docker-compose.gateway.yml` ONLY. `docker-compose.yml`, `Makefile`, `server/src/config.ts` untouched.

Deliverable: `docker-compose.gateway.yml` (root of repo).
- `gateway` service on external network `signal-scan-gateway`, loopback-only publish `127.0.0.1:8130:8130`.
- Own browserless `gateway-chrome` (NOT `chrome`), `CRAWL_WS_ENDPOINT=ws://gateway-chrome:3000`, mirrors `docker-compose.yml:21-41` limits (`mem_limit: 6g`, `shm_size: 2g`, `CONNECTION_TIMEOUT: 1800000`, json-file log cap).
- RO mounts: `/opt/signal-scan-gateway/proxies.txt` → `/data/proxies.txt` with `CRAWL_PROXY_FILE=/data/proxies.txt`; `/opt/signal-scan-gateway/gateway.env` → `/run/gateway.env` (host-only env_file, root-owned mode 600; never committed).
- One-time host command documented in the file header: `docker network create signal-scan-gateway`.

---

## 1. HAPPY — `docker compose -f docker-compose.gateway.yml config`

Command:

```
docker compose -f docker-compose.gateway.yml config
```

Observed exit code: `0` (stderr = 0 bytes).

Verbatim stdout:

```yaml
name: signal_scan
services:
  gateway:
    build:
      context: /home/namvt/Desktop/dev-space/signal_scan/server
      dockerfile: Dockerfile.gateway
    depends_on:
      gateway-chrome:
        condition: service_started
        required: true
    environment:
      CRAWL_PROXY_FILE: /data/proxies.txt
      CRAWL_WS_ENDPOINT: ws://gateway-chrome:3000
      GATEWAY_PORT: "8130"
    logging:
      driver: json-file
      options:
        max-file: "3"
        max-size: 10m
    networks:
      signal-scan-gateway: null
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 8130
        published: "8130"
        protocol: tcp
    restart: unless-stopped
    volumes:
      - type: bind
        source: /opt/signal-scan-gateway/proxies.txt
        target: /data/proxies.txt
        read_only: true
        bind: {}
      - type: bind
        source: /opt/signal-scan-gateway/gateway.env
        target: /run/gateway.env
        read_only: true
        bind: {}
  gateway-chrome:
    environment:
      CONNECTION_TIMEOUT: "1800000"
    image: browserless/chrome:1.61-chrome-stable
    logging:
      driver: json-file
      options:
        max-file: "3"
        max-size: 10m
    mem_limit: "6442450944"
    networks:
      signal-scan-gateway: null
    restart: unless-stopped
    shm_size: "2147483648"
networks:
  signal-scan-gateway:
    name: signal-scan-gateway
    external: true
x-logging:
  driver: json-file
  options:
    max-file: "3"
    max-size: 10m
```

The four required elements, cited from the output above:

| # | Element | Line in output |
|---|---------|----------------|
| 1 | external network declaration | `networks:` → `name: signal-scan-gateway` + `external: true` |
| 2 | loopback-only binding | `host_ip: 127.0.0.1`, `target: 8130`, `published: "8130"` |
| 3 | own `gateway-chrome` service | `gateway-chrome:` with `mem_limit: "6442450944"` (=6g) + `shm_size: "2147483648"` (=2g) |
| 4 | proxy mount | `source: /opt/signal-scan-gateway/proxies.txt` → `target: /data/proxies.txt`, `read_only: true` |

Extra: `CRAWL_WS_ENDPOINT: ws://gateway-chrome:3000` (not `ws://chrome:3000`) and the env mount `/opt/signal-scan-gateway/gateway.env` → `/run/gateway.env:ro`.

## 2. FAILURE — drop `external: true` → project-scoped default net

Throwaway variant (deliverable file NOT edited; generated a sibling temp file and deleted it after):

```
sed '/^    external: true$/d' docker-compose.gateway.yml > docker-compose.gateway.failtest.yml
docker compose -f docker-compose.gateway.failtest.yml config
```

Observed exit code: `0`.

Verbatim stdout `networks:` block:

```yaml
networks:
  signal-scan-gateway:
    name: signal_scan_signal-scan-gateway
```

Proof: without `external: true` compose treats the key as a project-owned net and renames it `signal_scan_signal-scan-gateway` (project `signal_scan` prefixes it). Instances a/b join the pre-created `signal-scan-gateway` — a project-scoped different name would not resolve, so the declaration is load-bearing. Reverted: temp file deleted; `grep -n "external: true" docker-compose.gateway.yml` shows the live declaration at line 75; re-run happy `config` exits `0`.

Cleanup + revert evidence:

```
rm -f docker-compose.gateway.failtest.yml
grep -n "external: true" docker-compose.gateway.yml
75:    external: true
docker compose -f docker-compose.gateway.yml config >/dev/null 2>&1; echo "EXIT=$?"
EXIT=0
```

## 3. Scope guard

`git status --short` for the files this todo must NOT touch (pre-existing modifications from other waves, left as-is, NOT reverted or committed):

```
 M Makefile
 M docker-compose.yml
?? docker-compose.gateway.yml
```

No `git add` / `git commit` / branch / push performed. No secret value printed; `gateway.env`/`proxies.txt` are referenced by path only and never created or committed.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-4-request-plane-gateway.md
