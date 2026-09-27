# Solana RPC provider research — wallet watcher + block-scan feasibility

Researched 2026-09-23. All numbers from provider-owned pages. Conflicts between two official pages of the same provider are flagged. Nothing estimated silently — unverifiable values marked.

## 1. Verdict up front

- **Block-scan-per-slot mode: INFEASIBLE on every free and sub-$50 tier.** Cheapest credible path is ~$4.5k–6.2k/month. Your ~2.6 TB/day math is confirmed.
- **Polling / logsSubscribe watcher for ~100 wallets: fits free or ≤$50 on several providers.** Best free candidates: GetBlock (50k CU/day, WS free), Shyft (unlimited credits, 10 RPS), dRPC (210M CU/30d), Chainstack Developer (3M RU + 500 WS conns, Solana capped 5 RPS), Helius Free (1M credits, 10 RPS, LaserStream WSS standard included).
- **Per-wallet `getSignaturesForAddress` is the cost trap on Chainstack** (always billed archive = 2 RU). On Helius/Alchemy/QuickNode it is a flat per-call cost.

## 2. Block-scan feasibility (getBlock jsonParsed every slot)

Bandwidth demand: 2.5 slots/s x ~12 MB x 86,400 s = **2.592 TB/day ≈ 77.8 TB/month**.

Published bandwidth/cost ceilings (provider-owned):

| Provider | Published rate | 77.8 TB/mo cost |
|---|---|---|
| Triton One | $0.08/GB streaming; $0.08/GB + $10/M standard RPC | ~$6,220/mo bandwidth alone |
| Alchemy | gRPC bandwidth starting at $75/TB | ~$5,835/mo |
| Helius | Data add-on 100 TB = $4,500/mo (Professional only); + $999 Professional | ~$5,499/mo total |
| GetBlock | paid shared plans "unlimited bandwidth" but metered by CU; dedicated Solana from $1,000/mo | CU-metered ; not viable |
| RPC Fast | paid plans unlimited bandwidth, CU-metered | CU-metered ; not viable |
| Chainstack | RU-metered ; Unlimited Node flat RPS but per-request billed | not viable |

Sources: triton.one/pricing ; triton.one/sui-rpc-full-node ; alchemy.com/pricing ; helius.dev/pricing ; getblock.io/pricing.md ; rpcfast.com/pricing ; chainstack.com/pricing.

Conclusion: **block-scan must be abandoned or moved to a dedicated/streaming contract.** No free tier serves it; the cheapest published route is a Helius 100 TB data add-on or Triton streaming, both four figures/month.

Important: "unlimited bandwidth" on RPC Fast/GetBlock paid plans is bandwidth, not compute — getBlock still burns CU/RU per call and ToS fair-use applies. Do not read "unlimited bandwidth" as "block-scan is free".

## 3. Per-provider table (free tier)

| Provider | Free quota | RPS | WS conns | Sub cap | logsSubscribe free? | Card? |
|---|---|---|---|---|---|---|
| Helius | 1M credits/mo | 10 | not published | not published | Yes (LaserStream WSS standard methods on all plans) | no (dashboard); Agent plan needs 1 USDC |
| Alchemy | 30M CU/mo | 25 (500 CU/s) | not published | not published | Yes, bandwidth-priced | no |
| Chainstack | 3M requests/mo + 1 node | 25 (pricing) / **5 Solana (docs)** | 500 concurrent/node | 500 concurrent/node | Yes, each push = 1 RU | no ("No credit card required") |
| dRPC | 210M CU/30d | ~100 req/s per IP (free) | not published | not published | not documented | not stated |
| GetBlock | 50,000 CU/**day** | 20 | not published | not published | Yes ("WebSockets: Yes" all plans) | not stated |
| RPC Fast | 1.5M CU/mo | 15 | 1 | not published | Yes (1 concurrent WS) | not stated |
| QuickNode | 10M credits — **1-month trial** | 15 | not published | not published | not stated | **no** ("No card required") |
| Shyft | unlimited credits | 10 | not published | not published | Yes (WS supported) | not stated |
| Triton One | **none** | same limits all plans | flexible, unpublished | unpublished | included (streaming paid) | $125 prepaid deposit, non-refundable |
| Solana Tracker | 500k credits (€1 one-time) | 5 | 2 | 2 | yes (WS included) | €1 |
| Lava | free tier | 25–100 | not published | not published | "depends on provider WS support" | not stated |

## 4. Per-method cost (published numbers only)

### Helius — helius.dev/docs/billing/credits, helius.dev/docs/billing/plans
- Standard RPC calls = **1 credit** each; historical/archival calls = **1 credit** each.
- `getSignaturesForAddress` = 1 ; `getTransaction` = 1 ; `getBlock` = 1.
- getProgramAccounts = 10 ; DAS API = 10 ; Enhanced Transactions = 100.
- LaserStream WSS = **2 credits per 0.1 MB** streamed; gRPC same (Business/Professional mainnet).
- CONFLICT: helius.dev/docs/api-reference/rpc/http/llms.txt groups `getBlock`, `getTransaction`, `getSignaturesForAddress` at **10 credits**. The billing-credits page (current) says 1. Treat 1 as current, flag the stale API-reference page.

### Alchemy — alchemy.com/docs/reference/compute-unit-costs
- `getBlock` = **40 CU** ; `getSignaturesForAddress` = **40 CU** ; `getTransaction` = **40 CU**.
- getAccountInfo/getBalance = 10 ; sendTransaction = 20 ; getTransactionsForAddress = 100 ; getLargestAccounts = 3000.
- WS subscriptions priced by bandwidth: general table **0.04 CU/byte**; Solana-specific section says **0.0002 CU/byte** (flag: 200x conflict between two tables on the same page).
- PAYG $0.525/1M CU. gRPC $75/TB.

### Chainstack — docs.chainstack.com/docs/request-units
- 1 RU = full request; 2 RU = archive request.
- `getSignaturesForAddress` **always billed archive = 2 RU**, regardless of slot.
- `getTransaction` / `getBlock` = 1 RU recent (target slot ≥ firstAvailable + 5,000), **2 RU archive**.
- Archive-eligible: getTransaction, getBlock, getBlockTime, getBlocks, getBlocksWithLimit, getSignaturesForAddress, getFirstAvailableBlock, getSignatureStatuses.
- WS: subscription setup = 1 request; **each push = 1 RU** ; 500 concurrent WS connections per node ; 1-hour idle timeout.

### QuickNode — quicknode.com/api-credits
- Solana = **30 API credits per method** (flat "All methods* 30"). Applies to getBlock, getTransaction, getSignaturesForAddress.
- Advanced APIs = 2x multiplier; large calls extra multipliers. `getProgramAccounts` falls under large-call multipliers per page.

### GetBlock — docs.getblock.io plans-and-limits
- CU-metered, per-method CU weights **not published** for Solana (page only gives eth_getLogs as an example of "heavy"). **Unverifiable — do not estimate.**
- Free: 50,000 CU/day, 20 RPS, 2 tokens. Starter $49: 90M/mo. Growth $99: 185M/mo. Advanced $199: 385M/mo. Limitless Solana: 5 RPS $150, 15 RPS $450, 30 RPS $900, 50 RPS $1,500 (unlimited requests, no CU metering).

### RPC Fast — rpcfast.com/pricing
- CU-metered; **per-method CU values not published. Unverifiable.**
- Free blocks: getProgramAccounts, getTokenAccountsByOwner, getTokenAccountsByDelegate, getTokenLargestAccounts.
- Free: 1.5M CU, 15 RPS, 50 GB, 1 WS. Focus $45: 12M CU, 50 RPS, 10 WS. Stream $249: 60M CU, 150 RPS, 20 WS.

### Solana Tracker — docs.solanatracker.io
- Most methods = **1 credit**. Archival + DAS = **10 credits**. V2 optimized = 1 credit (90% fewer).
- Which exact methods are "archival" is not enumerated on the credits page — **partially unverifiable**; likely includes getSignaturesForAddress/getTransaction/getBlock.
- Free: 500k credits, 5 RPS, 2 WS conns. Developer €35: 15M credits, 60 RPS, 25 WS. Business €399: 100M, 225 RPS, 100 WS.

### Triton One — triton.one/pricing
- Standard RPC/ledger = **$10/M calls + $0.08/GB**. Streaming (websocket) = **$0.08/GB only** — no per-call. Metaplex DAS/Photon = $50/M + $0.08/GB.
- No free tier. $125 minimum prepaid deposit, non-refundable, valid 12 months. Same connection/RPS limits on every plan.

### Lava — lavanet.xyz/lava-rpc-api-gateway
- Free: 25–100 RPS depending on usage, 28+ chains incl Solana. Per-method cost / paid plan pricing **not retrieved (unverifiable)**.
- ToS: over-RPS → 429; monthly hard stop; archive/debug methods gated and may 403 on plans that exclude them.

## 5. Datacenter / cloud IP blocking

- **Solana Foundation public endpoints (api.mainnet-beta.solana.com):** explicit. 100 req/10s/IP, 40 req/10s per single method, 40 concurrent connections, 100 MB/30s, and **403 = "Your IP address or website has been blocked."** Docs state "not intended for production applications… high-traffic websites may be blocked without prior notice." Source: solana.com/docs/references/clusters.
- **No provider-owned page found** for Helius, Alchemy, Chainstack, dRPC, GetBlock, RPC Fast, QuickNode, Shyft, Triton, Solana Tracker, or Lava stating that datacenter/cloud IPs are blocked or throttled. The only related provider statement is Helius docs *permitting* datacenter IP blocks in its allow-list (helius.dev/docs/rpc/protect-your-keys: "Cloud provider IP ranges / Data center IP blocks").
- **Explicitly unverifiable:** claims that any named provider silently throttles datacenter IPs. No provider source supports it. Do not assert it.

## 6. Cheap WebSocket / many-wallet streaming specialists

- **Helius** — LaserStream WSS carries standard Solana subscription methods (incl logsSubscribe) on all plans including Free; Helius extensions (transactionSubscribe) from Developer. Metered 2 credits/0.1 MB. helius.dev/docs/rpc/websocket
- **Shyft** — gRPC + RabbitStream + WS, no credits/bandwidth metering, free 10 RPS, paid flat-rate. Built for trader streaming. shyft.to/solana-rpc-grpc-pricing
- **RPC Fast** — gRPC Yellowstone/Shredstream tiers from $249; free only 1 concurrent WS.
- **Triton** — streaming billed by bandwidth only ($0.08/GB), designed for high-volume streaming, but paid-only.
- **Chainstack** — Yellowstone gRPC enabled by default on Solana nodes; 500 concurrent WS/node.
- Subscription-per-connection caps for ~100-wallet logsSubscribe are **published only by Solana Tracker** (2 free / 25 / 100 / 250) and **RPC Fast** (1 / 10 / 20 / 50 concurrent WS). All others: **unpublished — unverifiable**.

## 7. Workload math (100 wallets, polling)

Assumed: 100 wallets, 5-min poll cadence (288 polls/day/wallet), ~50 new sigs/day/wallet.
- getSignaturesForAddress: 28,800/day ; getTransaction: 5,000/day ; total ~34k calls/day ≈ 1M/month.

| Provider | Cost basis | ~1M calls/mo | Fits free? |
|---|---|---|---|
| Helius | 1 credit/call | 1M credits | borderline Free (1M), or Developer $49 |
| Chainstack | 2 RU (getSig always archive) | ~2M RU | yes, 3M Free (but 5 RPS Solana cap) |
| Alchemy | 40 CU/call | ~40M CU | no (30M free) → PAYG ≈ $21/mo |
| QuickNode | 30 credits/call | ~30M credits | no (10M trial) → Build $49 (80M) |
| GetBlock | CU weights unpublished | unverifiable | Free 50k CU/day likely too small |
| dRPC | min 10 CU/call | ~10M CU | yes, 210M Free |
| Shyft | unlimited credits | 0 | yes (10 RPS) |
| Solana Tracker | 1 credit (10 if archival) | 1–10M | no (500k) → Developer €35 |

For the **logsSubscribe** variant (100 wallets): one WSS connection with 100 subscriptions is within Solana Tracker Developer (25 conns? subscriptions cap unclear) and RPC Fast Focus (10 conns). On Helius/Shyft/Alchemy, subscription caps are unpublished — must be tested, not assumed.

## 8. Recommendation

- **Primary (polling/WS watcher): Helius.** Free covers ~1M credits; Developer $49 covers 10M with 50 RPS; LaserStream WSS standard methods included; clean 1-credit per-method pricing. Cheapest predictable per-call model at this volume.
- **Failover: Shyft** (unlimited credits, flat rate, WS/gRPC) or **dRPC** (210M CU free). Shyft better if you move to streaming.
- **Do not** run block-scan-per-slot on any free/cheap tier. If required, budget Helius 100 TB add-on ($4,500 + $999) or Triton streaming (~$0.08/GB), or negotiate dedicated.
- **Avoid for this workload:** Chainstack free (Solana 5 RPS + getSignaturesForAddress always double-billed), QuickNode free (trial only, 30 credits/call), RPC Fast free (4 methods blocked, 1 WS).

## 9. Explicitly unverifiable (flag, do not estimate)

1. GetBlock Solana per-method CU weights — unpublished.
2. RPC Fast per-method CU weights — unpublished.
3. Solana Tracker exact archival-method list — not enumerated.
4. WS connection caps for Helius, Alchemy, dRPC, GetBlock, QuickNode, Shyft — unpublished.
5. Subscription-per-connection caps for all providers except Solana Tracker and RPC Fast — unpublished.
6. Lava paid plan pricing / per-method cost — page not retrievable.
7. dRPC WebSocket availability and caps on free tier — not documented.
8. Any provider-side datacenter-IP throttling — no provider source; only Solana Foundation documents IP blocking.
9. Alchemy WS per-byte CU (0.04 vs 0.0002 conflict on same page) and Helius getBlock/getTransaction credit (1 vs 10 conflict between billing page and API reference) — resolve by testing your key/account.
