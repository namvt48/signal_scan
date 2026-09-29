# 2026-09-29 — Nansen credit burn cut + LF write-once + permissive tracked-by

## Problem
`tgm/flows` (1 credit/call) was fetched 2×/CA on `flowsSweep` (every 15 min) AND
again on `setupSweep` (every 1h) → ~240 credits/CA/day. Wallet "Tracked by"
membership also expired after `TRACKED_BY_WINDOW_MS` (7d), so an early buyer
vanished from a re-added CA.

## Changes
| File | Change |
|---|---|
| `server/src/config.ts` | `POLL_FLOWS_MS` 900_000 → 21_600_000 (6h); `POLL_SETUP_MS` 3_600_000 → 21_600_000 (cache TTL, so `setupSweep` stops hourly refetch); new `NEW_TOKEN_MIN_AGE_MS` (4h) + `NEW_TOKEN_RETRY_MS` (1h); `TRACKED_BY_WINDOW_MS` comment now prune-only |
| `server/src/poller.ts` | `applySeriesPass` LF write-once: skip `exchangeLf` when `genesis_bal != null` AND a cache entry holds non-empty `exchange`; carry `prev.exchange` into the re-stored entry (`isStorable` requires non-empty exchange). New `isTooNewToken` (basis `deployed_at ?? added_at`, fail-open): too-new CAs get flat 1h retry in `setupSweep` and are filtered out of the 5-min `essentialGapSweep` |
| `server/src/signals.ts` | `trackedWalletStats` + `trackedWalletStatsByCa`: dropped `b.ts >= @memberSince` (membership = ever-bought); 24h stat window untouched. Caller updated to 1-arg `latestWatchTradeTsByCa` |
| `server/src/db.ts` | `latestWatchTradeTsByCa` signature `(sinceTs, memberSince)` → `(sinceTs)` |
| `server/test/lf-write-once.test.ts` | NEW: stale entry + known `genesis_bal` → 1 series call, **0 exchange calls**, entry re-stored fresh with carried points; second test locks the first-pass LF fetch |
| `server/test/signals.test.ts`, `server/test/assemble-signals-batch.test.ts` | Assertions inverted to ever-bought membership (member with `inflow 0` + `balUsd`) |

## Credit math after
- `flowsSweep` 6h = 4 passes/day × 1 call (T100; LF skipped) = **4/CA/day**
- `setupSweep` cache TTL 6h ≈ 4 fetches/day × 1 call = **4/CA/day**
- **≈ 8 credits/CA/day** (was ~240 → ~30×)

## Verification (fresh, this session)
- `cd server && npx tsc --noEmit` → exit **0**
- `cd server && npm test` → **tests 358 / pass 358 / fail 0** (duration 29.7s)
- Code inspected: `config.ts:72,79-81,107`; `poller.ts:365,409,642-653,1003`; `db.ts:407`; `signals.ts:413`

## Decisions flagged
1. `essentialGapSweep` (5-min re-ask) is effectively off for CAs < 4h old — they wait for the hourly `essentialSweep`. Intended ("tránh spam request"); revert by reverting the `line 1003` filter.
2. Ever-bought membership is global: a wallet whose only buy is > 7d old now shows in `Tracked by` (inflow 0) for ALL CAs, not only re-added ones.
3. `pruneTrackedByNone(TRACKED_BY_WINDOW_MS)` LEFT UNTOUCHED — a CA that shows a wallet but has no buy in 7d can still be pruned at 7d. Make it window-less if that contradicts intent.
4. LF write-once only freezes after `seriesReachesStart` passed (validated read); a lost setup-cache file self-heals on the next pass.

## Deploy — 2026-09-29 (instance a / production)
- `make restart` (deploy + up) → `signal_scan-api` **Recreated**, `signal_scan-web` Running (identical image), `restarts=0`.
- Built images == running images:
  - api `sha256:d91ae649695a15ba45e29328a2c5e6fb9eef39f3069d7a5048be386fb0cde513`
  - web `sha256:9b12408101e0898fc98e8709764b702c5893a506f57b272dd40f89e061ee49de`
- Served web bundle = freshly built bundle (`index-BeftzA1-.js`, `index-Diq2vjx.css`).
- `/api/health` → `{"healthy":true,"mode":"gmgn","provider":"gmgn+nansen"}`; external `https://signal-scan.duckdns.org/` → HTTP 200 via `make test`.
- LIVE config proof from `docker compose logs api`:
  - `[poller] setup sweep every 7200000ms (retries until a CA is complete, then 21600000ms)` → `POLL_SETUP_MS` = 6h active.
  - `[poller] essentialGapSweep done in 1ms` → new-token filter working (no re-asks).
- `server/.env` overrides on host: `POLL_SETUP_RETRY_MS=7200000`, `POLL_ESSENTIAL_MS=7200000`, `POLL_ESSENTIAL_GAP_MS=1800000`, `POLL_VOLUME_MS=1800000`, `POLL_WALLETS_MS=1800000`, `POLL_SYMBOL_BACKFILL_MS=1800000`.
  **No override** for `POLL_FLOWS_MS` / `POLL_SETUP_MS` / `NEW_TOKEN_*` → compiled defaults (6h / 6h / 4h / 1h) apply.
- Deployed to INSTANCE=a only; `/root/signal_scan_b` (instance b) NOT touched.

## Blocking finding (not code)
Nansen returns `403 Insufficient credits remaining to call this endpoint` on `POST /api/v1/tgm/flows`.
The client gates on it: `nansen-credit gated until 2026-09-29T04:47:12.069Z` (10-min gate, only 2 calls attempted — no hammering).
So T100/LF ingestion is dry until the Nansen credit balance resets/is topped up. The cadence cut is live but buys nothing while the balance is 0.

EVIDENCE_RECORDED: evidence/2026-09-29-nansen-credit-lf-write-once.md
