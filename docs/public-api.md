# Signal Scan Public API v1

Read-only API for external consumers of the Signal Scan dashboard data. The standalone service serves `/api/v1/*`; it does not expose dashboard write operations or user authentication. All routes read from one merged dashboard database. `/api/v1/alerts` and `/api/v1/ws` cover `market` and `wallet` alert origins; `/api/v1/fomo/*` routes and `/api/v1/fomo/ws` cover `fomo` alerts and FOMO user data. Returned data is the backend's currently stored state; this API does not backfill history.

Browsable pages served by the same web container:

- `https://signal-scan.duckdns.org/api-docs.html` — endpoint reference.
- `https://signal-scan.duckdns.org/feature-history.html` — public API feature milestones (commit dates, not formal releases).

Sources live in `public/` (`api-docs.html`, `feature-history.html`, `docs.css`); publish them with `make docs-deploy` (instance A only, rebuilds `web` only).

## Public access

No client authentication is required. Do not send an `Authorization` header; every route under `/api/v1` is available to any caller who can reach the public HTTPS URL. Per-client API keys and endpoint scopes are not used.

The standalone service still authenticates its requests to the dashboard's private export endpoint with `PUBLIC_API_EXPORT_TOKEN`. That backend-only credential is configured separately and is never exposed to external callers. The dashboard's existing login and its other authenticated APIs are unchanged.

```bash
curl https://signal-scan.duckdns.org/api/v1/status
```

Because there is no caller identity, wallet addresses and wallet-watch trades are public to all API consumers. FOMO handles, trades, positions, tokens, alerts, wallets, and measured holdings are likewise public. Do not enable this service unless that disclosure is acceptable.

## Endpoints

### Service and catalog

| Method and path | Access | Response |
| --- | --- | --- |
| `GET /api/v1/status` | Public | `{ "status": "ok", "version": "v1" }` |
| `GET /api/v1/chains` | Public | `{ "data": ["sol", "base", "bsc", "robinhood"] }` |
| `GET /api/v1/tiers` | Public | `{ "data": ["S+", "S", "A+", "A", "B+", "B", "P"] }` |

These routes confirm the public service is responding, not that the backend data source is healthy.

### Tokens and market data

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/v1/tokens` | Public | Paginated dashboard token snapshot. |
| `GET /api/v1/tokens/{chain}/{address}` | Public | One token with market, metrics, and history. |
| `GET /api/v1/tokens/{chain}/{address}/market` | Public | Market fields only. |
| `GET /api/v1/tokens/{chain}/{address}/metrics` | Public | Signal and metric fields only. |
| `GET /api/v1/tokens/{chain}/{address}/history` | Public | Stored metric history only. |
| `GET /api/v1/tokens/{chain}/{address}/detail` | Public | Distribution metrics and the top-100 holder table. |
| `GET /api/v1/tokens/{chain}/{address}/balance-chart` | Public | Top-100 total balance series for `day`, `week`, or `month`. |

Supported chain path values: `sol`, `base`, `bsc`, `robinhood`. Address/CA must be 1–128 characters; invalid identity returns `400`.

The collection response is `{ "generatedAt": 1700000000000, "data": [<token>, ...], "nextOffset": 50 }`. `nextOffset` is `null` when the current page reaches the end.

```http
GET /api/v1/tokens?limit=50&offset=0
```

`limit` defaults to `50`; `offset` defaults to `0`.


A token object has this shape (fields may be `null` when the source has no value):

```json
{
  "id": "token-id",
  "ca": "token-address",
  "chain": "sol",
  "symbol": "TICKER",
  "tier": "A",
  "iconUrl": "/api/token-avatar/sol/token-address",
  "xHandle": "token_x",
  "market": {
    "price": 0.001,
    "marketCap": 1000000,
    "holders": 1200,
    "volume24h": 250000,
    "volume1h": 12000,
    "buyVol24h": 140000,
    "sellVol24h": 110000,
    "dataUpdatedAt": {
      "marketCap": 1700000000000, "volume24h": 1700000000000, "holders": 1700000000000,
      "fresh": 1700000000000, "symbol": 1700000000000, "icon": 1700000000000
    }
  },
  "metrics": {
    "score": 3,
    "pass": { "fresh": true, "t100": true, "lf": false },
    "fresh": 24.7,
    "rawFresh": 24.7,
    "freshCurrent": true,
    "freshUpdatedAt": 1700000000000,
    "t100": { "pct": 25, "multiple": 1.25 },
    "lf": 69000000,
    "trackedHolding": 4.2,
    "trackedInflow": 1250,
    "trackedActivityAt": 1700000000000
  },
  "balanceRange": {
    "d1": { "peak": 1200, "trough": 900 },
    "d7": null,
    "d30": null
  },
  "history": {
    "marketCap": [{ "t": 1700000000000, "value": 1000000 }],
    "holders": [], "fresh": [],
    "t100": [{ "t": 1700000000000, "value": 25, "peakBalance": 69000000, "troughBalance": 52000000 }]
  }
}
```

The individual subresource endpoints return `{ "data": <market|metrics|history value> }`. Token detail returns the token object directly. Token, subresource, and detail requests return `404` when the token has no stored state; `502` means the private backend is unavailable.

Field notes:

- `iconUrl` is a path relative to the API origin; the dashboard serves `/api/token-avatar/...` publicly.
- `metrics.fresh` is the gated Fresh-wallet percentage the dashboard emits (`null` when the factor is hidden); `metrics.rawFresh` is the ungated measurement.
- `metrics.trackedHolding` is the tracked-wallet token amount as a percentage of token supply (`0` when supply is unknown). Alert `snapshot.trackedHoldingPct` is the same measure captured when the alert was stored (`null` when no token state was available).
- `metrics.trackedInflow` is net USD over the trailing 24h and may be negative; `metrics.trackedActivityAt` is the newest tracked buy/sell timestamp (`0` when none).
- `balanceRange` is `null` until balance snapshots exist; individual windows are `null` when that window has no data.
- `history.t100[]` keeps the optional `peakBalance`/`troughBalance` fields stored beside each sample.

### Token detail

`GET /api/v1/tokens/{chain}/{address}/detail` returns distribution metrics and the top-100 holder table built from stored snapshots:

```json
{
  "ca": "token-address",
  "chain": "sol",
  "price": 0.001,
  "supply": 1000000000,
  "holders": 1200,
  "freshSupplyPct": 24.7,
  "top100SupplyPct": 25,
  "medianHolderAmount": 500000,
  "medianHolderUsd": 500,
  "top100": [{
    "address": "holder-address",
    "percentOwnership": 5,
    "balance": 50000000,
    "balanceUsd": 50000,
    "addrType": 1,
    "isNew": false,
    "chg24h": 1.5,
    "name": "entity-label"
  }],
  "snapshotAt": 1700000000000
}
```

Missing scalar values are `null`; `top100` is empty when no snapshot exists. `addrType` is the source classification (1 = wallet, 2 = exchange). The endpoint returns `404` when the token has no stored state. Top-100 addresses and labels are on-chain/public source data, but they reveal wallet correlation; treat them accordingly.

### Balance chart

`GET /api/v1/tokens/{chain}/{address}/balance-chart?window=day|week|month` returns the top-100 cohort's total balance series:

```json
{
  "source": "nansen",
  "points": [{ "t": 1700000000000, "total": 69000000, "totalUsd": 69000, "holders": 100, "inflow": 1200 }],
  "cachedAt": 1700000000000
}
```

`window` defaults to `day`; other values return `400`. `source` is `nansen` when a cached Nansen series exists and `snapshots` for the local snapshot fallback. `t` is normalized to epoch milliseconds. Optional point fields are `null` when the source did not provide them. This endpoint never performs a synchronous upstream fetch; stale cached series may trigger a background refresh.

### Token activity

`GET /api/v1/tokens/{chain}/{address}/activity?from=<ms>&to=<ms>` returns aggregate tracked-wallet activity for the half-open interval `[from, to)`:

```json
{
  "chain": "sol", "ca": "token-address", "from": 1700000000000, "to": 1700086400000,
  "buys": 3, "sells": 1, "buyUsd": 1200, "sellUsd": 300, "netInflowUsd": 900
}
```

Timestamps are Unix epoch milliseconds. Both bounds are optional; defaults are the last 24 hours through the current time. The range must be positive and no longer than 31 days. Aggregates use stored wallet-watch trades, not FOMO activity.

### Alerts

`GET /api/v1/alerts?after_id=<id>&limit=<n>` returns alert observations after the cursor, ordered by ID:

```json
{
  "data": [{
    "id": 42, "ca": "token-address", "chain": "sol", "metric": "fresh",
    "value": 24.7, "responseAt": 1700000000000,
    "snapshot": {
      "capturedAt": 1700000000000, "symbol": "TICKER", "marketCap": 1000000,
      "marketCapAt": 1700000000000, "freshPct": 24.7, "t100Multiple": 1.25, "lf": 69000000,
      "trackedHoldingPct": 4.2,
      "iconUrl": "/api/token-avatar/sol/token-address",
      "xHandle": "token_x"
    }
  }],
  "nextId": 42,
  "oldestAvailableId": 1,
  "gap": false
}
```

`after_id` defaults to `0`; `limit` defaults to `50`. The main feed includes market (`fresh`, `t100`) and tracked-wallet (`trackerBuy`) observations. FOMO-user `trackerBuy` observations are available only through `/api/v1/fomo/alerts` and the FOMO WebSocket. `gap` indicates that a nonzero cursor predates the oldest retained observation; acknowledged rows may be pruned. The feed migration reassigned former B alert IDs, so consumers holding pre-merge cursors must reset them.

### Live inflow stream

The deployed main endpoint is `wss://signal-scan.duckdns.org/api/v1/ws`. It is public and server-to-client. On connection, the server sends `{ "type": "ready", "afterId": <latest main alert ID> }`; it then sends `{ "type": "inflow", "data": <alert> }` for each new `wallet`-origin `trackerBuy`. `market` alerts and sells are not streamed. Alert payloads omit buyer identity and internal metadata.

The main stream starts at its current cursor; it does not replay prior inflows. Use `GET /api/v1/alerts?after_id=<id>` to recover across disconnects. After the one-time merge, discard any cursor saved from former instance B and start from the new feed. Ping/pong, connection limits, and slow-consumer handling are unchanged.

The FOMO endpoint `wss://signal-scan.duckdns.org/api/v1/fomo/ws` has the same protocol and streams only `fomo`-origin `trackerBuy` alerts. Recover with `GET /api/v1/fomo/alerts?after_id=<id>`. Both paths share the 64-connection budget and read the same merged backend; an unavailable stream closes only its own connection with code `1011`.

### Wallets

`GET /api/v1/wallets?limit=<n>&offset=<n>` returns tracked wallet records:

```json
{
  "data": [{ "id": "wallet-id", "address": "wallet-address", "chain": "sol", "name": "Wallet", "tags": ["whale"], "clan": null }],
  "nextOffset": 50
}
```

`limit` defaults to `50`; `offset` defaults to `0`. Wallet records and addresses are available to every caller. Pagination is offset-based and can shift when the wallet list changes.

### Wallet trades

`GET /api/v1/wallets/{id}/trades?from=<ms>&to=<ms>&after_id=<id>&limit=<n>` returns tracked wallet-watch trades in `[from, to)`, ordered by trade ID:

```json
{
  "data": [{
    "id": 17, "walletId": "wallet-id", "ca": "token-address", "chain": "sol",
    "ts": 1700000000000, "side": "buy", "amountUsd": 250, "price": 0.001, "tx": "transaction-id"
  }],
  "nextId": 17
}
```

`from` and `to` are optional Unix epoch-millisecond bounds forming a positive range up to 31 days; when omitted they default to the last 24 hours through the current time. The interval is half-open `[from, to)`. `after_id` defaults to `0`; `limit` defaults to `50`. `nextId` is `null` when there are no more results. Trade IDs are suitable for cursor-based pagination; trades outside the selected time interval are excluded.

### FOMO watch-list and activity

FOMO routes read FOMO users, trades, positions, and holdings from the merged dashboard database. They return `502` when the private upstream is unavailable. FOMO token stats accept `eth` in addition to `sol`, `base`, `bsc`, and `robinhood`; other values return `400`.

| Method and path | Response |
| --- | --- |
| `GET /api/v1/fomo/tokens` | Paginated token table (token payload plus `fomoUsers`). |
| `GET /api/v1/fomo/tokens/{chain}/{address}` | One token, including `fomoUsers`. |
| `GET /api/v1/fomo/tokens/{chain}/{address}/users` | Per-token FOMO user stats. |
| `GET /api/v1/fomo/alerts` | FOMO-user (`fomo` origin) alert observations. |
| `GET /api/v1/fomo/users` | Paginated FOMO watch-list. |
| `GET /api/v1/fomo/users/{id}/trades` | One user's stored FOMO buy/sell alerts. |
| `GET /api/v1/fomo/users/{id}/positions` | Stored positions plus balance measurements and refresh metadata. |
| `GET /api/v1/fomo/wallets` | Paginated tracked wallets. |
| `GET /api/v1/fomo/wallets/{id}/trades` | One FOMO wallet's watch trades. |

#### FOMO token table

`GET /api/v1/fomo/tokens?limit=<n>&offset=<n>` returns the merged dashboard's
tracked token list. Each entry is the same payload as `GET /api/v1/tokens` plus
`fomoUsers` — the rows the dashboard's FOMO sub-table renders:

```json
{
  "generatedAt": 1700000000000,
  "data": [{
    "id": "base:0xtoken", "ca": "0xtoken", "chain": "base",
    "market": { "marketCap": 1000000, "holders": 1200 },
    "metrics": { "score": 7, "trackedHolding": 3.5 },
    "history": { "marketCap": [] },
    "fomoUsers": [{ "handle": "@trader", "buyUsd": 1250, "sells": 1, "balUsd": 5000 }]
  }],
  "nextOffset": null
}
```

`GET /api/v1/fomo/tokens/{chain}/{address}` returns one entry with the same
shape and `404` when the merged dashboard does not track that token. `eth` is
accepted here as well as on the per-token stats route.

#### FOMO alerts and wallets

`GET /api/v1/fomo/alerts?after_id=<id>&limit=<n>` returns only FOMO-user
`trackerBuy` observations, with the same DTO, `nextId`, and `gap` semantics as
`GET /api/v1/alerts`. `/api/v1/alerts` contains market and tracked-wallet
origins. FOMO wallets and their watch trades are also sourced from the merged
dashboard database.

#### FOMO users

`GET /api/v1/fomo/users?limit=<n>&offset=<n>` returns the watch-list:

```json
{
  "data": [{
    "id": "fomo-user-id", "handle": "@trader", "name": "Trader", "tags": ["clan-a"],
    "clan": "a", "userId": "fomo-user-id", "walletSolana": null,
    "walletEvm": "0x...", "source": "manual"
  }],
  "nextOffset": null
}
```

`limit` defaults to `50`; `offset` defaults to `0`. Optional identity fields are `null` when unset.

#### FOMO token stats

`GET /api/v1/fomo/tokens/{chain}/{address}/users` returns the same per-user
aggregation the dashboard's FOMO table renders:

```json
{
  "data": [{
    "handle": "@trader", "name": "Trader", "tags": ["clan-a"], "clan": "a",
    "buyUsd": 1250, "sellUsd": 400, "buys": 3, "sells": 1, "trades": 4,
    "lastTs": 1700000000000, "holdingAmount": 5000000, "holdingPct": 0.5, "balUsd": 5000
  }]
}
```

- `buyUsd` is BUY spend over the trailing 24 hours; `sellUsd` is SELL gross proceeds. They are reported separately and are never netted. Each is `null` when any in-window amount is unresolved, rather than a partial total.
- `lastTs` is `0` when the user is a member only because a stored position or measured holding exists.
- `holdingAmount`, `holdingPct`, and `balUsd` are omitted when the measurement or price is unknown. `holdingPct` is position value ÷ token market cap × 100.

#### FOMO trades

`GET /api/v1/fomo/users/{id}/trades?from=<ms>&to=<ms>&after_id=<id>&limit=<n>` returns stored FOMO alerts in `[from, to)`, ordered by ascending trade ID:

```json
{
  "data": [{
    "id": 17, "userId": "fomo-user-id", "handle": "@trader", "eventId": "fomo-swap:...",
    "ca": "token-address", "chain": "base", "side": "buy",
    "usdValue": 200, "tradeUsd": 100, "price": 0.001, "token": "TICKER",
    "ts": 1700000000000, "source": "fomo"
  }],
  "nextId": 17
}
```

`usdValue` is type-dependent: the post-fill position value for a buy and signed realised PnL for a sell. `tradeUsd` is the USD actually traded in either direction and is the only field suitable for spend/proceeds sums. Pagination and range rules match wallet trades.

#### FOMO positions and holdings

`GET /api/v1/fomo/users/{id}/positions` returns one entry per stored position or measured holding:

```json
{
  "data": [{
    "ca": "token-address", "chain": "base", "tradeId": "trade-id", "status": "open",
    "amount": 1000, "costBasisUsd": 100, "avgEntryPrice": 0.1, "priceUsd": 0.2,
    "realizedPnlUsd": 0, "unrealizedPnlUsd": 100, "fetchedAt": 1700000000000,
    "holdings": [
      { "source": "rpc", "amount": 1000, "pct": 0.01, "capturedAt": 1700000000000, "wallet": "0x..." }
    ]
  }],
  "freshness": {
    "balances": {
      "checkedAt": 1700000000000, "capturedAt": 1699999999000,
      "complete": true, "truncated": false, "available": true
    },
    "positions": { "checkedAt": 1700000000000 }
  }
}
```

`costBasisUsd` is money actually spent, not the alert's mark-to-market value. `holdings` lists stored measurements for the same `(user, ca, chain)`: `source` is `api` (FOMO balances) or `rpc` (wallet-balance measurement); `wallet` appears only for `rpc`. A CA with a measured holding but no position row appears with `null` position fields and `fetchedAt: 0`. Unknown users return an empty `data` array, not `404`.

`freshness` describes the last upstream refresh, not the age of individual rows: `balances.checkedAt` is when the FOMO API balance refresh ran, `capturedAt` when that snapshot was taken, `complete`/`truncated`/`available` report whether the upstream balance list was partial, row-capped, or unreadable. Either entry is `null` when that refresh has never run. Per-position `fetchedAt` remains the timestamp of that position row.

## Pagination and limits

- Public `limit` defaults to 50 and is bounded to 1–100. `offset` defaults to 0 and is bounded to 1,000,000. Token, wallet, FOMO-user, FOMO-token, and FOMO-wallet lists use offset pagination.
- `after_id` defaults to 0 and must be a non-negative integer. Alerts, wallet trades, FOMO alerts, and FOMO trades use ID cursors; alerts return `nextId`, trades return nullable `nextId`.
- Activity and trade time ranges are half-open `[from, to)` epoch-millisecond ranges, at most 31 days. Both endpoints default to the last 24 hours through the current time when omitted.
- The entire service is limited to 120 requests per minute per process, shared by all callers. `429` responses include `Retry-After`. At most 16 requests run concurrently; excess concurrency returns `503`.
- Backend export requests have a 10-second timeout. Identical in-flight requests share work; successful export responses are cached for 500 ms in a bounded per-process cache.

## Errors

Errors use JSON `{ "error": "..." }` for API-generated failures:

| HTTP status | Meaning |
| --- | --- |
| `400` | Invalid chain/address, pagination, or time range. |
| `429` | Global per-process rate limit exceeded; retry after `Retry-After` seconds. |
| `502` | Internal dashboard export endpoint unavailable, unconfigured, timed out, or returned a non-success response. |
| `503` | Service concurrency limit reached. |

## Setup and lifecycle

Configuration used by the standalone container:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_API_EXPORT_TOKEN` | Private credential shared with the backend's `server/.env`; required for backend export requests. |
| `PUBLIC_API_PORT` | Internal listen port; Compose uses `3010`. |
| `PUBLIC_API_INTERNAL_URL` | Private dashboard API base URL; deployed main and FOMO routes use the merged instance A API. |
| `PUBLIC_API_FOMO_INTERNAL_URL` | Private FOMO route upstream; set to the same merged A API and share `PUBLIC_API_EXPORT_TOKEN`. |

Set `PUBLIC_API_RUN=1` only in the standalone container to start the service process; the ordinary dashboard API does not enable this listener.

1. Set a long random `PUBLIC_API_EXPORT_TOKEN` in the backend's `server/.env`.
2. Copy `server/public-api.env.example` to `server/public-api.env`; set the same `PUBLIC_API_EXPORT_TOKEN` and point both internal API URLs to `http://signal-scan-api-a:3001`. Keep both secret files private and do not commit them.
3. Create/deploy the standalone API with `make public-api-deploy` (instance A). Check it with `make public-api-status` and `make public-api-logs`.
4. Stop or start only the standalone service with `make public-api-down` / `make public-api-up`. `make public-api-build` rebuilds its image. The dashboard API and login remain available when the public service is stopped.

The service is configured to publish only on loopback (`127.0.0.1:3010`) and is exposed externally through the existing HTTPS Nginx route. The initial deployment also installs the backend export route and Nginx proxy configuration; it rebuilds/recreates the backend and web proxy. Later on/off actions affect only the public API container. Keep one replica because the request quota, cache, and in-flight limits are process-local.

## Data exposure

This is a read-only data export, not a general dashboard API. The DTOs omit tracked-buyer details and internal dashboard notes. Wallet addresses, wallet-watch trades, FOMO handles, FOMO trades, FOMO positions, FOMO tokens, FOMO alerts, and measured holdings are public without authentication; do not expose this service if that disclosure is unacceptable. Only stored source history is returned; unavailable/expired source data is not reconstructed.
