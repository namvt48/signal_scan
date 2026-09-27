# maxMc: `-1` = "no max cap" sentinel (2026-09-21)

User report: the Settings panel showed `Min market cap 15,000` next to `Max market cap 0`.
"max lúc nào cũng phải cao hơn min chứ, kiểu 9999999999 hoặc là để -1 là không có max cap".

Root cause: the market-cap ceiling used `0` as its "off" sentinel, which reads as an
inverted band (max 0 < min 15,000). Worse, `-1` — the value the user asked for — was
**rejected** by the API: `isThresholdValueFor` only accepted `>= 0`.

Decision: adopt `-1` as the documented "no cap" sentinel (not a magic 9999999999),
normalize the legacy `0` on read, keep the gate semantics identical.

## Changes

| file | change |
|---|---|
| `server/src/config.ts:148` | `MAX_MC = num('MAX_MC', -1)` — new installs default to the explicit sentinel. `MIN_MC` untouched (`0` = no floor stays). |
| `server/src/settings.ts:35` | `isThresholdValueFor` — `maxMc` accepts `v >= -1` (other keys byte-identical). |
| `server/src/settings.ts:43` | `thresholdValueError` — `maxMc must be a finite number >= -1 (-1 = no cap)`. |
| `server/src/settings.ts:67-68` | `getThresholds()` normalizes `maxMc <= 0 → -1`, so the pre-existing persisted `maxMc="0"` row surfaces as `-1` without a migration. |
| `server/src/settings.ts:19,94-96` | doc + band-check comment updated; the inverted-band error still fires only when the ceiling is armed (`> 0`), so `minMc=15000 + maxMc=-1` is valid. |
| `src/types.ts:120` | doc: `-1 = no cap`. |
| `src/components/SettingsPanel.tsx:20,30,46-51,121` | `FieldSpec.hint`; `maxMc` gets `min: -1, hint: '-1 = no max'`; `regroup()` now preserves a leading `-` (it stripped non-digits, so typing `-1` used to collapse to `1`). |
| `server/test/min-mc-gate.test.ts` | +4 regressions (below). |

`server/src/signals.ts` intentionally NOT edited — `th.maxMc > 0 && marketCap > th.maxMc`
(L244) already treats `-1` and `0` as "off".

## Verification

Local (`npm test` / `npm run build` / root `npx tsc --noEmit`)
- **127 pass / 0 fail** (123 before + 4 new), `TEST_EXIT=0`, `BUILD_EXIT=0`, `TSC_EXIT=0`
- new cases: `maxMc=-1` validates + round-trips / `-2` rejected with the exact message /
  `setSetting('maxMc','0')` → `getThresholds().maxMc === -1` (the prod legacy row) /
  `-1` keeps a 5000-cap row while `maxMc=1000` drops it / `minMc=15000 + maxMc=1000` → error

Prod (`make restart`, exit 0, web HTTP 200, `/api/health` healthy)
```
GET  /api/settings  → values.maxMc = -1   (normalized from the persisted "0"), defaults.maxMc = -1
PUT  {"maxMc":-1}   → 200 OK             (was 400 "must be a finite number >= 0" before)
PUT  {"minMc":15000,"maxMc":1000} → 400 {"error":"minMc (15000) must be <= maxMc (1000)"}
FE bundle assets/index-BF-vQeWS.js contains the "-1 = no max" hint
GET  /api/signals   → 164 rows, 122 with score>=1, 30 with volume1h  (no regression)
```

## Incident found during verification
`debug.allFactors` was `1` before the deploy and `0` after. Cause: the Settings panel
saves the whole patch — `SettingsPanel.tsx:155` `updateSettings({ ...parsed.values, allFactors })`
— so a Save from a panel whose `allFactors` state was `false` (`:96` init / `:134` load)
overwrites the flag. With `allFactors=false` the table narrows to passing rows only
(`SignalTable.tsx:317`). It was **not** part of this change; restored to `allFactors=true`
via `PUT {"allFactors":true}` and re-read as `true`.
