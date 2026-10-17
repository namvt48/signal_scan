# =====================================================================
# signal_scan — Makefile deploy lên server (167.86.101.228) qua docker compose
#
# 2 container (docker-compose.yml):
#   web — nginx serves SPA + proxies /api/ to its instance-specific API alias
#   api — Node poller + SQLite + express (chỉ expose 3001 nội bộ, không publish)
#
# 2 instance song song: INSTANCE=a (mặc định, production) | INSTANCE=b (bản thứ 2).
#   Cột Clan chỉ hiện ở instance b (SHOW_CLAN=on) — a build với off nên ẩn hẳn.
#   FOMO chỉ bật ở instance b (SHOW_FOMO=on) — a/local không set nên code path vắng hẳn.
#   Tab title cũng theo instance: a=signal_scan, b=fomo (TITLE).
#
# Cú pháp:
#   make deploy              # instance a: copy source (web + server/, loại node_modules/dist) + build
#   make deploy INSTANCE=b   # instance b: dir /root/signal_scan_b, port 8125, DB ./data-b
#   make up   [INSTANCE=b]   # docker compose up -d + status
#   make down [INSTANCE=b]  # docker compose down
#   make restart [INSTANCE=b]# deploy + up
#   make gateway-deploy     # sync instance-a source, build + restart the shared gateway
#   make fomo-watch-deploy  # deploy/restart only the FOMO websocket watcher
#   make logs / api-log / status / test / firewall
#
# Ghi chú:
# - SQLite nằm ở $(REMOTE_DIR)/data (bind mount ./data:/data) — `make ssh-rm`
#   XÓA CẢ DB! Backup = copy thư mục data/ trên server.
# - rsync excludes phải ANCHOR: `--exclude 'data*'` (không neo) khớp MỌI basename
#   nên đã nuốt src/services/dataStore.ts — file đó KHÔNG BAO GIỜ được deploy, lộ
#   ra 2026-09-24 khi web build fail vì ImportRow.clan chưa lên server. Đã đổi
#   thành '/data*' + '/keys' và thêm -c (so CONTENT, không chỉ size+mtime).
# - MODE=gmgn cần tạo server/.env TRÊN SERVER (từ server/.env.example) — file
#   .env chứa secret nên KHÔNG được deploy copy tự động. Mặc định MODE=mock
#   chạy full pipeline không cần key.
# - Instance a: port 8124 KHÔNG publish ra internet (BIND=127.0.0.1) — chỉ Caddy
#   (host) và daemon (host, --api-url http://127.0.0.1:8124) vào được. Công khai
#   duy nhất qua https://signal-scan.duckdns.org. Instance b vẫn 0.0.0.0:8125.
# - UFW trên server hiện INACTIVE — docker publish port trực tiếp qua iptables.
#   Target `firewall` vẫn chạy `ufw allow` (idempotent, có tác dụng khi ufw được
#   bật sau này). Nếu từ ngoài vẫn không vào được → kiểm tra firewall panel
#   của nhà cung cấp VPS.
# - KHÔNG đụng /root/qd-crawler, /root/trading-monitor (project khác).
# =====================================================================

HOST      ?= root@167.86.101.228
GATEWAY_DIR := /root/signal_scan
SERVER    := 167.86.101.228
POLL_FLOWS_MS ?= 10800000
POLL_SETUP_MS ?= 10800000

# Instance selector: `make deploy INSTANCE=b` = second parallel deployment with its
# own dir/port/DB. Default `a` = primary deployment.
INSTANCE  ?= a
ifeq ($(INSTANCE),a)
REMOTE_DIR ?= /root/signal_scan
PORT      ?= 8124
DATA_DIR  ?= data
PROJECT   ?= signal_scan
SHOW_CLAN ?= off
TITLE     ?= signal_scan
# Web bind loopback: Caddy + daemon đều ở host nên vẫn vào bình thường; IP:8124
# từ ngoài bị chặn, chỉ còn https://$(DOMAIN).
BIND      ?= 127.0.0.1
DOMAIN    ?= signal-scan.duckdns.org
else
REMOTE_DIR ?= /root/signal_scan_$(INSTANCE)
PORT      ?= 8125
DATA_DIR  ?= data-$(INSTANCE)
PROJECT   ?= signal_scan_$(INSTANCE)
SHOW_CLAN ?= on
TITLE     ?= fomo
SHOW_FOMO ?= on
# Instance b không có entry Caddy → giữ publish công khai như cũ.
BIND      ?= 0.0.0.0
DOMAIN    ?=
endif

# URL mà `make test` dùng để kiểm tra TỪ MÁY LOCAL.
ifeq ($(DOMAIN),)
BASE ?= http://$(SERVER):$(PORT)
else
BASE ?= https://$(DOMAIN)
endif
LEGACY_CONTAINER := signal_scan

# Passed to every docker compose call so the two instances stay isolated.
COMPOSE_ENV := PORT=$(PORT) BIND=$(BIND) DATA_DIR=$(DATA_DIR) COMPOSE_PROJECT_NAME=$(PROJECT) INSTANCE=$(INSTANCE) SHOW_CLAN=$(SHOW_CLAN) TITLE=$(TITLE) SHOW_FOMO=$(SHOW_FOMO) POLL_FLOWS_MS=$(POLL_FLOWS_MS) POLL_SETUP_MS=$(POLL_SETUP_MS)

# Port cần mở ở ufw: instance a đi qua Caddy (80/443), instance b qua $(PORT).
FIREWALL_PORTS := $(if $(DOMAIN),80 443,$(PORT))

FILES     := Dockerfile nginx.conf docker-compose.yml docker-compose.gateway.yml docker-compose.monitor.yml monitor.caddy .dockerignore package.json package-lock.json tsconfig.json vite.config.ts index.html
SSH       := ssh -o BatchMode=yes -o ConnectTimeout=10 $(HOST)
SCP       := scp -o BatchMode=yes -o ConnectTimeout=10
RSYNC_SSH := ssh -o BatchMode=yes -o ConnectTimeout=10

FOMO_RELEASE_FILES := \
	server/src/alert-feed.ts \
	server/src/api.ts \
	server/src/auth.ts \
	server/src/config.ts \
	server/src/db.ts \
	server/src/fomo-api.ts \
	server/src/poller.ts \
	server/src/setup-cache.ts \
	server/src/signals.ts \
	server/src/telegram-alert-settings.ts \
	server/src/monitor/alert-policy.ts \
	server/src/monitor/alerts.ts \
	server/src/monitor/collector.ts \
	server/src/monitor/store.ts \
	server/src/monitor/telegram.ts \
	server/src/monitor/types.ts \
	server/public/monitor.html

# Keep Telegram presentation deploy isolated from alert-state and API changes.
.PHONY: deploy up down restart logs api-log status test firewall ssh-rm gmgn-keygen gmgn-env gmgn-status gateway-up gateway-deploy gateway-down gateway-log monitor-deploy monitor-restart monitor-alerts-deploy monitor-telegram-format-deploy monitor-periodic-report-deploy routing-smoke fomo-watch-deploy fomo-evm-watch-deploy fomo-rpc-apply fomo-api-deploy fomo-release-deploy watchers-up fresh-retry-deploy market-data-reconcile cohort-labels-api-up

routing-smoke:
	$(SSH) 'bash -s' < scripts/test_instance_routing.sh


deploy:
	$(SSH) "mkdir -p $(REMOTE_DIR)"
	$(SCP) -r $(FILES) $(HOST):$(REMOTE_DIR)/
	rsync -azc --delete --exclude node_modules --exclude dist --exclude .env --exclude '/data*' --exclude '/keys' -e "$(RSYNC_SSH)" server src $(HOST):$(REMOTE_DIR)/
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose build && echo '== deploy OK — instance=$(INSTANCE) port=$(PORT) dir=$(REMOTE_DIR)'"

# Deploy only the Fresh retry gate fix to instance A; never sync/rebuild web or B.
fresh-retry-deploy:
	@test "$(INSTANCE)" = a || { echo 'fresh-retry-deploy is restricted to INSTANCE=a'; exit 1; }
	$(SCP) server/src/poller.ts server/src/setup-cache.ts $(HOST):$(REMOTE_DIR)/server/src/
	$(SSH) "cd $(REMOTE_DIR) && if [ -f /root/signal-scan-monitor/monitor.env ]; then $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env build api && $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env up -d --no-deps --force-recreate api; else $(COMPOSE_ENV) docker compose build api && $(COMPOSE_ENV) docker compose up -d --no-deps --force-recreate api; fi"
	sleep 3
	$(SSH) "curl -fsS http://127.0.0.1:8124/api/health >/dev/null && echo 'instance A API health OK'"

# Deploy only the FOMO API and alert/telemetry backend files listed above.
fomo-api-deploy:
	@test "$(INSTANCE)" = a -o "$(INSTANCE)" = b || { echo 'fomo-api-deploy supports INSTANCE=a|b'; exit 1; }
	rsync -azcR -e "$(RSYNC_SSH)" $(FOMO_RELEASE_FILES) $(HOST):$(REMOTE_DIR)/
	$(SSH) "cd $(REMOTE_DIR) && if [ -f /root/signal-scan-monitor/monitor.env ]; then $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env config --quiet && $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env build api && $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env up -d --no-deps --force-recreate api; else $(COMPOSE_ENV) docker compose config --quiet && $(COMPOSE_ENV) docker compose build api && $(COMPOSE_ENV) docker compose up -d --no-deps --force-recreate api; fi"
	sleep 3
	$(SSH) "curl -fsS http://127.0.0.1:$(PORT)/api/health >/dev/null && echo 'instance $(INSTANCE) API health OK'"

# Apply the monitor's B/Solana suppression before restarting either API.
fomo-release-deploy:
	@$(MAKE) monitor-alerts-deploy
	@$(MAKE) fomo-api-deploy INSTANCE=a
	@$(MAKE) fomo-api-deploy INSTANCE=b


fomo-evm-watch-deploy:
	$(SSH) "set -eu; test -x /opt/wallet-watch/venv/bin/python; test -f /opt/fomo-watch/fomo.env; curl -fsS http://127.0.0.1:8125/api/health >/dev/null; install -d -m 0750 /opt/fomo-wallet-watch/watchers/common /opt/fomo-wallet-watch/watchers/evm /opt/fomo-wallet-watch/data /root/signal-scan-monitor/heartbeats"
	rsync -azc --delete --exclude '__pycache__' -e "$(RSYNC_SSH)" watchers/common/ $(HOST):/opt/fomo-wallet-watch/watchers/common/
	rsync -azc --delete --exclude '__pycache__' -e "$(RSYNC_SSH)" watchers/evm/ $(HOST):/opt/fomo-wallet-watch/watchers/evm/
	$(SCP) watchers/__init__.py $(HOST):/opt/fomo-wallet-watch/watchers/__init__.py
	$(SCP) deploy/fomo-evm-wallet-watch.service $(HOST):/etc/systemd/system/fomo-evm-wallet-watch.service
	$(SSH) "systemctl daemon-reload && systemctl reset-failed fomo-evm-wallet-watch.service && systemctl enable fomo-evm-wallet-watch.service && systemctl restart fomo-evm-wallet-watch.service && systemctl --no-pager --full status fomo-evm-wallet-watch.service"

fomo-watch-deploy:
	$(SSH) "set -eu; test -x /opt/fomo-watch/venv/bin/python; test -f /opt/fomo-watch/fomo.env; test -f /etc/systemd/system/fomo-watch.service; curl -fsS http://127.0.0.1:8125/api/health >/dev/null; install -d -o root -g root -m 0700 /opt/fomo-watch/logs"
	$(SCP) watchers/fomo/feed.py $(HOST):/opt/fomo-watch/watchers/fomo/feed.py
	$(SSH) "set -eu; /opt/fomo-watch/venv/bin/python -m py_compile /opt/fomo-watch/watchers/fomo/feed.py; systemctl restart fomo-watch.service; systemctl is-active --quiet fomo-watch.service; systemctl --no-pager --full status fomo-watch.service"

fomo-rpc-apply:
	$(SSH) "cd $(REMOTE_DIR) && if [ -f /root/signal-scan-monitor/monitor.env ]; then $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env up -d --force-recreate api; else $(COMPOSE_ENV) docker compose up -d --force-recreate api; fi"
	sleep 3
	$(SSH) "curl -fsS http://127.0.0.1:8125/api/health >/dev/null"
	@$(MAKE) fomo-evm-watch-deploy INSTANCE=b

# Start the three provisioned host watchers only after both APIs are ready.
watchers-up:
	$(SSH) "set -eu; curl -fsS http://127.0.0.1:8124/api/health >/dev/null; curl -fsS http://127.0.0.1:8125/api/health >/dev/null; test -f /etc/cron.d/wallet-watch-watchdog; systemctl daemon-reload; systemctl enable --now wallet-watch.service fomo-watch.service fomo-evm-wallet-watch.service; systemctl is-active wallet-watch.service fomo-watch.service fomo-evm-wallet-watch.service"

# Bring up the staged cohort-label source privately; source/data are migrated once from 250.
cohort-labels-api-up:
	$(SSH) "set -eu; test -f /opt/ct-wallet-alpha-engine/data/wallet_portfolio_pnl.sqlite3; docker network inspect signal-scan-cohort-labels >/dev/null 2>&1 || docker network create signal-scan-cohort-labels; touch /opt/ct-wallet-alpha-engine/.env; chmod 600 /opt/ct-wallet-alpha-engine/.env"
	$(SCP) deploy/ct-wallet-alpha-engine.override.yml $(HOST):/opt/ct-wallet-alpha-engine/docker-compose.override.yml
	$(SCP) deploy/ct-wallet-alpha-engine.dockerignore $(HOST):/opt/ct-wallet-alpha-engine/.dockerignore
	$(SSH) "set -eu; cd /opt/ct-wallet-alpha-engine; docker compose config --quiet; docker compose build ct-wallet; docker compose up -d; timeout 60s sh -c 'until curl -fsS http://127.0.0.1:8081/api/health >/dev/null 2>&1; do sleep 1; done'; curl -fsS --max-time 30 http://127.0.0.1:8081/api/pnl/cohort-labels | jq -e '.schema == \"canonical_cohort_label_index_v1\" and .total_wallets > 0' >/dev/null; echo 'cohort API ready'"

# The gateway net is external: Compose will NOT create it, so every `up` (a, b, local)
# must ensure it exists first or `docker compose up` refuses to start.
up:
	$(SSH) "docker network create signal-scan-gateway || true"
	$(SSH) "docker network inspect signal-scan-cohort-labels >/dev/null 2>&1 || docker network create signal-scan-cohort-labels"
	$(SSH) "cd $(REMOTE_DIR) && if [ -f /root/signal-scan-monitor/monitor.env ]; then $(COMPOSE_ENV) docker compose --env-file /root/signal-scan-monitor/monitor.env up -d; else $(COMPOSE_ENV) docker compose up -d; fi"
	sleep 2
	@$(MAKE) status

down:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose down && echo '== $(INSTANCE): container đã dừng + xóa'"

restart:
	@$(MAKE) deploy
	@$(MAKE) up

# ---------- request-plane gateway (its own compose project) ----------
# docker-compose.gateway.yml ships via $(FILES); the external net is created here too.
gateway-deploy:
	@$(MAKE) deploy INSTANCE=a
	$(SSH) "docker network create signal-scan-gateway || true"
	$(SSH) "docker volume create signal-scan-market-data >/dev/null"
	$(SSH) "cd $(GATEWAY_DIR) && if [ -f /root/signal-scan-monitor/monitor.env ]; then docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml build gateway && docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml up -d gateway; else docker compose -f docker-compose.gateway.yml build gateway && docker compose -f docker-compose.gateway.yml up -d gateway; fi"

# Quiesce the legacy tables, force-import only public rows, then restart the gateway
# so it merges the final A/B setup caches before resuming its single market poller.
market-data-reconcile:
	$(SSH) 'bash -s' < scripts/reconcile_market_data.sh

gateway-up:
	$(SSH) "docker network create signal-scan-gateway || true"
	$(SSH) "docker volume create signal-scan-market-data >/dev/null"
	$(SSH) "cd $(REMOTE_DIR) && if [ -f /root/signal-scan-monitor/monitor.env ]; then docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml up -d; else docker compose -f docker-compose.gateway.yml up -d; fi"

gateway-down:
	$(SSH) "cd $(REMOTE_DIR) && docker compose -f docker-compose.gateway.yml down"

gateway-log:
	$(SSH) "cd $(REMOTE_DIR) && docker compose -f docker-compose.gateway.yml logs -f gateway"

# ---------- public host monitor ----------

monitor-deploy:
	$(SSH) 'set -eu; dir=/root/signal-scan-monitor; envfile=$$dir/monitor.env; install -d -m 700 "$$dir"; if [ ! -f "$$envfile" ]; then umask 077; token=$$(openssl rand -hex 32); printf "MONITOR_API_TOKEN=%s\\nDISCORD_BOT_TOKEN=\\nDISCORD_CHANNEL_ID=\\nTELEGRAM_BOT_TOKEN=\\nTELEGRAM_CHAT_ID=\\nTELEGRAM_ALERT_THREAD_ID=\\nTELEGRAM_PERIODIC_CHAT_ID=\\n" "$$token" > "$$envfile"; fi; chmod 600 "$$envfile"; grep -q "^MONITOR_API_TOKEN=." "$$envfile"; install -d -m 0750 "$$dir/data" "$$dir/usage" "$$dir/heartbeats"; test -f /opt/fomo-watch/fomo_heartbeat; test -f /opt/wallet-watch/heartbeat; test -f /opt/fomo-watch/watchers/fomo/feed.py; test -f /opt/wallet-watch/watchers/common/state.py'
	$(SCP) watchers/fomo/feed.py $(HOST):/opt/fomo-watch/watchers/fomo/feed.py
	$(SCP) watchers/common/state.py $(HOST):/opt/wallet-watch/watchers/common/state.py
	$(SSH) "systemctl restart fomo-watch.service wallet-watch.service"
	@$(MAKE) deploy INSTANCE=a
	@$(MAKE) deploy INSTANCE=b
	$(SSH) "docker network create signal-scan-gateway || true"
	$(SSH) "docker volume create signal-scan-market-data >/dev/null"
	$(SSH) "cd /root/signal_scan && docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml config --quiet && docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml build gateway && docker compose --env-file /root/signal-scan-monitor/monitor.env -f docker-compose.gateway.yml up -d"
	@$(MAKE) up INSTANCE=a
	@$(MAKE) up INSTANCE=b
	@$(MAKE) routing-smoke
	$(SCP) monitor.caddy $(HOST):/root/signal-scan-monitor/monitor.caddy
	$(SSH) "set -eu; backup_dir=\$$(mktemp -d /root/signal-scan-monitor/caddy-backup.XXXXXX); cp -a /etc/caddy/Caddyfile \"\$$backup_dir/Caddyfile\"; if [ -f /etc/caddy/monitor.caddy ]; then cp -a /etc/caddy/monitor.caddy \"\$$backup_dir/monitor.caddy\"; else touch \"\$$backup_dir/no-monitor-snippet\"; fi; install -m 0644 /root/signal-scan-monitor/monitor.caddy /etc/caddy/monitor.caddy; if ! grep -Fqx 'import /etc/caddy/monitor.caddy' /etc/caddy/Caddyfile; then printf '\\nimport /etc/caddy/monitor.caddy\\n' >> /etc/caddy/Caddyfile; fi; if ! caddy validate --config /etc/caddy/Caddyfile; then cp -a \"\$$backup_dir/Caddyfile\" /etc/caddy/Caddyfile; if [ -f \"\$$backup_dir/monitor.caddy\" ]; then cp -a \"\$$backup_dir/monitor.caddy\" /etc/caddy/monitor.caddy; else rm -f /etc/caddy/monitor.caddy; fi; exit 1; fi; ufw allow 8443/tcp; systemctl reload caddy"
	$(SSH) "set -eu; health_status=\$$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8126/healthz); dashboard_status=\$$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8126/); api_status=\$$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8126/api/snapshot); history_status=\$$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8126/api/history?hours=24'); printf 'internal health=%s dashboard=%s snapshot=%s history=%s\\n' \"\$$health_status\" \"\$$dashboard_status\" \"\$$api_status\" \"\$$history_status\"; test \"\$$health_status\" = 200; test \"\$$dashboard_status\" = 200; test \"\$$api_status\" = 200; test \"\$$history_status\" = 200"
	public_health=$$(curl -sS -o /dev/null -w '%{http_code}' https://signal-scan.duckdns.org:8443/healthz); dashboard=$$(curl -sS -o /dev/null -w '%{http_code}' https://signal-scan.duckdns.org:8443/); api=$$(curl -sS -o /dev/null -w '%{http_code}' https://signal-scan.duckdns.org:8443/api/snapshot); history=$$(curl -sS -o /dev/null -w '%{http_code}' 'https://signal-scan.duckdns.org:8443/api/history?hours=24'); printf 'public HTTPS health=%s dashboard=%s snapshot=%s history=%s\n' "$$public_health" "$$dashboard" "$$api" "$$history"; test "$$public_health" = 200; test "$$dashboard" = 200; test "$$api" = 200; test "$$history" = 200

monitor-restart:
	$(SSH) "cd /root/signal_scan && docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml up -d --force-recreate monitor"

monitor-alerts-deploy:
	$(SCP) server/src/monitor/store.ts $(HOST):/root/signal_scan/server/src/monitor/store.ts
	$(SCP) server/src/monitor/telegram.ts $(HOST):/root/signal_scan/server/src/monitor/telegram.ts
	$(SCP) server/src/token-avatar.ts $(HOST):/root/signal_scan/server/src/token-avatar.ts
	$(SCP) server/src/monitor/main.ts $(HOST):/root/signal_scan/server/src/monitor/main.ts
	$(SCP) server/src/monitor/alerts.ts $(HOST):/root/signal_scan/server/src/monitor/alerts.ts
	$(SCP) server/src/telegram-alert-settings.ts $(HOST):/root/signal_scan/server/src/telegram-alert-settings.ts
	$(SCP) server/src/alert-feed.ts $(HOST):/root/signal_scan/server/src/alert-feed.ts
	$(SCP) server/src/monitor/alert-policy.ts $(HOST):/root/signal_scan/server/src/monitor/alert-policy.ts
	$(SCP) server/src/monitor/collector.ts $(HOST):/root/signal_scan/server/src/monitor/collector.ts
	$(SCP) server/src/monitor/types.ts $(HOST):/root/signal_scan/server/src/monitor/types.ts
	$(SCP) server/public/monitor.html $(HOST):/root/signal_scan/server/public/monitor.html
	$(SSH) 'cd /root/signal_scan && docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml config --quiet && docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml build monitor && docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml up -d --force-recreate monitor && for attempt in $$(seq 1 30); do curl -fsS http://127.0.0.1:8126/healthz >/dev/null 2>&1 && { echo monitor-health-ok; exit 0; }; sleep 1; done; echo monitor-health-failed; docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml ps; exit 1'

# Deploy only the Telegram alert formatter; preserve monitor state and APIs.
monitor-telegram-format-deploy:
	$(SCP) server/src/monitor/telegram.ts $(HOST):/root/signal_scan/server/src/monitor/telegram.ts
	$(SSH) 'set -eu; cd /root/signal_scan; docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml config --quiet; docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml build monitor; docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml up -d --force-recreate monitor; for attempt in $$(seq 1 30); do curl -fsS http://127.0.0.1:8126/healthz >/dev/null 2>&1 && { echo monitor-health-ok; exit 0; }; sleep 1; done; echo monitor-health-failed; docker compose --env-file /root/signal-scan-monitor/monitor.env -p signal_scan_monitor -f docker-compose.monitor.yml ps; exit 1'
# Deploy separate periodic-channel routing; never fall back to the live-alert destination.
monitor-periodic-report-deploy:
	rsync -azcR -e "$(RSYNC_SSH)" server/src/monitor/telegram.ts server/src/monitor/periodic-scan.ts server/src/monitor/config.ts server/src/monitor/main.ts docker-compose.monitor.yml $(HOST):/root/signal_scan/
	$(SSH) 'set -eu; cd /root/signal_scan; envfile=/root/signal-scan-monitor/monitor.env; test -f "$$envfile"; docker compose --env-file "$$envfile" -p signal_scan_monitor -f docker-compose.monitor.yml config --format json | python3 -c "import json,sys; e=json.load(sys.stdin)[\"services\"][\"monitor\"][\"environment\"]; missing=[key for key in (\"TELEGRAM_BOT_TOKEN\",\"TELEGRAM_CHAT_ID\") if not e.get(key)]; periodic=(e.get(\"TELEGRAM_PERIODIC_CHAT_ID\") or \"\").strip(); alert=(e.get(\"TELEGRAM_CHAT_ID\") or \"\").strip(); assert not missing, \"Missing Telegram alert config: \" + \", \".join(missing); assert not periodic or periodic != alert, \"TELEGRAM_PERIODIC_CHAT_ID must differ from TELEGRAM_CHAT_ID\"; print(\"periodic Telegram reports disabled until a separate channel is configured\" if not periodic else \"periodic Telegram channel configured\")"; docker compose --env-file "$$envfile" -p signal_scan_monitor -f docker-compose.monitor.yml config --quiet; docker compose --env-file "$$envfile" -p signal_scan_monitor -f docker-compose.monitor.yml build monitor; docker compose --env-file "$$envfile" -p signal_scan_monitor -f docker-compose.monitor.yml up -d --force-recreate monitor; for attempt in $$(seq 1 30); do curl -fsS http://127.0.0.1:8126/healthz >/dev/null 2>&1 && { echo monitor-health-ok; exit 0; }; sleep 1; done; echo monitor-health-failed; docker compose --env-file "$$envfile" -p signal_scan_monitor -f docker-compose.monitor.yml ps; exit 1'

logs:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose logs -f web"

api-log:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose logs -f api"

status:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose ps --format 'table {{.Name}}  {{.Status}}  {{.Ports}}'; \
		curl -s -m 5 -o /dev/null -w 'HTTP %{http_code} — web localhost:$(PORT)\n' localhost:$(PORT)/ || echo 'web chưa phản hồi'; \
		curl -s -m 5 localhost:$(PORT)/api/health && echo ' — /api/health OK (qua nginx)' || echo 'api chưa phản hồi qua nginx'"

# health check TỪ MÁY LOCAL — đúng kịch bản 'xem từ ngoài qua internet'.
# Instance a: qua https://$(DOMAIN) (port 8124 đã bị chặn khỏi internet).
test:
	@curl -s -m 8 -o /dev/null -w '== HTTP %{http_code} — $(BASE)/\n' $(BASE)/ \
		|| echo '== KHÔNG vào được từ ngoài — nếu là instance a thì kiểm tra Caddy (systemctl status caddy); nếu là b thì kiểm tra firewall panel của VPS provider'
	@curl -s -m 8 $(BASE)/api/health && echo ' — /api/health OK' || echo '== /api/health KHÔNG truy cập được từ ngoài'

firewall:
	$(SSH) "for p in $(FIREWALL_PORTS); do ufw allow \$$p/tcp >/dev/null 2>&1; done; ufw status verbose | head -5"
	@sleep 1
	@$(MAKE) test

ssh-rm:
	$(SSH) "cd $(REMOTE_DIR) 2>/dev/null && $(COMPOSE_ENV) docker compose down --remove-orphans; \
		docker rm -f $(LEGACY_CONTAINER) 2>/dev/null; \
		rm -rf $(REMOTE_DIR) && echo 'đã xóa $(REMOTE_DIR) trên server (+ DB trong data/ — cẩn thận!)'"

# ---------- GMGN key setup (MODE=gmgn) ----------
# Quy trình 3 bước: make gmgn-keygen → paste public key tại gmgn.ai/ai lấy API key
# → make gmgn-env (điền GMGN_API_KEY + GMGN_BASE_URL) → make restart
# Private key sinh NGAY TRÊN SERVER (keys/, chmod 600) — không bao giờ rời server.

GMGN_KEY_DIR := $(REMOTE_DIR)/keys

gmgn-keygen:
	$(SSH) "mkdir -p $(GMGN_KEY_DIR) && cd $(GMGN_KEY_DIR) && \
		if [ ! -f gmgn-private.pem ]; then \
			openssl genpkey -algorithm ed25519 -out gmgn-private.pem 2>/dev/null && \
			openssl pkey -in gmgn-private.pem -pubout -out gmgn-public.pem 2>/dev/null && \
			openssl pkey -in gmgn-private.pem -outform DER 2>/dev/null | od -An -tx1 | tr -d ' \n' > gmgn-private.hex && \
			chmod 600 gmgn-private.pem gmgn-private.hex && echo '== keypair mới đã sinh:'; \
		else echo '== keypair ĐÃ TỒN TẠI (không sinh lại — dùng key cũ):'; fi && \
		echo && echo '===== PUBLIC KEY (copy TOÀN BỘ khối bên dưới, paste vào gmgn.ai/ai) =====' && \
		cat gmgn-public.pem && \
		echo '===== hết public key ====='"

gmgn-env:
	$(SSH) "cd $(REMOTE_DIR) && sh server/scripts/gmgn-env.sh"

gmgn-status:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose exec -T api printenv MODE 2>/dev/null | sed 's/^/MODE=/'; \
		test -f server/.env && echo '.env tồn tại' || echo '.env CHƯA có — đang chạy MODE=mock'; \
		curl -s -m 5 localhost:$(PORT)/api/health && echo"
