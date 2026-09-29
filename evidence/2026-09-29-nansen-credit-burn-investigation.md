# 2026-09-29 — Nansen credit burn investigation (300 credits / ~30 min)

## Action taken: burn STOPPED
Commented out `NANSEN_API_KEY` in both instance env files (backups kept) and force-recreated the api containers.
`config.nansenApiKey` empty → `nansenApi = null` → every credit door (`exchangeLf`, `seriesAtRung`,
`NansenMarketProvider.creditTokenInformation`) early-returns. `NANSEN_CRAWL=off` everywhere, so the
free browser door was already inactive — the credit API was the only Nansen traffic.

Verified after recreate:
- `signal_scan-api-1` / `signal_scan_b-api-1` startup flag `nansenApi=off`
- `nansen post` log lines since recreate: **0** on both instances
- containers Up, `/api/health` `healthy:true`, `nansen-credit gateUntil=0`
- web + api still serving (dashboard unchanged)

### Revert
`server/.env` untouched in git (server-side only). Backups: `/root/signal_scan/server/.env.bak-nansenstop`
and `/root/signal_scan_b/server/.env.bak-nansenstop`. To re-enable: uncomment the `NANSEN_API_KEY=` line in
each `server/.env`, then
`cd /root/signal_scan && PORT=8124 BIND=127.0.0.1 DATA_DIR=data COMPOSE_PROJECT_NAME=signal_scan SHOW_CLAN=off TITLE=signal_scan docker compose up -d --force-recreate api`
(and the same with b's env: `PORT=8125 BIND=0.0.0.0 DATA_DIR=data-b COMPOSE_PROJECT_NAME=signal_scan_b SHOW_CLAN=on TITLE=fomo`).

## Measurements (facts)
| Item | Value |
|---|---|
| `x-nansen-credits-remaining` (probe, 07:4xZ) | **9629** — account NOT dry |
| `x-nansen-credits-cost` on `POST /api/v1/tgm/flows` | **1** credit/call |
| `x-nansen-credits-used` | 1 |
| Key holders (repo-wide, server+local) | `/root/signal_scan/server/.env` + `/root/signal_scan_b/server/.env` — **SAME key (shared pool)**; local dev has no `server/.env` |
| Instance b | 1 CA, 0 calls/30 min — negligible |
| Instance a setup-cache | 125 entries, 1.5 MB, mtime 09:35Z |
| `NANSEN_CRAWL` | off (no free-door traffic) |
| `tgm/flows` success log | none — only DEBUG (`nansen.ts:367`), `LOG_LEVEL` unset → INFO |
| Logged `nansen post` 403s/hour | 04h=21, 05h=53, 06h=59, 07h=11 → **403 failures cost 0 credits** |

## Corrected earlier claim
The committed evidence file (2026-09-29-nansen-credit-lf-write-once.md) and commit 7d1b25c state
"nansen returns 403 insufficient credits → ingestion dry until the balance resets". **That is wrong**:
a live probe returned HTTP 200 with `x-nansen-credits-remaining: 9629`. The 403s were intermittent, not a
zero balance.

## Why the burn could not be attributed from logs
Successful credit calls are invisible: `postOnce()` logs `x-nansen-credits-remaining` at **DEBUG** only
(`server/src/providers/nansen.ts:367-368`) and `LOG_LEVEL` is unset (INFO). Every failing (403) call is
logged but costs 0; every spending call is silent. So the log volume was anti-correlated with the spend.

## Prime suspect
One full setup pass over the 125 cached CAs at 1 credit/call ≈ **125–300 credits**, matching the observed
"~300/30 min":
- at the 04:36Z restart the container logged `[setup-cache] loaded 0 entries` → every CA counted as
  `needsSetup` → T100 + LF re-fetched for all 125;
- `[poller] setupSweep done in 5751618ms` = a **95-minute** sweep (06:00:06Z → 07:35:58Z) — the window the
  user reports falls inside it.

## Bugs found (not yet fixed)
1. **TTL bypass for incomplete CAs** — `needsSetup()` (`poller.ts:352-358`) returns true when the cached
   entry is FRESH but the token score is `!nansenScore(...).complete`, so such a CA re-fetches T100 + LF on
   **every** `setupSweep` (every `POLL_SETUP_RETRY_MS`=2h on the server), ignoring `POLL_SETUP_MS` (6h).
   N incomplete CAs = N × 2 credits every 2h, indefinitely.
2. **No guard against an empty cache load** — a restart that loads 0 entries silently triggers a full
   backfill of every tracked CA (~300 credits). Nothing compares cache size against `tracked_cas`.
3. **No credit accounting on success** — spend is untraceable; `x-nansen-credits-cost` is not read at all
   (only `-remaining`, and only at DEBUG).

## Recommended debug next steps (needs sign-off)
1. Log credit spend at INFO: `path`, `x-nansen-credits-cost`, `x-nansen-credits-remaining` per call, plus a
   per-sweep `credits spent` counter. Without this the burn stays invisible.
2. Fix `needsSetup` so an incomplete-but-fresh CA respects the TTL (or the miss ladder), instead of
   re-asking every pass.
3. Guard the empty-cache backfill (refuse/slow a full re-ask when `tracked_cas >> cache entries`).
4. Re-enable the key only after step 1 lands, so the next pass can be attributed to the call.

EVIDENCE_RECORDED: evidence/2026-09-29-nansen-credit-burn-investigation.md
