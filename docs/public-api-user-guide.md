# Signal Scan Public API — User Guide

**API version:** v1  
**Base URL:** `https://signal-scan.duckdns.org/api/v1`  
**WebSocket URL:** `wss://signal-scan.duckdns.org/api/v1/ws`  
**API type:** Read-only. Responses are built from data currently stored by Signal Scan.

This guide is for API consumers. Public endpoints do not require an account, API key, or `Authorization` header.

> **Privacy notice:** The API does not identify callers. Wallet addresses, wallet profiles, and wallet-watch trades are publicly accessible. Do not send internal credentials or user login credentials to these endpoints.

## Quick start

Check the public service:

```bash
curl -sS https://signal-scan.duckdns.org/api/v1/status
```

Successful response:

```json
{"status":"ok","version":"v1"}
```

Fetch one page of tokens:

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/tokens?limit=10&offset=0'
```

Connect to the live inflow stream from a browser:

```js
const ws = new WebSocket('wss://signal-scan.duckdns.org/api/v1/ws');

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'ready') {
    console.log('Connected. Alert cursor:', message.afterId);
  } else if (message.type === 'inflow') {
    console.log('New inflow:', message.data);
  }
});

ws.addEventListener('close', (event) => {
  console.log('WebSocket closed:', event.code, event.reason);
});
```

## General behavior

- REST uses HTTPS; WebSocket uses WSS.
- Query parameters are passed in the URL. GET endpoints do not require a request body.
- Responses are JSON with `camelCase` fields, except for the `after_id` query parameter.
- Timestamps are Unix epoch time in **milliseconds**.
- Missing values may be `null` or an empty array, depending on the field. Do not treat `null` as zero unless that matches your application’s semantics.
- Supported chains: `sol`, `base`, `bsc`, `robinhood`.
- Responses represent stored state and stored history. The API does not reconstruct expired source data or backfill missing history.
- This API is read-only. It does not provide dashboard write operations.

### Browser CORS policy

The REST API does **not** enable cross-origin browser access. A page served from another origin cannot call these REST endpoints directly with browser `fetch`; the browser blocks the response because it has no `Access-Control-Allow-Origin` header. This was verified against the deployed endpoint from an external browser origin.

Use one of these patterns:

1. **Same-origin page:** if the page is served from `https://signal-scan.duckdns.org`, call REST with a relative URL such as `/api/v1/alerts`.
2. **External website:** call the public REST API from your own backend, then expose only the data your frontend needs through your own origin. Do not add an unrestricted CORS proxy.
3. **Live WebSocket:** a browser on another origin can connect to the public WSS endpoint for live events. REST catch-up after reconnect must still run server-side unless the page is same-origin.

`curl`, Node.js, and other server-side HTTP clients are not subject to browser CORS enforcement.

## Endpoint catalog

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/status` | Public service status. |
| `GET` | `/chains` | Supported chains. |
| `GET` | `/tiers` | Supported tiers. |
| `GET` | `/tokens` | Paginated token snapshot. |
| `GET` | `/tokens/{chain}/{address}` | Token details. |
| `GET` | `/tokens/{chain}/{address}/market` | Token market fields. |
| `GET` | `/tokens/{chain}/{address}/metrics` | Token metrics. |
| `GET` | `/tokens/{chain}/{address}/history` | Stored token history. |
| `GET` | `/tokens/{chain}/{address}/detail` | Distribution metrics and top-100 holder table. |
| `GET` | `/tokens/{chain}/{address}/balance-chart` | Top-100 balance series (`day`, `week`, `month`). |
| `GET` | `/tokens/{chain}/{address}/activity` | Time-bounded wallet-watch activity aggregates. |
| `GET` | `/alerts` | Alert observations ordered by ID. |
| `GET` | `/wallets` | Paginated tracked-wallet records. |
| `GET` | `/wallets/{id}/trades` | Time-bounded wallet-watch trades ordered by ID. |
| `WS` | `/ws` | Live stream of new `trackerBuy` inflow alerts. |

Append each path to the Base URL. For example, `/tokens/sol/So111...` becomes `https://signal-scan.duckdns.org/api/v1/tokens/sol/So111...`.

## Service and catalogs

### `GET /status`

```json
{"status":"ok","version":"v1"}
```

This reports that the public API process is responding. It does not confirm that the backend export source is healthy; data endpoints can still return `502`.

### `GET /chains`

```json
{"data":["sol","base","bsc","robinhood"]}
```

### `GET /tiers`

```json
{"data":["S+","S","A+","A","B+","B","P"]}
```

## Tokens and market data

### Token list — `GET /tokens`

| Parameter | Default | Bounds | Meaning |
| --- | ---: | ---: | --- |
| `limit` | `50` | `1–100` | Maximum number of tokens in the page. |
| `offset` | `0` | `0–1000000` | Starting position in the current list. |

Example:

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/tokens?limit=50&offset=0'
```

Response:

```json
{
  "generatedAt": 1700000000000,
  "data": [
    {
      "id": "sol:token-address",
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
          "marketCap": 1700000000000,
          "volume24h": 1700000000000,
          "holders": 1700000000000,
          "fresh": 1700000000000,
          "symbol": 1700000000000,
          "icon": 1700000000000
        }
      },
      "metrics": {
        "score": 3,
        "pass": {"fresh": true, "t100": true, "lf": false},
        "fresh": 24.7,
        "rawFresh": 24.7,
        "freshCurrent": true,
        "freshUpdatedAt": 1700000000000,
        "t100": {"pct": 25, "multiple": 1.25},
        "lf": 69000000,
        "trackedHolding": 4.2,
        "trackedInflow": 1250,
        "trackedActivityAt": 1700000000000
      },
      "balanceRange": {
        "d1": {"peak": 1200, "trough": 900},
        "d7": null,
        "d30": null
      },
      "history": {
        "marketCap": [{"t": 1700000000000,"value":1000000}],
        "holders": [],
        "fresh": [],
        "t100": [{"t": 1700000000000,"value":25,"peakBalance":69000000,"troughBalance":52000000}]
      }
    }
  ],
  "nextOffset": 50
}
```

`nextOffset` is the offset for the next page. `null` means the current list has no more rows. Offset pagination can shift if the token list changes between requests.

### Token details and subresources

```text
GET /tokens/{chain}/{address}
GET /tokens/{chain}/{address}/market
GET /tokens/{chain}/{address}/metrics
GET /tokens/{chain}/{address}/history
```

Examples:

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/tokens/sol/So11111111111111111111111111111111111111112'
curl -sS 'https://signal-scan.duckdns.org/api/v1/tokens/sol/So11111111111111111111111111111111111111112/market'
```

Token detail returns the token object directly. Each subresource returns `{ "data": ... }`. Fields may be `null` if the source has no value. `chain` must be supported; address/CA must be 1–128 characters. A token, subresource, or detail request returns `404` when the token has no stored state; `502` means the private backend is unavailable.

`metrics.trackedHolding` is the tracked-wallet token amount as a percentage of token supply (`0` when supply is unknown). Alert `snapshot.trackedHoldingPct` is the same measure captured when the alert was stored (`null` when no token state was available).

`metrics.fresh` is the gated Fresh-wallet percentage the dashboard emits (`null` when the factor is hidden); `metrics.rawFresh` is the ungated measurement. `metrics.trackedInflow` is net USD over the trailing 24h (may be negative) and `metrics.trackedActivityAt` is the newest tracked buy/sell timestamp (`0` when none). `balanceRange` is `null` until balance snapshots exist, and each window is `null` independently. `iconUrl` is relative to the API origin; the dashboard serves `/api/token-avatar/...` publicly.

### Token detail and balance chart

```text
GET /tokens/{chain}/{address}/detail
GET /tokens/{chain}/{address}/balance-chart?window=day|week|month
```

Detail returns distribution metrics plus the top-100 holder table:

```json
{
  "ca": "token-address", "chain": "sol", "price": 0.001, "supply": 1000000000, "holders": 1200,
  "freshSupplyPct": 24.7, "top100SupplyPct": 25, "medianHolderAmount": 500000, "medianHolderUsd": 500,
  "top100": [{
    "address": "holder-address", "percentOwnership": 5, "balance": 50000000, "balanceUsd": 50000,
    "addrType": 1, "isNew": false, "chg24h": 1.5, "name": "entity-label"
  }],
  "snapshotAt": 1700000000000
}
```

Missing scalars are `null`; `top100` is empty when no snapshot exists. `addrType` is the source classification. Detail returns `404` when the token has no stored state. Top-100 addresses/labels are public on-chain data but reveal wallet correlation; handle them accordingly.

Balance chart returns the top-100 cohort's total balance series:

```json
{
  "source": "nansen",
  "points": [{"t": 1700000000000, "total": 69000000, "totalUsd": 69000, "holders": 100, "inflow": 1200}],
  "cachedAt": 1700000000000
}
```

`window` defaults to `day`; invalid values return `400`. `source` is `nansen` for a cached Nansen series or `snapshots` for the local fallback. `t` is epoch milliseconds; optional fields are `null` when unavailable. The endpoint serves cache/snapshots without a synchronous upstream fetch; a stale cached series may trigger a background refresh.

## Token activity

### `GET /tokens/{chain}/{address}/activity`

`from` and `to` are optional Unix epoch-millisecond timestamps defining the half-open interval **`[from, to)`**. If omitted, they default to the last 24 hours through the current time. The interval must be positive and no longer than 31 days.

Example:

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/tokens/sol/So11111111111111111111111111111111111111112/activity?from=1700000000000&to=1700086400000'
```

```json
{
  "chain": "sol",
  "ca": "token-address",
  "from": 1700000000000,
  "to": 1700086400000,
  "buys": 3,
  "sells": 1,
  "buyUsd": 1200,
  "sellUsd": 300,
  "netInflowUsd": 900
}
```

Aggregates use stored wallet-watch trades, not FOMO activity. `netInflowUsd = buyUsd - sellUsd`.

## Alerts REST

### `GET /alerts`

| Parameter | Default | Bounds | Meaning |
| --- | ---: | ---: | --- |
| `after_id` | `0` | Non-negative integer | Return alerts whose IDs are greater than this cursor. |
| `limit` | `50` | `1–100` | Maximum number of alerts in the page. |

Example:

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/alerts?after_id=0&limit=50'
```

```json
{
  "data": [
    {
      "id": 42,
      "ca": "token-address",
      "chain": "sol",
      "metric": "trackerBuy",
      "value": 250,
      "responseAt": 1700000000000,
      "snapshot": {
        "capturedAt": 1700000000000,
        "symbol": "TICKER",
        "marketCap": 1000000,
        "marketCapAt": 1700000000000,
        "freshPct": 24.7,
        "t100Multiple": 1.25,
        "lf": 69000000,
        "trackedHoldingPct": 4.2,
        "iconUrl": "/api/token-avatar/sol/token-address",
        "xHandle": "token_x"
      }
    }
  ],
  "nextId": 42,
  "oldestAvailableId": 1,
  "gap": false
}
```

`metric` can be `fresh`, `t100`, or `trackerBuy`. REST returns all alert types; WebSocket streams only `trackerBuy`. `nextId` is the cursor for the next request. If there are no newer rows, it remains at the supplied cursor. `oldestAvailableId` can be `null` when no alerts are stored.

`gap: true` means the supplied cursor predates the retained alert range, commonly because older rows were pruned. Pruned rows cannot be recovered; continue from the retained range and record that a gap occurred.

Alert DTOs exclude buyer identities, FOMO metadata, and dashboard notes.

## Live inflow WebSocket

### Connect

```text
wss://signal-scan.duckdns.org/api/v1/ws
```

No API key is required. The stream is server-to-client; clients must not send commands or subscription messages.

The server sends one `ready` message after connection setup:

```json
{"type":"ready","afterId":42}
```

`afterId` is the latest stored alert ID at connection initialization. After that, each newly stored alert with `metric: "trackerBuy"` is sent as:

```json
{
  "type": "inflow",
  "data": {
    "id": 43,
    "ca": "token-address",
    "chain": "sol",
    "metric": "trackerBuy",
    "value": 250,
    "responseAt": 1700000000000,
    "snapshot": {
      "capturedAt": 1700000000000,
      "symbol": "TICKER",
      "marketCap": 1000000,
      "marketCapAt": 1700000000000,
      "freshPct": 24.7,
      "t100Multiple": 1.25,
      "lf": 69000000,
      "trackedHoldingPct": 4.2,
      "iconUrl": "/api/token-avatar/sol/token-address",
      "xHandle": "token_x"
    }
  }
}
```

`value` is the USD value stored on the alert; `responseAt` is the timestamp of the stored trade event. An inflow is sent only after the alert has been stored successfully. A duplicate trade that is deduplicated does not create a new alert. Sells, `fresh`, and `t100` alerts are not streamed.

### Browser: receive live events

A browser on any origin can open the public WebSocket and receive live events:

```js
const ws = new WebSocket('wss://signal-scan.duckdns.org/api/v1/ws');

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'ready') {
    console.log('Connected. Alert cursor:', message.afterId);
  } else if (message.type === 'inflow') {
    console.log('New inflow:', message.data);
  }
});
```

The WebSocket stream does not replay events missed while disconnected. Deduplicate by `data.id` in the consumer.

### Recover missed events after reconnect

Use `GET /alerts?after_id=<saved-id>` to catch up after reconnect. The REST request is subject to browser CORS. For a browser page hosted on `signal-scan.duckdns.org`, use a same-origin relative URL such as `/api/v1/alerts`. A page hosted on a different origin cannot fetch this REST endpoint directly; perform catch-up in your application backend and return the result to your frontend through your own same-origin endpoint.

The following Node.js 20+ example runs in a backend process. It uses the `ws` package for WebSocket and Node’s built-in `fetch`, so browser CORS does not apply. Install the client dependency with `npm install ws`.

```js
import { WebSocket } from 'ws';

const API = 'https://signal-scan.duckdns.org/api/v1';
const WS_URL = `${API.replace('https:', 'wss:')}/ws`;
let lastProcessedId = null; // Replace with durable storage if restart recovery is required.
let queue = Promise.resolve();
let retryDelayMs = 1000;

async function catchUp(afterId, throughId) {
  let cursor = afterId;
  while (cursor < throughId) {
    const url = new URL(`${API}/alerts`);
    url.searchParams.set('after_id', String(cursor));
    url.searchParams.set('limit', '100');

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Alert catch-up failed: HTTP ${response.status}`);
    const page = await response.json();
    if (page.gap) console.warn('Alert history gap: older rows have been pruned.');

    for (const alert of page.data) {
      if (alert.id > throughId) break;
      if (alert.metric === 'trackerBuy') await handleInflow(alert);
      // Advance past every alert type; REST returns more than inflow events.
      lastProcessedId = alert.id;
    }

    if (page.nextId <= cursor) break;
    cursor = Math.min(page.nextId, throughId);
    lastProcessedId = Math.max(lastProcessedId, cursor);
  }
}

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.on('message', (raw) => {
    queue = queue.then(async () => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ready') {
        if (lastProcessedId === null) {
          // First connection: start live at the server-provided cursor, no history replay.
          lastProcessedId = message.afterId;
        } else {
          // Reconnect: recover stored inflows up to the new connection's ready cursor.
          await catchUp(lastProcessedId, message.afterId);
        }
        return;
      }

      if (message.type === 'inflow' && message.data.id > lastProcessedId) {
        await handleInflow(message.data);
        lastProcessedId = message.data.id;
      }
    }).catch((error) => console.error('Signal Scan consumer error:', error));
  });

  ws.on('open', () => { retryDelayMs = 1000; });
  ws.on('close', () => {
    setTimeout(connect, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 30000);
  });
  ws.on('error', (error) => console.error('Signal Scan WebSocket error:', error.message));
}

async function handleInflow(alert) {
  // Replace with application logic. Persist/commit by alert.id for idempotency.
  console.log(alert.chain, alert.ca, alert.value, alert.id);
}

connect();
```

This example keeps its cursor in memory; persist `lastProcessedId` durably if the consumer must recover after a process restart. If `gap` is `true`, pruned alerts cannot be recovered. Production consumers should also define how to handle fetch failures and event-processing failures without advancing their durable cursor prematurely.

### Heartbeat, limits, and close behavior

- The server sends ping frames about every 25 seconds. Standard WebSocket clients answer with pong automatically; do not disable pong handling.
- The HTTPS proxy has a 75-second read-idle timeout. Heartbeats keep an idle connection alive.
- At most 64 concurrent WebSocket connections are accepted per process. Excess handshakes receive HTTP `503`.
- The feed is polled once per process and shared among connected clients.
- Slow consumers may be disconnected to protect memory. Reconnect and perform REST catch-up as described above.
- If the backend export source is unavailable during connection setup or polling, the server closes the connection with `1011`. Client messages are rejected with `1008`; a slow consumer may be closed with `1013`.
- Do not assume exactly-once delivery across reconnects. Deduplicate by alert ID and use the REST cursor for catch-up.

## Wallets and wallet trades

### Wallet list — `GET /wallets`

`limit` defaults to `50` and is bounded to `1–100`; `offset` defaults to `0` and is bounded to `1000000`.

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/wallets?limit=50&offset=0'
```

```json
{
  "data": [
    {"id":"wallet-id","address":"wallet-address","chain":"sol","name":"Wallet","tags":["whale"],"clan":null}
  ],
  "nextOffset": 50
}
```

Wallet addresses, names, and tags are public. Offset pages can shift when the wallet list changes.

### Trades — `GET /wallets/{id}/trades`

| Parameter | Default | Bounds | Meaning |
| --- | ---: | ---: | --- |
| `from` | 24 hours ago | — | Unix epoch ms, inclusive. |
| `to` | Current time | — | Unix epoch ms, exclusive. |
| `after_id` | `0` | Non-negative integer | Trade ID cursor. |
| `limit` | `50` | `1–100` | Maximum rows in a page. |

The interval must be positive and no longer than 31 days. Only stored `source=watch` trades are returned; the interval is `[from, to)`.

```bash
curl -sS 'https://signal-scan.duckdns.org/api/v1/wallets/wallet-id/trades?from=1700000000000&to=1700086400000&after_id=0&limit=50'
```

```json
{
  "data": [
    {
      "id": 17,
      "walletId": "wallet-id",
      "ca": "token-address",
      "chain": "sol",
      "ts": 1700000000000,
      "side": "buy",
      "amountUsd": 250,
      "price": 0.001,
      "tx": "transaction-id"
    }
  ],
  "nextId": 17
}
```

`nextId` is the last row ID to use as the next `after_id`; `null` means there is no next page for the current query. Trades outside the selected time range are excluded.

## Pagination and request limits

- `limit` defaults to `50` and is bounded to `1–100` for token, wallet, trade, and alert lists.
- `offset` is used for token and wallet lists and is bounded to `1000000`.
- `after_id` is used for alerts and trades and must be a non-negative integer.
- Activity and trade time ranges use epoch milliseconds and the half-open interval `[from, to)`, with a maximum span of 31 days.
- The HTTP quota is shared by all callers: 120 requests per minute per process. A `429` response includes `Retry-After` in seconds.
- At most 16 HTTP requests are processed concurrently; excess requests may receive `503`.
- The WebSocket limit is 64 concurrent connections per process and is independent of the HTTP quota.
- Quotas and caches are process-local; production runs one public API replica to keep behavior consistent.

## Errors and recovery

API-generated errors commonly use this shape:

```json
{"error":"invalid pagination"}
```

| HTTP/status | Common cause | Consumer action |
| ---: | --- | --- |
| `400` | Invalid chain/address, pagination, or time range. | Correct the path/query; do not retry the same invalid request. |
| `429` | HTTP quota exceeded; `Retry-After` is included. | Wait at least the indicated duration, then retry with backoff. |
| `502` | Private backend export failed, is unconfigured, or timed out. | Retry with backoff; avoid tight loops. |
| `503` | HTTP concurrency limit or WebSocket connection cap. | Retry HTTP later; wait before reconnecting WebSocket. |
| WebSocket `1011` | Backend data source unavailable during stream setup or polling. | Reconnect with backoff; use REST status/catch-up as appropriate. |
| WebSocket `1013` | Consumer is reading too slowly. | Reduce processing/backlog, reconnect, then catch up via REST. |

Network/proxy failures may not return JSON. A successful `GET /status` does not guarantee that every backend data endpoint is ready.

## Data and security notes

- The API is public and read-only; it has no caller identity or API keys.
- Wallet addresses, wallet profiles, and wallet-watch trades are public to all callers.
- Alert responses omit buyer identities and FOMO metadata; the API cannot be used to retrieve buyer identities.
- Only retained, stored data is returned. REST cursors can report `gap` after older rows have been pruned.
- Never put `PUBLIC_API_EXPORT_TOKEN` in a client, browser bundle, URL, or request to a public endpoint. That credential is only for service-to-service access to the private backend export.
- The API does not expose dashboard write operations, login, FOMO data, or internal dashboard notes.
