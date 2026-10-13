#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'routing smoke failed: %s\n' "$1" >&2
  exit 1
}

container_ip() {
  docker inspect --format '{{(index .NetworkSettings.Networks "signal-scan-gateway").IPAddress}}' "$1"
}

resolved_ip() {
  docker exec "$1" getent hosts "$2" | awk 'NR == 1 { print $1 }'
}

check_instance() {
  local name="$1" web="$2" api="$3" api_alias="$4" chrome="$5" chrome_alias="$6"
  local configured_api api_ip api_dns chrome_ip chrome_dns nginx_config crawl_endpoint

  configured_api="$(docker exec "$web" printenv NGINX_API_UPSTREAM 2>/dev/null || true)"
  [[ "$configured_api" == "$api_alias" ]] || fail "$name web upstream is '$configured_api', expected '$api_alias'"

  api_ip="$(container_ip "$api")"
  api_dns="$(resolved_ip "$web" "$api_alias")"
  [[ "$api_dns" == "$api_ip" ]] || fail "$name alias $api_alias resolves to $api_dns, expected $api_ip"

  nginx_config="$(docker exec "$web" cat /etc/nginx/conf.d/default.conf)"
  [[ "$nginx_config" == *"set \$api_upstream http://$api_alias:3001;"* ]] || fail "$name nginx config does not target $api_alias"
  docker exec "$web" wget -q -O /dev/null http://127.0.0.1/api/health || fail "$name web proxy health request failed"

  crawl_endpoint="$(docker exec "$api" printenv CRAWL_WS_ENDPOINT)"
  [[ "$crawl_endpoint" == "ws://$chrome_alias:3000" ]] || fail "$name API browser endpoint is '$crawl_endpoint', expected ws://$chrome_alias:3000"

  chrome_ip="$(container_ip "$chrome")"
  chrome_dns="$(resolved_ip "$api" "$chrome_alias")"
  [[ "$chrome_dns" == "$chrome_ip" ]] || fail "$name alias $chrome_alias resolves to $chrome_dns, expected $chrome_ip"
  printf '%s routing: web -> %s; API -> %s; ok\n' "$name" "$api_alias" "$chrome_alias"
}

check_instance a signal_scan-web-1 signal_scan-api-1 signal-scan-api-a signal_scan-chrome-1 signal-scan-chrome-a
check_instance b signal_scan_b-web-1 signal_scan_b-api-1 signal-scan-api-b signal_scan_b-chrome-1 signal-scan-chrome-b
