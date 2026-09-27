# Learnings — nansen-proxy-routing

Repo conventions + hard-won facts. APPEND ONLY, never overwrite.

## Repo / toolchain
- Repo: `/home/namvt/Desktop/dev-space/signal_scan`. **KHÔNG phải git repo** → cấm mọi lệnh git (kể cả `git status`, `git diff`). Dùng `diff`/`ls`/mtime để chứng minh file không đổi.
- Server: `server/` — TypeScript ESM ("type": "module"), tsx, node:test.
  - Build: `cd server && npm run build` (= tsc)
  - Test: `cd server && npm test` (= `tsx --test test/*.test.ts`)
  - Test style: `import { test } from 'node:test'` + `import assert from 'node:assert/strict'` (xem `server/test/crawl-breaker.test.ts`)
- Deps hiện có (KHÔNG thêm mới): better-sqlite3, express, puppeteer-core, tsx, typescript.
- Node local: v25.8.1. Docker local: 29.8.0 (có → smoke với chrome container thật khả thi).

## `server/src/crawl.ts` exports (baseline, không được phá)
- `createCircuitBreaker(failureLimit, cooldownMs)` — có test riêng.
- `browserPostJson<T = unknown>(url, body): Promise<{status: number; json: T | null}>` — consumer: `server/src/index.ts`.
- `hourlyStatsToPoints(rows)` — consumer: `server/test/nansen.test.ts`.
- `nansenSeries(...)`, `balanceSeries(...)` — consumer: `server/src/poller.ts`.
- `api.ts:30` chỉ còn comment import `balanceSeries`.

## Deploy / ops (không đụng trong plan này)
- `Makefile`: deploy = ssh `194.163.187.250` + `docker compose build/up`; `.env` KHÔNG copy tự động (manual trên server) → config mới phải qua `.env.example` + runbook.
- `docker-compose.yml`: service `chrome` = `browserless/chrome:1.61-chrome-stable`, `CONNECTION_TIMEOUT: 1800000`, `mem_limit: 3g`, `shm_size: 1g`. `./data` bind mount sẵn → proxy file đặt ở đó.
- Evidence plan này: `evidence/<YYYY-MM-DD>-door-pool-plan-execution.md` (T7) + ledger `.omo/start-work/ledger.jsonl`.
- T5: chrome `mem_limit` sized for door pool only via comment (`mem_limit ≈ 1g + 0.7g × N`, N = CRAWL_PROXY_FILE lines = concurrent browsers in the single chrome container since browserless v1 = 1 browser/WS). 3g ⇒ N ≤ 2. `./data` bind mount hosts non-committed `proxies.txt` (creds); editing it needs a restart. No functional config changed; YAML verified with python3 yaml.safe_load.

## T1 config surface (2026-09-22)
- Shape: **flat** in the `config` object (crawl settings are NOT grouped) — new fields sit right after `crawlBreakerCooldownMs`, same `crawl*` prefix convention. Consumer builds `DoorPoolConfig.proxies` by parsing `config.crawlProxyFile` itself; T3 must map fields by name (no nested object).
- Final field names + defaults (all in `server/src/config.ts` `config`):
  - `crawlProxyFile: str('CRAWL_PROXY_FILE', '')`
  - `crawlPathBudget: posNum('CRAWL_PATH_BUDGET', 30)`
  - `crawlBudgetWindowMs: posNum('CRAWL_BUDGET_WINDOW_MS', 60_000)`
  - `crawlDoorCapPerMin: posNum('CRAWL_DOOR_CAP_PER_MIN', 40)`
  - `crawlWarmupTimeoutMs: posNum('CRAWL_WARMUP_TIMEOUT_MS', 30_000)`
  - `crawlRequestTimeoutMs: posNum('CRAWL_REQUEST_TIMEOUT_MS', 45_000)`
  - `crawlQuarantineJitterMs: posNum('CRAWL_QUARANTINE_JITTER_MS', 30_000)`
- New helper `posNum(name, def)`: fallback default on missing/blank/NaN/≤0, never throws. **Do NOT reuse `num()` for these** — `num()` THROWS on non-finite and passes through ≤0, which would crash import on a bad env. `crawlEnabled` reads `NANSEN_CRAWL` (still distinct from `MODE`).
- T3 (crawl.ts) reads `config.crawl*` — no config.ts change needed later unless the shape moves.

## T4 design doc (2026-09-22)
- `docs/proxy-routing-design.md` (246 dòng, 9 section `## `) — thiết kế door pool D1-D12, mọi số liệu dẫn `evidence/2026-09-21-ip-vs-fingerprint.md`, `evidence/2026-09-21-vol-1h-column.md`, `server/src/config.ts:56`, hoặc `plan §Dx`.
- Hai số 45 req cùng path @8/s và 471 req/60s trộn path chỉ có nguồn ở plan §T4 (probe gốc `.probe/p43-probe*.mjs`); không có sẵn trong 2 evidence file trên.
- Sizing dùng `door_cap=40`, `path_budget=30`: repair → 1 door (khuyến nghị 2-3), prod → max(5,3)=5 (+1 = 6 doors), RAM `1g+0.7g×N`.
- Doc KHÔNG chứa credential; `NANSEN_API_KEY` chỉ nhắc tên (1 lần). Đã strip toàn bộ em/en dash và footer `EVIDENCE_RECORDED` khỏi doc.

## T2 (door-pool.test.ts) — contract dùng + fake clock
- Dùng NGUYÊN VĂN "T2/T3 FROZEN INTERFACE CONTRACT" (decisions.md): parseProxyFile/classify/DoorPool + types DoorConn,DoorSpec,DoorPoolConfig,DoorPoolDeps,DoorHttpResponse,ProxySpec. 13 test() phủ 8 nhóm.
- Fake clock: `sleep(ms)` resolve ngay + `t += ms` → wait-loop D7 (poll 250ms cap 65s) và quarantine tự trôi, không sleep thật, không deadlock; `advance(ms)` nhảy mốc thủ công (99_999 / +2 / +120_001).
- `quarantineJitterMs: 0` → quarantine = retryAfter*1000 chính xác, jump clock deterministic.
- LRU priming trick: 1 request thành công trước → door đó most-recently-used → request kế tiếp chắc chắn route sang door kia (D7 tie→LRU) mà không cần giả sử thứ tự index cold-start.
- `start()` fire-and-forget drain bằng `setImmediate` loop + `waitFor(stats() hết cold/warming)`, không real timer.
- RED verify: `npx tsx --test test/door-pool.test.ts` ×3 → SyntaxError "does not provide an export named 'DoorPool'" (ESM link-stage ⇒ file test parse OK, fail đúng do thiếu export).

## T6 smoke harness (2026-09-22)
- `.probe/door-pool-smoke.mjs` — chạy từ `server/`: `npx tsx ../.probe/door-pool-smoke.mjs <mode>`. Flags: `--help` | `--simulate` | `--doors N --broken M` | `--load --minutes M --rate R [--baseline]`. Env: `PROXY_FILE` (bắt buộc mode thật), `CRAWL_WS_ENDPOINT`/`WS` (default `ws://127.0.0.1:3000`), `SMOKE_CA`/`SMOKE_WALLET`. Exit: 0 ok · 1 usage/env/T3-pending · 2 chrome container not running (hint `docker compose up -d chrome`) · 3 watchdog.
- Import `DoorPool`/`parseProxyFile` LAZY trong `loadPool()` → `node --check` + `--help` pass trước khi T3 land; `--simulate` hiện exit 1 "DoorPool not exported yet" (đúng — cần T3). `--doors N --broken M`: N là TỔNG door gồm M broken (khớp QA T3 `--doors 2 --broken 1` → door0 real, door1 `http://127.0.0.1:9`). Proxy log masked `user@host:port`; mọi mode in `cleanup: closed N doors`.

## T3 door pool implementation (2026-09-22) — cấu trúc + điểm khó
- Cấu trúc `server/src/crawl.ts` (759 dòng): frozen contract types → `parseProxyFile`/`classify`/`pathKey` → `class DoorPool` (acquire/pick/tick/dispatch/applyOutcome/warm/rewarm/penalize/retire/logDoor) → real transport (`doorWsEndpoint`, `inPageFetch`, `realConnect`) → lazy singleton `getPool` + `browserPostJson` → exports cũ giữ nguyên byte-for-byte (`createCircuitBreaker`, `hourlyStatsToPoints`, `nansenSeries`, `balanceSeries`, `BalancePoint`).
- Re-warm PHẢI fire-and-forget (`void conn.invalidate().then(...)`, state='warming' sync trước): nếu await inline thì requery cùng request sẽ đập lại door vừa 403 → vỡ test 7b (fetchCount phải =1 sau r1).
- Requery KHÔNG đi qua wait-loop D7 — chỉ `pick(path, failedDoorId)` tức thì; hết door → trả `{status: gốc|502, json:null}` NGAY (interpretation #21). Wait-loop chỉ ở acquire đầu request.
- Fake clock: mọi chờ trong pool phải qua `deps.sleep` (không setTimeout thật) → sleep giả tự tăng virtual clock → loop 250ms/65s hữu hạn, test chạy ~1s.
- Budget ghi tại dispatch (`hits.push({t, path})`) — tính cả fetch fail + requery; `budgetUsed` = tổng request door trong window (interpretation #2); prune giữ `h.t > now - windowMs` (biên t0 rơi đúng tại now=t0+60_000 → test 3/3b pass).
- Race guard: continuation của rewarm chỉ promote `warming → probation` khi state VẪN là 'warming' → penalize đồng thời luôn thắng (ponytail comment tại rewarm).
- `egressIp` vào `stats()` qua property tùy chọn trên conn (`DoorConnWithEgress = DoorConn & {egressIp?}`) — interface DoorConn đóng băng không đổi, fake conn không có → null.
- tsconfig server KHÔNG có DOM lib: trong `warm()` dùng `p.title()` (puppeteer API) thay vì `document.title` trong evaluate; `fetch`/`navigator` trong evaluate được @types/node 20 cover.
- `retry-after` phải đọc IN-PAGE (`r.headers.get`) và trả ra ngoài; `Number(null)=0` → phải guard `rawRetry === null ? NaN : Number(rawRetry)` kẻo quarantine=0.
- `browserPostJson` KHÔNG BAO GIỜ throw nữa (pool degrade 503/502) — consumers (nansenSeries, NansenWebCrawler.extremesFor) vốn đã throw khi status!==200 nên poller log + đi tiếp, không đổi hành vi vòng ngoài.

## [2026-09-22 11:0x] T3 landed + owner proxy list appeared
- T3 `server/src/crawl.ts` 759 dòng, build 0, door-pool 13/13, full suite 155/155, smoke --simulate exit 0 (orchestrator tự chạy lại, không tin worker).
- Deviation duy nhất so với decisions.md: D3 nói "real403 trong probation → penalized ngay", test pin "403 đầu → re-warm → probation; streak≥2 mới penalized". Implement theo TEST (spec), ghi issues.md. D5 trong plan cũng là "re-warm + requery" nên không lệch ý định.
- `createCircuitBreaker` giữ export nhưng KHÔNG còn wire vào live path (pool thay bằng per-door transport-fail retire). `test/crawl-breaker.test.ts` vẫn xanh.
- `data/proxies.txt` (owner tạo 09:55–10:30 qua .probe/proxy-scan.mjs) + `evidence/2026-09-22-nansen-proxy-scan.{md,jsonl}` đã có → QA thật (docker chrome + proxy thật) GIỜ KHẢ THI, không còn owner-gated như plan giả định. F4/T7 nên dùng.

- [2026-09-22] T7 evidence: `evidence/2026-09-22-door-pool-plan-execution.md` (build exit 0; door-pool 13/13 x2; full suite 155/155; smoke --simulate exit 0; only crawl.ts/config.ts/door-pool.test.ts new; proxies.txt 35 data lines = 3 http + 32 non-http → 3 doors).
- F2 fix: guard state tại đầu mutator async (rewarm) + tính earliest-slot thay vì poll mù (acquire) là 2 pattern diệt race/hang với diff ~1 dòng/~30 dòng — sớm nhất = min(quarantineUntil, backoffUntil, hits[0].t+window), 0=unknown→giữ poll.
- Mask/strip credential trong URL: luôn dùng `\/\/[^/?#]*@` (authority-scoped, greedy tới `@` cuối) — `[^@/]*@` dừng ở `@` đầu tiên leak đuôi password chứa `@` raw; và decodeURIComponent phải nằm TRONG try của parser per-line kẻo 1 entry xấu đánh sập cả pool.

## [2026-09-22 12:2x] Final Verification Wave executed (F1-F4)
- All four gates returned APPROVE, zero REJECT outstanding. Plan checkboxes left as `[~]` (blocked on the user-approval step of the final-wave gate) - do NOT flip to `[x]` before explicit user sign-off.
- F1 oracle APPROVE: T1-T7 acceptance traceable, 10/10 hard constraints pass, MUST FIX none.
- F2 oracle APPROVE (3rd pass): R1 rewarm-guard closes the concurrent double-invalidate page leak; R2 earliestSlot closes the 65s cap-burn; mask/decode fixes correct; no false-503, hard 65s bound.
- F3 APPROVE via substitute reviewer: canonical `security-reviewer` agent crashed twice on a provider error (`content[].thinking ...`), oracle retry died on provider 400 -> lean prompt on the `unspecified-high` config produced the verdict. Lesson: when a review agent is infra-broken, re-dispatch lean on another agent config instead of re-litigating scope.
- F4 APPROVE: real chrome actually ran (3 doors, warmup-ok, requery exactly once per request, cleanup closed 3 doors).
- Lesson: a `gitignore` rule MUST put `#` on its own line - inline comments do not exist, the whole line becomes a literal inert pattern. F3 caught our own fix shipping an inert credential guard.
- Lesson: `.probe/door-pool-smoke.mjs` preflight must not rely solely on `docker compose ps` - a chrome started via bare `docker run` has no compose labels; the `docker ps --filter name=chrome` fallback is what unblocked real-chrome QA.

## [2026-09-23] Lesson: một cú chết hạ tầng chung có thể giả làm "proxy hỏng" hàng loạt

- Lỗi transport trong door pool chỉ là `{threw:true, status:0}` — vô nghĩa nếu không có **origin**. Khi ≥2 door dùng CHUNG một phụ thuộc (cùng 1 chrome container), mọi lỗi của phụ thuộc đó đến đồng thời trên TẤT CẢ door ⇒ "2 lần liên tiếp" bị thoả tức thì cho mọi door ⇒ retire cả pool trong vài trăm ms. Lỗi tương quan (correlated failure) phá vỡ giả định "mỗi door độc lập" của rule đếm-liên-tiếp. Fix đúng: phân loại theo **origin** (prefix `browser:`) trước khi tính điểm, không chỉ theo số lần.
- `retire()` terminal + không có re-arm = blackout vĩnh viễn sau một sự cố 30 giây. Với state machine, mọi trạng thái "chết" cần một cửa quay lại (cooldown) — trừ khi có lý do rõ ràng (reputation). Test pin cũ vẫn xanh vì cooldown chặn re-arm tức thời ⇒ có thể thêm hồi sinh mà không phá contract.
- Khi 503 xuất hiện dày đặc, kiểm tra nó **có phải do mình tự sinh** (`if (!door) return {status:503}`) trước khi đổ lỗi cho upstream — log `nansen chart 503` nghe như Nansen nhưng thực ra là pool cạn door.
- Probe phải chạy từ **đúng network vantage point**: `curl -x` từ host 250 vào proxy của chính nó trả 000 (hairpin NAT) trong khi từ trong container trả 200. False negative từ sai vantage point dễ dẫn tới kết luận "proxy chết" — đúng loại kết luận sai đã gây ra sự cố này.

## [2026-09-23] Rate limit RPC: 429 plain-text = edge limit, không phải cạn quota

- Phân biệt bằng **body**: edge/CF trả plain text `Too Many Requests`; cạn credit quota trả JSON có message riêng. Một `getHealth` lẻ trả 200 **không** chứng minh còn quota — method rẻ có thể không bị meter.
- Prod dùng **Helius**, không phải public mainnet — đọc endpoint thật từ container env trước khi suy đoán về provider.
- "Queue" đã có sẵn: `pace()` giữ `nextStartAt`, `post()` gọi lại `pace()` mỗi attempt ⇒ retry tự về **cuối** hàng đợi. Chỉ thiếu **budget cấu hình được** ⇒ nới budget = "không mất request", không cần thêm cấu trúc queue mới (YAGNI).
- Test pin "persistent 429 rejects" buộc giữ hành vi throw khi hết budget; vẫn nới được default vì test truyền `[1,1]` tường minh.
- In config để verify thì `solanaRpcUrl` **chứa API key** ⇒ luôn redact (`sed -E "s|(api-key=)[^&]*|\1<REDACTED>|"`) hoặc so hash sha256, đừng in giá trị.
- `mem_limit` là **cap, không phải reservation**: đo `docker stats` trước khi kết luận nghẽn RAM — nâng trần khi RSS chỉ 28% là insurance, không phải tối ưu.
