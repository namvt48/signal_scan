# Issues — nansen-proxy-routing

Known bugs + gotchas. APPEND ONLY.

## Bug phải fix (T3)
- `server/src/crawl.ts:145` — `if (out.status !== 403 || attempt === 2) return out;` → 429 đi thẳng ra ngoài, không đọc retry-after, không cách ly.
- Circuit breaker chỉ đếm lỗi thrown → 403/429 trả về như response KHÔNG tính → vòng chết 403 → invalidatePage() → page mới → 403 mỗi ~4.5s; chrome phình 2.3GB/3GB.
- Warmup = goto + sleep(4000) cứng → race với CF challenge (cần tới ~20s theo .probe/challenge-probe.mjs).

## Gotchas
- retry-after phải đọc TRONG in-page fetch (r.headers.get('retry-after')) rồi đưa ra ngoài — hiện browserPostJson chỉ trả {status, json}.
- 403 interstitial = HTML (~6472B, title "Just a moment"); 403 real = JSON. Đừng dùng size làm tiêu chí duy nhất.
- 429 body ~975B "Error 1015"; retry-after đo được 2204–2797s (~37–47 phút).
- Penalty 429 lan theo IP, KHÔNG lan cross-IP → requery sang door khác an toàn.
- Chrome KHÔNG auth được SOCKS5 → chỉ http://user:pass@host:port.
- npm test chạy toàn bộ test/*.test.ts — file test mới đang RED làm fail cả suite; khi verify task khác dùng `npx tsx --test test/<file>.test.ts`.

## T2 contract gaps (pinned interpretations — T3 MUST match, test file KHÔNG được sửa)
- `ProxySpec.url` semantics không frozen (nguyên dòng gốc vs bỏ credentials) → test chỉ assert `url.includes('host:port')` + username/password exact.
- `DoorStat.budgetUsed` semantics không frozen (tổng per-door trong window vs per-path) → test assert `=== 30` chỉ tại điểm cả 2 cách hiểu trùng nhau (sau 30 req cùng path).
- Single-door 429: test pin theo D5 (requery fail → trả `{status: gốc|502}` NGAY, json null) chứ KHÔNG theo diễn giải D7 wait-loop-trong-cùng-request (chờ quarantine rồi trả 200). Request KẾ TIẾP mới chờ slot (D7) — test assert fetchTimes[1] >= t0+50s.
- Penalized door được coi là "door sống" theo D7 (chờ slot/backoff, không phải 503 ngay); hết backoff 2m → re-warm → probation → 200 → healthy (test group 7b pin).

## T3 deviations / gaps (implement theo test = spec)
- MÂU THUẪN D3 vs test: decisions.md:41 "403-real trong probation → penalized ngay" nhưng test 7b (door-pool.test.ts:444-447) pin: 403 thật ĐẦU TIÊN khi door đang probation → re-warm → `waitFor(probation)`; chỉ 403 LIÊN TIẾP thứ 2 (real403Streak≥2, reset khi 200) → penalized (7a:433). Implement theo test: streak-based, không phân biệt healthy/probation.
- `createCircuitBreaker` giữ export (crawl-breaker.test.ts xanh) nhưng KHÔNG còn wire vào `browserPostJson` — pool thay thế bằng per-door transport-fail retirement (≥2 liên tiếp → broken-proxy). Plan T3 "breaker không còn rebuild loop" diễn giải = bỏ hẳn breaker khỏi live path; nếu cần global fast-fail thì re-wire trong `getPool()`.
- `crawlWarmupTimeoutMs` dùng cho CẢ goto timeout lẫn budget poll tính từ trước goto → warmup worst-case ≈ 2× warmupTimeoutMs (D3 nói một con số 30s). Không test nào pin; chấp nhận.
- Smoke `--simulate`: "cleanup: closed 2 doors" (không phải 3) — pool tự `conn.close()` khi retire broken door nên harness skip record đã closed. Harness KHÔNG sửa (đúng chỉ thị); exit 0, bảng door + "broken door retired as expected" in đủ.
- `dispatch(d, url, body, path)` 4 tham số (path = dẫn xuất từ url, truyền vào để khỏi tính lại) — private method, giữ nguyên; smell >3 params ghi nhận, không đáng tách value object.
- File 759 dòng (≈640 pure LOC) vượt trần 250 LOC của programming skill — task MANDATE implement đúng trong crawl.ts, cấm tạo src file mới; deviation có chủ đích, ghi nhận tại đây.
- Dirty-worktree check (không git): mtime chứng minh chỉ `src/crawl.ts` đổi trong session (10:52+); `dist/*` regenerate do `npm run build` bắt buộc (derived, không phải source); config.ts 09:51 = T1 trước đó; test/door-pool.test.ts 10:12 = T2, không đụng.

## F2 rejection fix (2026-09-22, R1-R4) — chỉ server/src/crawl.ts
ĐÃ SỬA:
- R1 rewarm(): guard `if (d.state === 'warming') return;` — chặn double-invalidate từ 2 request in-flight cùng door (interleave I1/I2 đè page → leak page trong browserless 3GB, đúng pattern prod OOM 2026-09-19). Callers an toàn: tick() gọi từ 'penalized', applyOutcome từ healthy/probation — đều ≠ 'warming' nên vẫn lọt; không test chạm nhánh guard.
- R2 acquire(): thêm earliestSlot() — tính slot sớm nhất của door sống (throttled→quarantineUntil, penalized→backoffUntil, healthy/probation budget-blocked→hits[0].t+budgetWindowMs, cold/warming→0=unknown). `earliest - t0 >= 65s` → 503 NGAY, không đốt trọn cap mỗi request (retry-after đo được 2204-2797s >> cap). earliest===0 → giữ poll cũ, không 503 oan. Test group 8 xanh (quarantine 50s < cap → vẫn chờ tới slot), test 3/3b xanh (budget wait 60s < cap).
- R3 realConnect(): egress check bọc withTimeout(…, 10_000).catch(() => '') — proxy blackhole không còn treo ~180s protocolTimeout khiến door kẹt 'warming' lúc boot.
- R4 dispatch(): try/catch quanh conn.fetch — reject → synthetic {status:0, threw:true, head≤120} ; contract "postJson NEVER throws" không còn phụ thuộc conn ngoài; finally vẫn decrement outstanding.
CHỦ Ý KHÔNG SỬA (F2 đồng ý để lại):
- #3 throttled bị rewarm/penalize đè mất quarantine — self-healing, ưu tiên thấp.
- #6 4xx lạ (400/401/404) → transport → transportFails có thể retire cả pool — ngoài Classification đóng băng (spec), đổi = sửa contract.
- #7 budget overshoot khi concurrent — bounded, trần CF 43/min vẫn an toàn.
- #8 maskProxyUrl hở đuôi password chứa '@' raw — F3 đang soi, không tự chế mask mới ở file này.
Verify sau fix: build 0 · door-pool 13/13 ×3 · npm test 155/155 (3657ms) · simulate exit 0 (bảng door y nguyên: sim-bad retired broken-proxy, req2=502, sau đó 200) · grep R1/R2/R3/R4 có mặt · gate sleep(4000)/status!==403 rỗng · retry-after=7 · mtime: chỉ crawl.ts đổi (11:28), test vẫn 10:12 · LSP: none.
- S3 (fixed 2026-09-22): `dockerChromeUp()` in `.probe/door-pool-smoke.mjs` only saw compose-labeled containers — bare `docker run` chrome (`nansen-chrome`) → false exit 2; added `docker ps --filter name=chrome` fallback inside same try, catch→false unchanged.
- S4 (fixed 2026-09-22): root `.gitignore` had no rule for `data/` (proxies.txt credential-bearing, docs promise never-commit); appended `data/` line. Repo is not a git repo — rule is intent/hygiene only.

## F3 security fix (2026-09-22, S1+S2) — chỉ server/src/crawl.ts
- S1 (credential leak): `maskProxyUrl` (:109-111) và `doorWsEndpoint` (:530) cùng regex cũ dừng ở `@` ĐẦU TIÊN → password chứa `@` raw leak đuôi (`http://user:pa@ss@h` → `http://user@ss@h`, tail `ss` sống sót) vào log + query `--proxy-server`. Fix cả 2 site: `/\/\/[^/?#]*@/` → `//` — strip WHOLE userinfo, authority-scoped (không vượt `/?#`), greedy tới `@` cuối. Over-mask (mất username trong log) = hướng an toàn. Doc comment maskProxyUrl cập nhật theo hành vi mới. Không đổi acceptance rules parseProxyFile / encoding / page.authenticate.
- S2 (pool-wide DoS từ 1 dòng xấu): `decodeURIComponent(username/password)` nằm NGOÀI try → `%zz` throw URIError → thoát parseProxyFile → getPool catch → proxies=[] → cả pool degrade single-door, vỡ D2 (bad entry → warn+skip entry đó, test :200 pin). Fix: chuyển protocol-check + decode VÀO trong try, `spec` const khai báo trước try, `out.push(spec)` sau try — URIError giờ đi đúng path warn(maskProxyUrl(line))+continue như mọi malformed line khác. Hành vi line hợp lệ identical (url raw, creds chỉ set khi có).
- Inline proof (tsx -e, không tạo file): (a) input 4 dòng task đưa → threw=null, count=2, urls=[http://u:p@h:80, http://ok:pass@h:9], creds decode y nguyên [u,p]/[ok,pass], warns masked (http://host:80 — không creds); (b) maskProxyUrl THẬT qua warn path `http://user:pa@ss%zz@h:80` → `http://h:80` (không 'pa'/'ss'), literal `http://user:pa@ss@h:80` → `http://h:80`, regex CŨ → `http://user@ss@h:80` (chứng minh leak cũ). PROOF_OK exit=0.
- Verify: build 0 · door-pool 13/13 ×2 · npm test 155/155 (3411ms) · simulate exit 0 bảng door y nguyên · grep regex mới = 2 hit (:110, :530) · sed 130-145: decode trong try · mtime: crawl.ts 11:45 (803 dòng), test vẫn 10:12 · LSP none.
- Không đụng: R1-R4 (đã APPROVED), .probe/EVIDENCE-2026-09-17-* (owner-gated rotation, ngoài task).
- S4-followup (fixed 2026-09-22): gitignore inline `#` is NOT a comment (gitignore(5): comment only at line start) — `data/ # ...` was one inert literal pattern; split into own-line comment + bare `data/`. Audit: no other line carries inline `#`.

## [2026-09-22 12:2x] Owner actions outstanding after the wave (not blockers)
1. Rotate `NANSEN_API_KEY`: live cleartext copy in pre-existing files `.probe/EVIDENCE-2026-09-17-clean-untracked-cas.md:68` and `.probe/EVIDENCE-2026-09-17-inflow-holding-4ca.md:145` (different earlier task; self-flagged "phai rotate"; out of this plan's write scope).
2. Real crawling: the 3 http proxies in `data/proxies.txt` are Cloudflare-403 (interstitial) - pool mechanics verified working, but live data needs paid/live proxies; add to the txt and restart the service (no hot reload by design).
3. `signal_scan` sits inside a git repo whose root is the PARENT dir (`../.git`), so `signal_scan/.gitignore` is operative - `data/` is now correctly ignored as of 12:16.

## Owner actions - server egress proxy (2026-09-22, post-plan by owner request)

- `167.86.101.228` is no longer proxy-less: tinyproxy 1.11.1 installed (`Port 31128`, BasicAuth, `Allow 127.0.0.1` + `Allow 118.71.50.141`). The Allow rule is the home IP, so a dynamic-IP change breaks the door until the rule is updated.
- Wired as the 4th door in `data/proxies.txt`. Verified working: real-chrome smoke `--doors 1` ended `state=healthy` with 2x HTTP 200 (evidence section (k)).
- NOT active yet: `CRAWL_PROXY_FILE` is unset (there is no `server/.env`), so the running config still boots the single fallback door. Per the owner directive, changing the list = restart the system.
- Rotate password: edit `/etc/tinyproxy/tinyproxy.conf` on the server + the one matching line in `data/proxies.txt`. Disable: `systemctl disable --now tinyproxy`. Uninstall: `apt-get purge -y tinyproxy`.
- Owner accepted the risk: crawler traffic now shares the prod IP with the live/paper-trade stack, so a CF throttle on that IP would hit both.
- Repo note: the `.git` directory in the parent (`dev-space`) is incomplete (only `info/`), so git says "not a repository" and nothing can be committed today. The `.gitignore` `data/` rule stays as defence for when a real repo exists.

## [2026-09-23] BLACKOUT: false `broken-proxy` retire (2 door cùng lúc) — đã fix

- Triệu chứng: prod chỉ còn factor `fresh`; DB `t100_multiple`=6, `genesis_bal`=7 / 89 CA; log `[pool] no door budget … skip` + `nansen chart 503` (503 tự sinh ở `postJson`, KHÔNG phải Nansen trả).
- Gốc: browser process bên trong `signal_scan-chrome-1` chết (06:30:30Z, `RestartCount=0`) → mọi fetch `{threw:true,status:0}`; `dispatch` chỉ giữ được `threw+status 0` nên **không phân biệt nổi "page chết" vs "proxy chết"** → `classify='transport'` → `transportFails≥2` → `retire('broken-proxy')`. Hai door dùng **chung 1 chrome container** nên cùng chết trong 200ms (06:35:30Z). `retire()` là terminal, chỉ `interstitial`/`real403` mới rewarm ⇒ không đường hồi.
- Bằng chứng proxy sống (probe từ trong container api): door0 200 egress 194.163.187.250, door1 200 egress 167.86.101.228. Lưu ý: `curl` từ **host** 250 vào `:31133` trả 000 (hairpin NAT provider) — host-side probe là false negative, phải probe từ trong container.
- Fix (`crawl.ts`+`api.ts`, chi tiết `evidence/2026-09-23-door-pool-blackout-fix.md`): (1) `realConnect.fetch` prefix `browser:` cho throw nguồn page/CDP → `applyOutcome` **rewarm thay vì tiêu transportFails**; (2) `retiredAt` + `rearmRetired()` hồi sinh door `broken-proxy` sau 60s; (3) `acquire()` khi mọi door retired → re-arm + log 1 lần `ALL DOORS RETIRED`; (4) `/api/health` thêm `doors`.
- **THAY ĐỔI NGỮ NGHĨA D5 (ghi vào contract)**: lỗi transport thật (head rỗng / `Failed to fetch` trong page) vẫn 2 lần → retire như cũ; lỗi nguồn page/CDP thì KHÔNG. `broken-proxy` không còn terminal (re-arm 60s); `real403-reputation` vẫn terminal. `door-pool.test.ts` 13 test cũ vẫn xanh + 4 test mới ⇒ hợp đồng không vỡ.
- Verify: 182/182 test · tsc exit 0 · prod doors `healthy` 22/24 req `lastStatus:200` · 0× `nansen chart 503` · 0× `page-fail|retired` · `t100` 6→9, `genesis` 7→10, `anchor` 6→9 (backfill tiếp theo nhịp sweep 12h).
- Ngoài scope: `nansen-cache.json` boot log `loaded 6 entries (pruned 7)` + 3 entry mới = 9/9 complete — prune hợp lệ (`setup-cache.ts:198-214`, C2 guard), không mất dữ liệu; chrome `mem_limit 3g` vẫn là nguyên nhân nền; `solana rpc 429` và `poller.ts:137` LSP error không liên quan.
- Nhịp backfill (đừng đọc nhầm là kẹt): `setupSweep anchored to systemDeployAt=…` → sweep đầy đủ 12h/lần; `early setup pass`=3 khớp 1:1 với `t100/genesis/anchor +3` và cache complete `6→9`, `setupSweep gini|series` 0 lỗi ⇒ 3 CA đó chạy trọn chuỗi. 78 CA fresh-only chờ mốc sweep kế tiếp.
