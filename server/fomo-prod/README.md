# FOMO prod bridge

Read-only HTTP bridge to `https://prod-api.fomo.family` using `curl_cffi`
Chrome impersonation. Node fetch gets HTTP 430 from Cloudflare; this service is
the only process that holds the Privy access/refresh tokens.

## Routes

```text
GET /health
GET /v2/users/{userId}/balances
GET /v2/users/{userId}/swaps?limit=100[&lastSwapIdV2={swap id}]
GET /feed/token?tokenAddress={ca}&networkId={id}
GET /trades/{tradeId}
```

`userId` must be FOMO's UUID. Prod rejects handles with HTTP 400, so the
watcher skips watch-list rows without a `userId` (`skipped N without userId`).
`/balances` returns at most 100 rows and no pagination flag; the API treats a
full page as possibly truncated and does not close missing holdings.

The per-user `/swaps` endpoint is paged newest-first: `hasNextPage` +
`lastSwapIdV2={last swap id}` walks backwards. The bridge forwards both the
page size and cursor, and the watcher keeps paging until its stored timestamp
cursor (then confirms a detected BUY with a one-time full buy/sell backfill for
that user and CA). The endpoint currently returns Solana activity only; EVM
activity is available through `/feed/token` (token-scoped). A feed item carries
the position's `tradeId`; `/trades/{tradeId}` returns that trade's full `swaps[]`
(buy and sell fills, including cross-chain legs), which the watcher ingests with
the same `fomo-feed:<swap id>` event ids as the token feed.

Only read-only routes are proxied. Write/trade endpoints are not reachable
through this bridge.

## Credentials

Mount a private directory containing:

```text
access_token    # Privy access JWT, or JSON with access_token/refresh_token
refresh_token   # rotated Privy refresh token
```

Both files should be mode `0600` and are never committed. The bridge refreshes
the access token five minutes before expiry and atomically rewrites both files.
`FOMO_PRIVY_APP_ID` is required when the access-token audience is not the Privy
app id (the fomo.family cookie token uses `privy.fomo.family`). If the refresh
token is missing, read requests still work until the access token expires;
`/health` reports `ok:false` after expiry or when the token file is absent.

## Runtime

The bridge is a compose service; the API talks to `http://fomo-prod:8080` and
host watchers can use `http://127.0.0.1:8131` when the port is published.
`/health` only inspects token expiry; it does not burn an upstream request.
