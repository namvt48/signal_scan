# Evidence — Token detail page disabled (2026-09-16T16:57:42+07:00)

Request: "tạm thời disable cái trang này đi ... không query các thông tin trong đây nữa,
không cho bấm vào CA để ra page chi tiết CA nữa, comment đi giảm tải lượng query"

## What was disabled (all commented, easy to re-enable)

Frontend `src/`:
- `App.tsx`: `TokenDetailPage` import commented, `selectedToken` state commented,
  `tab === 'dashboard'` now always renders `<SignalTable />` (no ternary).
- `components/SignalTable.tsx`: signature `SignalTable({ onSelectToken })` -> `SignalTable()`;
  the CA cell `<button onClick={...}/>` -> `<span title={s.ca}>` (no navigation, plain text).
- `services/tokenDetail.ts` + `components/TokenDetailPage.tsx` left on disk, now orphaned
  (tree-shaken out of the bundle) so re-enabling is a small revert.

Backend `server/src/api.ts`:
- imports `buildTokenDetail` (detail.js) and `balanceSeries` (crawl.js) commented out.
- `GET /api/tokens/:chain/:ca/detail` and `GET /api/tokens/:chain/:ca/balance-chart`
  wrapped in one `/* ... */` block. `/balance-chart` was the heavy one (browser-sidecar crawl).

## Gates (before deploy)

- root `npx tsc --noEmit` -> exit 0
- root `npm run build` -> exit 0 ("✓ built in 4.77s")
- `server/` `npx tsc --noEmit` -> exit 0
- `server/` `npm test` -> exit 0, 69 pass / 0 fail

## Deploy

- `make deploy` -> exit 0 · `make up` -> exit 0
  - `signal_scan-api-1 Up` · `signal_scan-web-1 Up 0.0.0.0:8124->80/tcp`
  - `HTTP 200 — web localhost:8124` · `/api/health {"healthy":true}`

## Prod verification

```
/api/tokens/sol/So1111...1112/detail                -> 404 {"error":"not found"}
/api/tokens/sol/So1111...1112/balance-chart?window=day -> 404 {"error":"not found"}
signals -> 200
/api/settings -> {"values":{...},"defaults":{...},"debug":{"allFactors":false}}
```

FE bundle shipped (nginx html assets): `grep -c 'balance-chart' *.js` -> **0**
(old "Bấm để xem chi tiết phân phối" tooltip also gone).

Note: an earlier attempt used a shell `for p in ...; do curl "$p"` loop whose `$p` did not
expand through the nested ssh quoting, producing a misleading `200`. Re-ran via python
urllib — result above is the authoritative one.
