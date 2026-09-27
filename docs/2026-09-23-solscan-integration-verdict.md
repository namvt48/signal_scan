# Có nên tích hợp Solscan vào signal_scan? — phán quyết (2026-09-23)

Dựa trên: bản đồ dữ liệu→nguồn của repo, tài liệu Pro API v2 của Solscan (kiểm 2026-09-23),
và so sánh 9 provider dữ liệu holder.

---

## 1. Bản đồ dữ liệu hiện tại (cột → nguồn)

| Cột | Nguồn | Transport |
|---|---|---|
| symbol, supply, price, marketCap, liquidity, deployedAt | Nansen essential-data | **browser crawl** (fallback: Nansen credit API) |
| volume24h / buy / sell | Nansen volume-details | **browser crawl** (fallback: Nansen credit API) |
| holder count | Nansen gini-stats | **browser crawl** (fallback: Nansen credit API) |
| **fresh wallet %** | Nansen gini-stats | **browser crawl — KHÔNG có đường khác** |
| **T100 multiple / pct** | Nansen hourly-stats series → `t100Genesis` | **browser crawl — KHÔNG có đường khác** |
| **Low float (LF)** | Nansen series nhãn `exchange`, điểm trái nhất | **browser crawl — KHÔNG có đường khác** |
| balanceRange d1/d7/d30 (chart) | cùng series trên | browser crawl |
| symbol/supply/price (floor) | DAS `getAsset` | Solana JSON-RPC |
| trackedHolding | `getTokenAccountsByOwner` ×2 | Solana JSON-RPC |
| trackedBy, trackedInflow, volume1h, entry | tính cục bộ từ dữ liệu trên | local |
| entry_usd, giá trade | DexScreener (`api.dexscreener.com`) | HTTP (trong `wallet_watch.py`) |

**Kết luận bản đồ:** đúng 3 chỉ báo setup (fresh%, T100 multiple, LF) là **crawl-only, không có
đường thay thế trong code**. Mọi thứ khác đều đã có fallback DAS / Nansen credit / tính cục bộ.

## 2. Solscan Pro API v2 làm được gì

| Cần | Solscan | Ghi chú |
|---|---|---|
| symbol/name/decimals/supply/price/market_cap | ✅ `GET /v2.0/token/meta` | kèm `holder` = tổng số holder, `created_time` |
| holder count | ✅ | `token/meta.holder` + `token/holders.data.total` |
| **top-100 holder kèm balance** | ✅ `GET /v2.0/token/holders` | `rank`, `amount`, `owner`, `value` (USD), `percentage`; lọc `from_amount/to_amount/from_value/to_value` |
| volume 24h + pool | ✅ `GET /v2.0/token/markets` | snapshot 24h/prev-24h, không có time window |
| transfer history | ✅ `GET /v2.0/token/transfer` | có `from_time`/`to_time` |
| **fresh wallet %** | ❌ | không có endpoint wallet-age |
| **T100 cohort TẠI GENESIS** | ❌ | chỉ trả top-100 **hiện tại**, không có snapshot lịch sử |
| **LF / genesis float** | ❌ | không có series ở độ chi tiết đó |
| batch nhiều token | ⚠️ chỉ `token/meta/multi` (max 50) | **`token/holders` không batch**; gói Lite **tắt hết endpoint multi** |

**Chi phí (verify 2026-09-23):** mọi endpoint phẳng **100 CU/call**. Lite **$49/tháng = 20M CU**,
rate limit 1.000 req/60s; L2 **$199** (150M CU), L3 **$399** (500M, 2.000 req/60s),
L4 **$1.099** (1,5B, 3.000 req/60s), Enterprise = liên hệ.
**KHÔNG có tier free** cho Solscan Pro API — bậc rẻ nhất là $49. (Etherscan API có nhắc "free tier users"
nhưng đó là API của Etherscan, không phải Solscan Pro; `public-api.solscan.io` không còn trong docs hiện tại.)
Top-100 = **3 call** (page_size max 40; export endpoint tối đa 5.000 record, 1 req/phút).

**ToS (đã verify, text gốc — `https://docs.solscan.io/solscan-api/solscan-api-terms-and-services`):**

- **Cache/lưu trữ — ĐƯỢC, nhưng chỉ "personal use":**
  > "You are permitted to view, print, download, **cache and make copies** of our API Content derived
  > from the API Services **strictly for personal use only and not for commercial use**. You may not
  > reproduce, transmit, broadcast, publish, modify, **display, distribute**, sell, license, rent,
  > lease or create a derivative form of the API Content … without our prior consent."
- **Mục đích thương mại / lợi ích tài chính — PHẢI xin phép bằng văn bản:**
  > "ALL API CONTENT … MAY NOT BE USED AS A BASIS FOR ANY **FINANCIAL OR COMMERCIAL GAINS**
  > WITHOUT OUR EXPRESS PRIOR WRITTEN CONSENT."
  > (Prohibited Activities: "Sell, trade, rent, loan, lease, license or provide our API Content … for
  > commercial purposes.")
- **Non-Competition — có, và còn hiệu lực SAU khi huỷ sub:**
  > "…you agree not to develop, create or offer any software services that directly compete with any
  > software services provided by us … This non-competition clause … **shall remain in effect after the
  > cancellation of your subscription**."
- **Huỷ sub → phải XOÁ dữ liệu đã cache:**
  > "You shall **promptly destroy the API Documentation, Content, Data and any other information
  > procured by us … that may be in your possession or control**."
- **Không có** điều khoản nào cho phép giữ dữ liệu **vĩnh viễn**, và **không có** quy định thời hạn lưu.
- Bên ký kết: **Block Solutions Pte. Ltd (Singapore)**. ToS chung: `solscan.io/terms-of-service`
  (`solscan.io/terms` → 404). Solscan API Terms **không** có điều khoản cấm AI/ML; Etherscan API ToS
  (`etherscan.io/apiterms`) **có** (cấm train model / tạo dataset) — chỉ áp dụng nếu coi Etherscan là bên
  quy định.

## 3. So sánh nhanh các nguồn holder cohort (đã verify)

| Provider | Top-100 + count? | Cohort lịch sử? | Giá đủ cho ~100-500 token @12h | ToS lưu DB |
|---|---|---|---|---|
| **Solana Tracker** | ✅ 1 call ra cả top-100 + `total` | chỉ chart holder-**count**; không có balance quá khứ | **Advanced €50** = 200K req/tháng, rate limit **"None"** | §6.4 **cho phép hiển thị derived data** (charts/analytics/aggregations), **cấm redistribute raw**; lưu trữ **không được nhắc** (§4 nói ST không sở hữu data on-chain; §6.2 cho phép "dashboards, analytics tools") |
| **Solscan Pro** | ✅ (3 call) | ❌ | **Lite $49** = 20M CU, 1.000 req/60s; **không có tier free** | ❌ **"personal use only, not for commercial use"**; cấm "display, distribute"; cấm dùng làm "basis for financial or commercial gains" nếu không có văn bản; huỷ sub → **phải destroy dữ liệu đã lưu**; **non-compete còn hiệu lực sau khi huỷ** |
| **Bitquery** | ⚠️ tự tổng hợp từ transfers | ✅ **nguồn DUY NHẤT verify được để dựng lại cohort genesis** (V1 transfers lọc theo ngày) | **Personal $39** = 100k points ≈ 20k call | ⚠️ chưa verify |
| Birdeye | ✅ | chỉ holder-count chart | Lite $39 / Starter $99 (chưa verify CU/call) | ❌ **cấm lưu vào database/archival repository** |
| Vybe | ✅ (top 1000, có label) | holder-count ts | Advanced $149 (100 token) → **vượt ngân sách** | ⚠️ chưa verify |
| CoinGecko | ⚠️ max 40 holder, không có count | ❌ | Analyst **$103,2** | ⚠️ chưa verify |
| Helius | ❌ không có endpoint holder | ❌ | — | — |
| Moralis | ❌ **endpoint Solana holders đã bị xoá 2026-07-31** | ❌ | — | — |
| Nodit | ❌ Solana Web3 Data API = "Soon" | ❌ | — | — |

## 4. Phán quyết (đã cập nhật sau khi verify ToS)

**KHÔNG tích hợp Solscan Pro API.** Hai lý do độc lập, mỗi lý do đủ để loại:

**Lý do 1 — không giải quyết vấn đề (đã có từ trước):**
- Thứ duy nhất crawl-only là **3 chỉ báo setup**. Solscan không thay được cái nào:
  không có wallet-age (fresh%), không có top-100 balance lịch sử (T100 multiple),
  không có genesis float series (LF).
- Cái Solscan thay được — metadata/supply/price/mcap/liquidity/volume/holder count — **đã có
  fallback DAS + Nansen credit API rồi**. Lợi ích thật chỉ là bớt một tầng phụ thuộc CF cho
  khối phụ, không phải bỏ crawl.

**Lý do 2 — ToS chặn thẳng use case này (mới verify):**
- License Solscan là **"personal, non-commercial"**, cache chỉ được **"strictly for personal use only
  and not for commercial use"**. Một tool sinh signal để trade rơi vào **"basis for any financial or
  commercial gains"** → cần **express prior written consent**.
- **Hiển thị cho người khác** = "display, distribute" → cấm. Dashboard riêng thì được; show cho ai thì không.
- **Huỷ sub → phải destroy toàn bộ dữ liệu đã lưu** (SQLite của signal_scan lưu metric vĩnh viễn
  → xung đột trực tiếp).
- **Non-Competition còn hiệu lực sau khi huỷ sub**, và phạm vi rộng ("substantially similar function,
  feature or capabilities").
- **Không có tier free** → tối thiểu $49/tháng chỉ để dùng thứ đã có fallback miễn phí.
- Cộng lại: trả tiền để nhận thêm rủi ro pháp lý, đổi lấy thứ không giải quyết vấn đề.

**Nếu mục tiêu là bỏ crawl Nansen:** phải tự dựng snapshot collector + tự diff
(xem `docs/2026-09-07-alpha-engine-data-sources.md`). Đổi provider không giải quyết.

**Nếu mục tiêu là có holder cohort rẻ + hợp lệ:** **Solana Tracker** ($50, 1 call = top-100 +
holder count, ToS cho phép derived data) hợp hơn Solscan; dùng **Bitquery** ($39) chỉ cho
backfill cohort genesis.

## 5. Kiến trúc đúng cho T100 multiple (điểm đáng giá nhất)

Cách hiện tại kéo lại top-100 từ Nansen mỗi lần. Cách tự chủ và rẻ hơn:

1. **Chụp danh sách ví top-100 MỘT LẦN** ngay khi phát hiện CA (lưu vào SQLite).
2. Mỗi lần refresh chỉ hỏi **số dư của ĐÚNG danh sách ví đó** → so với số dư genesis → ra multiple.

Không phụ thuộc provider nào có endpoint "historical cohort", và rẻ hơn nhiều lần. Endpoint cho bước 2
**đã verify là tồn tại**: Solana Tracker `POST https://rpc-data.solanatracker.io` →
`getTokenAccountsByOwners` — "Query balances for one mint across **up to 250 wallets in a single
request**". 500 ví = **2 call**. (Đây là sản phẩm **Solana RPC**, không phải Data API → có bảng
credit/rate limit riêng tại `/solana-rpc/credits-and-rate-limits`.)

## 6. Chi phí tích hợp (giữ lại để tham chiếu — nay là moot, xem §4)

- 1 class mới implement `MarketDataProvider` (`provider.ts:97-110`): `name`, `tokenInfo`,
  `metric(kind: 'essential'|'volume'|'gini')`, `assetInfo?`, `walletTokenHoldings`.
- Thêm 1 nhánh `ProviderMode` (`config.ts:25-32`) + ternary chọn provider (`index.ts:28-32`).
  **Không có registry/factory** — chi phí thấp.
- Điểm vênh: contract `metric(kind)` chia theo loại dữ liệu, Solscan chia theo **token**
  (1 token-overview trả cả meta + holders + market) → phải cache 1 token-overview cho mỗi CA.
- **Cùng shape này áp dụng cho Solana Tracker** nếu chọn nó — chi phí tương đương.

## 7. Solana Tracker — ToS đã verify (2026-09-23)

Nguồn: `https://solanatracker.io/terms` (cập nhật **23/03/2026**), `https://docs.solanatracker.io/pricing.md`.

| Mục | Kết quả |
|---|---|
| Lưu trữ data vào DB | **KHÔNG được nhắc tới** — không có điều khoản cấm, cũng không có điều khoản cho phép. §4 nói dữ liệu là **public on-chain, ST không sở hữu**. §6.2 cho phép build "dashboards, analytics tools" và đẩy trách nhiệm "data handling practices" sang bạn. |
| Hiển thị metric phái sinh | ✅ **ĐƯỢC, minh thị** — §6.4: "You may **display derived data (charts, analytics, aggregations)** in your applications", với điều kiện không ngụ ý ST bảo trợ/đối tác chính thức. |
| Cấm gì | §6.4: "**Redistribution, resale, or sublicensing of raw API data is prohibited** without prior written authorization." §5: cấm scrape ngoài API; cấm build sản phẩm **cạnh tranh trực tiếp**. |
| Dùng thương mại | **KHÔNG được nhắc tới** — không có điều khoản nào buộc nâng tier. Chỉ white-label là Enterprise+ (FAQ). |
| Cache/retention limit | **KHÔNG có** điều khoản nào. |
| Bảng giá | Free €0 / 10.000 req / 3 req-per-giây · **Advanced €50 / 200.000 req / rate limit "None"** · Pro €200 / 1M · Premium €397 / 10M · Business €599 / 25M · Enterprise €1.499 / 100M · Enterprise+ custom |
| Cảnh báo "None" | §6.1 + §6.6 vẫn bảo lưu quyền **throttle/suspend vì "excessive usage"**; quá quota → `429`. → "None" là rate limit công bố, không phải bảo đảm tuyệt đối. |

**Khác biệt quyết định so với Solscan:** Solana Tracker **không** có điều khoản "personal use only",
**không** cấm dùng cho lợi ích tài chính, **không** bắt destroy dữ liệu khi huỷ, **không** có non-compete
ngoài "cạnh tranh trực tiếp", và **minh thị cho phép hiển thị derived data**. Cộng thêm **có tier free**
và **rẻ hơn** ($50 vs $49 nhưng 1 call ra cả top-100 + total holder count).
