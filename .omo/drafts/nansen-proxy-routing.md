---
slug: nansen-proxy-routing
status: approved
intent: clear
review_required: false
pending-action: none — plan written at .omo/plans/nansen-proxy-routing.md (approved 2026-09-22)
approach: proxy list trong file txt (đọc lúc khởi động, doors = số proxy warmup-ok, KHÔNG phải N dòng = N doors); door = 1 WS connection browserless + --proxy-server + page.authenticate; pool nằm sau injection point (url, body) hiện tại; per-(door,path) budget 30/60s; broken proxy lúc query → retire door + rebalance + requery 1 lần door khác; đổi file proxy → restart hệ thống (không hot reload)
---

# Draft: nansen-proxy-routing

## Components (topology ledger)

| id | outcome (one line) | status | evidence path |
|---|---|---|---|
| C1 door-pool | Khởi động: đọc file txt proxy → N doors = N proxy; mỗi door = 1 WS connection + proxy riêng + cookie jar riêng; state machine cold→warming→probation→healthy→throttled→penalized→retired | active | evidence/2026-09-21-ip-vs-fingerprint.md; .probe/multi-proxy-probe.mjs; .probe/challenge-probe.mjs |
| C2 router | Chọn door least-outstanding còn budget path; door hỏng giữa query → retire + rebalance + **requery 1 lần** door healthy khác (không mất data); hết door → skip+log degrade êm | active | server/src/poller.ts (pacedFor giữ nguyên) |
| C3 classifier | 200 / 403-interstitial (title "Just a moment", ~6.4KB) / 403-real / 429 (Error 1015, ~975B, retry-after) / 5xx / transport — mỗi loại 1 hành động | active | evidence/2026-09-21-ip-vs-fingerprint.md |
| C4 config | `CRAWL_PROXY_FILE` (đường dẫn txt), budget/window env-tunable; không có file/`CRAWL_DOORS` → fallback 1 door từ `CRAWL_WS_ENDPOINT` (backward compat + bug-fix 429/warmup) | active | server/src/config.ts; server/.env.example |
| C5 infra | Chrome container giữ nguyên image; N doors trong 1 container (browserless v1 = 1 browser/connection); mem_limit ≈ 1g + 0.7g×N | active | docker-compose.yml; Makefile |
| C6 obs+tests | Log structured `[door id path status budget state]`; unit test node:test + fake transport (mẫu crawl-breaker.test.ts); probe script live khi có IP thật | active | server/test/crawl-breaker.test.ts; server/package.json |

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| Door placement | N doors = N WS connections vào chrome container hiện tại, `--proxy-server` qua query string + `page.authenticate()` | Probe chứng minh chạy (egress = IP proxy, challenge qua, cf_clearance per-connection) | yes — door spec có trường `ws` |
| Budget window | 30 req/path/60s | Trip đo được ~45 cùng path @8/s; 471/60s trộn path không trip | yes — env |
| Q2 cadence | **Repair theo evidence** (POLL_WALLETS_MS=5400000, POLL_HOT_MS=1800000, POLL_COLD_MS=7200000 → ~32 req/min) — user chưa chốt, veto được tại gate | Demand hiện tại ~190/min vượt budget path kể cả nhiều door | yes — env |
| Proxy file format | Mỗi dòng 1 proxy `scheme://[user:pass@]host:port`, scheme ∈ `http|socks4|socks5`; creds chỉ cho `http`; socks4/socks5 không cred **vẫn dùng được**; `#` comment + dòng trống bỏ qua | Đo 2026-09-22: 10/10 proxy ổn định nhất là socks5/socks4 (evidence/2026-09-22-nansen-proxy-scan.md) | yes |
| Đổi list = restart | Không hot reload, không file watcher — user yêu cầu restart | Đơn giản nhất, đúng ý user | n/a |
| State | In-memory single process | Hệ là 1 Node process + SQLite | yes |
| Observability | Logs only, không thêm endpoint | Không sửa FE/web (non-goal) | yes |

## Findings (cited - path:lines)

- server/src/crawl.ts:145 — nhánh sai `if (out.status !== 403 || attempt === 2) return out;` → 429 passthrough, không đọc retry-after.
- server/src/crawl.ts — breaker chỉ đếm lỗi thrown, không đếm 403/429 response → vòng chết 403→invalidatePage→403 mỗi ~4.5s, chrome 2.3/3GB RAM.
- server/src/crawl.ts — warmup sleep cứng 4s là race; challenge cần poll title/cookie tới 20s (challenge-probe: 8×2.5s + verify cf_clearance).
- server/src/index.ts — injection point duy nhất `NansenMarketProvider((url, body) => browserPostJson(url, body))` → pool thay sau signature, poller/nansen/api không đổi.
- server/src/providers/nansen.ts — 6 active paths: tgm-essential-data(1/CA), tgm-volume-details(2/CA), tgm-holders-gini-stats(1/CA), tgm-holders-change(kick only), tgm-holders-hourly-stats(1–7/CA: series + LF walk ≤6, snapshot.ts LF_WINDOWS), wp4t-transactions(1/wallet×CA).
- evidence/ip-vs-fingerprint — IP là khóa (cùng JA3: A 429/C 200); shared pool trôi 1/6→6/6 403; dedicated 4/4×200; egress ổn định; browserless v1 proxy query-string + page.authenticate OK; penalty 429 lan per-IP không lan cross-IP.
- evidence/vol-1h — trần 1 page ~43 req/min; prod demand ~190/min; 429: wp4t 5311, gini 442, volume 91; cadence repair → ~32/min; NANSEN_API_KEY lộ git → rotate (ops, ngoài scope).
- .probe-p8-raw.json — rate=8/s cùng path: 429 đầu at=5.6s ≈ req thứ 45; retry-after 2204–2797s.
- Makefile — deploy ssh 194.163.187.250 + compose build/up; `.env` không copy tự động; `./data` bind mount → proxy file đặt `./data/proxies.txt` được mount sẵn, không commit (secret).
- server/test/crawl-breaker.test.ts + package.json — `tsx --test test/*.test.ts`, node:test; createCircuitBreaker đã export có test.

## Decisions (with rationale)

1. Door = 1 WS connection (1 browser trong browserless v1) + proxy riêng — cf_clearance/cookie/egress gắn per-connection; probe chứng minh.
2. Pool sau signature `(url, body) => Promise<{status, json}>` — diff nhỏ nhất.
3. Budget per-(door,path) 30/60s + cap per-door ~40/min (sát trần page 43/min).
4. 429 → quarantine door đúng retry-after+jitter, không rebuild; **requery request đó 1 lần trên door healthy khác** (penalty không lan cross-IP — probe chứng minh).
5. 403-interstitial → door còn warming, tiếp tục poll; 403-real sau warmup → invalidate+re-warm 1 lần, fail nữa → penalized backoff lũy tiến (2m/10m/30m) → retired.
6. **Broken proxy detection** (yêu cầu mới): (a) lúc warmup — connect fail/proxy auth fail/egress check fail → retire ngay, log, pool chạy với N−1; (b) giữa query — lỗi transport (không phải HTTP status) đếm consecutive per door, ≥2 liên tiếp → retire + rebalance; request đang chạy → requery 1 lần door khác.
7. Requery tối đa 1 lần/request (chống loop); requery cũng fail → trả skip marker, poller log, đi tiếp — không mất nhịp sweep, không data ảo.
8. Warmup thay sleep 4s bằng poll loop challenge-probe (title + cf_clearance, timeout ~30s) + egress IP check 1 lần (api.ipify) để phát hiện proxy chết sớm.
9. Proxy file đọc 1 lần lúc khởi động; đổi file → `make restart` (user chốt); startup log rõ `loaded N proxies → N doors` + door nào retire lúc warmup.
10. Sizing: `doors_needed = Σ_path ceil(demand_path/30)`; file nên có ≥ doors_needed + 1 dự phòng; RAM check `N ≤ (mem_available − 1GB)/0.7GB` — công thức + bảng ví dụ nằm trong design doc.
11. Backward compat: không `CRAWL_PROXY_FILE` → 1 door từ `CRAWL_WS_ENDPOINT`, hành vi hiện tại + bug-fix (429/warmup áp dụng cả single-door).
12. Hết door healthy → degrade êm: skip + log, không queue vô hạn, không throw.

## Scope IN

- Design doc `docs/proxy-routing-design.md`: kiến trúc, state machine, router/budget, error matrix + requery, proxy file format, sizing formula + cost, RAM table.
- Plan diff (CHƯA apply): server/src/crawl.ts (door pool), server/src/config.ts, server/.env.example, docker-compose.yml (mem_limit theo N), server/test/ (unit tests mới).
- Test plan: unit (fake transport/fake clock, node:test) + live probe script khi có IP thật.
- Open questions + khuyến nghị.

## Scope OUT (Must NOT have)

- Không sửa code thật (plan-only tới khi duyệt + worker session chạy).
- Không đụng FE/web, không deploy prod.
- Không official Nansen API, không dependency mới.
- Không hot reload proxy file (restart semantics).
- Không rotate NANSEN_API_KEY trong scope (chỉ cảnh báo).
- Không refactor poller/nansen/api ngoài injection point.

## Open questions

- Q1 ✅ ANSWERED: proxy list = file txt, doors = số dòng warmup-ok (hao hụt ~89% sau 4 vòng đo), đọc lúc khởi động; hỏng giữa query → retire+rebalance+requery; đổi file → restart.
- Q2 ⚠️ default adopted (veto tại gate): cadence repair (~32 req/min) thay vì giữ demand ~190/min.
- OQ1 (ops): RAM server 194.163.187.250 còn trống bao nhiêu → chặn N doors tối đa? Design doc để công thức, worker không cần biết trước.
- A1 (veto-able): doors trong chrome container hiện tại, không browserless remote.
- A2 (veto-able): budget window 60s.

## Approval gate
status: awaiting-approval
<!-- User OK → write .omo/plans/nansen-proxy-routing.md (decision-complete, worker không phải hỏi thêm) -->

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
