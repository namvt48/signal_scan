# FOMO user watch - evidence index (2026-09-29)

Human-readable index of every artifact captured while building and verifying the FOMO
user watch feature (plan `.omo/plans/fomo-user-watch.md`, branch `feat/fomo-user-watch`).

All paths are relative to the repo root. Raw artifacts live under
`.omo/evidence/fomo-user-watch/`. The runbook is `docs/2026-09-29-fomo-user-watch.md`.

Every artifact below is checked to exist on disk by
`.omo/evidence/fomo-user-watch/task-11-runbook-check.txt` (and its negative twin
`task-11-runbook-check-negative.txt`, which proves the check fails on a missing path).

---

## Task 0 - alert capture (planning ground truth)

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl` | Raw keyless capture: 109 messages, 102 alerts, 68,562 bytes / 115s window. The pinned field map (alertType, trader, eventId, tokenAddress, ts, usdValue) and the money measurement come from here. |
| `.omo/evidence/fomo-user-watch/task-0-capture-summary.md` | Summary of the capture: envelope `type` distribution, per-alertType money counts, chain distribution, and the large-trades-only caveat. |

## Task 1 - `fomo_users` / `fomo_trades` schema

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-1-fomo-db.txt` | Happy QA: `importFomoUsers` bulk upsert, UNIQUE handle, FK cascade, and the pre-change DB opens without throwing. |
| `.omo/evidence/fomo-user-watch/task-1-fomo-db-negative.txt` | Failure proof: widening the `type` CHECK to allow `perp` lets a perp-shaped row in, proving the CHECK is load-bearing. |
| `.omo/evidence/fomo-user-watch/task-1-fomo-trade-check-fix.txt` | Follow-up fix: `INSERT OR IGNORE` was swallowing CHECK violations, replaced with `ON CONFLICT(event_id) DO NOTHING` (perp via the accessor now throws loudly). |

## Task 2 - auth route policy

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-2-auth-routes.txt` | Happy QA: route-policy matrix test passes; the fomo routes are gated (viewer 200 on GET, 403 on POST; service token 2xx on ingest; anonymous 401). |
| `.omo/evidence/fomo-user-watch/task-2-auth-routes-negative.txt` | Failure proof: removing the ingest policy entry makes the service-token assertion fail, proving the gate is load-bearing. |

## Task 3 - `VITE_SHOW_FOMO` build flag

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-3-flag-matrix.txt` | Happy QA: both build states exit 0; the only lowercase `fomo` string in either bundle is the data-layer key, so the flag-off build has no FOMO column code path. |
| `.omo/evidence/fomo-user-watch/task-3-flag-off-absence.txt` | Failure proof: the flag-off build omits the FOMO column code (gated, not merely hidden). |

## Task 4 - DataStore contract and both implementations

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-4-datastore.txt` | Happy QA: `npm run build` (tsc + vite) exits 0, proving both the localStorage and REST implementations satisfy the widened `DataStore` interface. |
| `.omo/evidence/fomo-user-watch/task-4-datastore-negative.txt` | Failure proof: deleting one FOMO method from `restDataStore` makes tsc fail naming the missing property, then restored to green. |

## Task 5 - `/api/fomo-users` CRUD and CSV import

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-5-fomo-users.txt` | Happy QA: `npx tsc --noEmit` exit 0 plus the `fomo-users` route test (create, 409 duplicate, PATCH, DELETE 204, import with a skipped row, viewer 403). |
| `.omo/evidence/fomo-user-watch/task-5-fomo-users-negative.txt` | Failure proof: an empty handle returns 400 (not 500, not a silent insert) and unknown fields are ignored. |

## Task 6 - `POST /api/fomo-watch/trades` ingest

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-6-fomo-watch-trade.txt` | Happy QA: a valid body creates one row; reposting the same `eventId` is a 200 no-op; an untracked user is a 404 that inserts nothing; perp/thesis are 400. |
| `.omo/evidence/fomo-user-watch/task-6-fomo-watch-trade-negative.txt` | Failure proof: a missing `eventId` and a `type:'perp'` body both 400 with zero inserted rows. |

## Task 7 - signal plumbing (`FomoUserStat`, `fomoUsers`)

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-7-fomo-signals.txt` | Happy QA: `fomo-signals` plus the existing signals tests pass; `buyUsd` is BUY-only (a sell's value is never added/subtracted); membership is ever-bought; `fomoUserStatsByCa` matches the per-CA function. |
| `.omo/evidence/fomo-user-watch/task-7-no-leakage.txt` | Failure proof: FOMO trades leave `trackedWallets` / `trackedInflow` / `trackedActivityAt` unchanged (no leakage into the existing score path). |

## Task 8 - watch-list UI behind `SHOW_FOMO`

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-8-fomo-users-ui.png` | Happy QA: the FOMO watch-list surface on instance b (list + add form + import/export). |
| `.omo/evidence/fomo-user-watch/task-8-import-preview.png` | Failure proof: a 2-row CSV with an empty handle shows the import preview with the skipped row and its reason; the list is unchanged. |
| `.omo/evidence/fomo-user-watch/task-8-viewer-gating.png` | A viewer account sees no add/import/delete controls. |
| `.omo/evidence/fomo-user-watch/task-8-flag-off.png` | Flag-off build shows no FOMO surface anywhere. |
| `.omo/evidence/fomo-user-watch/task-8-export.csv` | The exported CSV has the exact header `handle,name,clan,userId,walletSolana,walletEvm` with one data row. |

## Task 9 - `FOMO by` column in SignalTable

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-9-fomo-column.png` | Happy QA: the `FOMO by` header with sub-grid, one watched user's handle/trades/buy $/age, no balance cell, and the modal breakdown. |
| `.omo/evidence/fomo-user-watch/task-9-empty-and-long.png` | Failure proof: a CA with no FOMO rows shows the empty treatment and a long handle truncates instead of widening the table. |

## Task 10 - the firehose daemon

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-10-fomo-daemon.txt` | Happy QA: the offline regression covers frame drops (perp/thesis/ethereum/untracked), handle matching, eventId dedupe, FOMO-specific state/heartbeat, and no key in state or logs; a `--once` live smoke connects the socket and updates state. |
| `.omo/evidence/fomo-user-watch/task-10-fomo-daemon-negative.txt` | Failure proof: starting with the key unset exits non-zero with a clear message (no traceback, no key echo); a malformed frame is skipped and the loop continues. |

## Task 11 - runbook, evidence, acceptance checks

| Artifact | What it proves |
|---|---|
| `.omo/evidence/fomo-user-watch/task-11-runbook-check.txt` | Happy acceptance run: artifact existence, key-leak (API-key-prefix scan), the Makefile/docker-compose fomo grep, and `git status --short` (no `.env`, `keys/`, `data*`). |
| `.omo/evidence/fomo-user-watch/task-11-runbook-check-negative.txt` | Failure proof: a deliberately non-existent evidence reference makes the existence check FAIL, then the corrected reference PASSES. |

---

## Raw sample cited by the runbook

The alert to `fomo_trades` mapping in `docs/2026-09-29-fomo-user-watch.md` section 3
cites `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl` as its source.
