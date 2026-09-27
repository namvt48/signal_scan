# 2026-09-16 — Purge NULL tracked_cas · interval thật · fix filter FE (score>=1)

Theo yêu cầu user: (1) xoá row NULL, (2) tự chọn interval, (3) allFactors ON mà FE vẫn
thiếu CA, (4) xoá row bsc.

## 1. Purge prod `tracked_cas` (destructive, đã xác nhận)

Backup **trước** khi xoá, dùng sqlite backup API (WAL-safe, khác `cp`):
`/root/signal_scan/data/signal_scan.db.bak.preNullPurge.20260916T123409`

```sql
DELETE FROM tracked_cas WHERE entry_usd IS NULL;   -- 462 row
DELETE FROM tracked_cas WHERE chain <> 'sol';      -- 1 row
COMMIT;
```

| | trước | sau |
|---|---|---|
| `tracked_cas` tổng | 574 | **112** |
| `entry_usd IS NULL` | 462 | **0** |
| `chain <> 'sol'` | 1 | **0** |
| distinct chains | sol,bsc | **['sol']** |

Row giữ lại mẫu: `6GmAFSYs…` 290.97 · `Cm6fNnMk…` 95.92 · `PerPsCe2S…` 345.13 (entry_usd thật).

Số 574→112 chứ không phải 111: scanner cũ vẫn đang chạy và POST thêm 1 row trong lúc
thực thi (xem §5 — cửa sổ đua).

**422 row `token_state` mồ côi** (của CA vừa xoá) **KHÔNG** xoá — ngoài yêu cầu, và vô hại:
cả 4 sweep lặp `listTrackedCas()` (`poller.ts:47,139,157,200`) nên orphan không bị poll.

## 2. Interval (user "tự thay") — prod `.env` + default code

Căn cứ: `pacedFor` (`poller.ts:34`) gap = `max(250, interval×SWEEP_PACE_FACTOR/len(items))`,
per-CA; token sweep = **4 request trình duyệt/CA** (`tokenSweep` → `provider.tokenInfo`) nên
bị chặn bởi độ trễ, không phải gap. 574 CA thì sweep 5 phút là bất khả thi → đúng lý do
prod chưa từng log `tokenSweep done`. Sau purge còn 112 CA.

| key | chọn | lý do |
|---|---|---|
| `POLL_TOKEN_MS` | **900000** (15m) | 112 CA × 4 req browser; gap ~6.4s/CA → ~12m, lịch sự với CF |
| `POLL_HOLDERS_MS` | **3600000** (60m) | sweep nặng nhất (snapshot holder JSON); 7d/30d window không cần dày hơn |
| `POLL_WALLETS_MS` | **900000** (15m) | fan-out credit wallet×CA; 30s (key chết cũ) = 660k credit/h |

Đồng bộ: `server/src/config.ts:33,35` (default) · `server/.env.example:19,21` · prod `/root/signal_scan/server/.env`.
Backup `.env` trước khi sửa: `.env.bak.20260916T120842` + `.env.bak2.<ts>`.
Prod env sau sửa: `POLL_TOKEN_MS=900000 · POLL_HOLDERS_MS=3600000 · POLL_WALLETS_MS=900000`;
dead keys (`MODE`/`GMGN_*`/`RATE_W*`) = **0**.

## 3. Fix #3 — root cause: filter ở FE, không phải server

Đo prod: `/api/signals` trả **570/570** row — server **không** drop CA nào
(`tracked but NOT in signals: 0`). `allFactors` chỉ mở *display gate từng factor*
(`signals.ts:199-209`), không mở *row gate*.

Thủ phạm: `src/components/SignalTable.tsx:176`
```ts
const visible = signals.filter((s) => s.nansen.score >= 1);  // ẩn 294/570 = 52%
```
Phân bố prod: `score 0 → 294 row`, `score >= 1 → 276 row`.

Sửa (3 hunk):
- `passing = signals.filter(score >= 1)` — giữ nguyên ý nghĩa cho strip thống kê;
- `visible = allFactors ? signals : passing` — debug ON ⇒ bảng hiện **mọi** CA;
- state `allFactors` đọc `dataStore.getSettings().debug.allFactors` **cùng nhịp 30s** với
  `listSignals()`; "Active signal"/"Watch signal" vẫn tính trên `passing.length`.

Tính nhất quán: `SettingsPanel.tsx:60` đã đọc đúng field `s.debug?.allFactors` từ **cùng**
`dataStore.getSettings()` mà user thấy checkbox đang ON ⇒ SignalTable đọc cùng nguồn ⇒ thấy ON.

## 4. Verify (chạy tươi, không tin agent)

```
root   npx tsc --noEmit   → EXIT 0
root   npm run build      → EXIT 0, built in 5.09s
server npx tsc --noEmit   → EXIT 0
server npm test           → EXIT 0 (skipped 0, todo 0)
```

## 5. CHƯA deploy — hệ quả cần biết

Prod vẫn chạy code cũ, nên:
- `.env` mới **chưa có hiệu lực** (cần restart api).
- `config.ts`/FE fix chưa live.
- **Scanner cũ vẫn tạo NULL mới** cho swap chưa biết giá → purge sẽ tái nhiễm. Bằng chứng
  sống: trong lúc thực thi, `tracked_cas` 570 → 574 (+4) vì scanner đang chạy.
  Cần scp `scripts/wallet_watch.py` + `systemctl restart wallet-watch` để chặn gốc.

## 6. DEPLOY (user "deploy đi") — 2026-09-16 17:48

### 6a. API + web (repo)
`make deploy` → EXIT 0, log `== deploy OK, docker compose build pass` (web `✓ built in 18.14s`
trong docker). rsync loại `.env`/`data` ⇒ prod `.env` + DB nguyên vẹn.
`make up` → EXIT 0.

Container sau deploy:
```
signal_scan-api-1     Up 3 minutes   3001/tcp
signal_scan-web-1     Up 3 minutes   0.0.0.0:8124->80/tcp
signal_scan-chrome-1  Up 2 hours     3000/tcp
HTTP 200 — web localhost:8124
{"mode":"nansen","provider":"nansen","lastTokenFetchAt":1789555601612,"healthy":true}
```
**env live trong container** (`docker compose exec -T api printenv`): `900000` / `3600000` / `900000`;
`MODE` in ra rỗng ⇒ dead key đã biến mất. ⇒ interval mới thực sự có hiệu lực.

### 6b. Scanner (`/opt/wallet-watch`)
Diff remote-vs-local trước khi ghi đè: **chỉ 1 hunk** — đúng `track_post_body` + docstring step-5.
Backup remote: `wallet_watch.py.bak.preUnpricedSkip.20260916T174844`.

| bước | kết quả |
|---|---|
| scp `scripts/wallet_watch.py` | md5 remote = **99e3dc8b6d2a51b8bcfca0dae3eb74db** = local |
| `systemctl restart wallet-watch` | `active`, `NRestarts=0` |
| `py_compile` (venv server) | OK |
| banner `watch.log` | `min_usd=$50 source=api` · `wallets=11` · `feed=block` · rpc+ws endpoint |

5 bộ test chạy trên **venv production của server** (sau khi scp bản `test_wallet_watch.py` mới;
4 file kia đã `same`):
```
test_wallet_watch.py     EXIT 0 — 11/11 + "OK: track_post_body unpriced (quote_usd=0/thiếu) → None; priced → body['usd'] đúng giá"
test_block_feed.py       EXIT 0 — 19/19
test_route_detect.py     EXIT 0 — 15/15
test_gmgn_api_parity.py  EXIT 0 — 29/29 + MUTATION GATE 4/4 RED→GREEN
test_rpc_resilience.py   EXIT 0 — 13/13
```

### 6c. Purge lần 2 (NULL do scanner cũ đẻ trong lúc chờ deploy)
`139 → 122` (xoá 17 NULL). Lúc này `min entry_usd` giữ lại = **50.21** (khớp ngưỡng $50 ⇒ gate và
purge nhất quán).

### 6d. Bằng chứng gốc NULL đã bị chặn (empirical)
Sau restart scanner ~5 phút: `tracked_cas` **122 → 134** (+12 row mới) mà `null` **vẫn = 0**
⇒ scanner mới **chỉ POST CA có giá**. Trước deploy, 17 NULL sinh trong ~5h cùng cơ chế.

Trạng thái cuối:
```
tracked_cas : 134 | entry_usd null: 0 | chain != sol: 0
orphan token_state: 418
containers: api Up 3m · web Up 3m · chrome Up 2h    scanner: active, NRestarts=0
external: HTTP 200 · /api/health {"healthy":true,"provider":"nansen"}
```

## 7. Purge orphan `token_state` (user "xóa luôn") — 2026-09-16 18:52

Backup trước khi xoá: `signal_scan.db.bak.preOrphanPurge.20260916T125254` (155.5 MB).

```sql
DELETE FROM token_state
 WHERE ca IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tracked_cas tc WHERE tc.address = token_state.ca);
-- 531 -> 126  (xoá 405)
```

Trạng thái sau: `tracked_cas = 149` · `entry_usd NULL = 0` (149 row mới vẫn 0 NULL ⇒ fix gốc giữ vững).

### Census orphan toàn DB — 3 bảng là DƯƠNG TÍNH GIẢ, đã cố ý KHÔNG xoá

| bảng | cột | "orphan" | thực tế |
|---|---|---|---|
| `wallets` | address | 11/11 | **giả** — cột là địa chỉ **ví**, không phải CA |
| `wallet_token_state` | ca | 14/14 | **giả** — token ví đã giao dịch, không phải CA tracked |
| `wallet_trades` | ca | 257/260 | **giả** — trade ở mọi token ví chạm, không chỉ CA tracked |
| `holder_snapshots` | ca | 8460/8776 | **thật** — nhưng tự prune (§7a) |
| `nansen_series` | ca | 636/864 | **thật** — cache biểu đồ của CA đã xoá |

### 7a. Vì sao không cần VACUUM / không cần xoá snapshot thủ công

- `freelist_count = 26` page ⇒ chỉ **0.1 MB** tái sử dụng được sau lần xoá trên ⇒ VACUUM vô nghĩa
  cho 405 row `token_state` (row rất nhỏ).
- DB 155.6 MB, trong đó `holder_snapshots` chiếm **143.0 MB** (92%), orphan = **137.4 MB**
  (`holders_json` tối đa 19,121 byte/snapshot).
- Nhưng `poller.ts:147` gọi `deleteSnapshotsBefore(now - SNAPSHOT_RETENTION_MS)` trong **mỗi**
  holders sweep — prune **theo tuổi, toàn cục**, không lọc theo tracked ⇒ snapshot mồ côi tự biến
  mất trong ≤ 3 ngày (`SNAPSHOT_RETENTION_MS = 72h`). Chúng chỉ tồn tại vì `tracked_cas` bị purge
  *hôm nay*.
- Ngoài ra tập tracked đã co 570 → 149 CA (93% giảm) ⇒ lượng snapshot steady-state giảm mạnh;
  file sẽ giữ mức high-water ~155 MB và **không phình thêm**.

Kết luận: không hành động gì thêm. Muốn lấy lại 137 MB **ngay** thì phải xoá + `VACUUM`
(VACUUM cần quyền ghi độc quyền ⇒ phải dừng `signal_scan-api-1` ~1 phút) — chờ user quyết.

## 8. Chưa làm (ngoài yêu cầu)

- `VACUUM` / xoá sớm `holder_snapshots` mồ côi — chờ quyết (§7a).
- 2 backup DB (~310 MB tổng) còn giữ để an toàn — xoá được sau khi prod ổn định vài ngày.
- 7 ký tự non-ASCII (CJK/`𝕏`/Hangul filler) — chờ quyết.
