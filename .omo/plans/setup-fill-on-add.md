---
slug: setup-fill-on-add
status: DONE — Final Wave PASSED 2026-09-23 (F1 APPROVE · F2 APPROVE sau fix · F3 APPROVE); deploy còn gate ở việc user bật lại 250
intent: decided (F1=(b) + F1b=(i) · F2=yes · F3=queue)
review_required: true
approved_at: 2026-09-23
source_request: 'user 2026-09-22 (verbatim, xem §0)'
delivery_mode: direct (repo KHÔNG phải git repo → không worktree, không PR)
---

# Work Plan: Setup fill-on-add + file cache (t100/lf)

Repo: `/home/namvt/Desktop/dev-space/signal_scan` — **KHÔNG phải git repo, cấm mọi lệnh git.** Server TypeScript trên better-sqlite3: `server/` (tsx, node:test, puppeteer-core). Build: `cd server && npm run build`. Test: `cd server && npm test` (= `tsx --test test/*.test.ts`).

> **TRẠNG THÁI: ĐÃ DUYỆT 2026-09-23 — F1=(b) · F1b=(i) · F2=có · F3=queue (chi tiết §3).**
> Freeze lift cấp cho `poller.ts` + `api.ts`. F1=(b) ⇒ công thức anchor của t100/lf KHÔNG đổi ⇒ `snapshot.ts` **không cần sửa** (vẫn frozen). Deploy chỉ khi user cho bật lại 250.

## 0. Yêu cầu nguyên văn (user 2026-09-22)

> "Setup chỉ có fresh: t100/lf chưa ai ghi cái này lúc mà CA mới thêm vào CALL một lần cho đầy đủ thông tin, và cache lại nếu mà reset lại hệ thống thì không mất và định kì crawl lại các mốc 12h, từ giờ mặc định là khoảng thời gian kể từ thời điểm deploy hệ thống"

Diễn giải 3 yêu cầu:
1. **Fill-on-add** — lúc CA mới được thêm vào, gọi đủ 1 lần để có t100/lf (hiện chỉ `fresh` có).
2. **Cache** — cache lại để reset hệ thống không mất.
3. **Định kỳ 12h** — crawl lại theo mốc 12h; "từ giờ mặc định là khoảng thời gian kể từ thời điểm deploy hệ thống" (đọc thế nào → **F1**).

---

## 1. Problem statement (grounded in observed production state)

Tất cả số liệu dưới đây là **observed**: đo trên prod 250 ngày 2026-09-22, ghi trong `evidence/2026-09-22-ca-reset-250.md` (đọc lại file này trong session 2026-09-23). Không re-measure được ở local vì `data/signal_scan.db` không tồn tại trong repo.

- **12 CA re-track sau reset**: `nansen_fresh_pct` **12/12** và `nansen_t100_pct` **12/12**, nhưng `t100_multiple` **0/12**, `genesis_bal` **0/12**, `anchor_at` **0/12** → `fresh` có, `t100`/`lf` không ai ghi. Systemic, không phải per-CA.
- **Setup pass chạy đúng 1 lần lúc khởi động với queue rỗng** (`tracked_cas` = 1 ngay sau reset, phần lớn CA add SAU khi pass đã chạy): log `[poller] setupSweep done in 1ms`; pass kế tiếp ~12h sau (`POLL_SETUP_MS` default `43_200_000`, `config.ts:56`; trên 250 env không set → default).
- **Chuỗi series fail trên browser door**: log `[poller] seriesAtRung DeatoN4U Error: nansen chart 403` (Cloudflare) và `[poller] series cut ngan hon cua so xin, keep previous AJjATm3L n=0` (`poller.ts:264`, `snapshot.ts:107`).
- **Hệ quả**: FE/`/api/signals` payload `nansen.pass.t100/lf` luôn false vì đọc `token_state.t100_multiple` / `token_state.genesis_bal` (`signals.ts:213-217`) đều NULL. `fresh` có vì nó đến từ 1 card gini-stats rẻ (`metricSweep('gini')`, `poller.ts:235`).

---

## 2. Cơ chế (mỗi dòng đã verify trong session này; line number thật)

> **Sole-writer claim (đã kiểm chứng):** `refreshSeries` (`poller.ts:282`) là writer duy nhất của `t100_multiple`/`genesis_bal`/`anchor_at` **trong Nansen mode**. `t100_multiple` và `anchor_at` chỉ được ghi bởi `updateTokenAnalytics` (`ingest.ts:159-192`); hai caller của nó là `refreshSeries` (`poller.ts:299`) và `kickNansen` (`poller.ts:514`), mà `kickNansen` truyền giá trị cũ qua `passThroughAnalytics` (`poller.ts:214`) nên **không bao giờ fill**. Chỉ `genesis_bal` có writer thứ hai về lý thuyết: `upsertTokenInfo` ghi `genesis_bal = COALESCE(excluded.genesis_bal, …)` (`ingest.ts:66`) nhưng chỉ khi provider trả `info.genesisBal`; `providers/mock.ts:91` có, **Nansen không** → prod chỉ `refreshSeries`.

- `refreshSeries` (`poller.ts:282`) → `seriesAtRung` (`poller.ts:257`, 1 request series) + `exchangeLf` (`poller.ts:176`, request thứ 2 `label='exchange'`, ladder `LF_WINDOWS` `snapshot.ts:161`) + ghi `updateTokenAnalytics` (`poller.ts:299`). Sole caller: `setupSweep` (`poller.ts:230`). Lịch: `poller.ts:552`, gated `config.crawlEnabled` (`poller.ts:551`; `config.ts:80`, default `off`).
- `kickNansen` (`poller.ts:510`) cố ý pass-through 4 cột analytics qua `passThroughAnalytics` (`poller.ts:214`) → **đường tần suất cao KHÔNG THỂ fill t100/lf**.
- `kickCAs` (`poller.ts:483`) gọi `kickToken` (`poller.ts:499`) + `kickNansen`; chạy khi CA được add từ `POST /api/tracked-cas` (`api.ts:345`, fire-and-forget tại `api.ts:372`). Đây chính là hook "lúc mà CA mới thêm vào".
- `seriesFromMs` (`snapshot.ts:147`, body `:148`): `Math.max(now - capMs, deployedAt || 0)` — clamp cửa sổ về `deployed_at`. `exchangeAnchorLf(points, minAt)` (`snapshot.ts:84`, clamp tại `:91`) chặn scan leftmost>0 bởi `minAt` = token `deployed_at` (0 = không clamp). `t100Genesis(points)` (`snapshot.ts:56`) suy genesis/trough từ chính series được đưa.
- `rungFor`/`tfFor` (`poller.ts:157`, `snapshot.ts:171`) chọn rung theo tuổi token; `RUNG_SPAN_DAYS` (`snapshot.ts:140`).
- **Series cache hiện tại = bảng `nansen_series`** (`db.ts:167`) → reset DB (wipe bảng) xoá sạch (`evidence/2026-09-22-ca-reset-250.md`: `nansen_series` 4074 → **0**). Đó đúng là lý do "reset lại hệ thống thì không mất" cần **FILE** cache. `data/` được loại khỏi `make deploy` (`Makefile:50` `rsync … --exclude data`) nên file trong `data/` sống qua deploy; nhưng `make ssh-rm` (`Makefile:90`) xoá cả `data/` trong REMOTE_DIR → KHÔNG sống qua ssh-rm.

---

## 3. BA FORKS — ĐÃ ĐƯỢC USER TRẢ LỜI (2026-09-23)

> **Chốt:** F1=(b) · F1b=(i) · F2=có · F3=queue. Freeze lift: `poller.ts` + `api.ts`.

### DECIDED — F1 → nhánh (b)
**User 2026-09-23 (verbatim):** "hiện tại mấy cái nansen đang được config là 12h crawl lại data phần này để update 1 lần thì cái khoảng 12h này tính từ lúc deploy hệ thống lên server"
→ Mốc 12h tính TỪ LÚC DEPLOY HỆ THỐNG; công thức anchor của t100/lf (deploy-clamp) GIỮ NGUYÊN. Nhánh (a) bị loại.

**Nhánh (a) — đổi ANCHOR cửa sổ t100/lf từ `deployedAt` của token sang timestamp deploy của HỆ THỐNG.**
Chạm: `seriesFromMs` (`snapshot.ts:147-148`), giá trị `minAt` truyền vào `exchangeAnchorLf` (`snapshot.ts:84`/`:91`, gọi từ `exchangeLf` `poller.ts:198` và `seriesAtRung` `poller.ts:260`), và giá trị `anchor_at` ghi vào `token_state` (`poller.ts:293`).
⚠ Nếu anchor hệ-thống **muộn hơn** `deployed_at` của token (cao hơn cho gần hết CA re-track), cửa sổ bị cắt sau genesis thật → `seriesReachesStart` fail → đúng lỗi `series cut ngan hon cua so xin` đang quan sát. Chỉ an toàn nếu làm **floor** (không bao giờ muộn hơn `deployed_at`).

**Nhánh (b) — giữ nguyên công thức, chỉ tính mốc cadence 12h từ thời điểm deploy hệ thống.**
Chạm: chỉ scheduler — `poller.ts:552` + `config.ts:56` (mốc "pass đầu tiên" / "lần re-crawl kế" tính từ `systemDeployAt`).

**Recommendation:** **(b)** — giữ các công thức deploy-clamp (`seriesFromMs`/`exchangeAnchorLf`) đã tạo ra mọi giá trị t100/lf user-confirmed; đọc câu này như mốc cadence/cache-validity chứ không phải anchor genesis, vì (a) sẽ tái tạo đúng lỗi `series cut` trừ khi hạ xuống thành floor.

**Sub-fork F1b — nguồn timestamp:**
- (i) **KEY MỚI `systemDeployAt` trong `settings`, ghi lúc startup nếu chưa có** → chạm `db.ts` (migration, cạnh `lfRule` `db.ts:228-230`) + đọc ở `poller.ts`/`config.ts`.
- (ii) hằng số reset marker `2026-09-22T16:56:28Z` (`evidence/2026-09-22-ca-reset-250.md`) hardcode.
- (iii) process start (`Date.now()` lúc boot).
**Recommendation sub-fork:** **(i)** — bảng `settings` sống qua reset (observed: reset 2026-09-22 giữ `settings` **11 rows**), và đã có tiền lệ marker migration (`lfRule`, `db.ts:228-230`); process-start trôi mỗi restart, marker literal chỉ đúng cho đúng lần reset này.

**CHỐT (2026-09-23): (i).** Key mới `systemDeployAt` trong `settings`, ghi MỘT LẦN lúc startup nếu chưa có, **KHÔNG ghi đè** — neo phase cố định qua restart và qua reset bảng (`settings` đã sống sót reset 2026-09-22 với 11 row).

### DECIDED — F2 → **CÓ** (lift freeze)

**User 2026-09-23:** "có".
**Phạm vi lift:** `server/src/poller.ts` + `server/src/api.ts` (kèm `config.ts` / `crawl.ts` / `db.ts` vốn KHÔNG frozen).
**`snapshot.ts` KHÔNG cần lift** — F1=(b) không đổi công thức anchor (`seriesFromMs` `snapshot.ts:147-148`, `exchangeAnchorLf` `:84/:91` giữ nguyên) → vẫn frozen.

`poller.ts`, `api.ts`, `snapshot.ts` bị đóng băng bởi `.omo/plans/nansen-proxy-routing.md` **hard constraint #2** (dòng 22: "`poller.ts` / `providers/nansen.ts` / `api.ts` / `snapshot.ts` / FE: KHÔNG sửa"). Plan đó đã **11/11 complete** nhưng freeze vẫn là chỉ thị của plan.

- **Mọi nhánh của F1/F3 đều chạm ít nhất 1 trong 3 file này** → **không nhánh nào implement được nếu không lift freeze** cho đúng 3 file: `server/src/poller.ts`, `server/src/api.ts`, `server/src/snapshot.ts`.
- **VẪN ĐÓNG BĂNG BẤT KỂ F2** (không xin lift): `server/src/providers/nansen.ts`, FE `src/**`, `docker-compose.yml`, `.env.example`, `docs/**`, `server/test/door-pool.test.ts` (**13 tests** — grep -c xác nhận), không thêm dependency mới, không git (repo không phải git).

**Recommendation:** lift freeze **chỉ** cho `poller.ts` + `api.ts` + `snapshot.ts`, và chỉ trong phạm vi các thay đổi mô tả ở đây; giữ nguyên `providers/nansen.ts`/FE/`door-pool.test.ts`.

### DECIDED — F3 → nhánh (b): **QUEUE**

**User 2026-09-23:** "queue".
**Phát hiện khi verify (delta nhỏ hơn brief):** phần "jump the queue" ĐÃ có sẵn — `newCaPriorityMs` (`config.ts:59`, default `3_600_000`) + `newCasFirst` (`poller.ts:66`): CA mới trong 1h nhảy lên đầu mọi sweep rảnh. Thiếu duy nhất **trigger sớm paced** (hiện `setupSweep` chỉ chạy theo lịch `poller.ts:552`), nên việc phải làm gọn hơn nhiều so với "xây queue mới".

**Nhánh (a) — fill inline** trong `api.ts:345` handler (gọi thẳng `refreshSeries` cho CA vừa add trước khi response). Chạm `api.ts:345-374` + `poller.ts` (export/đường gọi).
**Nhánh (b) — enqueue CA mới vào sweep paced sẵn có** (`setupSweep`/`pacedFor`), ưu tiên đầu queue qua `newCasFirst` (`poller.ts:66`), và cho phép trigger 1 pass sớm (delay ngắn) thay vì đợi tới 12h. Chạm `poller.ts:230`/`:552` + `api.ts:372`.

**Recommendation:** **(b)** — 1 setup đầy đủ = **~2–3 request browser-door mỗi CA** (`seriesAtRung` 1 series + `exchangeLf` 1 request `label='exchange'` + card `gini` ở `poller.ts:235`); với **~61 CA auto-add/giờ** (observed, `evidence/2026-09-22-ca-reset-250.md` dòng 41), fill inline cộng thêm **~122–183 request door/giờ**, dồn cục, trong khi budget là per-path **30/min** (`config.ts:95`) + per-door cap **40/min** (`config.ts:98`) so với trần page đo được **~43 req/min** → burst add sẽ đốt hết budget và tái tạo đúng `seriesAtRung … 403`. Sweep pacing (`pacedFor`, `poller.ts:46`) trải request theo `POLL_SETUP_MS`, không bao giờ dồn batch.
**Kỳ vọng pacing/budget (để executor verify):** pass setup phải giữ **tổng ≤ 40 req/min/door** và **≤ 30 req/min/path**, và không chạm trần 43/min/page; trigger sớm cho CA mới phải paced, không bắn đồng loạt.

---

## 4. Cache design — `data/nansen-cache.json`

**Mục tiêu:** sống qua (a) reset wipe bảng DB và (b) `make deploy`; rehydrate lúc startup để entry còn trong 12h **không phải crawl lại** (không đụng door).

**Vị trí:** `data/nansen-cache.json` (mặc định; env `SETUP_CACHE_FILE='./data/nansen-cache.json'`). `data/` bind-mount và bị loại khỏi deploy (`Makefile:50`) → sống qua deploy + wipe bảng. **Cảnh báo thật:** `make ssh-rm` xoá `data/` (`Makefile:90`) → file CHẾT. Ghi rõ trong plan/evidence.

**Record shape (field name cụ thể, 1 record / (ca, chain)):**
```json
{
  "version": 1,
  "entries": [
    {
      "ca": "Fg9xK2mR7qT4vBn8cLd3Ws6Za1Py5Ue9HjA",
      "chain": "sol",
      "taken_at": 1758600000000,
      "window": "week",
      "series_from": 1758000000000,
      "series": [{ "t": "2026-09-16T02:00:00Z", "total": 616080000 }],
      "exchange": [{ "t": "2026-09-16T02:00:00Z", "total": 128890000 }],
      "t100_pct": 12.3,
      "t100_multiple": 1.42,
      "anchor_at": 1758000000000,
      "genesis_bal": 128890000
    }
  ]
}
```
- `series` = raw points của `seriesAtRung` (hourly-stats) tại rung `window`; `exchange` = raw points `label='exchange'` của `exchangeLf`. Lưu raw để rehydrate có thể replay cả chart cache (`upsertNansenSeries`, `db.ts:589`).
- `t100_pct`/`t100_multiple`/`anchor_at`/`genesis_bal` = derived fields, ghi thẳng vào `token_state`.

**Write policy:** ghi/ghi đè record sau khi `refreshSeries` (`poller.ts:282`) hoàn tất THÀNH CÔNG (có series + exchange → derived fields). Ghi atomic (tmp + rename). Prune: bỏ entry của CA không còn tracked + entry cũ hơn ngưỡng (ví dụ > 7×`POLL_SETUP_MS`) để file không phình vô hạn.

**12h validity check:** entry hợp lệ khi `now - taken_at < POLL_SETUP_MS` (`config.ts:56`, `43_200_000`). Quá hạn → coi như stale, phải crawl lại.

**Rehydrate trigger + hành vi sau reset DB:**
- Trigger: **lúc startup** (`index.ts` gọi `open()` xong, trước/không phụ thuộc `startPoller`), load file vào 1 map in-memory.
- Vì `updateTokenAnalytics` là `UPDATE` (`ingest.ts:166`) — row `token_state` do essential sweep / `kickToken` tạo — rehydrate áp dụng **lazy**: `refreshSeries` (và `kickNansen`) kiểm tra cache TRƯỚC khi fetch door; nếu entry hợp lệ **và** `getTokenState(ca, chain)` đã tồn tại → ghi derived fields bằng `updateTokenAnalytics` + replay `upsertNansenSeries` cho các window trong cache rồi **return sớm (0 door request)**. Nếu row chưa tồn tại → để lần gọi sau (sau khi essential/kickToken tạo row) áp dụng; không fetch door khi entry còn hạn.
- Sau reset DB: startup nạp file → các CA được re-add lại sẽ có row qua essential sweep, và `kickToken` (fired ở `api.ts:372`) áp cache ngay → t100/lf hiện lại **không cần crawl**. Entry còn trong 12h bị skip; entry stale bị crawl lại + cập nhật file.

**Alternative đã loại — bảng DB:** không thoả "reset không mất" vì reset wipe bảng (observed `nansen_series` 4074 → 0), đúng cùng cơ chế phá huỷ.

---

## 5. Tests + verification gates

- Gate build/test: `cd server && npm run build && npm test`.
- **Baseline hiện tại: 152 pass / 0 fail** (nguồn: `.omo/notepads/setup-trackedby/learnings.md` — sibling change `trackedByNames` đã ship session này; `door-pool.test.ts` 13 tests frozen, green). **Re-measure trước khi bắt đầu** (đúng lệnh trên) và ghi log baseline.
- **Tests mới cần thêm** (TDD RED trước — rule cf--testing):
  1. **fill-on-add**: CA mới add → sau đường setup, `token_state` có `t100_multiple`/`genesis_bal`/`anchor_at` non-null (fake provider đếm đúng số fetch).
  2. **cache sống qua wipe**: ghi cache → đóng DB → wipe `token_state` (mô phỏng reset) → reopen → rehydrate → 4 cột khôi phục **mà fake provider đếm 0 fetch cho entry còn hạn**.
  3. **rehydrate path**: entry `< 12h` → áp từ cache, không fetch; entry `> 12h` → fetch lại và cập nhật file.
  4. **cadence 12h**: `setupSweep` dùng `pollSetupMs`; biên validity đúng tại `now - taken_at == 43_200_000`.
- **Evidence path:** `evidence/2026-09-23-setup-fill-on-add.md`, kết thúc `EVIDENCE_RECORDED: <path>`.

---

## 6. Task breakdown (T1..Tn)

> Shape copy từ `.omo/plans/nansen-proxy-routing.md`. TODO **chưa tick** — plan chưa duyệt.

- [x] **1. [T1] F1–F3 answers captured + freeze lift recorded** (không code) — DONE 2026-09-23: F1=(b) · F1b=(i) · F2=có · F3=queue; frontmatter → `APPROVED`; phạm vi lift ghi ở §3/F2
  Ghi câu trả lời user cho F1 (a/b + sub-fork i/ii/iii), F2 (lift freeze 3 file), F3 (a/b) vào plan; cập nhật frontmatter `status`/`intent`/`approved_at` khi user duyệt.
  - **Acceptance Criteria**
    - [ ] F1/F2/F3 có câu trả lời ghi rõ trong file, không còn `DECISION NEEDED` treo
    - [ ] Danh sách file được lift freeze nằm trong plan; `nansen-proxy-routing.md:22` được trích làm nguồn
  - **Evidence**: diff plan (F1–F3 đã chốt)
  - **Difficulty**: LIGHT

- [x] **2. [T2] Cache store + record shape (`server/src/`, test mới)** · deps: T1 — DONE 2026-09-23: `server/src/setup-cache.ts` (214 dòng, leaf module) + `config.ts:45 setupCacheFile` (default cạnh `dbPath` → prod `/data/nansen-cache.json`) + `server/test/setup-cache.test.ts` (9 test). Verify độc lập: build 0, **161 pass / 0 fail** (152+9), lsp sạch ×3, `door-pool.test.ts` nguyên 13
  Implement đọc/ghi `data/nansen-cache.json` (atomic tmp+rename), record shape ở §4, validity `< POLL_SETUP_MS`; env `SETUP_CACHE_FILE`.
  - **Acceptance Criteria**
    - [ ] `cd server && npm run build` → exit 0
    - [ ] Test #2 (cache sống qua wipe) + test #3 (rehydrate) RED trước, GREEN sau
    - [ ] File ghi atomic; sai/thiếu file → không crash (fallback rỗng)
  - **Evidence**: log RED→GREEN + `node` dump record 1 CA → `evidence/2026-09-23-setup-fill-on-add.md`
  - **Difficulty**: MEDIUM

- [x] **3. [T3] Rehydrate + fill path (`poller.ts`, `snapshot.ts` theo F1)** · deps: T2 — DONE 2026-09-23 (gộp cùng T5): `poller.ts` `refreshSeries` export + door guard (entry còn hạn → apply rồi return, **0 fetch**); `applySetupCacheEntry` lazy (row chưa có → chờ, không fetch); `seriesAtRung`→`{points,from,window}`; `exchangeLf`→`{total,points}`; `cacheSeriesWindows` export; `crawl.ts` file-cache fallback khi `nansen_series` rỗng + seam `setPoolForTest`; `index.ts` load 1 lần lúc startup + prune. 3 guard an toàn bắt buộc: C1 `ensureLoaded()` (put trước load không phá file), C2 prune set rỗng = no-op (reset DB không xoá cache), C3 `isStorable()` (entry reload sẽ drop thì không ghi). Verify độc lập: build 0, **171 pass / 0 fail** (161+10), `door-pool` 13/13, lsp sạch, `snapshot.ts`/`api.ts`/`nansen.ts` không chạm
  Nạp cache lúc startup; `refreshSeries`/`kickNansen` check cache trước door; apply lazy khi row tồn tại; nhánh F1 đã chốt áp vào `seriesFromMs`/`exchangeAnchorLf`/`anchor_at` (nếu F1=(a)) hoặc chỉ scheduler (nếu F1=(b)).
  - **Acceptance Criteria**
    - [ ] `cd server && npm run build` → exit 0
    - [ ] Test #1 (fill-on-add) + #3 (rehydrate) GREEN
    - [ ] Entry còn hạn → **0** door request (fake provider đếm 0)
  - **Evidence**: log test + diff `poller.ts`/`snapshot.ts` → evidence file
  - **Difficulty**: HEAVY

- [x] **4. [T4] Enqueue/trigger theo F3 (`poller.ts`, `api.ts`)** · deps: T3 — DONE 2026-09-23: **chỉ `poller.ts`**, `api.ts` không đụng (queue-jump `newCasFirst` đã có sẵn, không dựng lại). `kickToken` giờ trả promise (resolve sau `upsertTokenInfo`, không bao giờ reject) → `kickCAs` chain `void kickToken(...).then(() => kickSetupEarly([c]))` = **bằng chứng thứ tự** (pass chạy sau khi row tồn tại). `kickSetupEarly`/`drainEarlySetup`: `crawlEnabled`-gated, 1 drainer tuần tự (không N đồng thời), batch qua `pacedFor(batch, newCaPriorityMs, …)`; lỗi bọc trong từng item → add không bao giờ fail vì pass. Verify độc lập: build 0, **173 pass / 0 fail** (171+2), `door-pool.test.ts` md5 `0eb56449b9c28faf4585189afa5c3eeb` nguyên 13/13, test assert thật (`exchangeFetches===2`, `doorFetches===6`, `maxActiveExchange===1`, cache tươi → 0 fetch mà cột vẫn đầy). Prod spacing: 1 CA = chạy ngay (item cuối không chờ), burst N = `1h×0.8/N` mỗi CA
  - **Observation (không chặn):** (1) mỗi CA mới tốn thêm 1 series fetch trùng giữa `kickNansen` và early pass (2 request/CA, không credit) — trong budget; (2) chain `earlySetupDrain` thiếu `.catch()` phòng thủ — hiện unreachable vì `fn` đã try/catch, ghi lại làm hardening sau
  Nếu F3=(b): CA mới vào đầu queue (`newCasFirst`, `poller.ts:66`) + trigger 1 pass sớm paced; nếu F3=(a): fill inline trong `api.ts:345`.
  - **Acceptance Criteria**
    - [ ] `cd server && npm test` → tất cả pass
    - [ ] Pacing ≤ 40 req/min/door và ≤ 30 req/min/path (giữ `config.ts:95,98`); không chạm 43/min/page
    - [ ] `server/test/door-pool.test.ts` **không sửa**, 13/13 pass
  - **Evidence**: log + số request/pass giả lập → evidence file
  - **Difficulty**: MEDIUM

- [x] **5. [T5] Cadence 12h theo F1 (`poller.ts`, `config.ts`)** · deps: T3 — DONE 2026-09-23 (gộp cùng T3): `systemDeployAt` ghi 1 lần trong `db.ts` `open()` (cạnh marker `lfRule`, không ghi đè → sống qua restart + reset bảng); `nextPhaseDelayMs(anchorAt, now, intervalMs)` neo `setupSweep` vào mốc `systemDeployAt + n × POLL_SETUP_MS` (deploy mới = mốc n=0 → pass đầu chạy ngay lúc boot). Anchor formula `seriesFromMs`/`exchangeAnchorLf` GIỮ NGUYÊN (F1=(b)) → `snapshot.ts` không sửa. Verify độc lập: build 0, 171/171, test #4 biên `43_200_000` GREEN
  Áp mốc cadence từ `systemDeployAt` (nếu F1=(b)) / validity cache; test #4 biên 12h.
  - **Acceptance Criteria**
    - [ ] Test #4 GREEN (biên `43_200_000`)
    - [ ] `cd server && npm run build && npm test` → exit 0, 0 fail
  - **Evidence**: log test → evidence file
  - **Difficulty**: LIGHT

- [x] **6. [T6] Evidence + verification tổng** · deps: T2–T5 — DONE 2026-09-23: `evidence/2026-09-23-setup-fill-on-add.md` §T6 (dòng 260-398) có output THẬT tự chạy lại: `BUILD_EXIT=0`, **173 pass / 0 fail**, md5 `door-pool.test.ts` khớp frozen `0eb56449b9c28faf4585189afa5c3eeb`, chain `152→161→171→173` mỗi bước 0 fail, danh sách 11 file + mục đích từng file, **verification matrix 4 yêu cầu user → evidence**, chứng minh 4 file frozen không bị chạm (mtimes), **deploy checklist** cho lúc user cho phép resume, 3 observation ghi lại (không sửa). Verify độc lập: T6 không đụng `server/src`/`server/test` (find mtime > 11:50 = rỗng), evidence append không ghi đè section cũ
  Tổng hợp build log, `npm test` full, RED→GREEN, baseline 152, diff file đã sửa, kết luận `EVIDENCE_RECORDED:`.
  - **Acceptance Criteria**
    - [ ] `evidence/2026-09-23-setup-fill-on-add.md` tồn tại, log thật (không mô tả suông)
    - [ ] Có dòng `EVIDENCE_RECORDED:`
   - **Evidence**: chính file trên
   - **Difficulty**: LIGHT

- [x] **7. [T7] F2 fix — prune dùng tracked set tươi (`poller.ts` + test mới)** · deps: T6 + Final Wave F2 REJECT — DONE 2026-09-23: F2 (reviewer code-quality) REJECT với **đúng 1** blocking finding — `setupSweep` prune (`poller.ts:263` cũ) dùng snapshot `cas` chụp lúc sweep BẮT ĐẦU, nhưng sweep bị paced qua `POLL_SETUP_MS × sweepPaceFactor` ≈ **0.8 × 12h ≈ 9.6h** (`pacedFor:57`), nên CA add giữa sweep đã được early-kick ghi cache entry hợp lệ (`kickCAs`→`kickToken`→`kickSetupEarly`→`drainEarlySetup`→`refreshSeries`→`putSetupCacheEntry`) rồi bị prune xoá oan → **void bảo đảm sống-qua-reset cho mọi CA add trong ~80% cửa sổ cadence**. Fix 1 dòng: prune đọc `listTrackedCas()` TƯƠI tại thời điểm prune, cùng block sync (không `await` xen giữa → không mở race mới), `newCasFirst` KHÔNG quay lại ở prune, `setup-cache.ts` không đổi semantics. `setupSweep` export làm seam test (theo tiền lệ `refreshSeries`/`pacedFor`). Test mới `server/test/setup-sweep-prune.test.ts` (151 dòng, 1 test): chạy `setupSweep` THẬT + `kickCAs` THẬT, precondition bắt buộc entry đã ghi (`t100_multiple=1.5`, `genesis_bal=120`) ⇒ không thể pass rỗng. RED thật `[setup-cache] pruned 1 entries` + assert sống-sót fail (`actual: undefined`), GREEN sau fix. Verify độc lập: build 0, **177 pass / 0 fail** (176+1), `door-pool.test.ts` md5 `0eb56449b9c28faf4585189afa5c3eeb` nguyên, 4 file frozen mtime nguyên, F2 re-review → **APPROVE**. Evidence: `evidence/2026-09-23-setup-fill-on-add.md` § `## F2 fix — prune dùng tracked set tươi (2026-09-23)`
   - **Difficulty**: LIGHT

## Final Verification Wave (2026-09-23) — PASSED

- [x] **F1 — goal/constraint verification (oracle)** · session `ses_f33630bb5ffeY5jeCTX9pK0XRi` (6m5s): **APPROVE** + 3 observation non-blocking (mid-pass prune race cost≈0; chart-path fetches không feed cache; evidence trích `config.ts:56` trong khi `pollSetupMs` giờ ở dòng khác — cosmetic)
- [x] **F2 — code quality/correctness (oracle)** · session `ses_f3362d964ffeTzP5cR2PrIItjl`: **REJECT** (1 blocking: stale-snapshot prune) → **T7 fix** → re-review cùng session: **APPROVE** (blocker RESOLVED, no new race, no semantic change to `setup-cache.ts`, 177/0 reproduced)
- [x] **F3 — HTTP-level e2e QA** · session `ses_f3362a5a6ffewUgws6p4OqaXnz` (11m55s): **APPROVE** — `server/test/setup-http-e2e.test.ts` chạy HTTP thật `POST /api/tracked-cas`, chứng minh RED khi bỏ trigger (restore byte-exact md5 `6c118e96eda4214f5105d4cf498ade18`), GREEN sau restore; evidence § `## Final Wave F3 — HTTP-level e2e QA`

**Kết luận workstream:** F1 ✅ F2 ✅ F3 ✅ — tất cả APPROVE. Gate build/test cuối: `cd server && npm run build` exit 0 · `cd server && npm test` **177 pass / 0 fail**. Deploy vẫn CHỜ user (250 paused).

**Verification matrix**

| Yêu cầu user | Chứng minh bằng |
|---|---|
| "CA mới thêm CALL 1 lần đủ thông tin" | T3 test #1 + F3 pacing (T4) |
| "cache lại, reset không mất" | T2 test #2 (wipe → rehydrate, 0 fetch) |
| "định kì crawl lại mốc 12h" | T5 test #4 + `pollSetupMs` (`config.ts:56`) |
| "từ giờ mặc định là khoảng thời gian từ deploy hệ thống" | F1 đã chốt (T1) → T3/T5 |

---

## 7. NOT IN SCOPE + deploy note

**NOT IN SCOPE**
- Sibling đã ship session này: `trackedByNames()` (`signals.ts:94`, single source `source='watch'`), evidence `evidence/2026-09-22-trackedby-single-source.md` — **KHÔNG mở lại**.
- `providers/nansen.ts`, FE `src/**`, `docker-compose.yml`, `.env.example`, `docs/**`, `server/test/door-pool.test.ts` — giữ nguyên.
- Không dependency mới; không git; không ssh.

**250 ĐANG PAUSED bởi user** (2026-09-22T17:16–17:19Z, `evidence/2026-09-22-ca-reset-250.md`): `wallet-watch.service` `inactive/dead`, `signal_scan-api-1` `Exited (137)`, `signal_scan-web-1` `Exited (0)`, `signal_scan-chrome-1` `Exited (143)`, `door2500` `Exited (0)`.

**Deploy:** chỉ **resume + deploy khi có lệnh rõ ràng của user** ("resume + deploy only on the user's explicit word"). Task soạn plan này **không ssh và không deploy** — không chạm 250.

---

## Corrections vs brief (line number/số liệu đã sửa)

1. `/api/signals` là `api.ts:256`, không phải `:257`.
2. `seriesFromMs` header `snapshot.ts:147`, công thức ở `:148` — trích cả hai.
3. "`refreshSeries` là writer DUY NHẤT của `genesis_bal`" đúng trong **Nansen mode**; `upsertTokenInfo` (`ingest.ts:66`) cũng ghi `genesis_bal` khi provider trả `info.genesisBal` (`providers/mock.ts:91` có, Nansen không). `t100_multiple`/`anchor_at` chỉ do `updateTokenAnalytics` (`ingest.ts:159`) ghi → kết luận brief vẫn đúng cho prod.
4. `POLL_SETUP_MS` tại `config.ts:56` — khớp. `setupSweep` schedule `poller.ts:552` — khớp. `passThroughAnalytics` `poller.ts:214` — khớp. `kickCAs` `:483` / `kickToken` `:499` / `kickNansen` `:510` — khớp. `nansen_series` `db.ts:167` — khớp. `door-pool.test.ts` **13 tests** — khớp.
5. Bổ sung: `settings` đã có tiền lệ marker migration `lfRule` (`db.ts:228-230`) → cơ sở cho key mới `systemDeployAt` (sub-fork F1b).
6. Giá trị `settings` prod (freshMinPct 15, lfMax 1e8, lfMin 3e7, maxMc 1.5e7, minMc 15000, minUsd 50, t100MinMultiple 1.2, + retired lfMaxPct/lfRule/t100MinPct + allFactors = 11 rows) là **observed từ phiên 2026-09-22**, không trong repo và không re-measure được local (`data/signal_scan.db` không tồn tại) — ghi rõ là observed, không phải file:line.
