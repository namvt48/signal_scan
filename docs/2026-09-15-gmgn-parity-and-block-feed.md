# Parity GMGN và block feed

Tài liệu này ghi lại cách detector swap-step khớp oracle GMGN, các giới hạn
đã đo được, và cách vận hành feed mới. Nguồn số liệu: plan
`.omo/plans/gmgn-parity-fixes.md`, fixture `scripts/fixtures/gmgn_rows_fixture.json`,
và evidence `.omo/evidence/gmgn-parity-fixes/`.

## 1. Semantics của một row GMGN

Một row GMGN không phải một route và không phải net theo ví. Cách hiểu đúng:

- 1 row = 1 **bước** swap qua đúng 1 pool (DEX hoặc launchpad curve).
- `token` / `token_amount` là **base** của pool đó; `quote_token` / `quote_amount`
  là **quote** của pool đó.
- `event_type buy|sell` tính theo **bước đó**, không tính theo route. Một tx có
  thể vừa buy vừa sell cùng một token ở hai pool khác nhau. Ví dụ `58pWphuG` có
  cả `sell OS→WSOL` và `sell OS→CARDS`.
- `launchpad_platform` (`Pump.fun`, `stonkfun`, `""`) là metadata GMGN gắn từ
  program id, **không** dùng để suy base/quote. Các row `stonkfun` thực tế chạy
  qua program Raydium/Meteora, nên map launchpad sang base/quote không tất định.
- Fee leg của aggregator (Jupiter/DFlow) **không tạo row**. Row chỉ sinh ra khi
  leg có endpoint là **POOL**.

Vì vậy detector phát ra đúng 1 event cho mỗi bước qua 1 pool, khớp oracle về
side, symbol base/quote và số step, không thừa không thiếu: **29/29**.

## 2. Giới hạn LP-fee: vì sao amount là gross

Số GMGN bằng `gross leg on-chain − LP fee của chính step đó`, khớp tới khoảng
1e-14 (sai khác chỉ do artifact làm tròn chuỗi lưu trong fixture).

**LP fee không tồn tại trong payload `getTransaction`.** Đã tìm bằng 4 cách
trên cả 6 case, 0 hit: delta token balance, raw text JSON, base64 của mọi field
`data` / `accountData`, và base64 của mọi dòng `Program data:` trong
`logMessages`. Không có `feeAmount` hay `transferCheckedWithFee` nào mang con số
này. Token-2022 trong fixture chỉ có transferChecked thường.

Hệ quả: exact net là bất khả thi từ RPC. Worker emit **gross**. Nguồn amount
bắt buộc là parsed instruction (`transferChecked.amount` / `tokenAmount.amount`),
**không** phải delta balance, và `decimals` lấy từ
`pre/postTokenBalances[].uiTokenAmount.decimals` theo mint.

Kết quả đo trên 29 row: **23/29 row exact cả hai phía**, và **6/29 row** lệch về
phía gross nằm trong khoảng **0.20% đến 7.75%**:

| sig | mint | phía | gross leg on-chain | oracle | overstate của gross |
|---|---|---|---|---|---|
| 58pWphuG | CARDS | base | 6407.891356 | 6394.913585 | +0.2025% |
| 58pWphuG | OS | base | 1947084.2203146615 | 1796185.193240272 | +7.7500% |
| 5XLTG1WX | ORE | base | 9.5460692188 | 9.46722534902 | +0.8259% |
| 33hqSn4Q | XBT | base | 102766.565214 | 97779.906425 | +4.8524% |
| 3nzGD2WV | USDC | quote | 450.798346 | 449.888419 | +0.2018% |
| 3BbWVS3K | USDC | quote | 151.328066 | 150.96474 | +0.2401% |

Ý nghĩa của `amount_basis = "gross_leg"`: **đây là leg gross on-chain**. Net của
GMGN có thể thấp hơn đúng bằng LP fee của pool, và fee đó **không suy được
per-row** từ payload. Field này là **hằng số trên mọi event**, không phải flag
theo từng row.

Lý do không có tín hiệu per-row: rule "`|delta|` của endpoint POOL nhỏ hơn `qty`
thì có fee" chỉ fire 1/6 row fee (row XBT fire vì token-2022 transfer-fee, không
phải LP fee); 5 row còn lại delta bằng đúng gross. Nếu quét mọi POOL account
cùng mint thì rule fire bừa trên cả row exact. Vì vậy detector không được suy
`amount_basis` từ delta balance, từ `dex_native`, `launchpad`, `price`, hay bất
kỳ field GMGN nào.

Tolerance so sánh là rel **1e-6** trên uiAmount, không phải int-equal trên raw.
Gate dùng công thức `rel_overstate = (emitted − oracle) / emitted` (mẫu = gross),
cap **8%**. Nếu lấy mẫu là oracle thì row OS thành 8.4011% và fail giả.

## 3. Rank rule cho base/quote

Trong phạm vi 1 tx, dựng đồ thị cặp mint từ các step đã pair, rồi gán rank:

1. `rank[m] = 0.0` nếu `m ∈ TIER_A` (WSOL, USDC, USDT, DAI); `rank[m] = 0.5`
   nếu `m ∈ TIER_B` (WBTC). Seed theo rank tăng dần.
2. BFS từ các seed: `rank[y] = rank[x] + 1` với `y` kề `x` chưa có rank. Mint
   không reach được đặt `rank = 99`.
3. Với mỗi step `(m1, m2)`: **rank nhỏ hơn = quote, rank lớn hơn = base**.
4. Rank **bằng nhau** thì base là mint **lexicographically nhỏ hơn**, quote là
   mint lớn hơn, và gắn `quote_inferred = True`.
5. Không reach được cả hai thì cũng theo rule 4 và gắn `quote_inferred = True`.

Kết quả đo được là **29/29** base+quote exact. Chỉ có **1** row tie duy nhất,
`58pWphuG sell OS ← CARDS`, ở đó OS và CARDS cùng rank 1.0 vì tx đó có cạnh
OS↔WSOL. Tie-break đã kiểm chứng: mint OS `8LstZpZu…` nhỏ hơn mint CARDS
`CARDSccU…` (lexicographic), nên lex-nhỏ-hơn = base = OS, đúng oracle.

Hai row OS↔CARDS còn lại (`3nzGD2WV`, `3BbWVS3K`) **không phải tie**: không có
cạnh OS↔WSOL trong tx đó, BFS cho `rank OS = 2.0 > CARDS = 1.0`, base = OS theo
rank-difference. Chỉ riêng `TIER_A` đạt 25/29; thêm `TIER_B` (WBTC) thì đạt
29/29.

## 4. Role rule RELAY và POOL

Role của mỗi endpoint leg xác định **bằng dữ liệu balance**, không bằng denylist
program id:

```
role(a) = "WALLET"  nếu owner(a) == wallet
          "RELAY"   nếu a không có trong pre/postTokenBalances  HOẶC  post(a) − pre(a) == 0
          "POOL"    ngược lại (owner != wallet và net delta != 0)
```

Yêu cầu cứng: mỗi step hợp lệ phải có **đúng 1 endpoint POOL**. Leg mà cả hai
endpoint đều RELAY là leg rác chuyển nội bộ route và bị bỏ. Phân bố đo được trên
fixture: `POOL→WALLET 5, WALLET→POOL 7, POOL→RELAY 11, RELAY→POOL 6` = **29/29**,
**0 AMBIG**. Có **17/29** row mà RELAY là một endpoint, nên đây là mainline chứ
không phải edge case.

Phân loại bằng balance là bắt buộc, vì cùng một authority vừa là `src` vừa là
`dst` trong cùng tx. Không được phân loại RELAY bằng denylist program id.

`pool_key(step)` là `owner` của endpoint POOL. Side xét theo leg của **base**
mint: POOL là `src` (pool gửi base ra) thì `side = BUY`; POOL là `dst` (pool nhận
base vào) thì `side = SELL`. Không dùng "base có chảy vào ví không", vì 17/29
step không chạm ví trực tiếp và `33hqSn4Q` có 2 row cùng mint cbBTC với side
ngược nhau. Side đạt **29/29**.

## 5. Trần của block-scan

Transport chính là quét block thật (`getBlock`), và đây là mặc định:
`--feed block` là default transport. Đo 20 slot thật trên mainnet ngày
2026-09-15:

- Local: p50 **1085ms**, p95 **2274ms**, **12.6MB** mỗi slot.
- Server: trung bình **698ms** mỗi block, **9.66MB** mỗi slot (p50 691ms, p95 929ms).
- **0** lần 413, **0** lần 429, **0** timeout.

Vì tỉ lệ lỗi dưới 20% nên không thêm banner ceiling. Nhưng trần thật đã lộ ra:
single-thread mất khoảng 0.7 đến 1.2 giây mỗi block, trong khi slot chỉ khoảng
0.4 giây. Trên public RPC việc này sẽ lag và gap-jump thường xuyên, tạo coverage
hole. Block feed không phụ thuộc số ví (tải 1 block rồi lọc trong RAM), nhưng
**khuyến nghị dùng RPC trả phí khi vận hành hơn khoảng 10 ví** để tránh lag-gap
và 429. Dùng `--rpc-url` để trỏ endpoint trả phí.

Hai chi tiết transport bắt buộc:

- `maxSupportedTransactionVersion=1`. Đo thật: ver=0 khiến `getBlock` trả lỗi
  `-32015 Transaction version (1) is not supported by the requesting client` và
  feed chết ngay slot đầu. Ver=1 mới đọc được block thật. Lỗi này cũng đã từng
  làm feed ws/poll âm thầm mất mọi tx version-1.
- Chế độ `--once` ở block feed có bound `_ONCE_MAX_SLOTS = 5` để không quét vô
  hạn trên chuỗi slot chết. `sol_price()` được gọi đúng 1 lần lúc feed khởi động
  để `quote_usd` của step quote bằng WSOL không bị 0.

## 6. Giới hạn của oracle GMGN

Oracle GMGN là tài sản khan hiếm và có ba giới hạn đã đo:

- **Window khoảng 3.84 ngày.** Quan sát được ts_min `1789115574` đến ts_max
  `1789144638`, cap 50 row. Tx cũ hơn khoảng 4 ngày **không có** oracle.
- **Không có phân trang.** `before=<ts>` bị ignore; `max_timestamp` trả
  `429 RATE_LIMIT_EXCEEDED`; `cursor` và `limit=100` trả `429 RATE_LIMIT_BANNED`.
- **Ban IP sau khoảng 5 call nhanh.** Thực nghiệm 5 call cách nhau dưới 2 giây từ
  VPS thì 2 call cuối `RATE_LIMIT_BANNED`. Vì vậy mọi dùng GMGN live phải throttled
  và không được đặt trong watch loop.

Hệ quả: backtest lịch sử phải dùng fixture đã snapshot, không thể kéo lại oracle
cho tx cũ.

## 7. Cách chạy `scripts/backtest_parity.py`

Script này là deliverable T10. Chế độ offline (mặc định cho CI) không gọi network
và không gọi GMGN API:

```bash
# offline, so 29 row oracle trong scripts/fixtures/, in parity %
python3 scripts/backtest_parity.py --from-fixture
```

Chế độ live dùng RPC để lấy signature của ví (không gọi GMGN API):

```bash
# live: liệt kê event + count; --limit mặc định 200
python3 scripts/backtest_parity.py --wallets <csv-hoặc-đường-dẫn> --limit 200
```

Ở chế độ live, tx cũ hơn window oracle (khoảng 3.84 ngày) sẽ in `no_oracle`, vì
GMGN không trả lịch sử xa hơn. Ở chế độ `--from-fixture`, script in đúng dòng
PASS cùng policy với gate T8: identity/side/step-count, amount exact 23/29 và 6
row gross-bounded trong 8%.
