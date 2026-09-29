# Keep-alive tab switching — verification (2026-09-28)

## Change
- `src/App.tsx`: `visited: Set<Tab>` state (lazy init `['dashboard']`); tab click marks visited (new Set, no mutation); Dashboard/Rated each rendered inside a wrapper `<div>` guarded by `visited.has(...)`, inactive wrapper gets `className="hidden"`; keys preserved (`viewVersion`, `rated-${viewVersion}`); `onTierChange` bumps `settingsVersion`; WalletsPage untouched; one explanatory comment added.
- `src/components/SignalTable.tsx`: added optional `onTierChange?: () => void` prop (destructured as `notifyTierChange`), invoked via `.then()` after the tier PUT resolves (not on failure — revert path unchanged).

## Build
`npm run build` → exit 0:
```
dist/assets/index-CfaYdb5Z.css   43.36 kB │ gzip: 10.86 kB
dist/assets/index-Cm_2rwAl.js   227.25 kB │ gzip: 69.83 kB
✓ built in 4.50s
EXIT=0
```

## Runtime (Playwright, vite :5173 + mock API :3001, sessionStorage allFactors=1)
Note: a mock-mode server (pid 30182) already held :3001 before this run (started by concurrent work); my own `ss_keepalive.db` instance hit EADDRINUSE, so verification used the existing mock server. Tier test data reset to null afterwards. `/tmp/opencode/ss_keepalive.db*` never created; removed anyway. Vite killed (pid 35730), `vite_stopped` confirmed.

1. Dashboard loaded: 4 mock rows, 0 skeleton cells (`main table td .animate-pulse.bg-surface2` = 0; the single `.animate-pulse` match is a decorative badge span).
2. Click Rated → one-time load (empty state "No tokens have been tiered yet", mounted).
3. Click Dashboard → `skeletonCells: 0` — rows appear instantly, NO loading skeleton (old behaviour showed one every switch).
4. DOM after switch-back — both tables alive, inactive one hidden:
```json
[{"cls":"","tables":1,"text":"Studyingattention beforeit becomes price"},
 {"cls":"hidden","tables":0,"text":"No tokens have been tiered yet.Go to the"}]
```
5. Tier sync: set Tier=S on first Dashboard row → click Rated → rated wrapper visible with the MOCKBLP row, `ratedTierValue: "S"`, `visibleSkeletonCells: 0`. Dashboard wrapper now `cls:"hidden"` with its table still mounted (`hasTable:true` both sides). onTierChange → settingsVersion bump → hidden table refetched promptly (no 30s poll wait).

## Screenshots
- `evidence/ss_keepalive_dashboard_noskeleton.png` — Dashboard right after switch-back, rows rendered, no skeleton.
- `evidence/ss_keepalive_rated_tier_sync.png` — Rated showing tier-S MOCKBLP row right after tiering on Dashboard.

## Not touched
`server/`, data stores, DataStore interface, sort/filters/tier write/display logic, styling (only `hidden` added). No commit made.
