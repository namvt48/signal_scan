#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/root/signal_scan
PROJECT=signal_scan_public_api
COMPOSE_FILE=docker-compose.public-api.yml
NETWORK=signal-scan-gateway
ACTIVE_FILE="$ROOT/deploy/bluegreen/public-api-active"
CADDYFILE=/etc/caddy/Caddyfile
LOCK=/run/lock/signal-scan-public-api-deploy.lock
DOMAIN=signal-scan.duckdns.org

cd "$ROOT"
mkdir -p "$(dirname "$ACTIVE_FILE")" "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -n 9 || { echo 'another public API deployment is running' >&2; exit 1; }

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

if [[ -f "$ACTIVE_FILE" ]]; then
  active=$(<"$ACTIVE_FILE")
else
  active=blue
fi
case "$active" in
  blue)
    previous_service=public-api; previous_main_export=public-api-export-main; previous_fomo_export=public-api-export-fomo; previous_port=3010
    candidate=public-api-green; candidate_main_export=public-api-export-main-green; candidate_fomo_export=public-api-export-fomo-green; candidate_port=3011
    ;;
  green)
    previous_service=public-api-green; previous_main_export=public-api-export-main-green; previous_fomo_export=public-api-export-fomo-green; previous_port=3011
    candidate=public-api; candidate_main_export=public-api-export-main; candidate_fomo_export=public-api-export-fomo; candidate_port=3010
    ;;
  *) echo "invalid active slot: $active" >&2; exit 1 ;;
esac
configured_port=$(awk '
  /# BEGIN signal-scan public API blue-green/ { managed=1; next }
  /# END signal-scan public API blue-green/ { managed=0; next }
  managed && /reverse_proxy 127\.0\.0\.1:[0-9]+/ {
    line=$0
    sub(/^.*reverse_proxy 127\.0\.0\.1:/, "", line)
    sub(/[^0-9].*$/, "", line)
    port=line
    matches++
  }
  END { if (matches != 1) exit 1; print port }
' "$CADDYFILE") || { echo 'cannot resolve active Public API route from Caddyfile' >&2; exit 1; }
[[ "$configured_port" == "$previous_port" ]] || {
  echo "active marker ($active) disagrees with Caddy route (port $configured_port); refusing rollout" >&2
  exit 1
}

previous_id=$(dc ps -q "$previous_service")
[[ -n "$previous_id" ]] || { echo "active service $previous_service is missing" >&2; exit 1; }
[[ "$(docker inspect -f '{{.State.Running}}' "$previous_id")" == true ]] || { echo "active service $previous_service is not running" >&2; exit 1; }

docker network inspect "$NETWORK" >/dev/null
: "${PUBLIC_API_A_DATA_DIR:=$ROOT/data}"
: "${PUBLIC_API_FOMO_DATA_DIR:=$PUBLIC_API_A_DATA_DIR}"
export PUBLIC_API_A_DATA_DIR PUBLIC_API_FOMO_DATA_DIR
[[ -r "$PUBLIC_API_A_DATA_DIR/signal_scan.db" ]] || { echo 'instance A database file is not readable' >&2; exit 1; }
[[ -r "$PUBLIC_API_FOMO_DATA_DIR/signal_scan.db" ]] || { echo 'configured FOMO source database file is not readable' >&2; exit 1; }
docker volume inspect signal-scan-market-data >/dev/null
[[ -s server/public-api.env ]] || { echo 'server/public-api.env is required' >&2; exit 1; }

release_id=$(date -u +%Y%m%dT%H%M%SZ)
export INSTANCE=a RELEASE_ID="$release_id"
dc config --quiet

echo "building candidate=$candidate release=$release_id"
cutover=0
candidate_alias=0
candidate_id=''
write_active_slot() {
  local slot=$1
  printf '%s\n' "$slot" >"$ACTIVE_FILE.tmp"
  mv "$ACTIVE_FILE.tmp" "$ACTIVE_FILE"
}
rollback() {
  local status=$1
  trap - ERR INT TERM HUP
  set +e
  if (( cutover )); then
    echo "rollback: routing back to $previous_service" >&2
    if switch_caddy_route "$previous_port"; then
      write_active_slot "$active"
    else
      echo "CRITICAL: Caddy rollback failed; leaving candidate $candidate running to preserve traffic" >&2
      exit "$status"
    fi
  fi
  if (( candidate_alias )) && [[ -n "$candidate_id" ]]; then
    docker network disconnect "$NETWORK" "$candidate_id" >/dev/null 2>&1
  fi
  dc stop --timeout 15 "$candidate" "$candidate_main_export" "$candidate_fomo_export" >/dev/null 2>&1
  exit "$status"
}
trap 'rollback "$?"' ERR
trap 'rollback 130' INT
trap 'rollback 129' HUP
trap 'rollback 143' TERM

dc build "$candidate" "$candidate_main_export" "$candidate_fomo_export"
dc up -d --no-deps --force-recreate "$candidate" "$candidate_main_export" "$candidate_fomo_export"
candidate_id=$(dc ps -q "$candidate")
[[ -n "$candidate_id" ]]

ready=0
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  if body=$(curl --silent --show-error --fail --max-time 20 "http://127.0.0.1:${candidate_port}/readyz" 2>/dev/null) \
    && python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status") == "ready" and d.get("release") == sys.argv[1]' "$release_id" <<<"$body"; then
    ready=1
    break
  fi
  sleep 2
done
(( ready == 1 )) || { echo "candidate readiness failed: $candidate" >&2; false; }

docker network disconnect "$NETWORK" "$candidate_id"
docker network connect --alias signal-scan-public-api "$NETWORK" "$candidate_id"
candidate_alias=1

switch_caddy_route() {
  local port=$1 tmp backup
  tmp=$(mktemp "${CADDYFILE}.bluegreen.XXXXXX")
  backup=$(mktemp "${CADDYFILE}.backup.XXXXXX")
  cp -p "$CADDYFILE" "$backup"
  if ! awk -v port="$port" '
    /# BEGIN signal-scan public API blue-green/ { skipping=1; begins++; next }
    /# END signal-scan public API blue-green/ { skipping=0; ends++; next }
    !skipping && /^signal-scan\.duckdns\.org[[:space:]]*\{[[:space:]]*$/ {
      sites++
      print
      print "    # BEGIN signal-scan public API blue-green"
      print "    handle /api/v1/* {"
      print "        reverse_proxy 127.0.0.1:" port
      print "    }"
      print "    # END signal-scan public API blue-green"
      next
    }
    !skipping { print }
    END { if (sites != 1 || skipping || begins != ends) exit 42 }
  ' "$CADDYFILE" >"$tmp"; then
    rm -f "$tmp" "$backup"
    echo 'could not locate exactly one signal-scan site in Caddyfile' >&2
    return 1
  fi
  chmod --reference="$CADDYFILE" "$tmp"
  if ! caddy validate --config "$tmp" --adapter caddyfile; then
    rm -f "$tmp" "$backup"
    return 1
  fi
  mv "$tmp" "$CADDYFILE"
  if ! caddy reload --config "$CADDYFILE" --adapter caddyfile; then
    cp -p "$backup" "$CADDYFILE"
    caddy reload --config "$CADDYFILE" --adapter caddyfile || true
    rm -f "$backup"
    return 1
  fi
  rm -f "$backup"
}

cutover=1
switch_caddy_route "$candidate_port"
candidate_slot=$([[ "$candidate" == public-api-green ]] && echo green || echo blue)
write_active_slot "$candidate_slot"

curl --silent --show-error --fail --max-time 20 "https://$DOMAIN/api/v1/status" >/dev/null

docker exec "$candidate_id" node -e '
const WebSocket = require("ws");
const ws = new WebSocket("wss://signal-scan.duckdns.org/api/v1/ws");
const timer = setTimeout(() => { console.error("websocket readiness timed out"); ws.terminate(); process.exit(1); }, 20000);
ws.on("message", raw => {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (message.type === "ready") { clearTimeout(timer); console.log("websocket ready"); ws.close(); process.exit(0); }
  if (message.type === "cursor_gap" || message.type === "invalid_cursor") { clearTimeout(timer); console.error(message.type); process.exit(1); }
});
ws.on("error", error => { clearTimeout(timer); console.error(error.message); process.exit(1); });
'

cutover=0
trap - ERR INT TERM HUP

if ! dc stop --timeout 15 "$previous_service" "$previous_main_export" "$previous_fomo_export"; then
  echo "warning: previous slot $active remains running; active route is $candidate" >&2
fi
echo "public API rollout complete: active=$candidate release=$release_id"
