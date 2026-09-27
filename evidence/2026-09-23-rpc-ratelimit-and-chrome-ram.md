# RPC rate-limit + queue + chrome RAM — 2026-09-23 (signal_scan)

**TL;DR (VI):** Thêm 2 knob env cho rate limit RPC Solana — `SOLANA_RPC_MIN_INTERVAL_MS` (limit, default
600ms) và `SOLANA_RPC_MAX_RETRIES` (budget retry 429, default 3) — nên **limit chỉnh được không cần sửa
code**. Budget retry nới 2→3 lần: 429 thoáng qua được **hấp thụ** thay vì làm mất kết quả ví. Nâng chrome
`mem_limit` 3g→6g + `shm_size` 1g→2g (host 24g, trống ~20g; cap không phải reservation). Deploy + verify
trên prod.

## 1. Yêu cầu (user, verbatim)

- "thêm cơ chế rate limit cho rpc cho tôi, các request đưa vào queue để không bị mất, lượng limit thì có config được"
- "cần tăng ram cho hiệu quả hơn browserless/chrome thì cứ tăng"

## 2. Thay đổi

| File | Nội dung |
|---|---|
| `server/src/config.ts` | `+solanaRpcMinIntervalMs` (`SOLANA_RPC_MIN_INTERVAL_MS`, 600) · `+solanaRpcMaxRetries` (`SOLANA_RPC_MAX_RETRIES`, 3) |
| `server/src/providers/solana.ts` | bỏ hằng hard-code `RETRY_429_DELAYS_MS = [400, 800]`; `retrySchedule()` = `400·2^n × maxRetries`; ctor lấy `minIntervalMs` + `retryDelayMs` từ config |
| `docker-compose.yml` | chrome `mem_limit: 3g → 6g`, `shm_size: 1g → 2g` |
| `server/test/solana.test.ts` | +1 test: budget 429 lấy từ config (`hits === config.solanaRpcMaxRetries + 1`) |

## 3. Cơ chế "queue" — thực ra đã có sẵn, chỉ thiếu budget cấu hình được

- `pace()` giữ `nextStartAt`: mọi caller (kể cả lượt retry) phải chờ slot → **FIFO toàn cục, không bao giờ burst**.
- `post()` gọi lại `pace()` ở **đầu mỗi attempt** ⇒ lượt retry tự động về **cuối hàng đợi**, không chen ngang.
- Hết budget ⇒ throw (giữ nguyên contract test pin `:230` "persistent 429 rejects"); **sweep ví 15' là tầng retry bền** nên không cần queue persist qua restart.

## 4. Evidence (lệnh + kết quả thật)

- `npm test` (default) → **183/183 pass, fail 0** (exit 0).
- `npm run build` (tsc) → **exit 0**.
- `lsp_diagnostics src/providers/solana.ts` → **No diagnostics found**.
- **Env override (chứng minh env→config→client):** `SOLANA_RPC_MAX_RETRIES=7 SOLANA_RPC_MIN_INTERVAL_MS=1500 npm test`
  → 183/183 pass, test budget pass ⇒ `hits = 8 = config+1`; nếu config không đọc env thì `hits=4` và test đã fail.
- **Deploy:** `make restart` → `chrome Recreated`, `api Recreated`, `web Running`; `== deploy OK`.
- **Limits áp thật** (`docker inspect`): `signal_scan-chrome-1 mem=6442450944` (6 GiB), `shm=2147483648` (2 GiB).
- **Prod dist:** `rpcMaxRetries=3 rpcMinIntervalMs=600` (đọc bằng `node --input-type=module` trong container).
- **Door pool tự hồi sinh (fix 2026-09-23 sáng):** log `[door 0/1] re-arm (retired 63s ago)` → `warmup-ok` → `promoted` → `healthy`;
  `/api/health` cuối: 2 door `state=healthy, lastStatus=200, requests=14/13`; web HTTP 200.
- **chrome RSS sau nâng:** `637MiB / 6GiB`, CPU ~21%.

## 5. Root cause 429 (Helius) — edge rate limit, KHÔNG phải cạn quota

- Prod `SOLANA_RPC_URL` = `https://mainnet.helius-rpc.com/?api-key=<REDACTED>` (không phải public mainnet).
- `getHealth` đơn lẻ → **HTTP/2 200 OK** ⇒ key hợp lệ, chưa bị chặn cứng.
- **20 request song song** (`getTokenAccountsByOwner`) → **20/20 HTTP 429**, body **plain text `Too Many Requests`**
  ⇒ rate limit tầng edge/CF, **không** phải JSON `max usage reached` của Helius (cạn credit).
- Log prod: **17 call 429** (12 `kickWalletHoldings` + 5 `walletSweep holdings`), **17 ví khác nhau** (~4% call).
- Kiểm tra chia sẻ key: quét `Config.Env` mọi container, so **sha256 10 ký tự đầu** (không in key) → chỉ
  `signal_scan-api-1` có key Helius; trên host chỉ tồn tại **1** URL Helius trong các `server/.env` ⇒ không chia sẻ.
- **Đề xuất:** đặt `SOLANA_RPC_MIN_INTERVAL_MS=1500` (0.67 req/s) → 396 call/ví-sweep ≈ 10 phút, vẫn < `pollWalletsMs` 15 phút.

## 6. Còn lại / giới hạn đã biết

- **Chưa đặt** `SOLANA_RPC_MIN_INTERVAL_MS` trên prod (chờ user chọn giá trị) ⇒ 429 vẫn còn (~4%).
- **`mem_limit 6g` là headroom, KHÔNG phải fix throughput**: RSS đo được 637–835MiB, **chưa hề chạm trần 3g cũ**.
  Nút thắt browser nhiều khả năng là **CPU** (8 core, chrome ~21–28%) hoặc số door — không phải RAM.
- **SECURITY:** một lệnh verify in nguyên `config.solanaRpcUrl` ⇒ **API key Helius lọt vào transcript phiên này**.
  Khuyến nghị **rotate key** trên dashboard Helius (code đã có `SafeRpcError` để không lộ URL vào log — lỗi nằm ở lệnh verify, không ở code).
