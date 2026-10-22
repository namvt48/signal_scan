# FOMO prod bridge

Read-only HTTP bridge to `https://prod-api.fomo.family` using `curl_cffi`
Chrome impersonation. Node fetch gets HTTP 430 from Cloudflare; this service is
the only process that holds the Privy access/refresh tokens.

## Routes

```text
GET /health
GET /v2/users/{userId}/balances
GET /v2/users/{userId}/swaps?limit=100
```

Only the two read-only user routes are proxied. Write/trade endpoints are not
reachable through this bridge.

## Credentials

Mount a private directory containing:

```text
access_token    # Privy access JWT, or JSON with access_token/refresh_token
refresh_token   # rotated Privy refresh token
```

Both files should be mode `0600` and are never committed. The bridge refreshes
the access token five minutes before expiry and atomically rewrites both files.
If the refresh token is missing, read requests still work until the access token
expires; `/health` reports `ok:false` after expiry.

## Runtime

The bridge is a compose service; the API talks to `http://fomo-prod:8080` and
host watchers can use `http://127.0.0.1:8131` when the port is published.
`/health` only inspects token expiry; it does not burn an upstream request.
