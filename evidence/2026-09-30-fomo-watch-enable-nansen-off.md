# 2026-09-30 — Enable FOMO watch on instance b, Nansen OFF, instance a untouched

## Instruction (verbatim)
"enable fomo watch lên đi nhưng mà không cho query đến nansen, không động đến instance A"
Chosen scope (user picked from 4 options): **Bật daemon + tắt Nansen trên b**.

## Before
- `fomo-watch.service` (b, host): `disabled` + `inactive`. `/opt/fomo-watch/fomo.env` held only
  `SIGNAL_SCAN_SERVICE_TOKEN` — **no `FOMO_API_KEY`**.
- b api: `nansenApi=off` (NANSEN_API_KEY commented in `server/.env:9`) but `chartSweep=on`
  (from `docker-compose.yml:50` hardcoded `NANSEN_CRAWL: "on"`, shared by a+b).
  With the free browser door on, b's `setupSweep` -> `metric('gini')` falls through the
  CompositeProvider to Nansen's browser door (gmgn has no gini) = real Nansen traffic.
- a api/web/chrome started 2026-09-29T09:49:39Z / 09:32:22Z (matches prior evidence).

## Action 1 — turn Nansen OFF for b only (no repo change, a untouched)
`docker-compose.yml` is shared; editing it + `make deploy INSTANCE=a` would ship it to a. Instead a
**b-local override** (compose auto-loads it; `make deploy` never deletes it):

`/root/signal_scan_b/docker-compose.override.yml`
```yaml
services:
  api:
    environment:
      NANSEN_CRAWL: "off"
```

Recreate only b api:
```
cd /root/signal_scan_b
PORT=8125 BIND=0.0.0.0 DATA_DIR=data-b COMPOSE_PROJECT_NAME=signal_scan_b \
  SHOW_CLAN=on TITLE=fomo SHOW_FOMO=on docker compose up -d --force-recreate api
```
Verified (`docker compose config`): effective `NANSEN_CRAWL: 'off'`.
Verified (startup): `mode=gmgn provider=gmgn+nansen nansenApi=off gmgnApi=on chartSweep=off`.
`grep -i nansen` in b api logs since recreate: none.

## Action 2 — enable the FOMO daemon (key provided by user)
First `systemctl enable` + a start attempt with no key → crash-loop (`FOMO_API_KEY chưa set`),
so it was stopped. User then supplied the (old, still-valid) FOMO key; appended to
`/opt/fomo-watch/fomo.env` (`chmod 600`, value never recorded here).

```
systemctl enable fomo-watch   # enabled
# append FOMO_API_KEY=<key> to fomo.env, chmod 600
systemctl start  fomo-watch
```
Final: `is-enabled=enabled`, `is-active=active`.

## Verified live (2026-09-30 03:54Z)
- `--once` self-check (stdout): `# fomo watch list: 164 handle, 14 userId`,
  `# fomo socket connected`, matched `fomo buy shiprekt88 $PUMP sol ≈ $5,593`, `emitted=1`, exit 0.
- b api log: `POST /api/fomo-watch/trades status=200`.
- b DB: `fomo_trades n = 1` (buy PUMP sol, usd 5593.17, event b8770c20-…),
  `tracked_cas note='fomo' = 1` → the FOMO buy enqueued its CA for tracking.
- b api log since restart: `nansen`/`credit` lines = **0** → the FOMO buy's enqueue did NOT query Nansen.

## Residual / follow-up
1. The key is STILL the leaked one (pasted in chat again) → **rotate before production**, then
   update `fomo.env` and `systemctl restart fomo-watch`.
2. b's watch list = 164 rows (imported 2026-09-29). F3 UI render check (merged "Tracked by" column)
   not re-run here.

## Residual Nansen path (NOT closed by env; needs code if owner wants zero)
CompositeProvider keeps Nansen as the fallback for `essential`/`volume`/`tokenInfo` when a GMGN
call errors. With `nansenApi=off` + `chartSweep=off` the FOMO buy path itself is clean
(`kickSetupEarly` gated by crawlEnabled; `kickNansen`->`seriesAtRung` returns undefined with a
null flows client; `flowsSweep` no-ops), but a GMGN failure can still reach Nansen's browser door.
Closing that fully = the "change code to block Nansen on the FOMO path" option.

## Instance A untouched
`signal_scan-api-1` started=2026-09-29T09:49:39.780Z, `signal_scan-web-1` started=2026-09-29T09:32:22.579Z
(both identical before/after). No a container recreated, no a file edited.

EVIDENCE_RECORDED: evidence/2026-09-30-fomo-watch-enable-nansen-off.md
