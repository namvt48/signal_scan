# Solana RPC provider choice — sized against measured usage (2026-09-23)

Verified against provider-owned pages on 2026-09-23. Conflicts between two pages of
the same provider are flagged, never averaged. Unverifiable values are named as such.

Related: `docs/2026-09-17-free-solana-rpc-transport-research.md` (transport verdict),
`docs/solana-rpc-free-tier-matrix.md` (broad free-tier matrix).

---

## 1. What is actually being asked of an RPC endpoint

| Caller | Method | Cadence | Cost driver |
|---|---|---|---|
| `server/src/providers/solana.ts` → `walletTokenHoldings` | `getTokenAccountsByOwner` ×2 (SPL + Token-2022) per wallet | `POLL_WALLETS_MS` = 15 min | linear in **wallets** |
| `server/src/poller.ts` → `symbolBackfillSweep` | DAS `getAsset` — 1 per CA whose symbol is NULL | `POLL_SYMBOL_BACKFILL_MS` = 5 min | linear in **ticker-less CAs** |
| `scripts/wallet_watch.py` (`--feed ws`/`poll`) | `logsSubscribe {mentions:[wallet]}` → `getTransaction` per hit; sweep `getSignaturesForAddress` | live | linear in **wallets** |
| `scripts/wallet_watch.py` (`--feed block`) | `getBlock` full/jsonParsed per confirmed slot | — | **2.76 TB/day — not a free-tier workload** |

Two findings that decide everything:

1. **The client paces itself at `minIntervalMs = 600`** (`solana.ts:173`), i.e. 1.67 req/s.
   RPS limits on every free tier are therefore *not* binding. The binding constraint is
   the **monthly credit/CU pool**.
2. **DAS `getAsset` is the dominant cost**, not the holdings calls — and it is the one
   requirement most providers do not serve at all.

Monthly credit formula (holds only if the DAS symbol backfill stays uncapped — see §5):

```
credits/mo = 5760 × wallets  +  86400 × tickerless_CAs
```

## 2. Hard filter: which providers serve DAS `getAsset`

DAS is a Metaplex spec, so it is opt-in per provider. Without it the symbol/supply/price
floor (`assetInfo`) breaks and the dashboard shows `—` whenever the Nansen browser door is blocked.

| Provider | DAS on free? | Published cost per `getAsset` | Free DAS capacity |
|---|---|---|---|
| **Helius** | yes | **10 credits** | 100,000 /mo |
| **Alchemy** | yes (**beta**) | **160 CU** | 187,500 /mo |
| **QuickNode** | yes, as a **separate add-on** | own product: free 10,000 req/mo @2 RPS, $10 = 50k, $49 = "unlimited" | 10,000 /mo |
| **Solana Tracker** | yes | 10 credits | 50,000 (one-off 500k credits, €1) |
| Shyft | DAS author, free tier = unlimited credits @10 RPS | not metered per call | ⚠️ per-call cost unpublished |
| Triton One | yes | $50/M calls + $0.08/GB | none — no free tier |
| Chainstack / dRPC / GetBlock / Ankr / Nodit / Hello Moon | **no DAS found** on any provider-owned page | — | — |

## 3. Cost at three scales

Aligned pairs (wallets, ticker-less CAs) = (11,5), (50,20), (100,50).
Assumes Helius 1 cr/hold call + 10 cr/`getAsset`; Alchemy 10 CU/hold + 160 CU/`getAsset`;
QuickNode 30 cr/hold + 60 cr/`getAsset`.

| Provider | 11 w / 5 CA | 50 w / 20 CA | 100 w / 50 CA | Cheapest paid tier |
|---|---|---|---|---|
| **Helius** | 495K/mo → **free** | 2.0M/mo → 2× over | 4.9M/mo → 4.9× over | **$49** = 10M credits |
| **Alchemy** | 7.5M CU/mo → **free** | 30.5M → 1.0× over | 74.9M → 2.5× over | PAYG **$0.525/1M CU** → $16 / $39 per mo |
| QuickNode | 4.5M/mo → trial | 19M → over | 43M → over | $49 = 80M credits (free = 10M **trial**, 1 month only) |
| Solana Tracker | 495K/mo → free | 2.0M → 4× over | 4.9M → 9.8× over | $35 = 15M credits |

Alchemy's per-call CU is 16× Helius's, but its free pool is 30× larger — so Alchemy is
the cheaper *paid* option at every scale above the Helius free tier, and the only one
that is cheaper than $49/mo. Its DAS is still beta.

## 4. Recommendation

**Primary: Helius** (`https://mainnet.helius-rpc.com/?api-key=KEY`)
- Free tier covers the current scale (11 wallets + ~10 ticker-less CAs) with room; 1 credit per standard/historical call; DAS 10 credits; LaserStream WSS standard methods (incl. `logsSubscribe`) included on **all** plans; no card, no email.
- Free-tier ceiling, solved for ticker-less CAs: `T ≈ (1_000_000 − 5760×W) / 86400` → at 11 wallets ≈ 10 CAs.

**Failover: Alchemy** (`https://solana-mainnet.g.alchemy.com/v2/KEY`)
- 30M CU/mo free, 25 RPS, no card. Biggest renewing free pool; DAS in beta.
- Fallback wiring already exists — `parseRpcEndpoints` splits on comma/whitespace:

```
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=KEY,https://solana-mainnet.g.alchemy.com/v2/KEY
```

**Reject**
- QuickNode — free tier is a **1-month trial**, and DAS is billed as a separate product.
- Chainstack — no DAS found; Solana Developer is 5 RPS (docs) vs 25 RPS (pricing page); `getSignaturesForAddress` is billed as archive = 2 RU.
- RPC Fast — free blocks `getTokenAccountsByOwner`, which is exactly the holdings call.
- `--feed block` (whole-chain `getBlock`) on any free or sub-$50 tier — 2.6 TB/day; cheapest credible is Helius 100 TB add-on ($4,500 + $999) or Triton (~$0.08/GB). Keep `--feed ws`.

## 5. The one code change that decides the bill

`symbolBackfillSweep` (`poller.ts:135`) re-asks **every 5 minutes, forever, with no attempt cap
and no window**. `config.ts:74` has no equivalent of `essentialGapWindowMs`. A mint DAS can
never resolve (non-standard, burned, unindexed) is therefore queried 288×/day at 10 credits
= **2,880 credits/day each** — on Helius free that is one stuck CA eating 8.6% of the whole
monthly pool.

Fix, using the pattern already in `config.ts`: cap retries per address, or stop after a
window, and mark it exhausted.

## 6. Explicitly unverifiable — do not estimate

1. Shyft per-call DAS cost and whether `getAsset` is unmetered on the free plan.
2. Helius `getBlock`/`getTransaction` credit cost: billing page says **1**, the api-reference
   `llms.txt` says **10**. Resolve by checking `/docs/billing/credits` for the live account.
3. Alchemy WebSocket CU: general table 0.04 CU/byte vs Solana section 0.0002 CU/byte (200×).
4. GetBlock and RPC Fast per-method CU weights for Solana — unpublished.
5. WS connection caps: Helius, Alchemy, dRPC, GetBlock, QuickNode, Shyft — unpublished.
   Published only by Solana Tracker (2/25/100/250) and RPC Fast (1/10/20/50).
6. Lava paid pricing; dRPC free-tier WebSocket availability.
7. No provider-owned page found stating datacenter/cloud-IP blocking. The only documented
   403-on-IP-block is the Solana Foundation public endpoint.
