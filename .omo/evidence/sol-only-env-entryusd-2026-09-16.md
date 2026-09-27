# sol-only + env key contract + entry_usd backfill — 2026-09-16

Request: "vấn đề 1 phải sửa cho đúng, xóa hoàn toàn các chain khác đi chỉ chạy chain sol
thôi fix 1 và 3 đi, sửa xong chưa cần deploy đâu"

NOT DEPLOYED. Repo is not a git repo — every claim below was re-read from disk and every
command re-run by the orchestrator, not taken from a subagent report.

## 1. Chain narrowed to Solana only

Single source of truth, both sides:

- `server/src/shared/chain.ts:3` → `export const CHAINS = ['sol'] as const;`
- `src/types.ts:1` → `export const CHAINS = ['sol'] as const;`

Downstream (all now reject/omit non-sol):

| File | Change |
|---|---|
| `server/src/providers/nansen.ts:81` | map → `{ sol: 'solana' }` (removed bsc/eth/base) |
| `server/src/providers/nansen.ts:406` | map → `{ sol: 'solana' }` (removed bnb/eth/base) |
| `server/src/db.ts` | CSV-import error msg now derives from `CHAINS` (was hardcoded "bsc, sol, eth or base") |
| `server/src/db.ts` SEED_WALLETS | 8 entries → all `chain:'sol'`; 6 EVM `0x…` addresses → base58 Solana (CT03/CT06 already sol, untouched) |
| `server/src/db.ts` mock-seed CA | `chain:'bsc'` → `'sol'` (would not compile otherwise) |
| `src/components/WalletsPage.tsx:14` | `EMPTY_DRAFT` hardcoded `chain:'bsc'` → `chain: CHAINS[0]` |
| `src/components/WalletsPage.tsx:65` | placeholder `"0x... or base58"` → `"base58 address"` (EVM vestige) |
| `src/services/dataStore.ts:176` | CSV error msg derives from `CHAINS` |
| `src/services/dataStore.ts` SEED_WALLETS | 8 → all `chain:'sol'`, 6 EVM addrs → base58 |
| `src/services/dataStore.ts` SEED_SIGNALS | 6 entries `'bsc'`/`'base'` → `'sol'` (required by narrowing; mock `ca` strings left as-is) |
| tests | `min-usd-gate.test.ts` 4×, `signals.test.ts` ~12× (+ `` `bsc:${CA_A}` ``), `nansen.test.ts` bsc/eth asserts → sol/solana |

Known cosmetic leftover (deliberate, reported): mock `SEED_SIGNALS` entries now carry
`chain:'sol'` with `0x…` `ca` strings. `ca` is a plain `string` field with no chain
validation and the mock wallet addresses were the scoped fix.

## 2. Poll-cadence env keys normalized to ONE convention: `POLL_*_MS` (milliseconds)

Root cause: `config.ts` read `TOKEN_SWEEP_SEC`/`HOLDERS_SNAPSHOT_SEC`/`WALLET_SWEEP_SEC`
(seconds) while `POLL_NANSEN_MS` used ms. Prod `.env` set `POLL_TOKEN_MS`/`POLL_HOLDERS_MS`/
`POLL_WALLETS_MS` → 3 overrides silently dead; effective cadence was 120s/300s/900s.

- `server/src/config.ts:33,35,38` → `POLL_TOKEN_MS` (default 120_000), `POLL_HOLDERS_MS` (300_000), `POLL_WALLETS_MS` (900_000); unit comment corrected to "milliseconds in env AND internally"
- `server/.env.example:19,21,24` → `POLL_TOKEN_MS=120000`, `POLL_HOLDERS_MS=300000`, `POLL_WALLETS_MS=900000` (= code defaults, no-op template); section header `(seconds)` → `(milliseconds)`
- `docker-compose.yml:3` comment → `(POLL_*_MS, NANSEN_API_KEY, ...)` (dropped retired MODE/GMGN_*)
- `server/dist/` regenerated so no stale `_SEC` string survived in the build artifact

Prod `server/.env` rewritten (NOT restarted → zero behavior change yet):

| Key | Before | After |
|---|---|---|
| `MODE` | `gmgn` (dead; resolveMode only logged a warning) | **removed** → default `nansen` |
| `GMGN_API_KEY`, `GMGN_PRIVATE_KEY` | dead | **removed** |
| `RATE_W1_RPS`, `RATE_W1_CAPACITY`, `RATE_W5_RPS`, `RATE_W5_CAPACITY` | dead | **removed** |
| `POLL_TOKEN_MS` | `300000` (dead) | `300000` → **live** |
| `POLL_HOLDERS_MS` | `3600000` (dead) | `3600000` → **live** |
| `POLL_WALLETS_MS` | `30000` (dead) | `900000` (30s would burn ~660k credits/h) |
| `SWEEP_PACE_FACTOR=0.8`, `NANSEN_API_KEY`, `PORT`, `DB_PATH` | kept | kept (values never printed) |

Backup: `/root/signal_scan/server/.env.bak.20260916T120842`, perms `0600`.
`docker-compose.yml` api service uses `env_file: server/.env` — confirmed the right file.

Post-deploy effective cadence: token **2min→5min**, holders **5min→60min** (12× less load on
the Cloudflare-protected holders door, source of the 44× `Navigation timeout 45000ms`),
wallets unchanged at 15min.

## 3. `tracked_cas.entry_usd` — stop creating NULL, start UPDATEing

Two independent causes found:

(a) Column `entry_usd` was added 2026-09-16. Schema of two backups (both lack the column):
`data.bak.20260910T160917` (11 rows) and `data.bak.preMinUsd.20260916T102840` (56 rows).
Every pre-migration row is NULL by construction.
(b) Scanner `track_post_body` POSTed unpriced swaps (omitting `usd`) → `entry_usd = NULL`;
`signals.ts:160-163` then fails OPEN on NULL (deliberate + covered by
`min-usd-gate.test.ts`: "NULL included (fail-open)") → those rows showed on the watchlist and
could never be checked against the $50 gate. Prod impact measured: 500 rows / 413 NULL (82.6%)
/ 87 priced; the 2026-09-16 flood was ~446 rows in one hour vs a normal ~20/day.
(c) `entry_usd` was written only at INSERT, never UPDATEd.

Fixes:

- `scripts/wallet_watch.py` `track_post_body` → returns `None` when `quote_usd` is not a
  finite number > 0 (unpriced swap no longer becomes a CA). Priced path always sets
  `body["usd"]`. Event-level gate `0.0 < qusd < min_usd` (line ~695) and swap detection
  untouched — unknown-price events still flow through detection.
- `server/src/db.ts:334` new `setTrackedCaEntryUsd(address, chain, usd)` —
  `UPDATE ... SET entry_usd = ? WHERE address = ? AND chain = ? AND entry_usd IS NULL`
  (SQL guard = never overwrites a known entry size).
- `server/src/api.ts` `POST /api/tracked-cas` — existing row + `entry_usd == null` + price
  present → backfill and answer **200** (no `kickCAs`, CA is already polled); known entry →
  **409** unchanged; new row → insert + kickCAs + **201** unchanged.
- `server/src/signals.ts` NOT touched (NULL fail-open is deliberate and tested).

## Verification (all re-run by the orchestrator)

```
server: npx tsc --noEmit                 → EXIT=0
server: npm test                          → EXIT=0 | tests 70, pass 70, fail 0, skipped 0
   (baseline was 69; +1 new: "setTrackedCaEntryUsd: fills NULL once, never overwrites
    a known entry, unknown CA -> undefined")
root:   npx tsc --noEmit                  → EXIT=0
root:   npm run build                     → EXIT=0, built in 4.86s
py:     python3 scripts/test_wallet_watch.py → EXIT=0
        OK: track_post_body BUY/SELL (có giá) → body+usd, TRANSFER/empty-mint → None
        OK: track_post_body unpriced (quote_usd=0/thiếu) → None; priced → body['usd'] đúng giá
py:     python3 scripts/test_block_feed.py   → EXIT=0 | OK: block-feed 19/19
grep "'bsc'|'eth'|'base'" server/src server/test src → ZERO hits
grep "TOKEN_SWEEP_SEC|HOLDERS_SNAPSHOT_SEC|WALLET_SWEEP_SEC" server/src server/.env.example docker-compose.yml Makefile → ZERO hits
grep "TOKEN_SWEEP_SEC" server/dist → ZERO hits
```

End-to-end against a local server on a throwaway DB (`DB_PATH=/tmp/e2e.db PORT=3999`):

```
POST unpriced  {address:CA_E2E_1, chain:sol}          → 201 accepted (legacy NULL path)
POST repost    {address:CA_E2E_1, chain:sol, usd:60}  → 200  ← the fix (was 409)
POST repost    {address:CA_E2E_1, chain:sol, usd:999} → 409  ← known entry protected
sqlite /tmp/e2e.db → tracked_cas = [('CA_E2E_1','sol',60.0)]   ← 999 did NOT overwrite
POST {chain:bsc}  → 400 {"error":"invalid chain (expected one of sol)"}
POST wallet {chain:eth} → 400 {"error":"invalid chain (expected one of sol)"}
GET /api/settings → debug.allFactors=false on a fresh DB (default OFF)
```

Contract check — keys `config.ts` reads vs keys present in prod `.env`:
```
config.ts : POLL_HOLDERS_MS, POLL_NANSEN_MS, POLL_TOKEN_MS, POLL_WALLETS_MS
prod .env : POLL_HOLDERS_MS, POLL_TOKEN_MS, POLL_WALLETS_MS
```
`POLL_NANSEN_MS` absent in prod → falls back to the 3_600_000 default (unchanged behavior).

## Open items (user decision required — nothing destructive was done)

1. **413 legacy NULL rows** still in prod `tracked_cas`. The new guard only stops NEW NULLs;
   an old row is backfilled only if that token trades again by a tracked wallet. Options:
   (a) one-time backfill from the scanner's `events.jsonl` by matching the `sig` embedded in
   `note` (`auto:{side} by {wallet} {sig}`) → recovers the true `quote_usd`, non-destructive;
   (b) delete rows where `entry_usd IS NULL` → destructive, needs explicit approval.
2. `allFactors` is currently **ON** (`'1'`) in the prod `settings` table — the user's debug
   switch, left as-is.
3. Prod has 1 `bsc` row in `tracked_cas` (pre-existing). Harmless under the narrowed union
   (read path does not validate chain) but it is now unreachable garbage — delete on request.

EVIDENCE_RECORDED: .omo/evidence/sol-only-env-entryusd-2026-09-16.md
