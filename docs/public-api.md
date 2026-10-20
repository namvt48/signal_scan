# Signal Scan Public API v1

Read-only API for external consumers of the Signal Scan dashboard data. The standalone service serves `/api/v1/*`; it does not expose dashboard write operations, user authentication, or FOMO data. Returned data comes from the backend's currently stored state; this API does not backfill history.

## Public access

No client authentication is required. Do not send an `Authorization` header; every route under `/api/v1` is available to any caller who can reach the public HTTPS URL. Per-client API keys and endpoint scopes are not used.

The standalone service still authenticates its requests to the dashboard's private export endpoint with `PUBLIC_API_EXPORT_TOKEN`. That backend-only credential is configured separately and is never exposed to external callers. The dashboard's existing login and its other authenticated APIs are unchanged.

```bash
curl https://signal-scan.duckdns.org/api/v1/status
```

Because there is no caller identity, wallet addresses and wallet-watch trades are public to all API consumers. Do not enable this service unless that disclosure is acceptable.

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
  "market": {
    "price": 0.001,
    "marketCap": 1000000,
    "holders": 1200,
    "volume24h": 250000,
    "volume1h": 12000,
    "buyVol24h": 140000,
    "sellVol24h": 110000,
    "dataUpdatedAt": { "marketCap": 1700000000000, "volume24h": 1700000000000, "holders": 1700000000000 }
  },
  "metrics": {
    "score": 3,
    "pass": { "fresh": true, "t100": true, "lf": false },
    "fresh": 24.7,
    "freshCurrent": true,
    "freshUpdatedAt": 1700000000000,
    "t100": { "pct": 25, "multiple": 1.25 },
    "lf": 69000000
  },
  "history": {
    "marketCap": [{ "t": 1700000000000, "value": 1000000 }],
    "holders": [], "fresh": [], "t100": []
  }
}
```

The individual subresource endpoints return `{ "data": <market|metrics|history value> }`. Token detail returns the token object directly.

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
      "marketCapAt": 1700000000000, "freshPct": 24.7, "t100Multiple": 1.25, "lf": 69000000
    }
  }],
  "nextId": 42,
  "oldestAvailableId": 1,
  "gap": false
}
```

`after_id` defaults to `0`; `limit` defaults to `50`. `gap` indicates that a nonzero cursor predates the oldest retained observation; acknowledged rows may be pruned. Alert DTOs exclude buyer identities and FOMO metadata.

### Live inflow stream

The deployed endpoint is `wss://signal-scan.duckdns.org/api/v1/ws`. It is a public, server-to-client WebSocket; no client authentication is required, matching the REST API. On connection the server sends `{ "type": "ready", "afterId": <latest alert ID> }`; it then sends `{ "type": "inflow", "data": <alert> }` for each newly stored `trackerBuy` alert. Fresh/T100 alerts and sells are not streamed. The alert payload omits buyer identity and internal metadata.

The stream starts at the latest stored alert when the connection is established; it does not replay prior inflows. Use `GET /api/v1/alerts?after_id=<id>` for cursor-based recovery after disconnect. The server sends WebSocket ping frames every 25 seconds and removes clients that do not answer pong. The HTTPS proxy allows 75 seconds of read idle time. At most 64 concurrent WebSocket connections are accepted per process; excess upgrades receive `503`. Alerts are polled once per process and shared with connected clients. Slow consumers are closed; reconnect and resume with the last processed alert ID using the REST endpoint.

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

## Pagination and limits

- Public `limit` defaults to 50 and is bounded to 1–100. `offset` defaults to 0 and is bounded to 1,000,000. Token and wallet lists use offset pagination.
- `after_id` defaults to 0 and must be a non-negative integer. Alerts and trades use ID cursors; alerts return `nextId`, trades return nullable `nextId`.
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
| `PUBLIC_API_INTERNAL_URL` | Private dashboard API base URL; Compose selects the instance-specific API alias. |

Set `PUBLIC_API_RUN=1` only in the standalone container to start the service process; the ordinary dashboard API does not enable this listener.

1. Set a long random `PUBLIC_API_EXPORT_TOKEN` in the backend's `server/.env`.
2. Copy `server/public-api.env.example` to `server/public-api.env`; set the same `PUBLIC_API_EXPORT_TOKEN`. Keep both secret files private and do not commit them.
3. Create/deploy the standalone API with `make public-api-deploy` (initial deployment is instance A). Check it with `make public-api-status` and `make public-api-logs`.
4. Stop or start only the standalone service with `make public-api-down` / `make public-api-up`. `make public-api-build` rebuilds its image. The dashboard API and login remain available when the public service is stopped.

The service is configured to publish only on loopback (`127.0.0.1:3010`) and is exposed externally through the existing HTTPS Nginx route. The initial deployment also installs the backend export route and Nginx proxy configuration; it rebuilds/recreates the backend and web proxy. Later on/off actions affect only the public API container. Keep one replica because the request quota, cache, and in-flight limits are process-local.

## Data exposure

This is a read-only data export, not a general dashboard API. The DTOs intentionally omit FOMO users, FOMO trades, tracked-buyer details, and internal dashboard notes. Wallet addresses and wallet-watch trades are public without authentication; do not expose this service if that disclosure is unacceptable. Only stored source history is returned; unavailable/expired source data is not reconstructed.
