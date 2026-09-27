# Tracked CT Wallet Alpha Engine — Data Source Synthesis
**Ghép 3 tài liệu:**
1. `message.txt` (14KB, 26 sections) — Data Science Brief: Tracked CT Wallet Analytics & Alpha Signal Engine
2. Framework01 Notion export — dashboard spec 9 cột (CA → Entry)
3. `2026-09-07-nansen-gmgn-birdeye-api-comparison.md` — API research đã verify (routes, pricing, rate limits)

**Mục đích:** map toàn bộ data requirements của Alpha Engine (brief) + Dashboard (Framework01) vào 3 platform, chỉ ra gaps và kiến trúc pipeline.

---

## 1. Quan hệ giữa 3 tài liệu

```
message.txt (Alpha Engine)          Framework01 (Dashboard)
  wallet analytics layer                  display surface
  ├─ Q1-Q6 research questions             ├─ 9 cột: CA, Tracked By,
  ├─ F1-F14 factors                       │  Nansen Setup, Holder,
  ├─ Alpha Score V0 (rule-based)          │  Inflow, Holding %,
  └─ Backtest / walk-forward              │  Volume, Tier, Entry
          │                                      │
          └────────────┬─────────────────────────┘
                       ▼
          Cùng 1 nền tảng data: tracked CT wallets (CT01..CTN) + token market data
          → Nansen/GMGN/Birdeye là 3 ứng viên provider
```

- **Framework01** = bề mặt hiển thị realtime cho human decision (bước cuối pipeline bot: Alert → Human Final Decision).
- **message.txt** = engine phía sau: biến "CT buys token" thành quantified signal (Signal Lift, Conviction, Consensus, Specialization).
- Cả hai dùng chung tracked-wallet DB (đã có: wallet_address, name, category, source — brief §2) và cùng cần token context data.

---

## 2. Data requirements tổng hợp (union của 2 docs)

### P1 — Must Have (brief §25 + Framework01 realtime cột)
| Requirement | Nguồn requirement | Đơn vị dữ liệu |
|---|---|---|
| Historical trades của tracked wallets (entry_ts, entry_price, amount_usd) | brief P1 | per wallet |
| Entry context: MC, liquidity, token_age, volume 1m-30m, price_change | brief §6 | per trade |
| Wallet PnL, trade count, track record | brief §4 | per wallet |
| Relative buy size (current ÷ median) | brief §8 | per trade |
| Forward returns 5m→24h, MFE/MAE | brief §16 | per trade |
| Holder count realtime (Framework01 cột 4) | F01 | per token, realtime |
| 24H volume buy+sell realtime (F01 cột 7) | F01 | per token, realtime |

### P2 — High Value
| Requirement | Nguồn |
|---|---|
| Specialization profile (wallet × setup matrix) | brief §11 |
| Entry timing sweet spot buckets | brief §7 |
| Consensus events (N wallets cùng CA trong window) | brief §13 + F01 cột 2 |
| Independent wallet clusters (funding graph) | brief §14 |
| Buy/liquidity, volume regime | brief F8, F13 |
| Fresh Wallet %, Top100 ↓, exchange balance (F01 Nansen Setup) | F01 cột 3 |
| Tracked Holding % của supply | F01 cột 6 |

### P3 — Advanced
Narrative classification, behavior clustering, ML, dynamic weighting (brief P3) — ngoài scope platform research.

---

## 3. Requirement → Platform mapping

Legend: ✅ native verified route · 🟡 partial/computable · ❌ gap · **[u]** unverified · chi tiết routes/pricing xem research doc

### 3.1 Wallet-level (Alpha Engine core)

| Requirement | GMGN (free) | Birdeye ($199 Premium) | Nansen |
|---|---|---|---|
| PnL + trade count per wallet | ✅ `wallet_profits` batch **100 wallets/call** (1d/7d/30d/all) | 🟡 category confirmed, REST route **[u]** | ✅ `profiler/address/pnl-summary` 1 cr/wallet |
| Trade history per wallet (entry_ts, price, amount_usd) | ✅ `wallet_activity` (W-limited ~4 rps) | 🟡 WS per wallet (1 addr/conn); REST **[u]** | ✅ `profiler/address/dex-trades` 1 cr/wallet |
| **Độ sâu lịch sử** (backtest cần months) | ⚠️ **[u]** — chưa verify depth của `wallet_activity`; `wallet_profits` có window "all" nhưng chỉ aggregate | 🟡 per-token `txs/token` có `seek_by_time` (per-wallet **[u]**) | 🟡 không doc rõ depth |
| Relative buy size (÷ median) | ✅ tự tính từ amount_usd history | 🟡 | ✅ |
| Accumulation sequence (buy velocity) | ✅ wallet_activity tuần tự | 🟡 WS | ✅ |
| Win rate, median ROI per trade | 🟡 tính từ wallet_activity (PnL per trade cần ghép exit) | 🟡 | ✅ profiler/pnl |

**→ Wallet analytics: GMGN là backbone** (free + batch). Win rate/median ROI cần join trade→exit — derive từ activity + K-line.

### 3.2 Token context at entry (point-in-time — phần khó nhất)

| Requirement | Giải pháp | Risk |
|---|---|---|
| MC at entry (historical) | K-line 1m (GMGN free / Birdeye OHLCV) × supply | ⚠️ supply thay đổi theo thời gian — mint/burn làm sai MC lịch sử. Không platform trả supply-at-T. Ước lượng supply hiện tại → đánh dấu approximation |
| Token age at entry | token creation time (GMGN `token/info`, Birdeye metadata) | ✅ ổn |
| Volume 1m/5m/15m/30m trước entry | K-line 1m history | ✅ ổn |
| Liquidity at entry (historical) | ❌ **gap** — K-line không có liquidity; token_overview là current. Fallback: pair/pool history riêng, hoặc snapshot collector từ giờ trở đi | cần quyết định |
| Holder count at entry | ⚠️ **chỉ Nansen `tgm/historical-top-holders` (25 cr/call)** — top holders at T, không full count. Fallback: snapshot collector (forward-only) | backfill đắt, forward free |
| Holder structure at entry (F01 cột 3b: Top100 ↓) | GMGN poll + tự diff snapshot (free) · Nansen native delta 5 cr/call | snapshot collector khuyến nghị |

**→ Điểm mấu chốt của backtest (brief §21):** mọi token metrics phải point-in-time. Chỉ price/volume/age reconstruct được từ K-line; **liquidity + holders + supply lịch sử không có source free** → bắt buộc build **snapshot collector riêng** (cron mọi 1-5m cho tokens trong universe) và chấp nhận backfill hạn chế cho quá khứ.

### 3.3 Realtime signal stream (pipeline bot: Wallet buys CA → Candidate → Alert)

| Bước pipeline | Solution | Ghi chú |
|---|---|---|
| Phát hiện tracked wallet mua CA **realtime** | **Birdeye WS `SUBSCRIBE_WALLET_TXS`** — 1 wallet/conn; Premium 500 conns → đủ cho ~100-200 tracked wallets | duy nhất có push; GMGN phải poll wallet_activity |
| Consensus detection (§13) | Ghép wallet events trong window → wallet_count, buy_velocity, time_dispersion | làm ở backend, data từ Birdeye WS + GMGN poll backup |
| Entry signal (F01 cột 9: volume threshold $300K) | Birdeye WS `SUBSCRIBE_LARGE_TRADE_TXS` + `SUBSCRIBE_TXS` | native USD-threshold stream |
| New token discovery (baseline universe §17) | Birdeye WS `SUBSCRIBE_NEW_PAIR`/`TOKEN_NEW_LISTING` + GMGN trending 1m | |
| Smart money cross-stream | GMGN `track smartmoney`/`kol` (free, poll) · Nansen smart-money/* 5 cr | |

### 3.4 Labels & clustering

| Requirement | Solution |
|---|---|
| Fresh wallet (F01 3a + brief) | ✅ **GMGN duy nhất**: `wallet_tags_stat.fresh_wallets`, per-holder `is_new`/`--tag fresh_wallet` |
| Top100 ↓ (F01 3b) | GMGN snapshot-diff (free) hoặc Nansen `tgm/holders` `balance_change_24h/7d/30d` (5 cr/call) |
| Exchange/LP exclusion (F01 3c, cột 4) | GMGN `addr_type=2` + Nansen `label_type:"exchange"`; **burn exclusion: không platform nào** → RPC/GoPlus |
| Funding graph / cluster detection (§14) | ❌ **gap lớn nhất** — không platform nào expose transfer graph. Buộc RPC indexer riêng (Alchemy/Helius/QuickNode + raw transfers) — chiếm phần lớn infra P2 |
| Validate tracked DB vs Nansen Smart Money labels | Nansen `tgm/holders` `premium_labels=true` 150 cr — one-off batch cho toàn bộ tracked wallets, không phải realtime |

---

## 4. Kiến trúc pipeline đề xuất

```
┌─ LAYER 1: REALTIME (Birdeye WS Premium $199/mo) ─────────────┐
│ SUBSCRIBE_WALLET_TXS × tracked wallets → Candidate events    │
│ SUBSCRIBE_LARGE_TRADE_TXS / NEW_PAIR  → market context       │
│ → consensus window aggregation (backend)                     │
└──────────────────────────────────────────────────────────────┘
┌─ LAYER 2: WALLET INTELLIGENCE (GMGN free) ───────────────────┐
│ wallet_profits batch → quality metrics (nightly refresh)     │
│ wallet_activity → trade history, conviction, accumulation    │
│ token_top_holders poll → snapshot DB (T100↓, fresh%, addr)   │
└──────────────────────────────────────────────────────────────┘
┌─ LAYER 3: MARKET DATA / LABELS (Birdeye REST + GMGN K-line) ─┐
│ K-line 1m → forward returns, MFE/MAE, Y_20_30m... labels     │
│ token_overview → holder count, vBuy/vSell 5s frames          │
│ Baseline universe: tokenlist/trending sample same MC/age     │
└──────────────────────────────────────────────────────────────┘
┌─ LAYER 4: OWN INFRA (gaps không platform nào phủ) ───────────┐
│ RPC indexer → funding graph, independent clusters (§14)      │
│ Snapshot collector → point-in-time holders/liquidity/supply  │
│ GoPlus/RPC → burn/LP exclusion cho holder count              │
└──────────────────────────────────────────────────────────────┘
┌─ OPTIONAL: Nansen (Pro $69 + credits, one-off/backfill) ─────┐
│ historical-top-holders 25cr → backfill point-in-time holders │
│ premium_labels 150cr × 1 lần → validate tracked-wallet DB    │
│ KHÔNG dùng cho realtime polling (cache 10-30')               │
└──────────────────────────────────────────────────────────────┘
```

## 5. Cost model

| Phase | Chi phí | Ghi chú |
|---|---|---|
| Realtime ops (bot live + dashboard F01) | **$199/mo** (Birdeye Premium) + GMGN free | WS 500 conns đủ 100-200 wallets; CU burn cần audit per-endpoint **[u]** |
| Backtest phase (one-off) | ~$0 GMGN (rate-limited, kéo dài thời gian) + $50-100 Nansen nếu backfill holders | ví dụ: 500 tokens × 4 mốc × 25 cr = 50k cr = $50 |
| Cluster infra (P2) | RPC node/Alchemy ~$49-199/mo | chỉ khi làm §14 |
| Cluster validation | 150 cr × (số wallets ÷ 1 call set) ≈ <$5 one-off | Nansen premium_labels |

## 6. Open items phải verify trước khi build

1. **GMGN `wallet_activity` historical depth** — backtest (brief §21-22) sống chết nhờ cái này. [u]
2. **Birdeye wallet REST routes** (`/defi/wallet/*`) — nếu có REST thì batch backfill wallet history dễ hơn WS. [u]
3. **GMGN free-key hidden quotas** — confirm lúc signup. [u]
4. **Historical liquidity source** — quyết định: pair-history API riêng hay snapshot-only từ giờ. [gap]
5. **Supply-at-T cho MC reconstruction** — chấp nhận approximation hay tích hợp mint/burn events. [gap]
6. **Birdeye per-endpoint CU cost** — audit trước khi commit Premium (memecoin volume endpoints burn CU nhanh). [u]

## 7. Bottom line

- **Engine + Dashboard dùng chung 1 stack: Birdeye Premium (realtime + market data) + GMGN Agent API (wallet/holder intelligence, free) + snapshot collector tự build.**
- Nansen chỉ vào 2 vai trò one-off rẻ: backfill holders lịch sử (25 cr) + validate tracked DB (150 cr × ít lần). Không realtime.
- Brief §25 Priority 1 **đủ data để start ngay** với combo trên, ngoại trừ 2 items cần verify: GMGN activity depth + historical liquidity.
- Phần tốn công nhất không phải API mà là **Layer 4**: funding-graph clustering (§14) và snapshot collector — cả hai không mua được, phải build.
