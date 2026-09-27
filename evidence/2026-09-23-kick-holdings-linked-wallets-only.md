# kickWalletHoldingsFor: chỉ đọc ví đã link CA (bỏ quét toàn bộ ~198 ví)

Date: 2026-09-23
Request (user, verbatim): "cái này không quét toàn bộ như vậy chỉ quét các wallet có trong
CA tracked by wallet đó thôi, nếu có event buy thì nó tự vào trong tracked by rồi — sửa theo
cái này cho tôi"

## Vấn đề

`kickWalletHoldingsFor` (poller.ts) được gọi từ `kickCAs` mỗi khi thêm CA mới, và vòng lặp
của nó là `for (const w of listWallets())` — tức là mỗi CA mới đều refetch holdings của
TOÀN BỘ 198 ví (198 × 2 programId = 396 RPC call), dù chỉ một vài ví thực sự liên quan.
Số liệu prod trước thay đổi: 2 CA mới / 15 phút → ~792 call thừa, và 12 trong 17 lỗi
`kickWalletHoldings` (429) đến từ chính burst này.

## Sự thật từ code (nguồn scope đúng)

`signals.trackedByNames(ca, buySinceTs)` (signals.ts:94) — cột "Tracked by" có **đúng một
nguồn**: wallet_trades `side='buy' AND source='watch'`. "Một ví chỉ HOLD không còn đủ điều
kiện. NO BACKFILL". Nghĩa là link ví↔CA đã có sẵn trong DB ngay khi daemon báo buy; không
cần hỏi RPC để biết ví nào liên quan.

## Thay đổi

1. `server/src/db.ts` — thêm `walletsLinkedToCas(addresses: readonly string[]): WalletRow[]`
   trả về DISTINCT ví có trade `side='buy' AND source='watch'` trên các CA đó (guard mảng
   rỗng, ORDER BY name). Đúng định nghĩa link của `trackedByNames`.
2. `server/src/poller.ts` — `kickWalletHoldingsFor` đổi nguồn vòng lặp từ `listWallets()`
   sang `walletsLinkedToCas(addresses)` (addresses = CA của chain đang kick); giữ nguyên
   coalesce `holdingsKickInFlight` per chain + guard sol-only; thêm log quan sát được:
   `[poller] kickWalletHoldings sol: N linked wallet(s) for M CA(s)`.
3. `server/test/poller.test.ts` — test cũ giờ dựng link bằng `insertTrades(..., 'watch')`
   trước khi kick; thêm assert ví KHÔNG có link watch-buy không bị query.

## Bằng chứng

| Kiểm tra | Kết quả |
|---|---|
| `npm test` (server) | `tests 183`, `pass 183`, `fail 0`, TEST_EXIT=0 |
| `npm run build` (`tsc`) | BUILD_EXIT=0 |
| `lsp_diagnostics server/src/poller.ts` | No diagnostics found |
| `lsp_diagnostics server/src/db.ts` | No diagnostics found |
| `grep listWallets\|walletsLinkedToCas poller.ts` | `listWallets` chỉ còn ở `walletSweep` (:425); kick dùng `walletsLinkedToCas` (:565) |

Lỗi LSP `Type '"eth"' is not assignable to type '"sol"'` trong `poller.test.ts` là **có sẵn
từ trước** (đã xuất hiện tại dòng 121/125 ngay khi sửa dòng import, trước khi viết lại test);
`test/` không nằm trong `tsc` build nên không ảnh hưởng BUILD_EXIT.

## Hiệu quả

1 CA mới: 396 call → `N × 2` call, với N = số ví đã có watch-buy cho CA đó (thực tế 0-3 ví)
⇒ giảm ~99% ở đường kick.

## Tradeoff đã biết

CA mới chưa có watch-buy nào ⇒ kick không query ví nào. Đúng theo định nghĩa sản phẩm
(trackedBy rỗng thì không có gì để attach); holding vẫn tới qua `walletSweep` ≤ 15 phút.

## Chưa deploy

Thay đổi chỉ mới ở local (repo không phải git repo). Prod vẫn đang chạy bản cũ.
