# FOMO watch-list tags — evidence (2026-10-02)

Feature: add `tags[]` to the FOMO watch list with full parity to wallets
(display chips + `Unicon` → rainbow name), per user request
"phần FOMO watch list thêm cho thôi phần tag, có support tag Unicon như wallet".

## Change surface

### Server
- `server/src/db.ts`
  - DDL `fomo_users`: `tags TEXT NOT NULL DEFAULT '[]'` (after `clan`).
  - Migration: `table_info(fomo_users)` + `ALTER TABLE fomo_users ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`
    (house idiom, cf. `fomo_trades.trade_usd`, `wallets.clan`).
  - `FomoUserRow.tags: string` (JSON) / `FomoUserInput.tags?: string[]`.
  - `insertFomoUser` / `updateFomoUser` JSON-encode.
  - `importFomoUsers`: upsert `tags = CASE WHEN excluded.tags <> '[]' THEN excluded.tags ELSE fomo_users.tags END`
    → a re-import without tags never blanks stored tags.
- `server/src/api.ts`
  - `FomoUserJson.tags: string[]` (always present, default `[]`); `toFomoUser` decodes `row.tags`.
  - `parseFomoUserBody` / `parseFomoImportRows` read `tagsField(b)`.
  - `parseFomoUserPatch`: non-array `tags` → `400 {error:'tags must be an array of strings'}`.
- `server/src/signals.ts`
  - `FomoUserStat.tags?: string[]`; both `fomoUserStats` and `fomoUserStatsByCa` select `u.tags AS tags`
    and reuse the existing `parseTags`. Key emitted **only when non-empty** → JSON stays byte-stable for untagged users.

### Frontend
- `src/types.ts`: `FomoUser.tags: string[]` (required) + `FomoUserStat.tags?: string[]`.
- `src/services/dataStore.ts`: `parseFomoUsersCsv` reads a `tags` column, split on `;`.
- `src/components/FomoUsersPage.tsx`: Tags column with inline add/remove chips (admin, mirrors `WalletsPage`),
  rainbow name via `walletNameClass(u.tags)`; CSV export header `handle,name,tags,clan,userId,walletSolana,walletEvm`;
  import preview shows tags. Modal unchanged (tags edited inline, parity with wallets).
- `src/components/SignalTable.tsx`: `FomoTable` handle gets `walletNameClass(u.tags)`.

## Verification

| Command | Result |
|---|---|
| `cd server && npx tsc --noEmit` | exit 0 |
| `cd server && npm test` | `tests 583 / pass 583 / fail 0` (was 578; +5) |
| `npx tsc --noEmit` (repo root, FE) | exit 0 |
| `npm run build` (FE, tsc + vite) | exit 0, `dist/` built |

New tests: API tags round-trip/replace/400 (`fomo-users.test.ts`), import enrich-no-blank (API + db),
DB insert/update/import (`fomo-db.test.ts`), stats surface + key order (`fomo-signals.test.ts`).

## Post-deploy verification (2026-10-02, user confirmed "deploy đi")

Deployed via `make deploy INSTANCE=a && make up INSTANCE=a`, then `INSTANCE=b` (builds both `web` + `api`).
- a: `signal_scan-web-1` + `signal_scan-api-1` up, `GET localhost:8124/` HTTP 200, `/api/health` `healthy:true`.
- b: `signal_scan_b-web-1` (0.0.0.0:8125) + `signal_scan_b-api-1` up, `GET localhost:8125/` HTTP 200, `/api/health` `healthy:true`.

Live E2E on **b** (FOMO instance):
- Migration applied: `PRAGMA table_info(fomo_users)` → `...,created_at,tags`; 275 rows; 0 rows with NULL/empty tags.
- `GET /api/fomo-users` (service token) → every DTO carries `"tags":[]`.
- Byte-stability: untagged members in `GET /api/signals` have **no** `tags` key.
- Round-trip (controlled write + revert): set `frankdegods` tags to `["Unicon"]` → `GET /api/signals` returned
  `tags:["Unicon"]` on ALL his member CAs (bsc/sol/robinhood/base); reverted to `[]`. Prod left clean.
- Admin PATCH via API returns 403 for the service token as expected (admin = Firebase Google JWT; write path
  covered by the 583/583 unit tests, incl. `tags must be an array of strings` → 400).

Not E2E'd: the visual rainbow render in the browser (requires a Firebase-authenticated session); `walletNameClass`
shipped in the rebuilt `web` bundle and is the same tested path used by `WalletsPage`.

EVIDENCE_RECORDED: docs/2026-10-02-fomo-tags-evidence.md

