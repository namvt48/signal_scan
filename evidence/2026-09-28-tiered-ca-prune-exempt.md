# 2026-09-28 — CA đã rate tier không bị auto-xóa

Yêu cầu: "khi mà các CA đã rate tier rồi thì không xóa sau 48h khi không có inflow như
các CA khác".

## Phát hiện: không phải 1 đường xóa mà là 3

Yêu cầu nêu đường 48h, nhưng nếu chỉ vá đường đó thì CA đã rate vẫn chết qua 2 đường khác
— đúng lỗi người dùng sẽ báo lại. Cả 3 đường cùng chọn candidate bằng SQL trên alias `t`:

| Đường | Vị trí | Điều kiện xóa | Gọi từ |
|---|---|---|---|
| `pruneUntrackedCas` | `db.ts:661` | 48h không inflow (`CA_INFLOW_WINDOW_MS`) và không ai holds | `poller.ts:693` |
| `pruneTrackedByNone` | `db.ts:697` | 7d (`TRACKED_BY_WINDOW_MS`) không wallet nào track | `poller.ts:704` |
| `zeroScoreGate` | `poller.ts:648` | data đầy đủ mà Nansen score 0/3 | `poller.ts:700` |

Quyết định: vá **cả 3** (người dùng nói "đã rate tier thì không xóa"; chỉ vá 1 đường là
fix triệu chứng, không phải nguyên nhân). Cùng một mệnh đề, định nghĩa một lần để 3 đường
không lệch nhau:

```ts
// server/src/db.ts
const NOT_TIERED = `NOT EXISTS (SELECT 1 FROM token_tiers tt WHERE tt.ca = t.address AND tt.chain = t.chain)`;
```

Áp vào cả 3 candidate query. `token_tiers` keyed (ca, chain) canonical ⇒ khớp
`tracked_cas.address` bằng string equality, giống predicate của `sweepOrphanedCaData`.

## Test (TDD: RED → GREEN)

3 file test, mỗi file thêm 1 CA "y hệt CA bị xóa nhưng có tier":

- `test/prune-untracked-cas.test.ts` — `TIERED` (stale, no holding, no buy, có tier)
- `test/prune-tracked-by-none.test.ts` — `TIERED` (no tracker, stale, có tier)
- `test/zero-score-gate.test.ts` — `TIERED_DEAD` (0/3 đầy đủ, có tier)

RED (trước khi sửa) — cả 3 fail đúng chỗ:

```
✖ pruneUntrackedCas ...   actual: [caPrune-dead, caPrune-flipped, caPrune-tiered, ...]
✖ pruneTrackedByNone ...  actual: [caTbn-held-old, caTbn-no-trade, caTbn-tiered]
✖ zeroScoreGate: keeps a complete 0/3 CA the user rated a tier ... false !== true
```

GREEN (sau khi sửa):

```
✔ 8/8 test trong 3 file
ℹ tests 351   ℹ pass 351   ℹ fail 0        (baseline 350, +1 test mới)
npx tsc --noEmit → 0 error
```

Log khi chạy gate cũng xác nhận: `zero-score gate: deleted 1/1 CAs` — chỉ xóa
`caGate-dead`, không đụng `caGate-tiered-dead`.

## Deploy + verify trên instance A

`make deploy` (cả 2 image Built) → `make up`:

```
signal_scan-api-1   Up 7 seconds                     (code mới)
signal_scan-web-1   Up 24 minutes  127.0.0.1:8124->80/tcp
HTTP 200 — web localhost:8124
/api/health  {"mode":"gmgn",...,"healthy":true}
grep -c NOT_TIERED server/src/db.ts → 4   (1 định nghĩa + 3 chỗ dùng)
```

Ingest còn sống: `wallet_trades 35152 → 35176`, `newest_trade_age=14s`.

### Đính chính về "bằng chứng prod"

Tôi đã định claim "8 CA đã rate còn tracked ⇒ fix hoạt động". **Sai.** Kiểm lại bằng cách
so candidate query có/không guard trên chính dữ liệu prod (cutoff `2026-09-26T09:43:42Z`):

```
se bi XOA neu KHONG co guard : 1
se bi XOA voi guard hien tai : 1     <-- giam 0
CA da rate tier duoc cuu     : 0
```

⇒ Hiện tại **chưa có** CA đã-rate nào nằm trong candidate set: cả 8 CA đã rate đang có
inflow/holding nên được giữ bằng clause cũ, không phải bằng guard mới. Guard chưa phải
cứu ai. Bằng chứng cấu trúc là **test RED→GREEN** ở trên, không phải dữ liệu prod hiện thời;
runtime proof sẽ đến khi một CA đã rate nằm 48h không inflow.

Hành vi của CA **chưa** rate không đổi: CA không tier vẫn bị xóa như cũ (1 CA trong
candidate set hiện tại, không tier → vẫn xóa).

## File thay đổi

- `server/src/db.ts` — const `NOT_TIERED` + 3 SQL + 3 doc comment
- `server/test/prune-untracked-cas.test.ts`, `test/prune-tracked-by-none.test.ts`,
  `test/zero-score-gate.test.ts`

Lưu ý: ngoài phạm vi yêu cầu — người dùng gọi tên đường 48h; tôi mở rộng sang
`pruneTrackedByNone` + `zeroScoreGate`. Nếu chỉ muốn đúng đường 48h, nói để tôi bỏ 2 clause kia.

EVIDENCE_RECORDED: evidence/2026-09-28-tiered-ca-prune-exempt.md
