# Evidence — 1H Volume column on the signal table

Date: 2026-09-21 · Repo: `/home/namvt/Desktop/dev-space/signal_scan` · Mode: mock (no live Nansen spend for E2E)

## 1. Request (verbatim)

> `chốt A , chỉ hiển thị thôi và cho làm một cột giữa cột Tracked Holding và 24H Volume`

Option A: new **1H Volume** column, display-only (NOT an entry gate), sourced from the Nansen
`tgm-volume-details` endpoint with `intervalSec: 3600`.

## 2. Why `intervalSec: 3600` is a real 1h window (live probe, highest-risk assumption)

`GET /api/v1/tgm-volume-details` on a real CA, same endpoint/CA, only `intervalSec` varied:

| `intervalSec` | `buyVolumeUsdRecent` | window |
|---|---|---|
| 86 400 | $474.153,70 | 24h |
| 3 600 | $31.358,99 | 1h |
| 900 | $523,52 | 15m |

Distinct, monotone values ⇒ `intervalSec` **is honored** by the provider; the fields are a
sliding window, not a fixed 24h. (Probe script `server/scripts/probe-vol-1h.mjs`, run then deleted.)

Cost: the volume sweep now issues 2 asks/CA instead of 1 (~2.3 → ~4.7 req/min at 112 tracked CAs)
against a ~43 req/min budget for one browser page ⇒ safe.

Concern that 1h would duplicate a sweep: `POLL_VOLUME_MS = 3_600_000` (1h) equals the requested
window, and each sweep reads one fresh window ⇒ consecutive, non-overlapping readings.

## 3. Changes

| File | Change |
|---|---|
| `server/src/providers/nansen.ts` | `volumeDetailsBody(ca, chain, intervalSec = 86_400)`; `case 'volume'` asks both windows — 24h as the primary metric, 1h in its own `try`/`catch` so a 1h failure cannot destroy the 24h number in the same patch; `tokenInfo()` forwards `volume1h` |
| `server/src/providers/provider.ts` | `volume1h?: number` on `MetricPatch` and `TokenInfo` |
| `server/src/providers/mock.ts` | synthesizes `volume1h` and carries it on the `'volume'` patch |
| `server/src/db.ts` | `vol_1h REAL` in `SCHEMA` + appended to the ALTER-migration list; `TokenStateRow.vol_1h` |
| `server/src/ingest.ts` | `['volume1h','vol_1h']` in `METRIC_WRITERS`; `upsertTokenInfo` inserts/stores the column; `vol_1h = COALESCE(excluded.vol_1h, token_state.vol_1h)` so a patch without 1h never wipes a measurement |
| `server/src/signals.ts` | DTO `volume1h?: number`, only spread when `vol_1h != null` |
| `src/types.ts` | `volume1h?: number` on `TokenSignal` |
| `src/components/SignalTable.tsx` | `<Th>1H Volume</Th>` placed between `Tracked Holding` and `24H Volume`; cell renders `usd(s.volume1h)` or `—`; `SkeletonRows cols={11→12}`; `min-w-[1400px→1500px]` (2 places) |
| `server/test/nansen.test.ts`, `server/test/signals.test.ts` | intervalSec test (3600 vs 86400), 2-ask ordering + 1h soft-fail test, DTO pass-through + absent-CA test |
| `server/scripts/nansen-sidecar.mjs` | dev tool: new `want` value `volume1h` → same endpoint via the prod body builder at `3_600`s, so a live 1h-vs-24h check needs no throwaway script (`node server/scripts/nansen-sidecar.mjs <chain> <back> volume,volume1h < list.txt`) |

Deliberate design decisions:
- `volume1h` is **optional** (never defaulted to `0`) so the UI prints `—` for "not measured yet",
  matching the existing fail-open convention used by `marketCap`.
- The new column uses the `HL_HEAD` / `HL_CELL` (highlighted-group) style, i.e. the column is treated
  as part of the highlighted metric group. → **flip this if it should be plain.**
- No entry gate / threshold added: the column is display-only per the decision above.

## 4. Verification

### 4.1 Static + tests

```
cd server && npm run build      → exit 0
npx tsc --noEmit   (root)       → exit 0
npm run build      (root)       → exit 0  (tsc + vite)
cd server && npm test           → 117 pass / 0 fail   (includes the 2 new tests)
```

### 4.2 Real HTTP path (mock provider, `MODE=mock`, API on :3001)

`POST /api/tracked-cas` × 3, then `GET /api/signals`:

```
MOCKSRC   vol1h=$14648 score=2
MOCKEGB   vol1h=$28681 score=1
MOCK05A   vol1h=$4949  score=1
MOCKIIS   vol1h=ABSENT score=0     ← never measured → field omitted from the DTO
```

`GET /api/signals` is a direct `res.json(assembleSignals())`, so the DTO is exercised end to end.

### 4.3 Browser (vite dev on :5199, real DOM, headless Chromium)

`document.querySelectorAll('thead th')` after load:

```
Ticker | MC | CA | Tracked by | Nansen setup... | Holder | Tracked Inflow |
Tracked Holding | 1H Volume | 24H Volume | Tier | Entry
```

- `colCount = 12`, index of `1H Volume` = **8**, immediately between `Tracked Holding` (7) and `24H Volume` (9). ✅
- Values render: `$14.648K` / `$28.681K` / `$4.949K`, with the following (24H) column carrying the
  larger `$496.461K` / `$484.180K` / `$81.798K` ⇒ 1H is visibly a subset of 24H. ✅
- **Not-measured path**: with `vol_1h` forced to `NULL` in the DB and the debug all-factors view on,
  the browser rendered `—` in that cell for all 4 unmeasured rows. ✅
- No console errors; table width 1965px with `scrollWidth == clientWidth` (no clipping at that viewport). ✅

## 5. Limits / not done

- **Not deployed.** Prod (`194.163.187.250`) still runs the old bundle/schema.
- After deploy, `vol_1h` is `NULL` for every existing CA until its first hourly volume sweep ⇒ the
  column shows `—` for up to one `pollVolumeMs` (default 1h).
- No live-Nansen E2E: the probe only proved the endpoint honors `intervalSec`; the sweep path itself
  was exercised against the mock provider.
- Not an entry gate — no ratio (`vol_1h / (vol_24h/24)`) or threshold knob exists yet.

## 6. Re-verification (independent re-run, same day)

Re-run from scratch after the initial pass, asserting each edit at the source level (not from notes):

```
cd server && npm run build   → exit 0
cd server && npm test        → tests 117 · pass 117 · fail 0 · cancelled 0 · skipped 0
npx tsc --noEmit   (root)    → exit 0
npm run build      (root)    → exit 0 · dist/assets/index-BYXQbssb.js 211.21 kB (FE grew ~0.4 kB)
```

Source assertions (all PASS):

- `nansen.ts:571` 24h ask → `nansen.ts:576-582` `let volume1h` inside its own `try`/`catch {}` → `:587`
  spread-if-defined. A 1h failure keeps the 24h patch. `nansen.ts:629` `tokenInfo` forwards `volume1h`
  (the kick path writes the column immediately on a new CA, not only at the hourly sweep).
- `db.ts:114` `vol_1h REAL` in `SCHEMA`; `db.ts:189` `'vol_1h'` is the **first** entry of the
  ADD-COLUMN list guarded by `db.ts:190` `if (!cols.includes(col))` ⇒ existing prod tables migrate.
- `ingest.ts`: `['volume1h','vol_1h']` writer + `@volume1h` bind + `vol_1h = COALESCE(excluded.vol_1h, token_state.vol_1h)`.
- `signals.ts` DTO // `src/types.ts` // `SignalTable.tsx` header order verified by offset (Tracked
  Holding < 1H Volume < 24H Volume), `cols={12}` on the skeleton, `min-w-[1500px]` in exactly 2 places.
- `nansen-sidecar.mjs` syntax OK; the rebuilt `dist/providers/nansen.js` emits
  `intervalSec: 3600` vs `86400` for the 2-arg vs 3-arg call.

The 3 initial FAIL markers in this audit were defects in the audit's own regexes, not the code
(needle `'function tokenInfo'` misses `async tokenInfo(`; the ALTER-array slice cut at line 190 while
the item sits at 189). Re-checked by reading the actual lines; both confirmed correct.

Cleanup: vite dev `/tmp` servers on 5199/3001/3099 killed, temp DB `v1h.db` + logs removed.

## 7. Deploy (prod 194.163.187.250, port 8124)

```
make restart   → exit 0
  docker compose build  → Image signal_scan-web Built / Image signal_scan-api Built
  docker compose up -d  → api Recreated+Started, web Recreated+Started, chrome Running
make test      → HTTP 200 (outside), /api/health {"mode":"nansen","provider":"nansen","healthy":true}
```

Verified on the live box:

- Served FE bundle `assets/index-_b-2bgZV.js` **contains `1H Volume`** → the column is live.
- `token_state.vol_1h` exists on the real prod DB → the ALTER migration ran against existing data.
- Containers: `api`/`web` Up, `chrome` Up 46h.

## 8. Incident found during post-deploy verification (NOT caused by this change)

The new column is live but **empty** (`SUM(vol_1h IS NOT NULL) = 0`), and the pre-existing
`volume24h` also stopped updating (`has24` static 191, `MAX(volume24h)` static over 22 min,
`/api/health.lastTokenFetchAt` frozen). Poller log 429s by endpoint, whole container life:

| endpoint | 429 count |
|---|---|
| `wp4t-transactions` (wallet × CA) | **5 311** |
| `tgm-holders-gini-stats` | 442 |
| `tgm-volume-details` (this column's source) | 91 |

One 6-minute window: 1 739 × 429 lines; `crawl transport unhealthy — fast-fail` × 30 earlier in the
run (0 in that window, i.e. it recovers). Some sweeps do finish (`seriesSweep.cold 478s`,
`walletSweep 716s`), so the box is partially alive.

Root cause is **demand >> budget on the single shared Chrome page** (~43 req/min measured), and it
predates this change:

- Real wp4t pair count = `wallet_token_state` rows = **1 059**; prod `.env` `POLL_WALLETS_MS=900000`
  (15 min) ⇒ **~70 req/min from wp4t alone = 1.6× the entire page budget**.
- Prod `.env` `POLL_HOT_MS=600000` + `POLL_COLD_MS=600000` ⇒ 297 CAs × (essential + volume + gini +
  holdersChange) every 10 min. My change contributes 2 asks/CA instead of 1 on `tgm-volume-details`
  ⇒ 91 of ~5 844 429s ≈ **1.6 %**. Reverting it would not clear the storm.
- Corroborated by independent Oracle consult (verdict: session/IP budget depletion driven by
  wp4t, ≈70 % confidence; this change a compounding factor, not the origin).

Recommended repair (env only, no redeploy, reversible) — brings total demand under budget:
`POLL_WALLETS_MS=5400000` (90 min → 11.8 req/min) + `POLL_HOT_MS=1800000` + `POLL_COLD_MS=7200000`
⇒ ≈ 32 req/min total vs ≈ 43 budget. Structural follow-up: move the 1h ask out of the shared volume
sweep into its own hot-tier-only `volume1hSweep` with its own interval, and/or a single shared
token-bucket in front of `ask()`.

Security note: while printing the prod `.env` filter, the agent's own `sed` redacted the wrong side
and `NANSEN_API_KEY`'s value was echoed into this session's logs. Key should be rotated.

Status: **not yet applied** — cadence is a product tradeoff (freshness vs throughput), awaiting the
user's go-ahead.
