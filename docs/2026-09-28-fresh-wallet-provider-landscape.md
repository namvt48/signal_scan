# Fresh-wallet % — provider landscape ngoài Nansen (2026-09-28)

**Câu hỏi:** ngoài Nansen, nền tảng nào cho được metric `fresh wallet %` (Nansen
`freshWalletBalancePercent` = % supply do ví "fresh" nắm giữ)?

**Bối cảnh:** Nansen web `gini-stats` bị Cloudflare chặn theo IP datacenter;
Nansen official API KHÔNG expose fresh% (chỉ có fresh **flow** USD).

---

## 0. Phải tách 2 định nghĩa (đừng lẫn)

| Định nghĩa | Nghĩa | Nansen dùng? |
|---|---|---|
| **Wallet age** (tuổi ví on-chain) | ví được fund lần đầu cách đây bao lâu | ✅ **đây là cái Nansen đo** |
| **Token-relative first trade** | ví giao dịch token NÀY lần đầu khi nào | ❌ khác hẳn |

Nhiều provider chỉ có cái thứ 2 → không thay thế được.

---

## 1. Tier 1 — có tín hiệu fresh trực tiếp

### GMGN (official Agent API) ⭐ đang tích hợp
- **Route:** `token info` → `wallet_tags_stat`; token holders/traders → per-holder `is_new`;
  security/analytics → **`fresh_wallet_rate`** (ratio — gần 1:1 nhất với Nansen %).
- **Kiểu:** vừa aggregate count (`wallet_tags_stat.fresh_wallets`) vừa per-holder tag (`is_new`).
- **Giá:** key tạo tại `gmgn.ai/ai` (upload Ed25519 pubkey). Không có bảng giá; **IPv4-only**.
- **Solana:** ✅ (BSC/Base/ETH nữa).
- **Blocking:** API official keyed — không CF. ⚠️ **Các web endpoint unofficial
  (`gmgn.ai/api/v1/...`) có Cloudflare, chặn IP datacenter y như Nansen** → phải dùng official Agent API.
- Docs: https://docs.gmgn.ai/index/gmgn-agent-api · https://github.com/GMGNAI/gmgn-skills

### Solscan Pro — `active_age` ⭐ rẻ + chính xác
- **Route:** `GET https://pro-api.solscan.io/v2.0/account/metadata` (+ `/metadata/multi`).
- **Kiểu:** **raw wallet age** — `active_age` = số ngày kể từ khi ví được fund lần đầu;
  kèm `funded_by.{funded_by, tx_hash, block_time}`. **Batch 50 địa chỉ/call.**
- **Giá:** CU-metered, 100 CU/call (có free tier). https://pro-api.solscan.io/pro-api-docs/v2.0/docs/pricing
- **Solana:** ✅ only.
- **Blocking:** keyed.
- → **cách rẻ nhất để tự tính % chính xác.**

### Helius Wallet API — `funded-by`
- **Route:** `GET https://api.helius.xyz/v1/wallet/{wallet}/funded-by?api-key=...`
- **Kiểu:** raw age — timestamp lần fund SOL đầu (= tuổi ví), amount/slot/funder + `funderName`/`funderType`.
  `batch-identity` (100 addr/call) phân loại funder.
- **Giá:** 100 credit/call, **cần plan trả tiền**. Free $0/1M · Dev $49/10M · Business $499/100M.
  ~$0.0005/ví @ $5/M.
- **Solana:** ✅.
- Docs: https://www.helius.dev/docs/wallet-api/funded-by · https://www.helius.dev/docs/billing/plans

### Bubblemaps Data API — tag `Fresh` + `first_activity_date`
- **Route:** `GET /v0/tokens/holders/{chain}/{token}` · `GET /v0/tokens/metrics/{chain}/{token}`.
- **Kiểu:** per-holder tag **`Fresh`** + `address_details.first_activity_date` (cần `return_metadata=true`);
  metrics → supply share của fresh wallet.
- **Giá:** credit — metrics 25 cr/req, top-holders 1 cr/req. https://docs.bubblemaps.io/data/api/introduction
- **Solana:** ✅ (`solana` trong chain enum).
- ⚠️ Schema `fresh` của metrics chưa rõ → verify bằng key thật.

### InsightX — cluster `Fresh Wallet`
- **Route:** `GET /dex-metrics/v1/{network}/{token}/clusters` (+ WS).
- **Kiểu:** aggregate theo cluster — `Fresh Wallet`, `volume_bot`, `funding_address`… + supply %.
- **Solana:** ✅. https://docs.insightx.network/docs/behavioural-nodes
- → mạnh về *cluster ví mới phối hợp*, không phải per-wallet age sạch.

---

## 2. Tier 2 — tự suy ra tuổi ví

| Provider | Route | Cho gì | Giá |
|---|---|---|---|
| **Bitquery** | GraphQL `Solana.BalanceUpdates` | token first-buy time + holding duration | points free + paid |
| **Dune** | `solana_utils.daily_balances` | derive first-seen từ snapshot (có query cộng đồng "all fresh wallets solana") | free + paid |
| **SolanaTracker** | `/v2/pnl/tokens/{token}/first-buyers` | `timing.firstTrade` + `identity.tags` (KOL/bot/pool) | Free €0 · Adv €50 · Pro €200 |
| **SolanaFM** | `GET /transactions?address=` | tx history → earliest tx = age | keyed tiered |
| **Helius raw RPC** | `getTransactionsForAddress` `sortOrder:'asc'` | first-tx thô, tự tính ở scale | 1 cr/call |

---

## 3. Tier 3 — ĐÃ CHECK, KHÔNG dùng được

| Provider | Lý do |
|---|---|
| **Birdeye** | tag chỉ có `bundler/sniper/insider/dev/smart_trader` — **không có fresh/age**. `first_trade_at` là token-relative |
| **Moralis** | Solana chỉ có `holdersByAcquisition`/`holderChange` (aggregate); "first transaction" doc là EVM |
| **Vybe** | top-1000 + label CEX/KOL/VC — không có age/fresh |
| **Arkham** | token holders + entity label; có "Early Holder" template nhưng không có field age/fresh |
| **Cielo** | "Fresh Wallet Buy" chỉ là **alert UI plan Whale**; Feed API không expose tag |
| **DexScreener** | không có holder/age — chỉ pairs/price/liquidity |
| **QuickNode** | DAS `getTokenAccounts` (holders) — không có age |
| **GoldRush/Covalent** | Solana = SPL balances only; holders/transactions là EVM/Foundational |
| **Kaito** | social/mindshare — không on-chain age |
| **Step Finance** | portfolio/tx-history — không fresh |
| **Socket** | bridge routing — không liên quan |

---

## 4. Xếp hạng adopt (cost × reliability)

1. **GMGN official Agent API** — `fresh_wallet_rate` + `is_new`. 0 chi phí mới, đã tích hợp. Primary.
2. **Solscan Pro `active_age`** — 50 ví/call, 100 CU. Tự tính đúng %, cross-check GMGN. Rẻ nhất.
3. **Bubblemaps** — aggregate độc lập để đối chiếu; 1 cr/holders.
4. **Bitquery** — first-buy on-chain, không cần per-wallet call.
5. **Helius `funded-by`** — chỉ deep-dive top holders (per-wallet, plan trả tiền).
6. **InsightX** — chỉ khi cần signal cluster ví mới.

**Verify status:**
(a) ✅ **XONG 2026-09-28** — `fresh_wallet_rate` = **% SUPPLY** do ví fresh giữ (docs GMGN ghi sai "ratio of fresh wallets among holders"; chứng minh ở §5). Đồng thời: `wallet_tags_stat.fresh_wallets` cap 1000, và GMGN UI **không** hiển thị fresh ratio (chỉ API có — đã kiểm chứng bằng browser thật).
(b) ⏳ chưa — shape field `fresh` trong Bubblemaps metrics (public schema chỉ hiện `supply_stats`/`scores`).

---

## 5. GMGN field semantics — VERIFIED live 2026-09-28 (token AGI)

Token test: `CaWZeUM4FvX9dPkjGc2xHS6tSN3qJfTWyvaG77aM5o7h` (sol, holder_count 4085).

✅ **`stat.fresh_wallet_rate` = % SUPPLY do ví fresh nắm giữ** — docs GMGN ghi SAI
("Ratio of fresh/new wallets among holders").

**Bằng chứng quyết định (PONSKI, holder_count=203):** `fresh_wallets=6`, `fresh_wallet_rate=0.0633`;
Σ `amount_percentage` của đúng **6** ví tag fresh = **6.3277%** → **khớp 4 chữ số**.
Nếu là count-ratio thì phải là 6/203 = **2.96%**, không phải 6.33%.

**Field nào là gì:**

| Muốn lấy | Field | Cách tính | Giá trị token AGI |
|---|---|---|---|
| **Supply held by fresh (%)** | `stat.fresh_wallet_rate` | có sẵn | 0.156 → 0.1766 (live) |
| Số ví fresh | `wallet_tags_stat.fresh_wallets` | có sẵn, **cap 1000** | 1000 (thật ≥1000) |
| Supply held by fresh (verify) | — | `Σ amount_percentage` của holder `tag=fresh_wallet` trên `/v1/market/token_top_holders` | **~17.9% (top-100)** |

**Lệnh verify:**
```
GET /v1/market/token_top_holders?chain=sol&address=<MINT>&limit=100&tag=fresh_wallet&order_by=amount_percentage&direction=desc
→ cộng amount_percentage toàn bộ list
```

**Lưu ý:**
- `is_new` (per-holder) **≠** tag `fresh_wallet`: trong 100 ví tag fresh chỉ 23 có `is_new=true`.
- `token_top_holders` **cap 100** → 16.16% là **chặn dưới** (còn ~900 ví fresh nhỏ ngoài top-100).
- So sánh Nansen "Supply held by Fresh Wallets" **5.82%** vs GMGN **16.16%** → chênh do **định nghĩa "fresh" khác nhau** (GMGN = "new wallet with no prior trading history"), không phải lỗi dữ liệu.

**Đo trên nhiều token (2026-09-28):**

| Token | holders | `fresh_wallet_rate` | `fresh_wallets` | Supply held by fresh (tag, top-100) |
|---|---|---|---|---|
| AGI (micro-cap) | 4,085 | 15.6% | 1000 | **16.16%** |
| BONK | 1,010,693 | 0.05% | 1000 | 0.20% |
| WIF | 532,673 | 0.1% | 1000 | 0.11% |
| FARTCOIN | 220,648 | 0.13% | 1000 | 0.16% |

→ `wallet_tags_stat.fresh_wallets` **= 1000** ở mọi token ⇒ **CAP trần 1000**, KHÔNG phải số thật khi token lớn.

⚠️ **Ngoại lệ token lớn:** BONK `fresh_wallet_rate=0.0005` (0.05%) nhưng top-100 ví fresh đã giữ **0.1968%** (> rate) ⇒ với token lớn/già, `fresh_wallet_rate` có thể **stale hoặc lấy mẫu**, không đối chiếu được. Chỉ tin chắc ở token nhỏ/trung; token lớn nên dùng Σ top-100 làm chặn dưới.

**Bằng chứng cap (BONK, 1,010,702 holders):** 5 tag dính đúng 1000 —
`fresh=1000, sniper=1000, rat_trader=1000, whale=1000, bundler=1000`;
các tag còn lại là số thật: `smart=857, renowned=656, top=329, creator=21`.
Token mới **PONSKI** (162 holders) trả `fresh_wallets = 0/1` → field trả số thật khi < 1000.
⇒ Với token ≥1000 ví fresh, field chỉ cho biết **"≥1000"**, không dùng được.

**⚠️ Bug API (silent wrong data):** gọi `token/info` liên tiếp quá nhanh (~1s) ⇒ API trả **HTTP 200, `code:0, message:success`, nhưng toàn bộ `data` = 0** (`holder_count=0`, mọi tag = 0). **Không phải 429**, không có cờ báo lỗi ⇒ parser dễ ghi số 0 sai. Spacing **≥5-6s** thì hết. ⇒ Bắt buộc: spacing + validate `code==0 AND holder_count>0` trước khi tin.
→ Fresh supply sụp rất nhanh khi token trưởng thành (16% micro-cap → 0.1-0.2% large-cap) ⇒ tín hiệu tốt cho early-stage.
→ Rate limit: `token_top_holders` weight 5, free plan bị `429` sau ~3-4 call liên tiếp; nghỉ ~75s thì gọi lại được ⇒ cần spacing + cache.

---

## Source index
- https://docs.gmgn.ai/index/gmgn-agent-api · https://github.com/GMGNAI/gmgn-skills
- https://pro-api.solscan.io/pro-api-docs/v2.0/reference/v2-account-metadata-multi · /docs/pricing
- https://www.helius.dev/docs/wallet-api/funded-by · /docs/billing/plans · /docs/billing/credits
- https://docs.bubblemaps.io/data/api/tokens/top-holders · /tokens/metrics · /api/introduction
- https://docs.insightx.network/docs/behavioural-nodes · /reference/websocket-clusters
- https://docs.bitquery.io/docs/blockchain/Solana/solana-balance-updates/
- https://docs.dune.com/data-catalog/curated/balances/solana-latest-balances
- https://solanatracker.mintlify.app/data-api/pnl-v2/token/get-token-first-buyers
- https://docs.solana.fm/reference/get_account_transactions
- https://docs.birdeye.so/reference/get-token-v1-holder-profile · /holders/holder-metrics (Moralis)
- https://docs.vybenetwork.com/docs/token-holder-data · https://arkm.com/api/docs · https://arkm.com/llms.txt
- https://developer.cielo.finance/docs/fetch-feed · https://docs.dexscreener.com/api/reference
- https://goldrush.dev/docs/chains/solana · https://pro.kaito.ai/kaito-api · https://api-docs.step.finance/
