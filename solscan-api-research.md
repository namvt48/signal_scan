# Solscan Pro API v2 — research for signal_scan

Date: 2026-09-23. All numbers from provider-owned pages (solscan.io, pro-api.solscan.io, docs.solscan.io, info.etherscan.com).
Fact not published = marked "NOT PUBLISHED".

## Verdict
- Holder data EXISTS: `token/holders` returns a rank-sorted holder list (address, amount, USD value, % of supply) + `data.total` = holder count. This is the crux and it is YES.
- No pre-bucketed cohort endpoint. Cohort/distribution = paginate (max 40/page) + aggregate client-side. Top-100 = 3 calls.
- One request per token; no holders-multi. Batch only for meta (max 50) and price (deprecated), and Lite disables all "multi".
- Free tier exists but its quota/RPS are NOT PUBLISHED.
- ToS is restrictive: personal-use cache allowed, commercial redistribution / competing service prohibited.

## 1. Token endpoints (base https://pro-api.solscan.io)
| Endpoint | Path | Key fields |
|---|---|---|
| Token Meta | `GET /v2.0/token/meta?address=` | address, name, symbol, icon, decimals, price, volume_24h (deprecated), market_cap, market_cap_rank, price_change_24h, supply (string), holder (count), creator, create_tx, created_time, first_mint_tx, first_mint_time, metadata |
| Token Meta Multi | `GET /v2.0/token/meta/multi?address[]=` | same as above; max 50 addresses |
| Token Price (DEPRECATED) | `GET /v2.0/token/price?address=&from_time=&to_time=&time[]=` | price points; `time[]` param deprecated |
| Token Price Multi (DEPRECATED) | `GET /v2.0/token/price/multi` | batch price |
| Token Holders | `GET /v2.0/token/holders?address=&page=&page_size=&from_amount=&to_amount=&from_value=&to_value=` | items[]: address (token account), amount, amount_str, decimals, owner (wallet), rank (largest first), value (USD), percentage; data.total = holder count. page_size ∈ {10,20,30,40} |
| Token Transfer | `GET /v2.0/token/transfer?address=&activity_type=&from=&exclude_from=&to=&exclude_to=&amount=&from_time=&to_time=&value=&page=&page_size=&sort_by=&sort_order=` | block_id, trans_id, block_time, time, activity_type (enum ACTIVITY_SPL_*), from_address, to_address, token_address, token_decimals, amount (raw). page_size ∈ {10..100} |
| Token Markets | `GET /v2.0/token/markets?token=&sort_by=&program=&page=&page_size=` | pool_id, program_id, token_1, token_2, token_account_1/2, total_trades_24h, total_trades_prev_24h, total_volume_24h, total_volume_prev_24h, total_tvl, num_trader_24h, num_trader_prev_24h |
| Others | token/list, token/top (top TOKENS), token/trending, token/latest, token/historical-data, token/search, token/defi/activities (+export) | |
| Market (separate) | market/list, market/info, market/volume (historical), market/positions | pool + historical market data |

CU cost: flat 100 CU/call for every endpoint (Nov pricing update).

## 2. Holder cohort / distribution
- Top holders: YES — `token/holders` sorted by `rank` from largest; each row carries `value` (USD) and `percentage` of supply.
- Holder count: YES — `data.total` and `token/meta.holder`.
- Cohort slicing: filters `from_amount`/`to_amount` (raw token) and `from_value`/`to_value` (USD) let you query ranges, then aggregate client-side. No server-side bucket summary.
- Caveats: rows are token accounts; same wallet (`owner`) can appear multiple times. Max 40 rows/page.
- Marketing confirms: `https://solscan.io/apis` → `/token/*`: "holder lists, holder counts, top holders, token info, and token inventory".
- `token/top` = top tokens, NOT top holders.

## 3. Free tier
- Provider states a free key exists: "Free API key — no cost, with a lower rate limit and access to core endpoints." `docs.solscan.io/build-with-ai/solscan-mcp`
- Exact requests/day, requests/month, RPS: NOT PUBLISHED (checked solscan.io/apis live — plan cards no longer render publicly; Lite page references "the standard Free tier" without numbers).
- API key required (header `token:`). Free key = email signup, no card. Card (Stripe) only for paid.
- Undocumented keyless "Public API" referenced in llms.txt (`reference/chaininfo`); limits NOT PUBLISHED.

## 4. Paid tiers (2026)
From `pro-api.solscan.io/pro-api-docs/v2.0/docs/packages_endpoint_allocation`:
| Plan | Price/mo | Monthly CU | Rate limit (req/60s) | Calls/mo @100CU |
|---|---|---|---|---|
| Lite | $49 | 20,000,000 | 1,000 | 200,000 |
| Level 2 | $199 | 150,000,000 | 1,000 | 1,500,000 |
| Level 3 | $399 | 500,000,000 | 2,000 | 5,000,000 |
| Level 4 | $1,099 | 1,500,000,000 | 3,000 | 15,000,000 |
| Enterprise | Contact | Contact | Contact | custom |

From `docs.solscan.io/solscan-api/solscan-pro-api-endpoints` (human table) — Level 2 $199, Level 3 $399, Level 4 $1,099, Enterprise; Lite and Free omitted (possible discontinuation/newer page). DISCREPANCY — verify before buying.
Discounts: every 6 months 20% off, yearly 35% off (solscan.io/apis). Pix: Stripe card; crypto min 6-month commitment; no refunds.

## 5. 2026 changes
- Ownership: Etherscan acquired Solscan, announced 2024-01-03 — `info.etherscan.com/solscan-acquisition/`.
- v1: still published (`pro-api.solscan.io/pro-api-docs/v1.0`); keys for V1 and V2 in dashboard. NO provider announcement of v1 sunset found = NOT PUBLISHED.
- v2 partial deprecations: Token Price and Token Price Multi marked "Deprecated: Yes". CU table lists not-yet-referenced replacements: Token Latest Price Data, Token Historical Price Data, Token Historical Data, Token Search.
- CU unification to flat 100 "starting in November".
- Terms of Service page header shows "Last updated: Aug 19, 2026".
- No published 2026 notice of free-tier removal or price change found.
- Caution: some `pro-api.solscan.io/.../*.md` pages read as AI-generated (contain "Gap to flag" editorial text). Prefer docs.solscan.io GitBook tables.

## 6. Terms of service
`solscan.io/terms-of-service` (last updated Aug 19, 2026):
- Limited personal, non-commercial license; no automated extraction; "reproduction of any content ... extracted from our APIs, CSV exports or our website" without prior consent prohibited.

`docs.solscan.io/solscan-api/solscan-api-terms-and-services`:
- Grant of License: limited, non-exclusive, non-transferable license to use API Services to develop/test/support your Applications ("One (1) App License").
- IP Rights: may "view, print, download, cache and make copies ... strictly for personal use only and not for commercial use"; no reproduce/publish/distribute/sell/create derivative.
- Prohibited: copy/modify/recreate data; use data to build a directly competing service; resale; sell/rent/license API Content for commercial purposes.
- Non-Competition: cannot build/offer software with substantially similar function to Solscan's (e.g., Explorer Services); survives cancellation.
- Net for signal_scan: private internal dashboard under a paid subscription = defensible (App License). Public product replicating explorer/holder data = high legal risk. Get written consent: support@solscan.io.

## 7. Batching & historical window
- One request per token for meta/holders/transfer/markets. Batch only `token/meta/multi` (max 50) and deprecated `token/price/multi`. No holders batch. Lite disables all "multi" endpoints.
- Historical: `token/transfer` from_time/to_time; `token/price` from_time/to_time (`time[]` deprecated); `token/historical-data`; `market/volume` + `market/positions`. `token/markets` = current 24h/prev-24h snapshot only.
- Small page caps → top-100 holders = 3 calls; deep history = many paged calls.

## Fit for signal_scan
CAN feed: symbol/name/decimals, supply, price, market cap, holder count, top-holders list + distribution, transfer history, market/pool data.
- Replaces DAS `getAsset` (meta/supply/price) — yes.
- Adds holder distribution you cannot get from raw RPC.
- Does NOT replace the Nansen crawl's labeled/smart-money intelligence (Solscan has account labels/metadata endpoints but not Nansen-style analyst PnL/labels).
- Nansen CF-403 problem unchanged by Solscan; Solscan itself rate-limits and CF-fronts its site (but API host pro-api.solscan.io is reachable server-side).
- Cost shape: holders/meta are 1 call/token. Hourly refresh of N tokens = 24×N calls/day/token. Lite's 200k calls/mo caps at roughly 555 calls/hr sustained.
