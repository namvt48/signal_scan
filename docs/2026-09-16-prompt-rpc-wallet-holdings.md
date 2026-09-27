# Prompt — thay Nansen credit API bằng Solana RPC cho `wallet_token_state`

> Dán nguyên khối dưới đây vào agent. Scope đã chốt: **chỉ nhánh balance** (2 cột
> `Tracked by` + `Holding %`). Nhánh trades cố ý loại trừ (xem MUST NOT DO #1).

---

## TASK

Thay nguồn dữ liệu của `wallet_token_state` từ Nansen credit API
(`POST /api/v1/profiler/address/current-balance`, 1 credit mỗi cặp wallet×CA,
hiện đang 403 `Insufficient credits`) sang **Solana JSON-RPC trực tiếp**, để 2 cột
`Tracked by` và `Holding %` trên Token watchlist không còn phụ thuộc credit.

Không đổi định nghĩa hiển thị của 2 cột. Không đụng cột `Inflow 24h`.

## CONTEXT — bắt buộc đọc trước khi sửa

**Chi phí hiện tại (đo được, không đoán):**
- 11 wallet × 499 CA sol = **5.489** credit/lượt (+11 cho `dexTrades`).
- `POLL_WALLETS_MS=900s` → ~22.000 credit/h ≈ **528k credit/ngày**.
- Triệu chứng: `wallet_trades.max(ts)` trễ **27,5 giờ**, `wallet_token_state` chỉ có
  **14 row**, log 6h có 8× `Insufficient credits`.
- Comment trần đã ghi sẵn: `nansen.ts:510` — *"wallets×CAs credits is the ceiling"*.

**Đường dữ liệu hiện tại (đã trace, đừng trace lại):**

```
poller.walletSweep (poller.ts:150)
  ├─ provider.walletActivity      → insertTrades       → wallet_trades    [GIỮ NGUYÊN]
  └─ provider.walletTokenBalances → replaceWalletBalances → wallet_token_state  [THAY BẰNG RPC]
                                            │
                        ┌───────────────────┴───────────────────┐
              signals.trackedByNames (:70)            signals.sumHoldingUsd (:59)
              EXISTS balance_usd > 0                  → assembleSignals (:181-183)
              → cột "Tracked by"                        trackedHolding = holdingUsd/marketCap*100
                                                        → cột "Holding %"
```

Đây là **toàn bộ** reader của `wallet_token_state` — 2 cái trên, không còn chỗ nào khác.

**Toán học quyết định thiết kế:**

`holdingUsd = Σ(amount_i × price)` và `marketCap = price × supply`
⇒ `trackedHolding ≈ Σamount_i / supply` — **price tự triệt tiêu**.

Hệ quả: RPC **không cần lấy giá**. `getTokenAccountsByOwner` trả sẵn `tokenAmount`;
`token_state.supply` đã có từ free door. Chỉ cần 2 số đó.

**Vì sao KHÔNG cần gate `entry_usd ≥ minUsd`:** với 1 call/wallet thì không còn áp lực
chi phí theo số CA ⇒ sweep **toàn bộ** tracked CAs. Nhờ vậy semantics của `Tracked by`
giữ y nguyên và **tránh được rủi ro lệch gate** với `assembleSignals:163`. Đây là lý do
đường RPC thắng cả phương án "thu hẹp fan-out".

**RPC là hướng đã được chứng minh trong repo, không phải lý thuyết:**
`scripts/wallet_watch.py:235` đã có client JSON-RPC multi-endpoint + fallback
(`SOLANA_RPC_URL` → `RPC_HTTP` → defaults) và `detect_swaps()` ở `:702`.
Đọc file đó để tái dùng đúng convention (retry transport, coi body dị dạng là lỗi
transport chứ không giết daemon). **Không** port code Python sang TS máy móc — chỉ copy
chiến lược endpoint/retry.

## REQUIRED TOOLS

`read`, `edit`, `bash`, `grep`, `lsp_diagnostics`. Chạy test trong `server/`.
Được phép `curl` một Solana RPC công khai để verify programId (bước MUST DO #1).

## MUST DO

**1. Verify Token-2022 TRƯỚC KHI VIẾT CODE — đây là bẫy silent số 1.**
Memecoin hiện phần lớn nằm ở Token-2022 program, không phải SPL Token cổ điển. Bỏ sót
programId thứ 2 ⇒ ví biến mất âm thầm khỏi `Tracked by`. Chạy `getTokenAccountsByOwner`
với **cả hai** programId trên 1 wallet đang track thật và đối chiếu kết quả:
- SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`

Report con số thật (bao nhiêu account mỗi program, có mint nào trùng tracked CA không).

**2. Gọi RPC bằng `fetch` thẳng, không thêm dependency.**
Repo đã gọi raw `fetch` tại `nansen.ts:352`. Không cài `@solana/web3.js` hay tương tự.
Body: `{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner","params":[...]}`.
Dùng `encoding: "jsonParsed"`.

**3. Lấy TOÀN BỘ token account của ví trong 1 call/ví — không filter mint.**
```jsonc
// ĐÚNG — 1 call/ví/programId, lọc mint ở local
"params": [wallet, {"programId": "<PROGRAM>"}, {"encoding": "jsonParsed"}]
```
Với 11 ví × 2 programId = **22 call/chu kỳ**, không phụ thuộc số CA.
Lọc local: `mint ∈ listTrackedCas().filter(chain === 'sol')`.

**TUYỆT ĐỐI KHÔNG** dùng `getMultipleAccounts` trên ATA derive (PDA) từng cặp
wallet×CA — max 100 account/call ⇒ 55 call/ví ⇒ 605 call. Tệ hơn hẳn.

**4. Parse amount đúng, chịu được payload xấu.**
- `account.data.parsed.info.mint`
- `account.data.parsed.info.tokenAmount.uiAmountString` (string, luôn có)
  → fallback `tokenAmount.amount / 10^tokenAmount.decimals` khi `uiAmountString` vắng.
- `uiAmount` có thể `null` — không dùng trực tiếp.
- **1 mint có thể có nhiều token account** (hiếm) ⇒ **SUM**, không lấy `[0]`.
- `amount === 0` ⇒ bỏ row (đừng ghi row rỗng).

**5. Thêm cột `token_amount REAL NOT NULL DEFAULT 0` vào `wallet_token_state`** (`db.ts:134`).
Lý do: balance tính theo giá sẽ bằng 0 khi giá thiếu/stale, làm ví rơi khỏi `Tracked by`
một cách sai. `token_amount` là "ví đang sở hữu" — đúng semantics, không phụ thuộc giá.
Bảng chỉ có 14 row nên migration rẻ; dùng `ALTER TABLE ... ADD COLUMN` (không drop data).

**6. `replaceWalletBalances` (`ingest.ts:171`) ghi cả `token_amount`.** Giữ nguyên
DELETE + INSERT trong 1 transaction (comment Metis ở `:166` — wallet bán hết phải decay).

**7. `balance_usd` giữ nguyên nghĩa nhưng KHÔNG còn là nguồn của 2 reader.**
Tính tại write: `balance_usd = amount × token_state.price` (tra 1 lần/CA, cache trong
map cho cả lượt sweep). Giá thiếu/0 ⇒ `balance_usd = 0` nhưng `token_amount` vẫn đúng.

**8. Chuyển 2 reader sang `token_amount`:**
- `trackedByNames` (`signals.ts:75-76`): `s.balance_usd > 0` → **`s.token_amount > 0`**.
- `sumHoldingUsd` (`signals.ts:59`) → `sumHoldingAmount`: `SUM(token_amount)`.
- `assembleSignals` (`signals.ts:181-183`): `trackedHolding = supply > 0 ? Σamount/supply*100 : 0`.
  Guard đổi từ `marketCap > 0` → `supply > 0`. **Xoá** biến `holdingUsd` nếu không còn
  dùng (không để dead code).

**9. Solana-only. Non-sol giữ nguyên đường Nansen và phải hiện rõ.**
Nếu chain ≠ `'sol'` → **fallback** về `api.currentBalance` như cũ; log `warn` một lần
mỗi chain để credit burn còn lại là *nhìn thấy được*, không ẩn. Không được throw chết
ví non-sol.

**10. Endpoint + config:** thêm `solanaRpcUrl` vào `server/src/config.ts`, đọc env
**`SOLANA_RPC_URL`** (trùng tên `scripts/wallet_watch.py:1193` — dùng `RPC_HTTP` làm
fallback). Cho phép nhiều endpoint, thử lần lượt như `rpc()` của script. Không hardcode
endpoint trong provider.

**11. Thêm method vào `MarketDataProvider` seam** (`provider.ts`) theo đúng convention
"accept interfaces": ví dụ `walletTokenHoldings(wallet, chain): Promise<{ca, amount}[]>`.
Cập nhật **cả** `mock.ts` (`walletTokenBalances` ở `:132`) để mock mode vẫn chạy full
pipeline không cần key — mock phải sinh `token_amount` cùng pool `MOCK_CA_POOL`.
Đây là yêu cầu cứng: `MODE=mock` phải xanh sau khi sửa.

**12. Giữ error handling như hiện tại:** `poller.ts:159-169` bọc `try/catch` từng ví,
một ví lỗi không được giết cả sweep. RPC lỗi ⇒ log rõ method + ví (rút gọn address),
không silent.

**13. Evidence — không có bằng chứng thì chưa xong:**

| Việc | Bằng chứng bắt buộc |
|---|---|
| Token-2022 | Output call thật cho cả 2 programId, nêu số account + mint trùng tracked CA |
| Tests | `cd server && npm test` → 0 failures (dán output) |
| Mock mode | `MODE=mock` chạy 1 sweep → `wallet_token_state` có row, 2 cột render |
| Số không đổi nghĩa | So `trackedHolding` cũ vs mới trên **≥3 CA thật**, nêu diff % |
| Credit = 0 | `grep -rn "currentBalance" server/src` → chỉ còn nhánh fallback non-sol |
| Số call RPC | Đếm thật: phải ≈ 22/lượt (11 ví × 2 program), không scale theo CA |

## MUST NOT DO

1. **KHÔNG đụng `walletActivity` / `dexTrades` / `trackedInflow`.**
   Lý do: `docs/2026-09-15-gmgn-parity-and-block-feed.md` §T7 — *"exact net là bất khả
   thi từ RPC. Worker emit **gross**"* (LP fee không có trong `getTransaction`). Đổi
   `wallet_trades` sang RPC ⇒ `Inflow 24h` **đổi định nghĩa** gross/net. Đó là quyết
   định semantics của user, không phải việc của task này. 11 credit/lượt cho trades là
   chấp nhận được, để nguyên.

2. **KHÔNG thêm RPC call vào read path.** `assembleSignals` là SELECT đồng bộ, chạy
   mỗi `/api/signals`. RPC chỉ được gọi trong poller, ghi DB như hiện tại.

3. **KHÔNG xoá đường Nansen credit** — chỉ hạ nó thành fallback non-sol. Xoá hẳn thì
   mất khả năng so sánh khi cần debug.

4. **KHÔNG gate theo `entry_usd`/`minUsd`** trong sweep mới. Không cần, và sẽ gây lệch
   gate với `assembleSignals:163` (2 cột lệch âm thầm so với tập row đang render).

5. **KHÔNG dùng `getMultipleAccounts`/ATA per-CA** (xem MUST DO #3).

6. **KHÔNG thêm dependency mới.** Không `@solana/web3.js`, không `ethers`, không axios.

7. **KHÔNG log API key hay toàn bộ response RPC.** Log method + ví rút gọn + mint rút gọn.

8. **KHÔNG đổi định nghĩa 2 cột.** `Tracked by` = (đang giữ) OR (buy ≤ 7 ngày,
   `TRACKED_BY_WINDOW_MS`) — nhánh 1 đổi *nguồn*, không đổi *nghĩa*. `Holding %` giữ
   công thức `balance/mc`, chỉ đổi cách tính ra `balance` (giờ là `Σamount/supply`).

9. **KHÔNG refactor ngoài scope.** Không dọn `poller.ts`, không đổi cadence, không
   parallel hoá `pacedFor`, không sửa `walletSweep`'s `dexTrades` ordering.
   Bug fix = diff nhỏ nhất.

10. **KHÔNG commit.** Chỉ sửa + verify + report diff.

## Definition of done

- `walletTokenBalances` không còn gọi `api.currentBalance` cho chain `sol`.
- Số credit/lượt sweep ví giảm từ ~5.500 xuống ~11 (chỉ còn `dexTrades`) — đo bằng log
  `x-nansen-credits-remaining` (`nansen.ts:358`, bật `debug`) hoặc đếm call.
- 22 RPC call/lượt, **không** tăng khi thêm CA.
- `Tracked by` + `Holding %` render đúng trong `MODE=mock` và với dữ liệu thật.
- `server && npm test` 0 failures.
- Report: file đã sửa, diff, bảng evidence, và bất kỳ chỗ nào bạn phải tự quyết mà
  prompt không nói — nêu rõ, đừng giấu.

## Điểm cần escalate ngay (đừng tự quyết)

1. Nếu probe Token-2022 cho thấy **không** mint nào của tracked CA nằm ở Token-2022 →
   báo lại, có thể chỉ cần 1 programId (giảm còn 11 call/lượt).
2. Nếu `trackedHolding` cũ vs mới **lệch > 1%** trên CA thật → **dừng, báo cáo**. Nguyên
   nhân khả dĩ: `market_cap` của Nansen không bằng `price × supply` (FDV vs circulating
   supply). Khi đó phải chọn giữa `Σamount/supply` và `Σamount×price/mc` — cần user chốt,
   không tự đổi.
3. Nếu `getTokenAccountsByOwner` bị public RPC trả `429` hoặc truncate response trên ví
   nhiều token → báo số đo thật (số account, số lần 429) trước khi thêm retry phức tạp.
