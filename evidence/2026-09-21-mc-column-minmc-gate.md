# MC column + minMc gate — verification (2026-09-21)

## 1. Server unit tests (new gate + full suite)
$ cd server && npx tsx --test test/min-mc-gate.test.ts
  pass 4 / fail 0
$ npm test
  tests 115 / pass 115 / fail 0

## 2. Frontend typecheck + build
$ npx tsc --noEmit
  TSC_EXIT=0
$ npm run build
  BUILD_EXIT=0 (vite built in 4.95s)

## 3. DOM evidence (vite preview :4319 + Playwright, mock dataStore)
header[1] = "MC" (right of Ticker, left of CA)
rows: $8.900M | $2.450M | $1.180M | $4.300M | $15.600M | $640.000K | $27.800M | — (no marketCap)
settings modal field: "Min market cap" default 0
after save 5000000 -> localStorage signal_scan:settings {"minMc":5000000}
header hint then reads: "MC ≥ $5.000M"

## 4. LSP diagnostics
src/*, server/src/*: 0 errors (18 pre-existing @phosphor-icons deprecation hints in App.tsx/WalletsPage.tsx)

## 5. DEPLOY (prod) — 2026-09-21, root@194.163.187.250:/root/signal_scan, PORT=8124
$ make deploy
  #23 ✓ built in 10.17s ; naming to docker.io/library/signal_scan-web ; "== deploy OK, docker compose build pass"
$ make up
  signal_scan-api-1  Up  3001/tcp | signal_scan-web-1  Up  0.0.0.0:8124->80/tcp
  HTTP 200 — web localhost:8124 ; /api/health {"mode":"nansen","provider":"nansen","healthy":true}

GET http://194.163.187.250:8124/api/signals -> HTTP 200, 189511 bytes, list of 285 rows
  rows with marketCap field: 241 / 285 ; row0 has NO marketCap (null -> fail-open, renders "—")
  top5 MC: 3483.85M 2079.01M 1327.72M 797.88M 326.81M ; bottom5 MC: 0.003M 0.003M 0.002M 0.0M 0.0M
served FE bundle: assets/index-NCEHgoXK.js (213186 bytes) == hash from local build
  contains "Min market cap": 1 | "minMc": 2 | "MC": 1
DB prod /root/signal_scan/data NOT touched (rsync exclude data/.env/keys); MIN_MC default 0 = gate OFF after deploy

## 6. UI changes round 2 (2026-09-21) — tracked-by chips / CA click-copy / holder format / sort
Files: src/components/SignalTable.tsx, src/lib/format.ts

### Local (vite preview :4319, mock seeds)
tsc --noEmit -> TSC_EXIT=0 ; vite build -> ok
columns(px @viewport1995): Ticker132 MC132 CA132 TrackedBy395 Nansen395 Holder132 +28s +14s
CA cell 132px for a 90px address; span scrollW==clientW -> not clipped
chips: CT03/CT06/CT08, 42px each, 28px apart, border 1px solid rgb(234,246,221), radius 6px
click CA -> 120ms: title="Copied", text="copied", color rgb(27,129,69) ; 1400ms: back to address
holder: 8,900 / 6,200 / 12,400 (no .000)
sort: 156K 97K 84K 66K 41K 23K 12K 8K -> descending

### Prod (194.163.187.250:8124, real data, after make deploy+up)
GET / -> HTTP 200 ; /api/health {"mode":"nansen","healthy":true}
288 rows | chips max 8 | rows with +N: 42 | max rendered lines: 9 (8 chips + +N)
overflow samples: 8 chips + "+35" ; 8 chips + "+5"
inflowDescending: true | top5: $79.355K $42.455K $23.654K $12.586K $12.363K
holder samples: 8,465 / 7,231 / 81,994 / 6,455 / 4,203 | any .000 pattern: false
hero: "Top 288 tokens ranked by tracked wallet inflow." | header hint: "sorted by tracked inflow"

Screenshots: evidence/2026-09-21-mc-trackedby-ca-holder.png (local), evidence/2026-09-21-prod-mc-chips-plus.png (prod)

## 7. UI round 3 (2026-09-21) — header weight/size, column alignment, MC bold, CA width
Files: src/components/ui.tsx (Th), src/components/SignalTable.tsx

### Root cause found
Th base had text-left; the [text-align:center] class used by HL_HEAD generated NO css at all
  -> measured: 0 rules for [text-align:center]; ALL headers (incl. the 3 highlighted) were left-aligned all along.
Fix: Tailwind v4.1.7 important modifier is a SUFFIX -> text-center!  (built css now has text-align:center!important)

### Th (shared: SignalTable, TokenDetailPage, WalletsPage, SettingsPanel)
text-[11px] font-semibold text-ink2  ->  text-[14px] font-bold text-ink

### Resulting column alignment (header == value, verified computed text-align)
left  : Ticker, CA, Tracked by, Nansen setup
center: MC, Holder, Tracked Inflow, Tracked Holding, 24H Volume, Tier, Entry

### MC
value: text-ink2 12.5px  ->  font-bold text-ink, centered  (rendered $54.325K, weight 700, align center)
minMc hint restored (was deleted by a bad edit) — renders "MC | >= $5.000M" when minMc > 0; absent on prod (MIN_MC=0)

### Widths (viewport 1995, table stretched 1.37x)
CA w-24 -> w-36 ; Tracked by w-72 -> w-60 ; total units unchanged 352
PROD: CA col 197px, Tracked by col 329px, CA clipped rows = 0 / 288

### Prod deploy
make deploy -> deploy OK ; make up -> web Up 7s, HTTP 200, /api/health healthy nansen
Screenshots: evidence/2026-09-21-header-align-mc-bold-local.png, evidence/2026-09-21-prod-header-align.png
