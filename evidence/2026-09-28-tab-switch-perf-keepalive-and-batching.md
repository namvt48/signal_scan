# Tab-switch latency: root cause, fixes, production verification (2026-09-28)

User report: "sao mà hiện tại tôi chuyển qua lại giữa 2 tab dashboard và rated thời gian load bị lâu
vậy có cách nào cải thiện không". Approved scope: deploy the pending UI fix first, then do A + B.

## Root cause (two layers, additive)

**1. FE — every tab switch was a remount + full refetch.** `src/App.tsx` rendered tabs by conditional
mount (`{tab === 'dashboard' && <SignalTable/>}` / `{tab === 'rated' && <SignalTable/>}`), so switching
unmounted one table and mounted the other, re-running the data effect (`SignalTable.tsx:385-412`) and
refetching `listSignals()` + `getSettings()` from scratch. No caching existed anywhere. So ~3s of
network+server was paid on **every** switch, not just the first.

**2. BE — `/api/signals` was itself slow (~2.5s of server work).** `assembleSignals` looped over
`listTrackedCas()` and per CA called `getTokenState` (db.ts:811), `sumHoldingAmount` (signals.ts:175)
and `trackedWalletStats` (signals.ts:134) — and **each of those called `getDb().prepare(...)` on every
invocation**. ~460 tracked CAs x 3 = ~1380 statement compiles + 1380 queries per request.
(`latestWatchTradeTsByCa` was already batched — 1 query total, not a culprit.)

## Fix A — keep-alive tabs (instead of a response cache)

`src/App.tsx`: a `visited: Set<Tab>` state (seeded `['dashboard']`) marks tabs visited on click; each
table renders inside a wrapper `<div>` that gets `className="hidden"` when inactive. Lazy (mounts on
first visit) and never unmounts afterwards, so a switch back is pure `display` toggling — no refetch,
and each tab keeps its own sort/filter/scroll state.

`src/components/SignalTable.tsx`: new optional `onTierChange?: () => void` prop (destructured as
`notifyTierChange`), called after the tier PUT settles. Wired in App to bump `settingsVersion`. Needed
because with both tables kept alive, a tier set on Dashboard would otherwise be invisible on an
already-mounted Rated tab for up to its 30s poll.

Why keep-alive over a module-level cache (the originally-described "A"): a cache would need a
`DataStore` interface change (the 30s poll must bypass the cache while a switch must use it), TTL or
explicit invalidation on `setTier`, and it loses per-tab view state. Keep-alive is a smaller diff with
no invalidation surface.

## Fix B — batched queries

- `server/src/db.ts` +`allTokenStates()` — one `SELECT * FROM token_state`, keyed `${chain}:${ca}`.
- `server/src/signals.ts` +`sumHoldingAmountByCa()` — one `GROUP BY ca` over `wallet_token_state`,
  preserving the per-CA `EXISTS (watch BUY, no time bound)` filter.
- `server/src/signals.ts` +`trackedWalletStatsByCa(now)` — one query using a `members` CTE
  (`DISTINCT ca, wallet_id`, watch BUY within `TRACKED_BY_WINDOW_MS`) then **LEFT JOIN** the 24h
  windowed trades, `GROUP BY (ca, wallet_id)`, `ORDER BY ca, lastTs DESC, name`. The CTE + LEFT JOIN
  is required: a naive `JOIN wallet_trades` silently drops a member that has no trade inside the 24h
  stat window, which must still appear as `inflow 0, buys 0, sells 0, lastTs 0`.
- `assembleSignals` now does 3 map lookups (`?? 0` / `?? []`) instead of 3 queries per CA.
- Existing `getTokenState` / `sumHoldingAmount` / `trackedWalletStats` are untouched and still
  exported (`getTokenState` has 32 callers).
- New regression test `server/test/assemble-signals-batch.test.ts` locks batched-vs-per-CA equality
  for every CA, including the member-with-no-trades case.

## Verification

### Static
- `npm run build` (FE) exit 0 — CSS hash unchanged by A/B (`index-CfaYdb5Z.css`), JS `index-Cm_2rwAl.js`.
- `cd server && npx tsc --noEmit` exit 0.
- `cd server && npm test` → **320 pass / 0 fail** (316 pre-existing baseline + 4 new).

### B: equivalence against REAL production data (460 tracked CAs)
Ran against a copy of the prod DB (`backup-pretier-20260928T072709Z.db`):
- per-CA equivalence, batched vs per-CA: **0 mismatches**
- `assembleSignals` output byte-identical: `allFactors=false` 229,920 B ✓ / `allFactors=true` 375,528 B ✓
- timing on that copy: median **468.5 ms → 113.8 ms (4.1x)**

### Deploy (instance A) + DB backup
`make restart` (INSTANCE=a). Both `signal_scan-api-1` and `signal_scan-web-1` recreated (server code
changed, unlike the earlier FE-only deploy). Web HTTP 200, `/api/health` `healthy:true`, `mode:gmgn`.
Instance B untouched.

Pre-deploy safety backup made with `better-sqlite3`'s online `.backup()` (no `sqlite3` CLI on the box):
`data/backup-prepbatch-2026-09-28T0811Z.db` — 36,298,752 B, 10 tables, `tracked_cas=460`,
`wallets=201`, `wallet_trades=35056`, `token_tiers=1`.
(NOTE: a first attempt picked `data/signal.db` — a 0-byte stale file from 19/09 — because of an
`ls *.db | grep -v backup | head -1` filter. The live DB is `signal_scan.db`. The bogus backup was
deleted and redone properly.)

### B on production
Server-side duration from the api's own request log (`dur=`), which isolates processing from transport:

```
path=/api/signals status=200 dur=118
path=/api/signals status=200 dur=150
path=/api/signals status=200 dur=142
... 105–178 ms across 20 samples
```

| measurement | before | after |
|---|---|---|
| `/api/signals` server `dur` | ~2.5 s (implied by 2.96–4.09 s curl) | **105–178 ms** |
| curl `time_total` (from this workstation) | 2.96–4.09 s | 1.39–2.30 s |
| curl `time_starttransfer` (TTFB) | — | ~0.60 s |
| transfer of 230 KB | — | ~1.44 s @ ~113 KB/s |

The residual curl time is **not server work**: `/api/settings` returns `dur=1 ms` server-side while
curl sees 0.61 s, and the 230 KB body downloads at ~113 KB/s on this workstation's link to the VPS.
So the API fix is proven server-side; the leftover number is transport.

### A on production (Playwright, http://194.163.187.250:8124)
Request counting is the decisive evidence — exactly **2** `/api/signals` requests for the whole session:

| # | request | triggered by |
|---|---|---|
| 10 | `?allFactors=0` | initial Dashboard load |
| 136 | `?allFactors=1` | first visit to Rated |
| — | *none* | **clicking back to Dashboard issued ZERO requests** |

- Lazy mount confirmed: after initial load only **1** wrapper existed (`tables: 148`, `rows: 450`)
  — the Rated table was not fetched until first visited.
- Rated after first visit: wrapper index 1 visible, `skel: 0`, stat row
  `Tiered so far 1 | S-tier 0 | A-tier 1 | B-tier 0` — matches `token_tiers = 1` exactly.
- Switch back to Dashboard: wrapper 0 visible, wrapper 1 hidden, **0 skeleton cells, 450 rows
  already present**. The ~324 ms observed is browser re-layout of 148 tables/450 rows when un-hiding,
  not a fetch. Measured note: an earlier probe reported `msToVisible: 1` / `ratedFirstLoadMs: 0` —
  those were invalid, because the probe read the DOM before React committed the new wrapper and
  because skeleton rows are themselves `tbody tr`; the corrected probe waits for the wrapper to exist
  first.
- `bodyRows: 4` on the Rated table looked like 4 tokens but is **1 data row + a 3-row nested
  "Tracked by" table** (`parentIsNested: true`) — consistent with `token_tiers = 1`, not a bug.

## Cleanup
- Killed a leftover mock API from this session on `:3001` (pid 30182, `MODE=mock`,
  `DB_PATH=/tmp/opencode/ss_local.db`, cwd = this repo) plus its npx wrapper; removed
  `/tmp/opencode/ss_{fe,server}.log`, `ss_local.db*`, `ss_keepalive.db*`, `prod_copy.db`,
  `prod_work.db`, `prod-equiv.ts`. Ports 3001/5173 free.

EVIDENCE_RECORDED: evidence/2026-09-28-tab-switch-perf-keepalive-and-batching.md
