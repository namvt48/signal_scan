# =====================================================================
# signal_scan — Makefile deploy lên server (194.163.187.250) qua docker compose
#
# 2 container (docker-compose.yml):
#   web — nginx serve SPA + proxy /api/ -> api:3001 (publish port $(PORT))
#   api — Node poller + SQLite + express (chỉ expose 3001 nội bộ, không publish)
#
# 2 instance song song: INSTANCE=a (mặc định, production) | INSTANCE=b (bản thứ 2).
#   Cột Clan chỉ hiện ở instance b (SHOW_CLAN=on) — a build với off nên ẩn hẳn.
#   Tab title cũng theo instance: a=signal_scan, b=fomo (TITLE).
#
# Cú pháp:
#   make deploy              # instance a: copy source (web + server/, loại node_modules/dist) + build
#   make deploy INSTANCE=b   # instance b: dir /root/signal_scan_b, port 8125, DB ./data-b
#   make up   [INSTANCE=b]   # docker compose up -d + status
#   make down [INSTANCE=b]   # docker compose down
#   make restart [INSTANCE=b]# deploy + up
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
# - Port 8124: chưa bị chiếm trên server (8123=qd-monitor, 8080=market-replay,
#   8098=trading-monitor-frontend, 8000=risk-system, 5174=trading-dashboard).
# - UFW trên server hiện INACTIVE — docker publish port trực tiếp qua iptables.
#   Target `firewall` vẫn chạy `ufw allow` (idempotent, có tác dụng khi ufw được
#   bật sau này). Nếu từ ngoài vẫn không vào được → kiểm tra firewall panel
#   của nhà cung cấp VPS.
# - KHÔNG đụng /root/qd-crawler, /root/trading-monitor (project khác).
# =====================================================================

HOST      ?= root@194.163.187.250
SERVER    := 194.163.187.250
# Instance selector: `make deploy INSTANCE=b` = second parallel deployment with its
# own dir/port/DB. Default `a` = the existing production deployment (unchanged).
INSTANCE  ?= a
ifeq ($(INSTANCE),a)
REMOTE_DIR ?= /root/signal_scan
PORT      ?= 8124
DATA_DIR  ?= data
PROJECT   ?= signal_scan
SHOW_CLAN ?= off
TITLE     ?= signal_scan
else
REMOTE_DIR ?= /root/signal_scan_$(INSTANCE)
PORT      ?= 8125
DATA_DIR  ?= data-$(INSTANCE)
PROJECT   ?= signal_scan_$(INSTANCE)
SHOW_CLAN ?= on
TITLE     ?= fomo
endif
LEGACY_CONTAINER := signal_scan

# Passed to every docker compose call so the two instances stay isolated.
COMPOSE_ENV := PORT=$(PORT) DATA_DIR=$(DATA_DIR) COMPOSE_PROJECT_NAME=$(PROJECT) SHOW_CLAN=$(SHOW_CLAN) TITLE=$(TITLE)

FILES     := Dockerfile nginx.conf docker-compose.yml .dockerignore package.json package-lock.json tsconfig.json vite.config.ts index.html
SSH       := ssh -o BatchMode=yes -o ConnectTimeout=10 $(HOST)
SCP       := scp -o BatchMode=yes -o ConnectTimeout=10
RSYNC_SSH := ssh -o BatchMode=yes -o ConnectTimeout=10

.PHONY: deploy up down restart logs api-log status test firewall ssh-rm gmgn-keygen gmgn-env gmgn-status

deploy:
	$(SSH) "mkdir -p $(REMOTE_DIR)"
	$(SCP) -r $(FILES) $(HOST):$(REMOTE_DIR)/
	rsync -azc --delete --exclude node_modules --exclude dist --exclude .env --exclude '/data*' --exclude '/keys' -e "$(RSYNC_SSH)" server src $(HOST):$(REMOTE_DIR)/
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose build && echo '== deploy OK — instance=$(INSTANCE) port=$(PORT) dir=$(REMOTE_DIR)'"

up:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose up -d"
	sleep 2
	@$(MAKE) status

down:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose down && echo '== $(INSTANCE): container đã dừng + xóa'"

restart:
	@$(MAKE) deploy
	@$(MAKE) up

logs:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose logs -f web"

api-log:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose logs -f api"

status:
	$(SSH) "cd $(REMOTE_DIR) && $(COMPOSE_ENV) docker compose ps --format 'table {{.Name}}  {{.Status}}  {{.Ports}}'; \
		curl -s -m 5 -o /dev/null -w 'HTTP %{http_code} — web localhost:$(PORT)\n' localhost:$(PORT)/ || echo 'web chưa phản hồi'; \
		curl -s -m 5 localhost:$(PORT)/api/health && echo ' — /api/health OK (qua nginx)' || echo 'api chưa phản hồi qua nginx'"

# health check TỪ MÁY LOCAL — đúng kịch bản 'xem từ ngoài qua internet'
test:
	@curl -s -m 8 -o /dev/null -w '== HTTP %{http_code} — http://$(SERVER):$(PORT)\n' http://$(SERVER):$(PORT)/ \
		|| echo '== KHÔNG vào được từ ngoài — chạy: make firewall; nếu vẫn lỗi thì kiểm tra firewall panel của VPS provider'
	@curl -s -m 8 http://$(SERVER):$(PORT)/api/health && echo ' — /api/health OK' || echo '== /api/health KHÔNG truy cập được từ ngoài'

firewall:
	$(SSH) "ufw allow $(PORT)/tcp >/dev/null 2>&1; ufw status verbose | head -5"
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
