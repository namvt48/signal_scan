# Plan: wallet-watch — 100% tx-level detection (buy/sell/transfer) + giảm RPC

Goal: mọi tx **đã nạp** mà ví thực sự đổi số dư một mint ⇒ **luôn** có event được
phân loại (swap / transfer), không bao giờ im lặng bỏ. Amount chỉ cần xấp xỉ.
Đồng thời cắt số call RPC.

Nguồn chân lý: `pre/postTokenBalances` trong chính payload `getTransaction` đã gọi
(chain net-delta). **Nansen KHÔNG phải oracle** — đã đo: lệch qty >5% ở 209/668
rows (31%), lệch side ở 10 rows. Chain delta exact: `qty_net` có dấu khớp net ví
tới p95 1.75e-16, max 0.5%, 0/662 rows >5%.

## Trạng thái đo được (P1 xong — `.probe/program-decoder/coverage_report.json`)

| side | rows | moved | present | presence |
|---|---|---|---|---|
| buy | 425 | 425 | 423 | 99.5% |
| sell | 243 | 243 | 239 | 98.4% |
| transfer | 1995 | 1793 | 69 | **3.8%** |
| **TOTAL** | 2663 | 2461 | 731 | **29.7%** |

202 row `transfer` còn lại có net ví = 0 ⇒ **Nansen nhiễu, không phải mất tx**:
188 ví đứng yên (pre==post, không account nào đổi), 14 ví không có balance row cho
mint đó. Không có ca round-trip nào. ⇒ **Mẫu số D1 = 2461**, 202 loại trừ có ghi lý do.

## Quyết định chốt từ Oracle (bg_0a859af5, ses_f26cbb052ffeNbkkD33blJ4QIx)

Predicate cho fallback net-delta = **gated net-delta**, đặt **sau `_pair_steps`**
(không đụng đường pairing ⇒ oracle per-step 29 row không rủi ro). Với mint `M`:
1. `M ∉ majors` (TIER_A ∪ TIER_B) **và** `wallet_net[M] ≠ 0` **và** chưa có built
   event cho `M` (chống double-count).
2. **GATE QUYẾT ĐỊNH (giết constraint A)**: `M` phải "swap-anchored":
   tồn tại leg `M` trong `legs` với `encl ∈ _SWAP_PROGRAMS`, **hoặc** candidate `M`
   trong `rejected` với `set(prog_stack) ∩ _SWAP_PROGRAMS ≠ ∅`.
   JUP stake/withdraw program ∉ registry (chỉ JUP6LkbZ) ⇒ Jupiter withdraw
   `387w9fh8EF` KHÔNG qua gate ⇒ 0 SWAP. B (TX2) CNgNK6 leg `encl=6EF8rrec`
   (pump.fun ∈ registry) ⇒ qua. C (6 miss) Ai66LHZG trong `rejected` với
   `prog_stack ∋ LBUZKhRx/JUP6LkbZ` ⇒ qua.
3. Hai chiều (củng cố): ví có net **trái dấu** ở mint khác trong cùng tx
   (một cuộc trao đổi, không phải chuyển một chiều). Quote = major trái dấu có
   `|net|` lớn nhất, nếu không có thì non-major trái dấu lớn nhất.

Hệ quả quan trọng:
- **KHÔNG cần decode declared (P6 huỷ)**: amount TX2 = đúng net ví
  (`30775532056683`) ⇒ gate 2 tái tạo chính xác, `amount_basis="net_delta"`.
  Đã đo: Anchor event KHÔNG chứa mint bị miss ở nhóm 6 ⇒ decode declared cũng
  không cứu được nhóm 6. Bỏ hẳn module mới.
- Mint **không** swap-anchored + net≠0 + chưa có event ⇒ **TRANSFER** (in/out).
  Vụ Jupiter withdraw thành TRANSFER (đúng yêu cầu mới) mà **test swap vẫn 0 step**.

## Hợp đồng test (đã đọc `test_wallet_watch.py:106-135`)

`got == EXPECTED` **chính xác theo set**, `got` lấy từ `detect_swaps`, tuple
`(sig10, role, side, mint10, qty)`. Docstring line 10-13: 2 row TRANSFER của
387w9fh8EF đã **xoá** vì "0 step". ⇒ KHÔNG được để `detect_swaps` nhả TRANSFER.
Chốt: `detect_swaps` **giữ swap-only**; thêm `detect_events(tx, wallet)` =
`detect_swaps` + `_net_transfers`; production `_handle_tx` gọi `detect_events`;
test giữ `detect_swaps` (oracle tay bất biến). Transfer được đo bằng `coverage`.

## Bất biến — KHÔNG được phá

- `test_wallet_watch.py`: `got == EXPECTED` chính xác. `detect_swaps` không nhả TRANSFER.
- `test_gmgn_api_parity.py` mutation gate: file detector **byte-identical** sau 4 mutation.
- Không double-count: mint đã có built event thì fallback bỏ qua (gate 1).
- Không bịa giá: thiếu giá ⇒ `quote_usd=None`, `usd_pending=True`.

## Thứ tự công việc

### P1 — Đo transfer recall ✅ XONG
`decoder_harvest.py coverage` (subcommand mới, `baseline` giữ nguyên làm oracle
buy/sell). Kết quả ở bảng trên; `.probe/program-decoder/coverage_report.json`.

### P2 — Counter RPC per-method ✅ XONG
WHERE `scripts/wallet_watch.py`, cạnh `rpc()` (`:351`).
HOW Đếm theo `method` (`getBlock`, `getSignaturesForAddress`, `getTransaction`,
`getSlot`, `getMultipleAccounts`) + theo key; log 1 dòng/phút kèm tổng. Không đổi logic.
EXPECT log có số thật để đo D5.
VERIFY chạy `--help`/`--once`, counter xuất hiện trong log.

### P3 — Persist `_seen` + cache decimals ✅ XONG
WHERE `wallet_watch.py`: load/save state (hiện có key `wallets` **và `block_slot`**),
`_seen` (`:1336`).
HOW Ghi thêm `seen` (sig đã xử lý, giới hạn N gần nhất) + `info` (decimals/symbol —
bất biến) vào state; load lại khi khởi động.
EXPECT restart không re-fetch cửa sổ backfill.
VERIFY `test_block_feed.py` + `test_rpc_resilience.py` (cả hai có guard
"state thật KHÔNG đổi" — phải giữ đúng, chỉ ghi khi chạy thật).

### P4 — Fallback gated net-delta (SWAP) + TRANSFER (**lõi**)
WHERE `wallet_watch.py`: trong `detect_swaps` (`:1138`) **sau** khi `built` xong;
`detect_events` mới; `_handle_tx` (`:1573`) gọi `detect_events`; `_seen` key thêm
`DETECTOR_VER`.
HOW
1. Tính `swap_anchored = {lg["mint"] for lg in legs if lg["encl"] in _SWAP_PROGRAMS}
   ∪ {c["mint"] for c in rejected if set(c["prog_stack"]) & _SWAP_PROGRAMS}`.
   (Chú ý: `rejected` chỉ chứa reason ∈ _FEE_REJECT_REASONS = {aggregator_frame,
   plumbing, no_pool_endpoint}; B bị `same_mint` nằm trong `legs`, không trong
   `rejected` ⇒ phải kiểm **cả hai** nguồn.)
2. Với mọi `M` trong `net_adj`, `|v|>0`, `M ∉ majors`, chưa có built event:
   - `M ∈ swap_anchored` **và** có net trái dấu ở mint khác ⇒ SWAP:
     `type="SWAP"`, `side` theo dấu `v`, `qty=|v|`, `qty_net=v`,
     `amount_basis="net_delta"`, `pool=""`, quote = major trái dấu |net| lớn nhất.
   - `M ∉ swap_anchored` ⇒ TRANSFER: `type="TRANSFER"`, `side="transfer"`,
     `transfer_dir="in"|"out"` theo dấu `v`, `qty=|v|`, `qty_net=v`,
     `counterparty` = owner đối ứng nếu suy được.
3. `detect_events` = `detect_swaps` + các TRANSFER trên. `_handle_tx` dùng
   `detect_events` để post (side transfer phải lọt contract `WatchTrade`).
4. `_handle_tx`: chỉ nhích `head` sau khi phân loại xong tx; lỗi ⇒ giữ `head`.
   `_seen` key = `f"{DETECTOR_VER}:{wallet}:{sig}"`.
EXPECT 6 miss + TX2 sinh SWAP event; 387w9fh8EF sinh **TRANSFER** (không SWAP);
transfer presence 3.8% → 100%.
VERIFY 6 suite PASS + `coverage` D1 = 100% (2461/2461) + TX2 kiểm tay BUY
`30775532.056683` tickr / quote USDC.

✅ XONG 2026-09-25. Bằng chứng chạy thật:
- 6 suite PASS; `coverage` D1 = **2461/2461 = 100%** (buy 425/425, sell 243/243,
  transfer 1793/1793) → `.probe/program-decoder/coverage_report.json`.
- 6 miss cũ: 5/6 amount **EXACT** qua `net_delta` (vd `5WxwFDpxtH` SELL 0.018704 ≡
  chain −0.018704; `343Yuv73Kn` BUY 213289.687911 ≡ chain). Ca còn lại
  `5NbAEK6UoS` detect được nhưng xếp TRANSFER (không thấy counter-leg ⇒ không có cơ
  sở gọi BUY; Nansen nằm trong 10 ca `side_disagree`).
- `387w9fh8EF` CÓ trong fixtures: 2 ví đều `{'TRANSFER': 1}`, **0 SWAP** ⇒ đúng
  constraint A. Nhiễu: 1940 SWAP → 3657 event (+1717 TRANSFER, ~0.66/tx).
- Lệch so với plan: (a) `anchored` phủ **cả 2 chiều ví** (cap_fee chỉ `rs=="WALLET"`
  ⇒ hụt 2 BUY); (b) TRANSFER **log-only** (không POST) — 1 dòng đổi nếu muốn POST;
  (c) TX2 fetch live **bị chặn**: URL trong unit trả 401 (key đã rotate), pool thật
  không nằm trong unit ⇒ không đào tiếp để tránh lộ key.

### P5 — ~~Cache `getTransaction` theo sig + fan-out~~ ✅ ĐÃ CÓ SẴN
`_handle_tx:1688` đã fan-out MỌI ví trong `keys` (`accountKeys` ∪ owner của
pre/postTokenBalances); `process_sig:1752` dedup `sig in _seen` TRƯỚC khi fetch ⇒
1 fetch/sig. Cache LRU/disk thứ hai = trùng lặp `_seen` ⇒ bỏ (YAGNI).
THAY BẰNG (defect thật, đã sửa + verify): `_seen` chỉ key theo sig ⇒ tx cũ bị bỏ
qua **vĩnh viễn** ⇒ fix P4 vô hiệu trên box. Thêm `DETECTOR_VER`, `save_state` ghi
`detector_ver` vào state, `_seen_restore` BỎ set đã lưu khi ver khác ⇒ quét lại 1
lượt. Chọn cách này thay vì prefix key vì `test_block_feed` assert **sig thô** trong
`WW._seen` (:267/:272/:280/:283). VERIFY 6 suite PASS + gate 3/3 (ver-lạ bỏ / ver-đúng
nạp / save ghi ver).

### P6 — ~~Tier-0 declared decode DFlow~~ ❌ HUỶ (Oracle)
Gate 2 tái tạo đúng amount TX2 bằng net ví (`amount_basis="net_delta"`), ít code
hơn, và decode declared không cứu được nhóm 6 (event không chứa mint bị miss).
Chỉ làm lại nếu sau P4 còn tx DFlow nào sai amount.

### P7 — Giảm RPC còn lại ✅ XONG (đòn đúng ≠ plan gốc)
ĐO LIVE 2026-09-25 (`# rpc/60s`, service thật `--feed ws`, 201 ví):
`getSignaturesForAddress` 387 (93.7%) · `getTransaction` 26 (6.3%) · `getBlock` **0**.
⇒ (a) `getBlock` params và (c) `getMultipleAccounts` **vô nghĩa** với service live
(ws feed không dùng `getBlock`; decimals/symbol qua HTTP). Đòn đúng = **sweep**.
HOW (đã làm): `--sweep` default 60 → **300s** (ws là đường chính; hố đã có
`_ws_catchup_due` + `WS_BACKFILL_CAP` lo riêng nên sweep định kỳ chỉ là lưới chậm) +
stagger `time.sleep(0.05)`/ví trong `poll_once` (bỏ burst 201 call ⇒ bớt 429/retry —
`rpc()` thử lần lượt mọi endpoint nên 1 lỗi × ~3 endpoint).
KẾT QUẢ (counter P2, delta/cửa sổ): quiet **19–20 call/phút** vs baseline **225/phút**
= **−91%**; chu kỳ 5 phút (1 sweep ~205 + 4 quiet) ≈ **57/phút** = **−75%** ✅ >50%.
Cửa sổ spike (`getTransaction` 78–111/phút) là tx mới THẬT, không phải lãng phí.
DEFECT đã sửa kèm: `_rpc_meter` in `err=` **tích luỹ** (không phải delta) ⇒ suýt đọc
sai error rate là "9%→21%"; số đúng ~2–8% (dao động theo sức khoẻ ws). Nay in delta.
VERIFY 6 suite PASS; box hash == local (`39d731858a93f9ff`); `active=active`.

### P8 — Watermark no-gap (backtest 14h tìm ra) ✅ XONG
BACKTEST 14h (cửa sổ `[now−15h, now−1h]` VN = 2340 event / 1017 sig / 83 ví; chain
truth `getSignaturesForAddress` qua **Helius thật** `private=yes`, fetch ok 1421/1500):
`expected(wallet,sig)=787` ⇒ old delivered **290 = 36.8%**, miss 497. Phân loại miss
bằng logic P4: TRANSFER 442 · SWAP 34 · net≈0 (ảo) 21 ⇒ P4 bắt **476/476 = 100%** phần
miss THẬT ⇒ nút thắt là **INGESTION**, không phải classify. Split ingestion/detection
của `bt_recall` là VÔ HIỆU: `state.seen` bị DETECTOR_VER reset lúc restart 23:13 VN,
SAU cửa sổ (45/932 artifact).

ROOT CAUSE (đọc code, không đoán): trong cửa sổ **0 `ws đứt shard` + 0 `vá bù` + 0 lỗi**
⇒ ws "khoẻ" nhưng im; và **cả 476 miss đều có ví ∈ `accountKeys`** ⇒ `mentions` lẽ ra
phải fire. `fetch_new_sigs` cũ `while len(out) < cap` thoát ngay sau **1 trang 25**
(cap=10) ⇒ `out[-cap:]` = đuôi của trang MỚI NHẤT; `poll_once:1821` đặt
`head = sigs[0][0]` ⇒ watermark **NHẢY QUA** dải sig nằm giữa ⇒ mất VĨNH VIỄN. Lưới cứu
`_ws_catchup_due` chỉ chạy trong `except` — không exception ⇒ không bao giờ chạy.

HOW: `fetch_new_sigs` quét **xuống tận `head`** rồi mới `out[-cap:]`; `_SIG_PAGE=1000`
(= max API ⇒ 1 call phủ trọn backlog ≤1000) + trần `_SIG_MAX_PAGES=40`; chạm trần mà
chưa tới `head` ⇒ trả `[]` để watermark KHÔNG tiến (thà chậm còn hơn mất). `head=None`
(backtest/parity) giữ nguyên hành vi cũ (25/trang).

VERIFY: 6 suite PASS (test (b) viết lại = full-page + `head` ở trang 2, khẳng định đuôi
kề `head` — bản cũ fail) + mô phỏng OLD/NEW trên lịch sử THẬT (`bt_chain_sigs.json`,
dùng chính hàm đã deploy): top-15 ví theo số sig ⇒ **OLD_skip 2644 vs NEW_skip 15**
(= 1/ví = chính sig watermark, không phải mất). Deploy hash `f93feb3f6b06aade`,
`active`, 0 traceback, backup `.bak.20260925T175651`.

CÒN LẠI (chưa làm, cần quyết): (a) miss ĐÃ mất nằm SAU watermark ⇒ cần rewind `head`
một lần mới recover (P8 chỉ bịt lỗ hổng VỀ SAU); (b) drain rate sweep = `cap`/300s
(10 sig/5' ⇒ backlog 500 mất ~4h), ws vẫn là đường real-time; (c) tỉ lệ mất của chính
ws (~58% trong cửa sổ) chưa đo riêng.

## Định nghĩa hoàn thành (đo được)

| # | tiêu chí | cách đo |
|---|---|---|
| D1 | Presence tx-level = **100%** trên **2461** row có net≠0 (202 row Nansen nhiễu loại có ghi lý do) | `decoder_harvest.py coverage` |
| D2 | Không mất tx lúc ingest (ws thủng/restart vẫn nạp đủ) | test hố ws + restart (P4) |
| D3 | 6 suite cũ PASS | `python3 scripts/test_*.py` (standalone, KHÔNG pytest) |
| D4 | Oracle 29-row không regress | `test_gmgn_api_parity.py`: steps 29/29, identity 29/29, side 29/29, amounts 23/29 exact + 6 gross, mutation gate 4/4 |
| D5 | RPC/giây giảm ≥50% so baseline | counter P2, so trước/sau → **−75% chu kỳ / −91% idle** ✅ |
| D6 | Watermark không nhảy qua dải sig (no-gap) | mô phỏng OLD/NEW trên lịch sử thật → **NEW_skip = 1/ví** (chính sig watermark), OLD = `sigs−25` ✅ |

## Cổng chặn (mỗi bước phải qua)

1. `python3 scripts/test_wallet_watch.py`
2. `python3 scripts/test_route_detect.py` (18/18)
3. `python3 scripts/test_gmgn_api_parity.py` (29/29 + mutation gate 4/4)
4. `python3 scripts/test_block_feed.py` (19/19)
5. `python3 scripts/test_wallet_watch_config.py`
6. `python3 scripts/test_rpc_resilience.py` (13/13)
7. `python3 scripts/decoder_harvest.py coverage` → D1 = 100%

## Rollback

Mỗi bước 1 commit riêng (chỉ commit khi user yêu cầu). P4 rủi ro nhất: 6 suite đỏ
mà 3 lần thử không xong ⇒ revert P4, giữ P1–P3, consult Oracle với output thực tế.

## Mặc định đã chọn

- Transfer: `side="transfer"` theo `WatchTrade`; thêm `transfer_dir` in/out.
- 1 tx ví vừa swap vừa transfer cùng mint: ưu tiên swap (gate 1 loại transfer cho
  mint đã có built event) ⇒ không double-count.
- Momus [OKAY] plan này (anchors đúng, executable).
