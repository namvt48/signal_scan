# Door-pool blackout fix — 2026-09-23 (signal_scan)

**TL;DR (VI):** Lỗi gốc không nằm ở proxy. Chrome/browserless chết browser process → mọi fetch trả
`threw + status 0` → pool xếp nhầm thành lỗi transport → **cả 2 door bị `retired('broken-proxy')`
trong cùng 200ms** (proxy vẫn sống) → pool hết door → mọi request `tgm-holders-hourly-stats` /
`tgm-volume-details` nhận 503 tự sinh → `t100_multiple` / `genesis_bal` không bao giờ được ghi →
dashboard chỉ còn `fresh`. Đã sửa 2 tầng: (1) lỗi page/CDP không tính là lỗi proxy nữa (rewarm thay
vì retire), (2) door `broken-proxy` không còn là án tử — tự re-arm sau 60s. Deploy + verify trên prod.

## 1. Symptom

- Prod `194.163.187.250` (`/root/signal_scan`, port 8124): đa số ticker chỉ có setup factor `fresh`,
  thiếu `t100_multiple` / `genesis_bal`.
- DB baseline sau blackout: `tracked_cas` 89 · `nansen_fresh_pct` 84 · `t100_multiple` **6** ·
  `genesis_bal` **7** · `anchor_at` 6 → 78 dòng fresh-only.
- Log: `[pool] no door budget for <path> — skip` lặp vô hạn; `nansen chart 503`.

## 2. Root cause

Chuỗi nhân quả trong `server/src/crawl.ts` (trước fix):

1. `06:30:30Z` browserless log `Browser process 1222ee19-… has closed, cleaning up` → browser
   process bên trong container `signal_scan-chrome-1` chết (container **không** restart: `RestartCount=0`).
2. Mọi fetch đang bay trả `{status:0, threw:true}`. Đường page: `head='page unavailable (invalidated)'`;
   đường CDP throw: `head=<message>` của puppeteer. `dispatch()` (:397-417) chỉ giữ được
   `threw + status 0` — **không có field nào phân biệt "page chết" với "proxy chết"**.
3. `classify()` trả `'transport'` → `applyOutcome()` cũ: `transportFails += 1`, **≥2 → `retire(d,'broken-proxy')`**.
4. Cả 2 door dùng **chung một** chrome container ⇒ một cú chết browser hạ cả hai trong ~200ms
   (`06:35:30Z`, log `retired reason=broken-proxy` cho door 0 và door 1).
5. `retire()` (:524-527) đặt `state='retired'` + `conn.close()`; `pick()` bỏ qua door retired → **terminal**.
   Chỉ `interstitial`/`real403` mới gọi `rewarm()`; `transport` thì không ⇒ không đường hồi.
6. `postJson()` :259 `if (!door) return {status:503, json:null}` ⇒ mọi call sau đó nhận **503 tự sinh**
   (không phải Nansen trả 503). `nansenSeries()` :807 `throw new Error('nansen chart 503')`.
7. `setupSweep` gọi gini (1 request) TRƯỚC series ⇒ 84 CA kịp lấy `fresh` trong 35 phút door còn sống;
   `exchangeLf` (6 window) + `tgm-holders-hourly-stats` fail ⇒ pass không hoàn chỉnh ⇒
   `setup-cache` từ chối ghi ⇒ không có gì rehydrate.

**Bằng chứng proxy KHÔNG hỏng** (probe chạy từ *trong* container api, đọc `/data/proxies-server.txt`):

```
door0 http://***@194.163.187.250:31133 -> HTTP 200 egress=[194.163.187.250]
door1 http://***@167.86.101.228:31128 -> HTTP 200 egress=[167.86.101.228]
direct (no proxy)                      -> HTTP 200 egress=[194.163.187.250]
```

Ngoài ra: tinyproxy 250 `NRestarts=0`, `Allow 172.23.0.0/16` khớp compose subnet; tinyproxy 167
journal **im lặng** quanh 06:35Z ⇒ request chưa từng tới proxy. `curl` từ host 250 vào `:31133` trả
000 (hairpin NAT của provider) nhưng từ container trả 200 — host-side probe là false negative.

## 3. Fix

`server/src/crawl.ts` + `server/src/api.ts`:

| # | Change | Ref |
|---|---|---|
| 1 | `realConnect.fetch` đánh dấu mọi throw có nguồn gốc page/CDP bằng prefix `browser:` | :756, :761 (const :193) |
| 2 | `applyOutcome` case `transport`: throw có prefix `browser:` → `rewarm()`, **không** tiêu `transportFails` | :492-493 |
| 3 | Door có `retiredAt`; `rearmRetired()` hồi sinh door `broken-proxy` sau `RETIRED_RETRY_MS = 60s` | :229, :589-600 (const :202) |
| 4 | `acquire()`: khi **mọi** door retired → re-arm; log 1 lần `ALL DOORS RETIRED — pool exhausted` | :342-349 |
| 5 | `warm()` success xoá `retiredReason` (door sống không được đọc như retired) | :267, :577 |
| 6 | `/api/health` trả `doors: poolStatsOrNull()` — `null` nếu pool chưa dựng (không side-effect) | api.ts :31, :256; crawl.ts :821 |

Hai hình thái lỗi được bao trùm:
- **page chết, browser sống** → rewarm 1 phát, hồi ngay (không mất request nào vào sổ retire).
- **browser process chết** → rewarm fail ×2 → retire → re-arm sau 60s → `puppeteer.connect()` dựng
  browser mới. Trần blackout: **60s** thay vì vĩnh viễn.

Chủ ý KHÔNG đổi: `real403-reputation` retire vẫn terminal (IP bị 403 liên tục không được dò lại mỗi
60s — có test pin), và lỗi transport thật (head rỗng / `Failed to fetch` từ trong page) vẫn theo đúng
D5 cũ: 2 lần liên tiếp → retire.

## 4. Tests

`server/test/door-pool.test.ts` — **chỉ thêm**, không sửa file (frozen contract T2/T3):

- `browser-level failure: re-warms the door instead of retiring it, and the door keeps serving` (:498)
- `browser-level failure does NOT spend a transport fail: a real transport fail still retires (2 consecutive)` (:521)
- `re-arm: broken-proxy door revives after RETIRED_RETRY_MS and serves again` (:541)
- `re-arm: a real403-reputation retire stays terminal` (:566)

```
ℹ tests 182  pass 182  fail 0   (trước đó 178)
> tsc → BUILD_EXIT=0
LSP: no diagnostics (crawl.ts, api.ts, door-pool.test.ts)
```

13 test cũ của door-pool (kể cả `lifecycle: 2 consecutive transport failures retire a door (broken-proxy);
exhausted pool degrades to 503 without throwing`) vẫn xanh ⇒ hợp đồng D5 giữ nguyên.

## 5. Prod verification

Deploy: `make restart` (rsync + `docker compose build` + `up -d`; api `Recreated`).

**Trước** (blackout): `{"fresh":84,"t100":6,"genesis":7}` · log chỉ có `no door budget … skip`.

**Sau** (~2 phút):

```json
"doors":[{"id":0,"state":"healthy","proxy":"…250:31133","requests":5,"lastStatus":200,"retiredReason":null},
         {"id":1,"state":"healthy","proxy":"…228:31128","requests":7,"lastStatus":200,"retiredReason":null}]
```
```json
{"fresh":85,"t100":7,"genesis":8}
```

**Sau** (~14 phút): doors `healthy` (requests 22/24, `lastStatus:200`, `retiredReason:null`) ·
`{"rows":92,"fresh":87,"t100":9,"genesis":10,"anchor":9}` ·
`nansen chart 503` **0** · `page-fail|ALL DOORS|retired` **0** · `warmup-ok` cho cả 2 door.

Kết luận: đường browser-door thông lại; `t100_multiple` 6→9, `genesis_bal` 7→10, `anchor_at` 6→9.

**Vì sao các con số đứng yên sau đó (không phải kẹt):** `[poller] setupSweep anchored to
systemDeployAt=2026-09-23T06:00:06.610Z — next pass in 38548s` (~10.7h) — sweep đầy đủ trên toàn bộ
queue chạy theo nhịp 12h neo vào `systemDeployAt`; đường chạy nhanh (`earlySweep`) chỉ phục vụ CA
mới thêm. Log `early setup pass` = **3**, khớp 1:1 với `t100 +3`, `genesis +3`, `anchor +3` và cache
complete `6 → 9` ⇒ **cả 3 CA đó đi trọn chuỗi gini + series + exchange**, không sót bước nào.
`setupSweep gini|series`, `genesisLF`, `crawlBalanceSeries` = **0 lỗi**. 78 CA fresh-only còn lại chờ
mốc sweep 12h kế tiếp (đúng thiết kế, không phải blackout).

## 6. Ghi chú ngoài scope

- `nansen-cache.json`: log boot `[setup-cache] loaded 6 entries from /data/nansen-cache.json
  (pruned 7)` rồi +3 entry complete mới ⇒ 9 entry hiện tại, 9/9 complete. **Không phải mất dữ liệu**
  — `pruneSetupCache` (`setup-cache.ts:198-214`) bỏ entry không còn trong `tracked_cas` (hoặc quá
  7×POLL_SETUP_MS), và C2 guard chặn wipe khi queue rỗng. (Con số "13→9" ở bản trước của file này
  ghi gộp prune + entry mới; chi tiết đúng là prune 7 ở boot rồi ghi thêm 3.)
- Chrome container chạy `mem_limit 3g`; browser process từng chết vì OOM. Pool giờ tự hồi nhưng
  memory ceiling vẫn là nguyên nhân nền — nếu tái diễn nhiều, xem lại limit.
- `solana rpc … 429` tràn `walletSweep`: vấn đề riêng, không thuộc fix này.
- `server/src/poller.ts:137` LSP error (`Expected 0 arguments, but got 1`) có sẵn từ trước, không đụng.
