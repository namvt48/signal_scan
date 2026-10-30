# FOMO prod bridge

Read-only HTTP bridge to `https://prod-api.fomo.family` using `curl_cffi`
Chrome impersonation. The bridge is intended to remain stopped unless explicitly
operated; never copy browser cookies or credentials into this service.

## Routes

```text
GET /health
GET /v2/users/{userId}/balances
GET /v2/users/{userId}/swaps?limit=100[&lastSwapIdV2={swap id}]
GET /trades?userId={userId}&orderBy=closedAt[&tokenAddress={ca}]
GET /feed/token?tokenAddress={ca}&networkId={id}
GET /trades/{tradeId}
```

Only read-only routes are proxied. All bridge responses advertise
`X-Fomo-Retry-Handled: 1`; callers must not retry these responses. Provider 403
latches the persisted account-wide suspension. Local paused/suspended/state errors
are 503; cooldown and exhausted quota are 429 with `Retry-After`. The health route
is local-only and reports safe guard state and remaining delays.

## Offline request guard

Upstream access is fail-closed. Set `FOMO_UPSTREAM_ENABLED=true` to permit calls.
The default `FOMO_REQUEST_QUOTA_MODE=limited` requires positive
`FOMO_MAX_REQUESTS_PER_MINUTE`, `FOMO_MAX_REQUESTS_PER_HOUR`, and
`FOMO_MAX_REQUESTS_PER_DAY` values; missing, invalid, or zero limits deny
requests. `FOMO_REQUEST_QUOTA_MODE=unlimited` explicitly disables those quota
windows, but still requires upstream enablement and valid persistent state.

For Compose deployments, persist these variables in
`${DATA_DIR:-data}/fomo-prod-runtime.env`; the bridge loads this optional
per-instance file on every `docker compose up`. Keep Makefile defaults out of
this policy file so ordinary `make up` cannot silently pause or limit it.
Both modes serialize and pace outbound calls. The limited mode charges every
attempt (including bounded transport/5xx retries) against all three windows.
The bridge retries only transport failures and 5xx, at most three times; 401,
403, and 429 are never retried. HTTP 403 persistently suspends every endpoint.
HTTP 429 starts a global cooldown (60 seconds when the provider omits
`Retry-After`); 503 with `Retry-After` also defers all endpoints.

Shared state defaults to `/state/request-guard.json`
(`FOMO_GUARD_STATE_FILE`) on the persistent `DATA_DIR/fomo-prod-guard` volume.
Corrupt/unreadable state deliberately blocks requests rather than resetting.
All GET responses carry `X-Fomo-Retry-Handled: 1`; consumers make one request
and preserve their cursors when blocked. `/health` is local-only and reports
safe guard state; it never calls FOMO.

After provider approval, an operator may clear suspension/cooldown while
preserving quota history. From the repository root, set `DATA_DIR` as used by
Compose if it differs from `data`:

```sh
FOMO_GUARD_STATE_FILE="${DATA_DIR:-data}/fomo-prod-guard/request-guard.json" \
  python3 server/fomo-prod/request_guard.py --confirm-provider-approval
```

This command is local only; there is no HTTP reset route. Do not reset merely to
work around a provider denial.

Run bridge tests entirely offline with a local fake upstream:

```sh
cd server/fomo-prod
python3 -m unittest -v test_bridge
```
