# GMGN Key Runbook — bật MODE=gmgn (data thật)
**Ngày:** 2026-09-08 · **Trạng thái trước runbook:** server chạy MODE=mock (full pipeline + data synthetic), keypair Ed25519 đã sinh trên server tại `/root/signal_scan/keys/` (chmod 600, không rời server).

## 5 bước (khoảng 5 phút làm thủ công)

1. **Lấy public key:** `make gmgn-keygen` — in lại public key (idempotent, không sinh key mới nếu đã có).
2. **Tạo API key:** mở **https://gmgn.ai/ai** → paste TOÀN BỘ khối `-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----` → tạo key → nhận **GMGN_API_KEY**.
3. **Tạo .env trên server:** `make gmgn-env` — tự điền sẵn `MODE=gmgn` + `GMGN_PRIVATE_KEY` (đọc từ `keys/gmgn-private.hex`, đúng format PKCS8-DER hex mà `loadSigningKey` cần). Còn thiếu 2 giá trị sẽ được in ra.
4. **Điền tay 2 giá trị còn lại:** `ssh root@194.163.187.250 "nano /root/signal_scan/server/.env"`:
   - `GMGN_API_KEY` — key từ bước 2
   - `GMGN_BASE_URL` — base URL của Agent API, xem trong dashboard GMGN sau khi tạo key
5. **Kích hoạt:** `make restart` → `make gmgn-status` phải thấy `MODE=gmgn` + health OK.

## VERIFY ngay sau lần gọi thật đầu tiên (3 mục đánh dấu VERIFY trong `server/src/providers/gmgn.ts`)

| Cần xác nhận | Xem ở đâu | Nếu sai thì sửa |
|---|---|---|
| Signature header names + format chữ ký | `make api-log` — nếu GMGN trả 401/403 ngay request đầu | hàm `request()` trong `gmgn.ts` — chỉ 1 nơi |
| Base URL chính xác | dashboard GMGN | env `GMGN_BASE_URL` — không phải code |
| Timestamp (giây hay mili-giây) | field `ts` của activity sau sweep đầu | dòng `* 1000` trong `walletActivity` |

## Reality check 429 (đã xác nhận thực tế 2026-09-08)

Limit theo docs (20/4 rps) **lạc quan hơn thực tế** — sweep holders đầu tiên ở 4 rps đã dính `429 RATE_LIMIT_BANNED` (ban cấp IP, ~10-15'). Cơ chế phòng ngừa đã built-in:

- **Pacing**: `pacedFor()` dàn đều request của mỗi sweep trên `SWEEP_PACE_FACTOR` (mặc định 0.8) của chu kỳ — không bao giờ dồn batch. Thêm CA → gap tự co, không cần chỉnh gì.
- **Knob env** (sửa trong `server/.env` + `make restart`, không đụng code): `RATE_W1_RPS`, `RATE_W5_RPS`, `RATE_W1_CAPACITY`, `RATE_W5_CAPACITY`, `SWEEP_PACE_FACTOR`, `POLL_*_MS`.

**Thủ tục khi dính 429:**
```bash
ssh root@194.163.187.250 "cd /root/signal_scan && docker compose stop api"   # ngừng bắn ngay
# chờ 10-15', probe 1 call đơn:
ssh root@194.163.187.250 'curl -s -o /dev/null -w "%{http_code}\n" "https://openapi.gmgn.ai/v1/user/info?timestamp=$(date +%s)&client_id=$(cat /proc/sys/kernel/random/uuid)" -H "X-APIKEY: <KEY>"'
# 200 rồi thì:
ssh root@194.163.187.250 "cd /root/signal_scan && docker compose start api"
```
Nếu lặp lại: giảm `RATE_*_RPS` một nửa hoặc tăng `POLL_*_MS` trước khi start.



## Kiểm chứng data thật (10 CA test đã có sẵn)

`make api-log` chạy 1-2 phút đầu sẽ thấy `tokenSweep done` — rồi:
```bash
curl -s http://194.163.187.250:8124/api/signals | python3 -m json.tool | head -40
```
Số holders/volume/fresh% sẽ khác hẳn mock và thay đổi thật theo từng sweep. Kiểm thêm: `wallet_activity` historical depth (open item #1 của docs) bằng cách xem số rows trong `wallet_trades` sau sweep wallet đầu tiên.

## Rollback (30 giây)

```bash
ssh root@194.163.187.250 "rm /root/signal_scan/server/.env"
make restart   # quay về MODE=mock, data synthetic, pipeline không gián đoạn
```

## Lưu ý bảo mật

- `server/.env` và `keys/` **không bao giờ** được scp/rsync vào repo hay commit — Makefile deploy chỉ rsync `server/src` + configs, không chạm 2 file này.
- `GMGN_PRIVATE_KEY` là **request-signing key** (không phải wallet key) — lộ thì rotate ngay trong dashboard GMGN.
- GMGN **IPv4 only** — server phải đi ra IPv4 (đã check: server có IPv4 public).
