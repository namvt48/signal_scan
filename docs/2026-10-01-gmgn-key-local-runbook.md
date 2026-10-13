# GMGN key — runbook chạy từ máy LOCAL

**Ngày:** 2026-10-01 · **Server:** `root@167.86.101.228` · **Instance mặc định:** `a` (`/root/signal_scan`, port 8124)

Mục tiêu: từ máy local (kể cả máy mới) tạo/rotate **GMGN API key** và nạp vào đúng chỗ, **không cần thao tác thủ công trên server** ngoài SSH.

> Nguyên tắc: **public key sinh trên server, private key không rời server** (`keys/`, chmod 600). Máy local chỉ đọc *public* key và điền *API key* — không copy private key về máy.

---

## 0. Chuẩn bị máy local

```bash
ssh-keygen -t ed25519 -C "may-local"        # nếu chưa có ~/.ssh/id_ed25519
ssh-copy-id root@167.86.101.228            # lần đầu cần password root
ssh root@167.86.101.228 "echo ok"          # verify SSH

git clone git@github.com:namvt48/signal_scan.git
cd signal_scan                              # để dùng `make`
```
Cần: `make`, `openssl`, `ssh`, `curl`. (Key SSH ở B0 là key để vào server — **không** phải key GMGN.)

---

## ĐƯỜNG A — dùng keypair GMGN đã có sẵn trên server (khuyến nghị)

Server đã có keypair tại `/root/signal_scan/keys/` từ 2026-09-08 → không cần sinh mới.

**A1. Lấy PUBLIC key (đang có sẵn, chỉ in lại):**
```bash
make gmgn-keygen
# hoặc lấy trực tiếp, không cần clone repo:
ssh root@167.86.101.228 "cat /root/signal_scan/keys/gmgn-public.pem"
```
Copy **nguyên khối** `-----BEGIN PUBLIC KEY----- … -----END PUBLIC KEY-----`.
(`gmgn-keygen` idempotent — key cũ tồn tại thì in lại, không ghi đè.)

**A2. Tạo key trên GMGN:**
1. Mở **https://gmgn.ai/ai** (đăng nhập account GMGN của bạn).
2. Dán nguyên khối PEM ở A1 vào ô public key → tạo key.
3. GMGN trả về **`GMGN_API_KEY`** → copy lại.
> Nếu account đã tạo key với đúng pubkey này rồi thì bỏ qua A2/A3.

**A3. Nạp `GMGN_API_KEY` vào gateway** (gateway là nơi giữ key, tự chèn header `X-APIKEY`):
```bash
# đặt biến trong shell local, tránh lọt vào lịch sử lệnh nếu muốn
GMGN_KEY='dán_key_vào_đây'
ssh root@167.86.101.228 "sed -i 's|^GMGN_API_KEY=.*|GMGN_API_KEY=$GMGN_KEY|' /root/signal-scan-gateway/gateway.env"
```
Kiểm tra dòng đã có (che value):
```bash
ssh root@167.86.101.228 "sed -E 's/=.*/=<...>/' /root/signal-scan-gateway/gateway.env | grep GMGN"
```

**A4. Restart gateway + verify:**
```bash
make gateway-up                                              # ssh + up -d
# hoặc ép recreate để chắc chắn đọc env mới:
ssh root@167.86.101.228 "cd /root/signal_scan && docker compose -f docker-compose.gateway.yml up -d --force-recreate gateway"

ssh root@167.86.101.228 "docker ps --format '{{.Names}} {{.Status}}' | grep gateway; \
  docker logs signal_scan-gateway-1 2>&1 | tail -5"
```

---

## ĐƯỜNG B — rotate / sinh keypair MỚI

Chỉ làm khi key cũ lộ, hoặc bạn muốn key khác.

```bash
# B1. xoá keypair cũ trên server (private + public + hex)
ssh root@167.86.101.228 "rm -f /root/signal_scan/keys/gmgn-public.pem /root/signal_scan/keys/gmgn-private.pem /root/signal_scan/keys/gmgn-private.hex"
# B2. sinh keypair mới ngay trên server + in public key
make gmgn-keygen
```
Rồi lặp lại **A2 → A4**.

> Keypair luôn sinh trên server. Không sinh ở local rồi scp private key lên — trái nguyên tắc "private key không rời server".

---

## Verify cuối (từ local, gọi thẳng GMGN để check API key sống)

```bash
GMGN_KEY='key_cua_ban'
CA='<dan_mot_CA_sol_bat_ky>'   # vd lấy 1 address từ bảng tracked_cas
curl -s -o /dev/null -w "GMGN HTTP %{http_code}\n" \
  "https://openapi.gmgn.ai/v1/token/info?chain=sol&address=$CA&timestamp=$(date +%s)&client_id=$(cat /proc/sys/kernel/random/uuid)" \
  -H "X-APIKEY: $GMGN_KEY"
```
- `401` → sai/thiếu API key (đây là mã DUY NHẤT chứng minh key hỏng).
- `200` / `404` → key được chấp nhận (khác 401 là OK).
- `403` → IP không nằm allowlist của GMGN hoặc đang trong cooldown ban (thử lại sau 10–15').

Kiểm qua app: instance **a** port 8124 là **loopback, KHÔNG vào được từ internet** — dùng `make status` / `make api-log` (thấy `tokenSweep done`), hoặc `make test` để check từ ngoài qua domain trong Makefile.

---

## Troubleshooting

| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| Gateway không boot, log `missing required env: gmgnApiKey` | `gateway.env` thiếu/rỗng `GMGN_API_KEY` | điền lại A3 → A4 |
| `ssh-keygen -e -m PKCS8 -f id_ed25519.pub` → `unsupported key type ED25519` | key SSH OpenSSH không convert PEM được | không dùng key git cho GMGN; dùng `keys/gmgn-public.pem` |
| GMGN 403 liên tục | IP server không được allowlist / bị ban | kiểm allowlist trên gmgn.ai, chờ cooldown 10–15' |
| `make gmgn-keygen` không ra key | sai `INSTANCE`/`REMOTE_DIR` | mặc định instance `a` → `/root/signal_scan`; chỉnh `make gmgn-keygen INSTANCE=b` nếu cần |

## GMGN 429 / shared-IP ban

GMGN applies the temporary ban to the gateway egress IP, not just the API key.
The gateway therefore limits all GMGN token-info keys together to **1 request/s,
burst 1, concurrency 1**. A 429 blocks the shared queue until the upstream reset
time (plus a small safety margin); missing, malformed, or stale reset data falls
back to a 60-second cooldown. `Retry-After` delta/date values are normalized too.
Concurrent provider requests for the same chain + CA share only the in-flight
request; completed responses are not cached.

When GMGN reports `RATE_LIMIT_BANNED`:

1. Stop both API containers and the `wallet-watch` service so they cannot keep
   feeding requests into the gateway.
2. Keep the gateway running; wait until the GMGN reset/cooldown has elapsed.
3. Send one token-info probe through the gateway. Do not probe directly from
   the server repeatedly.
4. If the probe succeeds, start both API containers and `wallet-watch`. If it
   returns another 429, stop them again and honor the new reset time.

Do not work around a shared-IP ban by switching API keys; every key exits from
the same gateway egress.

---

## Bảo mật

- `gmgn-public.pem` — công khai, paste lên GMGN thoải mái.
- `gmgn-private.pem` / `gmgn-private.hex` — **ở lại server**, không commit, không scp, không copy về local.
- `GMGN_API_KEY` và `gateway.env` — secret, **không** in ra log/chat; nạp qua `sed`/`nano` trên server.
- Không tái sử dụng key SSH GitHub/git cho GMGN — 1 service 1 key.

---

## Tham chiếu
- Runbook cũ (đường `server/.env`, đã lạc hậu so với gateway): `docs/2026-09-08-gmgn-key-runbook.md`
- Gateway giữ key: `docker-compose.gateway.yml`, `server/src/gateway/gmgn.ts`
- Makefile: target `gmgn-keygen`, `gmgn-env`, `gmgn-status`, `gateway-up`
