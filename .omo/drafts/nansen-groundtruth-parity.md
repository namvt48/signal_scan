---
slug: nansen-groundtruth-parity
status: awaiting-approval
intent: clear
review_required: false
classification: Standard
pending-action: write .omo/plans/nansen-groundtruth-parity.md
approach: >
  Build a replay-by-signature parity harness that treats .probe/nansen-24h/tx-sample.jsonl (990 Nansen
  rows = 733 unique sigs) as ground truth, replays each sig through the EXISTING network-free detector
  wallet_watch.detect_swaps(tx, wallet), aggregates per (sig, wallet, mint, side), compares signed net
  token amount + USD (price-drift-aware), classifies every expected record, then runs a phase-2 pass over
  the null-field rows and a reasonableness assessment. **UPDATED (Option A, user-approved): detector DOES
  change** — leg phí được emit thành event SELL có đánh dấu (xem D9); phần còn lại vẫn verify-only.
---

# Draft: nansen-groundtruth-parity

## Components (topology ledger)
| id | outcome (one line) | status | evidence path |
|---|---|---|---|
| C1 | Ground-truth loader/normalizer: tx-sample.jsonl -> expected records per (sig, wallet, ca, side), NUL strip, null-row deferral bucket | active | .probe/nansen-24h/tx-sample.jsonl |
| C2 | On-chain replay fetcher: getTransaction per unique sig, RPC fallback list, fixture cache, UNAVAILABLE class | active | scripts/backtest_parity.py:157 |
| C3 | Detector invocation + event aggregation: pure detect_swaps(tx, wallet) -> signed net qty + quote_usd per (sig, wallet, mint, side) | active | scripts/wallet_watch.py:827-900 |
| C4 | Comparator + verdict + price-drift analysis: MATCH / AMOUNT_OFF / USD_OFF / TYPE_MISMATCH / MISSING / EXTRA / UNAVAILABLE / DEFERRED_NULL | active | scripts/test_gmgn_api_parity.py:53-54 |
| C5 | Report + phase-2 (revisit null rows) + reasonableness assessment written as evidence md | active | .probe/EVIDENCE-2026-09-21-door2500-server-verify.md |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| How to obtain WW detections for a PAST window | D1 replay-by-signature: fetch getTransaction(sig) then call detect_swaps | wallet_watch has NO time-window and NO CA filter (live-only feed); detect_swaps is network-free so sig replay is exact and deterministic | yes |
| Match granularity | D2 aggregate per (sig, wallet, mint, side); never 1:1 row match | 205/733 sigs have >1 Nansen row (max 5 legs) AND WW emits 1 event per hop; 1:1 produces false mismatches (prior lesson: "cách so sai") | yes |
| Old txs unavailable on free RPC | D3 probe first; UNAVAILABLE is its own class, NOT a detector failure; if >20% of sigs unavailable, rebuild the sample from the freshest crawl files (tx <=2h) and rerun the same harness | oldest ground-truth tx is 34.1h old; mainnet-beta retention ~2d; crawl is still running at /root/signal_scan/tmp/door2500 | yes |
| USD basis differs (tx-time vs today's DexScreener price) | D4 two-level: report raw ratio distribution AND residual after removing ONE global price-drift factor; gate on residual | WW quote_usd is priced at detection time (DexScreener), Nansen usdValueAtTxTime at tx time; a single consistent factor = price basis, not a bug | yes |
| Comparison target | D5 detector events (detect_swaps), NOT server DB rows | wallet_trades has no qty column, side only ('buy','sell'), and wp4tTransactionsToActivities keeps ONLY txType==='buy' -> sells/transfers never persist | yes |
| Artifact layout | D6 .probe/nansen-parity/{report.md,parity.jsonl,fixtures/} + one EVIDENCE md | repo convention for probe output + evidence | yes |
| Amount basis | D7 primary = qty_net (wallet net delta), secondary bucket = qty (gross leg) | Nansen directionalAmountOfTokens is the wallet's signed token movement; qty_net is its WW equivalent; token-2022 fee makes gross = net x 100/99 | yes |
| File placement / test style | D8 scripts/nansen_parity.py + offline fixture self-check scripts/test_nansen_parity.py, plain stdlib asserts, no pytest | repo has no pytest/requirements; every existing test is `python3 scripts/test_*.py` | yes |
| Fee-leg labeling (Option A — post-Metis, measured) | D9 detector emits ONE extra event per qualifying leg: `side="SELL"`, `type="SWAP"`, `"fee_leg": True`, `amount_basis="gross_leg"`. Qualify = (a) out-leg from tracked wallet, (b) `rd != "POOL"`, (c) same tx has a step `side=="BUY"` of the SAME mint, (d) leg unpaired. Capture point = side-channel at the reject inside `_legs_with_roles` (:636-644 aggregator_frame/plumbing, :645-648 no_pool_endpoint) — legs never reach pairing. When emitted, the BUY's `qty_net` switches to gross via `n_mint_adj = net_map[M] + Σ fee_out[M]` so `Σ signed qty_net == _net_owner(M)` (<1e-6); fee event prices inherit the same-mint BUY step's `unit_price`. GMGN gate + backtest gate filter `fee_leg`-marked events (never bump `EXPECT_COUNT`). | Nansen counts fee legs as sell rows; GMGN deliberately does not (`test_wallet_watch.py:10-13`) ⇒ the two oracles diverge by design, hence the marker + filter. Measured: fee leg in `48Y3e48T4z…` dies at `aggregator_frame` (`encl=JUP6LkbZbjS1…`), BUY `qty_net=48881.855420` already fee-netted (naive add ⇒ 48832.92 ≠ chain net); `3fec2kXP.json` dust legs are WALLET→POOL (0.0242%/2.9056%/0.0242%) ⇒ excluded by (b), keeping `EXPECT_COUNT=2`; transfer tx `5fgRuKgt…` has no steps ⇒ excluded by (c); DIFFCA `RxrDxxL2…` unpaired `3ZLekZYq` (0.50%, steps are SELL) ⇒ excluded by (c). Ratio thresholds cannot separate these (0.099–0.5% vs 0.0242–2.9%) ⇒ structural discriminator only. Fee-USD measured −9.6% vs Nansen ($0.127 vs $0.1405) ⇒ fee rows gated at 15%, listed separately. | yes |

## Findings (cited - path:lines)
- Ground truth shape: 990 rows, **733 unique sigs**, **752 unique (sig, wallet, ca, txType)** groups, 205 sigs with >1 row (max 5), 183 unique (wallet,ca) pairs, 66 wallets, 105 CAs. txType: buy 481 / sell 209 / transfer 300. (measured this session over .probe/nansen-24h/tx-sample.jsonl)
- Nulls: `txSignerAddress` null in **990/990 (100%)** -> unusable, skip. `usdValueAtTxTime` null in **13 rows** (10 buy + 3 sell) -> the phase-2 deferred set. `usdValueCurrent` null 212 (not compared). usd present 977/990, min 0.0, median 146.66, max 45845.17.
- tx age: newest **1.2h**, oldest **34.1h**; window 2026-09-20T17:39:10Z -> 2026-09-22T02:31:55Z (now 2026-09-22T03:43Z) -> RPC retention risk is real but mostly inside 2 days.
- Detector is replayable: `detect_swaps(tx, wallet)` network-free (scripts/wallet_watch.py:827-900); precedents scripts/wallet_hist.py:79 and scripts/backtest_parity.py:157 `_fetch_tx(sig)`.
- Detector event schema (scripts/wallet_watch.py:801-823): sig, slot, wallet, side BUY/SELL, mint, sym, qty (gross leg), quote_mint, quote_sym, quote_qty, quote_usd, qty_net, unit_price, pool, program, amount_basis='gross_leg', quote_inferred, symbol_pending, usd_pending, type='SWAP', + step/n_steps (:891) + ts_epoch_ms (:1263). RECEIVE variant :1132-1159 (side='RECEIVE', type='RECEIVE', quote_usd=None). OTC fill variant :1096-1123.
- wallet_watch is live-only: feeds at :1354-1429 (ws), :1461-1513 (block), :1334-1351 (poll); `--once` = one live tick, `--backfill N` = N most-recent sigs, `--block-backfill N` = N slots behind tip. No `--from/--to`, no `--ca` (:1518-1592). Historical wallet+window replay exists only in scripts/wallet_hist.py:40-85 (no CA filter).
- Field mapping: Nansen `directionalAmountOfTokens` (signed per leg; buy > 0, sell < 0) <-> WW signed net `+qty_net` (BUY) / `-qty_net` (SELL) summed per (sig, wallet, mint). Nansen `usdValueAtTxTime` (USD of the TOKEN leg at tx time) <-> WW `quote_usd` = quote_qty x price from DexScreener **at detection time** (scripts/wallet_watch.py:385-418, :785-792).
- Known amount bias: token-2022 transfer fee -> gross/net ratio exactly 100/99 = +1.01%, min==max over 6/6 cases (.probe/EVIDENCE-2026-09-21-walletwatch-onchain-verify.md:38-56). GMGN gate tolerances: REL_TOL=1e-6, GROSS_CAP=0.08, observed overstate 0.20%-7.75% because RPC cannot see the LP fee (scripts/test_gmgn_api_parity.py:53-54; docs/2026-09-15-gmgn-parity-and-block-feed.md:27-69).
- Known price-basis divergence: WW implied SOL ~$99.25 vs Nansen $64.02-$103.94 (.probe/REQ-wallet-watch-complete-ledger.md §4.2/§5.4) -> justifies D4.
- **9 group buy+sell KHÔNG phải round-trip**: cả 9/9 có `sell/buy` nằm trong bucket **≤1%** (0.099% / 0.100% / 0.200% / 0.500% — đúng dạng 10/20/50 bps), USD leg-out chỉ $0.03-$2.91 so với leg-in $32-$1456 (48Y3e48T4z 48,930.79↔48.93 · 47HyTMRsA5 221,984.25↔443.97 · FAb1wuVXNV 36,988.16↔184.94 · 45wg2jDQpj 1,381,098.38↔6,905.49 · 4MUWW6C21v 173,567.33↔171.83 · w2GuZTjKeQ 80,711.91↔80.71 · 5KPh5AyNPL 7,281.64(2 leg)↔7.21 · 51WLgoxirD 7,390.10↔7.32 · 3P4fJC3n2x 26,623.12↔26.36). Cấu trúc: 1 leg IN lớn từ pool -> ví + 1 leg OUT tí xíu ví -> địa chỉ khác (mỗi ca một địa chỉ: 3CgvbiM3, 6Gfahmxq, DSN3j1yk, HFqp6ErW, GP8StUXN, 3LoAYHuS, 7iWnBRRh). Nansen gán nhãn theo CHIỀU tiền của từng leg trong 1 tx atomic, không theo ý định giao dịch. Giả thuyết: phí token-2022/router thu bằng token (10/20/50 bps) -> fee authority/vault; **chưa xác định được program nếu chỉ nhìn data Nansen -> PHASE-2 dùng chính `getTransaction` đã fetch để gọi tên program của 9 leg-out này**. Hệ quả: R1 netting là bắt buộc (WW `qty_net` = net delta ví nên tự trừ leg phí); 9 group này là ca khó nhất của R2 (phải có CẢ buy và sell); rủi ro sản phẩm nếu coi mọi nhãn `sell` là bán thật -> sell-alert giả từ leg $0.03 (tiền lệ cùng loại: entry_usd lấy từ leg SELL, .probe/EVIDENCE-2026-09-17-inflow-holding-4ca.md:118-124). **KIỂM CHÉO (bác giả thuyết fee-vault per-mint)**: 7 địa chỉ nhận KHÔNG phải vault riêng theo mint — dùng chung cho nhiều CA (3CgvbiM3 phục vụ Ai66LHZG/3z2tRjNu/DVska6Y1/ZesMGYmo; GP8StUXN phục vụ Ai66LHZG/purpFPo5/3ZLekZYq/6GmAFSYs; 6Gfahmxq phục vụ PerPsCe2SJ7Q/739dnZEG/ZesMGYmo; 7iWnBRRh phục vụ 4UHmZGe6/Ai66LHZG/ZesMGYmo; DSN3j1yk phục vụ 6GmAFSYs/7ssJZGFT/PEPEqnuu; 3LoAYHuS phục vụ Ai66LHZG/ZesMGYmo; HFqp6ErW phục vụ Ai66LHZG/FFgjwTgf), gần như luôn ở vai trò `counterpartyAddress`/`toAddress` của row `sell` (GP8StUXN có 1 row `buy` làm fromAddress cho purpFPo5) ⇒ đây là VÍ ĐANG GIAO DỊCH DÙNG CHUNG (bot/router/MEV/fee wallet), KHÔNG phải transfer-fee vault per-mint. Overlap với 254 group transfer-only = **0** ⇒ leg-out được phân loại là chiều RA (`sell`), không phải `transfer`. Tỉ lệ 0.099-0.500% ≈ 10/20/50 bps (2 ca khớp chính xác 1/1000: `48.9307862 = 48930.78620605/1000`, `80.711908 = 80711.908049/1000`) ⇒ dạng PHÍ theo % thu bằng chính token. Chốt program cần on-chain -> phase-2.
- Số nền còn lại: tổng sell/buy toàn sample = **33.97%**; **134 group sell-only = bán thật**.
- **Mức SIG (bỏ wallet/ca): 17/733 sig mang cả buy+sell** = 9 `SAME_WALLET_SAME_CA` (leg phí 0.099-0.5%, đã bóc ở bullet trên) + 8 `SAME_WALLET_DIFF_CA` (SWAP THẬT: bán mint A -> mua mint B, hai chiều USD cùng bậc: RxrDxxL2 36.73<->29.04 · 5WxwFDpx 10.53<->11.25(+dust 0.056) · 42JFMWoc 275.48<->291.79(+phí 0.29) · 5AFpPgjm 1817.81<->1846.49(+phí 1.85) · 2KgXBXJr 2002.66<->1846.49(+phí 1.85) · 2KQw8xfK 1281.03<->1373.84(+phí 1.38) · 3nRnfqK1 4027.57<->4729.24(+phí 4.73) · 4tetyqAq 914.95<->915.89(+phí 0.92)), và **0 ca DIFF_WALLET**. Với grouping `(sig,wallet,ca)` mỗi swap tách thành 1 group sell-only (mint bán) + 1 group buy-only (mint mua) **trong cùng 1 sig** ⇒ ca kiểm chéo detector phải emit CẢ `SELL` (mint A) và `BUY` (mint B) trên cùng tx; phần phí là leg-out thứ hai cùng mint. **CHƯA có artifact nào ghi nhận wallet_watch TỰ detect**: `.probe/out.jsonl` (532,261 B) là output Nansen `tgm-essential-data`, 0 event; `tx-sample.{json,jsonl}` chỉ chứa nhãn `txType` của Nansen ⇒ con số "WW detect 1 sig ra cả buy+sell" là **DỮ LIỆU CHƯA ĐO**, do harness sinh ra (không được lẫn 2 nguồn).
- txType taxonomy gap: WW has NO 'transfer' type. Inbound plain receipt -> type=RECEIVE/side=RECEIVE (:1132-1159); outbound plain transfer -> no event at all. Emit filters also drop failed tx (:833), major<->major conversions (:846-850), phantom pump wflat hop (:861-871).
- Join key = Solana signature; Nansen `transactionHash` can carry trailing \u0000 -> strip (.probe/normalize_door.py:23; .probe/EVIDENCE-2026-09-21-door2500-server-verify.md:52-53,153).
- Server persistence is NOT a valid comparison target: wallet_trades(id, wallet_id, ca, ts, side CHECK in('buy','sell'), amount_usd, price, tx, source, UNIQUE(wallet_id,ca,tx,side)) with NO qty/type/leg columns (server/src/db.ts:147-160); insert at server/src/ingest.ts:263-273; wp4t mapping keeps only txType==='buy' and derives price=amountUsd/qty, discarding qty (server/src/providers/nansen.ts:128-149).
- Prior real bug this harness re-measures: min_usd=$50 gate dropped 100/100 Nansen buys ($4.88-$49.19) (.probe/EVIDENCE-2026-09-21-walletwatch-onchain-verify.md:69-76). Current split: detect gate = 0, $50 gates ADD-CA only (.probe/REQ-wallet-watch-complete-ledger.md:228; server/src/api.ts:363-370). Detector never reads min_usd for emission (scripts/test_wallet_watch_config.py:171-178).
- Repo test convention: plain stdlib assert scripts, no pytest/requirements/pyproject; run `python3 scripts/test_*.py`; fixtures under scripts/fixtures/ (json + pkl).

## Decisions (with rationale)

### Denominator đã đo (chốt từ tx-sample.jsonl)
- **743 group** `(sig, wallet, ca)` = đơn vị so sánh: buy-only **346** · transfer-only **254** · sell-only **134** · buy+sell **9**.
- Positive assertion: **355** group chứa buy, **143** group chứa sell.
- Negative assertion (theo Q1): **254** group transfer-only.
- **733 sig** phải fetch `getTransaction`. **13** group có row `usdValueAtTxTime` null → phase-2.

### Quy tắc so sánh (R1-R9)
- **R1 grouping + net identity**: expected net token = `sum(directionalAmountOfTokens)` over **MỌI row** trong group (buy+sell+transfer), vì `qty_net` của WW = net delta của ví cho mint đó trong tx (`scripts/wallet_watch.py:797-800`, `_net_owner` :1044-1054). So với `sum(signed qty_net)` của WW, signed = `+qty_net` nếu BUY else `-qty_net`.
- **R2 positive side**: group chứa buy → WW phải có ≥1 event `side=BUY, mint=ca`; chứa sell → ≥1 `side=SELL`. Thiếu = `MISSING` (FAIL).
- **R3 negative assertion (Q1, nguyên văn user)**: "nếu tx mà gán nhãn là transfer thì wallet watch sẽ **không được detect là buy hoặc sell**". Group transfer-only → WW **không được** có event BUY/SELL cho mint đó; **không có event = PASS** (đã xác minh: `detect_swaps` KHÔNG bao giờ trả `RECEIVE` — `_recv_event` :1126-1159 chỉ được gọi từ `_target_event` :1162-1198 ← `_handle_tx` :1286, nên ở tầng harness chỉ có thể là zero event); có BUY/SELL = `TRANSFER_FALSE_POSITIVE` (FAIL). **Sau Option A rule này vẫn nguyên vẹn**: fee leg chỉ được promote khi tx có step `side=BUY` cùng mint ⇒ tx transfer (không có step) không thể nào promote (đã đo: `5fgRuKgt…` events=0, `same_mint_as_buy_step=False`). Đường transfer/RECEIVE **không bị sửa**.
- **R4 USD per-side, drift-aware**: expected = `sum(usdValueAtTxTime)` chỉ trên row **cùng txType** với side đang so (row transfer **loại khỏi** gate USD vì WW RECEIVE có `quote_usd=None`); actual = `sum(quote_usd)` các event cùng side. Gate theo **residual ≤10% sau khi trừ MỘT hệ số trượt giá toàn cục** (median ratio); in kèm phân bố ratio thô p50/p90/max. Lý do: `quote_usd` định giá bằng DexScreener **lúc detect** (:385-418), Nansen là **lúc tx**.
- **R5 amount 2 tầng**: chính = net identity R1, `rel ≤1.5%` (bao phí token-2022 100/99 = +1.01%); phụ = per-side gross `sum|directionalAmountOfTokens|` vs `sum(qty)`, bucket `≤8%` = `GROSS_CAP` sẵn có (`scripts/test_gmgn_api_parity.py:53-54`) vì RPC không thấy LP fee (`docs/2026-09-15-gmgn-parity-and-block-feed.md:27-69`).
- **R6 null**: row có `usdValueAtTxTime` null → **skip gate USD** cho group đó, vẫn gate type+amount; group bị đánh dấu `DEFERRED_USD_NULL` (13) và được **quay lại ở phase 2**. `txSignerAddress` null 990/990 → **không so**. `usdValueCurrent`/`usdValuePctChangeToDate` → không so.
- **R7 UNAVAILABLE**: RPC không trả tx → class riêng, **loại khỏi denominator PASS/FAIL**, chỉ đếm. Nếu **>20% của 733 sig** unavailable → dựng lại sample từ file crawl mới nhất (crawl 2500 vẫn đang chạy) rồi chạy lại harness (D3).
- **R8 PASS bar**: `TYPE_MISMATCH = 0`, `TRANSFER_FALSE_POSITIVE = 0`, `MISSING = 0`, amount trong R5, USD residual trong R4 — trên **mọi group available**. "tx type phải chuẩn" ⇒ strict 100%, không có ngưỡng dung thứ cho type.
- **R9 root-cause cho mọi ca không MATCH**: mỗi group FAIL phải được gán nguyên nhân từ đúng điểm lọc của detector: failed tx (:833), major↔major (:846-850), phantom pump wflat (:861-871), không có pool leg → RECEIVE (:1132-1159), RPC unavailable, hoặc **lỗi detector thật**. Đây là nguyên liệu cho "đánh giá hợp lý" ở phase 2.
- **Test strategy (Q3)**: **TDD** — viết `scripts/test_nansen_parity.py` (comparator: netting, signed side, drift factor, phân loại R2/R3/R6/R7) trên fixture trước → RED, rồi mới viết `scripts/nansen_parity.py` → GREEN. Style assert thuần, chạy `python3 scripts/test_nansen_parity.py`, không pytest.

## Scope IN
- Parity harness comparing Nansen ground truth (tx-sample.jsonl) against `wallet_watch.detect_swaps` output for the same sigs.
- Fields compared: signed token amount (directionalAmountOfTokens vs qty_net/qty), USD (usdValueAtTxTime vs quote_usd, drift-aware), txType vs side/type, ca vs mint, wallet vs wallet.
- Null-field rows: skipped in phase 1, revisited in phase 2, then a written reasonableness assessment.
- Offline fixture self-check so the comparator logic is provable without network.
- Evidence markdown + machine-readable parity.jsonl.

## Scope OUT (Must NOT have)
- No change to server DB schema, no new wallet_trades columns, no change to wp4tTransactionsToActivities.
- No change to the running 2500-pair Nansen crawl or the door/proxy workstream (.omo/plans/nansen-proxy-routing.md).
- No re-architecture of wallet_watch feeds; no new --from/--to CLI unless Q1/Q2 answers require it.
- No dashboard/UI work, no deploy of /opt/wallet-watch (that is đợt 2, separate).
- No GMGN/Birdeye/Helius provider integration.
- No pytest/uv/requirements introduction.

## Open questions — RESOLVED, không còn fork mở
- **Q1 transfer** → user: "nếu tx mà gán nhãn là transfer thì wallet watch sẽ không được detect là buy hoặc sell" ⇒ negative assertion (R3). **UPDATED**: sau đó user chọn **Option A** (sửa detector để emit fee leg = SELL cho khớp Nansen) ⇒ detector CÓ thay đổi, nhưng đường transfer thì KHÔNG — R3 vẫn là negative assertion, được bảo vệ bằng điều kiện "phải có step BUY cùng mint" + yêu cầu 254 group transfer-only ra đúng 0 event.
- **Q2 ngưỡng** → user chọn: amount `rel ≤1.5%` + bucket gross `≤8%`; USD `residual ≤10%` sau khi trừ một hệ số trượt giá toàn cục (R4/R5).
- **Q3 test** → user chọn: **TDD**, viết test comparator trước.

## Approval gate
status: awaiting-approval
plan: `.omo/plans/nansen-groundtruth-parity.md` — WRITTEN (8 todos, 6 waves). Metis gap analysis DONE (17m42s): 3 blockers + 4 majors, all folded; blocker #1 (draft said "no detector change") fixed by D9 + R3/Q1 updates above; blocker #2 (naive discriminator breaks GMGN 29/29 via `3fec2kXP`) fixed by `rd != "POOL"` + BUY-step condition + gate filter; blocker #3 (fee leg dies at `aggregator_frame`, not at pairing) fixed by side-channel capture point. 4 majors folded: qty_net gross switch (<1e-6 identity), fee-USD pricing + 15% gate + `wallet_hist.py:106,114-115` None-risk deferred to phase-2, RPC pinned to `api.mainnet-beta.solana.com` + root-level cache format, root-cause bound to captured `reject_trace`.
next workflow action: chờ user okay → worker session chạy `$start-work` (Prometheus KHÔNG implement); hoặc user yêu cầu high-accuracy review trước (review_required=false).
<!-- set to awaiting-approval once Q1-Q3 are answered -->
