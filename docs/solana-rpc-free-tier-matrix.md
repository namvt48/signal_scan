# Free Solana Mainnet RPC — Comparison Matrix (verified 2026-09-17)

Scope: free tiers only. Enterprise/paid-only providers excluded.
Method context: wallet watcher using `getBlock` (jsonParsed/full), `getSignaturesForAddress`+`getTransaction`, or `logsSubscribe`.

**Uncertain numbers are marked ⚠️ and are NOT guesses — they are items where the provider does not publish the value.**

---

## 1. Decision matrix

| Provider | Endpoint format | Free quota | Free RPS | WS on free? | getBlock jsonParsed? | Card / KYC? | Datacenter IP OK? | 2025–26 change |
|---|---|---|---|---|---|---|---|---|
| **Helius** | `https://mainnet.helius-rpc.com/?api-key=K` / `wss://mainnet.helius-rpc.com/?api-key=K` | 1M credits/mo (renews) | 10 | **YES** (LaserStream WSS, standard methods incl. `logsSubscribe`) | YES — 1 credit; archival 10 | No card, no email required | Yes (API-key auth) | LaserStream WSS standard methods now included on Free; Helius acquired Light Protocol |
| **Alchemy** | `https://solana-mainnet.g.alchemy.com/v2/K` / `wss://solana-mainnet.streaming.alchemy.com/v2/K` | 30M CU/mo (largest renewing CU pool) | 25 | **YES** (`logsSubscribe`, `signatureSubscribe`, …) | YES; CU-metered (gPA = 20 CU) | No card | Yes (API-key auth) | DAS + Solana address webhooks in beta |
| **Chainstack** | `https://solana-mainnet.core.chainstack.com/K` (wss same host) | 3M RU/mo | **5** on Solana mainnet (25 on devnet) | **YES** (all nodes) | YES — method cap 400 RPS; archive = 2 RU | No card | Yes | Absorbed Syndica free users; Yellowstone gRPC from Growth |
| **dRPC** | `https://solana.drpc.org` (public, no key) | 210M CU / 30 days (flat 20 CU/method ≈ 10.5M calls) | ~100 *(dynamic, may drop to ~40)* | **YES** (public nodes) | YES; `trace`/`debug`/`filter` disabled | No card | **Mixed — you already saw 403 on dRPC** | Free plan re-cut 2025-06-01; flat 20 CU/method since Jun 2025 |
| **GetBlock** | `https://shared.eu-central-1.getblock.io/<token>/` / `wss://shared.eu-central-1.getblock.io/<token>/` | **50K CU / DAY** (no rollover) | 20 | **YES** | YES; `getProgramAccounts` served | No card for free | Yes | CU limits raised on all shared plans |
| **RPC Fast** | `https://solana.rpcfast.com?key=K` | 1.5M CU/mo | 15 | **YES — 1 concurrent** | YES | No card | Yes | Pricing rebuilt around Solana; colo EU |
| **Shyft** | dashboard-issued RPC/WSS URL | "Unlimited credits" | 10 | ⚠️ standard WS not itemized; gRPC = paid only | YES (accelerated gPA = paid) | No card | Likely yes | Repositioned as gRPC/RabbitStream trader infra |
| **ZAN** | `https://api.zan.top/node/v1/solana/mainnet/{key}` / `wss://api.zan.top/node/ws/v1/solana/mainnet/{key}` | 150M credits / 30 days | ⚠️ not published (per-project CU/s cap) | ⚠️ **CONFLICTING** — one doc says free Solana WS needs paid upgrade; another says 2 GB free wss traffic | YES (HTTP) | No card | Yes (API key) | Ant Group product; 20+ chains |
| **Nodies** | dashboard-issued | 4M requests/mo | ⚠️ "low rate limit", unpublished | ⚠️ not documented for free | YES (flat per-request billing) | No card | Yes | Public endpoints "heavily restricted" |
| **Ankr** | `https://rpc.ankr.com/solana` (public) / `https://rpc.ankr.com/solana/<token>` | 200M API credits/mo | ~30 | **NO — HTTPS only** (WS = Premium plan) | YES (full + archive on freemium) | No card | **Mixed — you saw 403 on Ankr** | Public/freemium split documented; WS gated |
| **Solana Foundation public** | `https://api.mainnet-beta.solana.com` (also `api.mainnet.solana.com`) | none (fair-use) | 10 avg (100 req/10s per IP) | 5 concurrent pubsub subs | Allowed but **100 MB/30s cap kills it** | None | **Officially may block you**: "high-traffic websites may be blocked without prior notice" | Rate limits unchanged; slot time cut 400→350ms |
| **PublicNode** | `https://solana-rpc.publicnode.com` / `wss://solana-rpc.publicnode.com` | none | ⚠️ unpublished, per-IP | YES (WS endpoint listed) | YES | None | **NO — your 403 came from here** | Solana Yellowstone gRPC added |
| **QuickNode** | `https://<name>.solana-mainnet.quiknode.pro/<token>/` | **10M credits ONE-TIME TRIAL (~1 mo)** | 15 | Trial only | YES — all standard methods 30 credits | ⚠️ likely card to start trial | Yes | Explicitly "no ongoing free tier" |
| **Blockdaemon** | dashboard-issued | 3M CU ⚠️ (secondary source only; own pricing page 404) | ⚠️ | ⚠️ | ⚠️ | ⚠️ institutional onboarding likely | Yes | n/a |
| **Hello Moon** | — | ⚠️ **No current free RPC offering verifiable** — site now = transaction landing / staking / data | — | — | — | — | — | Pivoted away from raw RPC |
| **Lava** | `https://gateway.lavanet.xyz` | ⚠️ free gateway exists; pricing page CU/RPS figures carry an explicit "mockup — confirm before launch" disclaimer | ⚠️ | ⚠️ | ⚠️ | No card | Yes (decentralized) | Multi-chain CU metering |
| **Solana Tracker RPC** | dashboard-issued | 500K credits, **€1 one-time only** (not monthly) | 5 | 2 WS connections | YES (flat credit model) | €1 payment | Yes | Repositioned around Shredstream |
| **Syndica** | — | **RETIRED** | — | — | — | — | — | **Self-serve RPC + ChainStream retired 2026-02-14** |
| **Triton One** | — | **No free tier** ($125 prepaid, non-refundable, 12 mo) | — | — | — | Prepaid crypto | Yes | — |
| **Vybe** | `https://api.vybenetwork.com` | 25,000 credits/mo | 60 RPM | **NO — WS = Pro/Business only** | **Not an RPC** — data API, no getBlock | Social sign-in required | Yes | Free tier requires social login (anti-abuse) |

---

## 2. Hard constraint: your current transport cannot run on any free tier

Block size you measured: 10–14 MB per slot. Chain slot time now ~350–400 ms (Solana cut 400→350 ms via feature gate in 2026).

- **Solana Foundation public endpoint**: hard cap 100 MB / 30 s per IP → ~8 blocks per 30 s = **0.27 blocks/s**. You need ~2.5/s. Fails by ~10×.
- **Helius WSS metering**: 2 credits per 0.1 MB uncompressed → a 12 MB block = ~240 credits. 1M credits/mo ≈ **4,100 blocks**. Fails in under an hour.
- **GetBlock free**: 50,000 CU/day. A full jsonParsed `getBlock` is a heavy-call weight (industry figures: ~100–200 CU) → **~250–500 blocks/day**. Fails by ~400×.
- **Bandwidth reality**: 2.5 blocks/s × 12 MB × 86,400 s = **~2.6 TB/day**. No free tier, and no paid tier under ~$500/mo, absorbs this.

**Conclusion: `getBlock`-per-slot with `transactionDetails: full, encoding: jsonParsed` is not a free-tier workload at all.** Changing RPC provider does not fix it.

The only free-tier-viable transport for your watcher is **`logsSubscribe` with `{"mentions": [wallet]}`**, then `getTransaction` (1 credit on Helius, ~40 CU on Alchemy) only for matched signatures. Notification payloads are KB-scale, not MB-scale.

---

## 3. Recommendation

Primary: **Helius free**
```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=KEY
```
- Only provider where `getBlock`/`getSignaturesForAddress`/`getTransaction` all cost exactly **1 credit** and `logsSubscribe` is on the free tier.
- 5 concurrent WS connections, 1,000 subscriptions per connection.
- No card, no KYC, no email required at signup.
- 1M credits/mo renews monthly (not a one-time trial).

Failover: **Alchemy free** — biggest renewing CU pool (30M/mo), 100 concurrent WS connections, EU-Central region, no card, `logsSubscribe` documented.

Second failover (EU latency): **GetBlock** (Frankfurt, WS + MEV protection on free, but 50K CU/day) or **RPC Fast** (1 concurrent WS, 1.5M CU/mo, EU colo).

Avoid for production:
- **PublicNode** — your 403 source; no published limits, "heavy restrictions".
- **Ankr free** — HTTPS only, no WebSocket. Will force you back onto polling.
- **QuickNode** — 10M credits is a one-time ~1-month trial, not a free tier.
- **Syndica** — retired 2026-02-14.
- **Solana Foundation public** — 100 MB/30 s makes block scanning impossible; docs say abusive clients get blocked without notice.
- **Vybe** — not an RPC endpoint at all.

All five API-key providers above (Helius, Alchemy, Chainstack, GetBlock, RPC Fast) authenticate by key/token, so datacenter traffic from your Contabo DE boxes is fine — that is the actual fix for the Cloudflare-style 403s you hit on keyless endpoints (publicnode, dRPC public, Ankr public).

---

## 4. Sources

| Claim area | Source |
|---|---|
| Helius plans, credits, free limits | https://www.helius.dev/pricing · https://www.helius.dev/docs/billing/plans |
| Helius rate limits, WS connections | https://www.helius.dev/docs/billing/rate-limits |
| Helius WS endpoint + `logsSubscribe` on all plans | https://www.helius.dev/docs/api-reference/rpc/websocket/llms.txt · https://www.helius.dev/docs/faqs/websockets |
| Helius per-method credits (`getBlock`=1, archival=10) | https://www.helius.dev/docs/billing/credits |
| Alchemy free tier 30M CU / 25 RPS / 5 apps | https://www.alchemy.com/pricing |
| Alchemy Solana WS endpoint, 100 free connections | https://www.alchemy.com/docs/reference/subscription-api · https://www.alchemy.com/docs/reference/solana-subscription-api-endpoints.md |
| Alchemy `logsSubscribe` example | https://www.alchemy.com/docs/reference/logs-subscribe.md |
| Alchemy Solana CU example (gPA = 20 CU) | https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-program-accounts.md |
| Chainstack plans / free 3M RU | https://chainstack.com/pricing/ |
| Chainstack Solana 5 RPS free, method caps, blocked methods | https://chainstack.mintlify.app/docs/limits |
| Chainstack Solana WS + archive RU model | https://docs.chainstack.com/reference/solana-getting-started |
| Syndica retirement | https://docs.chainstack.com/docs/migrating-from-syndica-to-chainstack · https://madeonsol.com/tools/syndica |
| dRPC free tier 210M CU / 30d, dynamic rate limit | https://drpc.org/docs/howitworks/ratelimiting · https://drpc.org/docs/pricing/requests |
| dRPC free plan change + disabled namespaces | https://blog.drpc.org/upcoming-changes-to-drpcs-free-plan-effective-june-1-2025/ |
| dRPC free 100 RPS, WS support | https://drpc.org/pricing · https://pubfi.ai/discovery/api/drpc |
| GetBlock free 50K CU/day, 20 RPS, WS on free | https://getblock.io/pricing.md · https://getblock.io/pricing-new/ |
| GetBlock Solana WS URL + gPA available | https://docs.getblock.io/rpc-endpoint/how-to-get-a-solana-rpc-endpoint.md |
| Ankr service plans — freemium HTTPS only, 200M credits | https://www.ankr.com/docs/rpc-service/service-plans/ |
| RPC Fast free Start tier (1.5M CU, 15 RPS, 1 WS) | https://rpcfast.com/pricing |
| Shyft free tier (unlimited credits, 10 RPS, 1 API RPS, no gRPC) | https://shyft.to/solana-rpc-grpc-pricing · https://shyft.to/ |
| ZAN endpoints + free 150M credits/30d | https://docs.zan.top/reference/api-instructions · https://docs.zan.top/docs/quick-start-guide |
| ZAN WS free-plan conflict (2 GB vs paid-only) | https://docs.zan.top/reference/best-practices-for-using-websockets-in-solana vs https://docs.zan.top/docs/quick-start-guide |
| Nodies free 4M req/mo | https://www.nodies.app/pricing |
| Solana Foundation public limits (100/10s, 40/method, 100 MB/30s) | https://solana.com/docs/references/clusters |
| Solana public webSocket sub cap (5) + 429/blocking warning | https://getblock.io/blog/public-solana-rpc-url-everything-you-need-to-know/ |
| PublicNode Solana endpoints (RPC/WS/Yellowstone gRPC) | https://solana-rpc.publicnode.com/ · https://publicnode.com/ |
| PublicNode undocumented limits / WS restrictions | https://onfinality.io/en/rpc-assistant/publicnode-rate-limit · https://onfinality.io/en/rpc-assistant/publicnode-solana-rpc-endpoint |
| QuickNode no ongoing free tier, 30 credits/call | https://www.quicknode.com/blog/best-solana-rpc-providers-2026 · https://www.quicknode.com/pricing |
| Solana Tracker RPC free (€1, 500K credits, 5 RPS, 2 WS) | https://www.solanatracker.io/solana-rpc · https://docs.solanatracker.io/pricing |
| Vybe free 25K credits, 60 RPM, WS paid-only | https://docs.vybenetwork.com/docs/plans-rate-limits · https://docs.vybenetwork.com/docs/websockets |
| Blockdaemon 3M CU free (secondary) | https://www.alchemy.com/overviews/solana-rpc |
| Triton One no free tier, $125 prepaid | https://docs.rpcplane.dev/compare/ (secondary) |
| Hello Moon current positioning | https://www.hellomoon.io/ |
| Lava pricing "mockup" disclaimer / free gateway | https://www.lavanet.xyz/pricing · https://docs.lavanet.xyz/ |
| Slot time 400→350 ms, 2026 | https://solana.com/ changelog references |

---

## 5. Explicitly uncertain (do not treat as fact)

1. **Shyft free-tier WebSocket** — pricing table lists RPC RPS and API RPS but never states whether standard `logsSubscribe` WS is included free. Verify in dashboard before relying on it.
2. **ZAN free-tier Solana WebSocket** — docs contradict each other (paid-upgrade-required vs 2 GB free wss traffic). Verify with a test connection.
3. **Nodies free RPS and WS** — "low rate limit" only; no number published, no WS statement for free.
4. **Blockdaemon free tier** — 3M CU figure comes from Alchemy's comparison page; Blockdaemon's own `/pricing` returned 404. Verify on signup.
5. **Lava free quotas** — the public pricing page literally labels its CU/RPS numbers as illustrative for a mockup. Not quotable.
6. **Hello Moon** — no evidence of a current free Solana RPC product. Assume unavailable.
7. **Alchemy Solana `getBlock` CU cost** — Alchemy publishes CU per method in docs; the exact `getBlock`/jsonParsed weight was not confirmed in this pass. Assume heavy-method tier and measure.
8. **QuickNode card requirement for the trial** — not confirmed either way.
9. **dRPC free-tier RPS for Solana specifically** — the 100 RPS figure is documented for EVM `eth_call`; Solana has "custom rate limits applied on the free tier" per dRPC's own docs.

---

## 6. One-line architecture fix

Replace `getBlock`-per-slot with `logsSubscribe {"mentions":[wallet]}` on a keyed WS endpoint (Helius primary, Alchemy failover); on notification call `getTransaction` for that signature only. This turns a 2.6 TB/day workload into a few KB/minute and fits inside a renewing free tier.
