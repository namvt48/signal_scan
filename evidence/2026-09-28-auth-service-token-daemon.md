# Service token cho daemon wallet-watch (chuẩn bị bật auth)

Ngày: 2026-09-28 · Instance: A (`root@194.163.187.250`, port 8124) · Trạng thái: **đã deploy, đã verify**

## Mục tiêu

Khi API bật auth (Firebase login + phân quyền), daemon `wallet-watch` — consumer
thứ hai của API, gọi `GET /api/wallets`, `GET /api/settings`, `POST /api/tracked-cas`,
`POST /api/wallet-watch/trades` — sẽ bị 401 và **toàn bộ ingest dừng**. Cấp cho nó
một service token tĩnh, gửi qua `Authorization: Bearer`.

Thứ tự deploy cố ý: **daemon trước, server sau**. Daemon gửi header cho server cũ
(chưa có middleware → bỏ qua, vô hại); nếu làm ngược lại thì có cửa sổ daemon bị 401.

## Phát hiện 1 — `http_json` dùng chung với Solana RPC

`watchers/common/config.py::http_json` là transport cho cả:
- HTTP tới API (`_api_url` = `http://127.0.0.1:8124`)
- **Solana RPC** — `rpc()` (config.py:196) gọi cùng hàm này cho mọi endpoint Helius/publicnode

⇒ Thêm `Authorization` vô điều kiện vào `http_json` sẽ **bơm service token ra mọi
provider Solana công cộng**. Vì vậy header được chặn theo tiền tố URL:

```python
def _auth_headers(url):
    if _service_token and url.startswith(_api_url):
        return {"Authorization": f"Bearer {_service_token}"}
    return {}
```

RPC endpoint luôn là `https://…`, không bao giờ khớp tiền tố `_api_url` ⇒ về mặt
cấu trúc không thể rò. `_auth_headers` đọc `_api_url` tại thời điểm gọi, nên
`config._api_url = args.api_url` (set trong `sol/main.py`) được tôn trọng động
(instance B dùng port 8125 vẫn khớp).

## Phát hiện 2 — `http_json` KHÔNG phải đường duy nhất (suýt bỏ sót)

Grep kiểm chứng lại tuyên bố "http_json là single point" thì phát hiện
`watchers/common/emit.py` có **2 chỗ tự dựng `urllib.request.Request`**, bỏ qua
`http_json`, với header cứng `{"Content-Type": "application/json"}`:

| Dòng | Hàm | Endpoint |
|---|---|---|
| emit.py:94-99 | `track_event` | `POST /api/tracked-cas` |
| emit.py:168-173 | `post_trade` | `POST /api/wallet-watch/trades` |

Đây **đúng 2 endpoint ghi** mà daemon dùng. Nếu để nguyên, sau khi bật auth: daemon
vẫn `GET` thành công (trông vẫn khoẻ, `source=api` vẫn log) nhưng **âm thầm ngừng
ghi CA + trade** — lỗi im lặng, tệ nhất trong các loại lỗi.

Sửa bằng **một** helper dùng chung (không lặp logic token ở 2 nơi):

```python
def api_headers():
    return {"Content-Type": "application/json", **_auth_headers(_api_url)}
```

và cả 2 chỗ trong emit.py đổi sang `headers=config.api_headers()`. Sweep cuối xác
nhận **chỉ `config.py` + `emit.py`** chạm mạng trong `watchers/`.

Token đọc từ env `SIGNAL_SCAN_SERVICE_TOKEN`, **không hardcode** vào repo. Rỗng ⇒
không gửi header ⇒ server trả 401: fail-closed có chủ ý.

## Shim deployment — vì sao sửa file là đủ

`/opt/wallet-watch/wallet_watch.py` không `import` bình thường: nó là **shim**
`exec(compile(_section_src(path), …), _FLAT)` từng file trong `_SECTIONS`
(`common/config.py` đứng đầu) vào **một namespace phẳng**. Comment dòng 12 nhắc
`patch ww.http_json` phải được mọi hàm thấy — nhưng đó là việc **test** làm; shim
production **không** thay thế `http_json`. ⇒ `_auth_headers`/`api_headers`/`_service_token`
nằm cùng `_FLAT` với `_api_url`; `http_json` resolve đúng, và `emit.py` gọi
`config.api_headers()` qua view `_Ns` trỏ về đúng binding đó.

## Thay đổi

| Nơi | Nội dung |
|---|---|
| `watchers/common/config.py` | `+_service_token` (đọc env), `+_auth_headers(url)`, `+api_headers()`, `+1` dòng trong `http_json` |
| `watchers/common/emit.py` | 2 chỗ `track_event` + `post_trade`: header cứng → `config.api_headers()` |
| `scripts/test_wallet_watch_config.py` | `+` section `(g)` (Bearer chỉ cho `_api_url`, RPC không dính, khớp `_api_url` động) và `(h)` (cả 2 đường POST của emit.py đều kèm Bearer — bắt bằng cách chặn `urlopen`) |
| `/opt/wallet-watch/watchers/common/{config,emit}.py` | scp 2 file (không rsync cả gói ⇒ blast radius tối thiểu) |
| `/root/signal_scan/server/.env` | `+SERVICE_TOKEN` (openssl rand -hex 32), `+FIREBASE_PROJECT_ID=trading-auth-67772`, `+AUTH_USER_ROLES` (5 admin kế thừa từ reference) |
| `/etc/systemd/system/wallet-watch.service.d/track.conf` | `+Environment=SIGNAL_SCAN_SERVICE_TOKEN=<token>` |

Backup: `.env.bak.20260928T103324`, `track.conf.bak.20260928T103324`,
`config.py.bak.20260928T103324`, `emit.py.bak.20260928T103648`.

Kiểm tra không drift trước khi ghi đè: `diff` deployed vs repo = **chỉ** phần thêm
mới ⇒ không có bản sửa chỉ-tồn-tại-production nào bị mất.

## Verify

```
# 1. deployed == repo (md5 khớp chính xác)
config.py e1ba7315212e42dc133e16ffa3d9dde0
emit.py   b4d4b2a0a0ad7668734277374e43db53

# 2. py_compile cả 2: OK

# 3. logic auth trong CHÍNH môi trường daemon (chỉ in boolean)
_auth_headers(API url)  -> Authorization: True
_auth_headers(RPC url)  -> Authorization: False   <- MUST be False
api_headers()           -> Content-Type: application/json, Bearer present: True

# 4. suite offline
python3 scripts/test_wallet_watch_config.py -> PASS (gồm OK (g) + OK (h))
python3 scripts/test_wallet_watch.py        -> PASS

# 5. restart — PID đổi nghĩa là process THẬT SỰ nạp code mới
2250618 -> 2617206 -> 2618458   active=active
SIGNAL_SCAN_SERVICE_TOKEN trong /proc/<pid>/environ: 1
# min_usd=$50 source=api      <- request CÓ kèm Authorization đã tới API OK
# wallets=201 source=api
! track / ! watch-trade: none
# feed=ws shard 3/6 key#2 logsSubscribe 34 ví (tổng 201)
# rpc/60s total=10 getTransaction=10
wallet_trades=35073 tracked_cas=462   (08:11Z: 35056 / 460 ⇒ đang tăng)
```

**Bài học — lần restart đầu tiên đã hụt:** lệnh chạy thứ hai bị cắt giữa `sleep`
nên `systemctl restart` **chưa hề chạy**; file trên đĩa đã mới nhưng process vẫn
giữ code cũ trong RAM (PID và `ActiveEnterTimestamp` không đổi, nên rất dễ tưởng
đã xong). Luôn xác nhận **PID đổi** sau khi deploy, đừng tin output bị cắt.

## Rollback

```bash
cp /root/signal_scan/server/.env.bak.20260928T103324 /root/signal_scan/server/.env
cp /etc/systemd/system/wallet-watch.service.d/track.conf.bak.20260928T103324 \
   /etc/systemd/system/wallet-watch.service.d/track.conf
cp /opt/wallet-watch/watchers/common/config.py.bak.20260928T103324 \
   /opt/wallet-watch/watchers/common/config.py
cp /opt/wallet-watch/watchers/common/emit.py.bak.20260928T103648 \
   /opt/wallet-watch/watchers/common/emit.py
systemctl daemon-reload && systemctl restart wallet-watch   # xác nhận PID ĐỔI
```

## Còn lại

`Makefile` deploy **không** ship `watchers/` (chỉ `server src`) ⇒ mọi thay đổi
watchers phải scp tay, đúng như trên.

`scripts/*.py` là dev-only (không deploy): `ruleA_real_regress.py:117` gọi thẳng
`{API}/api/wallets` bằng urllib — sẽ cần token nếu chạy lại sau khi bật auth.
Không nằm trên đường production.

Chưa làm: xác nhận server thực sự **từ chối** request thiếu token (cần middleware
auth — phần của agent BE) và E2E Google login trên `https://signal-scan.duckdns.org`.

EVIDENCE_RECORDED: evidence/2026-09-28-auth-service-token-daemon.md
