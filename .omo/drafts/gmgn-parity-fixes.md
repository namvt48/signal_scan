---
slug: gmgn-parity-fixes
status: approved
<!-- gate chi tiết ở section "## Approval gate" cuối file; frontmatter này chỉ là status tóm tắt -->
intent: clear
review_required: false
pending-action: DONE — plan đã viết tại .omo/plans/gmgn-parity-fixes.md và **APPROVED** (Momus round 4). Bước tiếp: user chạy /start-work.
approach: >
  RÚT LẠI kết luận cũ "GMGN không tái tạo được từ RPC": kết luận đó dựa trên bảng user
  paste BỊ CẮT. Probe live API /v1/user/wallet_activity cho thấy GMGN hoàn toàn nhất quán:
  MỘT row cho MỘT bước swap qua một DEX/launchpad pool, amount = NET delta phía ví nhận
  (SỬA bởi F21–F23: amount = gross leg on-chain − LP fee của step đó; "transfer-fee" chỉ là ca riêng của XBT/token-2022; LP fee KHÔNG tồn tại trong RPC payload), base/quote = hai asset của pool. 29 row / 9 sig đã snapshot
  làm oracle. User chốt: vẫn dùng RPC làm nguồn realtime, parser phải tái tạo đúng semantics
  đó; GMGN chỉ dùng làm oracle offline + tool đối soát thủ công (không vào hot path, vì
  ban IP sau ~5 call nhanh và không có phân trang).
---

# Draft: gmgn-parity-fixes

## Components (topology ledger)
<!-- id | outcome (one line) | status | evidence path -->
- C1 | Nguồn row swap = RPC parser tái tạo semantics per-step của GMGN; GMGN chỉ là oracle offline | decided | .omo/drafts/gmgn-parity-fixes-fixture/gmgn_rows_fixture.json (29 rows)
- C2 | Symbol (`_sym()` :519 cache-only → `F8eyg3…`) + quote-mint list sai (WBTC/cbBTC coi là tiền → đảo base/quote) | active | scripts/wallet_watch.py:53-61,173,519-524
- C3 | Event THỪA: TRANSFER_IN/OUT 84% log (162/192 event FhsbQ); extras `WBTC 0.02007` là step thật bị đảo base/quote | active | /home/namvt/Downloads/wallet-watch-logs-20260915-103142/events.jsonl
- C4 | Event THIẾU: `_seen_add(sig)` đánh dấu TRƯỚC fetch (:819 → :784) → tx null/429 mất vĩnh viễn | active | scripts/wallet_watch.py:784-791,816-851
- C5 | Tests: `test_gmgn_parity.py:140` gọi dead-code `classify_swaps`, `test_route_detect.py:45,112` + `test_wallet_watch.py:56` gọi `classify` → cả ba phải theo detector mới | active | scripts/test_*.py
- C6 | Scaling 100 ví: RPC URL hardcode `api.mainnet-beta.solana.com` (:48 HTTP, :886 WSS), không env | active | scripts/wallet_watch.py:48,886,949-1008

## Open assumptions (announced defaults)
<!-- assumption | adopted default | rationale | reversible? -->
- GMGN row ≡ 1 bước swap, amount = net delta ví nhận | **đã verify bằng API** (29 rows khớp on-chain legs; XBT 102,766.57 gross → 97,779.91 net = fee 4.85%; ORE 9.54607 → 9.46723 = fee 0.83%; STEVE gross=net) | snapshot fixture là ground truth, không cần đoán | no (đã đo)
- `launchpad_platform` (Pump.fun / stonkfun) quyết định base/quote cho cặp token/token | mọi cặp không có global-quote trong fixture đều là launchpad pool (JUDE/SPCX, SNOOPDOGE/DOGE, STEVE/ORE, OS/CARDS) → base = token mới, quote = asset của curve | khớp 8/8 row token-token | yes (nếu gặp DEX token/token mới → rule 4)
- Pool order fallback = lexicographic-greater mint là base, flag `quote_inferred` | cover cbBTC/WBTC (base=cbBTC ✓) và XBT/WBTC (base=XBT ✓) trong fixture | chỉ 4/29 row cần tới fallback | yes
- Không đụng `wallet_trades`/server/FE | toàn bộ thay đổi nằm trong `scripts/wallet_watch.py` + tests + 1 script đối soát | deploy = scp tới `/opt/wallet-watch` + restart systemd (`make deploy` KHÔNG ship scripts/) | yes

## Findings (cited - path:lines)

**Kiến trúc hiện tại**
- F1 Production emit dùng `classify()` — scripts/wallet_watch.py:337 (net delta theo mint, phát cả TRANSFER_*); `classify_swaps()` :596 (mô hình gần GMGN) là DEAD CODE — `process_sig` :816 gọi `classify()` tại :847, rồi `print(fmt(ev))` :848 + `jl_write(ev)` :849 + `track_event(ev)` :850.
- F2 `_sym()` :519-524 chỉ đọc cache `_info` → khi chưa warm phát `mint[:6]+"…"` (`CARDSc…`, `DoGEV7…`, `F8eyg3…`). `token_info()` :173 negative-cache failure vĩnh viễn (mint lỗi không bao giờ retry).
- F3 `DEFAULT_QUOTES` :53-59 = {WSOL, USDC, USDT, JUP, WBNB}; `--quotes` default `scripts/quotes.txt` :954 **không tồn tại** → `quotes_map` :61 chỉ có defaults. Thiếu DAI; và (quan trọng) WBTC/cbBTC **không** được phép là global quote cho cặp token/token.
- F4 Transport: `run_ws_feed` :870 dùng `wss://api.mainnet-beta.solana.com` :886 `logsSubscribe(mentions)`; `getTransaction(commitment=confirmed)` :826-836; RPC hardcode :48. RPC công khai 429 thường xuyên.
- F5 `track_post_body(e)` :76-87 pure, chỉ POST khi `side ∈ {BUY,SELL}` → đã tự loại transfer khi detector ngừng phát TRANSFER_*; `track_event` :90-112 fail-soft + dedup `_posted_mints` :67. **Không cần sửa**.
- F6 Server: `MarketDataProvider.walletActivity()` → `{tx,ts,side,ca,chain,amountUsd,price}` không có symbol/qty (server/src/providers/provider.ts); `wallet_trades` UNIQUE(wallet_id,ca,tx,side) (server/src/db.ts:138-150); `walletSweep` `POLL_WALLETS_MS=30000` (server/src/poller.ts:150-168). → KHÔNG đụng.
- F7 GMGN bị retire khỏi server 2026-09-09 sau `429 RATE_LIMIT_BANNED` ở 4 rps khi sweep holders (server/src/config.ts:20; docs/2026-09-08-gmgn-key-runbook.md). Client compile còn nguyên: `server/dist/providers/gmgn.js` (155 dòng) — `wallet_activity` `{chain,wallet_address,limit}` weight 5, **không cần Ed25519**; `limit` cap 50; lỗi code≠0; rate-limit kèm `x-ratelimit-reset`.

**RÚT LẠI: "GMGN không nhất quán / không thể parity từ RPC"**
- F8 (cũ F7-F9, SAI) Kết luận cũ dựa trên bảng paste bị cắt. Sự thật từ API: `33hqSn4Q` có **2 step XBT** (638,160.36 → WBTC 0.016567; 97,779.91 → WSOL 2.0069) — leg 102,766.57 gross không "bị bỏ" mà là 97,779.91 sau fee 4.85%. `3pkGZDK1` có 4 step (sell cbBTC 0.0200705→USDC; buy cbBTC 0.0028584→WBTC; buy cbBTC 0.0172121→WBTC; sell XBT 740,926.93→WBTC 0.0200651). "SELL WBTC 0.02007" mà ta coi là event THỪA chính là row `sell cbBTC 0.0200705` bị **đảo base/quote**. → Parity TÁI TẠO ĐƯỢC.
- F9 Per-pool multiplicity: `3BbWVS3K` = **3** step buy CARDS→USDC riêng biệt (964.66/36,772.24/1,184.39) trong 1 route + 1 step OS→CARDS; `58pWphuG` = OS bán vào **2 pool khác nhau** (→WSOL 5.85; →CARDS 26,699.55) + 2 sell CARDS→USDC. → frame phải theo **instance lời gọi**, không theo program-id; pair legs theo **pool-key (owner của vault)**.
- F10 Route-level ≠ row-level: `5XLTG1WX` sell STEVE 20,395,086 → 2 row (`sell ORE 9.467` khi STEVE→ORE và `sell STEVE 20,395,086` khi ORE→USDC); ví không hề nhận ORE. `4zmaV87B` buy SNOOPDOGE → 1 row `buy SNOOPDOGE 10,363,786` (quote DOGE) + 2 row DOGE→USDC; mint `DoGEV7LA…` symbol on-chain = **DOGE** (không nhầm CA). `2k3KYp18` = sell SPCX 9.524479 (quote USDC) + sell JUDE 9,678,051.40 (quote SPCX 9.524479 — đúng bằng lượng SPCX vừa nhận). → side/step phải tính **theo từng pool**, không suy ra từ net delta của ví.

**Đo được (baseline)**
- F11 `classify()` (production): khớp 10/21 row cửa sổ cũ, thừa 1 (thực chất là base/quote đảo, F8) — tức sai ~50% về **shape** (route-level thay vì per-step) dù amount có lúc đúng.
- F12 `classify_swaps()` (dead, chạy thử): 11/21, thừa 5 (`CARDSc…` ×3 do thiếu symbol + không pair theo pool, `DoGEV7…`, `WBTC`).
- F13 Log đầy đủ: TRANSFER_IN 1056, BUY 232, TRANSFER_OUT 187, SELL 126, NEUTRAL 2 → 162/192 event của FhsbQ là TRANSFER_OUT (84%) mà GMGN không hiển thị → user chốt bỏ.
- F14 Row 31-51 recall 100% (21/21 sig có trong log, blockTime khớp tới giây); row 52-80 trước cửa sổ log.

**Probe API live (fact, không đoán)**
- F15 `GET https://openapi.gmgn.ai/v1/user/wallet_activity?chain=sol&wallet_address=…&limit=50&timestamp=<unix±5s>&client_id=<uuid>` + header `X-APIKEY` → HTTP 200, `code=0`, `data.activities` 50 rows. Fields: `event_type, tx_hash, timestamp, token{address,symbol,logo,total_supply}, token_amount, quote_token{token_address,name,symbol,decimals}, quote_amount, quote_address, cost_usd, buy_cost_usd, price_usd, price, from_address, to_address, is_open_or_close, launchpad, launchpad_platform, dex_native, dex_usd, gas_native, gas_usd, priority_fee, tip_fee, wallet, chain`.
- F16 **Không có phân trang**: `before=<ts>` bị **ignore** (trả về đúng window cũ); `max_timestamp` → 429 `RATE_LIMIT_EXCEEDED`; `cursor` và `limit=100` → 429 `RATE_LIMIT_BANNED`. Window quan sát được ≈ 3.84 ngày (ts_min 1789115574 → ts_max 1789144638…; 50 row). ⇒ **không thể lấy oracle cho tx cũ hơn ~4 ngày** ⇒ backtest lịch sử phải dùng fixture đã snapshot.
- F17 **Ban IP thực nghiệm**: 5 call cách nhau <2s từ VPS → 2 call cuối `RATE_LIMIT_BANNED`. ⇒ mọi dùng GMGN live phải ≥5s/call, ≤4 call/run, cấm trong watch loop.
- F18 Oracle snapshot + tx on-chain đã được cứu khỏi `/tmp` (dễ bị evict): `.omo/drafts/gmgn-parity-fixes-fixture/` = 12 tx JSON (9 sig: 2k3KYp18, 33hqSn4Q, 3BbWVS3K, 3fec2kXP, 3nzGD2WV, 3pkGZDK1, 4zmaV87B, 58pWphuG, 5XLTG1WX) + `gm_activity_FhsbQ_50rows.json` (payload thô) + `gmgn_rows_fixture.json` (**29 rows** đã lọc theo tx_hash: 2k3KYp18=2, 33hqSn4Q=4, 3BbWVS3K=4, 3fec2kXP=2, 3nzGD2WV=4, 3pkGZDK1=4, 4zmaV87B=3, 58pWphuG=4, 5XLTG1WX=2).
- F19 Test coupling: `test_route_detect.py:45,112` → `ww.classify`; `test_gmgn_parity.py:128,140` → `ww.rpc` + `ww.classify_swaps` (GT ở :190 target 30/30 + amount ≥27/29); `test_wallet_watch.py:56` → `ww.classify`, :101-114 → `track_post_body` (giữ). Cả 3 seed `ww._sol_px/_info/_supply` để chạy offline → detector mới phải cho seed cùng kiểu.
- F20 Q2 (100 ví) số liệu: GMGN 0.25-0.5 rps × weight 5 + cap 50 row/call + không phân trang + ban sau ~5 call ⇒ sweep 100 ví ≈ 200-400s (3.3-6.7 phút/ví) và burst >50 row mất trắng. RPC ws 100 sub + N `getTransaction` trên public ⇒ 429; cần RPC trả phí (Helius free 1M credit/tháng, ~10-20 credit/tx) và `--rpc-url`.

## Decisions (with rationale)
- **D1 (Q1=user)** Nguồn = RPC (realtime, không ban, không cap). GMGN API **chỉ** dùng làm (a) fixture oracle đã snapshot và (b) tool đối soát **thủ công** throttled. Lý do: F16+F17 (không phân trang, ban IP), yêu cầu realtime.
- **D2** Thay model route-level bằng **per-step**: hàm mới `detect_swaps(tx, wallet) -> list[event]`, mỗi event = 1 bước qua 1 pool (F9, F10). Xoá dead code `classify_swaps()` :596 và `classify()` :337 (cùng logic TRANSFER_* :426,443,449 mà D3 bỏ). Giữ helper `_swap_legs()` :527.
- **D3 (Q3=user)** Bỏ hẳn `TRANSFER_IN/OUT/NEUTRAL` khỏi stdout + `events.jsonl` + auto-track (F13: 84% noise). `track_post_body` giữ nguyên (F5).
- **D4 (Q4=user)** Fix-forward mất-tx: `_seen_add(sig)` dời **sau** khi có tx non-null (:840-842); lỗi/null/429 → KHÔNG đánh dấu, retry sweep sau với backoff. Backfill tx cũ = replay sig lịch sử bằng detector mới (D5).
- **D5** Oracle backtest: `scripts/fixtures/` nhận 29 row + 12 tx từ F18; gate = 29/29 khớp `(event_type, token.symbol, token_amount, quote_token.symbol, quote_amount)` và **0 event thừa**. Tx ngoài window (không có row GMGN) chỉ assert shape/amount on-chain, flag `no_oracle` — không gọi GMGN live trong test.
- **D6 (amount)** `token_amount`/`quote_amount` = **net delta phía tài khoản trader** (`post − pre` của các token account thuộc trader), KHÔNG phải gross transfer — vì fee-on-transfer (F8: XBT 4.85%, ORE 0.83%). Tài khoản trader = `owner == wallet` HOẶC account không có trong `preTokenBalances` (tạo trong tx, vd ATA mới / temp của launchpad).
- **D7 (base/quote)** Chuỗi rule, dừng ở hit đầu: (1) pool launchpad (`launchpad_platform` tương ứng program-id Pump.fun/stonkfun) → base = token mới, quote = asset curve; (2) mint ∈ GLOBAL_QUOTES {USDC, USDT, WSOL, DAI} → mint đó là quote; (3) linking-mint (mint xuất hiện ở step khác của cùng tx) → là quote; (4) fallback lexicographic-greater = base + flag `quote_inferred=true` (F8 F10: cover đúng 4/29 row). **WBTC/cbBTC không được vào GLOBAL_QUOTES.**
- **D8 (side)** Tính theo từng step: base chảy **vào** tài khoản trader ⇒ BUY, chảy **ra** ⇒ SELL (không suy từ route direction; F9/F10 cho thấy 1 tx có cả 2 chiều và cùng token ở 2 pool).
- **D9 (frame/pairing)** Ghép legs theo: (a) frame = instance lời gọi (walk `stackHeight`, stack reset mỗi top-level ix, không cross-contaminate giữa các ix); (b) DEX-frame = ancestor gần nhất ∉ NONDEX {TokenkegQ, TokenzQd, System, ComputeBudget, ATA, Jupiter JUP6/JUP5/JUP4}; KHÔNG cần registry DEX (DEX lạ tự hoạt động); (c) pair 2 leg trong cùng **pool-key** = owner của token-account phía vault; (d) chỉ nhận group đúng 2 leg với 2 mint khác nhau (leg fee nội bộ nằm ngoài DEX-frame nên tự bị loại).
- **D10 (symbol)** `token_info()` :173 bỏ negative-cache vĩnh viễn → retry có TTL (vd 60s) + hàng đợi mint chưa resolve; unresolved vẫn emit với `mint[:6]+"…"` và flag `symbol_pending` (không block). Thêm `DAI` vào GLOBAL_QUOTES (F3).
- **D11 (Q2 scaling)** Thêm `--rpc-url` (mặc định `RPC_HTTP`/`SOLANA_RPC_URL` env, fallback hằng số :48) áp cho cả HTTP :826 và WSS :886 (tự suy `wss://` từ `https://`); log khởi động in số ví + endpoint. Không auto-failover provider (ponytail: thêm khi 429 thật sự chặn vận hành).

## Scope IN
1. `scripts/wallet_watch.py`: `detect_swaps()` mới theo D2/D6/D7/D8/D9, wire vào `process_sig` :847, xoá `classify()` + `classify_swaps()`, drop TRANSFER_* (D3).
2. `_seen_add` dời sau fetch + retry/backoff (D4).
3. `token_info()` retry-TTL + `symbol_pending` (D10); GLOBAL_QUOTES + DAI.
4. `--rpc-url`/env cho HTTP+WSS (D11).
5. Fixture: copy `.omo/drafts/gmgn-parity-fixes-fixture/*` → `scripts/fixtures/` (29 row + 12 tx) làm oracle offline.
6. Tests: `scripts/test_gmgn_api_parity.py` mới (gate 29/29, 0 thừa, offline từ fixture); cập nhật `test_gmgn_parity.py` (GT paste cũ → regenerate/đối chiếu API trong window, row ngoài window flag), `test_route_detect.py`, `test_wallet_watch.py` sang detector mới; giữ seed `_sol_px/_info/_supply` offline (F19).
7. `scripts/backtest_parity.py`: replay sig lịch sử (`getSignaturesForAddress`, giới hạn) qua detector, in parity so với fixture khi window trùng; mặc định offline, không gọi GMGN (D5).
8. `scripts/gmgn_oracle.py` (tool **thủ công**, stdlib urllib): 1 call/ví, ≥5s giữa các call, in bảng rows; ghi rõ warning ban (F16/F17).
9. Deploy: scp watcher + fixtures/tests lên `/opt/wallet-watch/`, restart systemd, verify log mới không còn TRANSFER_* và row khớp GMGN mẫu; `make deploy` không ship scripts/ nên cần lệnh scp riêng trong plan.

## Scope OUT (Must NOT have)
- Không đưa GMGN vào hot path / watch loop / auto-track (chỉ oracle offline + tool thủ công).
- Không khôi phục `server/src/providers/gmgn.ts`, không dùng endpoint signed (`wallet_holdings`), không đổi `provider.ts` seam.
- Không đổi schema `wallet_trades`, không đụng server/FE/framework01 scoring/Nansen poller.
- Không gọi endpoint `signed`/pagination GMGN đã biết là bị reject (F16).
- Không thêm dependency Python mới (chỉ stdlib).
- Không hứa oracle cho tx cũ hơn ~4 ngày (không tồn tại nguồn đối chiếu, F16).
- Không auto-failover multi-RPC provider.

## Open questions
- Đã chốt hết: Q1 = RPC-only (D1) · Q2 = trả lời bằng số liệu (F20/D11), không cần fork mới · Q3 = bỏ TRANSFER (D3) · Q4 = fix-forward + backtest qua fixture (D4/D5) · Q5 = GMGN tooling nằm ở watcher Python, chỉ làm oracle thủ công (D1).
- Rủi ro còn lại (worker xử, không cần user quyết): thứ tự vault trong `accountKeys` như proxy cho pool mint-order (D7 rule 3/4) — nếu sai thì fallback lexicographic vẫn đúng 4/4 row fixture.

## Findings sau Momus review v1 (F21–F26 — tất cả đo offline trên fixture, không đoán)

- **F21 (LP fee không có trong payload):** oracle `token_amount`/`quote_amount` = `gross leg on-chain − LP fee của step`. Khớp exact 6/6 case đã verify: `58pWphuG` OS `1947084.2203146615 − 150899.027074389 = 1796185.1932402714` (oracle `1796185.193240272`); CARDS `6407.891356 − 12.977771 = 6394.913585`; `5XLTG1WX` ORE `9.5460692188 − 0.078843870 = 9.467225349019857`; `33hqSn4Q` XBT `102766.565214 − 4986.658789 = 97779.906425`; `3nzGD2WV` USDC `450.798346 − 0.909927 = 449.888419`; `3BbWVS3K` USDC `151.328066 − 0.363326 = 150.96474`.
- **F22 (4 cách tìm fee trong tx đều 0 hit):** balance deltas (vault nhận đúng gross), raw text JSON, base64 mọi field `data`/`accountData` (u64 LE/BE, u32 LE, ±1 đơn vị), base64 mọi `Program data:` log. Không `feeAmount`/`transferCheckedWithFee` nào mang con số này; token-2022 trong fixture chỉ có transferChecked thường ⇒ **exact net bất khả thi từ RPC**.
- **F23 (nguồn amount phải là parsed instruction, không phải balance delta):** row `33hqSn4Q sell XBT ← WBTC 638160.364952` — instruction raw `638160364952` khớp exact, còn delta balance của vault là `99683.5682570003`/`619015.5540030003` (XBT là token-2022 có transfer fee riêng). Đo toàn bộ 9 tx với nguồn instruction: **23/29 row exact cả hai phía**, 6 row lệch về gross (+0.2025%, +7.7500%, +0.8259%, +4.8524%, +0.2018%, +0.2401%).
- **F24 (fixture `token` KHÔNG có `decimals`):** chỉ `quote_token` mới có ⇒ mọi phép tính raw phải lấy decimals từ `pre/postTokenBalances[].uiTokenAmount.decimals`. Artifact rounding thật: row `58pWphuG sell OS ← CARDS 11033477.24844975` có raw `11033477248449752` ⇒ lệch **2 đơn vị raw** ở dec 9 (rel 1.8e-18) ⇒ gate phải so **rel 1e-6 trên uiAmount**, không được int-equal.
- **F25 (rule base/quote tất định, 29/29):** rank BFS theo tier — `TIER_A {WSOL, USDC, USDT, DAI} = 0.0`, `TIER_B {WBTC} = 0.5`, `+1` mỗi hop, **rank nhỏ = quote, rank lớn = base**, rank bằng nhau ⇒ lex nhỏ hơn là base + flag `quote_inferred`. Đo: TIER_A-only = 24/29; thêm WBTC ⇒ **29/29**, đúng **3** row inferred (các cặp OS↔CARDS ở `58pWphuG`, `3nzGD2WV`, `3BbWVS3K` — cả hai mint cùng rank 1.0; **đã sửa**: bản trước ghi "1 row" là sai, đo lại = 3). Rank ví dụ `4zmaV87B = {USDC 0.0, DOGE 1.0, SNOOPDOGE 2.0}`, `58pWphuG = {USDC 0.0, WSOL 0.0, CARDS 1.0, OS 1.0}`. ⇒ **xoá `LAUNCHPAD_PROGRAMS`** (phản bác thêm: row `stonkfun` chạy qua `LBUZ`/`CPMMoo8L`/`CAMMCzo5` = program Raydium/Meteora). Tiền lệ bug: mint WBTC **gõ tay** sai đuôi (`…mGRqojhxv8DNh…` bịa vs thật `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh`) ⇒ tụt 28/29 ⇒ phải build mint map từ fixture.
- **F26 (rule side per-step, 29/29):** role endpoint xác định bằng **dữ liệu balance**, không denylist — `WALLET` (owner == ví), `RELAY` (absent khỏi balances HOẶC net delta 0), `POOL` (còn lại). Yêu cầu cứng: leg hợp lệ có **đúng 1 endpoint POOL**; side = `BUY` nếu POOL là `src` (pool gửi base), `SELL` nếu POOL là `dst`. Đo trên 29 row: `POOL→WALLET 5, WALLET→POOL 7, POOL→RELAY 11, RELAY→POOL 6` = 29/29 exact, **0 ambiguous**. Hai rule sai đã đo để so sánh: "base chảy vào ví ⇒ BUY" = 18/29; không có khái niệm RELAY (chỉ ví/ephemeral pre==post==0) = 22/29 + 7 AMBIG. Bằng chứng cần per-step: `33hqSn4Q` cùng mint cbBTC cùng raw `1657105` nhưng 2 row ngược side — leg `#8 GJrFmC(POOL) → ExPLiW(CapuXN RELAY)` = BUY, leg `#9 ExPLiW → FWiLr7(HxA6SK POOL)` = SELL. RELAY đã gặp: `CapuXN…`, `ARu4n5…`, `BQ72nS…`, `GGztQqQ6…`, `GJrFmC…`, `9puaS8…` (absent khỏi balances, net-zero qua 6 leg DOGE: nhận `311170405711+867339085549` = gửi `1143696377958+285353388+34242406526+285353388`); **17/29 row có RELAY làm 1 endpoint** ⇒ mainline.
- **F27 (loại trừ logMessages):** `SwapEvent { dex, amount_in, amount_out }` + `Program log: Dex::<Name> amount_in:` chỉ có ở **2/9 tx** (route qua Jupiter) và `58pWphuG` có **5** SwapEvent vs **4** row oracle ⇒ không map 1-1, không dùng làm nguồn step.

## Findings sau Momus review v2 (F28–F30 — đo offline, đóng 3 blocker MB1–MB3)

- **F28 (MB1 — flag per-row là bất khả thi, rule plan v2 sai):** Đo lại sạch **theo từng mint** (bản đo trước của tôi lọc `post` theo mint nhưng không lọc `pre` ⇒ lẫn delta mint khác, kết quả vô nghĩa — đã bỏ). Kết quả: rule `|delta POOL endpoint| < qty ⇒ flag True` chỉ fire **1/6** row có phí; 5 row còn lại delta **bằng đúng gross**: CARDS acct38 `HeiMeC` Δ=`6407.891355999978`, OS acct32 `31kxrg` Δ=`1947084.2203146615`, ORE acct13/19 Δ=`∓9.5460692188`, USDC acct29 `5gxMGo` Δ=`151.32806600000004` / `450.7983459999996`. Row XBT fire **không phải** do LP fee mà do token-2022 transfer-fee (Δ=`99683.5682570003`/`619015.5540030003` — trùng con số ở F23). Nếu nới thành "quét mọi POOL account của mint đó" thì rule fire bừa **trên cả row exact** (`58pWphuG` CARDS acct13 Δ=`20291.65595900081`, acct23 Δ=`-26699.547315000033` đều ≠ gross của row fee). ⇒ **Không tồn tại tín hiệu per-row nào trong payload** (nhất quán với F22): field phải là **hằng số `amount_basis="gross_leg"` trên mọi event**, không phải bool per-row.
- **F29 (MB2 — WALLET literal trong plan v2 sai):** chuỗi plan gõ tay `FhsbQzAJWVDNwaH61cTo6XkkfEsmYMZKs9VJHH32bVG` = **43 ký tự**, thiếu 1 `S`; chuỗi thật **44 ký tự** (đọc bằng `DATA["rows"][0]["wallet"]`). Vi phạm chính constraint §5.7 ⇒ literal đã bị xoá khỏi plan, bắt buộc đọc từ fixture.
- **F30 (MB3 — shape fixture thật, đo bằng script 0/12 & 0/67):** tx JSON có **root `{blockTime, meta, slot, transaction, transactionIndex, version}`** và **không** có wrapper `result`; **không** `meta.loadedAddresses` (0/12), **không** `programIdIndex` (0/67) ⇒ 9 tx đều legacy, `instructions[].programId` là chuỗi. 12 file → 9 sig; 3 cặp trùng (`4zmaV87B*`, `33hqSn4Q*`, `58pWphu*`) **byte-identical** (sha256 `55fe63dc…`/`58562576…`/`c335708d…`) ⇒ dedupe theo `transaction.signatures[0]` an toàn. Rows fixture: root `{source, caveat, tx_key, rows}`, row key thật là `tx_hash` (không `sig`), `event_type` (không `side`), có `launchpad`/`launchpad_platform` (chỉ là nhãn GMGN, cấm dùng — F25). Fixture **không** chứa USDT/DAI (symbols đo được: `CARDS, DOGE, JUDE, ORE, OS, SNOOPDOGE, SPCX, STEVE, USDC, WBTC, WSOL, XBT, cbBTC`).

## Findings sau Momus review v3 (F31–F32 — tôi tự đo lại offline, gồm cả việc bác 1 nit của Momus)

- **F31 (BLOCKER round 3 — `quote_inferred == 3` là SAI, đúng là 1):** chạy rank-BFS **đúng spec plan §3 Bước 4** (TIER_A {WSOL,USDC}=0.0, TIER_B {WBTC}=0.5, `rank[y]=rank[x]+1`, seed theo rank tăng dần, tie ⇒ lex-nhỏ-hơn = base + flag) trên 29 pair oracle, **per-tx**: base/quote exact **29/29**, nhưng tie chỉ xảy ra ở **1** row = `58pWphuG sell OS ← CARDS`. Rank do được: `58pWphuG = {USDC 0.0, WSOL 0.0, CARDS 1.0, OS 1.0}` (tie vì tx này có cạnh OS↔WSOL); `3nzGD2WV = 3BbWVS3K = {USDC 0.0, CARDS 1.0, OS 2.0}` ⇒ 2 row OS↔CARDS còn lại giải bằng **rank-difference** (2.0 > 1.0), `quote_inferred = False`. `base == OS` vẫn đúng trên **cả 3** row. Kèm số đo phụ: **`TIER_A-only = 25/29`** (bản trước ghi 24/29 — sai, Momus đúng).
- **F31b (2 nit số học đã đo lại):** (i) raw thật của row OS là `11033477248449751` — grep `58pWphuG.json`: `…751` = **3 hit**, `…752` = **0 hit**, `…750` = **0 hit** ⇒ artifact là **1** đơn vị raw ở dec 9, rel `9.06e-17` (bản trước ghi 2 đơn vị / 1.8e-18 — sai; kết luận về tolerance rel 1e-6 không đổi); (ii) row ORE: fixture lưu **string** `9.46722534902`, phép trừ float cho `9.467225349019857` (rel 1.5e-14 ≪ 1e-6) ⇒ nói "khớp tới chữ số cuối" là quá lời, đã sửa thành `≈` + ghi chú artifact.
- **F32 (nit #2 của Momus BỊ BÁC — Momus đo sai, không phải plan sai):** Momus khai delta USDC `151.32806600000004` "không tái lập được" trong `3BbWVS3K` (nó thấy acct29 Δ=`+851755.31892`). Nguyên nhân: nó pair `preTokenBalances`/`postTokenBalances` **theo vị trí list** (`zip`), trong khi Solana pair theo field **`accountIndex`** — hai list có tài khoản được tạo/đóng giữa tx (ATA mở mới) nên vị trí lệch nhau. Đo lại theo `accountIndex`: `3BbWVS3K` acctIndex 29 owner `2N1KNu` Δ = **`151.328066`** ✓ (cùng phép đo zip-positional cho **0 hit**); `3nzGD2WV` acctIndex 29 owner `2N1KNu` Δ = **`450.798346`** ✓. ⇒ §3 Bước 5 của plan giữ nguyên. Hệ quả **củng cố** MB1: row **có** LP fee vẫn có delta = gross ⇒ rule per-row của v2 cho `flag=False` trên row cần flag (lại thêm 1 bằng chứng không có tín hiệu per-row).**Bài học cho worker/reviewer: mọi phép tính delta balance phải group theo `accountIndex`, không bao giờ `zip` theo vị trí.**
- **F33 (Momus round 3 xác nhận CLOSED, tôi đối chiếu lại):** MB1 (scan plan: `amount_basis`×21, `gross_leg`×15, `amount_includes_lp_fee` chỉ còn 1 lần ở changelog; ban explicit ở §2.3/§3-B5/T2), MB2 (wallet fixture 44 char `FhsbQz…2bVG` **không** xuất hiện trong plan; 0 literal nào khớp exact/edit-distance-1; 3 literal không thuộc fixture đúng là USDT/DAI/wETH được phép), MB3 (root keys 12/12, `result` 0/12, `loadedAddresses` 0/12, `programIdIndex` 0/67 top-level & 0/347 kể cả inner, 9 sig, 3 cặp byte-identical, rows root đúng, `tx_hash` 29/29 không `sig`, `event_type` 29/29 không `side`, `token.decimals` 0/29 vs `quote_token.decimals` 29/29), mutation #4 (XBT deltas raw `99683568257`/`619015554003` dec 6 tòn tại; raw `638160364952` tòn tại; row target là non-`G` ⇒ mutation fail ở rel 1e-6), USDT/DAI vắng mặt, T2 logging, và **oracle table §2.3 MATCH 29/29** (multiset trên 6 field số + per-sig counts + đúng 6 `G` marker).

## Quyết định mới

- **D14 (owner chốt, 2026-09-15):** Với step có LP fee, detector emit **GROSS** + flag `amount_includes_lp_fee`; **không** decode fee per-DEX. Gate = 29/29 exact cho `side` + `base/quote symbol` + số step, amount exact tuyệt đối trên 23 row không phí, 6 row còn lại phải `gross ≥ oracle`, `rel_overstate ≤ 8%`, và có flag `True` (row không phí phải `False`). Lý do từ chối các nhánh khác: (B) decode per-DEX cần `getAccountInfo` + layout từng program, mâu thuẫn comment L461-470, fee đã chứng minh không trong payload; (C) chỉ làm riêng Meteora DLMM ⇒ logic rẽ nhánh theo program id, vẫn cần layout; (D) gross không flag ⇒ sai lệch vô hình, vi phạm fail-loud.
- **D15:** base/quote dùng rank rule F25; xoá `LAUNCHPAD_PROGRAMS` và field `launchpad` trong event dict (thông tin program đã ở field `program`).
- **D16:** side dùng role-direction rule F26; không dùng ví làm mốc.
- **D17:** Cấm hardcode mint/address/WALLET bằng tay trong code và test — build từ fixture (tiền lệ F25, F29).
- **D18 (refine D14, không đổi ý owner):** phần "flag" của D14 được hiện thực bằng **field hằng `amount_basis="gross_leg"` trên mọi event** thay vì bool per-row — vì F28 chứng minh không có tín hiệu per-row để suy. Vẫn đúng tinh thần D14: emit gross, gắn nhãn rõ ràng, fail-loud (consumer biết net của GMGN có thể thấp hơn đúng LP fee, ≤ 7.75%), không decode fee per-DEX. Gate không đổi: 29/29 `side`/`base-quote`/step-count, amount exact rel 1e-6 trên 23 row, 6 row `gross ≥ oracle` + `rel_overstate ≤ 8%`. Cấm suy `amount_basis` từ `G` marker §2.3 / `dex_native` / `launchpad` / `price` — những thứ đó chỉ tồn tại trong test oracle.

- **D19 (pin công thức gate, từ nit #3 của Momus):** `rel_overstate = (emitted − oracle) / emitted` — mẫu là **gross** mà detector phát, khớp đúng các số % đã in trong bảng §2.2 (max `7.7500%`). **Cấm** dùng mẫu = oracle: row OS sẽ tính ra `8.4011%` > ngưỡng 8% ⇒ fail giả trên code đúng, và worker bị kẹt vì §5.6 cấm nới tolerance. Đồng thời chốt: `quote_inferred` count trong gate = **1**, còn `base == OS` assert trên **cả 3** row OS↔CARDS (F31).

## Approval gate
status: approved
<!-- Round 1 REJECT (3 blocker) — đóng ở v2: B1 → F21/F22/F23 + D14; B2 → F26; B3 → F25.
     Round 2 REJECT (MB1 flag rule, MB2 wallet literal, MB3 fixture shape + 4 note) — đóng ở v3: F28 + D18, F29, F30 + plan §2.5.
     Round 3 REJECT (1 blocker: `quote_inferred == 3` sai ⇒ detector đúng vẫn fail gate, deadlock với §5.6; + 6 nit) — đóng ở v4: F31 (đo lại = 1, TIER_A-only 25/29), F31b (raw …751 / rel 9.1e-17; ORE artifact), D19 (pin `rel_overstate` mẫu = gross), header drift; nit #2 BÁC bằng F32 (Momus pair balances theo vị trí thay vì `accountIndex`).
     Round 4: **APPROVE** (session `ses_f5bf4477effefC8ZuZVogOV2pH`, 0 blocker). Momus tự đo lại: BFS rank base/quote 29/29, `quote_inferred` = 1 (chỉ `58pWphuG`), `base == OS` 3/3 row, TIER_A-only 25/29; THU HỒI nit #2 round 3 (zip positional = 0 hit; `accountIndex` 29 → `3BbWVS3K` raw `151328066`/ui `151.32806600000004`, len_pre 15 vs len_post 16; `3nzGD2WV` raw `450798346`) ⇒ §3 Bước 5 + F28 đứng vững; 8 raw delta Bước 5 tái lập đủ; D19 xác nhận `0.0775/0.9225 = 8.4011%` là fail thật trên mẫu oracle; §2.3 multiset 29/29 = True, G = 6, split 23/6; fixture shape đóng băng (root 12/12, `result` 0, `loadedAddresses` 0, `programIdIndex` 0/67 & 0/347, 9 sig, 3 cặp byte-identical).
     2 nit non-blocking đã áp vào plan: (i) L3 header `D1–D18` → `D1–D19` + status APPROVED; (ii) §2.2 intro bỏ "khớp tới chữ số cuối" → `~1e-14` + artifact note.
     Plan hiện hành: .omo/plans/gmgn-parity-fixes.md (v4, APPROVED). Bước tiếp: **user** chạy `/start-work` — Prometheus không implement. Evidence: .omo/evidence/gmgn-parity-fixes/round4-momus-approve.md. -->
