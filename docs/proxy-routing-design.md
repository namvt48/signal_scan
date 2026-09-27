# Thiết kế Door Pool + Proxy Routing cho crawler Nansen

**Ngày**: 2026-09-22 · **Trạng thái**: Approved (plan `.omo/plans/nansen-proxy-routing.md`, D1-D12) · **Phạm vi**: crawler Nansen (free app-questions door), không đụng FE/nansen credit API.

Tài liệu này mô tả thiết kế thay **1 page browser đơn** bằng **door pool N proxy** cho crawler Nansen. Mọi số liệu đều dẫn nguồn (đường dẫn `evidence/...` hoặc `plan §Dx`), không có số nào lấy từ trí nhớ.

---

## 1. Bối cảnh + sự cố prod

Kiến trúc hiện tại: `server/src/index.ts:24` wiring `NansenMarketProvider((url, body) => browserPostJson(url, body))`. `crawl.ts` giữ **một browser + một page persistent** (`crawl.ts:31-33`), warmup bằng `goto` + `sleep(4000)` cứng (`crawl.ts:70-71`), rồi `p.evaluate` gọi `fetch` same-origin từ page đó để qua Cloudflare.

Bug code (không phải giả thuyết):

- `server/src/crawl.ts:145`: `if (out.status !== 403 || attempt === 2) return out;` ⇒ **429 đi thẳng ra ngoài**, không đọc `retry-after`, không cách ly.
- `createCircuitBreaker` (`crawl.ts:109-124`) chỉ đếm lỗi **thrown** (`crawl.ts:149-150`); 403/429 trả về như response KHÔNG tính ⇒ breaker không mở khi bị limit.
- Warmup `sleep(4000)` cứng race với CF challenge (probe `.probe/challenge-probe.mjs` cho thấy cần tới ~20s).

Sự cố prod (đo trên `194.163.187.250`):

| Hiện tượng | Số liệu | Nguồn |
|---|---|---|
| Vòng chết 403 | `Setting up page` lặp mỗi ~4.5s: fetch trước khi `cf_clearance` kịp có → 403 interstitial → `invalidatePage()` → page mới → 403 | `evidence/2026-09-21-ip-vs-fingerprint.md` (§"Phát hiện phụ") |
| Chrome phình RAM | `signal_scan-chrome-1` ăn **2.306GiB / 3GiB** | `evidence/2026-09-21-ip-vs-fingerprint.md` (§"Phát hiện phụ") |
| Tổng 429 cả vòng đời container | **5 844** = wp4t `5 311` + gini `442` + volume `91` | `evidence/2026-09-21-vol-1h-column.md` §8 (bảng 429); plan §T4 ghi "5844×429" |
| Breaker đang mở lúc đo | `[nansen] ... crawl transport unhealthy (fast-fail)`, **0 × 429** trong 500 dòng log cuối | `evidence/2026-09-21-ip-vs-fingerprint.md` (§"Phát hiện phụ") |

Nguyên nhân gốc: **demand >> budget trên một page chia sẻ** (~43 req/min đo được, xem §2). Cụ thể wp4t có 1 059 cặp (wallet × CA) và prod `.env` `POLL_WALLETS_MS=900000` (15 phút) ⇒ **~70 req/min chỉ riêng wp4t = 1.6× toàn bộ budget 1 page** (`evidence/2026-09-21-vol-1h-column.md` §8). Đây là nguyên nhân có trước, không phải do cột 1H Volume.

---

## 2. Bằng chứng đo được

Mỗi dòng = một phát hiện + nguồn. Các con số 45 req và 471 req chỉ có nguồn ở plan §T4 (probe gốc là họ `.probe/p43-probe*.mjs`, được nhắc tại `evidence/2026-09-21-ip-vs-fingerprint.md` cuối file).

| # | Phát hiện | Số liệu | Nguồn |
|---|---|---|---|
| 1 | **IP là khoá của CF limiter** (không phải JA3/fingerprint) | Cùng Chrome 121, cùng UA: IP A `429` `retry-after: 2204` (975B, 71ms) / IP C `200` (gini 458B, 682ms; volume 561B, 259ms) | `evidence/2026-09-21-ip-vs-fingerprint.md` (bảng IP A vs IP C, "Kết luận" #1) |
| 2 | **Trip khi dồn cùng path** | ~**45 request cùng một path @ 8/s** → bị trip | plan §T4 (probe họ `.probe/p43-probe*.mjs`, nhắc ở cuối `evidence/2026-09-21-ip-vs-fingerprint.md`) |
| 3 | **Trộn path tránh trip** | **471 req / 60s trộn path KHÔNG trip** | plan §T4 (cùng probe). Ghi chú đối chiếu: `evidence/2026-09-21-ip-vs-fingerprint.md` "Kết luận" #3 nói luật có vẻ theo path ở session trước, nhưng sau khi đã bị trip thì phạt lan cả 2 path |
| 4 | **`retry-after` dài** | `2204-2797s` (~37-47 phút) | `evidence/2026-09-21-ip-vs-fingerprint.md` (bảng: 2204; "Kết luận" #4: ~2797) |
| 5 | **Shared pool trôi reputation** | Lần đầu **1/6 × 200**; chạy lại vài phút sau **6/6 × 403** (kể cả IP vừa 200) | `evidence/2026-09-21-ip-vs-fingerprint.md` (§"Test pool proxy datacenter") |
| 6 | **IP riêng (dedicated static) ổn định** | VPS không proxy **4/4 × 200** (ms 164-758, body 457-458B) | `evidence/2026-09-21-ip-vs-fingerprint.md` (đối chứng cuối §"Test pool") |
| 7 | **Egress ổn định trong session** (không xoay upstream phá cookie binding) | **5/5** lần sample cùng 1 session ra cùng IP | `evidence/2026-09-21-ip-vs-fingerprint.md` (§"Test pool", dòng "Egress ổn định?") |
| 8 | **Trần 1 page** | **~43 req/min** | `server/src/config.ts:56` (measured 2026-09-16); `evidence/2026-09-21-vol-1h-column.md` §8 |
| 9 | **429 = CF Error 1015** | body **~975B**, `zone: app.nansen.ai` | `evidence/2026-09-21-ip-vs-fingerprint.md` "Kết luận" #4; `.omo/notepads/nansen-proxy-routing/issues.md` |
| 10 | **403 interstitial = HTML challenge** | **~6472B**, `<title>Just a moment...</title>` (khác hẳn 403 real = JSON) | `evidence/2026-09-21-ip-vs-fingerprint.md` (dòng IP C đo lần đầu); `issues.md` gotcha |
| 11 | **`cf_clearance` là điều kiện cần, không đủ** | Cả 6 proxy đều lấy được `cf_clearance` (2.5-5s) nhưng cuối cùng **6/6 × 403** | `evidence/2026-09-21-ip-vs-fingerprint.md` (§"Test pool") |

**Hệ quả thiết kế**: IP là tài nguyên bị chấm điểm độc lập ⇒ phải tách egress IP theo door, và requery sang door khác an toàn (phạt 429 lan theo IP, KHÔNG cross-IP: `issues.md`).

---

## 3. Kiến trúc door pool

```
poller.ts / providers/nansen.ts
  provider.metric / walletActivity / ...
        │  ask(url, body)
        ▼
NansenMarketProvider.postJson   (PostJson interface, nansen.ts:377)
        │  (url, body) => Promise<{status, json}>
        ▼
index.ts:24  ── injection point (KHÔNG đổi chữ ký) ──►
        browserPostJson(url, body)          crawl.ts:128
        = lazy singleton delegate tới DoorPool
        │
        ▼
DoorPool.postJson(url, body)               (D7 router)
   - path key = đoạn cuối URL
   - budget per-(door,path) + per-door cap
   - chọn least-outstanding trong eligible
        │
   ┌────┴─────┬───────────┬───────────┐
   ▼          ▼           ▼           ▼
DoorConn 0  DoorConn 1  DoorConn 2  DoorConn N-1
(state riêng, cookie jar riêng, cf_clearance riêng, budget riêng)
   │          │           │           │
   └────┬─────┴───────────┴───────────┘
        ▼   WS/CDP: MỖI door = 1 connection riêng
  browserless/chrome (container `chrome`, mem_limit 3g, shm_size 1g)
        ▼   --proxy-server=<proxy> (query string WS) + page.authenticate(cred)
  proxy 0 .. proxy N-1   (mỗi door một egress IP riêng)
        ▼
  app.nansen.ai  (CF challenge ở page, path API ở in-page fetch)
```

**Vì sao pool nằm sau injection point `(url, body)`?** Chữ ký `browserPostJson(url, body): Promise<{status, json}>` là hợp đồng bất biến (`decisions.md` invariant; plan hard constraint #2). `poller.ts`, `providers/nansen.ts`, `api.ts`, `snapshot.ts`, FE và cả `index.ts` không phải sửa một dòng. Pool là lớp trong suốt: `browserPostJson` chỉ trở thành delegate lazy tới `DoorPool`, còn provider vẫn gọi y hệt.

Định nghĩa door (D1):

- Door = **1 WS connection** tới browserless (`CRAWL_WS_ENDPOINT`, default `ws://chrome:3000`, `config.ts:96`) + `--proxy-server=<proxy>` truyền qua query string + `page.authenticate({username, password})` khi proxy có credential.
- browserless v1 spawn **1 browser / connection** ⇒ N doors nằm trong **cùng 1 container** `chrome` với N connection (không thêm service chrome). Đã chứng minh: `.probe/multi-proxy-probe.mjs`, `.probe/challenge-probe.mjs`.

---

## 4. State machine (D3)

Mỗi door có state riêng. Bảng state × điều kiện vào × hành động × điều kiện ra:

| State | Điều kiện vào | Hành động | Điều kiện ra |
|---|---|---|---|
| `cold` | Khởi tạo lúc `pool.start()` | Chưa làm gì, chờ connect | Bắt đầu connect WS → `warming` |
| `warming` | Boot, hoặc hết `penalized` (re-warm) | Connect WS → new page → `goto https://app.nansen.ai/token-god-mode` → poll mỗi 2.5s (title hết "Just a moment" + cookie `cf_clearance` tồn tại), timeout `CRAWL_WARMUP_TIMEOUT_MS=30000`. Fetch egress IP (`https://api.ipify.org`) 1 lần, chỉ log informational | Warmup OK → `probation`. Connect/auth/warmup fail → `retired` (reason `broken-proxy`) |
| `probation` | Sau warmup, hoặc hết `throttled` | Phục vụ request bình thường | 200 đầu tiên → `healthy`. Gặp **403 real** ngay trong probation → `penalized` (bắt reputation drift sớm) |
| `healthy` | Sau 200 đầu ở probation | Phục vụ request | 429 → `throttled`. 403 real → xử lý `real403` (xem §5) → `penalized` nếu lặp. 5xx/transport → đếm, không đổi state trừ khi retired |
| `throttled` | Nhận 429 | Quarantine tới `now + retryAfter*1000 + jitter(0..CRAWL_QUARANTINE_JITTER_MS=30000)`. Thiếu header → default **1800s** | Hết quarantine → `probation` |
| `penalized` | 403 real (sau khi đã re-warm 1 lần mà vẫn lặp) | Backoff luỹ tiến **2m → 10m → 30m** | Hết backoff → `warming` (page mới). Hết nấc thang → `retired` |
| `retired` | Connect/warmup fail, hoặc transport-fail ≥2 liên tiếp, hoặc penalty cạn thang | Loại vĩnh viễn tới restart; log reason | Không ra (trừ restart) |

Ghi chú: `probation` và `healthy` đều **eligible** cho router (D7). Trần timeout warmup = `CRAWL_WARMUP_TIMEOUT_MS=30000`; request timeout = `CRAWL_REQUEST_TIMEOUT_MS=45000` (T1 config surface, plan §T1).

---

## 5. Error matrix (D4/D5)

Classifier là **pure function** trên `DoorHttpResponse { status, contentType, retryAfter, head, len, json, threw }` (hợp đồng `decisions.md`). Quy tắc: `threw: true` → `transport` **bất kể status**.

| Loại | Nhận biết | Hành động door | Hành động request |
|---|---|---|---|
| `ok` | `200` + json | health OK, reset transport-fail | Trả luôn, không requery |
| `throttle` | `429` (body CF Error 1015 ~975B) | → `throttled`: quarantine `retry-after` + jitter ≤30s; thiếu header → 1800s | **Requery 1 lần** sang door khác (phạt 429 per-IP, không cross-IP) |
| `interstitial` | `403` + content-type html / `bodyHead` bắt đầu `<` (~6472B, title "Just a moment") | invalidate page + re-warm | Requery 1 lần |
| `real403` | `403` + json (không phải HTML challenge) | invalidate + re-warm 1 lần; **lặp lại → `penalized`** | Requery 1 lần |
| `5xx` | `status >= 500` | Đếm transport-fail (KHÔNG quarantine) | Requery 1 lần |
| `transport` | `threw` / timeout (`CRAWL_REQUEST_TIMEOUT_MS=45000`) / json parse fail | transport-fail++; **≥2 liên tiếp → `retired`** | Requery 1 lần |

**Requery ≤ 1 lần / request (tổng ≤ 2 `fetch`)**. Requery fail → trả `{status: <status gốc | 502>, json: null}`; provider throw như hiện tại, poller log rồi đi tiếp sang CA khác. **Không bao giờ trả data ảo** (D5). `postJson` KHÔNG bao giờ throw; degrade trả `{status: 503, json: null}`.

Lưu ý bug-fix bắt buộc (T3): bỏ nhánh passthrough `status !== 403` (`crawl.ts:145`), đọc `retry-after` khi 429, breaker không còn rebuild loop.

---

## 6. Budget + router (D6/D7)

**Sliding window per-(door, path)** (D6):

- Prune timestamp ngoài `CRAWL_BUDGET_WINDOW_MS=60000` (60s).
- Door eligible cho path khi `count < CRAWL_PATH_BUDGET=30` trong cửa sổ 60s.
- Cap tổng per-door `< CRAWL_DOOR_CAP_PER_MIN=40` (sát trần page đo được 43/min, §2 #8).
- Path key = **đoạn cuối URL sau dấu `/` cuối cùng**. 6 path API (`providers/nansen.ts:42-50`):

  `tgm-essential-data`, `tgm-volume-details`, `tgm-holders-gini-stats`, `tgm-holders-change`, `tgm-holders-hourly-stats`, `wp4t-transactions`.

**Router** (D7):

- `eligible` = state `healthy | probation` + còn budget path + còn cap.
- Chọn **least-outstanding**, tie → **least-recently-used**.
- Không door nào eligible nhưng còn door sống → chờ slot sớm nhất (tính từ budget/quarantine), poll mỗi 250ms, **cap 65s**; quá cap → trả `{status: 503, json: null}` + log `[pool] no door budget for <path> (skip)`.
- Không còn door sống → `503` ngay.

---

## 7. Proxy file + vận hành

- Env `CRAWL_PROXY_FILE` (default `''`, plan §T1/D2).
- Format mỗi dòng: `http://user:pass@host:port`. Dòng `#` = comment, dòng trống = bỏ qua. Dòng không parse được → **log warn + bỏ, không crash**.
- Vị trí file: `./data/proxies.txt` (host) = `/data/proxies.txt` (trong container). Thư mục `./data` đã có bind mount sẵn `./data:/data` (`docker-compose.yml:38-40`) và **không commit** vì chứa credential proxy.
- **Đọc 1 lần lúc khởi động, KHÔNG hot reload** (plan hard constraint #5). Đổi file ⇒ chạy `make restart`.
- N doors = N dòng valid. File thiếu/rỗng → **fallback single-door** từ `CRAWL_WS_ENDPOINT` (proxy = null) = hành vi hiện tại + bug-fix (D2, backward compat).
- Startup log (D8): `loaded N proxies → N doors` + kết quả từng door. `pool.start()` warmup song song, non-blocking; `index.ts` không sửa, không await.
- Chỉ hỗ trợ HTTP proxy (`http://user:pass@host:port`). **SOCKS5 không dùng được** vì Chrome không auth được SOCKS5 (plan non-goals; `issues.md` gotcha).
- Bảo mật: không log password, không đưa credential vào URL log; `.env.example` chỉ ghi tên biến + format, không giá trị thật (plan hard constraint #6). Observability (D10): log `[door <id>] <event> path=<p> status=<s> budget=<used>/<cap> outstanding=<n> state=<st>`; events `warmup-ok, warmup-fail, retired, throttled, re-warm, requery, skip, egress`. Không thêm endpoint mới.

---

## 8. Sizing + cost (D9)

**Công thức**:

```
doors = max( ceil(total_demand / door_cap),  max_path ceil(path_demand / path_budget) ) + 1 dự phòng
```

với `door_cap = CRAWL_DOOR_CAP_PER_MIN = 40` req/phút (D6), `path_budget = CRAWL_PATH_BUDGET = 30` req / 60s / (door, path) (D6). `max_path` lấy path có nhu cầu cao nhất (thực tế là `wp4t-transactions`).

**Bảng 1: cadence repair** (~32 req/min tổng, wp4t ~11.8/min; `evidence/2026-09-21-vol-1h-column.md` §8; plan §D9):

| Đại lượng | Giá trị | Phép tính |
|---|---|---|
| total_demand | ~32 req/min | `evidence/2026-09-21-vol-1h-column.md` §8 |
| wp4t path_demand | ~11.8 req/min | `evidence/2026-09-21-vol-1h-column.md` §8 (1 059 pairs / 90 phút) |
| `ceil(total / 40)` | 1 | `ceil(32/40)` |
| `ceil(wp4t / 30)` | 1 | `ceil(11.8/30)` |
| doors (formula) | **1** | `max(1, 1)` |
| Khuyến nghị triển khai | **2-3** | plan §D9 (dự phòng + headroom) |

**Bảng 2: cadence prod** (~190 req/min tổng, wp4t ~70/min; plan §D9; `evidence/2026-09-21-vol-1h-column.md` §8):

| Đại lượng | Giá trị | Phép tính |
|---|---|---|
| total_demand | ~190 req/min | plan §D9 |
| wp4t path_demand | ~70 req/min (`POLL_WALLETS_MS=900000`, 1 059 pairs) | `evidence/2026-09-21-vol-1h-column.md` §8 |
| `ceil(total / 40)` | 5 | `ceil(190/40) = ceil(4.75)` |
| `ceil(wp4t / 30)` | 3 | `ceil(70/30) = ceil(2.33)` |
| doors (formula) | 5 | `max(5, 3)` |
| doors (+1 dự phòng) | **6** | plan §D9 |

**RAM**: `mem_limit ≈ 1g + 0.7g × N`, N = số connection vào container `chrome` (plan §D9, §T5; `docker-compose.yml:23`).

| N | RAM ước tính | Ghi chú |
|---|---|---|
| 2 | ~2.4g | `mem_limit: 3g` hiện tại cover N ≤ 2 (`docker-compose.yml:19,24`) |
| 3 | ~3.1g | Phải nâng `mem_limit` (T5) |
| 6 | ~5.2g | Kịch bản cadence prod (plan §D9 ghi `1g+0.7g×6 ≈ 5.2g`) |

`shm_size: 1g` giữ nguyên (`docker-compose.yml:27`); Chrome render qua `/dev/shm`, default 64m sẽ fallback ra disk và stall.

**Cost**:

- VPS ~$5/mo/IP: **ước lượng từ plan §T4, chưa đo thực tế**.
- Dedicated proxy (giá thuê): **chưa đo**.
- Khuyến nghị: **dedicated static IP, mỗi IP một door**. Lý do: shared pool đã đo **trôi reputation 1/6 → 6/6 × 403 trong vài phút** (§2 #5), còn IP riêng/VPS riêng đã đo **4/4 × 200** ổn định (§2 #6) và egress ổn định trong session (§2 #7). Đường rẻ và chắc là mỗi IP riêng một door.

---

## 9. Runbook + rủi ro mở

**Cadence repair** (D12, owner đã duyệt default):

Sửa `.env` trên server (`194.163.187.250`, port 8124):

```
POLL_WALLETS_MS=5400000
POLL_HOT_MS=1800000
POLL_COLD_MS=7200000
```

⇒ tổng ~32 req/min (từ ~190), lọt dưới budget 43/min (`evidence/2026-09-21-vol-1h-column.md` §8; plan §D12). **KHÔNG đổi default trong `server/src/config.ts`** (plan §D12); prod pin giá trị trong `.env`.

Quy trình:

1. `.env` trên server là **manual, KHÔNG được Makefile deploy** (`Makefile:50` loại trừ `.env`; `.omo/notepads/nansen-proxy-routing/learnings.md`). Phải sửa trực tiếp trên server.
2. Tạo/sửa `./data/proxies.txt` trên server (nếu dùng door pool).
3. Chạy `make restart` (`Makefile:61-63` = deploy + up).

Task này **không** ssh, không deploy; runbook chỉ để owner thực thi.

**Cảnh báo bảo mật**: `NANSEN_API_KEY` đã lộ ra log trong một phiên trước **cần rotate** (`evidence/2026-09-21-vol-1h-column.md` §8 "Security note"). Tài liệu này chỉ nhắc **tên biến**, không chứa giá trị.

**Open questions**:

- **RAM trống server prod chưa đo** → chặn N tối đa (plan OQ1). Phải đo RAM trống trước khi nâng `mem_limit` theo công thức §8.
- **Chưa có proxy thật để live-verify**: toàn bộ state machine / budget / classifier hiện được chứng minh bằng unit test (fake clock + fake transport) và smoke `--simulate`; chưa chạy với proxy dedicated thật (plan §T6/T7, OQ). Live probe với proxy thật **chờ owner chạy**, không block.
- **Giá dedicated proxy/IP thực tế chưa đo** (§8): con số ~$5/mo/IP là ước lượng từ plan §T4.

