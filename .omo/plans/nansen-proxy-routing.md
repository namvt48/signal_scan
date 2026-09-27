---
slug: nansen-proxy-routing
status: approved
intent: clear
review_required: false
approved_at: 2026-09-22
source_draft: .omo/drafts/nansen-proxy-routing.md
delivery_mode: direct (repo KHÔNG phải git repo → không worktree, không PR)
---

# Work Plan: Nansen Door Pool + Proxy Routing

Repo: `/home/namvt/Desktop/dev-space/signal_scan` — **KHÔNG phải git repo, cấm mọi lệnh git.** Node server: `server/` (tsx, node:test, better-sqlite3, puppeteer-core). Test: `cd server && npm test`. Build: `cd server && npm run build`.

## Goal

Thay 1 page browser đơn (đang chết loop 403 → invalidate → 403 mỗi ~4.5s) bằng **door pool N proxy** đọc từ file txt lúc khởi động: tăng throughput theo số IP dedicated, không đốt IP, không mất data (requery khi door hỏng), degrade êm khi hết door. Kèm design doc, bug-fix 429/warmup, cadence guidance.

## Hard constraints (worker MUST)

1. KHÔNG deploy prod, KHÔNG ssh server, KHÔNG sửa `.env` thật. Chỉ sửa file trong repo.
2. Injection point bất biến: `server/src/index.ts` wiring `NansenMarketProvider((url, body) => browserPostJson(url, body), ...)`; chữ ký `browserPostJson(url, body): Promise<{status: number; json: unknown}>` KHÔNG đổi. `poller.ts` / `providers/nansen.ts` / `api.ts` / `snapshot.ts` / FE: KHÔNG sửa.
3. `createCircuitBreaker` vẫn export từ `crawl.ts`; `server/test/crawl-breaker.test.ts` phải tiếp tục pass (grep consumers trước khi bỏ dùng nội bộ).
4. Không dependency mới (stdlib + puppeteer-core + express hiện có).
5. Không hot reload proxy file — đọc 1 lần lúc khởi động; đổi file = `make restart`.
6. Không secret vào repo: `proxies.txt` nằm `./data/` (bind mount sẵn); `.env.example` chỉ ghi tên biến + format, không giá trị thật.
7. Requery tối đa 1 lần/request — không loop, không retry vô hạn.
8. TDD: test RED trước, implement GREEN sau (rule cf--testing của repo).
9. Cấm lệnh git (không phải git repo).

## Non-goals

Official Nansen API; FE/web; deploy prod; rotate `NANSEN_API_KEY` (chỉ cảnh báo trong design doc); refactor poller/nansen/api/snapshot ngoài injection point; SOCKS5 **có auth** (Chrome không hỗ trợ auth cho SOCKS5). socks5/socks4 **không cred vẫn dùng được** qua `--proxy-server` — đo được 10/10 proxy ổn định nhất là socks5/socks4 (xem `## Cập nhật đo lường 2026-09-22`).

## Design decisions (D1–D12, đã duyệt)

- **D1 Door** = 1 WS connection tới browserless (`CRAWL_WS_ENDPOINT`, default `ws://chrome:3000`) + `--proxy-server=<proxy>` qua query string + `page.authenticate({username,password})` khi proxy có cred. browserless v1 spawn 1 browser/connection → N doors trong 1 container, mỗi door cookie jar + cf_clearance + egress IP riêng. Đã chứng minh: `.probe/multi-proxy-probe.mjs`, `.probe/challenge-probe.mjs`.
- **D2 Proxy file**: `CRAWL_PROXY_FILE` (default `''`). Format mỗi dòng `scheme://[user:pass@]host:port`, scheme ∈ `http|socks4|socks5` (creds chỉ áp dụng được cho `http`; socks4/socks5 phải **không cred** — Chrome không auth SOCKS5); bỏ qua dòng trống/`#`; dòng không parse được → log warn + bỏ (không crash). **N ứng viên → doors = số door warmup-ok**, KHÔNG phải `N dòng = N doors` (xem `## Cập nhật đo lường 2026-09-22`). File thiếu/rỗng → fallback single-door từ `CRAWL_WS_ENDPOINT` (proxy=null) = hành vi hiện tại + bug-fix.
- **D3 State machine per door**: `cold → warming → probation → healthy → throttled → penalized → retired`.
  - `warming`: connect WS → new page → goto `https://app.nansen.ai/token-god-mode` → poll mỗi 2.5s (title hết "Just a moment" + cookie `cf_clearance` tồn tại), timeout `CRAWL_WARMUP_TIMEOUT_MS`=30s; fetch egress IP (`https://api.ipify.org`) 1 lần, log informational. OK → `probation`. Connect/auth/warmup fail → `retired` (`broken-proxy`).
  - `probation`: phục vụ request; 200 đầu → `healthy`. 403-real trong probation → `penalized` ngay (bắt reputation drift).
  - `throttled` (429): quarantine tới `now + retryAfter*1000 + jitter(0..30s)`; thiếu header → default 1800s. Hết → `probation`.
  - `penalized` (403-real): backoff lũy tiến 2m → 10m → 30m → `retired`. Hết → `warming` (page mới).
  - `retired`: loại vĩnh viễn tới restart; log reason.
- **D4 Classifier** (từ in-page fetch trả `{status, contentType, retryAfter, bodyHead, bodyLen, json}`):
  200+json → OK; 429 → THROTTLE (Error 1015 ~975B); 403 + html/bodyHead bắt đầu `<` → INTERSTITIAL ("Just a moment" ~6.4KB); 403 + json → REAL403; ≥500 → 5XX; throw/timeout(45s)/json fail → TRANSPORT.
- **D5 Hành động**: OK → health + reset transport-fail. THROTTLE → `throttled` + requery 1 lần door khác (429 penalty per-IP, không cross-IP). INTERSTITIAL khi đang chạy → invalidate + re-warm; requery 1 lần. REAL403 → invalidate + re-warm 1 lần; lặp lại → `penalized`; requery 1 lần. 5XX → requery 1 lần + đếm transport-fail (không quarantine). TRANSPORT → transport-fail++ ; ≥2 liên tiếp → `retired`; requery 1 lần. Requery fail → trả `{status: <gốc|502>, json: null}` (provider throw như hiện tại, poller log + đi tiếp). Không data ảo.
- **D6 Budget**: per-(door,path) sliding window: prune timestamp ngoài `CRAWL_BUDGET_WINDOW_MS`=60s, eligible khi `count < CRAWL_PATH_BUDGET`=30; cap tổng per-door `< CRAWL_DOOR_CAP_PER_MIN`=40 (sát trần page đo được 43/min). Path = đoạn cuối URL: `tgm-essential-data`, `tgm-volume-details`, `tgm-holders-gini-stats`, `tgm-holders-change`, `tgm-holders-hourly-stats`, `wp4t-transactions`.
- **D7 Router**: eligible = state `healthy|probation` + còn budget path + còn cap. Chọn least-outstanding, tie → least-recently-used. Không eligible nhưng còn door sống → chờ slot sớm nhất (tính từ budget/quarantine), poll 250ms, cap 65s; quá cap → `{status:503, json:null}` + log `[pool] no door budget for <path> — skip`. Không door sống → 503 ngay.
- **D8 Boot**: `pool.start()` warmup song song mọi door, non-blocking (index.ts không sửa, không await). Startup log `loaded N candidates → N-k doors (k retired at warmup)` + per-door kết quả.
- **D9 Sizing**: `doors = max( ceil(total_demand/door_cap), max_path ceil(path_demand/path_budget) )`, khuyến nghị +1 dự phòng. Cadence repair (~32/min, wp4t 11.8/min) → 1 door (khuyến nghị 2–3). Cadence prod (~190/min, wp4t 70/min) → max(5,3)=5 → 6 doors, RAM ≈ 1g+0.7g×6 ≈ 5.2g.
- **D10 Observability**: log `[door <id>] <event> path=<p> status=<s> budget=<used>/<cap> outstanding=<n> state=<st>`; events: `warmup-ok, warmup-fail, retired, throttled, re-warm, requery, skip, egress`. Không endpoint mới.
- **D11 Test seam**: export `DoorPool` với deps inject `{connect, now, sleep}` (fake transport + fake clock). `browserPostJson` = wrapper lazy singleton pool từ config. Giữ `createCircuitBreaker`.
- **D12 Cadence repair (Q2 default đã duyệt)**: khuyến nghị vào `.env.example` + design doc: `POLL_WALLETS_MS=5400000`, `POLL_HOT_MS=1800000`, `POLL_COLD_MS=7200000` (~32 req/min). KHÔNG đổi default trong `config.ts` (prod .env manual trên server — runbook trong design doc).

## TODOs

- [x] 1. [T1] Config surface (`server/src/config.ts`, `server/.env.example`)
  Thêm: `CRAWL_PROXY_FILE=''`, `CRAWL_PATH_BUDGET=30`, `CRAWL_BUDGET_WINDOW_MS=60000`, `CRAWL_DOOR_CAP_PER_MIN=40`, `CRAWL_WARMUP_TIMEOUT_MS=30000`, `CRAWL_REQUEST_TIMEOUT_MS=45000`, `CRAWL_QUARANTINE_JITTER_MS=30000`. Env → config có validate (số > 0, fallback default khi thiếu/NaN). `.env.example`: section "Door pool / proxy routing" (tên biến, default, format proxy line, ghi chú `./data/proxies.txt` bind mount + không commit, ghi chú cadence repair D12, cảnh báo rotate `NANSEN_API_KEY`).
  - **Acceptance Criteria**
    - [ ] `cd server && npm run build` → exit 0
    - [ ] Thiếu env → default đúng từng biến; env rác (`abc`, `-1`, `0`) → fallback default (không NaN, không crash)
    - [ ] `.env.example` không chứa secret thật; có đủ 7 biến + ghi chú
  - **Evidence**: build log + dump config parse (tsx one-off, không commit) → ghi vào evidence file T7
  - **Difficulty**: LIGHT

- [x] 2. [T2] Unit tests RED (`server/test/door-pool.test.ts`, node:test + assert/strict, mẫu `crawl-breaker.test.ts`)
  8 nhóm: (1) `parseProxyFile`: comment/blank/valid/không-parse → list + count đúng; (2) classifier fixtures từ evidence: 429→THROTTLE, 403+html ~6472B→INTERSTITIAL, 403+json→REAL403, 500→5XX, 200→OK; (3) budget: 30 req path A → request 31 phải chờ/skip, path B vẫn eligible, cap tổng 40 → mọi path hết eligible; (4) router: least-outstanding, loại throttled, hết door → `{status:503,json:null}` không throw; (5) requery: door1 transport-fail → request chạy door2 đúng 1 lần; door1 fail 2 lần liên tiếp → retired `broken-proxy`; requery cũng fail → trả status gốc/502, tổng attempt ≤2; (6) 429 → quarantine đúng `retryAfter+jitter` (fake clock), hết hạn → probation → 200 → healthy; (7) 403-real → re-warm 1 lần; lặp → penalized backoff 2m (fake clock) → warming → probation; (8) fallback: không proxy file → 1 door, WS không query proxy, vẫn đủ classifier + quarantine 429.
  - **Acceptance Criteria**
    - [ ] `cd server && npm test` chạy tới `test/door-pool.test.ts` và **FAIL** (RED thật: thiếu export `parseProxyFile`/`classify`/`DoorPool`), không phải lỗi cú pháp file test
    - [ ] Mọi test dùng fake clock + fake transport (không sleep thật, không mạng, không chrome)
    - [ ] File test cũ không bị sửa
  - **Evidence**: log RED (test name + failure reason) → evidence T7
  - **Difficulty**: MEDIUM

- [x] 3. [T3] Door pool implementation (`server/src/crawl.ts`, giữ export công khai)
  Implement D1–D11. Cấu trúc đề xuất (được lệch nếu giữ nguyên semantics + test pass): `parseProxyFile(text): string[]` (export), `classify(res): 'ok'|'throttle'|'interstitial'|'real403'|'5xx'|'transport'` (export), `class DoorPool { constructor(deps:{connect,now,sleep,config}); start(); postJson(url,body); stats() }` (export), `browserPostJson` = lazy singleton delegate, `createCircuitBreaker` giữ nguyên. In-page fetch trả thêm `contentType/retryAfter/head/len`. WS endpoint per door: `${base}?${new URLSearchParams({'--proxy-server': proxy})}`; proxy có cred → `page.authenticate`. Wait-loop D7. Log D10 mọi transition. Bug-fix bắt buộc: bỏ nhánh `status !== 403` passthrough; 429 đọc retry-after; breaker không còn rebuild loop.
  - **Baseline characterization**: `server/test/crawl-breaker.test.ts` + toàn bộ suite hiện tại phải GREEN **trước** khi sửa (chạy `npm test` ghi log baseline); `browserPostJson` giữ chữ ký `{status,json}`.
  - **Acceptance Criteria**
    - [ ] `cd server && npm run build` → exit 0
    - [ ] `cd server && npm test` → TẤT CẢ pass (suite cũ + `door-pool.test.ts` GREEN)
    - [ ] `server/src/index.ts`, `poller.ts`, `providers/nansen.ts`, `api.ts`, `snapshot.ts`, FE: diff = rỗng
    - [ ] Không `sleep 4000` cứng trong warmup; không nhánh bỏ qua 429
  - **Manual-QA**: `node .probe/door-pool-smoke.mjs --doors 2 --broken 1` (harness từ T6) chạy trên chrome container local nếu docker có → observable: `[door 0] warmup-ok` + egress IP, `[door 1] retired reason=broken-proxy`, N request mixed path được phục vụ door 0, KHÔNG có 403-loop log. Nếu docker không có: chạy biến thể fake-transport (`--simulate`) và ghi rõ là simulated.
  - **Evidence**: build log, test log, baseline log, smoke output, diff list file đã sửa
  - **Difficulty**: HEAVY

- [x] 4. [T4] Design doc (`docs/proxy-routing-design.md`)
  Sections: Bối cảnh + sự cố prod (loop 403 ~4.5s, 5844×429, chrome 2.3/3GB) / Bằng chứng đo (IP là khóa; trip ~45 req cùng path @8/s; 471 req/60s trộn path không trip; retry-after 2204–2797s; shared-pool drift 1/6→6/6; dedicated 4/4×200; trần 43 req/min/page) — dẫn đường dẫn evidence / Kiến trúc (sơ đồ ASCII, state machine D3, error matrix D4–D5, budget D6, router D7) / Proxy file + restart semantics / Sizing D9 (công thức + 2 bảng kịch bản + RAM table `1g+0.7g×N`) / Cost (VPS ~$5/mo/IP vs dedicated proxy; khuyến nghị dedicated static; cảnh báo shared pool) / Cadence repair runbook D12 (prod .env manual + `make restart`) / Cảnh báo rotate `NANSEN_API_KEY` / Open questions (RAM trống server prod).
  - **Acceptance Criteria**
    - [ ] File tồn tại, đủ sections, số liệu khớp evidence (có dẫn path evidence)
    - [ ] Có công thức `doors = max(...)` + bảng ví dụ 32/min và 190/min
    - [ ] Không chứa secret/credential thật
  - **Evidence**: file path + `wc -l` + grep xác nhận đủ section
  - **Difficulty**: LIGHT

- [x] 5. [T5] Compose + infra notes (`docker-compose.yml`)
  Chỉ comment + mem_limit: comment công thức `1g + 0.7g×N` (N = số connection vào cùng container `chrome`), ghi chú `./data/proxies.txt` qua bind mount sẵn có. KHÔNG đổi image/port/mount/network. Giá trị `mem_limit` giữ 3g + comment "tăng khi N>2".
  - **Acceptance Criteria**
    - [ ] YAML parse được (`node -e "require('js-yaml')" ` không có → dùng `docker compose config` nếu docker có, else parse bằng script node tối thiểu/ `python3 -c yaml.safe_load`) → không lỗi
    - [ ] Diff chỉ là comment + mem_limit; service/ports/mounts không đổi
  - **Evidence**: diff + kết quả parse
  - **Difficulty**: LIGHT

- [x] 6. [T6] Smoke/probe harness (`.probe/door-pool-smoke.mjs` (+ tuỳ chọn `.probe/door-pool-load.mjs`))
  Script node (puppeteer-core) đọc `PROXY_FILE` env: (a) `--doors N --broken M`: warmup N doors song song, cố tình thêm M proxy hỏng → in bảng `door id / egress IP / clearedAt / state / retire reason`; (b) `--simulate`: chạy biến thể fake-transport không cần chrome (dùng được khi docker không có); (c) `--load --minutes M --rate R`: workload mix 6 path → in per-door req, 200/403/429, req/min, so sánh N doors vs 1 door. Header file ghi rõ usage. Đầu script detect docker availability và in fallback hint.
  - **Acceptance Criteria**
    - [ ] `node --check .probe/door-pool-smoke.mjs` → exit 0
    - [ ] Chạy `--simulate` (không cần chrome/proxy) → in bảng door + exit 0
    - [ ] Có usage header + không hardcode credential
  - **Evidence**: output `--simulate` + `node --check` log
  - **Difficulty**: MEDIUM

- [x] 7. [T7] Evidence + verification (`evidence/<YYYY-MM-DD>-door-pool-plan-execution.md`)
  Tổng hợp: build log, `npm test` full log, RED→GREEN của T2→T3, kết quả smoke `--simulate` (+ real chrome nếu có), danh sách file sửa, ghi chú live probe với proxy thật **CHỜ owner chạy** (không block), open questions. Kết thúc bằng `EVIDENCE_RECORDED: <path>`.
  - **Acceptance Criteria**
    - [ ] File tồn tại, đủ mục, log dán thật (không mô tả suông)
    - [ ] Có dòng `EVIDENCE_RECORDED:`
  - **Evidence**: chính là file trên
  - **Difficulty**: LIGHT

## Final Verification Wave

- [x] F1. Oracle: goal/constraint verification. Đọc plan + `git`-free diff (list file sửa) + crawl.ts/config.ts/.env.example/docker-compose.yml/docs. Verdict: plan Goal đạt chưa; 9 hard constraints có bị vi phạm không (đặc biệt #2 injection point + file cấm sửa, #4 dependency mới, #6 secret trong repo, #9 git). Output: APPROVE/REJECT + lý do + file:line.
- [x] F2. Oracle: code quality + logic. Review `crawl.ts` door pool: state machine đúng D3, classifier đúng D4, budget math đúng D6 (sliding window, prune, cap), router/requery đúng D5/D7 (requery ≤1, không loop, không mất data), race conditions (concurrent postJson lên cùng door, outstanding counter), single-door fallback tương đương hành vi cũ + bug-fix. Output: APPROVE/REJECT + file:line.
- [x] F3. Security review. Proxy credential handling (không log password, không vào URL log; URLSearchParams encode; `page.authenticate` đúng), không secret trong repo/docs, log không lộ proxy cred, `.env.example` an toàn, không command injection qua tên file/URL config. Output: APPROVE/REJECT + file:line.
- [x] F4. Hands-on QA. Chạy thật: `cd server && npm run build && npm test` (root-independent re-run), `node .probe/door-pool-smoke.mjs --simulate`, và nếu docker khả dụng thì chạy smoke thật với chrome container + 1 proxy hợp lệ + 1 proxy hỏng, đồng thời kill 1 door giữa lượt để quan sát requery/rebalance. Adversarial classes: hung/long commands (timeout), flaky tests (chạy test 3 lần), misleading success output (đối chiếu log với hành vi thật), stale state (budget window qua fake clock), dirty worktree (không phải git → kiểm tra file rác do QA tạo và dọn). Output: APPROVE/REJECT + artifact path + cleanup receipt.

> **Wave status: CLOSED - user signed off 2026-09-22; all four gates are `[x]`.** Ledger entries F1-F4 appended to `.omo/start-work/ledger.jsonl`; rows flipped `[~]` -> `[x]` after sign-off.
> - F1 APPROVE (oracle): goal + 10/10 hard constraints traceable, MUST FIX: none.
> - F2 APPROVE (oracle, 3rd pass): R1 (rewarm double-invalidate page leak) + R2 (65s cap-burn) provably closed; mask/decode fixes correct; no false-503, hard 65s bound.
> - F3 APPROVE (substitute reviewer; canonical `security-reviewer` agent crashed 2× on a provider error): S1 mask + S2 decode verified adversarially; inert `.gitignore` rule caught and fixed; no credential reachable through the artifact.
> - F4 APPROVE (hands-on): build 0 · frozen spec 13/13 ×3 · 155/155 · `--simulate` exit 0 · real chrome ran (3 doors, requery ≤1/request, cleanup 3 doors).
> - **Owner actions (not blockers):** rotate `NANSEN_API_KEY` (cleartext in pre-existing `.probe/EVIDENCE-2026-09-17-clean-untracked-cas.md:68` and `.probe/EVIDENCE-2026-09-17-inflow-holding-4ca.md:145`); the 3 free proxies in `data/proxies.txt` are Cloudflare-403 → real crawling needs live paid proxies + restart.

## Verification matrix

| Requirement (user) | Chứng minh bằng |
|---|---|
| Sticky IP, warmup trước API | T3 D1/D3 + test warmup; F4 egress IP per door (nếu chrome) |
| 403 interstitial vs real | T2 test #2 (fixture ~6472B "Just a moment" vs json) |
| 429 retry-after quarantine, không rebuild loop | T2 test #6 + T3 D5 (429 không invalidate page) |
| Budget 30/path/IP | T2 test #3 |
| Door hỏng → rebalance + requery, không mất data | T2 test #5 |
| Hết door → degrade êm | T2 test #4 (503 marker, không throw) |
| Proxy list file, đếm lúc boot, đổi file = restart | T1 D2 + T2 test #1 + T4 doc; code không có watcher |
| Backward compat CRAWL_WS_ENDPOINT | T2 test #8 + T3 fallback |
| Không dep mới, không FE/prod/git | F1 constraint review |

## Open questions (owner, không block worker)

- OQ1: RAM trống server prod → chặn N tối đa (D9 formula, owner tính khi chốt số proxy).
- OQ2: cadence — đã adopt repair (D12); nếu giữ cadence prod cần ≥6 dedicated IP.
- Owner action ngoài scope: rotate `NANSEN_API_KEY` (đã lộ); chuẩn bị `./data/proxies.txt` trên server trước `make restart`.

---

## Cập nhật đo lường 2026-09-22 (proxy thật, không phải giả định)

Quét 2006 proxy free qua browserless Chrome (challenge + `POST /api/questions/tgm-holders-gini-stats` == 200), rồi đo lại 103 con sống **4 vòng trong ~1.5h**. Chi tiết: `evidence/2026-09-22-nansen-proxy-scan.md`.

**Hao hụt (đây là lý do D2/D8/D9 phải tính lại):**

| vòng | TCP mở | forward HTTPS | Nansen OK |
|---|---|---|---|
| 1 (2006 con) | 998 | 331 | 103 |
| 2 | 69 | 53 | 35 |
| 3 | 76 | 57 | 35 |
| 4 | 65 | 46 | 28 |

Phân bố số lần OK / 4 vòng trên 103 con: **4/4 = 11 · 3/4 = 20 · ≤2/4 = 72**.

**Hệ quả sizing (thay công thức cũ):**

- Chỉ **~11%** proxy free sống đủ 4/4 vòng ⇒ nạp **8–10× số door cần**, không phải 1×. Muốn 5 door ổn định → nạp ~50 ứng viên, chấp nhận ~45 con retire lúc warmup.
- Đây là lý do **D8 `loaded N candidates → N-k doors`** và **D9 sizing** phải có tham số hao hụt, không được giả định `N dòng = N doors`.
- Pool chết theo giờ (66% mất sau ~10–60 phút ở lần đo 2) ⇒ decision "đổi file = `make restart`" đồng nghĩa phải restart định kỳ, không phải restart khi đổi list.

**Bộ lọc lúc nạp (thêm vào `parseProxyFile`/load):**

- **Loại proxy có egress IP xoay giữa các vòng** (đo được 2/103: `socks4://171.234.162.101:1083`, `:1084`). Door cần egress cố định, egress đổi = mất định danh IP.
- **Giữ** proxy có egress ≠ IP vào nhưng **egress ổn định** (gateway/NAT) — nhóm này chết nhanh hơn (19% vs 51% sống) nhưng con nào đã sống là dùng được — nhưng thực tế chỉ **2/10** door tier-A có dạng này, 8/10 còn lại egress = entry.

**Danh sách dùng được (đã đo 4 vòng):**

- `data/proxies-stable.txt` — 10 con 4/4 vòng + egress không đổi (**tier A**, dùng làm door).
- `data/proxies.txt` — 29 con tier A + tier B (3/4 vòng), sắp tier.
- Regenerate: `cd .probe && LIST=<file> node proxy-scan.mjs` (env `WS`, `OUT`, `WORKING`, `BC`).

**Cảnh báo:** đây vẫn là proxy free, KHÔNG dùng cho prod. Muốn N door ổn định thật phải dùng endpoint trả phí có sticky session (egress cố định, có auth) — khớp giả định C1 "1 door = 1 egress ổn định".
