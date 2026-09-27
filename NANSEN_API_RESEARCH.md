# Nansen official API vs internal `tgm-holders-hourly-stats` crawl

Date: 2026-09-23. Sources: `https://api.nansen.ai/openapi.json` (live OpenAPI 3.1.0, 97 paths),
`https://docs.nansen.ai/*.md`, `nansen-ai/nansen-cli`.

## Verdict

The two metrics CAN be served by the official API. The equivalent endpoint is
**`POST https://api.nansen.ai/api/v1/tgm/flows`**, which accepts exactly the cohort
labels the internal crawl uses (`top_100_holders`, `exchange`) and returns a
**per-bucket time series** of cohort `token_amount` + `holders_count`.

The internal endpoint name `tgm-holders-hourly-stats` is the web-app's rendering of
the `tgm/flows` dataset: hourly buckets for ranges <= 7 days, daily for longer.

## Primary mapping

| Internal crawl | Official API |
|---|---|
| `GET/POST app.nansen.ai/api/questions/tgm-holders-hourly-stats` | `POST api.nansen.ai/api/v1/tgm/flows` |
| `{tokenAddress, chain:"solana", date, label:"top_100_holders", excludeExchanges}` | `{token_address, chain:"solana", date:{from,to}, label:"top_100_holders", filters, pagination, order_by}` |
| `label:"exchange"` (LF series) | `label:"exchange"` |
| header: none (headless Chrome session) | header: `apikey: <key>` (or x402/MPP) |

`TGMFlowsLabel` enum: `whale`, `public_figure`, `smart_money`, `top_100_holders` (default), `exchange`.
`TGMFlowsChain` enum includes `solana`.

Response item (`TGMFlows`) fields: `date` (RFC3339 inclusive bucket start),
`bucket_end` (exclusive), `is_complete`, `price_usd`, `token_amount`,
`value_usd`, `holders_count`, `total_inflows_count`, `total_outflows_count`,
`total_inflows_dex`, `total_outflows_dex`, `total_inflows_cex`, `total_outflows_cex`
(last four only populated when `label=exchange`, else null + a `warnings` entry).

Bucket granularity: **hourly when the requested range is <= 7 days, daily for longer ranges.**
`is_complete=false` marks buckets truncated by the request window or still live.

Credit cost: **1 per call** (Free and Pro) per the credits table.
Tier: "Basic" ($0.01/call) on the x402 pay-per-request ladder.

## Other holder endpoints (not the series you need)

| Endpoint | Returns | Time series? | Credits |
|---|---|---|---|
| `POST /api/v1/tgm/holders` | Point-in-time per-address list; `label_type` incl `exchange`; fields token_amount + balance_change_24h/7d/30d (changes, not series) | No | 5 (150 if `premium_labels=true`) |
| `POST /api/v1beta1/tgm/historical-top-holders` | Per-address snapshot list at one `as_of_date`; `label_type` incl `all_holders`/`exchange`/`smart_money`/`whale`; chains base/bnb/ethereum/**solana** | No (one date per call; iterate + sum to reconstruct) | 25 |
| `POST /api/v1/smart-money/historical-holdings` | Aggregated cohort balance, **daily snapshots**, date_range, max ~4yr | Yes, but smart-money cohort only | (historical SM family; verify) |
| `POST /api/v1beta1/smart-money/historical-token-balances` | Point-in-time SM aggregates | No | 25 |
| `POST /api/v1/profiler/address/historical-balances` | Per-wallet balance snapshots | Yes, but per address | 1 |

## Parity gaps to verify before migrating

1. **`excludeExchanges` is not exposed** on `tgm/flows`. Filters accept only
   `price_usd`, `token_amount`, `value_usd`, `holders_count`, `total_inflows_count`,
   `total_outflows_count`. If the internal T100 series differs with `excludeExchanges=true`,
   the official `label=top_100_holders` definition must be diffed against it.
2. **Hourly only <= 7 days.** A genesis->trough series spanning more than a week is
   either daily-granularity or assembled from multiple <=7d calls.
3. Beta risk: historical-* endpoints are explicitly "subject to breaking changes".

## Recommendation

Before deleting the crawl, run a shadow diff for one token: fetch both series over the
same window and compare `token_amount` bucket-by-bucket. If they match, migrate.
