---
slug: fomo-user-watch
status: planned
intent: clear
review_required: false
pending-action: fold metis findings, run momus review on .omo/plans/fomo-user-watch.md, then handoff
approach: Mirror the existing wallet-watch pipeline for FOMO users on instance b only - one Python firehose watcher (watchers/fomo/) on wss://api.fomoapi.io/ws/alerts matched locally against a fomo_users watch list entered in the UI like wallets, POSTed to a new ADMIN_SERVICE route /api/fomo-watch/trades, stored in fomo_trades (unique on FOMO eventId), surfaced by a fomoUserStatsByCa() mirror of trackedWalletStatsByCa() into TokenSignal, and rendered as ONE new column in SignalTable.tsx gated by a new build flag VITE_SHOW_FOMO (on for instance b, off for a + local dev).
---

# Draft: fomo-user-watch

## Components (topology ledger)
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

| id | outcome | status | evidence |
|---|---|---|---|
| C1 fomo_users watch list | server table + CRUD/import routes + FE input UI mirroring Wallets tab (manual add + CSV) | active | server/src/db.ts, src/components/WalletsPage.tsx, src/services/dataStore.ts |
| C2 watchers/fomo daemon | single WS firehose socket, local match vs watch list, dedupe, emit, state/heartbeat | active | watchers/common/{config,emit,state}.py, watchers/sol/feed.py |
| C3 fomo ingest route | POST /api/fomo-watch/trades (ADMIN_SERVICE) -> fomo_trades, unique on eventId, FK ON DELETE CASCADE | active | server/src/api.ts parseWatchTradeBody, server/src/auth.ts ROUTE_POLICY |
| C4 signal plumbing | fomoUserStatsByCa(now) -> TokenSignal.fomoUsers + fomoInflow, same window as Tracked by | active | server/src/signals.ts:140-217,454-467 |
| C5 FE column + flag | one new column in SignalTable (header + inline rows + modal), gated by VITE_SHOW_FOMO | active | src/config.ts, Dockerfile:10-14, Makefile:62, src/components/SignalTable.tsx:~322 |
| C6 list discovery to ~2000 | walker over leaderboards + /v2/users/{handle}/following to grow the seed list from ~150-330 to ~2000 | deferred (Q3: user supplies the list via UI/CSV) | fomo/*.csv already holds handle,userId,walletSolana,walletEvm -> imports as-is |
| C7 firehose retention/prune | prune job for stored FOMO alerts | dropped (Q1: only watched users are stored; fomo_trades follows wallet_trades, which has no prune job) | server/src/db.ts wallet_trades |

## Open assumptions (announced defaults)
<!-- assumption | adopted default | rationale | reversible? -->

| assumption | adopted default | rationale | reversible |
|---|---|---|---|
| how the watch list is entered | manual add + CSV import/export, exactly like Wallets (`handle,userId?,name?,clan?,walletSolana?,walletEvm?`) | user said "input tren giao dien nhu wallet"; wallets already has import/export + skip-with-reason preview | yes |
| activity window for the new column | same window constant the Tracked by column uses | one behaviour to reason about; no new tuning knob | yes |
| chain handling | match on FOMO `chain`/`chainId` -> existing Chain union (sol/base/bsc); other chains stored, not surfaced | signals table is chain-scoped today | yes |
| column is display-only | display-only; does NOT feed the X/3 score or tier gates | confirmed by user at fork Q2 | yes |
| instance scope | instance b only; instance a and local dev unchanged | user: "chi B dash nay danh rieng cho data FOMO" | no (confirmed) |
| watcher runtime | Python daemon on the host, `--api-url http://127.0.0.1:8125`; no docker-compose service, no new systemd unit file in repo | every existing watcher is a host Python daemon; server/package.json has no WS client dep | yes |
| API key placement | env/secret only (`FOMO_API_KEY` in server/watcher env, never committed, never logged); key pasted in chat must be rotated | secret-leak guard; rsync already excludes /keys | no |

## Findings (cited - path:lines)

FOMO API (docs https://fomoapi.io/docs + live keyless `/v1`, `/health`):
- Stream: `wss://api.fomoapi.io/ws/alerts?key=YOUR_API_KEY`. It is the APP feed and `/v1` states it carries **LARGE trades only** - not every trade by every user. A watched user's small trades will never appear.
- Free tier: 250,000 credits/month; realtime for 7 days, then delayed ~15s.
- `/v2/alerts` backfill = 125 credits/call. `/v2/users/{handle}` = 2500 credits on hit, 250 on miss -> bulk-resolving 2000 handles is unaffordable (up to 5M credits).
- Alert payload carries stable `eventId`, `userId`, `trader`, `token`, `tokenAddress`, `chainId`, `chain`, `usdValue`, `ts`. Feed alerts may lack tx hash and price/quantity -> dedupe on `eventId`, not on `(user,ca,tx,side)` like wallet_trades.

Repo - instance b wiring:
- `Makefile:10,62` - `INSTANCE=b`, port 8125, data dir `./data-b`, `TITLE ?= fomo`, `SHOW_CLAN=on`.
- `src/config.ts` - `SHOW_CLAN = import.meta.env.VITE_SHOW_CLAN === 'on'`; build-time baked, "instance a and local dev leave it unset, so the Clan column and fields are omitted entirely".
- `Dockerfile:10-14` - `ARG VITE_SHOW_CLAN` / `ARG VITE_TITLE` -> ENV. A `VITE_SHOW_FOMO` flag follows this pattern exactly.

Repo - Tracked by pipeline (the thing to mirror):
- `server/src/signals.ts:34` `TrackedWalletStat`; `:140` `trackedWalletStats(ca, chain, now)`; `:187` `trackedWalletStatsByCa(now)` -> Map keyed `${chain}:${address}`; `:213-217` stat build; `:454-467` assembly into TokenSignal (`trackedWallets`, `trackedInflow`, `trackedActivityAt`).
- `src/types.ts` `TrackedWalletStat = { name, clan?, tags?, inflow, buys, sells, balUsd?, lastTs }` - the shape a FOMO-user stat should mirror (minus balUsd, which FOMO alerts do not provide).
- `src/components/SignalTable.tsx:~36` `WALLET_COLS` (SHOW_CLAN-conditional widths); `:~322` `<Th>Tracked by</Th>` with a sub-grid header (Wallet/Clan/Bal/TXs/Inflow/Age); modal breakdown rows ~:769.

Repo - ingest/auth/db conventions:
- `watchers/common/emit.py` `watch_trade_body()` / `post_trade()`; `watchers/common/config.py` `_api_url` + `api_headers()` (service token); `watchers/common/state.py` watermark/heartbeat.
- `watchers/sol/feed.py` - lazy `websockets` import + WS reconnect loop (the FOMO socket template).
- `server/src/api.ts` - `parseWatchTradeBody` + `POST /api/wallet-watch/trades`; that route resolves a row in `wallets`, so it **cannot** be reused as-is for FOMO users (a FOMO user is not a wallet).
- `server/src/auth.ts` - `ROUTE_POLICY` roles `ADMIN_SERVICE` / `ADMIN_ONLY` / `ALL_ROLES`, fail-closed.
- `server/src/db.ts` - `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE` + rebuild/rename migrations; `wallet_trades` UNIQUE(wallet_id, ca, chain, tx, side), FK wallets ON DELETE CASCADE; `importWallets` for CSV bulk upsert.
- `server/test/wallet-watch-trade.test.ts` - node:test + `createApp` deps + `SERVICE_TOKEN`; the test template.
- No systemd unit committed for watchers; they run on the host. Python tests live in `scripts/test_*.py`. Evidence convention: `evidence/YYYY-MM-DD-*.md|png`. `keys/helius-keys.txt` exists and rsync excludes `/keys`.

Repo - existing FOMO groundwork in `fomo/` (1.4MB, already pulled):
- `leaderboard_{24h,7d,30d,all}.{json,csv}` - 150 traders per window; CSV header includes `rank,handle,displayName,clanId,clanName,clanRole,pnlUsd,volumeUsd,trades,followers,following,walletSolana,walletEvm,twitter,...`.
- `fomo_clans_{24h,all}.{json,csv}` - 29 CSV rows: `clanId,clanName,clanMemberCount,handle,...,walletSolana,walletEvm`.
- `itsalita_profile.json` (handle, displayName, avatar, userId, wallets, pnlUsd), `itsalita_following.csv` 160 rows (header includes `handle,displayName,userId,clanId,walletSolana,walletEvm`), `itsalita_followers.csv` 15 rows.
- `lf-candidates.json` is a JSON-encoded array of `[id8, count, usd...]` - token/CA candidates, **not** a user list.
- Net: only ~150-330 unique handles exist locally, NOT 2000. Growing to ~2000 requires more `/following` walks (250 credits/call, <=200 names/call -> ~10-15 seeds = ~2,500-3,750 credits, cheap). The CSVs already carry `userId`, so seeding avoids the expensive `/v2/users/{handle}` resolve.

## Decisions (with rationale)

- D1 One firehose socket + local match by `userId`/`handle`. Rationale: 2000 sockets is impossible and the API has no per-user stream; local match is free.
- D2 Never bulk-call `/v2/users/{handle}`. Rationale: 2500/250 credits x 2000 blows the 250k/mo free budget. Seed `userId` from the existing `fomo/*.csv` files and learn the rest from the stream.
- D3 Dedupe key = FOMO `eventId`. Rationale: stable, provided by the feed, and the feed may omit tx hash - `(user,ca,tx,side)` would collapse or duplicate.
- D4 Consumer stays in Python under `watchers/fomo/`. Rationale: matches every existing watcher; server/package.json has no WS client dependency, adding one would be new surface.
- D5 Route roles: `POST /api/fomo-watch/trades` = ADMIN_SERVICE; watch-list reads = ALL_ROLES; watch-list mutations = admin. Rationale: mirrors wallet-watch roles exactly, fail-closed.
- D6 New build flag `VITE_SHOW_FOMO`, not reusing `VITE_SHOW_CLAN`. Rationale: different feature, different lifecycle; reusing SHOW_CLAN would couple the clan column to FOMO forever. Same mechanism (Dockerfile ARG + Makefile + src/config.ts) so instance a/local dev omit the column entirely.
- D7 FOMO stats computed by a mirror of `trackedWalletStatsByCa` using the same activity window. Rationale: one mental model for both columns; no new tunable.
- D8 `FOMO_API_KEY` lives in env/secret only; the key already pasted into chat is treated as exposed and must be rotated. Rationale: secret-leak guard; `keys/` is already rsync-excluded.
- D9 (Q1) Store ONLY alerts whose `userId`/`handle` is in `fomo_users`; the socket still consumes the full firehose but non-matching alerts are dropped before insert. Rationale: dash B stays lean, no retention job, column behaves identically; user confirmed.
- D10 (Q2) The new column is display-only - a mirror of Tracked by without `Bal` (FOMO alerts carry no balance): handle, buys/sells, inflow USD, age of newest trade. It never touches scoring, tiers or gates. Rationale: request was "them cot thoi"; user confirmed.
- D11 (Q3) No discovery walker. The user supplies the watch list through the UI/CSV; the existing `fomo/*.csv` files (which already carry `userId`) import as-is, so no `/v2/users/{handle}` resolve cost is incurred. Rationale: user confirmed; keeps credits and scope minimal.

## Scope IN
- `fomo_users` table + CRUD/CSV import/export on the server, exposed through `DataStore` (rest + local implementations).
- FE input surface for the FOMO watch list mirroring the Wallets tab (add, CSV import with skip-with-reason preview, export), instance-b only.
- `watchers/fomo/` daemon: WS connect/reconnect, local watch-list match, eventId dedupe, batched POST, state/heartbeat, `--api-url` default `http://127.0.0.1:8125`.
- `fomo_trades` table + `POST /api/fomo-watch/trades` + parse/validate, dedupe on eventId, cascade delete with `fomo_users`.
- `fomoUserStatsByCa()` -> `TokenSignal.fomoUsers` (+ inflow/lastTs) and ONE new column in `SignalTable.tsx` (header, inline rows, modal) behind `VITE_SHOW_FOMO`.
- Tests: server endpoint test mirroring `wallet-watch-trade.test.ts`; watcher self-check mirroring `scripts/test_wallet_watch.py`; typecheck/build.
- Runbook doc (`docs/YYYY-MM-DD-fomo-user-watch.md`) + evidence artifact under `evidence/`.

## Scope OUT (Must NOT have)
- Any change to instance a behaviour, its build flags, or its data dir.
- Per-user FOMO sockets, or any `/v2/users/{handle}` bulk resolution.
- Wallet-address-based matching as the primary key (FOMO identity is userId/handle; wallets are a side attribute).
- Backfilling history via `/v2/alerts` (125 credits/call) unless the user asks for it later.
- New scoring/tier logic, new tunables, or a separate FOMO page/panel - the request is "them cot thoi".
- New npm runtime dependency for WebSockets in the server.
- Committing the FOMO API key anywhere (repo, docs, logs, evidence).
- Storing alerts from users outside the watch list, and any retention/prune job (Q1 -> watched users only, C7 dropped).
- A walker/discovery tool to grow the list toward ~2000 handles (Q3 -> user supplies the list; `fomo/*.csv` imports only after BOM-strip + header mapping - see the correction in the revision section).
- Any scoring, tier or gate change driven by FOMO activity (Q2 -> display-only).

## Open questions
None outstanding. All three forks answered by the owner:
- Q1 (data shape) -> store ONLY watched users' alerts. Firehose is consumed in full but non-matching alerts are dropped before insert; no retention/prune job. Recorded as D9.
- Q2 (product) -> display-only column mirroring Tracked by without `Bal`; no effect on X/3 score, tiers or gates. Recorded as D10.
- Q3 (scope) -> no discovery walker; the owner supplies the list via UI/CSV. NOTE (corrected after measurement): the CSVs do NOT import "as-is" - only `itsalita_following.csv`/`itsalita_followers.csv` carry `userId`; `leaderboard_24h.csv` and `fomo_clans_24h.csv` have no `userId` column at all, all four carry a UTF-8 BOM, and their headers are `displayName`/`clanName` (not `name`/`clan`). 310 unique handles vs 173 unique userIds. Import needs BOM-strip + header mapping. Recorded as D11 (amended).

Still to verify during execution (not blocking approval): the precise insertion points in `SignalTable.tsx` for the header/inline/modal and the exact count-sites that must be bumped (`colCount` :564, skeleton :436, `colSpan` :672, `min-w-[1928px]` :432/:660). The window question is SETTLED: the FOMO column reuses the existing 24h stats literal (`now - 86_400_000`), NOT `TRACKED_BY_WINDOW_MS` (7 days, a different job). The mount question is SETTLED: a sibling surface inside the same tab container `WalletsPage` uses, gated by `SHOW_FOMO` - not a forked page.

## Approval gate
status: approved
- 2026-09-29: user replied "oke" after the brief - approval granted. Plan written to `.omo/plans/fomo-user-watch.md` (now 220 lines / 60,072 bytes after the revision below: 11 implementation todos `- [ ] 1..11.` + 4 final-verifier rows `- [ ] F1..F4.`). Structural self-check passed: first `##` heading is `## TL;DR (For humans)`, header order matches the template (`## Scope` carries the captured-schema subsection), all task rows column-zero, tasks appear only under `## Todos` / `## Final verification wave`, zero unfilled placeholders.
- Review state: Metis gap analysis RAN and is FOLDED IN (18 findings: 3 blocker / 7 major / 8 minor - see the revision section below). A keyless live capture then replaced the reviewer's unknowns with measured facts. Momus review is running now against the revised plan. `review_required: false`, so the dual high-accuracy review is offered to the user, not assumed.
- Approval authorizes the PLAN ONLY. No implementation, no implementer subagents. Execution starts only when the user explicitly starts a worker session (e.g. `$start-work`).
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

## Revision after review (2026-09-29) - what changed in the plan and why

Two things happened after the plan was first written: (1) the Metis gap analysis landed, and (2) a KEYLESS live capture of the real FOMO socket replaced every remaining unknown with a measured fact. Both are folded into the plan; the plan is now 220 lines / 60,072 bytes.

### 1. Empirical capture (free, 0 credits, ~60s-delayed keyless tier)
- Connected ONCE to `wss://api.fomoapi.io/ws/alerts` with no key; captured 109 messages / 102 alerts / 68,562 bytes in a 115s window.
- Raw evidence: `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl`. Probe script: `.omo/scripts/fomo-probe.mjs` (planning tooling, not product code).
- **Resolved a BLOCKER**: the alert DOES carry the handle - the field is `trader` (102/102 present). So the ~178 CSV rows with no `userId` are still matchable; the reviewer's "handle may not exist in the payload" concern is closed.
- The buy/sell discriminator is **`alertType`**, NOT `type` (`type` is always the literal `"alert"`). Measured: buy 36 / sell 41 / perp 12 / thesis 13.
- `usdValue` is NOT one currency: for a buy it byte-equals `positionValueUsd` (post-fill SIZE); for a sell it byte-equals `realizedPnlUsd` (signed PnL); perp has none (0/12); thesis has none (1/13). => summing buy−sell over it is a category error.
- `tokenAddress` present 90/102 - the 12 nulls are exactly the 12 perp rows.
- `chain` = {solana, robinhood, ethereum, hyperliquid, bsc, base}; `chainId` = {1399811149, 4663, 1, 1337, 56, 8453}. Only sol/base/bsc are in this repo's `Chain` union.
- `eventId` unique 102/102. `txHash`/`execTs`/`execLagMs`/`tradeUsd` only on 17/102. `ts` = epoch ms. `replay:true` on 97/102 (delayed tier). Envelope `type` ∈ {welcome, alert, heartbeat} plus bare `ping`/`pong`.
- Load ~0.9 alerts/s - one socket + local match is trivial.

### 2. Metis findings folded (18 total: 3 blocker / 7 major / 8 minor)
- BLOCKERS: (F1) the net-inflow mirror was built on a false `usdValue` premise; (F2) the `type`/perp/thesis filter was missing and the "no per-user stream" rationale was contradicted by the docs; (F3) most local handles have no `userId` and draft asserted they did.
- MAJORS: (F4) the Tracked-by window/membership rule was ambiguous and the draft pointed at the 7-day `TRACKED_BY_WINDOW_MS`; (F5) `docker-compose.yml` was missing from the flag chain and "instance a untouched" was unsatisfiable; (F6) `watchers/` is NOT shipped by `make deploy`; (F7) a naive daemon would reuse the shared heartbeat/state path and mask the sol watcher; (F8) the `fomo/` CSVs do not match the proposed import schema (BOM, `displayName`/`clanName`, no `userId` in 2 files, and 2 claimed files don't exist); (F9) the SignalTable column count-sites were not enumerated; (F10) reconnect/backfill was unstated; (M6) the additive `TokenSignal.fomoUsers` field contradicts a "byte-identical instance a" promise.
- MINORS: auth-routes test already covered; refresh cadence unpinned; batched-POST contradicted a single-object route; 404-vs-200 on an unknown user; chain mapping + `canonicalCa` normalisation unstated; `ts`/key-masking/15s-delay details; scope-creep guards + completeness-claim ban; plus an implicit "never write FOMO into `wallet_trades`" constraint made explicit.

### 3. Plan changes applied
- Added a `### Captured FOMO alert schema` subsection under `## Scope` (measured ground truth; the executor no longer guesses field names).
- Todo 1: replaced nullable `side` + `amount_usd` with `type TEXT NOT NULL CHECK(type IN ('buy','sell'))` + `usd_value` (meaning documented as per-type); `ca` must be canonicalised.
- Todo 6: parser now validates `alertType`/`trader`/`tokenAddress`, rejects perp/thesis with 400, maps/validates chain, canonicalises `ca`, treats 404 as "refresh the list", and is explicitly ONE trade per request (no batch endpoint).
- Todo 7: `inflow` renamed to `buyUsd` and computed BUY-ONLY; membership redefined as EVER had a `type='buy'` row (mirroring Tracked by), plus a user with only sells must NOT be listed.
- Todo 4: CSV parser must strip the BOM and map `displayName→name`, `clanName→clan`, with `userId` optional; only 4 files exist.
- Todo 8: added an "unresolved (no userId)" marker and settled the mount (sibling surface in the same tab container).
- Todo 9: enumerated every count-site (`colCount` :564, skeleton :436, `colSpan` :672, `min-w` :432/:660) + own `FOMO_COLS` + own popup state.
- Todo 10: consumes the existing capture (no re-capture), pins the chain map, the FOMO-specific state/heartbeat filenames, the ~300s refresh, per-alert POST, 404→refresh, no backfill, no key/URL logging.
- Todo 11: fixed the `fomo/` inventory, added the missing watchers deployment story (`scp`/`rsync` + `websockets` + the instance-b service token).
- Scope guardrails: "instance a byte-identical" reworded to "behaviour unchanged; one additive always-empty `fomoUsers` field allowed"; explicit bans on `wallet_trades` reuse, on a net/PnL figure, and on completeness claims in UI copy.
- F2/F4 verifiers + success criteria updated to the new semantics.
