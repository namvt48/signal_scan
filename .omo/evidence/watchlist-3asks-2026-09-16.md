# Evidence — watchlist 3 asks (full-width / T100 format / debug toggle)

Date: 2026-09-16T16:52:51+07:00 (2026-09-16T09:52:51Z)
Prod: root@194.163.187.250, web localhost:8124 -> signal_scan-web-1 / signal_scan-api-1

## Local gates (from repo, before deploy)

- `server/`: `npx tsc --noEmit` -> exit 0
- `server/`: `npm test` -> exit 0, 69 pass / 0 fail (was 62; +7 new `settings-debug`)
- root: `npx tsc --noEmit` -> exit 0
- root: `npm run build` -> exit 0 ("✓ built in 5.21s")

## Deploy

- `make deploy` -> exit 0 ("== deploy OK, docker compose build pass")
- `make up` -> exit 0
  - `signal_scan-api-1  Up`  `signal_scan-web-1  Up  0.0.0.0:8124->80/tcp`
  - `HTTP 200 — web localhost:8124`
  - `{"mode":"nansen","provider":"nansen",...,"healthy":true}`

## Ask 1 — full width (no horizontal scroll)

`src/components/SignalTable.tsx`:
- removed `mx-auto max-w-[1180px]`
- `min-w-[1460px]` -> `min-w-[1280px]` (both skeleton + main table)
Columns sum ~1264px, so table now fits a 1366+ viewport instead of requiring >=1510px.

Prod bundle contains the new class:
- `/usr/share/nginx/html/assets/index-B4jkj0NH.js:min-w-[1280px]`

## Ask 2 — T100 label shows `T100 <value>` only

`src/lib/format.ts:47`:
```
if (s.t100) parts.push(`T100 ${(s.t100.multiple ?? s.t100.pct).toFixed(3)}`);
```
No `%`, no `x`, no `down-arrow`. Prod `/api/signals` payload shape:
```
T100 samples: [('JOLLYBOT', {'pct': 0, 'multiple': 1}), ('DREGG', {'pct': 51.342527877738156, 'multiple': 2.055182804168896}), ('CRIBS', {'pct': 12.113276563063517, 'multiple': 1.1378282872469976})]
```
=> renders `T100 2.055`, `T100 1.138`.

## Ask 3 — debug config toggle (default OFF)

`server/src/settings.ts:78-99`: `DEBUG_ALL_FACTORS_KEY='allFactors'`, `getDebugAllFactors()`, `setDebugAllFactors()`, `settingsResponse()` -> `{values, defaults, debug:{allFactors}}`.
`server/src/api.ts:156-169` `parseSettingsBody` -> `SettingsPatch` with real-boolean guard; `:167` non-boolean -> `{error}`; `:228` flag applied before the response reads it back.
`server/src/signals.ts:187-189` score block UNCHANGED; `:199-209` display gate `allFactors || pass`.
`src/components/SettingsPanel.tsx` checkbox "Show all factors (debug)"; `src/types.ts` `Settings.debug`, `SettingsPatch`.

### Prod contract (live HTTP, via nginx :8124)

```
1) GET default     : {"values":{...},"defaults":{...},"debug":{"allFactors":false}}
2) PUT true        : (200, debug.allFactors=true)
3) GET after       : {"allFactors": true}
4) PUT non-bool    : (400, '{"error":"allFactors must be a boolean"}')
5) PUT numeric only: (200, debug.allFactors=true)      <- numeric PUT does not reset the flag
6) GET isolate     : {"allFactors": true}
7) PUT false(rest) : (200, debug.allFactors=false)
8) GET final       : {"allFactors": false}
```

### Gating effect (prod /api/signals, 482 rows)

```
OFF rows 482 | factors_shown 298 | sample [('Bjz6Dz', [], 0), ('JOLLYBOT', [], 0), ...]
ON  rows 482 | factors_shown 701 | sample [('Bjz6Dz', ['fresh'], 0), ('JOLLYBOT', ['fresh','t100','lf'], 0), ...]
nansen keys seen: ['fresh', 'lf', 'score', 't100']
restored allFactors=False ; sanity GET {'allFactors': False}
```

Score unchanged by the flag (`score` stays 0 for the shown failing factors).

## Changes not deployed (still open decisions)

- `server/.env` on prod sets `POLL_TOKEN_MS` / `POLL_HOLDERS_MS` / `POLL_WALLETS_MS`, but `server/src/config.ts` reads
  `TOKEN_SWEEP_SEC` / `HOLDERS_SNAPSHOT_SEC` / `WALLET_SWEEP_SEC` -> all three overrides are dead.
  Effective intervals = defaults 120s / 300s / 900s. Also dead: `MODE=gmgn`, `GMGN_*`, `RATE_W*`.
- Wallet sweep fails `403 Insufficient credits remaining` (Nansen official API credits exhausted).
- Token sweep observed full pass ~2h06m (09:38:28 -> 11:44:44, 377 fetched_at), 44 `Navigation timeout of 45000 ms`
  in 3h, 0 `tokenSweep done in` lines -> latency-bound, not meeting its 120s interval.
- CAM: 427 `tracked_cas`, 362 NULL `entry_usd`; `entry_usd` only written at insert (`server/src/db.ts:325`),
  never updated -> fail-open exposes every NULL regardless of the $50 `minUsd` gate.
