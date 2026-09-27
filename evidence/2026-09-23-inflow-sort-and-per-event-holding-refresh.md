# Dash sort theo inflow mới nhất + refresh holding mỗi event watch

Date: 2026-09-23
Request (user, verbatim): "giờ sắp xếp lên trên dash là theo thứ tự có tracked inflow CA nào có
inflow thì lên đầu tiên trong danh sách" + "sửa tracked holding: khi mà wallet mua một CA mới
vượt ngưỡng => thêm CA vào trong tracking, thêm vào tracked inflow, thêm vào tracked holding
(cái này query balanceOf), sau khi đó mỗi khi ví đó của CA đó mà có event mua/bán/transfer từ
wallet watch thì call lại balance of của ví đó và CA đó để update lại số tracked inflow và holding"

Chốt với user trong phiên:
- Sort theo **thời điểm inflow mới nhất**, KHÔNG theo lượng inflow.
- Phạm vi: "làm đủ" cả sell/transfer, NHƯNG "điều kiện để add CA thì chỉ cần BUY như hiện tại".
- Inflow giữ nguyên định nghĩa "Σ buy 24h" — sell chỉ refresh holding.
- Ngưỡng add CA = `minUsd` sẵn có (settings, default $50).

## Thay đổi

1. `server/src/db.ts` — thêm `latestWatchBuyTsByCa(sinceTs): Map<ca, ts>`:
   `SELECT ca, MAX(ts) FROM wallet_trades WHERE side='buy' AND source='watch' AND ts >= ? GROUP BY ca`.
   Khoá thời gian của inflow (đúng nguồn `sumTrackedBuyUsd`).
2. `server/src/signals.ts` — `TokenSignal.trackedInflowAt: number` (0 = chưa có inflow);
   `assembleSignals` đọc map 24h một lần/vòng và trả `out.sort((a,b) => b.trackedInflowAt - a.trackedInflowAt)`.
   `trackedInflow` (số tiền) KHÔNG đổi.
3. `src/types.ts` + `src/components/SignalTable.tsx` — thêm field vào DTO; default sort (chưa bấm cột)
   đổi từ `b.trackedInflow - a.trackedInflow` sang `b.trackedInflowAt - a.trackedInflowAt`.
   Bấm cột "Tracked Inflow" vẫn sort theo số tiền (hành vi cũ giữ nguyên).
4. `src/services/dataStore.ts` — mock seed: `SEED_RAW: Omit<TokenSignal,'trackedInflowAt'>[]` +
   `.map((s,i) => ({...s, trackedInflowAt: SEED_TS - i*600_000}))` để thứ tự seed không đổi dưới sort mới.
5. `server/src/api.ts` — `parseWatchTradeBody` nhận `side` (`'buy'|'sell'|'transfer'`, default `'buy'`
   ⇒ daemon BUY-only hiện tại không phải sửa gì); handler `/api/wallet-watch/trades`: `transfer` KHÔNG ghi
   `wallet_trades` (không có giá trị trong CHECK `side IN ('buy','sell')`), `buy`/`sell` ghi bình thường,
   và **mọi** event gọi `kickWalletRow(wallet)` để đọc lại balance ngay (thay vì chờ `walletSweep` ≤15').

## Verify (local)

- `cd server && npm test` → `tests 186 / pass 186 / fail 0` (trước thay đổi: 183 → +3 test mới).
  - mới: `side=sell lands as a trade row, side=transfer never does`, `400 on an unknown side`,
    `assembleSignals: rows order by NEWEST tracked inflow first — the amount is ignored`.
- `cd server && npm run build` (tsc) → exit 0.
- `npm run build` (FE: tsc + vite) → exit 0, `dist/assets/index-ymhMyQxE.js 215.61 kB`.
  - Lần chạy đầu FAIL `TS2741: Property 'trackedInflowAt' is missing` ×8 (mock seed) → đã sửa bằng (4).
- `lsp_diagnostics` `signals.ts` / `db.ts` / `api.ts` → No diagnostics.

## Deploy + verify prod (194.163.187.250) — 2026-09-23 08:29-08:34 UTC

`make restart` → `docker compose build` pass, `signal_scan-api-1` + `signal_scan-web-1` recreated,
`HTTP 200 — web localhost:8124`, `/api/health` → `healthy:true`, doors healthy/probation.

1. **Sort** — `GET /api/signals` (qua internet, không phải localhost):
   `n = 51`, `co field trackedInflowAt: True`, `sort desc dung: True`, `so row co inflow: 51/51`.
   top5 = `DEW9dSN6Qp $8251 08:20` → `JCvGrCbiHc $2035 08:09` → `69LjZUUzxj $418 07:54` →
   `GkBZGFgNy9 $1754 07:47` → `fvHLJUwsyn $3688 07:21`.
   ⇒ thứ tự theo **thời điểm**, không theo lượng ($418/$3688 vẫn nằm dưới $8251 nhưng trên $1754 không xảy ra —
   $1754 (07:47) nằm DƯỚI $418 (07:54) vì 07:54 mới hơn) — đúng yêu cầu.
2. **side validation mới** (probe không ghi DB, ví không tracked):
   `side=mint` → `HTTP 400 {"error":"side must be 'buy', 'sell' or 'transfer'"}`;
   `side=sell|transfer|buy` → `HTTP 404 {"error":"wallet not tracked"}` (parse qua, chỉ ví sai).
3. **Daemon patch** `/opt/wallet-watch/wallet_watch.py`:
   backup `wallet_watch.py.bak.preSellPost.20260923T083037`; 4/4 pattern thay thế (assert count==1 từng pattern
   trước khi ghi — sai là không ghi gì); `/opt/wallet-watch/venv/bin/python -m py_compile` OK.
   Nội dung: guard `side not in ("BUY","SELL")`; body thêm `"side": "sell"|"buy"`;
   `hops` filter → `(side==BUY and qty_net>0) or side==SELL` (SELL có `qty_net` ÂM nên phải nới riêng,
   chỉ đổi `side` là không đủ); docstring cập nhật. `track_post_body` GIỮ NGUYÊN BUY-only ⇒ auto-track CA
   vẫn BUY-only đúng yêu cầu user.
   `systemctl restart wallet-watch` → `is-active: active`, MainPID 530573, uptime 181s, không traceback.
4. **SELL đã POST** (trước patch: chưa từng có row sell nào):
   `wallet_trades source='watch' side='sell'` = **2 row**, ts `1790152404000` (08:33:24) — 2 row sell đầu tiên
   trong toàn bộ lịch sử; cùng cửa sổ có 1 buy (08:33:32). Wallet bán = `Cny7Brip3B` (CA `9CPfv7rc6v`, `1NJMqVM4Pa`).
   Không row nào bị ghi nhầm thành `buy` (đúng thứ tự deploy server-trước).
5. **Refresh holding mỗi event** — api log cùng cửa sổ: `[poller] kickWallet Cny7Brip: 3 positions` /
   `4 positions` ⇒ đúng ví đã bán được đọc lại balance ngay (không chờ `walletSweep` 15').
6. **Fix kick linked-only cũng live**: `[poller] kickWalletHoldings sol: 0 linked wallet(s) for 1 CA(s)`
   (trước đây là 198 ví/CA).

## Quyết định user trong phiên (đã chốt, không còn treo)

- Deploy ngay ✔ (đã deploy).
- Sửa daemon cho SELL post ✔ (đã sửa + verify).
- **Transfer: bỏ qua** (user chọn) — server vẫn tolerate `side='transfer'` (chỉ refresh holding, không ghi row);
  daemon KHÔNG có detector transfer nào, muốn có phải viết đường detect mới (loại swap leg/fee leg) — để sau.

