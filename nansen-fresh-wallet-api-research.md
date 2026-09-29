# Nansen official API — fresh-wallet metric research

Date: 2026-09-28. Source: docs.nansen.ai (official API reference).

## Verdict

The official Nansen API does **NOT** expose `freshWalletBalancePercent` (or any
"% of supply held by fresh wallets") field. That metric is only in the internal
web endpoint `https://app.nansen.ai/api/questions/tgm-holders-gini-stats`.

The official API's only fresh-wallet surface is **flow**, not **balance/supply %**:
`POST https://api.nansen.ai/api/v1/tgm/flow-intelligence`.

## Fresh wallets in the official API (the ONLY place)

Endpoint: `POST /api/v1/tgm/flow-intelligence`
Docs: https://docs.nansen.ai/api/token-god-mode/flow-intelligence
Overview row: https://docs.nansen.ai/api/overview — "Summary of token flows
across Smart Money, exchanges, Top PnL Traders, Public Figures, Whales, Fresh Wallets"

Request fields: `chain`, `token_address`, `timeframe` (`5m|1h|6h|12h|1d|7d`),
`pagination`, `filters`, `order_by`.

Response fresh-wallet fields:
- `fresh_wallets_net_flow_usd` — net flow (USD) for fresh wallets. **Only 1d & 7d timeframes.**
- `fresh_wallets_avg_flow_usd` — avg absolute flow (USD). Only 1d & 7d.
- `fresh_wallets_wallet_count` — **always 0 for 1d/7d, null for shorter; count is not tracked separately.**

=> These are USD inflow/outflow numbers over a timeframe. There is no balance,
no holdings amount, no ownership %, and no holder count.

## What the official API does NOT have

- No `freshWalletBalancePercent`, `fresh_wallet_balance_percent`, `new_wallets`,
  `holder_age`, or `first_seen` field anywhere in the documented schemas.
- `tgm/holders` `label_type` enum: `whale | public_figure | smart_money | all_holders | exchange`.
  There is **no** `fresh_wallet` label type.
  Response per holder: `address`, `name`/`address_label`, `token_amount`,
  `total_outflow`, `total_inflow`, `balance_change_24h/7d/30d`,
  `ownership_percentage`, `value_usd`.
  Docs: https://docs.nansen.ai/api/token-god-mode/holders
- `tgm/flows` `label` enum: `whale | public_figure | smart_money | top_100_holders | exchange`.
  No fresh-wallet label. Docs: https://docs.nansen.ai/api/token-god-mode/flows
- `tgm/token-screener` mentions "fresh wallet inflows" in a use-case blurb but
  exposes no fresh-wallet field (`netflow`, `inflow_fdv_ratio` only).
  Docs: https://docs.nansen.ai/api/token-god-mode/token-screener

## Token God Mode (TGM) endpoint list

| Endpoint | Exposes |
|---|---|
| POST /api/v1/tgm/token-information | market cap, volume, holders, traders |
| POST /api/v1/tgm/nansen-indicators | risk/reward indicators for a token |
| POST /api/v1/tgm/token-ohlcv | OHLCV |
| POST /api/v1/tgm/token-screener | token screening, netflow, inflow/outflow-FDV ratios |
| POST /api/v1/tgm/flow-intelligence | net flow + avg flow + wallet count per cohort **incl. fresh_wallets (1d/7d)** |
| POST /api/v1/tgm/holders | top holders, smart money, exchange, whale, public figure balances + ownership_percentage |
| POST /api/v1/tgm/flows | inflow/outflow by label over time (no fresh wallet) |
| POST /api/v1/tgm/who-bought-sold | recent buyers/sellers summary |
| POST /api/v1/tgm/dex-trades | DEX trades |
| POST /api/v1/tgm/transfers | top token transfers |
| POST /api/v1/tgm/jup-dca | Jupiter DCA orders (Solana) |
| POST /api/v1/tgm/pnl-leaderboard | addresses + realised/unrealised PnL |
| POST /api/v1/tgm/perp-* | perp positions/trades/screener/leaderboards (Hyperliquid) |
| POST /api/v1beta1/tgm/historical-top-holders | top holders at `as_of_date` (beta) |

Overview: https://docs.nansen.ai/api/overview

## Closest alternatives for a freshness signal

1. **Flow-based proxy** — `flow-intelligence` `fresh_wallets_net_flow_usd` /
   `fresh_wallets_avg_flow_usd` (1d/7d). Closest official substitute, but it is
   net USD flow, not supply share, and the wallet count is unusable (always 0).
2. **Per-wallet freshness** — `POST /api/v1/profiler/address-first-funder`
   (first funder of a wallet) plus `POST /api/v1/profiler/address/labels`.
   Lets you classify individual wallets yourself, then join against
   `tgm/holders` `ownership_percentage` to approximate a fresh-wallet supply %.
   Docs: https://docs.nansen.ai/api/profiler/address-first-funder
   and https://docs.nansen.ai/api/profiler/address-labels
3. **Self-computed** — take `tgm/holders` (`token_amount` / `ownership_percentage`
   per address) and classify each holder as fresh via first-funder/age, then sum.

## Docs index

- llms.txt (complete endpoint index): https://docs.nansen.ai/llms.txt
- Base URL: `https://api.nansen.ai`, auth header `apikey: <KEY>`.
