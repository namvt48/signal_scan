# 2026-09-28 — Chặn port công khai (instance a) + thêm viewer

Hai việc: (1) "hủy giao diện port cũ" → chặn `http://194.163.187.250:8124`, chỉ còn
`https://signal-scan.duckdns.org`; (2) thêm `vuthenam.9.3.4.5@gmail.com` làm viewer.

## 1. Thêm viewer

`vuthenam.9.3.4.5@gmail.com` là địa chỉ **KHÁC** `vuthenam.9.3.4@gmail.com` (đang là admin)
— thêm 1 dòng, không sửa dòng cũ.

`AUTH_USER_ROLES` sau khi sửa (7 entry: 2 admin / 5 viewer), áp trên cả
`/root/signal_scan/server/.env` và local `server/.env`:

```
lehoangtrong.vn@gmail.com:admin
vuthenam.9.3.4@gmail.com:admin
thegreatkhanh.217@gmail.com:viewer
roguewolfalone@gmail.com:viewer
harry@drava.tech:viewer
harry.quantitative@gmail.com:viewer
vuthenam.9.3.4.5@gmail.com:viewer
```

Env chỉ đọc lúc khởi động ⇒ `docker compose up -d --force-recreate api` (không phải
`restart`, vì `restart` giữ nguyên env cũ của container).

Xác minh trong container:

```
$ docker compose exec -T api printenv AUTH_USER_ROLES
  entries=6 admin=2 viewer=5          # wc -l hụt 1: giá trị không có newline cuối → thực tế 7
  viewer moi: vuthenam.9.3.4.5@gmail.com:viewer
  GET /api/health (no auth) -> 200
  GET /api/signals (no auth) -> 401   # auth vẫn kín
```

## 2. Chặn port cũ

Sự thật: Caddy (host) `reverse_proxy 127.0.0.1:8124`, nhưng compose publish
`0.0.0.0:8124` ⇒ `http://194.163.187.250:8124` vào được UI qua HTTP thường, bỏ qua HTTPS.

**Blast radius đã kiểm trước khi sửa** — điểm sống còn là daemon:

```
/opt/wallet-watch/watchers/common/config.py:64  _api_url = "http://127.0.0.1:8124"
ExecStart=... --api-url http://127.0.0.1:8124
```

Daemon và Caddy đều ở host, đều dùng `127.0.0.1` ⇒ bind loopback **không** cắt ingest
lẫn HTTPS. Chỉ `make test` (curl từ ngoài vào IP) chết theo — đúng mục đích.

`docker-compose.yml` dùng chung cho cả instance b (đang public 0.0.0.0:8125, không có
entry Caddy) ⇒ tách biến `BIND` thay vì hardcode:

- `docker-compose.yml`: `- "${BIND:-127.0.0.1}:${PORT:-8124}:80"`
- `Makefile`: `BIND ?= 127.0.0.1` + `DOMAIN ?= signal-scan.duckdns.org` (instance a);
  `BIND ?= 0.0.0.0` + `DOMAIN ?=` (instance b); `BASE` = `https://$(DOMAIN)` hoặc
  `http://$(SERVER):$(PORT)`; `make test` dùng `$(BASE)`;
  `FIREWALL_PORTS := $(if $(DOMAIN),80 443,$(PORT))`.

Interpolate đã kiểm (local, `docker compose config`): a → `host_ip: 127.0.0.1`,
b → `host_ip: 0.0.0.0`.

Backup trên server: `docker-compose.yml.bak.20260928T161758`, `Makefile.bak.20260928T161758`.
Recreate: `docker compose up -d web` (đổi port bind buộc recreate).

### Bằng chứng sau khi chặn

```
listen 8124:  127.0.0.1:8124        (không còn 0.0.0.0)      ✓
listen 8125:  0.0.0.0:8125          (instance B không đụng)   ✓

từ máy local:
  https://signal-scan.duckdns.org/            -> 200
  https://signal-scan.duckdns.org/api/health  -> 200
  http://194.163.187.250:8124/                -> 000 (chặn)
  http://194.163.187.250:8125/                -> 200 (B còn nguyên)

auth matrix qua HTTPS (không vỡ):
  /api/health (no auth) -> 200
  /api/signals, /api/me, /api/wallets (no auth) -> 401

login wall render sau recreate: "Sign in to continue" + "Sign in with Google"

ingest của daemon SAU khi chặn port (api log):
  2026-09-28T09:21:17.306Z POST /api/tracked-cas         status=409   (dedupe bình thường)
  2026-09-28T09:21:17.316Z POST /api/wallet-watch/trades status=200
  2026-09-28T09:21:17.323Z POST /api/wallet-watch/trades status=200
  wallet_trades 35150 -> 35152,  newest_trade_age=37s
  systemctl is-active wallet-watch -> active
```

## 3. Đính chính về COOP

Header `Cross-Origin-Opener-Policy: same-origin-allow-popups` (thêm trước đó ở
`nginx.conf`) **KHÔNG** xóa được cảnh báo console:

```
[ERROR] Cross-Origin-Opener-Policy policy would block the window.closed call.
```

Lý do: popup của Google tự set `COOP: same-origin`, nên `window.closed` bị chặn bất kể
header phía mình. Cảnh báo vô hại (luồng đăng nhập thật đi qua redirect/postMessage của
`/__/auth/handler`, không phải `window.closed`). Giữ header (giá trị Firebase khuyến
nghị, có lợi về bảo mật) nhưng **không** như tôi mô tả ban đầu (không làm hủy nhanh hơn).

Console khi tải trang mới: **0 error / 0 warning** (cảnh báo COOP chỉ xuất hiện khi mở
popup rồi hủy). Login wall không gọi `/api/*` ⇒ các `401` trong nginx log là **tab cũ
chạy bundle trước deploy**, không phải bug server.

EVIDENCE_RECORDED: evidence/2026-09-28-auth-port-harden-and-viewer.md
