# 2026-09-21 — Zero-score CA rejection gate + prod cleanup scan

## Feature (user request, verbatim intent)
Wallet watch finds a valid trade → CA added to watch → its data is crawled → if the
symbol is still null, do nothing (re-query later); if the data is non-null and
COMPLETE while the Nansen setup is 0/3, delete it immediately instead of keeping it
tracked. Then: scan the whole server tracking list once and clean it.

## Implementation
| file | change |
|---|---|
| `server/src/signals.ts` | NEW exported `NansenScore` + `nansenScore(st, th)` (L162-224) — factor math extracted verbatim from `assembleSignals`, which now calls it (L257). Single source of truth for thresholds. Adds `complete`. |
| `server/src/db.ts` | NEW `CaScoreGateRow` + `listCaScoreGateCandidates()` (L476-504, `tracked_cas LEFT JOIN token_state`), `deleteTrackedCasByIds(ids)` (L512-525, one transaction + the same orphan `token_state` cleanup `pruneUntrackedCas` uses; `wallet_trades` deliberately kept) |
| `server/src/poller.ts` | NEW exported `zeroScoreGate()` (L216-236) — deletes ONLY `complete && score === 0`, one batched delete, per-CA evidence log, wrapped so a throw cannot kill the sweep. Called at the end of `walletSweep` (L259), right after `pruneUntrackedCas` |
| `server/test/zero-score-gate.test.ts` | 3 cases: complete+0/3 deleted (+orphan state), incomplete kept, complete+1/3 kept |
| `server/scripts/prune-zero-score-cas.ts` | dry-run by default, `--apply` deletes; refuses to run when the DB file is absent |

`complete` requires ALL of: `st` exists, `symbol` non-empty after trim, `supply`,
`price`, `nansen_fresh_pct` (raw column — the mock-mode `fresh_count` fallback does
NOT qualify), `t100_multiple`, `genesis_bal` all non-null. Anything missing → kept.

## Verification (local)
- `cd server && npm test` → **tests 123, pass 123, fail 0** (baseline before this change: 120; +3 new). Zero-score gate cases logged live: `[poller] rejected CA caGate-dead (sol) 0/3 symbol=DEAD fresh=9 t100=1.099… lf=999999`
- `cd server && npm run build` → exit 0
- root `npx tsc --noEmit` → exit 0
- only 5 files modified in the whole repo (verified by mtime sweep): the 4 src/test/script files above + nothing else
- `deleteTrackedCasByIds` / `CaScoreGateRow` show 0 direct test callers in codegraph (covered indirectly through `zeroScoreGate`, which the 3 new tests exercise)

## Prod dry-run (read-only) — 194.163.187.250
Method: pushed only the 5 new/changed files to `/root/signal_scan` (running container
untouched, it runs `dist/`), `docker cp` of `src/` + script into `/app/local-gate`
inside the container, online backup of the live DB to `/tmp/dry.db`
(`better-sqlite3.backup`, source opened readonly), then the REAL script and a
report that calls the REAL `nansenScore` against the copy.

```
tracked_cas rows: 312 | gate candidates: 312
complete: 238   score 0/1/2/3 = 116/…/…
incomplete (KEPT, waiting on sweeps): 74
would delete 116 of 312 tracked CAs      <- real script, exit 0, 318 output lines

factor health among the 238 complete rows:
  freshPass=71  t100Pass=23  lfPass=56   (score0=116)
  t100 multiple: ==1 exactly=138, 1<x<1.2=77, >=1.2=23
  why 0/3: {"freshFails+t100Fails+lfFails": 116}   <- every doomed CA fails ALL THREE
  score0 impact: wallets holding >=1 = 80, buys in 24h = 15
  incomplete missing: t100=48, lf=48, price=35, fresh=7, supply=1
```

Every doomed row carries `note=auto:BUY by <wallet>` — i.e. all 116 came from the
wallet watch; no manually added CA is in the set.

**No-write proof**: `md5sum /data/signal_scan.db` = `7b39f94f9069f1f802c71d79b0aa3592`
before and after the dry-run (identical), size 165916672.

## Executed (user approved 2026-09-21)
Decision: backup → delete the 116 → deploy the gate. Deny-list NOT built — the user
confirmed the re-add churn ("kệ đó đúng là logic tôi muốn").

**Backup** (before any delete)
- online backup with the app live: `better-sqlite3.backup` (source opened readonly)
- `/root/backups/signal_scan-20260921-before-gate.db`, 165916672 bytes,
  md5 `00e2085f35a3d61b0dea252d460927f6`
- `PRAGMA quick_check` → `ok`; counts at backup time: tracked_cas=312, token_state=312,
  wallet_trades=1562, wallet_token_state=1083, wallets=198
- disk before: 47G/96G used (50G free)

**Deploy** — `make restart` from the local repo (the Makefile is local-only; the host
has no Makefile): exit 0, `signal_scan-api-1` recreated, web HTTP 200,
`/api/health` → `{"mode":"nansen","healthy":true}`. New code live in the image:
`grep -c zeroScoreGate /app/dist/poller.js` → 3, `scripts/prune-zero-score-cas.ts` present.

**Apply**
```
docker compose exec -T api npx tsx scripts/prune-zero-score-cas.ts --apply
apply exit=0
deleted 116 tracked CAs
remaining tracked CAs: 196
```
Post-delete counts: `tracked_cas=196`, `token_state=196` (orphans cleaned — the numbers
match exactly), `wallet_trades=1562` (untouched by design), `wallet_token_state=1083`.

**Gate satisfied** — same analysis re-run against the live DB:
```
tracked_cas=196 candidates=196 complete=122 incomplete=74
among COMPLETE rows -> freshPass=71 t100Pass=23 lfPass=56  (score0=0)
why 0/3: {}          <- no complete CA is left at 0/3
incomplete missing: t100=48, lf=48, price=34, fresh=7
```
The gate now runs automatically at the end of every `walletSweep` (POLL_WALLETS_MS,
15 min in prod), so as the 74 incomplete CAs finish arriving they get judged too.

**Dashboard** (`/api/signals` + rendered page at http://194.163.187.250:8124/)
- API: 164 rows (was 250), score>=1 = 122, score=0 = 42 (all incomplete-by-design),
  `volume1h` present on 30 rows (the column now carries real data)
- page: 12 columns, `1H Volume` at index 8 — between `Tracked Holding` (7) and
  `24H Volume` (9) as originally specified — 122 rows rendered, 21 of them with a `$`
  value in 1H Volume, no error banner
- note: the table renders score>=1 rows only, so the VISIBLE row count is unchanged
  (the deleted rows were already hidden). The gain is crawl budget + a clean DB, not
  fewer visible rows.

Cleanup: host temp files, `/app/local-gate`, `/tmp/dry.db`, `/tmp/backup.db` removed.
The `/root/backups/` dump is retained.
