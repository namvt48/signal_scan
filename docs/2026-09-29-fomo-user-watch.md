# FOMO user watch - runbook (2026-09-29)

> **Superseded 2026-10-22:** the paid `api.fomoapi.io` WebSocket/key was removed.
> The watcher now polls `/v2/users/{userId}/swaps` through the local prod bridge
> (`server/fomo-prod`, `FOMO_PROD_URL`), and instance B reads holdings from `/balances`
> through the same bridge. `FOMO_API_KEY` is no longer used. Prod requires a UUID,
> so the poller skips watch-list rows that only have a handle (`skipped N without
> userId`). The historical capture and
> alert-shape notes below still describe server idempotency, but socket sections are
> retired; see `docs/2026-10-20-fomo-prod-api.md` for the bridge.

**Feature:** a FOMO copy of the wallet-watch feature on instance "fomo" (dashboard b).
You keep a list of FOMO traders you watch, one background daemon follows FOMO's live
trade stream and records only the trades made by those traders, and one new column on
the signals table (`FOMO by`) shows which watched traders hit each coin.

**Instance:** b only. The UI and the column render only when the build flag
`SHOW_FOMO` is on. `make deploy INSTANCE=b` sets `VITE_SHOW_FOMO=on` (Makefile:64),
and instance a / local dev leave it unset, so the code paths are absent from their
build, not merely hidden.

**Ground truth:** the FOMO alert shape is measured, not guessed - a keyless capture of
102 real alerts lives at `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl`
(summary: `.omo/evidence/fomo-user-watch/task-0-capture-summary.md`). Every field name
below is pinned from that capture.

**Design rule:** the column is DISPLAY-ONLY. FOMO data never moves the score, a tier,
or a gate, and it never touches `wallet_trades`, `wallet_token_state`, or any wallet
accessor.

---

## 0. Coverage limit - read this before trusting any number

The polling watcher keeps a per-user wall-clock window that starts at the previous
successful poll (the deploy time on the first run, or first sight for a user added
later). A poll pages back only to that bound, so an inactive user costs one page and
history is never replayed. Every fill in the window is emitted by the same walk. Fills older
than the window are not fetched, so the `FOMO by`
column is inherently a partial view. FOMO's own documentation says, and this repo repeats it in
the column tooltip:

> do not compute market share, trade counts, or volume from it

The configured `FOMO_POLL_INTERVAL_S` is the target cycle start-to-start interval
(production: 300 seconds). User swaps are fetched sequentially in worker threads,
so the asyncio heartbeat continues during network I/O. Sweeps never overlap; if one
takes longer than the target interval, the next begins immediately after it finishes.

Do not read the `FOMO by` counts as platform-wide activity, and do not sum them into a
market share or a volume figure. The column answers one narrow question: "did a trader
on our watch list take a large position in this coin recently, and how big was it".

The dashboard's aggregate `Tracked Holding` is unknown (`—`) until at least one
FOMO user's holding percentage has been measured. Missing measurements are not
treated as zero; a measured zero remains `0%`. On instance B, holdings come from
fresh balance/position snapshots or wallet-based measurements, not from alert fields.
If a balance snapshot has an amount but no percentage, the backend derives the share
only when a positive token supply is known; otherwise it remains unknown.


---

## 1. Putting traders on the watch list

Two ways in, both on instance b's Tokens/Wallets screen behind `SHOW_FOMO`.

**Manual add.** A FOMO watch-list surface sits as a sibling of the Wallets tab (same
tab container, no separate page/route). Add a row with `handle` (required) and
`name`, `clan`, `userId`, `walletSolana`, `walletEvm` (optional). A row with no
`userId` is flagged "unresolved (no userId)": it still matches, but only by the
`trader` handle, which is weaker than an exact `userId` match. Most imported rows are
handle-only (see section 2).

**CSV import/export.** Export writes this exact header:

```
handle,name,clan,userId,walletSolana,walletEvm
```

Import uses the same header. A malformed row, or a row with an empty handle, is
skipped and shown with a reason in the preview before anything is committed - the same
skip-with-reason behaviour the wallet importer has. The parser strips a leading UTF-8
BOM (see section 2).

---

## 2. Importing the pre-pulled data in `fomo/`

The repo already contains FOMO data pulled earlier. Only these files matter, and their
headers differ from the export header, so import maps them:

| File | Rows | Header (first cells) | Carries `userId`? |
|---|---|---|---|
| `fomo/leaderboard_24h.csv` / `.json` | 150 | `rank,handle,displayName,clanId,clanName,...` | NO |
| `fomo/fomo_clans_24h.csv` / `.json` | 28 | `clanId,clanName,clanMemberCount,handle,displayName,...` | NO |
| `fomo/itsalita_following.csv` | 159 | `handle,displayName,userId,...` | YES |
| `fomo/itsalita_followers.csv` | 14 | `handle,displayName,userId,...` | YES |

- `displayName` maps to `name`, `clanName` maps to `clan`. `userId` is optional and
  absent from the two leaderboard/clan files entirely.
- **Every one of these CSVs carries a UTF-8 BOM**, so byte 0 is `EF BB BF` and the
  first header cell literally reads `\ufeffrank` / `\ufeffclanId` / `\ufeffhandle`.
  The app strips the BOM before parsing, so a plain `csv.DictReader` on the raw file
  without `encoding='utf-8-sig'` would produce a broken first column.
- The four files together hold **310 unique handles but only 173 unique userIds** -
  roughly half the list can only be matched by handle. That is expected; handle
  matching works because the alert always carries `trader`.
- Import the CSV as-is through the UI. Do not use `leaderboard_7d/30d/all` or
  `fomo_clans_all` - the app was not coded against them and they are not the supported
  inputs.

---

## 3. Alert field to `fomo_trades` mapping

Source of truth: `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl` (102 alerts,
109 messages, 115s). The daemon (`watchers/fomo/feed.py`) and the ingest route
(`POST /api/fomo-watch/trades`) use exactly this mapping.

| FOMO alert field | Stored as | Notes |
|---|---|---|
| `alertType` | `type` (`buy`\|`sell`) | **The buy/sell discriminator is `alertType`, NOT `type`.** Top-level `type` is always the literal `"alert"`. Measured: buy 36, sell 41, perp 12, thesis 13. perp/thesis are dropped before insert. |
| `trader` | watch-list match | The handle, present on 102/102, so handle matching works. `userId` matches first when the watch row has one. |
| `userId` | watch-list match | Present 102/102. |
| `eventId` | `event_id` | Unique on 102/102; the dedupe key (section 4). |
| `tokenAddress` | `ca` (canonicalised) | The contract address. Null on the 12 `perp` rows; a missing one on a buy/sell is dropped. |
| `chain` | `chain` | Mapped (section 4). |
| `ts` | `ts` | Epoch milliseconds. |
| `usdValue` | `usd_value` | **Type-dependent money field - see below.** |
| `token` | `token` | The ticker symbol (e.g. `STOCKER`). |
| `price` | `price` | Optional; NOT present anywhere in the captured sample, so it is always NULL in practice today. |
| `text` | not stored | A pre-rendered human string ("kangshifu bought $STOCKER ($3K size)"); log lines only, never parsed. |
| `txHash`, `tradeUsd`, `tradeUsdSource`, `execTs`, `execLagMs` | not stored | On-chain-confirmation fields; present in only 17 of 102 sample rows. A periodic miss is normal - never require `txHash`. |

### The money field, precisely

`usdValue` is **not one currency across directions**:

- On a **BUY**, `usdValue` is byte-equal to `positionValueUsd` (verified 36/36). It is
  the **post-fill POSITION VALUE in USD**, not that trade's size.
- On a **SELL**, `usdValue` is byte-equal to `realizedPnlUsd` (verified 41/41). It is
  the **signed realised PnL**, not sale proceeds.
- On `perp` (0/12) and `thesis` (1/13), there is no meaningful money field.

The actual trade size is `tradeUsd` (with `tradeUsdSource`), and it appears in only 17
of 102 sample rows, so it cannot be the column's basis.

**There is no token amount and no price in the payload.** Do not expect a quantity.

Therefore the column's `Buy $` is documented as the **SUM of BUY `usdValue` over the
last 24h**, i.e. a sum of post-fill position values. It is **not** trade size, **not**
net inflow, and **not** profit/PnL. Adding a buy's `usdValue` to a sell's `usdValue` is
a category error and is banned in the code: `buyUsd` is computed with
`SUM(CASE WHEN type='buy' THEN usd_value END)` and nothing else.

`Sell PnL` is a **separate** figure: the SUM of SELL `usdValue` over the last 24h, i.e.
the sum of **signed realised PnL** (it may be negative). It is reported alongside
`Buy $` and is **never** combined with it - there is no net/inflow number anywhere in
the column or the API.

`fomoUserStat` shape (mirrored on both sides): `handle`, optional `name`/`clan`,
`buyUsd`, `sellPnlUsd`, `buys`, `sells`, `trades`, `lastTs`. Membership is "ever had a
`type='buy'` row for this (ca, chain)" - a trader with only sells for that coin does
not appear, and a trader whose newest buy is older than 24h still appears with zero
24h stats.

---

## 4. Chain map and dedupe

**Chain map.** The shared `Chain` union is `sol | base | bsc | robinhood`
(`server/src/shared/chain.ts`, mirrored in `src/types.ts`), but this daemon accepts
only Base, BSC, and Robinhood alerts:

```
base      -> base
bsc       -> bsc
robinhood -> robinhood
```

Solana alerts are dropped by the daemon before any ingest POST. The FOMO instance also
rejects Solana events and CA/wallet writes at the API boundary, hides historical
Solana CA and wallet rows from dashboard lists, and deactivates previously active
Solana CAs at startup without deleting their trade history or shared market data.
`ethereum` (networkId 1) is supported as chain `eth`; `hyperliquid` and perp chainId `1337` are unsupported.


> **robinhood added 2026-10-01** (EVM, chainId 4663): the fomo dashboard now tracks
> robinhood CAs end-to-end. The gateway's `CHAIN_SLUGS` must carry `robinhood` too
> (`server/src/shared/chain-slugs.ts`), or every `gmgn/token-info` call for the chain
> is denied `400 bad_request` and the CA never leaves the dashboard's score filter.
>
> **Ethereum added 2026-10-23** (EVM, networkId/chainId 1): `eth` is in `CHAINS` and
> `CHAIN_SLUGS` (gmgn `eth`, nansen/dexscreener `ethereum`), and both FOMO API parsers
> map networkId 1. The bridge default `FOMO_SUPPORTED_CHAINS` already includes 1.

**Dedupe by `eventId`.** `fomo_trades` has a UNIQUE index on `event_id`, and the insert
is `INSERT INTO fomo_trades (...) ON CONFLICT(event_id) DO NOTHING`. Re-POSTing the same
event changes nothing: the second call returns 2xx and inserts zero rows. Reconnects and
replayed frames therefore cannot double-count. The daemon also keeps a bounded in-memory
seen-set and persists it in `fomo_state.json` so a restart does not re-POST.

Event ids share one namespace, `fomo-swap:<swap id>`. State written before the
cutover may hold `fomo-feed:<swap id>` or a bare swap id; `load_state()` rewrites
them, the ingest route canonicalizes a legacy `fomo-feed:` id, and a startup
migration rewrites stored `fomo_trades.event_id` values (dropping an existing
`fomo-swap:` twin of the same swap). Without that normalization the feed
re-reading its cursor item (`at == cursor`) or expanding a trade's older
`swaps[]` would insert an already-ingested fill under a second key.

---

## 5. Credits, tiers, and freshness

- **250,000 credits/month** on the free tier.
- **Realtime for 7 days**, then the stream is **delayed ~15s**.
- A frame with `replay: true` is just the **delayed tier**, not an error. 97 of 102
  sample rows were `replay:true` because the capture used the keyless delayed tier. The
  column is best-effort-fresh, not tick-accurate.
- Deliberately NOT used: `/v2/alerts` backfill (125 credits/call) and
  `/v2/users/{handle}` (2500 credits on hit). No gap backfill after a reconnect - the
  gap is accepted because the column is display-only.

---

## 6. Deploying the daemon (NOT handled by `make deploy`)

`make deploy` (Makefile:94) rsyncs **only** `server` and `src`:

```
rsync -azc --delete ... server src $(HOST):$(REMOTE_DIR)/
```

`watchers/` is not in that list, so **`make deploy` does not ship the FOMO daemon**.
You must copy the Python package to the host yourself. The daemon is a host process,
not a container - do **not** add a docker-compose service for it.

### 6.1 Copy the package to the host

The daemon imports `watchers.common`, so ship the whole `watchers/` tree (at minimum
`watchers/__init__.py`, `watchers/common/`, `watchers/fomo/`):

```bash
ssh root@194.163.187.250 'mkdir -p /opt/fomo-watch'
rsync -az --exclude __pycache__ watchers root@194.163.187.250:/opt/fomo-watch/
# or: scp -r watchers root@194.163.187.250:/opt/fomo-watch/
```

### 6.2 Install `websockets` on the host

Same dependency the `watchers/sol` daemon needs. Install it with the interpreter that
runs the daemon (the existing sol watcher's interpreter/venv):

```bash
ssh root@194.163.187.250 'pip3 install websockets'
```

If it is missing, the daemon exits immediately with:
`fomo watcher cần:  pip install websockets`.

### 6.3 Host environment (secrets)

The daemon reads two endpoints/values from the host environment:

- `FOMO_PROD_URL` - the local bridge (default `http://127.0.0.1:8131`), which owns the
  Privy token and Chrome TLS fingerprint. The daemon never holds a FOMO key.
- `SIGNAL_SCAN_SERVICE_TOKEN` - the instance-b service token. Both `GET /api/fomo-users`
  (the watch-list read) and `POST /api/fomo-watch/trades` (the ingest) require it; the
  daemon sends it as a `Bearer` header via `watchers/common/config.py`. Without it the
  daemon gets 401/403 and silently stops writing.

Keep them in a host-only env file, one `NAME=VALUE` assignment per line, chmod 600,
located on the server and never in the repo:

```
/opt/fomo-watch/fomo.env   (host-only secret file, chmod 600)
  FOMO_PROD_URL               - http://127.0.0.1:8131
  SIGNAL_SCAN_SERVICE_TOKEN   - instance-b service token
```

### 6.4 Run it under the host's existing service mechanism

No systemd unit is committed; the host runs the watchers (the sol watcher lives under
`/opt/wallet-watch/`). Run the FOMO daemon the same way - a host service whose
`ExecStart` is the module entrypoint, with the working directory at the package root and
the secret env file loaded:

```
WorkingDirectory=/opt/fomo-watch
EnvironmentFile=/opt/fomo-watch/fomo.env
ExecStart=/usr/bin/python3 -m watchers.fomo --api-url http://127.0.0.1:8125
```

Then enable/restart it exactly like the sol unit. `WATCH_HOME` can override where the
state file lands if the working directory is not the package root.

### 6.5 Daemon command (copy-pasteable)

Instance b's API is on port 8125, which is also the daemon's default:

```bash
python3 -m watchers.fomo --api-url http://127.0.0.1:8125
```

Self-check (runs one watch-list cycle, then exits):

```bash
python3 -m watchers.fomo --once --api-url http://127.0.0.1:8125
```

Every ~60 seconds the daemon refreshes the watch list from `GET /api/fomo-users`, asks
the bridge for each user's swaps pages back to that user's window start, maps buys/sells
against the quote-asset list, dedupes by swap id, and POSTs each survivor individually to
`/api/fomo-watch/trades`. The window starts at the user's previous successful poll; on a
fresh or migrated state it starts at the watcher deploy time, and a user first seen later
starts at first sight, so deploying the watcher does not replay history. Unlike the old
swap cursor, the wall-clock window advances even when the user made no trades, so an
inactive user costs one page. The window advances only after a complete read and ingest;
a failed GET/POST retries the same window next cycle. `/swaps` is mapped
chain-agnostically; captured responses have been Solana-only, so EVM normally
arrives via `/feed/token`. Both routes use the same `fomo-swap:<swap id>` event
id (a feed item's id is the swap id), so a fill seen on both is ingested once.
Every fill in the window is emitted
by the same walk, so no second per-CA crawl. GET and POST retry transient network errors and HTTP 429/500/502/503/504
up to three attempts total, with bounded exponential backoff (0.5s, 1s; numeric
`Retry-After` is capped at 2s). Other HTTP errors are not retried. A failed POST is not marked
deduped or persisted, so a replayed alert can be tried again; a successful POST is acknowledged
only after its response, and repeated attempts reuse `eventId` for server-side idempotency.
On a 404 from the ingest it treats the watch list as stale and refreshes it once without retrying
the stale POST.

---

## 7. Instance-b env wiring (where secrets live)

- Server secrets live in **`server/.env` ON THE SERVER**, created from
  `server/.env.example`. That file is never in the repo and `make deploy` never copies
  it (`rsync --exclude .env`).
- The rsync excludes `'/keys'` and `'/data*'`, so private keys and every DB dir
  (`data`, `data-b`) stay on the host and out of git.
- `MODE=gmgn` (a server-side setting, not FOMO) needs that server-side env file to
  exist; the default `MODE=mock` runs without it.
- The FOMO daemon's own settings (`FOMO_PROD_URL`, `SIGNAL_SCAN_SERVICE_TOKEN`) live in
  the host env / service drop-in described in 6.3, not in the repo.

---

## 8. Troubleshooting: daemon up but the column is empty

Work through these in order.

1. **Watch-list membership.** The daemon stores only traders that exist in the FOMO
   watch list. If the trader was never added (or their handle/userId differs from the
   stored row), their alerts are dropped by design. Confirm `GET /api/fomo-users` on
   instance b returns the row.
2. **The bridge.** Check `curl http://127.0.0.1:8131/health`. `ok:false` means the
   Privy access token expired and the bridge could not refresh; refresh the files in
   `data/fomo-prod-credentials/` and restart `fomo-prod`.
3. **Ingest 404s.** A line like
   `! ingest 404 (<handle>) - watch list stale, refresh` means the server has no
   matching `fomo_users` row for that handle/userId. Fix the watch list; the daemon
   refreshes itself on a 404 but will keep 404ing until the row exists.
4. **Cursor bootstrap.** A newly added user emits nothing until the next swap after
   its first poll; that is intentional, not a failure. The column is best-effort-fresh and, because the feed is large-trades-only,
   a watched trader can legitimately have no rows for a coin right now.

Also remember the by-design drops: a `perp`/`thesis`/`listing` alert, an alert with no
`tokenAddress`, an untracked trader, and any chain outside `base|bsc|robinhood` all produce
no row.

---

## 9. Security: rotate the exposed key before production

The FOMO API key that was pasted during planning is **EXPOSED**. It must be **rotated
before any production deploy**. Rotate it in the FOMO dashboard, put the new value only
in the host env file from 6.3, and never commit it, log it, or paste it into a doc,
an evidence file, or a chat. The socket carries the key in its query string, so always
keep the URL masked in logs (`?key=***`).

---

## 10. Evidence

The full artifact index for this feature (every captured command output, screenshot,
CSV, and the raw alert sample) is at:

- `evidence/2026-09-29-fomo-user-watch.md`

Raw alert sample: `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl`.

## 11. Amendment 2026-09-29 - two behaviour changes

Two changes were added after the original build (todos 12 and 13 in the plan); the
runbook above already reflects them.

**A newly inserted live/cursor BUY can enqueue or reactivate its CA.** The
`POST /api/fomo-watch/trades` body requires `provenance` (`live`, `cursor`, or
`historical`). The shared admission gate applies to all supported chains and
rejects future/pre-deployment events, BUYs outside the 48-hour activity window,
Pass-blocked CAs, and known entry sizes below the configured minimum. Unknown
entry size remains eligible.

Expanded historical trade-detail fills and bootstrap token-feed items carry
`historical`: they can persist in `fomo_trades`, but cannot add/reactivate a CA,
emit tracker-buy observations, or trigger holdings/position/market refreshes.
Per-user crawl windows and existing feed cursors carry `cursor`, preserving
legitimate catch-up after an outage. Duplicate event IDs remain no-ops.
This is tracked-CA state, not native wallet state: the FOMO route never writes
`wallet_trades` or invokes `kickWalletRow`. SELLs never admit CAs.

**`Sell PnL` - a separate realised-PnL figure.** Each FOMO user row now reports
`sellPnlUsd` (SUM of SELL `usd_value`, may be negative) in addition to `buyUsd`; the
two are never combined. Rendered signed (`text-pos`/`text-neg`) inside the nested
`FomoTable`, between `Buy $` and `Age`.

**Amendment 2026-10-08 - derive FOMO holding percentage from balance snapshots.**
The alert feed itself still has no wallet address or token amount, so it cannot
provide a holding. Instance B's `Tracked Holding` comes from separate fresh balance,
position, or wallet measurements. When a fresh API balance supplies an amount but
omits its percentage, the backend computes `amount / supply × 100` only for a known,
positive supply. Missing measurements remain unknown; a measured zero remains zero.

## 12. Timestamped WebSocket diagnostics

The FOMO watcher writes a private, rotating JSONL trace to
`/opt/fomo-watch/logs/fomo-ws.jsonl`. It records each application frame returned by
`ws.recv()` before parsing, including control payloads and frames later ignored, then
records the processing decision and each ingest HTTP attempt. WebSocket protocol-level
ping/pong frames are handled internally by the library and are not returned by `recv()`.
`frame_id` joins `frame_received`, `frame_decision`, `frame_state`, `ingest_attempt`,
and `ingest_failure` rows. Timestamps are ISO-8601 UTC with millisecond precision.
Text frames are retained as text; binary frames are losslessly base64-encoded.

Credential-like fields, configured service/API credentials, and credential query
parameters are redacted. The directory is mode `0700`; log files are mode `0600`.
The handler rolls over at 16 MiB per file and retains ten backups (about 176 MiB total
for normal-sized frames); one unusually large frame can exceed the rollover threshold.
Older rows are removed as backups rotate. The trace starts only after deployment and
does not recover earlier frames or trigger historical API queries.

If directory setup, write, rotation, or shutdown I/O fails, the watcher emits one
bounded stderr warning, disables the JSONL sink for the current process, and continues
processing alerts. Diagnostics resume after the next service restart.

Deploy only the watcher with `make fomo-watch-deploy`. The target checks instance B's
health, installs the private log directory, compiles the watcher remotely, and restarts
`fomo-watch.service`; it does not rebuild or restart either dashboard.

## 13. Market-cap history chart and dashboard timezone

The MC cell opens the same interactive history-chart treatment used by Fresh Wallet
on both instance builds. It records at most 96 samples per CA from existing market
data writes; opening the chart makes no upstream request. No pre-deploy market-cap
history was stored, so the curve accumulates from the first new metric update.

The chart shows at most 32 points. Denser histories are averaged into time buckets;
the tooltip and point list show how many source samples each average represents.
Stored history remains unaggregated.

Absolute timestamps shown in the dashboards use `Asia/Ho_Chi_Minh` (UTC+7), including
chart axes and tooltips. API/storage timestamps remain epoch milliseconds or UTC
machine timestamps; relative ages and time-window filters remain durations/epoch-based.


## 14. FOMO Tracker Buying Telegram alerts

Every new FOMO BUY with a known positive `trade_usd` adds one `trackerBuy` observation
to the instance-B alert feed. The monitor uses the same `trackerBuyingK` rule fetched
from instance A as for tracked-wallet buys, including the existing strict `>` amount
comparison and market-cap bounds. The alert identifies the FOMO trader by handle;
FOMO users are not represented as wallet addresses.

If the feed does not include a usable `trade_usd`, no alert is created from the
position's `usdValue`. When the FOMO swap enrichment later resolves that BUY's fill,
it adds the observation then. SELLs never create Tracker Buying alerts. The existing
`eventId` prevents duplicate observations on replay.

The Telegram alert's `Tracked by` and `FOMO users` lines include every tracked wallet
name and FOMO handle available for the token; they do not collapse identities into a
`+N more` suffix. Long alerts are split into labeled parts within Telegram's message
limit; confirmed successful parts are persisted so retries resume at the first unsent
part.

## 15. Direct Fomo web API scan

**Status: investigation only.** The authenticated Fomo web UI makes requests directly to `prod-api.fomo.family`. The requests below were observed through the logged-in Brave UI or replayed as read-only GETs; schemas and page counts were retained, not user IDs, tokens, addresses, or record values. This does not establish an official or stable public API contract.

### Observed data routes

| Data | Route | Observed response |
|---|---|---|
| User holdings | `GET /v2/users/{userId}/balances` | `balances[]` entries nest `balance`, `tokenFilterResult`, `userToken`, `activeTrade`, and `valuation`; top-level fields include `otherPnl`, `otherPnlV2`, `livePerpPnl`, and `otherEquity`. The UI returned a non-empty response for a public profile; the signed-in account's own balance response was empty. |
| Active and closed positions | `GET /trades?userId={userId}&orderBy=closedAt` | `activeTrades[]`, `closedTrades[]`, `hasNextPage`, and `closedCount`. Each trade nests `trade`, `swaps`, `transfers`, and may include `tokenMetadata` and a comment. A populated response had `hasNextPage=true`. |
| Individual swaps | `GET /v2/users/{userId}/swaps` | `swaps[]` contains `id`, `networkId`, `inTokenAddress`, `outTokenAddress`, `humanUsdAmountIn`, `humanUsdAmountOut`, `createdAt`, `outTradeId`, `inNetworkId`, and `outNetworkId`; response includes `hasNextPage`. |
| Swap history pagination | `GET /v2/users/{userId}/swaps?lastSwapIdV2={cursor}` | Scrolling the profile activity caused the UI to request this query key. The observed cursor replay returned another non-overlapping page. Cursor selection and termination still need validation; one replay is not proof of complete history. |
| Trade detail | `GET /trades/{tradeId}` | Returns a nested `trade`, its `swaps`, and `transfers`. The UI requested this after opening a profile trade. |
| PnL/equity snapshots | `GET /v2/userTokens/aggregatedSnapshot?userId={userId}&timestamp=...` | The UI returned rows with `snapshotId`, `pnl`, and `equity`. |
| Token activity | `GET /feed/token?tokenAddress=...&networkId=...&threshold=...` | A read-only API probe returned `items[]` with `type`, `id`, `tradeId`, `createdAt`, `userId`, `usdAmount`, `marketCap`, `fdv`, and `price`, plus `hasNextPage`. This route was not captured from a token-detail UI flow; its UI filters and pagination remain unverified. |

The Discover UI also requested `/v2/leaderboard`, `/watchlist`, `/v2/clans/leaderboard?window=...&limit=...`, `/tokenAllowList/detailed`, `/v1/perps/listed-perps`, and `/proxy/verifiedTokens`. These are discovery/profile data, not evidence that the alert websocket has been replaced.

### Candidate mapping to this repository

- `FomoPosition`: `activeTrades[].trade.tokenAddress` → `ca`; `activeTrades[].trade.id` → `tradeId`; the source collection (`activeTrades`/`closedTrades`) and `trade.closedAt` → `status`; `trade.humanTokenAmount` → `amount`; `trade.totalCostBasis` → `costBasisUsd`; `trade.avgEntryPrice` → `avgEntryPrice`; `trade.tokenMetadata.currentPrice` → `priceUsd`; `trade.realizedPnlUsd` and `trade.unrealizedPnlUsd` → the respective PnL fields.
- `FomoSwap`: `createdAt` → `at`; `outTradeId` → `tradeIdOut`; `inTokenAddress`/`outTokenAddress` → the two token addresses; `humanUsdAmountIn`/`humanUsdAmountOut` → the two USD values.
- `networkId`/`inNetworkId`/`outNetworkId` require an explicit mapping to this repository's `Chain` union. Unsupported networks must remain unsupported; cross-chain swaps cannot be represented as a single-chain `FomoSwap` without an explicit policy.
- The observed profile data routes use a stable `userId` for balances/swaps and the `userId` query for trades/snapshots. The exact handle-to-`userId` resolver contract was not verified; do not assume a handle is interchangeable with `userId` on every route.
- These REST routes are enrichment/portfolio reads. They do **not** prove equivalence to the existing large-trade alert websocket, whose captured alert contract and `eventId` dedupe are documented above. Do not remove the websocket ingestion based on this scan.
- `FomoPosition` and `FomoSwap` are not wire-compatible with the direct API response; an adapter and pagination handling are required. FOMO user's wallet holding measurements in `server/src/fomo-holdings.ts` remain a separate chain-RPC path.

### Completeness and security limits

- `/trades` returned `hasNextPage=true`; the next-page parameter was not identified. `/feed/token` also returned `hasNextPage=true`; its UI filters and cursor have not been captured.
- Swaps use `lastSwapIdV2` in the observed UI request, but the exact cursor algorithm and full-history termination behavior are not yet established.
- The app API uses the logged-in session and sits behind Cloudflare. A browser-impersonating `curl_cffi` client succeeded; plain external probes were blocked. Do not assume an ordinary server HTTP client will work.
- The tested `fomo-sapiens` helper is unofficial and persists auth material when its login/auth flow is used. Do not reuse that persistence model or copy browser tokens into the project. A supported server-side auth/refresh mechanism is still required for a production integration.
- No code, API provider, websocket, or deployment was changed as part of this investigation.

---

## 16. Alita following synchronization

The API bridge now exposes Alita's read-only following pages and profile. When
enabled on instance B, the API poller checks them every 15 minutes and adds newly
followed users to `fomo_users` with the stable FOMO `userId` and the `Alita follow`
tag. Existing rows are matched case-insensitively by handle and tagged without
overwriting their manual metadata.

Removal is deliberately conservative:

- A snapshot is complete only when the owner profile ID is correct, the following
  count is unchanged before/after pagination, and the unique paginated IDs exactly
  match that count.
- An incomplete or failed poll may add/tag returned users, but never removes or
  untags anyone; it also resets pending absence confirmation.
- Removal requires the same user to be absent from two complete snapshots at least
  one polling interval apart. Rows created by the sync are deleted on confirmation
  (existing trade/position foreign keys cascade); manual/CSV rows are kept and only
  lose the sync tag.

`GET /api/fomo/follow-sync` reports the last sync state; `POST` triggers an
admin-only run. The Makefile enables this by default for instance B and keeps it
off for A; pass `FOMO_ALITA_SYNC=off` to disable B. Compose's raw default is off.
Do not infer an unfollow from profile privacy or a short page; the count check is
the deletion gate.

## Source index

- `.omo/plans/fomo-user-watch.md` - the work plan and the pinned "Captured FOMO alert schema"
- `.omo/drafts/fomo-user-watch.md` - the answered forks (decisions D1-D11)
- `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl` - 102 real alerts (raw)
- `.omo/evidence/fomo-user-watch/task-0-capture-summary.md` - the capture summary
- `watchers/fomo/feed.py` - the daemon (socket, match, dedupe, emit, state)
- `watchers/fomo/main.py` - the CLI (`python3 -m watchers.fomo`)
- `server/src/api.ts` - `POST /api/fomo-watch/trades` and the `/api/fomo-users` routes
- `server/src/db.ts` - `fomo_users` / `fomo_trades` DDL and accessors
- `server/src/signals.ts` - `FomoUserStat` and `fomoUserStatsByCa`
- `src/components/FomoUsersPage.tsx` - the watch-list UI (export header)
- `Makefile:94` - the `server src` rsync that does not ship `watchers/`
