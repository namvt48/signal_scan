# Evidence — UI round 4 (wallet columns, tracked-by theme, settings number format)

Date: 2026-09-21 · Prod: `http://194.163.187.250:8124/` · Bundle: `dist/assets/index-C5Xl7_Oa.js`, `index-CFgxmbi_.css`

## 1. Scope (3 user requests)

| # | Request (verbatim intent) | Change |
|---|---|---|
| 1 | Tab Wallet: giảm chiều dài cột Address vừa đủ address, kéo dài cột Name ra | `WalletsPage.tsx`: bỏ `table-fixed` ở cả 2 bảng (skeleton + thật), Address `w-[380px]`→`w-[1%]` + `break-all`→`whitespace-nowrap`, Name `w-24`→`w-full`, Tags `w-40`→`min-w-[220px]` |
| 2 | Tracked by: đổi theme theo ảnh gửi kèm | `SignalTable.tsx`: chip `rounded-md border-lime-soft bg-lime-soft text-accent font-semibold` → `rounded-full border-[#B9B4AA] bg-[#DCD8CF] text-[#333] font-bold`; `+N` từ nút dashed-border → text trơn `#8a8a8a` |
| 3 | Signal thresholds: Low float min/max + min market cap thêm dấu `,` ngăn nghìn | `SettingsPanel.tsx`: `grouped` flag trên 3 field, `type=text` + `inputMode=numeric`, helper `group()`/`regroup()`, `parse()` strip `,` |
| 4 | (chốt qua question) Tracked by: wrap **ngang** y như ảnh | `SignalTable.tsx`: container `flex-col items-start` → `flex-wrap items-center`, gap 6px |
| 5 | (chốt qua question) Xóa **luôn** dark mode | Xóa 4 chỗ: boot script `index.html`; palette dark + block `html.light` trong `index.css` (gộp về `:root` light); state `light` + `toggleTheme` + nút toggle trong `App.tsx`; `THEME_KEY` trong `config.ts` |

## 2. Typecheck / build

```
npx tsc --noEmit   → exit 0 (no output)
npm run build      → ✓ built in 4.50s
                     dist/assets/index-C5Xl7_Oa.js   218.15 kB │ gzip: 66.62 kB
                     dist/assets/index-CFgxmbi_.css   35.10 kB │ gzip:  7.51 kB
```

## 3. Layout math (why the wallet table was wrong)

Both tables were `table-fixed w-full` → columns split the container **proportionally**, so width specs are ratios, not px.

- Signal table: 352 spec units, container 1951px → 5.48 px/unit.
- Wallet table: 884 spec units, container 1951px → **2.21 px/unit** → Address (380 spec) rendered **~830px** while its content needs only ~376px.

Font measurement (IBM Plex Mono, `text-xs` = 12px): 44-char base58 = **316px** → cell needs `316 + gap 6 + icon 13 + px-5 padding 40 = 376px`.

Fix: drop `table-fixed` → `table-auto`; Address `w-[1%]` + `whitespace-nowrap` (shrinks to content at ANY viewport), Name `w-full` (absorbs the slack), Tags `min-w-[220px]` (keeps tags on one line).

## 4. Local verification (vite preview :4319, Playwright)

```
container 1945 · tableLayout=auto
th: STT 66 · Address 376 · Name 1000 · Tags 220 · Chain 82 · Source 100 · Actions 101
rows: rowH 55/55/55/64 · addrW 376 · addrOverflow 0 (all) · nameW 1000

settings inputs: lfMin type=text "1,000,000" · lfMax type=text "300,000,000" · minMc type=text "5,000,000"
                 freshMinPct type=number "10" · t100MinMultiple type=number "1.2" · minUsd type=number "50"
typing test:     typed "1234567" → became "1,234,567"   (regroup realtime OK)
chip style:      bg rgb(220,216,207) border rgb(185,180,170) color rgb(51,51,51) weight 700 radius pill 11px
```
Note: local seed has ≤8 wallets/token → no `+N` locally (`moreStyle: null`).

Regression caught + fixed locally: with `table-auto` the Tags column collapsed to 105px (its min-content), wrapping every tag to 2 lines and inflating rows to **125px**. Adding `min-w-[220px]` restored rows to 55–69px.

## 5. Prod verification (after `make deploy` + `make up`)

```
web recreated; /api/health → {"mode":"nansen","provider":"nansen","healthy":true}

settings:        lfMin "30,000,000" · lfMax "100,000,000" · minMc "0"
                 freshMinPct "15" · t100MinMultiple "1.2" · minUsd "50"  (unchanged, type=number)
chip (real row): "Frank Degod" bg rgb(220,216,207) border rgb(185,180,170) color rgb(51,51,51)
                 weight 700 · radius pill · 11px
+N buttons:      42 rows · sample "+5" → color rgb(138,138,138) · bg rgba(0,0,0,0) · borderWidth 0px
dashboard rows:  289
wallet cols:     STT 66 · Address 376 · Name 994 · Tags 220 · Chain 82 · Source 91 · Actions 101
wallet rows:     rowH 55 · addrW 376 · content 328–335 · overflow 0 · addrLen 43–44 · nameW 994
```

## 6. Artifacts

- `evidence/2026-09-21-prod-wallet-cols.png` — prod Wallets tab: Address hugging its 43–44 char address on one line, Name absorbing the width.
- `evidence/2026-09-21-prod-trackedby-theme.png` — prod Dashboard **before** round 5: beige pill chips one per line.
- `evidence/2026-09-21-prod-trackedby-wrap-nodarkmode.png` — prod Dashboard **after** round 5: chips wrapping 2 per line, `+5` / `+35` inline on the last chip's line, header has only the gear icon (no theme toggle).
- Reference image the user sent: crop 229×653, recovered from `opencode.db` (`part.type=file`, `filename=clipboard`) → analysed for chip colours/geometry.

## 7. Round 5 — the two open questions, answered by the user

**Q1 → "Wrap ngang y như ảnh"**: container `flex-col items-start` → `flex-wrap items-center`, gap 6px. Chips now flow horizontally and `+N` sits on the same line as the last chip, matching the reference image.

**Q2 → "1 và xóa luôn dark mode đi"**: dark mode removed entirely (not merely left in place).

This deliberately supersedes the earlier "mỗi người một dòng" instruction, per the user's answer.

```
npx tsc --noEmit  → exit 0
npm run build     → ✓ built in 4.63s
                    index-B0y54Urd.js   210.98 kB │ gzip: 64.99 kB   (was 218.15 kB — toggle + dark palette gone)
                    index-cqD0T833.css   34.85 kB │ gzip:  7.42 kB   (was 35.10 kB)
```

Local (:4319): `html.className=""` · body `rgb(244,242,236)` · theme-toggle buttons **0** · gear button **1** · container `flex-wrap: wrap`, `row`, gap 6px, 3 chips on one line.

Prod (after `make deploy` + `make up`; web recreated; `/api/health` `healthy:true`):

```
theme-toggle buttons: 0        html class: ""        body bg: rgb(244,242,236)
trackedBy cells: 206 · cells wrapping to >1 line: 105
  sample "Frank Degod" | "dylansdegens"   → 1 line, 2 chips
  sample 9 chips                          → 7 lines [2,2,1,1,1,1,1]
  sample 9 chips                          → 5 lines [2,2,2,2,1]
chip:  bg rgb(220,216,207) · border rgb(185,180,170) · color rgb(51,51,51) · weight 700 · pill
+N:    42 rows · color rgb(138,138,138) · bg transparent · border 0px
       inline check: ["W1 (Big whale WW) ", "+5"] → shares a line with a chip
```

## 8. Known gaps / not done

- **Still open (out of scope)**: `server/src/ingest.ts:46` `upsertTokenInfo` writes `market_cap = excluded.market_cap` without `COALESCE` — can overwrite a good value with `0`.
- Stale `signal_scan:theme` keys remain in users' localStorage from the removed toggle; nothing reads them now (harmless).

## 9. Round 6 — chip viền trong modal `+N` (deployed, verified prod)

Yêu cầu: *"cái bảng tracked by khi bấm vào chi tiết thì tôi muốn nó cũng có viền như bên ngoài dashboard"*.

`SignalTable.tsx`:
- Tách class chip thành hằng số dùng chung `TRACKED_CHIP` (1 định nghĩa, 2 chỗ dùng) → modal và bảng không thể lệch nhau.
- Modal `walletsPopup`: `<ul>` list text trơn (kẻ dòng `border-b`) → `<div className="flex max-h-72 flex-wrap content-start gap-1.5 overflow-auto">` chứa `<span title={w} className={TRACKED_CHIP}>`.

```
npx tsc --noEmit  → exit 0
npm run build     → ✓ built in 4.45s   index-BzsREQL9.js  211.18 kB │ gzip: 65.02 kB
                    (grep bundle: TRACKED_CHIP xuất hiện đúng 1 lần — hằng số dùng chung)
```

Prod (`index-DI9_xUW2.js`, web recreated, `/api/health` healthy). Bấm `+5` → modal "Tracked by — 13 wallets":

```
matchesTableChip: true          ← so từng property với chip trong <td>, giống hệt
modal chips: 13 SPAN
  bg rgb(220,216,207) · border rgb(185,180,170) 1.05px · color rgb(51,51,51)
  weight 700 · radius pill · font-size 11px
container: DIV.flex.max-h-72.flex-wrap.content-start.gap-1.5.overflow-auto
  display flex · flexWrap wrap · gap 6px · maxHeight 288px · overflowY auto
old <ul> list: gone
```

Ảnh: `evidence/2026-09-21-prod-modal-trackedby-chips.png` — modal chips viền beige y hệt chip trong cột Tracked by bên dưới.

**Ngoài scope (không do tôi làm)**: cột `1H Volume` xuất hiện trong prod bundle + `server/src` từ một session/agent khác (build `index-_b-2bgZV.js` lúc 15:51). Prod bundle cũng xác nhận các thay đổi round 4–5 đã lên (`Switch to dark mode`: 0 · `#0a0c10`: 0 · `#f4f2ec`: 1 · `html.light`: 0).

## 10. Round 7 — căn giữa header + sort 5 cột + MC min/max band (deployed, verified prod)

Yêu cầu: *"Entry căn giữa cho tôi, Tracked Holding đang bị lệch, và thêm cho tôi Holder Tracked Inflow Tracked Holding 1H Volume 24H Volume mỗi cột sẽ có sort tăng dần, giảm dần khi bấm vào cột để chuyển mode, sẽ có icon để thể hiện mặc định thì vẫn như hiện tại thôi nhưng mà khi bấm vào sẽ enable, và tắt tab đi sẽ hiện về bình thường … tiếp theo thêm feature, min max filter cho MC cho tôi giống LF, sửa trong cả bảng Signal thresholds"*.

### 10.1 Nguyên nhân lệch (không phải lỗi `text-center`)

`Th` base có `px-5` + `whitespace-nowrap`. `Tracked Holding` rộng ~116px nhưng content box của `w-28` chỉ 143.7 − 40 = 103.7px → label **tràn ra ngoài** content box → `text-center` căn giữa một hộp đã tràn nên mắt thấy lệch phải. Đo **trước** khi sửa: **Tracked Holding +6.1px, Entry +3.7px** (chỉ 2 cột này lệch thật; `Ticker −19.6 / CA −61.5 / Tracked by −94.4` là cột left-align, đúng thiết kế).

Fix: `C_HEAD = `${HL_HEAD} px-3! whitespace-normal!`` → `px-3` cho label 119.7px chỗ → vừa 1 dòng; `whitespace-normal` để khi hẹp hơn (`min-w-[1500px]`) thì **wrap** thay vì tràn. `Entry` cũng `px-3! whitespace-normal!`.

Đo **sau** khi sửa trên prod — đo **hộp text** bằng `Range`, không đo hộp `<button>` (hộp button luôn đối xứng nên không phát hiện được lỗi):

```
MC            headDelta   0   thW 123   lines 1
Holder                    0        123        1
Tracked Inflow            0        144        1
Tracked Holding           0        144        1   ← trước là +6.1
1H Volume                 0        144        1
24H Volume                0        144        1
Tier                      0         72        1
Entry                     0         72        1   ← trước là +3.7
Ticker −20 · CA −62 · Tracked by −94 · Nansen setup −115   (left-align, giữ nguyên)
```

### 10.2 Sort 5 cột + caret

`SortKey = 'holders'|'trackedInflow'|'trackedHolding'|'volume1h'|'volume24h'`, `SortState = { key, dir } | null`. `null` = mặc định như cũ (`b.trackedInflow - a.trackedInflow`) → **mặc định không đổi**, cả 5 caret xám. Click lần 1 = **descending**, lần 2 = **ascending** (không có trạng thái thứ 3). Metric `undefined` (phần lớn row không có `volume1h`) **chìm xuống cuối ở cả 2 chiều**. Caret: `SortCaret` = 2 tam giác đặc `9×14`, `#9AA0A6` idle / `#151515` active, `absolute -right-2 top-1/2 -translate-y-1/2`.

Đo trên prod (click thật qua DOM, đọc lại DOM):

```
default      label "sorted by tracked inflow"           carets [grey,grey] ×5
Holder #1    "sorted by holder count, descending"       [grey,#151515]  81,994 → 47,948 → 42,203 → 26,748 → 22,547 → 18,577
Holder #2    "... ascending"                            [#151515,grey]  39 → 77 → 86 → 110 → 120 → 142
1H Volume #1 "... descending"                           $42.881K, $8.117K, $608.937, $338.562, —, —, —, —
1H Volume #2 "... ascending"                            $338.562, $608.937, $8.117K, $42.881K, —, —, —, —   ← sink cả 2 chiều
Tracked Holding #1  "sorted by tracked holding, descending"  11.945% → 9.493% → 6.699% → 5.577% → 5.303% → 5.231%
```

Reset khi đổi tab (yêu cầu *"tắt tab đi sẽ hiện về bình thường"*): arm `Holder desc` → click `Wallets` → label = `null` (SignalTable unmount, sort là `useState` cục bộ) → click `Dashboard` → label = **`sorted by tracked inflow`**.

### 10.3 MC min/max band (giống LF)

- `server/src/config.ts`: `MAX_MC = num('MAX_MC', 0)`.
- `server/src/settings.ts`: `maxMc` vào interface + `THRESHOLD_KEYS` + `thresholdDefaults`; band pair check.
- `server/src/signals.ts`: gate `st.market_cap != null && (st.market_cap < th.minMc || (th.maxMc > 0 && st.market_cap > th.maxMc))` — nhánh `th.maxMc > 0 &&` là **bắt buộc**, thiếu nó thì `maxMc = 0` sẽ chặn mọi token. Fail-open khi chưa đo được `market_cap`.
- FE: `FIELDS` thêm `maxMc`; `BANDS` gộp 2 band (`Low float band`, `Market cap band (USD)`); header MC hiện `≥ X` / `≤ Y` / `X–Y`.

**Bug do test bắt được (đã sửa):** check band ban đầu là `minMc > maxMc` → vì `0 = OFF` (không phải "bằng 0"), `minMc = 250M` với `maxMc = 0` bị chặn oan (2 test `minMc` cũ fail). Sửa ở **cả server và FE**: chỉ coi là band đảo khi **cả hai** biên đều `> 0`.

Panel prod (`Signal thresholds`), 2 band render 2 cột — chứng minh bằng toạ độ (cùng `y`, khác `x`):

```
Low float band   y 485   x 810 (30,000,000)   x 1006 (100,000,000)
Market cap band  y 676   x 810 (15,000)       x 1006 (0)        ← 2 input mới, maxMc = "0"
field đơn (Fresh 15 / T100 1.2 / Min USD 50): x 797  w 406
```

`/api/settings` trên prod trả `values.maxMc = 0`, `defaults.maxMc = 0`. Modal đóng bằng **Cancel** (không Save) → settings đang chạy của prod **không bị đổi**.

### 10.4 Verify

```
FE tsc        exit 0          server tsc    exit 0
FE build      ✓ 4.54s  index-XbhToTIF.js 213.20 kB │ gzip 65.78 kB
server test   120 / 120 pass, 0 fail  (thêm 3 test maxMc: 115 → 118; +2 test COALESCE của agent khác)
prod bundle   index-D4Y15VhB.js  (grep: #9AA0A6 ×2 · "Max market cap" · "Market cap band (USD)" · "Sort by" · "must be ≤ max market cap")
prod CSS      .px-3\!{padding-inline:…!important} · .whitespace-normal\!{white-space:normal!important} · .-right-2{right:…}
```

Ảnh: `evidence/2026-09-21-prod-sort-carets-centered-headers.png` (header căn giữa + caret trên 5 cột, `Tracked Holding↓` đen, label "sorted by tracked holding, descending") · `evidence/2026-09-21-prod-settings-mc-band.png` ("Market cap band (USD)" 2 cột Min 15,000 / Max 0).

**Ghi chú**: mặc định bảng vẫn sort theo `tracked inflow` desc nhưng caret để xám hết — đúng yêu cầu *"mặc định thì vẫn như hiện tại thôi, bấm vào sẽ enable"*. Muốn caret tự sáng đúng cột mặc định thì đổi `sort` khởi tạo thành `{ key: 'trackedInflow', dir: 'desc' }`.

## 11. Round 8 — nút "Reset view" cạnh nút settings (deployed, verified prod)

Yêu cầu: *"thêm một nút ở góc phải trên reset chart view cho tôi ở gần nút settings ấy"* → làm rõ: *"reset view giống f5 lại ý là muốn xóa mấy cái hiệu ứng sort không phải market replay, sửa lại market replay như ban đầu đi"*.

### 11.1 Lần đầu làm nhầm project (đã revert)

Tôi tưởng là `market-replay` (app chart có `resetChartView`/`chart-view-registry`), đã thêm nút vào `web/src/components/TopBar.tsx` + 3 test. Revert bằng `git checkout -- web/src/components/TopBar.tsx web/src/components/TopBar.test.tsx`; `git status --short` sau đó chỉ còn `m vendor/lightweight-charts-drawing` (submodule bẩn từ trước, không phải tôi), và test TopBar về đúng **13/13**. `signal_scan` không có chart view state để reset (chart balance chỉ là SVG tĩnh) → yêu cầu thuộc `signal_scan`.

### 11.2 Cách làm (chỉ `src/App.tsx`, không sửa SignalTable)

`SignalTable` giữ toàn bộ view state trong `useState` nội bộ (`signals`, `error`, `walletsPopup`, `allFactors`, `thresholds`, `sort`) nên remount bằng `key` chính là "F5 thu nhỏ":

```tsx
const [viewVersion, setViewVersion] = useState(0)
...
{tab === 'dashboard' && (
  <IconButton onClick={() => setViewVersion((v) => v + 1)} aria-label="Reset view" title="Reset view">
    <ArrowCounterClockwise size={16} />
  </IconButton>
)}
...
{tab === 'dashboard' && <SignalTable key={viewVersion} refreshKey={settingsVersion} />}
```

So với `location.reload()`: reload thật sẽ reset cả `tab` về Dashboard, còn cách này giữ nguyên tab + thresholds, chỉ trả bảng về mặc định. Nút **ẩn ở tab Wallets** (nút chỉ tác động bảng dashboard, để đó sẽ là nút chết).

### 11.3 Verify

```
tsc --noEmit  0 error        build ✓ index-CpPdBkG6.js 215.37 kB │ gzip 66.33 kB
local (seed, 8 rows):  resetBox x 1917 / gearBox x 1949 (cùng y 14) · order "reset → gear"
  armed Holder desc  holders [18,300 → 12,400 → 9,500]
  bấm reset          holders [8,900 → 6,200 → 12,400] = y hệt trước khi sort · label về "sorted by tracked inflow" · 5 caret xám
  tab Wallets        resetExists false · gearExists true
prod (index-anYN1BNO.js, 122 rows):
  header buttons     [Dashboard, Wallets, Reset view, Threshold settings]
  resetBox x 1917 y 14 / gearBox x 1949 y 14   (sát nhau, cùng hàng, reset bên trái gear)
  before             $STAMP $ALLINU $CATE $ACAT · 8,261 / 7,315 / 81,994 / 4,203
  armed Holder desc  $CATE $STONK $CBBTC $MET · 81,994 → 47,756 → 42,203 → 26,748 · caret Holder [#9AA0A6,#151515]
  sau reset          $STAMP $ALLINU $CATE $ACAT · 8,261 / 7,315 / 81,994 / 4,203  (trùng khớp `before`) · 5 caret xám hết · 122 row
```

Lưu ý minh bạch: field `identicalToBefore` trong lần đo trả `false` là **lỗi phép so sánh của tôi** — tôi không đưa `carets` vào object `before` nên so `undefined` với chuỗi JSON sau đó. `tickers`, `holders` và `label` khớp chính xác; `carets` sau reset đều `#9AA0A6` (xám) nên cũng đúng.

`signal_scan` không có test runner (package.json không có script `test`), nên kiểm chứng khả chạy là các phép đo DOM ở trên chứ không phải unit test.

Ảnh: `evidence/2026-09-21-prod-reset-view-button.png` — cụm góc phải header, icon mũi tên ngược chiều kim đồng hồ (Reset view) nằm ngay trái bánh răng (Threshold settings).
