# FOMO user watch - runbook (2026-09-29)

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

FOMO's feed carries **large trades only**, not every trade by every user. A watched
trader's small trades will never appear on the socket, so the `FOMO by` column is
inherently a partial view. FOMO's own documentation says, and this repo repeats it in
the column tooltip:

> do not compute market share, trade counts, or volume from it

Do not read the `FOMO by` counts as platform-wide activity, and do not sum them into a
market share or a volume figure. The column answers one narrow question: "did a trader
on our watch list take a large position in this coin recently, and how big was it".

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

`fomoUserStat` shape (mirrored on both sides): `handle`, optional `name`/`clan`,
`buyUsd`, `buys`, `sells`, `trades`, `lastTs`. Membership is "ever had a `type='buy'`
row for this (ca, chain)" - a trader with only sells for that coin does not appear, and
a trader whose newest buy is older than 24h still appears with zero 24h stats.

---

## 4. Chain map and dedupe

**Chain map.** The repo's `Chain` union is only `sol | base | bsc`, so the daemon maps:

```
solana -> sol
base   -> base
bsc    -> bsc
```

Everything else is **dropped**: `ethereum`, `robinhood`, `hyperliquid`, and the perp
chainId `1337`. They cannot be stored, so they are discarded at the daemon and never
reach the ingest route.

**Dedupe by `eventId`.** `fomo_trades` has a UNIQUE index on `event_id`, and the insert
is `INSERT INTO fomo_trades (...) ON CONFLICT(event_id) DO NOTHING`. Re-POSTing the same
event changes nothing: the second call returns 2xx and inserts zero rows. Reconnects and
replayed frames therefore cannot double-count. The daemon also keeps a bounded in-memory
seen-set and persists it in `fomo_state.json` so a restart does not re-POST.

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

The daemon reads **two** values from the host environment:

- `FOMO_API_KEY` - the FOMO key. It rides in the socket query string
  (`wss://api.fomoapi.io/ws/alerts?key=...`), and the daemon masks it in every log line
  (`?key=***`).
- `SIGNAL_SCAN_SERVICE_TOKEN` - the instance-b service token. Both `GET /api/fomo-users`
  (the watch-list read) and `POST /api/fomo-watch/trades` (the ingest) require it; the
  daemon sends it as a `Bearer` header via `watchers/common/config.py`. Without it the
  daemon gets 401/403 and silently stops writing.

Keep them in a host-only env file, one `NAME=VALUE` assignment per line, chmod 600,
located on the server and never in the repo:

```
/opt/fomo-watch/fomo.env   (host-only secret file, chmod 600)
  FOMO_API_KEY                - the rotated FOMO key
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

Self-check (connects, then exits after the first emitted alert or a ~90s window):

```bash
python3 -m watchers.fomo --once --api-url http://127.0.0.1:8125
```

The daemon opens exactly **one** socket to `wss://api.fomoapi.io/ws/alerts`, matches
alerts locally against the watch list (refreshed from `GET /api/fomo-users` about every
300 seconds), dedupes by `eventId`, and POSTs each survivor individually to
`/api/fomo-watch/trades`. On a 404 from the ingest it treats the watch list as stale and
refreshes it once.

---

## 7. Instance-b env wiring (where secrets live)

- Server secrets live in **`server/.env` ON THE SERVER**, created from
  `server/.env.example`. That file is never in the repo and `make deploy` never copies
  it (`rsync --exclude .env`).
- The rsync excludes `'/keys'` and `'/data*'`, so private keys and every DB dir
  (`data`, `data-b`) stay on the host and out of git.
- `MODE=gmgn` (a server-side setting, not FOMO) needs that server-side env file to
  exist; the default `MODE=mock` runs without it.
- The FOMO daemon's own secrets (`FOMO_API_KEY`, `SIGNAL_SCAN_SERVICE_TOKEN`) live in the
  host env / service drop-in described in 6.3, not in the repo.

---

## 8. Troubleshooting: daemon up but the column is empty

Work through these in order.

1. **Watch-list membership.** The daemon stores only traders that exist in the FOMO
   watch list. If the trader was never added (or their handle/userId differs from the
   stored row), their alerts are dropped by design. Confirm `GET /api/fomo-users` on
   instance b returns the row.
2. **The socket.** Check the daemon log for `# fomo socket connected`. If it is
   reconnecting, the key is missing or rejected. Confirm `FOMO_API_KEY` is set and not
   expired. The log never prints the key.
3. **Ingest 404s.** A line like
   `! ingest 404 (<handle>) - watch list stale, refresh` means the server has no
   matching `fomo_users` row for that handle/userId. Fix the watch list; the daemon
   refreshes itself on a 404 but will keep 404ing until the row exists.
4. **`replay:true` frames.** A replayed frame is just the delayed tier (section 5), not
   a failure. The column is best-effort-fresh and, because the feed is large-trades-only,
   a watched trader can legitimately have no rows for a coin right now.

Also remember the by-design drops: a `perp`/`thesis`/`listing` alert, an alert with no
`tokenAddress`, an untracked trader, and any chain outside `sol|base|bsc` all produce no
row.

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
