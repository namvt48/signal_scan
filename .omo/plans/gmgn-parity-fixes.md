# Plan: gmgn-parity-fixes — detector per-step + block-scan transport

**Slug:** `gmgn-parity-fixes` · **Status:** **APPROVED** (v4 — Momus round 4, verdict APPROVE, 0 blocker / 2 nit non-blocking đã áp) · **Owner decisions:** locked (D1–D19)
**Working dir:** `/home/namvt/Desktop/dev-space/signal_scan` (NOT a git repo ⇒ evidence must be written to files, no VCS diff available)
**Draft/source of truth:** `.omo/drafts/gmgn-parity-fixes.md` (findings F1–F33, decisions D1–D19)
**Oracle:** `.omo/drafts/gmgn-parity-fixes-fixture/gmgn_rows_fixture.json` — 29 rows / 9 sigs, snapshot của GMGN `wallet_activity` (data GMGN **chỉ để test**, không gọi API)

**v2 thay gì so v1 (cả 3 blocker Momus nêu đã verify offline, kèm số đo):**
- §2.2 viết lại: công thức fee-convention cũ **sai**. Sự thật đã chứng minh: oracle = `on-chain gross leg − LP fee`, mà **LP fee không tồn tại trong RPC payload** ⇒ exact amount cho 6 row là **bất khả thi** khi cấm GMGN API. Owner đã chốt policy: emit **gross + flag**.
- §3 Bước 3-4 viết lại: side tính theo **POOL endpoint direction** (không theo "có phải ví không") ⇒ 29/29; base/quote theo **rank BFS tier** (xoá `LAUNCHPAD_PROGRAMS`) ⇒ 29/29.
- §3 Bước 5, §2.3, T2, T3, T8 cập nhật theo; gate T8 định nghĩa lại đúng policy.
- §6 thêm 4 bằng chứng loại trừ (SwapEvent logs không phải nguồn step; fixture `token` **không có** decimals; mint id không được gõ tay; tolerance bắt buộc rel 1e-6).

**v3 thay gì so v2 — đóng đúng 3 blocker Momus (MB1–MB3), mỗi cái kèm số đo mới:**
- **MB1 (flag rule sai):** thay field `amount_includes_lp_fee` bằng **hằng số `amount_basis="gross_leg"` trên mọi event**. Đo lại sạch theo từng mint: rule "`|pool delta| < qty`" chỉ fire **1/6** row fee (5 row còn lại delta = đúng gross: `6407.891355999978`, `1947084.2203146615`, `∓9.5460692188`, `151.32806600000004`), còn quét mọi POOL account cùng mint thì fire bừa trên row exact (`20291.65595900081`, `-26699.547315000033`) ⇒ không có tín hiệu per-row. Sửa ở §3 Bước 5, §2.2 gate, §2.3, event dict, `fmt()`, T2, T8, T11, T12, §6, §7. Thêm lệnh cấm suy `amount_basis` từ `G`/`dex_native`/`launchpad`/`price`.
- **MB2 (WALLET literal gõ tay sai):** xoá literal khỏi §2.2; bắt buộc đọc `DATA["rows"][0]["wallet"]` (v2 thiếu 1 ký tự `S`, 43 vs 44 char) — ghi rõ trong §2.2, T8, §5.7.
- **MB3 (shape fixture sai):** thêm hẳn **§2.5 "Shape fixture THẬT"** — root `{blockTime,meta,slot,transaction,transactionIndex,version}`, **không** wrapper `result` (0/12), **không** `loadedAddresses` (0/12), **không** `programIdIndex` (0/67), 12 file → 9 sig với 3 cặp trùng **byte-identical** (sha256), row key là `tx_hash`/`event_type` (**không có** `sig`/`side`), rows-root `{source,caveat,tx_key,rows}`. Sửa T1 (đường dẫn sig), T8 (đường dẫn wallet), §3 Bước 1 (ghi chú ALT: fixture không cover ⇒ vẫn giữ `_keys()`).
- **4 note non-blocking đã xử:** (a) xoá ghi chú tie-break "chú ý…" mơ hồ — đo thật: mint OS `8LstZpZu…` < CARDS `CARDSccU…` ⇒ lex-nhỏ-hơn = base; (b) T8 thêm **mutation #4** (đổi nguồn amount sang delta balance ⇒ phải FAIL ở XBT); (c) ghi rõ USDT/DAI **không** có trong fixture 29 row ⇒ dùng hằng mainnet, gate không cover (§2.4, T3); (d) T2 bắt buộc in `frame_key` đầy đủ + dòng `PAIR`/`REJECT` có lý do.

**v4 thay gì so v3 — đóng 1 blocker của Momus round 3 + 5 nit (tất cả đã tôi tự đo lại offline, không tin review mù):**
- **BLOCKER (assertion sai trong gate):** v3 khai `quote_inferred == 3`. Chạy lại **đúng spec §3 Bước 4** trên 29 pair oracle: tie chỉ xảy ra ở **1** row (`58pWphuG sell OS ← CARDS`, OS=CARDS=rank 1.0). Ở `3nzGD2WV`/`3BbWVS3K` **không có** cạnh OS↔WSOL ⇒ BFS cho `rank OS = 2.0 > CARDS = 1.0` ⇒ base = OS **bởi rank-difference, không phải tie**. Đã sửa count 3→1 ở §1, §3 Bước 4, T8, §6 (2 dòng); giữ assert `base == OS` trên **cả 3** row OS↔CARDS. Nếu không sửa thì detector đúng vẫn fail gate mà §5.6 cấm sửa test ⇒ deadlock.
- **Nit 1:** raw OS thật là `…751` (3 hit), không phải `…752` (0 hit) ⇒ 1 đơn vị raw, rel `9.1e-17` (§2.2).
- **Nit 3 (quan trọng cho gate):** pin công thức `rel_overstate = (emitted − oracle) / emitted` (mẫu = **gross**) trong T8. Nếu lấy mẫu = oracle thì row OS thành `8.4011%` > 8% ⇒ fail giả. Số đo theo mẫu gross: 0.2025 / 7.7500 / 0.8259 / 4.8524 / 0.2018 / 0.2401 % — đều ≤ 8%.
- **Nit 4:** `TIER_A-only` đo lại = **25/29** (v3 ghi 24/29).
- **Nit 5:** header drift — L3/L5 giờ ghi `D1–D19` (= draft hiện hành, D19 đã có; Momus round 4 bắt lại `D1–D18` ở L3 ⇒ đã sửa).
- **Nit 6:** §2.2 bảng ORE bỏ cách nói "khớp tới chữ số cuối" — fixture lưu string `9.46722534902`, phép trừ float ra `…019857` (rel 1.5e-14, vẫn ≪ 1e-6).
- **Nit 2 của Momus BỊ BÁC (có số đo):** Momus khai delta USDC `151.32806600000004` "không tái lập được" trong `3BbWVS3K` — sai vì nó pair `pre/postTokenBalances` **theo vị trí list** (`zip`), trong khi Solana pair theo field **`accountIndex`** (hai list có account tạo/đóng giữa tx ⇒ lệch vị trí). Đo lại theo `accountIndex`: `3BbWVS3K` acctIndex 29 (owner `2N1KNu`) Δ = `151.328066` ✓ (zip-positional = 0 hit); `3nzGD2WV` acctIndex 29 (owner `2N1KNu`) Δ = `450.798346` ✓. ⇒ §3 Bước 5 **giữ nguyên**; bằng chứng MB1 càng mạnh (row có fee vẫn có delta = gross ⇒ rule v2 cho flag=False). Ghi F32.
- **Không đổi:** MB1–MB3 đã CLOSED theo review round 3; thuật toán side (POOL endpoint direction 29/29), rank BFS (29/29), transport block-scan (T7), policy D14, scope out §8, dependency T1→…→T12.

---

## 1. Goal (what "done" means)

Watcher phát ra **đúng 1 event cho mỗi bước swap qua 1 pool**, khớp GMGN trên 29-row oracle về **side, symbol base/quote, số step**, **không thừa không thiếu**; amount khớp exact trên 23 step không có LP fee, và trên 6 step có fee thì emit gross kèm field `amount_basis="gross_leg"` (hằng số trên mọi event — policy owner đã chốt §2.2, bằng chứng §3 Bước 5). Transport chính = **quét block thật** từ RPC Solana.

Definition of done — tất cả phải có evidence file (xem §7):
1. `scripts/test_gmgn_api_parity.py` → `PASS steps 29/29 · identity 29/29 · side 29/29 · amounts exact 23/29 + 6 gross (amount_basis=gross_leg)` (offline, không network).
2. `scripts/test_block_feed.py` → `PASS` (offline, fake RPC).
3. `scripts/test_wallet_watch.py`, `scripts/test_route_detect.py` → `PASS` sau khi đổi sang detector mới.
4. Chạy thật trên server: `--feed block` in ra event, `grep -c TRANSFER_ events.jsonl` = `0`.
5. Không còn event kiểu `CARDSc…`/`F8eyg3…` khi mạng metadata hoạt động (thay bằng symbol + flag).

---

## 2. Ground truth đã verify (đọc kỹ trước khi code)

### 2.1 Semantics của GMGN row
- 1 row = 1 **bước** qua 1 pool (DEX hoặc launchpad curve), KHÔNG phải 1 route, KHÔNG phải net theo ví.
- `token`/`token_amount` = **base** của pool; `quote_token`/`quote_amount` = **quote** của pool.
- `event_type buy|sell` tính theo **bước đó**, không theo route. Một tx có thể vừa buy vừa sell cùng token ở 2 pool (`58pWphuG`: `sell OS→WSOL` **và** `sell OS→CARDS`).
- `launchpad_platform` (`Pump.fun`, `stonkfun`, `""`) là metadata GMGN gắn từ program id của họ. **KHÔNG dùng nó để suy base/quote** (v1 sai ở đây): bằng chứng phản bác — các row `stonkfun` lại chạy qua `LBUZ…`/`CPMMoo8L…`/`CAMMCzo5…` (program Raydium/Meteora) ⇒ map launchpad→base/quote không tất định. Base/quote dùng rank rule §3 Bước 4 (đã 29/29).
- Fee leg của aggregator (Jupiter/DFlow) **không tạo row**; row chỉ sinh ra khi leg có **POOL endpoint** (§3 Bước 3).

### 2.2 Quy tắc amount (đã pin bằng bằng chứng — cấm đoán lại)

**Sự thật đã verify (6/6 trường hợp):** số GMGN = `gross leg on-chain − LP fee của chính step đó`, khớp tới ~1e-14 (lệch chỉ do artifact làm tròn chuỗi lưu trong fixture — xem F31b; ORE row: stored `9.46722534902` vs emitted `9.467225349019857`, rel `1.5e-14`):

| sig | mint | side lệch | gross leg on-chain | oracle | oracle = gross − fee | overstate của gross |
|---|---|---|---|---|---|---|
| 58pWphuG | CARDS | base | 6407.891356 | 6394.913585 | 6407.891356 − 12.977771 = **6394.913585** ✓ | +0.2025% |
| 58pWphuG | OS | base | 1947084.2203146615 | 1796185.193240272 | − 150899.027074389 = **1796185.1932402714** ✓ | +7.7500% |
| 5XLTG1WX | ORE | base | 9.5460692188 | 9.46722534902 | − 0.078843870 ≈ **9.46722534902** (fixture lưu string `9.46722534902`; phép trừ float cho `9.467225349019857`, rel 1.5e-14 ≪ 1e-6) ✓ | +0.8259% |
| 33hqSn4Q | XBT | base | 102766.565214 | 97779.906425 | − 4986.658789 = **97779.906425** ✓ | +4.8524% |
| 3nzGD2WV | USDC | quote | 450.798346 | 449.888419 | − 0.909927 = **449.888419** ✓ | +0.2018% |
| 3BbWVS3K | USDC | quote | 151.328066 | 150.96474 | − 0.363326 = **150.96474** ✓ | +0.2401% |

**LP fee KHÔNG có trong `getTransaction` payload** — đã tìm bằng 4 cách trên cả 6 case, 0 hit:
1. token balance deltas (không account nào có |delta| = fee; vault nhận đúng gross: CARDS `6407.891355999978`, OS `1947084.2203146615`, ORE `9.5460692188`);
2. raw text của JSON (`str(raw_fee)` với raw tại đúng decimals);
3. base64 của mọi field `data`/`accountData` (u64 LE, u64 BE, u32 LE) ± 1 đơn vị;
4. base64 của mọi dòng `Program data:` trong `logMessages` (cùng 3 packing).
Không có `feeAmount`/`transferCheckedWithFee` nào mang con số này; token-2022 trong fixture chỉ có transferChecked thường.

**Hệ quả (đã chấp nhận — policy owner, D14):** exact net là bất khả thi từ RPC. Worker emit **gross**:

```
amount(step, mint) = parsed-instruction amount của leg thuộc step đó / 10**decimals(mint)
                     (KHÔNG dùng delta balance cấp tx — xem bằng chứng XBT dưới)
amount_basis = "gross_leg"   # HẰNG SỐ trên MỌI event — xem §3 Bước 5 (không suy per-row)
```

- Nguồn amount **bắt buộc** là parsed instruction (`transferChecked.amount`/`tokenAmount.amount`), **không** phải delta balance. Bằng chứng: row `33hqSn4Q sell XBT ← WBTC 638160.364952` — instruction raw = `638160364952` khớp oracle exact, trong khi delta balance của các vault là `99683.5682570003`/`619015.5540030003` (XBT là token-2022 có transfer fee riêng ⇒ delta ≠ số GMGN báo).
- `decimals` lấy từ `pre/postTokenBalances[].uiTokenAmount.decimals` theo mint (hoặc `parsed.info.tokenAmount.decimals`). **Cấm** lấy từ fixture `token.decimals` — field đó **không tồn tại** trong row GMGN (chỉ `quote_token` mới có `decimals`) ⇒ v1 của plan này dựa vào nó là sai.
- Số đo parity với nguồn instruction (đã chạy trên 9 tx; wallet **đọc từ fixture** `DATA["rows"][0]["wallet"]` — cấm gõ literal vào plan/code; bản v2 gõ tay và **SAI**: thiếu 1 ký tự `S`, 43 char vs 44 char đúng trên chain): **23/29 row exact cả hai phía**; đúng **6 row** lệch về phía gross như bảng trên (0.20%–7.75%).
- Gate (§4 T8) do đó: exact bắt buộc cho 23 row; 6 row phải thoả `emitted ≥ oracle`, `rel diff ≤ 8%`, và mọi event đều mang `amount_basis == "gross_leg"` (hằng số, không phải per-row flag — xem §3 Bước 5). Không được nới tolerance để biến row lệch thành "exact".
- **Tolerance so sánh = rel 1e-6 theo uiAmount, không phải equal-int theo raw.** Bằng chứng artifact (đã đo lại: grep file `58pWphuG.json` cho `11033477248449751` = **3 hit**, `…752` = **0 hit**): row `58pWphuG sell OS ← CARDS 11033477.24844975` có raw on-chain `11033477248449751` ⇒ ui = `11033477.248449751`, lệch **1 đơn vị raw** ở dec 9 (rel **9.1e-17**) nhưng fail nếu so int strict; row này **là exact**, không phải row fee.

### 2.3 Oracle table (29 rows — acceptance gate)

Cột `amt` đánh dấu nguồn số amount: `G` = gross ≠ oracle (6 row có LP fee, xem §2.2); dấu trống = exact. **Cột này chỉ là expected-value cho test** (T8 dùng nó để biết row nào cần bound ≤ 8% thay vì exact). **Cấm** detector suy ra `G` từ dữ liệu nào — production không có khả năng biết step nào bị thu phí (§3 Bước 5 có bằng chứng đo được).

| sig | side | base | token_amount | quote | quote_amount | amt |
|---|---|---|---|---|---|---|
| 2k3KYp18 | sell | SPCX | 9.524479 | USDC | 1415.838994 | |
| 2k3KYp18 | sell | JUDE | 9678051.403663 | SPCX | 9.524479 | |
| 33hqSn4Q | sell | cbBTC | 0.01657105 | USDC | 1286.802742 | |
| 33hqSn4Q | buy | cbBTC | 0.01657105 | WBTC | 0.01656677 | |
| 33hqSn4Q | sell | XBT | 638160.364952 | WBTC | 0.01656677 | |
| 33hqSn4Q | sell | XBT | 97779.906425 | WSOL | 2.006944216 | G |
| 3BbWVS3K | buy | OS | 10588363.790051019 | CARDS | 38921.288721 | |
| 3BbWVS3K | buy | CARDS | 964.657141 | USDC | 123.451845 | |
| 3BbWVS3K | buy | CARDS | 36772.236971 | USDC | 4703.117027 | |
| 3BbWVS3K | buy | CARDS | 1184.394609 | USDC | 150.96474 | G (quote) |
| 3fec2kXP | buy | JUDE | 9678051.403663 | SPCX | 16.224732 | |
| 3fec2kXP | buy | SPCX | 16.7186 | USDC | 2488.948469 | |
| 3nzGD2WV | buy | OS | 2392197.678713395 | CARDS | 7672.907241 | |
| 3nzGD2WV | buy | CARDS | 3033.796563 | USDC | 394.448555 | |
| 3nzGD2WV | buy | CARDS | 1162.468777 | USDC | 150.332487 | |
| 3nzGD2WV | buy | CARDS | 3476.641901 | USDC | 449.888419 | G (quote) |
| 3pkGZDK1 | sell | cbBTC | 0.0200705 | USDC | 1559.565691 | |
| 3pkGZDK1 | buy | cbBTC | 0.0028584 | WBTC | 0.0028576 | |
| 3pkGZDK1 | buy | cbBTC | 0.0172121 | WBTC | 0.0172075 | |
| 3pkGZDK1 | sell | XBT | 740926.930166 | WBTC | 0.0200651 | |
| 4zmaV87B | buy | SNOOPDOGE | 10363786.042923 | DOGE | 11436.96377958 | |
| 4zmaV87B | buy | DOGE | 8673.39085549 | USDC | 732.746279 | |
| 4zmaV87B | buy | DOGE | 3111.70405711 | USDC | 262.833109 | |
| 58pWphuG | sell | CARDS | 6394.913585 | USDC | 824.225653 | G |
| 58pWphuG | sell | CARDS | 20291.655959 | USDC | 2609.254878 | |
| 58pWphuG | sell | OS | 1796185.193240272 | WSOL | 5.848984792 | G |
| 58pWphuG | sell | OS | 11033477.24844975 | CARDS | 26699.547315 | |
| 5XLTG1WX | sell | ORE | 9.46722534902 | USDC | 726.96198 | G |
| 5XLTG1WX | sell | STEVE | 20395086.158547 | ORE | 9.5460692188 | |

So khớp bằng `(sig, side, base_symbol, quote_symbol)` + số event mỗi sig phải bằng đúng số row: `2k3KYp18=2, 33hqSn4Q=4, 3BbWVS3K=4, 3fec2kXP=2, 3nzGD2WV=4, 3pkGZDK1=4, 4zmaV87B=3, 58pWphuG=4, 5XLTG1WX=2`. Amount so rel-tol 1e-6 (row `G` theo policy §2.2).

### 2.4 Mint + account roles đã verify từ fixture
- Mint/symbol map: **build từ chính fixture** (`token.address`, `quote_token.token_address`, `quote_address`) — không hardcode tay. (Bài học thật: mint WBTC gõ tay sai đuôi `3NZ9JMVBmGRqojhxv8DNh…` (bịa) vs đúng `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` ⇒ rank rule tụt còn 28/29.)
- `TIER_A` (rank 0.0) = mint của symbol `WSOL, USDC, USDT, DAI` (DAI = `EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o`). **Cấm** đưa WBTC/cbBTC/BTC-peg vào TIER_A.
- **Lưu ý đã đo:** 29 row fixture chỉ có các symbol `CARDS, DOGE, JUDE, ORE, OS, SNOOPDOGE, SPCX, STEVE, USDC, WBTC, WSOL, XBT, cbBTC` ⇒ **không** có USDT/DAI. Mint USDT (`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`) và DAI không suy ra được từ fixture ⇒ dùng hằng số mainnet trên, ghi comment nguồn trong code, và chấp nhận gate 29/29 **không** cover chúng (ghi vào `T3.log`). Mint WSOL/USDC lấy từ fixture map.
- `TIER_B` (rank 0.5) = mint của symbol `WBTC` = `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` (lấy từ fixture). Thêm `wETH`-Wormhole `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` **chỉ khi** gặp route dùng nó (fixture chưa có ⇒ chưa thêm, YAGNI).
- **RELAY accounts đã gặp** (owner không phải ví, net delta = 0, hoặc không có trong balances): `CapuXNQoDviLvU1PxFiizLgPNQCxrsag1uMeyk6zLVps`, `ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn`, `BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV`, `GGztQqQ6pCPaJQnNpXBgELr5cs3WwDakRbh1iEMzjgSJ`, `GJrFmC…`, và `9puaS8…` (4zmaV87B: ABSENT khỏi balances nhưng net-zero qua 6 leg DOGE — nhận `311170405711 + 867339085549` = gửi `1143696377958 + 285353388 + 34242406526 + 285353388`). 17/29 row có RELAY làm 1 endpoint ⇒ đây là mainline, không phải edge case.
- **Cấm** phân loại RELAY bằng denylist program id: phải phân loại bằng **dữ liệu balance** (`net delta == 0` hoặc account absent) như §3 Bước 3 — vì cùng một authority (`CapuXN…`) vừa là src vừa là dst trong cùng tx.

---

### 2.5 Shape fixture THẬT (đo bằng script, không suy đoán) — bắt buộc theo đúng shape này
Đo trên `.omo/drafts/gmgn-parity-fixes-fixture/` (12 file tx + 1 file rows + 1 file gm_activity):
- Tx JSON có **root = `{blockTime, meta, slot, transaction, transactionIndex, version}`** — **KHÔNG** có wrapper `result` (0/12 file) ⇒ đường dẫn đúng là `json.load(f)["transaction"]["signatures"][0]`, không phải `result.transaction...`.
- 12 file → **9 sig phân biệt**; 3 cặp trùng: `4zmaV87B.json`≡`4zmaV87BnoMS.json` (sha256 `55fe63dc…`), `33hqSn4Q.json`≡`33hqSn4QyCKb.json` (`58562576…`), `58pWphuG.json`≡`58pWphu.json` (`c335708d…`) — **byte-identical** ⇒ dedupe theo `transaction.signatures[0]` là an toàn.
- **Không** có `meta.loadedAddresses` (0/12) và **không** có `programIdIndex` (0/67 instruction) ⇒ cả 9 tx đều là legacy; `instructions[].programId` là **chuỗi địa chỉ**.
- Không có ALT trong fixture **không** có nghĩa production không cần: **giữ** `_keys(msg, meta)` gộp ALT cho tx v0 ngoài đời; nhánh ALT không được fixture cover ⇒ ghi chú vào `T2.log`.
- File rows: root = `{source, caveat, tx_key, rows}` (29 row). Row key thật: `tx_hash` (**không có** field `sig`), `wallet`, `event_type` (**không có** field `side`), `is_open_or_close`, `token`, `token_amount`, `quote_token`, `quote_amount`, `quote_address`, `price`, `price_usd`, `cost_usd`, `dex_native`, `dex_usd`, `launchpad`, `launchpad_platform`, `from_address`, `to_address`, `gas_native`, `gas_usd`, `priority_fee`, `tip_fee`, `buy_cost_usd`, `chain`, `timestamp`.
- `token` dict **không có** `decimals` (chỉ `quote_token` mới có) ⇒ decimals phải lấy từ `pre/postTokenBalances[].uiTokenAmount.decimals` (§2.2).

## 3. Thuật toán detector (spec bắt buộc)

Hàm mới `detect_swaps(tx, wallet) -> list[dict]` trong `scripts/wallet_watch.py`. Không network, không state ngoài cache metadata (như `classify_swaps` cũ L596 đã giữ).

**Tái dùng tài sản có sẵn (bắt buộc, đừng viết lại):** `_keys(msg, meta)` L512 (đã gộp ALT `loadedAddresses` cho tx v0), `_PLUMBING` L486-493, `_SWAP_PROGRAMS` L474-484, `_TRANSFER_TYPES` L498-503, `_WRAPPED_NOISE` L497, `_sym()` L519, `dbase()` L120, `_swap_legs()` L527 (chỉ phần thu thập transfer parsed-instructions; phần wallet-net-delta **không** dùng cho amount).

**Đã thử và LOẠI (đừng thử lại):** `logMessages` của Jupiter (`Program log: Dex::<Name> amount_in: X, offset: N` + `SwapEvent { dex, amount_in, amount_out }`) **không** phải nguồn per-step — chỉ 2/9 tx có (chỉ route qua Jupiter), và `58pWphuG` có **5** SwapEvent nhưng oracle chỉ **4** row ⇒ không map 1-1. Số `Program data:` (base64) cũng không chứa amount net/fee (§2.2). Nguồn sự thật duy nhất: parsed SPL transfer legs + `pre/postTokenBalances`.

### Bước 1 — thu legs + frame theo **instance lời gọi**
- Đi `msg.instructions` (mỗi top-level ix = 1 **frame chain riêng**), theo `meta.innerInstructions[].instructions` bằng `index`.
- Duy trì `stack` theo `stackHeight`; **reset stack ở mỗi top-level instruction** (bug cũ: stack không reset ⇒ leg của ix này bị gán frame của ix trước).
- `frame_id` = tuple đường dẫn instance (vd `(top_i, height, enclosing_program_id, invocation_seq)`), **KHÔNG phải** program-id đơn thuần — `3BbWVS3K` gọi cùng 1 program 3 lần cho 3 pool khác nhau ⇒ group theo program-id sẽ gộp 3 step thành 1 (bug F9 đã đo: 3 row mua CARDS bị merge).
- Chỉ nhận instruction có `parsed.type ∈ _TRANSFER_TYPES` và program ∈ {`TokenkegQ…`, `TokenzQd…`}. Leg = `{mint, src, dst, raw_amount, decimals, frame_id, enclosing_program, seq}`.
- Lấy `owner`, `pre`, `post` cho **mọi** account trong `pre/postTokenBalances` (map qua `_keys` index→address; **fixture không có ALT nên index luôn nằm trong `accountKeys`** — đo: 0 out-of-range trên 9 tx — nhưng code production vẫn phải giữ `_keys()` gộp ALT vì tx v0 ngoài đời dùng) + `decimals` theo mint. Account không có trong balances ⇒ `owner=None, pre=post=0`.

### Bước 2 — lọc frame DEX
- `enclosing_program` = program gần nhất trên stack ∉ `_PLUMBING` ∪ {token programs} ∪ `_AGGREGATORS` (mới: router aggregator — lấy từ `_SWAP_PROGRAMS` entries tên chứa "Jupiter"/"DFlow": `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`). DEX thật (Raydium/Meteora/Orca/pump.fun) **giữ lại**; DEX lạ tự lọt qua vì rule là loại-by-denylist (không cần registry đầy đủ).
- Leg fee/referral do aggregator tự CPI ⇒ `enclosing_program` = aggregator ⇒ bị loại ⇒ không ra event thừa.
- **Không** loại leg chỉ vì endpoint là authority của aggregator (xem §2.4: `CapuXN…` là endpoint hợp lệ của step thật).

### Bước 3 — role endpoint, side, và pair step
Role của mỗi endpoint leg, xác định **bằng dữ liệu balance** (không denylist):
```
role(a) = "WALLET"  nếu owner(a) == wallet
          "RELAY"   nếu a không có trong pre/postTokenBalances  HOẶC  post(a) − pre(a) == 0
          "POOL"    ngược lại  (owner != wallet và net delta != 0)
```
- **Yêu cầu cứng:** mỗi leg của step hợp lệ phải có **đúng 1 endpoint POOL**. Leg 2 endpoint đều RELAY ⇒ leg rác (chuyển nội bộ route) ⇒ bỏ. Assert role distribution không có case "không POOL nào" sau khi lọc (đo được trên fixture: `POOL→WALLET 5, WALLET→POOL 7, POOL→RELAY 11, RELAY→POOL 6` = 29/29, **0 AMBIG**).
- `pool_key(step)` = `owner` của endpoint POOL; pair 2 leg thành 1 step khi chúng ở **cùng `frame_id`** (fallback khi frame không tách được: cùng `pool_key` và là 2 mint khác nhau; nếu vẫn nhiều ứng viên ⇒ chọn cặp có `|seq_base − seq_quote|` nhỏ nhất). Mỗi step phải có đúng **2 mint phân biệt**.
- **Side (đã verify 29/29):** xét leg của **base** mint —
  - POOL là `src` (pool **gửi** base ra) ⇒ `side = BUY`
  - POOL là `dst` (pool **nhận** base vào) ⇒ `side = SELL`
  - Không dùng "base có chảy vào ví không" — 17/29 step không chạm ví trực tiếp (relay đứng giữa), và `33hqSn4Q` có 2 row cùng mint cbBTC cùng raw `1657105` nhưng side ngược nhau:
    - leg `#8 cbBTC GJrFmC(POOL) → ExPLiW(CapuXN RELAY)` = **BUY** cbBTC ← WBTC ✓ oracle
    - leg `#9 cbBTC ExPLiW(RELAY) → FWiLr7(HxA6SK POOL)` = **SELL** cbBTC ← USDC ✓ oracle
  - `4zmaV87B`: leg `#5 DOGE DTeJym(YWhRVs POOL) → 9puaS8(RELAY, absent)` = **BUY** DOGE, quote leg `#2 USDC 35698t(WALLET) → ARMyhL(YWhRVs POOL)` raw `262833109` = `262.833109` ✓ đúng row oracle ⇒ cặp base/quote cùng `pool_key = YWhRVs…`.

### Bước 4 — base/quote: **rank BFS** (đã verify 29/29, thay toàn bộ chuỗi launchpad/LINK/fallback của v1)
Trong phạm vi **1 tx**, dựng đồ thị cặp mint từ các step đã pair:
1. `rank[m] = 0.0` nếu `m ∈ TIER_A`; `rank[m] = 0.5` nếu `m ∈ TIER_B`; seed theo rank tăng dần (TIER_A trước TIER_B).
2. BFS từ các seed: `rank[y] = rank[x] + 1` với `y` kề `x` chưa có rank. Mint không reach được ⇒ `rank = 99`.
3. Với mỗi step `(m1, m2)`: **rank nhỏ hơn = quote, rank lớn hơn = base**.
4. Rank **bằng nhau** ⇒ base = mint **lexicographically nhỏ hơn**, quote = mint lớn hơn, và gắn `quote_inferred = True`.
5. Không reach được cả hai ⇒ cùng rule 4 (lex nhỏ hơn = base) + `quote_inferred = True`.

Số đo trên fixture (chạy lại **đúng spec trên** trên 29 pair oracle, F31): rank `4zmaV87B = {USDC 0.0, DOGE 1.0, SNOOPDOGE 2.0}`, `58pWphuG = {USDC 0.0, WSOL 0.0, CARDS 1.0, OS 1.0}`, `3nzGD2WV = 3BbWVS3K = {USDC 0.0, CARDS 1.0, OS 2.0}`; kết quả **29/29 base+quote exact**, và đúng **1 row** `quote_inferred` — chỉ `58pWphuG sell OS ← CARDS` (OS=CARDS=1.0 do tx đó có cạnh OS↔WSOL).
**Hai row OS↔CARDS còn lại (`3nzGD2WV`, `3BbWVS3K`) KHÔNG phải tie:** không có cạnh OS↔WSOL trong tx đó ⇒ BFS cho `rank OS = 2.0 > CARDS = 1.0` ⇒ base = OS theo rule 3 (rank lớn = base), `quote_inferred = False`. Cả 3 row đều có base = OS ⇒ T8 assert base == OS trên cả 3, nhưng assert count `quote_inferred == True` == **1**.
**Tie-break rule 4 đã ĐO và đúng như đã viết (không đảo, không để ngỏ):** mint OS `8LstZpZuR9Dy7JCZC3YwPEWtbYhuDVFAYV37r6ZAcuHz` < mint CARDS `CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp` (so lexicographic = `True`; cả hai 44 ký tự, lấy từ fixture map) ⇒ lex-nhỏ-hơn = base = **OS** = đúng oracle. Nếu row tie fail ⇒ detector sai, **không** đổi direction tie-break. `TIER_A-only` đạt **25/29**; thêm `TIER_B` (WBTC) ⇒ **29/29**.

### Bước 5 — amount + usd + event dict
- `qty` = §2.2 (gross, từ parsed instruction, decimals từ balances) cho base mint; `quote_qty` tương tự cho quote mint.
- `amount_basis = "gross_leg"` — **hằng số trên mọi event, không suy theo row.** Số đo bác bỏ mọi rule suy per-row (đây là lỗi MB1 của plan v2, đã đo lại sạch theo từng mint): rule "`|delta|` của endpoint POOL < `qty` ⇒ flag True" chỉ fire **1/6** row có fee; 5 row còn lại delta **bằng đúng gross**: CARDS acct38 `HeiMeC` Δ=`6407.891355999978`, OS acct32 `31kxrg` Δ=`1947084.2203146615`, ORE acct13/19 Δ=`∓9.5460692188`, USDC acct29 `5gxMGo` Δ=`151.32806600000004`/`450.7983459999996`. Case XBT fire chỉ vì token-2022 transfer-fee (`99683.5682570003`/`619015.5540030003`), không phải LP fee. Nếu quét *mọi* POOL account của cùng mint thì rule fire bừa trên cả row exact (vd `58pWphuG` CARDS: acct13 Δ=`20291.65595900081`, acct23 Δ=`-26699.547315000033`). ⇒ Không có tín hiệu per-row nào trong payload; phát hành trung thực: mọi amount là gross leg, net của GMGN có thể thấp hơn đúng bằng LP fee của pool (≤ 7.75% trên 6/29 row đã đo).
- **Cấm** đọc `G` marker §2.3, `dex_native`, `launchpad`, `price` hay bất kỳ field GMGN nào để quyết định `amount_basis` (Constraint §5.1/§5.6/§5.7).
- `quote_usd` = `quote_qty × price` (price từ `_info[mint][1]`; WSOL ⇒ `_sol_px`); `unit_price = quote_qty / qty` (giữ semantics `fmt()` L702-715).
- Không bỏ event vì `min_usd` nếu `quote_usd == 0`/thiếu price — giữ event + `usd_pending=True` (metadata-miss không được làm **thiếu** row; oracle 29/29 không phụ thuộc giá).
- Event dict (giữ key mà `fmt()`/`jl_write`/`track_post_body` đang đọc: `wallet, sig, side, mint, qty, quote_usd, unit_price`):
```python
{"ts":…, "slot":…, "sig":…, "wallet":…, "side":"BUY|SELL", "mint":<base mint>, "sym":<base symbol>,
 "qty":<gross base amount>, "quote_mint":…, "quote_sym":…, "quote_qty":…, "quote_usd":…, "unit_price":…,
 "pool":<pool_key>, "program":<enclosing_program>,
 "amount_basis":"gross_leg", "quote_inferred":bool, "symbol_pending":bool, "usd_pending":bool,
 "type":"SWAP"}   # KHÔNG BAO GIỜ là TRANSFER_IN/TRANSFER_OUT/NEUTRAL
```
  (v1 có field `launchpad` — **bỏ**, vì không còn `LAUNCHPAD_PROGRAMS`; thông tin program đã ở field `program`.)
- `fmt()` L702: thêm hiển thị step (vd `BUY 1,184.394609 CARDS ← USDC 150.96474 ≈ $150.96 step 3/4`) + marker ` (gross)` khi `amount_basis == "gross_leg"`; bỏ nhánh map `TRANSFER_IN→BUY` L706.

### §3-T2-notes (deviation ĐO ĐƯỢC trong lúc implement — F3 đọc mục này)
T2 đạt gate §3 với 2 điều chỉnh so với chữ §3, cả hai đều có counterproof offline trong `.omo/evidence/gmgn-parity-fixes/T2.log`:
- **G1 — pairing primary key = `frame_id` đơn thuần (KHÔNG kèm `pool_key`).** 4 step escrow-DEX có 2 vault owner khác nhau giữa 2 leg của cùng 1 swap. Nếu thêm `pool_key` vào điều kiện primary ⇒ chỉ 25/29 (M2 counterproof). Mệnh đề "cặp base/quote cùng `pool_key`" trong ví dụ `4zmaV87B` là **hệ quả quan sát được**, không phải điều kiện pairing. `pool_key` vẫn là attribute `pool` của step + dùng cho fallback.
- **G2 — REJECT reason thứ 7 `major_pair`.** Chạy đúng §3 literal ⇒ 31 events (thừa 2 cặp USDC↔WSOL route-conversion, `58pWphuG` 5 row, `POOL→RELAY` 13, `quote_inferred` 3 — M1 counterproof). Rule đã implement: step mà **cả 2 mint ∈ `TIER_A` ∪ `TIER_B`** ⇒ drop + REJECT trace `major_pair` (nhất quán `_WRAPPED_NOISE`: wrapped natives chỉ là routing hop, không phải token đích; oracle không có row nào cả 2 mint đều major). `major_pair` là **trace-only**, không phải điều kiện của gate ngoài việc tái lập đúng 29 rows.
- Pairing distribution đo được: `by=frame 27, by=seq_gap 2, by=pool_key 0`; `unpaired 0`; `AMBIG(2-POOL) 0`. REJECT enum baseline: `not_spl 144, aggregator_frame 15, plumbing 13, same_mint 8, no_pool_endpoint 6, major_pair 4, unpaired 0`.
- Gate verify **độc lập bởi orchestrator** (không đọc log executor): steps **29/29** · side **29/29** · quote/identity **29/29** · amount **23 exact (rel ≤1e-6 cả 2 phía) + 6 gross (≥ oracle, overstate ≤8%)** = 29/29 · `quote_inferred` **1** · mọi event `amount_basis=="gross_leg"` + `type=="SWAP"` · per-sig emit == oracle (2,4,4,2,4,4,3,4,2).

### §3-T7-notes (deviation ĐO ĐƯỢC trong lúc implement — F1/F2/F3 đọc mục này)
Chữ §T7 pin `maxSupportedTransactionVersion: 0`; đo thật trên mainnet **2026-09-15** (orchestrator tự gọi lại, không tin log executor) ⇒ **0 là bất khả thi**, phải là **1**:
- `getBlock` slot `447286173` ver=0 ⇒ `-32015 Transaction version (1) is not supported by the requesting client…`; ver=1 ⇒ OK, 1291 tx, `versions_in_block={0,1,legacy}`. Block thật ~9.7–12.6 MB/slot.
- `getTransaction` (cùng defect, đường ws/poll): tx `3EYBtojHybSxAtadHJYVv6tskbhkCyJZsF5yKohWHWLbmVvjT9vfcVvDhk66KNwqf9RNYVcw4mgpFUMb6kTKhoCq` ver=0 ⇒ `-32015`; ver=1 ⇒ OK. Trước fix, `process_sig` **nuốt** exception này ⇒ feed ws/poll **âm thầm mất mọi tx version-1** (đúng loại lỗi "thiếu event" mà plan này tồn tại để diệt) ⇒ đã sửa `0→1` ở **cả hai** chỗ (`_BLOCK_PARAMS` + `process_sig` getTransaction), control flow T5 giữ nguyên byte-for-byte.
- **Skip matcher:** spec pin literal `-32004`/`"skipped slot"`, nhưng `rpc()` chỉ giữ `error.message` (rơi code) và node thật trả `"Slot N was skipped"` ⇒ dùng `"-32004" in err or "skipped" in err.lower()` (superset của cả hai literal); lỗi RPC khác vẫn **propagate** (đo: `429` nổi lên, không bị ăn).
- **`--once` mode block có bound** (`_ONCE_MAX_SLOTS = 5`): chữ §T7 ghi "chạy `max(1,N)` slot rồi `save_state` + return" nhưng bản đầu **quét vô hạn** trên chuỗi slot chết (đo: 200001 lần `getBlock` liên tục, tự guard của orchestrator mới dừng). Fix: tối đa 5 slot không dùng được (skip/None/non-dict) ⇒ `save_state` + return; block tốt vẫn return sau đúng 1 slot; `run_block_feed` = **49 dòng** (<50) nhờ tách generator `_block_txs`.
- Ngoài 3 điểm trên, transport trùng spec: `getBlock` là **nguồn tx duy nhất** (không `getTransaction` lần 2), resume từ `st["block_slot"]`, gap-jump khi lag > `block_max_lag`, `save_state` atomic dùng lại, `_handle_tx` là emit path duy nhất. Đo 20 slot: local p50 1085ms / 12.6MB/slot; server 698ms avg / 9.66MB/slot; **413/429/timeout = 0 ⇒ không thêm banner ceiling** (điều kiện >20% không kích hoạt), nhưng **ceiling thật đã lộ ra**: single-thread 0.7–1.2s/block so với slot ~0.4s ⇒ trên public RPC sẽ lag-gap thường xuyên (coverage hole) — ghi vào T12 + khuyến nghị RPC trả phí.

---

## 4. Tasks (thứ tự thực thi, mỗi task có verify + evidence)

Evidence dir: `.omo/evidence/gmgn-parity-fixes/` (tạo nếu chưa có). Mỗi task append log vào `<task-id>.log`. Cuối run phải in `EVIDENCE_RECORDED: .omo/evidence/gmgn-parity-fixes/`.

---

## TODOs

> Mirror thực thi của T1–T12. Chuỗi deps gốc: T1 → (T2,T3) → T4 → (T5,T6) → T7 → (T8,T9) → T10 → T11 → T12.
> **Ràng buộc file (quan trọng hơn thứ tự plan):** T2, T3, T4, T5, T6, T7 **cùng sửa `scripts/wallet_watch.py`** ⇒ **bắt buộc tuần tự** (1 writer/file). T8, T9, T10, T12 sửa file riêng ⇒ chạy song song được sau khi T7 xong (T9 cần output T8).
> Thứ tự thực thi chốt: T1 → T3 → T2 → T4 → T5 → T6 → T7 → [T8 ∥ T10 ∥ T12] → T9 → T11.

- [x] 1. [T1] Fixture + oracle loader (`scripts/fixtures/` + `block_sample.json`, không đụng production code) · deps: none · LIGHT
- [x] 2. [T2] `detect_swaps()` lõi §3 Bước 1-5 + bảng step-level có `PAIR`/`REJECT` · deps: T1,T3 · HEAVY · **verified độc lập 29/29·29/29·29/29 amount (23 exact + 6 gross), qi=1; deviation G1/G2 ghi ở §3-T2-notes**
- [x] 3. [T3] `TIER_A`/`TIER_B`/`_AGGREGATORS`, xoá `LAUNCHPAD_PROGRAMS` · deps: T1 · LIGHT
- [x] 4. [T4] Wire production: `_handle_tx` dùng chung feed, xoá `classify()`/`classify_swaps()`/`_swap_legs()`/`TRANSFER_*` + **xoá `scripts/test_gmgn_parity.py`** (test của hàm vừa bị xoá = dead code). **`test_wallet_watch.py` + `test_route_detect.py` sẽ ĐỎ tới T9** (chúng gọi `ww.classify()`; bản cập nhật thuộc §T9) — đỏ do thiết kế, không phải regression; T4 phải ghi rõ lỗi nguyên văn vào `T4.log` · deps: T2 · HEAVY
- [x] 5. [T5] Fix mất tx vĩnh viễn (`_seen_add` sau fetch) · deps: T4 · LIGHT
- [x] 6. [T6] `--rpc-url`/env + banner endpoint · deps: T4 · LIGHT · **verified độc lập: resolution arg→SOLANA_RPC_URL→RPC_HTTP→RPCS[0], `RPC_DEFAULTS` giữ nguyên làm fallback, `_wss()` suy từ endpoint (hardcode wss đã xoá), `api.mainnet-beta` còn đúng 1 literal, harness 24/24 + AST + ruff + state file untouched**
- [x] 7. [T7] Transport block scan thật + đo 20 slot trên server · deps: T5,T6 · HEAVY · **kèm fix hồi quy T4: gọi `sol_price()` 1 lần lúc feed khởi động** (T4 xoá `classify()` ⇒ call site duy nhất của `sol_price()` biến mất ⇒ `_sol_px` mãi = 0.0 ⇒ mọi step quote bằng WSOL có `quote_usd=0`/`usd_pending`; parity gate không phụ thuộc giá nên T2/T4 không bắt được — đo oracle-independence là chủ ý) · **verified độc lập: 3 deviation đo được ghi §3-T7-notes (ver 0→1 ở `_BLOCK_PARAMS` + `process_sig` getTransaction, skip matcher `"skipped"`, `--once` bound `_ONCE_MAX_SLOTS=5`); `run_block_feed` 49 dòng; once 4/4 case có bound; state file thật không đổi; 20-slot = local 1242ms/12.6MB, server 698ms/9.66MB, 413/429/timeout=0**
- [x] 8. [T8] `test_gmgn_api_parity.py` gate 29/29 + 4 mutation Red→Green · deps: T7 · HEAVY · **verified độc lập: gate exit 0 + PASS string nguyên văn, 2 run byte-identical, `wallet_watch.py` sha256 không đổi (d7705569…4720); test gọi module thật (`detect_swaps`/`_block_txs`), 0 literal base58 gõ tay (mint/sig đọc từ fixture), hermetic bằng hành vi (http_json/rpc/socket raise), tolerance pin REL_TOL=1e-6/GROSS_CAP=0.08; built-in 4/4 mutation RED→GREEN; orchestrator tự chạy THÊM 1 mutation độc lập (đảo tie-break `_base_quote` L545 `m1<m2`→`m1>m2`) → 4 FAIL RED (tie tx 58pWphuG OS↔CARDS)**
- [x] 9. [T9] `test_block_feed.py` + cập nhật `test_wallet_watch.py`/`test_route_detect.py` + retire `test_gmgn_parity.py` · deps: T8 · MEDIUM · **verified độc lập: cả 4 test file exit 0 + deterministic x2 (test_block_feed 19/19, test_wallet_watch 11/11 per-step + set-equality, test_route_detect 15/15, test_gmgn_api_parity PASS 29/29 nguyên vẹn); ruff+AST clean, LSP 0 error; `test_gmgn_parity.py` vắng mặt; 4 fixture `.pkl` giữ nguyên; **`wallet_watch.py` sha256 KHÔNG đổi (d7705569…4720)**; đọc code: `test_block_feed.py` dựng FakeRPC + gọi thật `run_block_feed`/`process_sig`, đủ 5 scenario i–v + sha guard state thật**
- [x] 10. [T10] `scripts/backtest_parity.py` (`--from-fixture`) · deps: T7 · MEDIUM · **verified độc lập: `--from-fixture` exit 0 + PASS string nguyên văn; policy D14 IMPORT từ gate T8 (`load_gate_module`, dùng `gate.REL_TOL`/`GROSS_CAP`/`PASS_LINE`) — không re-implement; ruff/AST clean; `gmgn.ai`=0 · `GMGN_API_KEY`=0; 2 run byte-identical; `wallet_watch.py` sha không đổi**
- [x] 11. [T11] Deploy + verify thật trên server (**DONE** — user authorize "continue"; deploy attempt 1 FAIL vì crash prod → fix `IncompleteRead` → attempt 2 PASS; còn 1 caveat coverage, xem sub-bullet) · deps: T8,T9,T10 · HEAVY · **BLOCKED — chờ user: deploy lên production `root@194.163.187.250:/opt/wallet-watch/` (scp tay, `make deploy` KHÔNG ship `scripts/`) + `systemctl restart wallet-watch` = thao tác trên service đang chạy production, không thể tự quyết. Toàn bộ T1–T10 + T12 đã xong nên T11 giờ chỉ còn là lever vận hành; F4 (production liveness) phụ thuộc T11 — NAY ĐÃ GỠ BLOCK: user gõ "continue" ⇒ deploy thật, bắt crash prod, fix, redeploy, verify PASS.**
  - **Deploy-readiness đo được (orchestrator, read-only probe — KHÔNG mutate):** ssh + key auth OK (`root@194.163.187.250`, host `vmi2958603`); service `wallet-watch` = `active`, pid 3187617, `ExecStart = venv/bin/python wallet_watch.py --min-usd 0.1 --jsonl /opt/wallet-watch/events.jsonl --track --api-url http://127.0.0.1:8124`, started `2026-09-14 11:35:25 CEST`.
  - **Production đang chạy code CŨ 100%:** remote `wallet_watch.py` sha256 `bf58888363a9049f4ff2eae8512c56c1511dbd1e497e839a0beeedcc874e30e7` / 39697 B (Sep 14 11:35) ≠ local `d7705569…4720` / 45735 B; remote `grep -c "def classify"`=**2** (legacy mà T4 đã xoá), `grep -c run_block_feed`=**0**. ⇒ `--feed` không có trong ExecStart ⇒ production vẫn transport cũ.
  - **Payload T11 chưa có trên server:** `fixtures/` = ABSENT, `test_gmgn_api_parity.py` = ABSENT, `backtest_parity.py` = ABSENT ⇒ bước scp của T11 còn nguyên công đoạn.
  - **Kết luận blocker:** KHÔNG phải thiếu quyền/không kết nối được — chỉ là gate "cần user confirm trước khi dispatch" do plan quy định + Destructive Operation Guard (restart service production đang ghi event). Chờ user gõ "go". ⇒ **user gõ "continue" ⇒ đã deploy thật; xem 4 sub-bullet kết quả bên dưới.**
  - **ATTEMPT 1 = FAIL (bắt crash prod thật):** scp `d7705569…4720`/45735 B + `fixtures/` (19 file) → gate offline TRƯỚC restart = **EXIT 0 / PASS 29/29 nguyên văn** → restart → **chết 31 s sau start**: `http.client.IncompleteRead(496520 bytes)` tại `run_block_feed` L973 → `rpc` L149 → `http_json` L142; `NRestarts` leo 1→**3** (restart-loop), traceback trong log leo 2→5. ROOT CAUSE: `IncompleteRead` ⊄ `OSError`/`URLError` ⇒ thoát except tuple của `rpc()` ⇒ vượt `except RuntimeError` ⇒ giết daemon; cùng lỗ `json.JSONDecodeError`. Lỗ MỚI do T7.
  - **FIX:** delegate `ses_f579b19d1ffeDJqHYAXzedIZfT` → +`import http.client`, except tuple += `http.client.HTTPException`,`json.JSONDecodeError`, nhánh non-skip ⇒ warn `# rpc skip slot {slot}` + bỏ slot (không chết); `-32004`/skipped giữ nguyên. Test mới `test_rpc_resilience.py` (200 dòng, 13/13) RED→GREEN. sha MỚI `d7a0cf2260e2381e2a5be7d12d4b3ad5db2e3bfaec9b1a87989195d7fa829818` / 46396 B. Local: 5/5 suite EXIT=0 (gate PASS 29/29 nguyên văn + MUTATION 4/4), LSP 0 error.
  - **ATTEMPT 2 = PASS:** gate TRƯỚC restart EXIT 0 → restart → sau 90 s: `active`, **`NRestarts=0`**, traceback KHÔNG tăng (5→5), `block_slot` 447429681→447430065; sau ~7 phút vẫn `NRestarts=0`, etime 06:47, `block_slot` 447431116. **Banner đã flush: `# watch 4 ví | feed=block | 5 quote-mints | min $0.1` ⇒ feed=block XÁC NHẬN.** `grep -ac TRANSFER_ watch.log` = **0**. `rpc skip slot` = 0.
  - **CAVEAT COVERAGE (chưa full — cần biết):** trên RPC công cộng feed lag-skip liên tục: **1178 gap-jump / 3721 slot bị bỏ**, max gap 67, KHÔNG có lỗi/rate-limit. `getBlock` ~1.1 s vs chain ~0.4 s/slot ⇒ `--block-max-lag 20` nhảy tới liên tục ⇒ **coverage thực tế thấp (~13–40% slot)** ⇒ vẫn CÓ THỂ miss swap. Đúng ceiling đã cảnh báo trước deploy. Muốn full coverage phải RPC trả phí (độ trễ thấp) / tăng song song. Rollback: `wallet_watch.py.bak.preT11.20260916T060207` (code cũ `bf588883…30e7`) + `…preT11b.20260916T061841` (bản crash).
- [x] 12. [T12] Docs 1 file (`docs/2026-09-15-gmgn-parity-and-block-feed.md`) · deps: T7 · LIGHT · **verified độc lập: file 182 dòng, đủ 7 `## ` section; `GMGN_API_KEY`=0; mọi số khớp plan nguyên văn (23/29, 6/29, 29/29×5, 0.2018/0.2025/0.2401/0.8259/4.8524/7.7500, 3.84×2, gross_leg, quote_inferred×2)**

## Final Verification Wave

- [x] F1. **APPROVE (sau re-run)**: lần 1 REJECT vì ledger thiếu `task-completed` cho T9/T10/T12 → orchestrator thêm 3 entry (ledger 13 dòng, mỗi task T1–T10,T12 đúng 1 entry) → re-run APPROVE. Evidence: T11.log vắng = gap đúng như dự kiến (T11 user-blocked), không phải defect. Evidence-completeness audit (§7 a–e): T1–T12 log tồn tại, PASS string đúng nguyên văn, 4 mutation FAIL + PASS cuối, số đo 20-slot, T11 grep counts — verifier độc lập (không phải executor)
- [x] F2. **APPROVE**: gate exit 0 + PASS string nguyên văn; 4/4 built-in mutation RED→GREEN; verifier TỰ dựng mutation RIÊNG (`_base_quote` tie-break L545 `m1<m2`→`m1>m2`) ⇒ 4 FAIL RED trên tx tie `58pWphuG` (OS↔CARDS) rồi revert 0; `REL_TOL = 1e-6` + `GROSS_CAP = 0.08` là literal pin và `backtest_parity.py` IMPORT (0 re-def); `grep -ri gmgn.ai scripts/` = 0 trong code (chỉ URL CDN nằm trong 2 fixture data, hermetic chứng minh không fetch); sha `wallet_watch.py` không đổi. Independent parity re-run from scratch: chạy lại gate T8 + 4 mutation trên con trỏ sạch, xác nhận tolerance pin rel 1e-6/dải 8% không bị nới (§5.6). **RE-VERIFIED on sha mới `d7a0cf22…` — V1 (F2 role) APPROVE + tự dựng 2 mutation RIÊNG ngoài 4 built-in: flip tie-break `_base_quote` ⇒ 4 FAIL (đúng row `58pWphuG` OS↔CARDS), siết `GROSS_CAP` 0.08→0.001 ⇒ 6 FAIL; revert ⇒ PASS 29/29 + file byte-identical. Gate hermetic (`block_network` stub `http_json`/`rpc`) ⇒ `rpc`/`run_block_feed` KHÔNG nằm trên đường parity ⇒ delta 3 hunk không thể ảnh hưởng kết quả.**
- [x] F3. **APPROVE**: D1 sạch (0 `openapi.gmgn.ai`, 0 `GMGN_API_KEY`, 0 field GMGN trong runtime `dex_native`/`cost_usd`/`launchpad`; 48 hit "gmgn" đều là comment/docstring/tên test); `grep -oE` base58 trên test gate = **0** (không mint/WALLET gõ tay ở đường so sánh; hằng TIER/aggregator trong `wallet_watch.py` là by-design của plan); không dep mới (chỉ stdlib + `websockets` sẵn có); `server/`+`src/` mtime ~30h TRƯỚC plan window (không bị đụng); 4/4 `.pkl` + 15/15 `.json` còn nguyên; `importlib` load OK + `detect_swaps` có mặt + sha khớp frozen; 0 secret (exec duy nhất = mutation harness trên source local, test-only). Constraint/scope/security review (§5.1–§5.9 + §8). **RE-VERIFIED on sha mới `d7a0cf22…` (sau fix IncompleteRead) — V2 (F1+F3 role) APPROVE**: diff 3 hunk error-handling-only ⇒ không dep mới (chỉ `http.client` stdlib); fixtures 19 file nguyên (29 row / 9 tx / 12→9 sig / 4 pkl); D1 sạch (0 `gmgn.ai`, 0 `GMGN_API_KEY`; 13 hit "gmgn" đều comment/docstring); 0 secret (base58 set y hệt prefix, chỉ program/mint công khai); ledger 14 dòng JSON hợp lệ + 0 artifact thiếu; evidence T1–T12 + F1–F3 đủ, F4 vắng = khớp `[~]`; production read-only: active/`NRestarts=0`/sha `d7a0cf22…`/`TRANSFER_`=0/banner `feed=block`; **13 traceback đều TRƯỚC banner run hiện tại, 0 SAU** ⇒ fix chứng minh sống (và V2 thấy đường mới bắn thật: `# rpc skip slot 447432844: …`). 2 discrepancy nhỏ: (F-1) mô tả "13 task-completed" thực ra là **12**; (F-2) T1 thiếu field `detail` → đã backfill. V2 cũng tự báo false-positive của chính nó (`429` khớp số slot `447·429·xxx`, không phải rate-limit).**
- [x] F4. **PASS — verify trên traffic thật (2026-09-16, evidence `.omo/evidence/gmgn-parity-fixes/F4.log`)**: 4/4 tiêu chí đạt trên event production thật. (1) `feed=block` chạy: banner `# watch 4 ví | feed=block | 5 quote-mints | min $0.1`, `block_slot` tiến 447429681→447434171, `NRestarts=0`, etime 23:14, sha `d7a0cf22…`. (2) `TRANSFER_` = 0 (`grep -ac TRANSFER_ watch.log`=0; 0 row mới chứa `TRANSFER_`). (3) **ASSERT count(`amount_basis`) == count(SWAP) == rows → `3 == 3 == 3` True** (events.jsonl 2012→2015; cả 3 row `type=SWAP` + `amount_basis=gross_leg`). (4) **đối chiếu tay 2/2 sig vs chain OK** (endpoint `api.mainnet-beta.solana.com`; publicnode/drpc/ankr trả 403 cho non-browser agent): `2RMZe33S…` chain_slot=447433502 == claimed, wallet∈tx, tx_err=None; `5pry7p7Z…` chain_slot=447433538 == claimed, wallet∈tx, tx_err=None ⇒ **2/2 OK, 0 fail**. Một tx (`5pry7p7Z…`) sinh 2 swap step (USDC + XspzcW) — đúng contract 1 event/swap-step. LƯU Ý đo traceback: naive measure báo "5 after banner" là do anchor vào banner ĐẦU (của run crash); đo đúng theo banner CUỐI (line 2932/4131) = **0**. CAVEAT không chặn F4: RPC công cộng lag-skip (gap_jumps=1178, slots_skipped=3721, max_gap=67, 0 error/rate-limit) ⇒ coverage ~13–40% ⇒ có thể miss swap trong khoảng bị nhảy; mọi swap QUAN SÁT ĐƯỢC đều emit đúng + verify on-chain; upgrade path = paid low-latency RPC.

---

### T1 — Fixture + oracle loader (không đụng production code)
- Tạo `scripts/fixtures/`: copy 12 tx JSON + `gmgn_rows_fixture.json` + `gm_activity_FhsbQ_50rows.json` từ `.omo/drafts/gmgn-parity-fixes-fixture/`.
  File trùng tên (`58pWphu.json` vs `58pWphuG.json`, `33hqSn4Q.json` vs `33hqSn4QyCKb.json`, `4zmaV87B.json` vs `4zmaV87BnoMS.json`) — đã đo **byte-identical** theo cặp (sha256 khớp, xem §2.5) ⇒ resolve theo **tx_hash thật bên trong file**: `json.load(f)["transaction"]["signatures"][0]` (**KHÔNG** có wrapper `result` — §2.5, 0/12 file) chứ không theo tên file ⇒ build `{sig: tx}` (dict tự dedupe 12→9) và assert đúng 9 sig, 29 rows. Field sig trong row fixture là **`tx_hash`**, không phải `sig`.
- Sinh `scripts/fixtures/block_sample.json` giả lập `getBlock`: `{"blockTime":…,"blockHeight":…,"transactions":[{"transaction":…,"meta":…,"version":…} cho 9 tx]}`.
- Verify: `python3 -c` in 9 sig + 29 rows + block_sample 9 tx. Evidence `T1.log`.

### T2 — `detect_swaps()` (lõi, §3 Bước 1-5)
- Viết mới trong `scripts/wallet_watch.py` (cạnh khối `# ---------- swap-level classify` L455, thay `classify_swaps()` L596-699).
- **In bảng verify trước khi chốt** (không đoán): mỗi step in `SIG | frame_key (tuple đầy đủ) | pool_key | base_mint_sym | quote_mint_sym | role(base.src) | role(base.dst) | side | qty_gross | quote_qty_gross | amount_basis`. Với **mọi leg bị loại** in thêm `REJECT <frame_key> <mint> <reason>` (`reason ∈ not_spl, plumbing, aggregator_frame, no_pool_endpoint, same_mint, unpaired`) và với mỗi cặp được ghép in `PAIR <frame_key> <base>←<quote> by=frame|pool_key|seq_gap`. Lý do: bản nháp thô của reviewer chỉ đạt 15/29 cho tới khi log đủ 2 loại dòng này ⇒ chiều cao stack trong `frame_key` và tie-break `|seq_base − seq_quote|` là phần ăn tiền, phải thấy được từng quyết định.
  Cuối bảng in 3 số: side exact, base/quote exact, amount exact — đối chiếu oracle. Kỳ vọng: `29/29 · 29/29 · 23/29 (+6 gross, §2.2)`.
- **Không** viết code suy LP fee / `amount_basis` per-row từ `dex_native`, `launchpad`, `G` marker §2.3 hay bất kỳ field GMGN nào — đã đo: tín hiệu đó không tồn tại trong payload tx (§3 Bước 5).
- `token_info()` L173: đổi negative-cache vĩnh viễn thành retry-TTL 60s (để `symbol_pending` tự lành).
- Verify: script nháp (xoá sau) hoặc đi thẳng T8 gate. Evidence `T2.log` = bảng trên.

### T3 — `GLOBAL_QUOTES`/`TIER_A`, `TIER_B`, `_AGGREGATORS` (không còn `LAUNCHPAD_PROGRAMS`)
- `TIER_A` = set mint {WSOL, USDC, USDT, DAI} — **cấm** WBTC/cbBTC/BTC-peg. Mint lấy từ fixture map, không gõ tay (§2.4).
- `TIER_B` = set mint {WBTC} (lấy từ fixture; kèm comment "add wETH-Wormhole 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs when a route uses it") → **xoá** yêu cầu `LAUNCHPAD_PROGRAMS` + suy stonkfun id của v1 (đã chứng minh không tất định: row `stonkfun` chạy qua Raydium/Meteora program).
- `_AGGREGATORS = {"JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH"}` (từ L477, L482).
- Verify: assert trong `test_gmgn_api_parity.py` rằng không mint BTC-peg nào ∈ `TIER_A`, và `LAUNCHPAD_PROGRAMS` **không tồn tại** trong module. Evidence `T3.log`.

### T4 — Wire production: xoá route-level, bỏ TRANSFER_*
- Tách `process_sig()` L816-851:
  - `_handle_tx(tx, sig, wallets, st)` = body L842-851 (keys filter + loop ví + `detect_swaps` + `print(fmt(ev))` + `jl_write(ev)` + `track_event(ev)`) — dùng chung **cả 3 feed** (block/ws/poll) ⇒ 1 emit path duy nhất.
  - `process_sig(sig, wallets, st, err)` giữ signature (ws/poll gọi L865, L931): fetch `getTransaction` L826-836 rồi gọi `_handle_tx`.
- Xoá `classify()` L337-453 và `classify_swaps()` L596-699 (dead sau khi wire) + nhánh phát `TRANSFER_IN/OUT/NEUTRAL` L426/L443/L449. `_swap_legs()` L527: giữ nếu `detect_swaps` dùng, không thì **xoá** (đừng để dead code lần 2 — bài học F1).
- `track_post_body()` L76-87 **giữ nguyên** (đã chỉ POST BUY/SELL).
- Verify: `grep -c "TRANSFER_" scripts/wallet_watch.py` = `0`; `python3 -c "import ast;ast.parse(open('scripts/wallet_watch.py').read())"`. Evidence `T4.log`.

### T5 — Fix mất tx vĩnh viễn (`_seen_add`)
- `_seen_add(sig)` L784-792 giữ; **dời call site**: `process_sig` L819 hiện mark TRƯỚC fetch ⇒ tx null (L840)/429 (except L837-839) là mất luôn. Sửa: fetch trước, chỉ `if not _seen_add(sig): return` **sau khi** `tx` non-null.
- Không sửa `rpc()` L138-157 (đã failover `RPCS` + `sleep(0.7)`): chỉ cần không mark seen ⇒ sweep kế tiếp tự retry (fix-forward, D-Q4).
- Verify: monkeypatch `rpc` trả `None` lần 1, tx thật lần 2 ⇒ event phát ở lần 2, `_seen` không chứa sig sau lần 1. Evidence `T5.log`.

### T6 — `--rpc-url` / env
- Thêm arg `--rpc-url` (default env `SOLANA_RPC_URL` → `RPC_HTTP` → hằng số L48). Khi set: `RPCS = [url] + RPCS_mặc_định`; WSS suy từ đó (`https://`→`wss://`) thay hardcode L886. In endpoint + số ví ở banner L1025-1027. Không auto-failover provider mới.
- Verify: `--once --feed poll` với `--rpc-url` endpoint sai ⇒ log in endpoint đó; `grep -n "api.mainnet-beta" scripts/wallet_watch.py` chỉ còn default list L48. Evidence `T6.log`.

### T7 — Transport: **block scan thật** (feed mới, mặc định)
- `run_block_feed(wallets, st, opts)`:
  ```
  slot = st.get("block_slot") + 1  nếu có, ngược lại rpc("getSlot",[{"commitment":"confirmed"}]) − block_backfill_slots
  loop:
    cur = rpc("getSlot",[{"commitment":"confirmed"}])
    nếu cur − slot > block_max_lag: in "# gap: skip slot X..Y (lag>Z)"; slot = cur − block_max_lag; save; continue
    blk = rpc("getBlock",[slot,{"encoding":"jsonParsed","transactionDetails":"full","maxSupportedTransactionVersion":1,"rewards":false,"commitment":"confirmed"}])   # ver=1 BẮT BUỘC — đo 2026-09-15, xem §3-T7-notes
    lỗi RPC chứa "-32004"/"skipped slot" ⇒ slot += 1; continue      # slot skipped là BÌNH THƯỜNG
    blk is None ⇒ slot += 1; continue
    for e in blk.get("transactions") or []:
        tx = {"slot":slot,"blockTime":blk.get("blockTime"),"transaction":e["transaction"],"meta":e.get("meta"),"version":e.get("version")}
        _handle_tx(tx, tx["transaction"]["signatures"][0], wallets, st)   # KHÔNG getTransaction lần 2
    slot += 1; st["block_slot"] = slot − 1
    nếu slot % block_save_every == 0: save_state(st)
    sleep(block_sleep)
  ```
- Knobs (argparse L949-995): `--block-backfill N` (0), `--block-max-lag N` (20 slot ≈ 8s), `--block-save-every N` (100), `--block-sleep S` (0.0). `--feed choices=["block","ws","poll"] default="block"`; `--once` ở mode block ⇒ chạy `max(1,N)` slot rồi `save_state` + return.
- `save_state(st)` L774-778 đã atomic (`tmp`+`os.replace`) ⇒ dùng lại; `st` thêm key `block_slot`.
- **Đo chi phí thật (bắt buộc trước khi coi xong):** 20 slot trên server với `--rpc-url` public; in `bytes/slot`, `ms/block`, HTTP status, số event. Nếu 413/429/timeout > 20% ⇒ ghi ceiling vào comment + banner `# ponytail: block-scan cần RPC trả phí (Helius/Triton); public mainnet-beta sẽ 429 ở ~2 block/s`. **Không** tự đổi design; báo user kèm số đo.
- Verify: `T7.log` = số đo 20 slot + `grep -c "getBlock" scripts/wallet_watch.py` ≥ 1 + banner `feed=block`.

### T8 — Tests: gate 29/29 (offline) — **gate theo policy D14**
- Mới `scripts/test_gmgn_api_parity.py` (pattern `importlib.util.spec_from_file_location` như `test_wallet_watch.py` L13-17):
  - Load `scripts/fixtures/*.json` (resolve sig từ `transaction.signatures[0]`); build `_info` seed từ fixture (`token.symbol`/`quote_token.symbol` ⇒ `_info[mint]=(sym, price)`); WSOL price = `_sol_px["v"]=100.0` như L116; `ww.min_usd = 0.0`. **Decimals lấy từ balances** (§2.2), không từ `token.decimals` (không tồn tại).
  - Chạy `detect_swaps(tx, WALLET)` với `WALLET = DATA["rows"][0]["wallet"]` (`DATA` = root `{source,caveat,tx_key,rows}` — phải qua `["rows"]`; không gõ literal), so 29 row theo `tx_hash` + `event_type`.
  - **Hard fail** nếu: thiếu row, thừa event, side sai, base/quote symbol sai, count/sig sai, hoặc amount sai rel-tol > 1e-6 trên row **không** flagged.
  - **Row `G` (6 row — danh sách đọc từ cột `amt` §2.3, chỉ phục vụ expected-value trong test):** hard fail nếu `emitted < oracle` hoặc nếu `rel_overstate > 0.08`, với **công thức pin cứng `rel_overstate = (emitted − oracle) / emitted`** (mẫu = **gross** mà detector phát — theo đúng bảng §2.2: max đo được `7.7500%`). **Cấm** lấy mẫu = oracle: row OS sẽ thành `8.4011%` > 8% ⇒ fail giả trên code đúng. **Không** assert per-row fee flag nào: `amount_basis == "gross_leg"` trên **mọi** event (assert hằng số này trên cả 29 event), vì không tồn tại tín hiệu per-row trong payload (§3 Bước 5 có số đo). 23 row không `G`: amount exact rel 1e-6.
  - Assert thêm: mọi event `type == "SWAP"`; không `side == "NEUTRAL"`; mỗi step có **đúng 1 endpoint POOL**; `WBTC mint not in TIER_A`; số event `quote_inferred == True` == **1** (đo lại theo đúng spec §3 Bước 4, F31: chỉ tie ở `58pWphuG` OS↔CARDS; `3nzGD2WV`/`3BbWVS3K` giải bằng rank OS 2.0 > CARDS 1.0 ⇒ không flag); và **cả 3** row OS↔CARDS đều có base == `OS`.
  - In `PASS steps 29/29 · identity 29/29 · side 29/29 · amounts exact 23/29 + 6 gross (amount_basis=gross_leg)`; ngược lại in bảng diff (mong đợi | thực nhận | role endpoints | frame_key | lý do pair/reject).
- **Red→Green bắt buộc** (chứng minh test có răng), cả **4** mutation, mỗi cái ghi output:
  1. cho `TIER_A` chứa mint WBTC ⇒ identity FAIL ở các row WBTC;
  2. bỏ điều kiện "đúng 1 endpoint POOL" (chấp nhận RELAY→RELAY) ⇒ thừa event hoặc side FAIL ở `33hqSn4Q`;
  3. đổi side thành "base chảy vào ví ⇒ BUY" ⇒ FAIL ≥ 11 row (đo được: rule ví-only đạt 18/29; rule không có RELAY đạt 22/29 + 7 AMBIG);
  4. đổi nguồn amount sang **delta balance** thay vì parsed instruction ⇒ FAIL ở `33hqSn4Q sell XBT ← WBTC 638160.364952` (delta vault đo được `99683.5682570003` / `619015.5540030003`).
   Revert cả 4 ⇒ PASS. Ghi 8 output (4 FAIL + PASS cuối + bảng step T2) vào `T8.log`.
- Evidence `T8.log`.

### T9 — Tests: block feed + cập nhật test cũ
- Mới `scripts/test_block_feed.py`: monkeypatch `ww.rpc` phục vụ `getSlot`/`getBlock` từ `fixtures/block_sample.json` (không network) ⇒ assert (a) đúng 29 event từ 9 tx, (b) block không chứa ví tracked ⇒ 0 event, (c) `rpc` raise `-32004 skipped slot` ⇒ qua slot sau, không chết, (d) lag > `block_max_lag` ⇒ nhảy tới + in dòng gap, (e) T5 case (tx None lần đầu).
- `scripts/test_wallet_watch.py` L56 `ww.classify` → `ww.detect_swaps`; bảng `EXPECTED` L40-55: **xoá** tuple side/type transfer, giữ BUY/SELL per-step (lấy giá trị thật từ output detector sau khi T8 pass rồi **review tay từng dòng** so on-chain legs — không paste mù). L101-114 (`track_post_body`) giữ nguyên.
- `scripts/test_route_detect.py` L45/L112 `ww.classify` → `ww.detect_swaps`; expectation viết lại mức **per-step** (giữ `route_txs.pkl`; expectation cũ không map được sang step nào ⇒ xoá + ghi chú lý do trong test, không chế số).
- **Retire** `scripts/test_gmgn_parity.py` (GT của nó là bảng paste bị cắt — chính nó gây kết luận sai F8) ⇒ thay bằng `test_gmgn_api_parity.py`. **Giữ** `scripts/fixtures/*.pkl`; lý do retire ghi vào `T9.log` + §6.
- Verify: cả 3 file test `PASS`. Evidence `T9.log`.

### T10 — `scripts/backtest_parity.py`
- Input: `--wallets`, `--limit N` sig (default 200) qua `getSignaturesForAddress`, `--from-fixture` (offline: 9 tx trong `scripts/fixtures/`).
- `--from-fixture` ⇒ so oracle 29 row, in parity % theo **đúng policy D14** (identity/side/step-count + amounts exact 23/29 & 6 row gross-bounded ≤ 8%) — chế độ CI/offline mặc định.
- Live ⇒ chỉ in event + count (tx cũ hơn ~4 ngày **không có oracle**: GMGN không phân trang, window 3.84 ngày — F16; in rõ `no_oracle`).
- **Không** gọi GMGN API ở chế độ nào (D1).
- Verify: `python3 scripts/backtest_parity.py --from-fixture` → in dòng PASS như T8. Evidence `T10.log`.

### T11 — Deploy + verify thật trên server
- `scp scripts/wallet_watch.py scripts/fixtures/*.json scripts/test_*.py scripts/backtest_parity.py root@194.163.187.250:/opt/wallet-watch/` (giữ cấu trúc `fixtures/` con). **`make deploy` KHÔNG ship `scripts/`** ⇒ bắt buộc scp tay.
- Trên server: `cd /opt/wallet-watch && python3 test_gmgn_api_parity.py` (offline, phải PASS **trước** khi restart) → `systemctl restart wallet-watch` → `journalctl -u wallet-watch -n 80` phải có banner `feed=block` + event SWAP, **không** `TRANSFER_`.
- `wc -l events.jsonl` trước/sau, `grep -c TRANSFER_` trên tail mới ⇒ 0.
- 10 phút sau: `tail -50 events.jsonl` ⇒ đối chiếu tay 1-2 sig với solscan; assert mọi event mới có `amount_basis == "gross_leg"` (`grep -c '"amount_basis": *"gross_leg"'` bằng số dòng SWAP mới).
- Evidence `T11.log` (banner + tail + grep counts + `systemctl status` ngắn).

### T12 — Docs (1 file, ngắn)
- `docs/2026-09-15-gmgn-parity-and-block-feed.md`: semantics GMGN row (§2.1), **giới hạn LP-fee** (§2.2: tại sao amount là gross, 6/29 row lệch 0.20–7.75%, semantics `amount_basis="gross_leg"` = "số này là leg gross on-chain; net của GMGN có thể thấp hơn đúng bằng LP fee của pool, và không suy được per-row"), rank rule base/quote (§3 Bước 4), RELAY/POOL role rule (§3 Bước 3), ceiling block-scan (số đo T7 + khuyến nghị RPC trả phí khi > ~10 ví), giới hạn oracle (window 3.84 ngày, không phân trang, ban sau ~5 call nhanh), cách chạy `backtest_parity.py`.
- Verify: file tồn tại; `grep -c GMGN_API_KEY` = 0. Evidence `T12.log`.

**Dependencies:** T1 → (T2,T3) → T4 → (T5,T6) → T7 → (T8,T9) → T10 → T11 → T12. Không task nào đụng `server/` hay `src/` (FE).

---

## 5. Constraints cho worker (không thương lượng)

1. **Không gọi GMGN API.** Không file nào import/URL tới `openapi.gmgn.ai`; không field nào của GMGN (`dex_native`, `price`, `cost_usd`…) được dùng trong runtime logic — chỉ dùng trong test để đối chiếu. (Thực nghiệm: 5 call nhanh ⇒ `RATE_LIMIT_BANNED`; `limit=100`/`cursor` cũng bị BAN.)
2. Không dependency Python mới (hiện trạng: stdlib + `websockets` cho feed ws). `getBlock` path không cần `websockets`.
3. Không network trong `detect_swaps()` — chỉ đọc cache `_info/_supply/_sol_px`. Symbol thiếu ⇒ `symbol_pending`, **không** block event, **không** retry vô hạn trong loop (`token_info()` L173 đổi negative-cache vĩnh viễn thành retry-TTL 60s — làm trong T2).
4. Không đổi `server/`, `src/` (FE), schema `wallet_trades`, Nansen poller, framework01 scoring.
5. Không xoá fixture/pkl cũ (oracle là tài sản khan hiếm — GMGN không trả lại history).
6. **Không "sửa cho pass" bằng nới tolerance / whitelist theo sig.** Tolerance cố định **rel 1e-6 trên uiAmount** (không phải int-equal trên raw — xem artifact §2.2). Riêng 6 row LP-fee áp đúng policy §2.2/T8. Nếu 1 row không đạt ⇒ sửa detector, không sửa test.
7. **Không hardcode mint/address/WALLET bằng tay trong code hoặc test** — build từ fixture (§2.4). Đã có tiền lệ bug: mint WBTC gõ tay sai đuôi ⇒ rank rule 28/29.
8. Repo rule function < 50 dòng / file < 800 dòng: `wallet_watch.py` hiện **đã** 1047 dòng (vi phạm có sẵn). **KHÔNG tách module mới** (3 test load bằng `importlib.util.spec_from_file_location("wallet_watch", …)` ⇒ tách file phá import path). Bù lại T4 **xoá** `classify()` (~117 dòng L337-453) + `classify_swaps()` (~104 dòng L596-699) ⇒ net diff gần trung tính; mỗi hàm mới (`detect_swaps`, `_legs_with_roles`, `_pair_steps`, `_rank_mints`, `_base_quote`) < 50 dòng.
9. Repo không phải git repo ⇒ mỗi task tự ghi evidence file; không có `git diff`.

---

## 6. Rủi ro đã biết + cách xử (không cần hỏi lại owner)

| Rủi ro | Xử lý |
|---|---|
| Step có LP fee ⇒ amount gross ≠ GMGN | Đã là **policy chấp nhận** (§2.2, D14): emit gross + `amount_basis="gross_leg"` hằng số; gate 23/29 exact + 6 row bounded ≤ 8%. Không decode fee per-DEX (cần `getAccountInfo` + layout từng program, mâu thuẫn comment L461-470, và fee đã chứng minh không có trong payload) |
| Worker cố suy flag/basis per-row từ delta balance hay field oracle | Đã đo và bác bỏ (MB1 v2): rule delta chỉ fire 1/6 row fee (XBT fire vì token-2022 transfer-fee), còn quét mọi POOL account cùng mint thì fire bừa trên row exact ⇒ không tồn tại tín hiệu per-row. `amount_basis` là hằng số (§3 Bước 5); cột `G` §2.3 chỉ là expected-value của test |
| Worker thử dùng `logMessages`/`SwapEvent` làm nguồn step | Đã đo: chỉ 2/9 tx có, `58pWphuG` 5 SwapEvent vs 4 row ⇒ loại (§3). Dùng parsed legs + balances |
| Worker lấy decimals từ `token.decimals` | Field không tồn tại trong row GMGN (chỉ `quote_token` có) ⇒ base amount sai ×10^dec (đã gặp khi verify). Lấy từ `uiTokenAmount.decimals` (§2.2) |
| Worker hardcode mint/WALLET tay | Đã gặp: WBTC mint sai đuôi ⇒ 28/29. Constraint §5.7 |
| Tie-break rank khi 2 mint cùng rank (chỉ `58pWphuG` OS↔CARDS) | **Đã đo, đã chốt:** mint OS < mint CARDS ⇒ lex-nhỏ-hơn = base = OS = oracle. Chỉ **1** row tie (`quote_inferred==1`); 2 row OS↔CARDS còn lại giải bằng rank OS 2.0 > CARDS 1.0 (§3 Bước 4, F31). T8 assert base == OS trên cả 3 + count tie == 1; nếu fail ⇒ sửa detector, không đảo direction |
| `stonkfun`/launchpad program id không xác định được tất định | Không cần nữa — `LAUNCHPAD_PROGRAMS` đã xoá (T3); base/quote dùng rank rule |
| DEX token/token không global quote, không tier, không linking | Rank 99 cả hai ⇒ lex tie-break + `quote_inferred=True` (trong fixture: **1 row/29** — `58pWphuG` OS↔CARDS; 2 row OS↔CARDS kia có rank lệch nên không flag) |
| Block jsonParsed quá lớn / 413 / 429 trên public RPC | Đo ở T7 (20 slot); trần ⇒ banner warning + khuyến nghị `--rpc-url` paid; `--block-max-lag` nhảy tới, không kẹt |
| Trùng event khi block feed + sweep cùng thấy 1 tx | `_seen` dedupe (T5, mark **sau** fetch) |
| `test_route_detect.py` expectation cũ không map sang per-step | Viết lại ở mức step; expectation vô căn cứ ⇒ xoá kèm lý do trong test (không chế số) |
| Metadata service (DexScreener) chết ⇒ symbol `CARDSc…` | `symbol_pending` + retry TTL; oracle gate seed `_info` từ fixture nên test không flaky |
| `test_gmgn_parity.py` cũ còn được ai đó chạy | Retire ở T9 (lý do ghi evidence); GT của nó là bảng paste bị cắt ⇒ sai (F8) |
| 100 ví trên block feed | Block feed **không phụ thuộc số ví** (1 lần tải block, lọc trong RAM) ⇒ mạnh hơn ws (1 sub/ví) và GMGN (cap 50 row/ví, không phân trang). Chi phí = CPU/RPC. Ghi vào T12 |

---

## 7. Evidence (bắt buộc trước khi claim done)

- Dir `.omo/evidence/gmgn-parity-fixes/` — 1 file `.log` mỗi task (T1…T12).
- Phải có: (a) bảng step-level của T2 (kèm các dòng `PAIR`/`REJECT` §4 T2); (b) output `PASS steps 29/29 · identity 29/29 · side 29/29 · amounts exact 23/29 + 6 gross (amount_basis=gross_leg)`; (c) **4** mutation FAIL + PASS cuối của T8 (Red→Green); (d) số đo 20-slot của T7; (e) T11: `systemctl restart` + banner `feed=block` + `grep -c TRANSFER_` = 0 trên event mới + count `amount_basis` = count event SWAP mới.
- Kết thúc run in: `EVIDENCE_RECORDED: .omo/evidence/gmgn-parity-fixes/`

## 8. Scope OUT (Must NOT)
GMGN trong hot path / auto-track; khôi phục `server/src/providers/gmgn.ts`; endpoint GMGN signed (`wallet_holdings`); pagination GMGN; **decode LP fee per-DEX để ra số net** (đã loại — D14); schema `wallet_trades`; FE/server; provider auto-failover; backfill oracle cho tx cũ hơn ~4 ngày; xoá fixture/pkl cũ; thêm field `launchpad` vào event; module mới tách từ `wallet_watch.py`.

## 9. Out-of-plan (làm sau nếu cần)
- Đẩy symbol/qty về server (`wallet_trades` thêm cột) để dashboard hiển thị amount — seam server `WalletActivity` chỉ có `{tx,ts,side,ca,chain,amountUsd,price}` (F6) ⇒ ngoài plan này.
- Nếu sau này cần **amount net exact**: phải decode LP fee theo từng DEX (pool state + layout) — cần quyết định mới của owner, kèm đo chi phí RPC; bằng chứng hiện tại cho thấy fee không nằm trong payload tx (§2.2).
