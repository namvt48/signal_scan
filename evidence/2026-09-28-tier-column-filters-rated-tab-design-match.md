# Tier map + filter bar + Rated tab, and reference design match

Date: 2026-09-28
Local only (no deploy). BE `MODE=mock`, FE `VITE_API_BASE=""`.

## User asks
1. "nhớ lưu lại cái map address với tier lại, mỗi khi add mới CA thì check cái này"
   -> address<->tier map must be PERMANENT; prune must NOT garbage-collect it;
      a pruned-then-re-added CA must auto-restore its tier.
2. "thay đổi màu sắc và design giống hệt mấy cái vừa thêm vào giống hệt như
   file .../Signal%20Scan%20Field%20Ops%20Edition.html"
   -> newly-added UI (tier column, filter bar, Rated tab) must match the
      reference HTML exactly.

## What landed
- Tier feature: `Tier = S+ | S | A+ | A | B+ | B | null`; key `(ca, chain)` via
  `canonicalCa`; clear(null) is the ONLY deletion path.
- BE: `server/src/shared/tier.ts` (new), `token_tiers` table + listTiers/setTier/
  deleteTier in `db.ts`, tier read in `signals.ts`, `parseTierBody` + `PUT /api/tier`
  in `api.ts`.
- FE: `types.ts`, `dataStore.ts` (+`setTier`, localStorage overlay), `restDataStore.ts`,
  `ui.tsx` (`TierSelect`/`Chip`), `SignalTable.tsx` (tier col, filter rows, StatRow,
  RatedHero, `.partial-note`), `App.tsx` (Rated tab).
- **Persistence fix**: removed `DELETE FROM token_tiers ...` from
  `sweepOrphanedCaData()` in `server/src/db.ts` (~L639). `token_tiers` is now touched
  only by schema + list/set/delete helpers.
- Test: `server/test/tier.test.ts` orphan-sweep test reversed to
  `tier map is permanent: pruning keeps the row, re-adding the CA restores the tier`.
- Design: reference CSS block mirrored into `src/index.css`; `ui.tsx` emits
  `.tier-select`/`.filter-chip`; `SignalTable.tsx` restructured so `.section-head` +
  `.filter-row`s sit ABOVE the `.frame` card on both tabs.

## Verification (evidence)
- FE build: `npm run build` (tsc + vite) -> `✓ built in 4.83s`, exit 0.
- BE: `npx tsc --noEmit` exit 0; `npm test` -> pass 316, fail 0, duration 28.6s.
- Design parity (computed styles vs reference): `.tier-select` 56x26/radius 8/
  `rgba(215,250,75,0.16)` + `rgb(107,122,27)`/mono 11.5/600/center/chevron;
  `.filter-chip.all.on` `rgb(27,36,32)`+white; nansen off white/opacity .4/mono 12/700/
  radius 999; `.filter-label` 11/700 uppercase ls .44px (non-mono); `.mc-filter-input`
  88px/radius 999/mono 12/700; `.stat-tile` white radius 20 pad 18x20; `.stat-tile.hi .num`
  lime; `.stat-tile.watch .num` `#B3492E`; `.section-head h2` 19/800 `#1B2420`;
  `.meta` 12/600 `#3F4A42`; `.hero-accent` `#B3492E`; `.scan-badge` 148x148/50% gradient/lime;
  rated tiles S `#6B7A1B`, A `#3E7D52`, B `#55645C`; `.partial-note` 12/600 `#55645C`
  bg `#F7F9F6` border-top 1px center; `.frame` radius 24.
- Rated tab screenshot: `evidence/2026-09-28-rated-tab-design-match.png`
  (watch-red hero accent, dark scan-badge, olive/green stat tiles, rank chips,
   S+->S rows, note bar all match reference).
- Dashboard screenshot verified same session: 4 stat tiles (plain / `.hi` dark+lime /
  `.watch` red / plain), section-head above frame, Nansen chips row + More Filters row
  (Still Holding chip + `Market Cap ($)` Min/Max pills), full column set, footer.
- Tier persistence proven end-to-end on a fresh mock DB:
  - cleared all 4 rows -> all `null`;
  - set exactly ONE via the REAL UI select (`browser_select_option`) -> server shows
    exactly ONE tiered row (`ca02=S+`), 3 `null`;
  - reload -> row 1 still `S+`.
- Live local run: `PUT /api/tier` 200 -> row in SQLite `token_tiers` -> survives reload;
  deselect rank chip -> "No tokens match the current filter."; MC min filter 4/4 -> 1/4;
  no fetch loop (2 req/6s = StrictMode double-mount).

## The "2 tiers" anomaly — RESOLVED, NOT A BUG
An earlier probe showed 2 tiers when 1 was set. Root cause: the probe mutated
`.tier-select` via the native value setter + a synthetic `change` event, which
confuses React's controlled select. Re-tested through the real UI path: exactly ONE
row written. DB key is the full CA (`0xdemo...ca02` vs `...ca03`) — no collision.

## Known deviations / notes
- MC unit: reference label `Market Cap (K$)`; app uses raw USD so label is
  `Market Cap ($)` with `Min`/`Max` placeholders. Flagged, not yet confirmed by user.
- Dashboard hides score-0 rows by design (`base = allFactors ? signals : passing`);
  mock CAs score 0 -> use `sessionStorage signal_scan:allFactors=1` to see rows.
  Pre-existing behavior, not from this diff.
- `borderWidth` computes as `0.864865px` — uniform page-scale artifact, not a CSS bug.
- Servers used for verification were stopped; `/tmp/opencode/ss_local.db*` removed.

## Deploy (instance A, production) — 2026-09-28
Request: "deploy lên server ddddi".
Target: root@194.163.187.250, instance `a` (`/root/signal_scan`, port 8124,
MODE=gmgn real data). Instance `b` (/root/signal_scan_b, :8125) NOT touched.
Server has no git repo — `make deploy` rsyncs the WORKING TREE (uncommitted tier +
design work shipped as-is; normal flow here). rsync excludes `/data*` + `/keys`,
so the DB and secrets are untouched; `.env` preserved -> MODE=gmgn kept.

Pre-deploy backup (host has no sqlite3 -> better-sqlite3 inside the api container):
- `/root/signal_scan/data/backup-pretier-20260928T072709Z.db` (36 MB)
- pre-deploy live rows: tracked_cas 460, token_state 460, wallets 201,
  wallet_trades 35019, token_tiers ABSENT.

Deploy: `make deploy` -> "Image signal_scan-web Built / signal_scan-api Built",
"deploy OK — instance=a port=8124". `make up` -> both containers Recreated+Started.

Post-deploy verification:
- `make status`: web Up, api Up; HTTP 200 on localhost:8124;
  /api/health = {"mode":"gmgn","healthy":true} (pipeline alive).
- `make test` (external): HTTP 200 — http://194.163.187.250:8124 + /api/health OK.
- token_tiers EXISTS (auto-created by `CREATE TABLE IF NOT EXISTS` on boot).
- Data intact: tracked_cas 460, wallets 201, wallet_trades 35020 (live, +1).
- /api/signals -> 266 signals, each carries a `tier` key.
- Round-trip on a real tracked CA (9h5AzEQzYu…, sol):
  PUT S+ -> 200 tier=S+; PUT null -> 200 tier=null; tiered rows back to 0.
  => prod data left EXACTLY as before (no test residue).
- Served FE assets = index-Bdy4twLY.js / index-CLbQs_vs.css = the exact hashes
  from this build -> the live UI is byte-identical to the locally verified build.
- Prod DOM (real data): nav Dashboard/**Rated**/Wallets; table has a **Tier**
  column; More-filters row has `Still holding` + `Market Cap ($)` Min/Max
  (real MC band $15K–$15M). Rated tab renders its empty state
  ("No tokens have been tiered yet.") — correct, prod has 0 tiered tokens.

Risk note: deploy is reversible — redeploy the previous working tree + `make up`.
DB backup above is the rollback point for data.

## Market Cap (K$) fix + still-holding verification — 2026-09-28 (2nd deploy)
User: "sửa lại cho tôi Market Cap ($) là k usd là đơn vị nghìn usd, và still holding khi
bật là bỏ các CA bị loại ra khỏi dash, cái này chưa thực hiện, sửa xong đó deploy lại đi".

### 1. Market Cap unit — FIXED (real change)
Reference (`Signal Scan Field Ops Edition.html`) line 504 labels it `Market Cap (K$)` and
line 1046 does `parseFloat(minVal) * 1000` — input is in THOUSANDS, compared against the
raw-USD `marketCap`. Our app labelled it `($)` and compared the raw number directly.
- `src/components/SignalTable.tsx` `mcPass`: `Number(mcMin) * 1000` / `Number(mcMax) * 1000`.
- Label `Market Cap ($)` -> `Market Cap (K$)`.
- Left the server SettingsPanel `minMc`/`maxMc` alone — those are raw-USD server thresholds,
  a different knob the user did not mention.

### 2. "Still holding" — ALREADY IMPLEMENTED, matches reference exactly
No code change. The reference's `meetsHoldingFilter(d) = !holdingOnlyFilter || parseNum(d.holding) > 0`
(line 1030) is identical to our `holdingPass = (s) => !holdingOnly || s.trackedHolding > 0`
(SignalTable.tsx:437), and both pipe it through `combinedFilter` -> the rendered rows. In the
reference the stat tiles are HARDCODED (99/51/48/$112.546M, lines 488-491) and do NOT respond
to filters — ours also leave the tiles as global counts. So behaviour already matches.
- Live prod proof (instance A, both before and after the 2nd deploy):
  click "Still holding" -> 149 rows -> **113 rows**, `aria-pressed=true`, class `on`,
  counter `113/149 tokens match` (matches the API-side count of trackedHolding>0 among passing).
- Likely reason for "chưa thực hiện": the whole filter bar is NEW in this uncommitted batch, so
  any view from before the first deploy today (or a cached bundle) had no chip at all.

### Verification
- `npm run build` (tsc + vite) exit 0; `server npx tsc --noEmit` exit 0; `npm test` 316 pass / 0 fail.
- Local live: label `Market Cap (K$)`; min `70000` K$ (=$70M) -> 2/4 rows kept ($83.209M + the
  fail-open no-MC row). Under the old un-scaled compare it kept all 4 -> conversion proven.
- Prod live after redeploy: min `5000` K$ (=$5M) -> **11/149** rows, every shown MC >= $5M
  ($5.367M, $6.182M, $5.603M ...). Un-scaled would have kept all 149.
- Served bundle contains `Market Cap (K$)` x1 and `Market Cap ($)` x0 (grep of the live asset).
- NOTE: the served asset hash (`index-CCeFX6IV.js`) differs from a local `npm run build`
  (`index-B9IGQe5y.js`) because the Dockerfile builds with `ENV VITE_API_BASE=""` — a different
  inlined env value yields a different content hash. Asset-hash equality to a local build is NOT
  a reliable invariant; verify deployed CONTENT (grep strings / behaviour) instead.

### 2nd deploy (instance A)
`make deploy` -> images built; `make up` -> **only `signal_scan-web-1` recreated**, `signal_scan-api-1`
NOT recreated (server code unchanged) => zero pipeline disruption. Web HTTP 200, `/api/health`
`healthy:true`, external `make test` HTTP 200. Instance B untouched. No DB backup needed (FE-only
change; DB not touched by this deploy).

### 3rd deploy (instance A) — tier-cell border visibility + Rated caption removal
Two FE-only tweaks, requested by the user with "sửa thôi chưa cần deploy" (then deployed on request):
- `src/index.css` `.tier-select`: the per-tier borders were pale enough to vanish on the zebra rows
  (`odd:bg-surface` #FFFFFF / `even:bg-surface2` #EEF2EC) — and the B/B+ badge fill (#EEF2EC) was
  IDENTICAL to the even-row background, so only its `var(--c-line)` #DCE4DA border delineated it.
  Border colours darkened per tier so the badge reads on BOTH stripes.
- `src/components/SignalTable.tsx`: removed the `mode === 'rated'` `.partial-note` caption block
  ("This list is sorted S+ → B and saved to the server — ..."). Consumed the whole block rather than
  just the sentence, so no empty styled bar is left; `partial-note` appears 0 times in the built JS.

`make restart` (deploy + up): only `signal_scan-web-1` recreated; `signal_scan-api-1` stayed Up
(22 minutes) => zero pipeline disruption. Web HTTP 200, `/api/health` `healthy:true`, `mode:gmgn`.

Verified by CONTENT (asset hashes legitimately differ between the docker and local builds):

| check | served (docker) | local build | result |
|---|---|---|---|
| minified border colours in CSS | `17211b47`x1, `6b7a1b`x3, `3e7d52`x5, `3f4a42`x3 | same counts | match |
| caption fragment `automatically adds or removes it here` in JS | 0 | 0 | removed |
| `partial-note` in JS | 0 | 0 | block gone |

Served assets: before `index-CCeFX6IV.js` + `index-CLbQs_vs.css`; after `index-CeEh-zAi.js` +
`index-BvAt17zr.css`.

EVIDENCE_RECORDED: evidence/2026-09-28-tier-column-filters-rated-tab-design-match.md
