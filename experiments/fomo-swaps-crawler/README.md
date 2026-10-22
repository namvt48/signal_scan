# FOMO swaps crawler (standalone experiment)

Independent crawler for FOMO's `GET /v2/users/{userId}/swaps` endpoint. It does
one request per user per cycle, keeps only the **first page** (`limit=100`, no
pagination), and stores CA/inflow aggregates in SQLite plus a flat CSV.

It does **not** import or modify `signal_scan`.

## What it stores

`data/fomo_swaps.db`:

- `users` — handle + FOMO userId loaded from `users.csv`.
- `swap_events` — first-page swaps, deduped by `tradeIdOut` (fallback `swapId`).
- `ca_inflow` — per `(user, chain, CA)`:
  - `inflow_usd` = sum of `tokenIn.usd` for swaps whose `tokenOut` is a token CA
    (quote assets such as SOL/USDC/USDT are excluded).
  - `buy_count`, `first_seen_at`, `last_seen_at`, `last_cycle`.
- `cycles` — per-cycle telemetry: HTTP 200/404/429/503, errors, credits cost,
  credits remaining, duration, stop reason, interval.
- `user_errors` — per-user 404/429/5xx/auth errors.
- `rate_state` — current interval, consecutive rate limits, clean cycles.

`data/ca_inflow.csv` — flat snapshot, sorted by `inflow_usd DESC`.
`data/latest_cycle.json` — last cycle summary.

Inspect results:

```bash
python3 report.py --top 20
python3 report.py --data-dir data --top 50
```

## Run

```bash
cd /opt/fomo-swaps-crawler
cp .env.example .env        # set FOMO_API_KEY
python3 crawler.py --once   # one full cycle
python3 crawler.py          # daemon, base interval 15m
```

Smoke test with a subset:

```bash
python3 crawler.py --once --max-users 5
```

### Sequential batches and rotation

Requests are not fired all at once:

- Users are split into `FOMO_BATCH_SIZE` chunks (default 20).
- With `FOMO_CONCURRENCY=1`, one user is submitted and awaited at a time.
- Before every HTTP call (including retries), a pacer enforces
  `FOMO_REQUEST_DELAY_MS` since the previous request start; the delay is not
  applied only in the result consumer.
- Between chunks the crawler sleeps `FOMO_BATCH_PAUSE_SECONDS` (default 10s).
- `FOMO_CYCLE_USERS=60` queries 60 users per cycle and rotates the cursor;
  5 cycles cover 271 users. Set `0` to query all users every cycle.
- 503 users are retried once after all batches, with the same batching.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `FOMO_API_BASE` | `https://api.fomoapi.io` | API base; set `https://prod-api.fomo.family` for free |
| `FOMO_API_KEY` | — | Paid API bearer key |
| `FOMO_AUTH_TOKEN` | — | Alternative bearer token |
| `FOMO_AUTH_TOKEN_FILE` | — | Access-token file read before each request; use for short-lived Privy tokens |
| `FOMO_REFRESH_TOKEN_FILE` | `<auth_token_file>.refresh` | Privy refresh-token file used when the access token is within the refresh skew |
| `FOMO_PRIVY_APP_ID` | from JWT `aud` | Optional override for the `privy-app-id` header |
| `FOMO_PRIVY_TOKEN_URL` | `https://auth.privy.io/api/v1/sessions` | Privy browser-session refresh endpoint |
| `FOMO_PRIVY_ORIGIN` | `https://fomo.family` | `Origin` header required by the refresh endpoint |
| `FOMO_TOKEN_REFRESH_SKEW_SECONDS` | `300` | Refresh the access token when it expires within this many seconds |
| `FOMO_IMPERSONATE` | `chrome` | curl_cffi TLS fingerprint for free API |
| `FOMO_AUTH_RETRY_SECONDS` | `300` | Retry delay after auth/Cloudflare error |
| `FOMO_USERS_FILE` | `users.csv` | handle,user_id CSV |
| `FOMO_DATA_DIR` | `data` | SQLite/CSV output |
| `FOMO_INTERVAL_SECONDS` | `900` | Base interval (15m) |
| `FOMO_MAX_INTERVAL_SECONDS` | `21600` | Interval cap (6h) |
| `FOMO_CONCURRENCY` | `1` | Parallel requests inside a batch |
| `FOMO_REQUEST_DELAY_MS` | `500` | Minimum delay between HTTP request starts |
| `FOMO_BATCH_SIZE` | `20` | Users per sequential batch; 0 = one batch |
| `FOMO_BATCH_PAUSE_SECONDS` | `10` | Pause between batches |
| `FOMO_CYCLE_USERS` | `0` | Users per cycle, rotating; 0 = all users |
| `FOMO_TIMEOUT_SECONDS` | `30` | HTTP timeout |
| `FOMO_LIMIT` | `100` | First-page size |
| `FOMO_MAX_USERS` | `0` | 0 = all users |
| `FOMO_CREDIT_COST` | `250` paid / `0` free | Credits per swaps request |
| `FOMO_CREDIT_RESERVE` | `50000` paid / `0` free | Skip a cycle if remaining < cost + reserve |
| `FOMO_MAX_503` | `0` | Stop after N HTTP 503s; 0 = never stop |
| `FOMO_CLEAN_CYCLES_TO_DECAY` | `8` | Halve interval after N clean cycles |
| `FOMO_START_DELAY_SECONDS` | `0` | Delay before first daemon cycle |
| `FOMO_LOG_LEVEL` | `INFO` | Log level |

## Rate-limit / credit behaviour

- HTTP `429`: sleep `Retry-After`, stop the current cycle, double the interval
  (15m → 30m → 60m → … up to 6h).
- `FOMO_INTERVAL_SECONDS` is the **idle delay after** a cycle, not a
  start-to-start period. Start-to-start = cycle duration + interval. A
  60-user cycle takes roughly 80s at 1 req/s with batch pauses; an all-271
  cycle takes roughly 6.7 minutes.
- HTTP `503`: record the user and continue the first pass; after the pass,
  wait `Retry-After` (capped 120s) and retry those users once with concurrency
  1. If `FOMO_MAX_503` is greater than 0, stop and double the interval after
  that many 503s; `0` means never stop for 503s.
- Clean cycles: after 8 consecutive clean cycles, halve the interval down to
  the base.
- Cycle status is one of `completed`, `credit_guard`, `rate_limited`,
  `upstream_busy`, `auth_error`, `interrupted`, `error`. The rotation cursor
  advances only on `completed`; shutdowns and unexpected exceptions mark the
  cycle `interrupted`/`error` and retry the same slice next time.
- Credit guard: before a cycle, read `/v2/me`. If `remaining < users × 250 +
  50,000`, skip the cycle, log `credit_guard`, and double the interval.
- Auth `401/403`/Cloudflare `430`: mark the cycle `auth_error`, keep the
  adaptive interval unchanged, and sleep only `FOMO_AUTH_RETRY_SECONDS`
  (default 300) before the next attempt. With `--once`, exit non-zero.

### Credit warning

`api.fomoapi.io` charges **250 credits per swaps request** (observed
`x-credits-cost: 250`). One full 271-user cycle costs **67,750 credits**.
The script cannot batch multiple users into one request; the cap is the FOMO
API plan quota.

## Free browser API: prod-api.fomo.family

This endpoint does **not** consume `api.fomoapi.io` credits. It is the web
app's API and requires:

- A Privy access token (short-lived, ~1h) plus its refresh token from a
  **dedicated** logged-in FOMO session.
- `curl_cffi` with `impersonate="chrome"`; plain Python/curl gets HTTP `430`
  from Cloudflare.
- Reading the envelope `{success, responseObject}`; swaps are flat fields
  (`id`, `inTokenAddress`, `outTokenAddress`, `humanUsdAmountIn`, ...).
- First page only (25 items); pagination is not implemented.

Setup:

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
install -d -m 700 data/credentials
printf '%s' '<privy-access-token>' > data/credentials/access_token
printf '%s' '<privy-refresh-token>' > data/credentials/refresh_token
chmod 600 data/credentials/access_token data/credentials/refresh_token
```

`.env`:

```env
FOMO_API_BASE=https://prod-api.fomo.family
FOMO_AUTH_TOKEN_FILE=/opt/fomo-swaps-crawler/data/credentials/access_token
FOMO_REFRESH_TOKEN_FILE=/opt/fomo-swaps-crawler/data/credentials/refresh_token
FOMO_PRIVY_ORIGIN=https://fomo.family
FOMO_TOKEN_REFRESH_SKEW_SECONDS=300
FOMO_CREDIT_COST=0
FOMO_CREDIT_RESERVE=0
FOMO_AUTH_RETRY_SECONDS=300
```

The crawler reads the access token before every request. When the JWT `exp`
is within `FOMO_TOKEN_REFRESH_SKEW_SECONDS`, it exchanges the refresh token at
Privy's **browser-session** endpoint (`POST /api/v1/sessions`, with
`privy-app-id` and `Origin` headers), rewrites both credential files atomically
(mode 0600), and uses the new access token immediately. The response field is
`token` (customer access token), not `access_token`. The response may rotate
the refresh token (`session_update_action: "set"`, non-empty `refresh_token`);
when it returns `"ignore"` with no `refresh_token`, the existing token stays
valid and is reused. The new value is persisted only when present; the literal
legacy sentinel `"deprecated"` is ignored, and a real `privy-refresh-token`
`Set-Cookie` value is preferred. This is the
same endpoint the Privy web SDK uses; the `POST /api/oauth/v2/token` endpoint
belongs to the separate device/agent OAuth flow and does not accept
browser-session credentials. Source refresh token: the `privy-refresh-token`
cookie on `.privy.fomo.family` (HttpOnly; not localStorage).
Credential files live under `data/` because the systemd unit mounts the
application directory read-only.

If the refresh token is missing/expired, the crawler keeps the current access
token; cycles become `auth_error` and retry every 5 minutes until the files are
updated. The endpoint's rate limit is unknown; use
`FOMO_REQUEST_DELAY_MS=1000` (1 req/s) and watch for `403`/`429`/`430`.

## Rate-limit probe

`rate_limit_probe.py` sends a bounded number of read-only `/swaps` requests at a
fixed aggregate rate, records latency and rate-limit headers, and stops
immediately on `401`, `403`, `429`, `430`, or `503`:

```bash
FOMO_AUTH_TOKEN_FILE=data/credentials/access_token \
  python3 rate_limit_probe.py --rates 1,2,4 --requests 30
```

Output goes to `data/rate-limit-probe.jsonl`. Start at 1 req/s, then increase
only if a step completes cleanly. The probe measures the local egress IP; FOMO
may rate-limit per IP, so validate any tuning on the server before deploying.

## Measured tuning (2026-10-21, prod free endpoint)

Probe from the local workstation (`cf-ray ...-HKG`):

| Target rate | Requests | Result |
|---:|---:|---|
| 1–18 req/s | 30–600 | 200, no 429 |
| 20 req/s | 553 | first 429 after ~31s |
| 24 req/s | 243 | first 429 after ~10.8s |
| 32 req/s | 117 | first 429 after ~4.3s |

The 429 responses carried `retry-after: 0` and no `x-ratelimit-*`
headers. The safe sustained target is **16 req/s** with **4 workers**;
20 req/s eventually trips the limit. Applied configuration:

```env
FOMO_INTERVAL_SECONDS=60
FOMO_CONCURRENCY=4
FOMO_REQUEST_DELAY_MS=62
FOMO_BATCH_PAUSE_SECONDS=0
FOMO_CYCLE_USERS=0
FOMO_START_DELAY_SECONDS=0
```

Server 250 result with that configuration:

| Scope | Duration | 429 | 503 | Errors |
|---|---:|---:|---:|---:|
| 60 users | 3.8s | 0 | 0 | 0 |
| 271 users | 17.7s | 0 | 0 | 0 |

Local workstation result: 60 users 5.0s; 271 users 24.2s. With
`FOMO_CYCLE_USERS=0` every cycle covers all 271 users; with a 60s idle
interval, start-to-start is about 78s. These measurements are per-egress-IP:
re-probe if the server IP or Cloudflare edge changes. Do not lower
`FOMO_REQUEST_DELAY_MS` below 62ms without a new probe.

## systemd

```bash
cp fomo-swaps-crawler.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fomo-swaps-crawler
journalctl -u fomo-swaps-crawler -f
```

`FOMO_START_DELAY_SECONDS=900` lets you run a manual `--once` first without
starting the daemon immediately. The unit uses the project venv Python so
`curl_cffi` is available.
