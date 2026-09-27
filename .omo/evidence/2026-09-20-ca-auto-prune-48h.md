# CA auto-prune: 48h inflow window — 2026-09-20

Request: "thêm cơ chế tự xoá hoàn toàn một CA nếu không có bất kì inflow nào từ wallet theo dõi trong vòng 48h kể từ inflow gần nhất".

## Change (minimal — reuse existing prune, do NOT touch TRACKED_BY_WINDOW_MS)
| file | change |
|---|---|
| `server/src/config.ts` | new `CA_INFLOW_WINDOW_MS` = `CA_INFLOW_WINDOW_MS` env, default `48 * 3_600_000`; removed now-dead `config.caPruneMinAgeMs` |
| `server/src/db.ts` | `pruneUntrackedCas(windowMs)` — one param instead of `(buySinceTs, minAgeMs)`; same SQL, both gates now use the window |
| `server/src/poller.ts` | `pruneUntrackedCas(CA_INFLOW_WINDOW_MS)` (was `Date.now() - TRACKED_BY_WINDOW_MS`, `config.caPruneMinAgeMs`) |
| `server/test/prune-untracked-cas.test.ts` | new rule + `YOUNG` case (hand-added, no inflow yet, inside window ⇒ must survive) |

Why a separate constant: `TRACKED_BY_WINDOW_MS` (7d) also feeds the `trackedBy` column (`signals.ts:206`) and the Nansen crawl window (`nansen.ts:647`) — shortening it would silently narrow those too.

Rule as implemented: drop a CA when no tracked wallet HOLDS it (`wallet_token_state.token_amount > 0`) AND no `wallet_trades` BUY with `ts >= now - 48h` AND `added_at <= now - 48h` (the added_at gate is what gives a never-bought CA the full window instead of a 6h grace).

## Local verification
- `npx tsc --noEmit` → exit 0.
- `npm test` → **tests 111 / pass 111 / fail 0**.
- RED proof (temp script, deleted after): same fixture set, `pruneUntrackedCas(6h)` → `['A-dead','B-young-no-inflow']` (B dies — old semantics), `pruneUntrackedCas(48h)` → `['A-dead']` (B survives). So the YOUNG assertion pins the 48h window.

## Deploy
- DB backup first (WAL-safe sqlite `.backup`): `/root/signal_scan/data/signal_scan.db.bak.preInflow48h.20260920T180712` (165 MB).
- `make restart` → rsync `server`+`src` → `docker compose build` → api container recreated; web HTTP 200; `/api/health` `{"mode":"nansen","healthy":true}`.
- Image verified to carry the change: `dist/config.js` has `CA_INFLOW_WINDOW_MS` + `48 * 3_600_000`; no `caPruneMinAgeMs`; `dist/db.js:308 pruneUntrackedCas(windowMs)`; `dist/poller.js:190 pruneUntrackedCas(CA_INFLOW_WINDOW_MS)`.

## Live result
Prediction made BEFORE deploy, from the live DB:
```
window 48h -> 16/108 CA   (grace 6h, no holding, no buy >= now-48h)
window 7d  -> 0/108 CA
```
After the first `walletSweep` (runs after the holdings pass; failures in that pass are caught per wallet):
- 16 × `[poller] prune untracked CA <addr> sol (added <ts>) auto:BUY by <wallet> <buySig>`
- `tracked_cas` 113 → **97**; all 16 predicted addresses gone, **0** of them remaining.
- Sample pruned: `7GPGqsfVK1gG88…pump` (added 2026-09-16T12:20), `AGcHhhcPhC6dXi…pump`, `HYdVEWivtWEUXq…` (added 2026-09-18T16:04).

## What "delete" currently touches (open question)
`DELETE FROM tracked_cas` only. After the run:
- `wallet_trades` for pruned CAs: 186 rows KEPT (wallet history — correct, do not delete).
- `wallet_token_state` orphans: 0 (FK cascade).
- `holder_snapshots` orphans: 0.
- **`token_state` orphans: 965 / 1062 rows** (incl. the 16 just pruned).
- **`nansen_series` orphans: 3159 / 3405 rows** — historical crawl data, expensive to re-collect.
So the current prune is not "hoàn toàn": it leaves ~4.1k orphan rows. Whether to purge them is the user's call (nansen_series has real re-crawl cost).

## Unrelated prod note (not caused by this change)
On container start, 931 × `[poller] kickWalletHoldings … getTokenAccountsByOwner failed` (every wallet kicked at once → Helius rate limit). 0 such errors in the last 3 min, and `getHealth` returns `"ok"`. Transient startup burst; the RPC and token sweeps are fine (`lastTokenFetchAt` advancing). Only consequence: right after a restart the holdings pass can be stale, and that pass is what the prune's "still holds" protection reads (conservative: over-protects, never over-deletes).

## Round 2 — "hoàn toàn" (token_state orphan sweep)
The first deploy only deleted the `tracked_cas` row, leaving the CA's own market data behind: 965 orphan `token_state` rows had accumulated (that table has no FK to `tracked_cas`, so the cascade never reached it). Fixed.

Safety check before writing the sweep (readers of `token_state`, all scoped to tracked CAs — a pruned CA's row is unreachable forever):
- `db.ts:348/365/383` — LEFT JOIN from `tracked_cas t` on `s.ca = t.address`.
- `signals.ts:164` — loops `listTrackedCas()`.
- Writers: `poller.ts:448 upsertTokenInfo`, `poller.ts:200/459 updateTokenAnalytics`, both fed by `poller.ts:73` = `listTrackedCas()` or `listCaTargetsByVolume()` — and the latter is `FROM tracked_cas t LEFT JOIN token_state` (`db.ts:378`). Live proof: `tiers: hot=37 cold=60` = 97 = `tracked_cas` count. So `token_state` is only ever written for tracked CAs ⇒ the sweep can never delete live data.
- FE never touches `token_state` (grep clean).

Change: one statement inside the existing transaction of `pruneUntrackedCas` (`db.ts:463-466`), swept by `NOT EXISTS` (not per dropped CA) so it also drains the old backlog, and unconditional so it runs even when nothing is doomed:
```sql
DELETE FROM token_state WHERE NOT EXISTS (
  SELECT 1 FROM tracked_cas t WHERE t.address = token_state.ca AND t.chain = token_state.chain)
```

Test (`test/prune-untracked-cas.test.ts`): token_state rows for DEAD, HELD and ORPHAN (never tracked). Asserts DEAD's row gone, HELD's kept, ORPHAN's swept. RED proof: with the sweep removed the file fails 1/1 (`actual: {ca:'caPrune-dead'…}, expected: undefined`); restored → `tsc` 0, **111/111 pass**.

Deploy + live: backup `signal_scan.db.bak.preTokenStateSweep.20260920T182719` (165 MB) → `make restart` (LOCAL make — the server has no Makefile) → image carries the sweep (`grep -c` in `/app/dist/db.js` = 1). After the next `walletSweep` (it paces 198 wallets at ~3.6s → `walletSweep done in 716391ms`, ~12 min; the prune runs after it):
```
before: token_state=1064  orphan=965
after : token_state=99    orphan=0    tracked_cas=99   tracked CAs WITH a token_state row=99
```
So exactly the dead rows went, all 99 tracked CAs kept theirs, and no CA was dropped (0 prune lines — nothing was doomed this round).

Deliberately NOT swept: `nansen_series` (3159 orphans). It is the only table whose loss is not free — a CA re-bought by a tracked wallet gets re-added, and its already-crawled history would be worth having. `wallet_trades` stays as history too. Awaiting the user's call.

