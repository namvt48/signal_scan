# FOMO prod API — `prod-api.fomo.family`

**Ngày tổng hợp:** 2026-10-20
**Phạm vi:** chỉ backend mà web app `fomo.family` gọi trực tiếp. Không bao gồm `api.fomoapi.io`, PooTracker, Mobula hay bất kỳ provider bên thứ ba nào.
**Trạng thái:** investigation only — không phải API công khai, không có contract chính thức, không dùng cho production khi chưa xác minh đủ.

---

## 1. Kết luận ngắn

- Có thể query read-only được **balances, trades, swaps, PnL snapshot, token feed, leaderboard, holders** bằng session đăng nhập Fomo.
- Auth là **Privy Bearer token**; request phải có **browser-like TLS fingerprint**, nếu không Cloudflare trả `430` dù token hợp lệ.
- **Rate limit chưa biết.** Response quan sát được không có `RateLimit-*`, `X-RateLimit-*` hay `Retry-After`.
- Pagination chỉ rõ ở swaps (`lastSwapIdV2`); trades/feed/token có `hasNextPage` nhưng **chưa biết param trang tiếp**.
- Catalog HAR có ghi `wss://prod-api.fomo.family/ws` (prices, fills, feed) nhưng **chưa xác minh live**.
- Schema khác `FomoPosition`/`FomoSwap` hiện tại → phải viết adapter, xử lý cross-chain, và giữ nguyên semantics `unknown ≠ 0`.

---

## 2. Contract & auth

| Hạng mục | Giá trị |
|---|---|
| Base URL | `https://prod-api.fomo.family` |
| Auth | `Authorization: Bearer <privy access token>` |
| Header bắt buộc khác | Browser-like headers (`Accept`, `Origin`, `Referer`, `User-Agent` Chrome) |
| Cloudflare | Plain `curl`/`requests`/`node` bị **HTTP 430** dù token hợp lệ; `curl_cffi` giả lập TLS Chrome thì pass |
| Envelope | `{ "success": bool, "message": string, "responseObject": object, "statusCode": number }` |
| Token refresh | Privy access + refresh token; helper không chính thức refresh tự động, nhưng lưu credential plaintext |
| Contract status | HAR capture 2026-09-01; live checks 2026-10-16 và 2026-10-20; **không có tài liệu chính thức** |

**Không được làm:**
- Copy cookie/token từ browser Brave vào backend.
- Dùng flow login của `fomo-sapiens` làm auth production (nó persist token/private key vào `.env` plaintext).
- Gọi các endpoint write/trade khi chỉ khảo sát dữ liệu.

---

## 3. Endpoint map

Chú thích trạng thái:
- **Live**: đã thấy response thật trong live check 2026-10-16 hoặc 2026-10-20.
- **Catalog**: có trong HAR catalog 2026-09-01, chưa live-verify lại.
- **UI-only**: thấy request trên giao diện nhưng chưa chụp status/schema đầy đủ.
- **Write**: không dùng cho read-only research.

### 3.1 Portfolio / user

| Method | Route                                                                       | Dữ liệu                                                                                                                                                                                                                                     | Trạng thái                                       |     |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --- |
| GET    | `/v2/users/{userId}/balances`                                               | `balances[]`: `balance`, `userToken`, `activeTrade`, `valuation`; top-level `otherPnl`, `otherPnlV2`, `livePerpPnl`, `otherEquity`                                                                                                          | **Live 200/304**                                 |     |
| GET    | `/v2/users/{userId}/swaps`                                                  | `swaps[]`: `id`, `networkId`, `inTokenAddress`, `outTokenAddress`, `humanUsdAmountIn`, `humanUsdAmountOut`, `createdAt`, `outTradeId`, `inNetworkId`, `outNetworkId`; `hasNextPage`                                                         | **Live 200**                                     |     |
| GET    | `/v2/users/{userId}/swaps?lastSwapIdV2={cursor}`                            | Trang kế tiếp                                                                                                                                                                                                                               | **Live UI** — 25 item/page; trang kế không trùng |     |
| GET    | `/trades?userId={userId}&orderBy=closedAt[&tokenAddress={ca}]`              | `activeTrades[]`, `closedTrades[]`, `closedCount`, `hasNextPage`; mỗi trade có `trade.tokenAddress`, `networkId`, `humanTokenAmount`, `avgEntryPrice`, `realizedPnlUsd`, `unrealizedPnlUsd`, `totalCostBasis`, `tokenMetadata.currentPrice` | **Live 200**                                     |     |
| GET    | `/trades/{tradeId}`                                                         | `trade`, `swaps`, `transfers`                                                                                                                                                                                                               | **Live**, response không rỗng                    |     |
| GET    | `/trades/{tradeId}/comments`                                                | Comment/thesis, `hasNextPage`                                                                                                                                                                                                               | **Catalog**                                      |     |
| GET    | `/v2/userTokens/aggregatedSnapshot?userId={id}&timestamp={ts}`              | `snapshotId`, `pnl`, `equity`                                                                                                                                                                                                               | **Live 200**                                     |     |
| GET    | `/v2/userTokens/aggregatedSnapshotById?userId={id}&snapshotId={snapshotId}` | Snapshot theo ID                                                                                                                                                                                                                            | **Live 304**                                     |     |
| GET    | `/v2/users/{userId}/spotlight`                                              | Spotlight trades/theses                                                                                                                                                                                                                     | **Live 200**                                     |     |
| GET    | `/v2/users/current/followingIds`                                            | Danh sách following                                                                                                                                                                                                                         | **Live 304**                                     |     |
| GET    | `/v2/users/{handle}/blessedonchain`                                         | Trạng thái on-chain của handle                                                                                                                                                                                                              | **Live 304**                                     |     |
| GET    | `/v2/transfers/with/{userId}`                                               | Transfer data                                                                                                                                                                                                                               | **Live 304**                                     |     |
| GET    | `/transfers/v2/supportedTokens`                                             | Token hỗ trợ transfer                                                                                                                                                                                                                       | **Live 304**                                     |     |
| GET    | `/v2/users/pin`                                                             | Chưa rõ semantics                                                                                                                                                                                                                           | **Live 304** — không dùng                        |     |
| POST   | `/v2/users`                                                                 | Body `{ address, evmAddress }`                                                                                                                                                                                                              | **Live 200 — Write, tránh**                      |     |

### 3.2 Feed / realtime

| Method | Route | Dữ liệu | Trạng thái |
|---|---|---|---|
| GET | `/feed/token?tokenAddress={ca}&networkId={id}&excludeThesis={bool}&threshold={usd}` | `items[]`: `type` (`swap_buy`/`swap_sell`), `id`, `tradeId`, `createdAt`, `userId`, `displayName`, `userHandle`, `usdAmount`, `marketCap`, `fdv`, `price`, `isDev`; `hasNextPage` | **Live 200** — 25 item (probe), 100 item (HAR), `hasNextPage=true` |
| GET | `/feed/token/sortedThesis?tokenAddress=&networkId=&afterTime=&beforeTime=&limit=&threshold=` | Thesis feed, `comment`, `authorTrade` | **Catalog** — phân trang theo time window |
| WSS | `wss://prod-api.fomo.family/ws` | “Live event stream (prices, fills, feed)” | **Catalog-only, chưa xác minh live** |

`/feed/token` là route gần nhất với nhu cầu “alert”: trả swap_buy/swap_sell theo token, có `userId`, `tradeId`, USD, MC, price. Tuy nhiên:
- Đây là **token-centric**, không phải “mọi giao dịch của user”.
- `threshold` lọc theo position size; chưa rõ có bỏ giao dịch nhỏ hay không.
- `limit` nhận tới 100 (live 2026-10-22: `limit=100` trả 100 item). Response
  không có cursor dùng được cho trang kế; watcher giữ cursor cục bộ theo
  `createdAt` + `id` and polled the first page every 60s (historical observation
  from 2026-10-22; this interval is configured separately per deployment).

### 3.3 Token / holders

| Method | Route | Ghi chú | Trạng thái |
|---|---|---|---|
| GET | `/hodlers/devs?tokenAddress=&networkId=` | Dev holdings, `user`, amount, pnl, cost basis | **Catalog** |
| GET | `/hodlers/top?tokens=[{address,networkId}]` | Top holders | **Catalog** |
| POST | `/hodlers/friends` | Body `{ tokens: [{address, networkId}], limit }` | **Live 200** |
| POST | `/proxy/cryptoTokens` | Token list | **Catalog** |
| POST | `/proxy/filterTokens` | Body là array `["{address}:{chainId}", ...]`; trả metadata/decimals/symbol | **Live 200** |
| POST | `/proxy/mostHeld` | Most-held tokens | **Catalog** |
| POST | `/proxy/tokenDetails` | Body `{ tokenId: "{address}:{chainId}" }` | **Catalog** |
| POST | `/proxy/tokenWarnings` | Body `{ address, networkId }` | **Catalog** |
| POST | `/proxy/trendingTokens` | Trending tokens | **Catalog** |
| GET | `/proxy/verifiedTokens` | Verified token list | **Live 200** |
| GET | `/tokenAllowList/detailed` | Token allow-list chi tiết | **Live 200** |

### 3.4 Discovery / config

| Method | Route | Ghi chú | Trạng thái |
|---|---|---|---|
| GET | `/v2/leaderboard` | Leaderboard mặc định | **Live 200** |
| GET | `/v2/leaderboard/24h`, `/7d`, `/30d` | Ranked traders; có `userId`, wallets, PnL, volume, holdings | **Live 200** |
| GET | `/v2/clans/leaderboard?window=&limit=` | Clan leaderboard | **UI-only** |
| GET | `/watchlist` | Watchlist của account | **Live 304** |
| GET | `/config` | App config | **Live 304** |
| GET | `/v1/perps/listed-perps` | Danh sách perp | **Live 200** |
| POST | `/sweeps` | Chưa rõ semantics | **Live 200** — không dùng |

### 3.5 Write / trade — không dùng

| Method | Route | Mục đích |
|---|---|---|
| GET | `/swaps/v2/status?relaySwapId=` | Trạng thái swap |
| POST | `/swaps/v2/fast-fill` | Thực thi swap |
| POST | `/trades/comment` | Tạo thesis/comment |

---

## 4. Schema quan trọng

### 4.1 Envelope

Mọi response quan sát được bọc:

```json
{
  "success": true,
  "message": "...",
  "responseObject": { },
  "statusCode": 200
}
```

→ Luôn đọc `responseObject`, không đọc top-level.

### 4.2 Balances

```text
responseObject.balances[]:
  balance            // thông tin balance
  tokenFilterResult  // metadata token
  userToken          // token user
  activeTrade        // trade đang mở
  valuation          // giá trị
responseObject:
  otherPnl, otherPnlV2, livePerpPnl, otherEquity
```

### 4.3 Swaps

```text
responseObject.swaps[]:
  id, createdAt
  networkId
  inTokenAddress, outTokenAddress
  humanUsdAmountIn, humanUsdAmountOut
  outTradeId
  inNetworkId, outNetworkId
responseObject.hasNextPage
```

- `inNetworkId` và `outNetworkId` có thể khác nhau → cross-chain.
- Không có trường “position” tổng hợp; đây là từng fill.

### 4.4 Trades (active/closed)

```text
responseObject:
  activeTrades[], closedTrades[]
  hasNextPage, closedCount

trade:
  tokenAddress, networkId
  humanTokenAmount
  avgEntryPrice
  totalCostBasis
  realizedPnlUsd, unrealizedPnlUsd
  tokenMetadata.currentPrice
  closedAt
```

### 4.5 Feed token

```text
responseObject.items[]:
  type: "swap_buy" | "swap_sell" | "thesis"
  id, tradeId, createdAt
  userId, displayName, userHandle
  usdAmount, marketCap, fdv, price
  isDev
responseObject.hasNextPage
```

- `usdAmount` là USD của swap.
- Khác `usdValue` của alert cũ: alert cũ dùng `usdValue` = position value sau BUY / realized PnL khi SELL, không phải size lệnh.

### 4.6 Aggregated snapshot

```text
responseObject rows:
  snapshotId, pnl, equity
```

---

## 5. Pagination

| Endpoint | Cơ chế | Đã xác minh |
|---|---|---|
| `/v2/users/{id}/swaps` | `lastSwapIdV2` | 25 item/page; trang kế không trùng; **cursor algorithm + termination chưa chốt** |
| `/trades` | `hasNextPage` | Chưa tìm được param trang tiếp |
| `/feed/token` | `hasNextPage` | Chưa biết param; một trang 25/100 item |
| `/trades/{id}/comments` | `hasNextPage` | Chưa rõ param |
| `/feed/token/sortedThesis` | `afterTime` / `beforeTime` / `limit` | Catalog-only |

**Quy tắc:** `hasNextPage=true` chỉ chứng minh còn trang, **không** chứng minh walk được hết lịch sử. Không dùng trang đầu làm “toàn bộ”.

---

## 6. Rate limit

Bằng chứng đo được (2026-10-20, reload một profile đã đăng nhập):

- **37 request** tới `prod-api.fomo.family` trong một lần reload.
- `GET /v2/users/{id}/swaps`: **200**.
- `GET /v2/users/{id}/balances`: **200** và **304**.
- Không thấy `429`.
- Response headers chỉ có `cf-cache-status`, `cf-ray`, `etag`, `server`, `x-request-id`, `content-encoding`… **không có** `RateLimit-*`, `X-RateLimit-*`, `Retry-After`.
- `304 Not Modified` là cache/conditional request, **không phải lỗi và không phải thiếu data**.

**Kết luận:** quota chưa biết. Không suy ra giới hạn an toàn từ việc không thấy header. Không dò bằng cách tăng tốc đến khi bị `429`.

Nếu thử polling:
- Bắt đầu thấp (ví dụ 1 req/s có jitter).
- Log status, latency, `cf-ray`, `etag`.
- Dừng ngay khi gặp `429`, challenge hoặc lỗi auth.
- Không chạy nhiều worker song song để “tăng throughput”.

---

## 7. Query recipe (read-only)

1. Dùng **account burner** đăng nhập web Fomo bằng browser.
2. Lấy **Privy access token** (+ refresh token) từ flow login.
3. Gọi bằng `curl_cffi` với `impersonate="chrome"`.
4. Header tối thiểu:
   - `Authorization: Bearer <token>`
   - `Accept: application/json`
   - `Origin: https://fomo.family`
   - `Referer: https://fomo.family/`
   - `User-Agent` Chrome
5. Đọc `responseObject`.
6. Với swaps: lưu `lastSwapIdV2`, dedupe theo `swaps[].id`, dừng khi `hasNextPage=false` hoặc cursor lặp.
7. Với balances/trades: `304` → dùng cache, không coi là rỗng.
8. Poll tuần tự, có backoff; không gọi endpoint write.

Ví dụ tối thiểu (placeholder, không chứa token thật):

```python
from curl_cffi import requests

BASE = "https://prod-api.fomo.family"
headers = {
    "authorization": f"Bearer {token}",
    "accept": "application/json",
    "origin": "https://fomo.family",
    "referer": "https://fomo.family/",
}

r = requests.get(
    f"{BASE}/v2/users/{user_id}/swaps",
    headers=headers,
    impersonate="chrome",
    timeout=30,
)
body = r.json()["responseObject"]
```

**Không** dùng Browserless như cách vượt quota: nó chỉ là transport, không cấp auth và không tăng giới hạn.

---

## 8. Mapping vào `signal_scan`

| Dữ liệu cần | Nguồn | Ghi chú |
|---|---|---|
| Bal / holdings | `/v2/users/{id}/balances` | `balances[]` lồng `balance`, `userToken`, `valuation`; amount token là nguồn, USD tính theo giá hiện tại |
| Position active/closed | `/v2/users/{id}/balances` + `/trades?userId={id}&orderBy=closedAt` + `/trades/{tradeId}` | `/trades` **requires `x-supported-chains`**; without it prod-api returns only Solana `activeTrades` (measured: 20 vs 33 active rows for one user). `/balances` is still authoritative for transfer-in positions, which `/trades` omits; union both sources. Pair vắng mặt trong response đầy đủ **không đủ** để đóng: FOMO có thể bỏ sót position cross-chain còn mở (FLOAT, 2026-10-22). Chỉ đóng sau khi trade detail xác nhận `closedAt`/amount 0; partial SELL còn mở thì cập nhật amount còn lại, không zero. Chỉ đọc trade detail khi có sell sau buy gần nhất (hoặc alert BUY thiếu balance) để hạn chế request |
| Từng fill | `/v2/users/{id}/swaps` | Map → `FomoSwap`; instance A's `fomo-watch.service` poll mỗi 300s từ 2026-10-29; POST alert; xử lý `inNetworkId`/`outNetworkId` |
| Equity/PnL history | `/v2/userTokens/aggregatedSnapshot` | `snapshotId`, `pnl`, `equity` |
| Alert candidate | `/feed/token` | `swap_buy`/`swap_sell`, `usdAmount`, `tradeId`, `userId`; nhưng token-centric + threshold |
| User directory | `/v2/leaderboard*` | Có `userId` ổn định, wallets, PnL/volume/holdings |
| Token metadata | `/proxy/tokenDetails`, `/proxy/filterTokens`, `/tokenAllowList/detailed` | Resolve decimals/symbol/chain |

**Cảnh báo mapping:**
- `FomoPosition` cần một `chain`; web API có thể trả in/out network khác nhau.
- `FomoSwap` cần hai legs; cross-chain phải có policy rõ ràng.
- `feed/token` không thay thế “all swaps của user”.
- Không suy trade size từ `usdValue` của alert cũ.
- Missing/unknown phải giữ `unknown`, không đổi thành `0`.

### 8.1 Bal và % trên dashboard

`Bal` là **position value hiện tại** (mark-to-market), không phải số tiền đã mua:

```text
Bal = token amount × price
```

- Token amount: `balance.shiftedBalance` / `userToken.humanAmountRemaining` từ
  `/v2/users/{id}/balances` (đã lưu ở `fomo_positions.amount`).
- Price: `tokenFilterResult.priceUSD` từ `/balances` (lưu ở
  `fomo_positions.price_usd`); nếu thiếu thì fallback `token_state.price`.
- **Không** dùng `userToken.totalCostBasisUsd` (invested/cost basis) làm Bal.
  Ví dụ đo được: position value $8,611.97, invested $7,969.97 — hai đại lượng khác nhau.
- Giá di chuyển liên tục; $8,611.97 và $8,625.22 chỉ là hai thời điểm của cùng
  phép nhân, không phải hai field khác nhau.

`%` cạnh Bal:

```text
% = Bal / token_state.market_cap × 100
```

Không dùng `amount / token_state.supply × 100` cho cột này. Nếu amount, price
hoặc market cap chưa biết, giữ `null`/`undefined` — không zero-fill; amount = 0
đã đo được thì Bal = 0 và % = 0.

### 8.2 Buy $/Sell $ cho EVM của FOMO user

Các response `/v2/users/{id}/swaps` đã capture chỉ có Solana, nhưng watcher
không giả định điều đó: mọi `networkId` được hỗ trợ đều được map và ingest bình
thường. `networkId=1` (Ethereum) được map thành chain `eth` (2026-10-23). EVM
của FOMO user cũng có thể lấy từ token feed, không phải từ wallet watch:

```text
GET /feed/token?tokenAddress={ca}&networkId={id}
  item: type, id (= swap id), tradeId, userId, userHandle, usdAmount, createdAt
GET /trades/{tradeId}
  responseObject.swaps[]: id, in/outNetworkId, in/outTokenAddress,
                          humanUsdAmountIn/Out, in/outHumanAmount, createdAt
```

Khi watcher thấy một feed item mới của user trong watch list, nó gọi
`/trades/{tradeId}` và ingest **toàn bộ** swap của trade đó (cả buy trước đó và
sell vừa xảy ra, kể cả leg cross-chain). Event id dùng `fomo-swap:<swap id>` cho
cả `/swaps` lẫn feed (feed id = swap id) — một fill xuất hiện ở cả hai đường chỉ
được ingest một lần. `trade_usd` của buy
lấy `humanUsdAmountIn`, của sell lấy `humanUsdAmountOut`.

Ví dụ đo được (`tradeId 8c589c0d-…`, CA `0x30de7ae4…`, network 4663):

```text
sell  id 938d0498-…  in 4663 -> out 1399811149  humanUsdAmountOut 2738.59
buy   id be93f3ff-…  in 1399811149 -> out 4663  humanUsdAmountIn  4208.17
```

Đây vẫn là dữ liệu FOMO user (`userId`/`userHandle` do FOMO trả), không liên
quan đến ví EVM nhập tay trong wallet watch.

---

## 9. Rủi ro

- **Unofficial/ToS:** không có contract, có thể đổi hoặc chặn bất kỳ lúc nào.
- **Cloudflare:** plain client bị `430`; TLS fingerprint thay đổi có thể làm gãy toàn bộ.
- **Token leak:** Privy token/refresh token là credential; không commit, không log.
- **Session expiry:** refresh flow chưa được xác minh server-side.
- **Rate limit:** chưa biết; polling nhiều user có thể bị chặn.
- **Pagination:** chưa chốt ở trades/feed/token → nguy cơ thiếu lịch sử.
- **Cache:** `304`/`etag` có thể làm tưởng “không có data mới”.
- **Cross-chain:** in/out network khác nhau, không map thẳng vào model một-chain.
- **Write endpoints:** `POST /swaps/v2/fast-fill`, `POST /trades/comment`, `POST /v2/users` tuyệt đối không gọi khi chỉ đọc.

---

## 10. Verification log

| Ngày | Việc đã làm | Kết quả |
|---|---|---|
| 2026-09-01 | HAR catalog `fomo-sapiens/references/endpoints.md` | Danh sách route + schema; có `WSS /ws`; chưa live-verify |
| 2026-10-16 | Brave đã đăng nhập, gọi read-only `prod-api.fomo.family` | `200` cho leaderboard, token feed, trades, swaps, balances |
| 2026-10-16 | Scan profile có dữ liệu, cuộn activity | `/swaps` 25 item/page; `lastSwapIdV2`; trang kế không trùng; `/trades` `hasNextPage=true` |
| 2026-10-16 | Mở trade detail | `/trades/{tradeId}` trả dữ liệu không rỗng |
| 2026-10-20 | Reload profile, capture 37 request | swaps `200`; balances `200`/`304`; không `429`; không rate-limit headers |
| 2026-10-20 | Kiểm tra response headers | Chỉ `cf-*`, `etag`, `x-request-id`…; không có `RateLimit-*` |

**Chưa xác minh:**
- `wss://prod-api.fomo.family/ws` có thật và còn hoạt động không.
- Param trang tiếp của `/trades`, `/feed/token`, `/trades/{id}/comments`.
- Quota thật, burst limit, giới hạn theo IP/tài khoản/session.
- Cơ chế refresh Privy bền vững cho server-side.
- Coverage đầy đủ của `/feed/token` và `/v2/users/{id}/swaps`.

---

## 11. Nguồn

- `docs/2026-09-29-fomo-user-watch.md`, mục 15 “Direct Fomo web API scan” (dòng 444-477).
- Archive session `01a14544-d2e7-7189-b19e-33c104647616` (2026-10-16): scan UI, endpoint catalog, auth/Cloudflare.
- Archive session `01a15776-f64a-72d2-b03e-4fc3dbad6716` (2026-10-20): rate-limit observation, 37 request, `304`.
- `fomo-sapiens/references/endpoints.md` — HAR capture 2026-09-01 (unofficial).
- `fomo-sapiens` README/SKILL — Privy auth, Cloudflare `430`, `curl_cffi` (unofficial).

---

*Tài liệu này chỉ mô tả các request read-only đã quan sát. Không có token, cookie, user ID, địa chỉ ví hay bản ghi giao dịch thật trong file.*
