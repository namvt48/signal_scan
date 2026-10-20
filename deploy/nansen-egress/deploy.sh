#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
EGRESS_HOST=root@194.163.187.250
GATEWAY_HOST=root@167.86.101.228
EGRESS_IP=194.163.187.250
GATEWAY_IP=167.86.101.228
GATEWAY_DIR=${GATEWAY_DIR:-/root/signal_scan}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
SCP=(scp -o BatchMode=yes -o ConnectTimeout=10)

command -v ssh >/dev/null
command -v ssh-keygen >/dev/null
command -v scp >/dev/null
command -v python3 >/dev/null

# Pin the already-trusted VPS 250 host key into the VPS 228 tunnel's private file.
known_raw=$(mktemp)
known_pinned=$(mktemp)
trap 'rm -f "$known_raw" "$known_pinned"' EXIT
ssh-keygen -F "$EGRESS_IP" -f "$HOME/.ssh/known_hosts" > "$known_raw"
python3 - "$known_raw" "$known_pinned" <<'PY'
import pathlib
import sys

records = [line for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line and not line.startswith("#")]
if not records or not any("ssh-ed25519" in line for line in records):
    raise SystemExit("no trusted Ed25519 host key found for VPS 250")
pathlib.Path(sys.argv[2]).write_text("\n".join(records) + "\n")
PY

EGRESS_PREFLIGHT='set -eu; test ! -L /root/signal-scan-egress; command -v docker >/dev/null; docker info >/dev/null'
GATEWAY_PREFLIGHT='set -eu; test -f /root/signal-scan-gateway/gateway.env; test -f /root/signal-scan-gateway/proxies.txt; docker network inspect signal-scan-gateway >/dev/null; curl -fsS http://127.0.0.1:8130/health >/dev/null'
"${SSH[@]}" "$EGRESS_HOST" "$EGRESS_PREFLIGHT"
"${SSH[@]}" "$GATEWAY_HOST" "$GATEWAY_PREFLIGHT"
source "$ROOT_DIR/deploy/nansen-egress/check-api-health.sh"
check_api_health
BRIDGE_IP=$("${SSH[@]}" "$GATEWAY_HOST" "docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' signal-scan-gateway")
[[ "$BRIDGE_IP" =~ ^172\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]
FW_WS_ENDPOINTS="ws://gateway-chrome:3000,ws://${BRIDGE_IP}:31135"

# Browserless runs on VPS 250 itself; host publication remains loopback-only.
"${SSH[@]}" "$EGRESS_HOST" 'install -d -o root -g root -m 0700 /root/signal-scan-egress'
"${SCP[@]}" "$ROOT_DIR/deploy/nansen-egress/docker-compose.browser.yml" "$EGRESS_HOST:/root/signal-scan-egress/docker-compose.browser.yml"
if ! "${SSH[@]}" "$EGRESS_HOST" 'set -eu; chmod 0600 /root/signal-scan-egress/docker-compose.browser.yml; docker compose --project-name signal-scan-fw-browser -f /root/signal-scan-egress/docker-compose.browser.yml config --quiet; docker compose --project-name signal-scan-fw-browser -f /root/signal-scan-egress/docker-compose.browser.yml up -d; for i in $(seq 1 30); do curl --silent --show-error --fail --max-time 3 http://127.0.0.1:31135/json/version >/dev/null && break; sleep 2; done; curl --silent --show-error --fail --max-time 3 http://127.0.0.1:31135/json/version >/dev/null; listener=$(ss -lntH "sport = :31135"); [[ "$listener" == *"127.0.0.1:31135"* && "$listener" != *"0.0.0.0:31135"* && "$listener" != *"[::]:31135"* ]]'; then
  "${SSH[@]}" "$EGRESS_HOST" 'docker compose --project-name signal-scan-fw-browser -f /root/signal-scan-egress/docker-compose.browser.yml down' || true
  exit 1
fi

# Use a separate key: the browser tunnel can reach only loopback:31135 on VPS 250.
"${SSH[@]}" "$GATEWAY_HOST" 'set -eu; install -d -o root -g root -m 0700 /root/signal-scan-egress; if [ ! -e /root/signal-scan-egress/fw-browser_id_ed25519 ]; then ssh-keygen -q -t ed25519 -N "" -C signal-scan-fw-browser-vps250 -f /root/signal-scan-egress/fw-browser_id_ed25519; fi; chmod 0600 /root/signal-scan-egress/fw-browser_id_ed25519; chmod 0644 /root/signal-scan-egress/fw-browser_id_ed25519.pub'
TUNNEL_PUBLIC_KEY=$("${SSH[@]}" "$GATEWAY_HOST" 'cat /root/signal-scan-egress/fw-browser_id_ed25519.pub')
[[ "$TUNNEL_PUBLIC_KEY" == ssh-ed25519\ * ]]
"${SCP[@]}" "$ROOT_DIR/deploy/nansen-egress/install_forward_key.py" "$EGRESS_HOST:/root/signal-scan-egress/install_forward_key.py"
printf '%s\n' "$TUNNEL_PUBLIC_KEY" | "${SSH[@]}" "$EGRESS_HOST" 'set -eu; chmod 0700 /root/signal-scan-egress/install_forward_key.py; TUNNEL_SOURCE_IP=167.86.101.228 TUNNEL_PORT=31135 python3 /root/signal-scan-egress/install_forward_key.py'
"${SCP[@]}" "$known_pinned" "$GATEWAY_HOST:/root/signal-scan-egress/known_hosts"
"${SCP[@]}" "$ROOT_DIR/deploy/nansen-egress/signal-scan-fw-browser-tunnel.service" "$GATEWAY_HOST:/root/signal-scan-egress/signal-scan-fw-browser-tunnel.service"
printf 'BIND_ADDRESS=%s\n' "$BRIDGE_IP" | "${SSH[@]}" "$GATEWAY_HOST" 'set -eu; umask 077; cat > /root/signal-scan-egress/fw-browser-tunnel.env; chmod 0600 /root/signal-scan-egress/fw-browser-tunnel.env; chmod 0644 /root/signal-scan-egress/known_hosts /root/signal-scan-egress/signal-scan-fw-browser-tunnel.service; install -m 0644 /root/signal-scan-egress/signal-scan-fw-browser-tunnel.service /etc/systemd/system/signal-scan-fw-browser-tunnel.service; systemd-analyze verify /etc/systemd/system/signal-scan-fw-browser-tunnel.service; systemctl daemon-reload; systemctl enable signal-scan-fw-browser-tunnel.service; systemctl restart signal-scan-fw-browser-tunnel.service; systemctl is-active --quiet signal-scan-fw-browser-tunnel.service'

# Verify the SSH-forwarded Browserless endpoint from the gateway container network.
"${SSH[@]}" "$GATEWAY_HOST" "set -eu; for i in \$(seq 1 20); do docker exec signal_scan-gateway-1 node -e 'fetch(\"http://${BRIDGE_IP}:31135/json/version\").then(async r=>{if(!r.ok)process.exit(1);const j=await r.json();if(typeof j!==\"object\")process.exit(1)}).catch(()=>process.exit(1))' && break; sleep 2; done; docker exec signal_scan-gateway-1 node -e 'fetch(\"http://${BRIDGE_IP}:31135/json/version\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'"

# Preserve the old proxy routing file. Only the FW Gini path receives the two direct WS routes.
PROXY_SHA_BEFORE=$("${SSH[@]}" "$GATEWAY_HOST" 'sha256sum /root/signal-scan-gateway/proxies.txt | cut -d " " -f 1')
ENV_BACKUP=$("${SSH[@]}" "$GATEWAY_HOST" 'set -eu; backup=/root/signal-scan-gateway/gateway.env.before-fw-browser.$(date -u +%Y%m%dT%H%M%SZ); test ! -e "$backup" || backup="${backup}.$$"; cp -a /root/signal-scan-gateway/gateway.env "$backup"; printf "%s" "$backup"')
"${SCP[@]}" "$ROOT_DIR/deploy/nansen-egress/set_gateway_env.py" "$GATEWAY_HOST:/root/signal-scan-egress/set_gateway_env.py"
REMOTE_BUILD="cd '$GATEWAY_DIR' && if [ -f /root/signal-scan-monitor/monitor.env ]; then docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml build gateway; else docker compose -f docker-compose.gateway.yml build gateway; fi"
REMOTE_UP="cd '$GATEWAY_DIR' && if [ -f /root/signal-scan-monitor/monitor.env ]; then docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml up -d --no-deps --force-recreate gateway; else docker compose -f docker-compose.gateway.yml up -d --no-deps --force-recreate gateway; fi"
env_changed=0
rollback_gateway_env() {
  if [[ "$env_changed" != 1 ]]; then return 0; fi
  printf 'Restoring prior gateway environment and direct FW route.\n' >&2
  if "${SSH[@]}" "$GATEWAY_HOST" "cp -a '$ENV_BACKUP' /root/signal-scan-gateway/gateway.env && $REMOTE_UP"; then
    env_changed=0
  else
    printf 'CRITICAL: gateway env rollback failed; restore %s manually.\n' "$ENV_BACKUP" >&2
    return 1
  fi
}
rollback_on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$env_changed" == 1 ]]; then rollback_gateway_env || status=1; fi
  rm -f "$known_raw" "$known_pinned"
  exit "$status"
}
trap rollback_on_exit EXIT
trap 'exit 143' INT TERM

env_changed=1
"${SSH[@]}" "$GATEWAY_HOST" "set -eu; chmod 0700 /root/signal-scan-egress/set_gateway_env.py; python3 /root/signal-scan-egress/set_gateway_env.py /root/signal-scan-gateway/gateway.env '$FW_WS_ENDPOINTS'; $REMOTE_BUILD; $REMOTE_UP"

if ! "${SSH[@]}" "$GATEWAY_HOST" 'for i in $(seq 1 30); do curl --silent --show-error --fail --max-time 3 http://127.0.0.1:8130/health >/dev/null && exit 0; sleep 2; done; exit 1'; then
  rollback_gateway_env || exit 1
  exit 1
fi

"${SSH[@]}" "$GATEWAY_HOST" "docker exec signal_scan-gateway-1 node -e 'const x=(process.env.CRAWL_FRESH_WALLET_WS_ENDPOINTS||\"\").split(\",\"); if(x.length!==2||x[0]!==\"ws://gateway-chrome:3000\"||x[1]!==\"ws://${BRIDGE_IP}:31135\"||Object.hasOwn(process.env,\"AUTH_DISABLED\")||Object.hasOwn(process.env,\"VITE_AUTH_DISABLED\"))process.exit(1)'"
PROXY_SHA_AFTER=$("${SSH[@]}" "$GATEWAY_HOST" 'sha256sum /root/signal-scan-gateway/proxies.txt | cut -d " " -f 1')
if [[ "$PROXY_SHA_BEFORE" != "$PROXY_SHA_AFTER" ]]; then
  printf 'The existing gateway proxy route changed unexpectedly.\n' >&2
  rollback_gateway_env || exit 1
  exit 1
fi
if ! check_api_health; then
  rollback_gateway_env || exit 1
  exit 1
fi

env_changed=0
printf 'Fresh Wallet now has direct Browserless egresses on VPS 228 and VPS 250; official Nansen API and other free-question routes are unchanged. VPS 250 Browserless is loopback-only behind a source-restricted SSH tunnel. Existing proxy file and production auth checks passed; no Telegram alert or Nansen query was sent by deploy.\n'
