# allFactors debug setting — implementation evidence

Generated: 2026-09-16T09:48:10Z (UTC)
Task: add persisted boolean `allFactors` setting to signal_scan **server**, expose on
`/api/settings`, use it to gate which Nansen factors `assembleSignals` returns.
Backend only — frontend `src/` untouched (parallel-agent owned, per constraint).

## Files changed (server/src)
- settings.ts  L75–100: DEBUG_ALL_FACTORS_KEY + getDebugAllFactors()/setDebugAllFactors()
  + SettingsResponse interface + settingsResponse() helper. Numeric threshold plumbing
  (THRESHOLD_KEYS, isThresholdValueFor, thresholdValueError, updateThresholds) left UNTOUCHED.
- api.ts       import swap (drop thresholdDefaults, add settingsResponse+setDebugAllFactors);
  parseSettingsBody → { thresholds, allFactors? } with real-boolean guard (400 on non-bool);
  GET /api/settings emits settingsResponse(getThresholds()); PUT applies thresholds then debug
  flag (validate-before-write, before response reads it back).
- signals.ts   import getDebugAllFactors; read per call in assembleSignals; gate nansen.fresh/t100/lf
  display = show when PASSES or (allFactors && has value). score block (L185-188) UNTOUCHED.

## Test files
- test/signals.test.ts       CA_H LF test rewritten: failing 31% LF hidden at default false,
  revealed (3.1e8 token units) at allFactors true, score stays 0; flag reset after.
- test/settings-debug.test.ts NEW: 7 HTTP-contract tests via createApp('test').listen(0)+fetch.

## Verification (exact invocations, from server/)
Node v25.8.1 (global fetch available).
- `npx tsc --noEmit`  → TSC_EXIT=0   (server/tsconfig.json includes src, excludes test)
- `npm test`          → NPMTEST_EXIT=0

### npm test tail (observed)
✔ GET /api/settings exposes debug.allFactors=false by default, alongside values+defaults
✔ PUT allFactors=true persists and round-trips through GET
✔ PUT with only numeric keys leaves allFactors unchanged
✔ PUT with only allFactors leaves numeric thresholds unchanged
✔ PUT rejects a non-boolean allFactors with 400 { error }
✔ PUT applies allFactors alongside numeric keys in one request
✔ allFactors persists in the settings table as the string 1/0 getDebugAllFactors reads
✔ assembleSignals LF gate: failing share hidden at default, revealed by allFactors; supply<=0 → no LF pass
ℹ tests 69  ℹ pass 69  ℹ fail 0  ℹ duration_ms 1325.427484

## Success criteria → evidence
Each contract behavior backed by a named passing test above + exit code 0.
