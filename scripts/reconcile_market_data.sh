#!/usr/bin/env bash
set -euo pipefail

cd /root/signal_scan

if [ -f /root/signal-scan-monitor/monitor.env ]; then
  gateway_compose() {
    docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml "$@"
  }
else
  gateway_compose() {
    docker compose -f docker-compose.gateway.yml "$@"
  }
fi

for container in signal_scan-api-1 signal_scan_b-api-1; do
  env=$(docker inspect --format '{{json .Config.Env}}' "$container")
  case "$env" in
    *'MARKET_DB_PATH=/market-data/market.db'*) ;;
    *) echo "$container is not attached to the shared market DB; refusing reconciliation"; exit 1 ;;
  esac
  case "$env" in
    *'SETUP_CACHE_FILE=/market-data/nansen-cache.json'*) ;;
    *) echo "$container is not attached to the shared setup cache; refusing reconciliation"; exit 1 ;;
  esac
done

curl -fsS http://127.0.0.1:8124/api/health >/dev/null
curl -fsS http://127.0.0.1:8125/api/health >/dev/null

gateway_compose stop gateway
trap 'gateway_compose up -d --no-deps gateway >/dev/null 2>&1' EXIT
gateway_compose run --rm --no-deps gateway node dist/market-data-reconcile.js --force
gateway_compose up -d --no-deps gateway
trap - EXIT

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:8130/health >/dev/null; then
    echo 'gateway health OK; legacy public market data reconciled and A/B setup caches merged'
    exit 0
  fi
  sleep 1
done

echo 'gateway health failed after market reconciliation'
gateway_compose logs --tail 80 gateway
exit 1
