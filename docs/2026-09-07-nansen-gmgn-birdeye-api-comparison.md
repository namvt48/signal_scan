# API Capability Comparison — Nansen vs GMGN.ai vs Birdeye
**For:** CT Alpha Bot Signal Framework01 (memecoin/CT signal dashboard, BSC + Solana + Ethereum)
**Researched:** 2026-09-07 · Sources: official docs fetched live + web search (2025–2026 sources preferred)
**Method:** official docs (docs.nansen.ai, docs.birdeye.so, docs.gmgn.ai, github.com/GMGNAI/gmgn-skills) + websearch. Every claim cites a source; anything not confirmable from official material is marked **[unverified]**.

---

## 1. API availability & signup

| | Nansen | GMGN | Birdeye |
|---|---|---|---|
| Official API | ✅ Yes, public, self-serve | ✅ Yes — "GMGN Agent API / OpenAPI", self-serve key | ✅ Yes, public, self-serve |
| Signup | app.nansen.ai — free key, no sales call (academy: "No, you do not need a Pro subscription to use the API") | Key created at **gmgn.ai/ai** by uploading an Ed25519 public key (docs.gmgn.ai/index/gmgn-agent-api). **IPv4 only** — IPv6 not supported | bds.birdeye.so account → API key in settings (docs.birdeye.so reference OpenAPI description) |
| Docs URL | https://docs.nansen.ai (+ /api/overview, /getting-started/credits) | https://docs.gmgn.ai/index/gmgn-agent-api · full OpenAPI skill specs: github.com/GMGNAI/gmgn-skills | https://docs.birdeye.so (llms.txt index at /docs/llms.txt) |
| Interface | REST (all POST, JSON), x402/MPP pay-per-call; no documented WS | REST `/v1/*` routes via `gmgn-cli` / MCP skills; **GMGN Callout OpenAPI** exists for callbacks [name verified in docs nav; details not extracted → treat as unverified] | REST + **WebSocket** (Business tier+) |
| Scraping caveat | n/a | ✅ No scraping needed — official API is free & self-serve. Historical context: gmgn.ai web endpoints require login and return no structured data (GMGN's own skill docs instruct "Do NOT ... visit gmgn.ai to fetch this data") | n/a |

---

## 2. Pricing (API ≠ subscription, kept separate)

### Nansen
Source: docs.nansen.ai/getting-started/credits (+ academy.nansen.ai/articles/0938495)
- **Free plan:** 100 trial credits, **daily refill to 10 credits**; all Pro endpoints accessible
- **Pro subscription:** $49/mo (annual) or $69/mo (monthly) → includes **2,000 API credits/month** (one-time grant, refreshed monthly)
- **Credit top-ups:** **$10 per 10,000 credits = $0.001/credit** (bulk >5M discount via sales)
- Key credit costs: `tgm/flow-intelligence` 1, `tgm/holders` **5** (**150** with `premium_labels=true` — required for Smart Money/Fund labels), `tgm/token-information` 1, `tgm/dex-trades` 1, `tgm/token-ohlcv` 1, `tgm/token-screener` 1, smart-money/* 5, `tgm/historical-top-holders` 25
- **Alternative: pay-per-call x402/MPP (no account):** Basic $0.01/call, Premium/Smart-Money $0.05/call (docs.nansen.ai/getting-started/agentic-payments). Holders (without premium labels) and flow-intelligence fall in these tiers
- Rate limits: Free **15 rps / 300 rpm**; Pro **75 rps / 1500 rpm** (academy.nansen.ai/articles/0938495)

### GMGN
Source: docs.gmgn.ai (llms.txt contains **no pricing/subscription page**); gmgnguide.com cross-check 2026-08-06
- **API key: free.** No documented API subscription, paid tier, or per-call fee anywhere in the doc set **[checked llms.txt index 2026-09-07; absence-of-pricing = verified]**
- The **1% handling fee is per *transaction* (trading via gmgn-swap only)** — not applicable to data queries
- Rate limits: leaky-bucket **rate=20/capacity=20 → RPS = 20 ÷ weight (W)** per module, effective **2026-05-13** (official announcement quoted via outposts.io). Weights: token info/security/pool = 1, holders/traders/portfolio-holdings = 5 → ≈4 rps for holders. Secondary source (Medium, 2026-04): global IP 500 rps; per path+user market-data 100 rps; trade 10 rps **[unverified-official]**
- Caveat: free-tier keys may carry hidden quotas not in docs **[unverified]** — verify at signup

### Birdeye
Source: docs.birdeye.so/docs/pricing + docs.birdeye.so/docs/rate-limiting (canonical; birdeye.so/data-api/pricing marketing page shows slightly different CU allotments — docs table cited here)
| Plan | $/mo | CUs | Rate limit | WebSocket |
|---|---|---|---|---|
| Standard (free) | 0 | 30,000 | 1 rps | — |
| Lite | 39 | 1.5M | 15 rps | — |
| Starter | 99 | 5M | 15 rps | — |
| Premium | 199 | 15M | 50 rps / 1000 rpm | ✅ 500 conns |
| Business | 499 | 60M | 100 rps / 1500 rpm | ✅ 2000 conns + batch endpoints |
| Business B-15/B-30/B-50 | 899/1350/2050 | 150M/300M/500M | 150 rps | ✅ |
- Overage: $9.9/1M CU (Premium) → $6.9 (Business). Starter overage $19.9/1M
- Rate limit is **per account, shared across all APIs**
- CU cost per endpoint category documented in "Compute Unit Cost" page — **not extracted; must verify per-endpoint CU burn before committing** [unverified]

---

## 3. Chain coverage (target: BSC, Solana, Ethereum, Base)

| | BSC | Solana | Ethereum | Base | Others |
|---|---|---|---|---|---|
| Nansen (TGM holders chain enum) | ✅ `bnb` | ✅ | ✅ | ✅ | +20: arbitrum, avalanche, base, tron, ton, sui, hyperevm, monad, plasma, robinhood, … (docs.nansen.ai/api/token-god-mode/holders) |
| GMGN (CLI/chains table) | ✅ `bsc` | ✅ `sol` | ✅ `eth` | ✅ | robinhood, arc, stable (github.com/GMGNAI/gmgn-skills) |
| Birdeye (`x-chain` enum) | ✅ `bsc` | ✅ | ✅ | ✅ | 17 total: arbitrum, avalanche, optimism, polygon, zksync, monad, hyperevm, aptos, fogo, mantle, megaeth, robinhood, sui |

All three cover all 4 target chains. ✅

---

## 4. Data freshness / realtime

| | Nansen | GMGN | Birdeye |
|---|---|---|---|
| Freshness | Last ~24h **live**; older from hourly batch (lag ≤ ~1h); responses **cached 10–30 min** by timeframe (docs.nansen.ai/api/token-god-mode/flow-intelligence → Data Freshness section) | Real-time, minimum **1-minute** windows for trending/K-line; token info real-time (gmgn-skills README granularity table) | Real-time REST + WS. Token Overview supports custom `frames` down to **5-second intervals** (Solana) and 1m+ elsewhere (docs.birdeye.so/reference/get-defi-token_overview) |
| WebSocket | ❌ none documented | ❌ none documented (Callout OpenAPI callbacks possible [unverified]) | ✅ Premium+. Streams: price, txs, new listings, new pairs, large trades, wallet txs, token stats, meme filter, transfers (docs.birdeye.so/docs/websocket) |
| Nansen history depth | BSC from 2020-08-29, Solana 2020-03-17, ETH 2015 (docs.nansen.ai/api/data-coverage) | — | — |

---

## 5. Endpoint → metric mapping (verified routes only)

### Nansen (all `POST https://api.nansen.ai/api/v1/...`, header `apikey`)
- **Holders:** `tgm/holders` — label_type: all_holders/smart_money/exchange/whale/public_figure; filters incl. `ownership_percentage`, `value_usd`, `balance_change_24h/7d/30d`, `total_inflow/outflow`, sort by ownership_percentage; `premium_labels=true` unlocks Smart Money/Fund labels at 150 credits (docs.nansen.ai/api/token-god-mode/holders)
- **Fresh wallets:** `tgm/flow-intelligence` explicitly segments flows by "Smart Money, exchanges, Top PnL Traders, Public Figures, Whales, **Fresh Wallets**" (docs.nansen.ai/api/overview + flow-intelligence page)
- **Holder count / token stats:** `tgm/token-information` ("Marketcap, Volume, Holders, Traders")
- **Volume:** `tgm/dex-trades` (all DEX trades of a token), `tgm/token-ohlcv`; buy/sell flows `tgm/flows` (inflow/outflow from smart money, exchanges, whales), `tgm/who-bought-sold`
- **Exchange balances:** TGM holders `label_type: "exchange"`; netflow incl. CEX transfers
- **Wallet PnL / profiler:** `profiler/address/pnl-summary`, `profiler/address/pnl`, `profiler/address/current-balance`, `profiler/address/dex-trades`, `portfolio/defi-holdings`
- **Smart money stream:** `smart-money/netflows`, `smart-money/holdings`, `smart-money/dex-trades` (last 24h)
- **Screener:** `tgm/token-screener` (multi-chain realtime screening)

### GMGN (routes via GMGN OpenAPI, see github.com/GMGNAI/gmgn-skills SKILL.md tables)
- **Token:** `GET /v1/token/info` (price, liquidity, market cap, **holder count**, `stat.top_10_holder_rate`, socials), `GET /v1/token/security`, `GET /v1/token/pool_info`
- **Holders:** `GET /v1/market/token_top_holders` — limit max **100**; per-holder `amount_percentage` (0–1 of supply), `usd_value`, `addr_type` (**2 = exchange/LP** with `exchange` name), `is_new`, `is_suspicious`, `transfer_in`; `--tag` filter: **`fresh_wallet`**, `smart_degen`, `renowned` (KOL), `dev`, `sniper`, `rat_trader`, `bundler`, `dex_bot`, `bluechip_owner`. Aggregate counts in `wallet_tags_stat` (`smart_wallets`, `renowned_wallets`, `sniper_wallets`, `fresh_wallets`, …)
- **Volume:** token info `price.volume_{window}` / `buy_volume_{window}` / `sell_volume_{window}` (1m min)
- **Wallet:** `GET /v1/user/wallet_holdings` (PnL per position), `GET /v1/user/wallet_token_balance`, `POST /v1/user/wallet_profits` (**batch 1–100 wallets**, 1d/7d/30d/all), `GET /v1/user/wallet_activity`, `GET /v1/user/created_tokens`
- **Streams:** `GET /v1/user/kol`, `GET /v1/user/smartmoney` (real-time KOL/smart-money trades), `GET /v1/trade/follow_wallet`
- **Discovery:** `market trending` (real-time, 1m/5m/1h/6h/24h, filters: liquidity range, created<30m, min-smart-degen-count, not_honeypot, launchpad), Trenches new-token feed

### Birdeye (GET https://public-api.birdeye.so, header `X-API-KEY` + `x-chain`)
- **Token Overview:** `GET /defi/token_overview` — identity, market cap, FDV, supply, **holder count**, liquidity, price, **unique wallets, buy/sell counts, vBuy/vSell/v24hUSD** across frames 5s–24h (docs.birdeye.so/reference/get-defi-token_overview). Frames supported: solana, base, **bsc, ethereum**
- **Trade data:** `GET /defi/v3/token/trade-data/single` (buy/sell volume, unique wallets, per-frame)
- **Raw trades:** `GET /defi/txs/token`, `seek_by_time`, V3 filtered feeds, `Trades - Token Filtered By Volume (V3)` (docs.birdeye.so/reference/transactions)
- **Holder analytics, wallet portfolio & PnL, smart money, discovery, security** — confirmed as product categories in Birdeye docs overview text; the exact REST routes for token-holder lists, wallet PnL and token security exist in the docs tree but **page content was not extractable in this session → exact route names [unverified]**. The known-common routes (`/defi/token_holders`, `/defi/wallet/pnl`, `/defi/token_security`) must be confirmed against docs.birdeye.so/reference before coding
- **WebSocket (Premium+):** `SUBSCRIBE_TOKEN_NEW_LISTING`, `SUBSCRIBE_NEW_PAIR`, `SUBSCRIBE_LARGE_TRADE_TXS` (USD threshold), `SUBSCRIBE_WALLET_TXS` (1 wallet/conn), `SUBSCRIBE_TOKEN_STATS`, `SUBSCRIBE_MEME` — 100 tokens/conn for price/txs (docs.birdeye.so/docs/websocket)

---

## 6. Capability matrix — 9 spec columns

Legend: ✅ native endpoint · 🟡 partial/computable · ❌ not available · **[u]** = unverified detail

| # | Spec column | Nansen | GMGN | Birdeye |
|---|---|---|---|---|
| 1 | Token CA identity | ✅ `tgm/token-information` (1 cr) | ✅ `/v1/token/info` (W=1) | ✅ `token_overview` + metadata endpoints |
| 2 | Tracked-wallet holdings list | ✅ `profiler/address/current-balance`, `portfolio/defi-holdings` (1 cr each) | ✅ `/v1/user/wallet_holdings` (W=5), `wallet_token_balance`, batch `wallet_profits` (100 wallets) | 🟡 wallet portfolio category confirmed; exact REST route **[u]**; ✅ WS `SUBSCRIBE_WALLET_TXS` (1 wallet/conn, Premium+) |
| 3a | Fresh Wallet % among holders | 🟡 `tgm/flow-intelligence` has Fresh Wallets **flow** segment (1 cr); fresh % of *holders* not directly exposed | 🟡→✅ `wallet_tags_stat.fresh_wallets` count ÷ `token/info` holder count = fresh %; per-holder `--tag fresh_wallet` + `is_new` in top-100 [definition of scanned population **[u]**] | ❌ no fresh-wallet identification documented |
| 3b | Top-100 holder decrease % | ✅ `tgm/holders` `balance_change_24h/7d/30d` filters + `tgm/historical-top-holders` (25 cr) — **only platform with native holder-delta** | ❌ point-in-time snapshot only — poll & diff yourself | ❌ holder count exists, top-100 distribution deltas not documented |
| 3c | Low float / exchange-balance-at-listing (30–100M) | ✅ best: `tgm/token-information` (supply/MC) + TGM holders `label_type:"exchange"` + `tgm/flows` CEX in/out | 🟡 `token/info` liquidity/MC/`top_10_holder_rate`; exchange/LP rows visible inside top-100 holders via `addr_type=2` | 🟡 supply/FDV/liquidity in token_overview; exchange-balance split not documented |
| 4 | Unique holder count (excl. burn/LP/exchange) | 🟡 holders count via `tgm/token-information`; exchange-filtered list; **burn-address exclusion not documented** | 🟡 holder count + `addr_type=2` LP/exchange rows in top-100 (subtract manually); burn exclusion not documented | 🟡 holder count + `unique_wallet_*` trader counts in token_overview; burn/LP exclusion not documented |
| 5 | Tracked-wallet USD buy inflow | 🟡 `profiler/address/dex-trades` per wallet (1 cr/wallet — costly at scale) | ✅ `wallet_activity` + `track follow_wallet` (`amount_usd`, side filter) + `track kol/smartmoney` streams | 🟡 WS `SUBSCRIBE_WALLET_TXS` per wallet (Premium+); REST route **[u]** |
| 6 | Tracked wallet % of supply | 🟡 balance ÷ supply (2 calls) | ✅ `wallet_holdings`/`token-balance` + token supply → direct compute | 🟡 same compute; wallet REST **[u]** |
| 7 | 24h DEX volume buy+sell realtime | ✅ `tgm/dex-trades` / `tgm/token-ohlcv` (1 cr) | ✅ `price.volume/buy_volume/sell_volume_{window}` realtime 1m | ✅✅ **best**: `token_overview` `vBuy24h/vSell24h/v24hUSD`, frames to **5s**, + WS `SUBSCRIBE_TXS` |
| 8 | S/A/B tier | 🟡 derived — raw inputs all present | 🟡 derived; bonus `market signal` endpoint exists (sol/bsc/…) [signal scope **[u]**] | 🟡 derived — raw inputs all present |
| 9 | Entry timing via volume threshold | 🟡 poll `tgm/dex-trades` | 🟡 poll trending 1m + K-line | ✅ **native**: WS `SUBSCRIBE_LARGE_TRADE_TXS` (USD-threshold prints) + `SUBSCRIBE_TXS` stream |

### What each platform CANNOT provide for our 9 metrics
- **Nansen:** No WebSocket. Fresh-wallet **holder-share** requires combining flow-intelligence + token-information (no single "% of holders that are fresh"). Burn/LP exclusion undocumented. `premium_labels` (the actual Smart Money/Fund identities) cost **150 credits/call** — prohibitive for realtime polling. Response caching 10–30 min hurts signal latency.
- **GMGN:** No WebSocket. No holder-delta history — top-100 decrease % must be built by polling `token_top_holders` and diffing snapshots. Fresh-wallet stat's population definition undocumented. Hidden free-key quotas possible **[u]**. IPv4-only.
- **Birdeye:** **No fresh-wallet identification at all.** No labeled smart-money *holder* distribution at token level (category exists, depth unverified). Wallet-per-connection WS limit (1 address/conn) makes >20 tracked wallets awkward. Per-endpoint CU costs must be audited — volume endpoints on high-traffic memecoins can burn CUs fast **[u]**.

### Fallback providers (only for the specific gaps)
- **Burn/LP/exchange exclusion for metric 4:** none of the three documents it. Options: compute from raw transfers via own RPC (Helius/Alchemy/QuickNode) or Moralis token-holder endpoints; GoPlus for LP/burn contract flagging at token level. [vendor claims not re-verified here]
- **BSC realtime block-level events (if Birdeye WS insufficient):** Alchemy/Helius websockets. [not verified in this session]

---

## 7. Cost estimate for Framework01 (BSC+Sol+ETH, ~50 tracked tokens, 9 columns)

| Combo | Monthly cost | Covers |
|---|---|---|
| **Birdeye Premium $199** + **GMGN free** | **$199** | 1,2(WS),4,6,7,9 + GMGN: 2,3a,5,smart-money stream |
| Birdeye Business $499 + GMGN free | $499 | adds batch endpoints + 2000 WS conns (needed if >500 tokens or many wallet streams) |
| Nansen Pro $69 + credit top-ups | $69 + usage | premium labels only; realtime polling burns credits fast (holders 5 cr, premium_labels 150 cr) |

---

## 8. Bottom-line recommendation (per spec column)

| Spec column | Use | Why |
|---|---|---|
| 1 CA identity | **Birdeye** | one call, all 4 chains, cheapest CU |
| 2 Tracked-wallet holdings | **GMGN** (+ Birdeye WS for push) | batch PnL for 100 wallets free; WS wallet stream for push |
| 3 Fresh Wallet % | **GMGN** (`wallet_tags_stat.fresh_wallets` ÷ holder count) | only platform with native fresh-wallet tag; Birdeye has none |
| 3 Top-100 holder decrease | **GMGN poll + own snapshot diff** (Nansen `tgm/holders` balance_change_24h only if budget allows — 5 cr/call) | no platform gives free native delta |
| 3 Low float / exchange balance | **Birdeye** supply/MC + **GMGN** `addr_type=2` rows; Nansen TGM `exchange` label if needed | combination covers filter |
| 4 Unique holders | **Birdeye** token_overview holder count; burn/LP exclusion via own RPC/GoPlus layer | cheapest realtime count |
| 5 Wallet USD buy inflow | **GMGN** `wallet_activity` / `track follow_wallet` | amount_usd + side filter, free, batched |
| 6 Wallet % of supply | **GMGN** | balance + `amount_percentage` semantics already supply-normalized |
| 7 24h vol buy+sell | **Birdeye** (5s frames + WS `SUBSCRIBE_TXS`) | objectively best realtime volume endpoint of the three |
| 8 S/A/B tier | **derived in our backend** | no vendor provides it; inputs from Birdeye+GMGN |
| 9 Entry timing | **Birdeye WS** `SUBSCRIBE_LARGE_TRADE_TXS` | native USD-threshold print stream — the only native solution |

**Primary stack: Birdeye Premium ($199/mo) for market data + GMGN Agent API (free) for wallet/holder intelligence.** Nansen is *not* needed for v1: everything it uniquely adds (premium Smart Money labels, historical top-holders) is credit-expensive at realtime polling rates; revisit if you later need institutional-grade wallet labeling.

---

## Source index
1. https://docs.nansen.ai/ · /api/overview · /api/token-god-mode/holders · /api/token-god-mode/flow-intelligence · /api/smart-money · /api/data-coverage · /getting-started/credits · /getting-started/agentic-payments
2. https://academy.nansen.ai/articles/0938495-get-started-with-api · /articles/9412804-about-nansen-pro
3. https://docs.gmgn.ai/index/llms.txt · /index/gmgn-agent-api.md
4. https://github.com/GMGNAI/gmgn-skills (skills/gmgn-token, gmgn-portfolio, gmgn-track SKILL.md tables = route + weight + field reference)
5. https://docs.birdeye.so/docs/pricing · /docs/rate-limiting · /docs/websocket · /docs/faq · /reference/get-defi-token_overview · /reference/get-defi-v3-token-trade-data-single · /reference/transactions · /reference/stats
6. https://gmgnguide.com/ecosystem/what-is-gmgn (2026-08-06 fee/subscription cross-check)
7. https://outposts.io/article/gmgn-launches-agent-api-… (2026-05-13 rate-limit doubling, quoting official GMGN announcement)
8. KuCoin/cointrust news 2026-04-21 (Nansen x402 pay-per-call launch)
