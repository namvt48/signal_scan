# Show all factors (debug) hiện HẾT CA + door-pool chết làm nansen/vol/MC đứng

Date: 2026-09-23 (Asia/Ho_Chi_Minh)
Prod: root@194.163.187.250 /root/signal_scan, port 8124, MODE=nansen

## Yêu cầu (user, verbatim)

1. "tôi muốn khi bật Show all factors (debug) vẫn phải hiện hết cả các CA kia"
2. "nếu mà đủ data (không lỗi) nansen mà 0/3 thì xóa hẳn luôn không tracking luôn
   ấy chứ không phải chỉ ẩn như ember, stonk đâu"
3. "mãi không thấy data nansen và 24h vol, MC quá lâu"

## 1. allFactors (debug) bypass display gates — ĐÃ SHIP

Root cause: `assembleSignals` loại CA bằng `continue` ở gate `minUsd` và band
`[minMc, maxMc]` TRƯỚC khi `allFactors` được dùng (chỉ dùng ở phần emit factor).
Nên tick debug không giữ row lại được. Prod: `maxMc = 15_000_000` → EMBER
(16.99M) + STONK (271.57M) bị ẩn dù vẫn tracking.

Fix (`server/src/signals.ts`, `assembleSignals`): bọc 2 `continue` đó trong
`if (!allFactors) { ... }`. Chỉ ảnh hưởng hiển thị; tracking/sweep/gate xóa
không đổi.

Test (RED trước, 1 test mới trong `server/test/min-mc-gate.test.ts`):
- `allFactors debug lists EVERY tracked CA: the minUsd + MC display gates are skipped`
- RED: `AssertionError: debug on: a row above maxMc must still be listed` (fail 1/12)
- GREEN sau fix. Toàn bộ suite: **190 tests / 190 pass / 0 fail**; `npx tsc --noEmit` exit 0.

## 2. Zero-score gate (đủ data + 0/3 → xóa hẳn) — ĐÃ CÓ SẴN, không sửa

`poller.ts` `zeroScoreGate()`, chạy cuối mỗi `walletSweep` (prod 15'):
`complete && score === 0` → `deleteTrackedCasByIds` (xóa `tracked_cas` + token_state mồ côi).
`complete` = symbol/supply/price/nansen_fresh_pct/t100_multiple/genesis_bal đều non-null.

Tests có sẵn (`server/test/zero-score-gate.test.ts`):
- `deletes a complete 0/3 CA and its orphan token_state` → log `deleted 1/1 CAs`
- `keeps a 0/3 CA whose data is incomplete (symbol NULL)` → ca EMBER
- `keeps a complete CA with exactly one passing factor` → ca STONK

Nghĩa là EMBER/STONK đang được GIỮ có lý do, không phải "chỉ ẩn":
EMBER `complete=false` (thiếu fresh/t100/genesis → chờ sweep), STONK `score=1`.

Luồng xóa thứ 2: `pruneUntrackedCas(CA_INFLOW_WINDOW_MS = 48h)` — không inflow watch 48h → xóa.

## 3. "mãi không thấy nansen/vol/MC" — nguyên nhân: DOOR POOL CHẾT (không phải ít CA)

Log trước fix: `[door 0] retired reason=broken-proxy`, `[door 1] retired reason=broken-proxy`
(10:04:25Z) → **0 door** → mọi câu hỏi nansen 502:
`[poller] kickToken … Error: nansen question tgm-volume-details 502`,
`[poller] seriesAtRung … nansen chart 502`. Pool KHÔNG tự dựng lại door sau retire → nansen tắt hẳn.

Proxy thật:
- `http://…@194.163.187.250:31133` → curl `000` / rc=56 (port LISTEN nhưng proxy nửa sống)
- `http://…@167.86.101.228:31128` → curl `200` (sống) nhưng door vẫn bị retire sau 1 lần `re-warm-fail n=1`

Thời gian query nansen khi door khỏe: **<1s** (`kickNansen … cached + extremes updated`, delta 0.00s).
Các burst cách 5-10' là do CA mới về (daemon add), không phải query chậm.
Pacing theo thiết kế: `pacedFor` giãn `slotMs = intervalMs * SWEEP_PACE_FACTOR(0.8) / count` —
càng ít CA thì mỗi CA càng bị giãn xa (setupSweep 12h / 4 CA ≈ 2.4h/CA), nhưng KHÔNG phải nguyên nhân đứng dữ liệu.

Fix tạm: `make restart` (deploy + recreate api) → pool dựng lại, door 1 `healthy lastStatus=200`.

## 4. Verify trên prod sau restart (10:17Z, chờ 6')

`GET /api/signals` → **10 CA** (trước fix chỉ 1), gồm cả EMBER/STONK bị band chặn ⇒ fix (1) sống.

```
SRI       score=1 mc=0        vol=807845  hold=504   fresh=16.24 t100m=1    lf=201446250
BPCHAN    score=0 mc=0        vol=4085    hold=56    fresh=0.13  t100m=None lf=None
CHICK     score=1 mc=22111    vol=323493  hold=326   fresh=43.04 t100m=1    lf=259660040
JEANPHIL  score=0 mc=5336813  vol=0       hold=0     fresh=None  t100m=None lf=None
CLIP      score=2 mc=350319   vol=917785  hold=2347  fresh=20.94 t100m=1.257 lf=198822285
INUVIDIA  score=0 mc=None     vol=0       hold=0     fresh=None  t100m=None lf=None
STONK     score=1 mc=271.57M  vol=66.17M  hold=51374 fresh=12.81 t100m=2.835 lf=348859676
BABYNEET  score=0 mc=0        vol=1825    hold=15    fresh=0     t100m=None lf=None
LYNKS     score=2 mc=331541   vol=479472  hold=691   fresh=19.68 t100m=1.435 lf=363944688
EMBER     score=0 mc=16.99M   vol=0       hold=0     fresh=None  t100m=None lf=None
```

Log sau restart: `[door 1] promoted path=tgm-essential-data status=200`,
`[door 0] promoted path=tgm-volume-details status=200`, `kickNansen … cached + extremes updated` (không 502).

## Tồn đọng (chưa làm, cần user chốt)

- **Pool không respawn door đã retire** → 1 proxy hỏng là mất nguồn nansen tới khi restart tay. Đề xuất: re-check/đưa door retired quay lại sau TTL, hoặc respawn khi 0 healthy.
- CA có kick fail lúc door chết (EMBER vol/hold/setup, INUVIDIA, JEANPHIL vol/hold) không retry ngay: vol ở `volumeSweep` 1h, setup ở `setupSweep` 12h (hoặc on-demand khi mở chart). Đề xuất: retry kick 1 lần sau khi pool khỏe.
- Proxy `194.163.187.250:31133` vẫn nằm trong `/data/proxies-server.txt` (chập chờn) — cần nguồn proxy thay thế.
