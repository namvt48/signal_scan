# Endpoint GMGN Top Traders theo token

## Phạm vi và kết quả xác minh

Ngày 2026-10-28, kiểm tra trang token Solana của GMGN:

`https://gmgn.ai/sol/token/HAsTKXYvv65zM7J6Cu5o5PcZsiKMQYo5oz4WPjgqwP6k`

Endpoint danh sách trader gọi thành công bằng server-side `fetch` không cookie và không API key: HTTP `200`, JSON `code: 0`, có 100 dòng khi `limit=100`. Kết quả chỉ được kiểm tra với token Solana này; không suy rộng cho token hoặc chain khác.

Đây là API nội bộ đang được GMGN web client sử dụng, không phải cam kết public API hoặc SLA.

## Top Traders

```http
GET https://gmgn.ai/vas/api/v1/token_traders/{chain}/{tokenAddress}?limit=100&orderby=profit&direction=desc
```

URL ví dụ đã kiểm chứng:

```text
https://gmgn.ai/vas/api/v1/token_traders/sol/HAsTKXYvv65zM7J6Cu5o5PcZsiKMQYo5oz4WPjgqwP6k?limit=100&orderby=profit&direction=desc
```

- `{chain}`: định danh chain chữ thường; ví dụ `sol`.
- `{tokenAddress}`: token/mint address trên chain đó.
- `limit`: số dòng yêu cầu. Đã thử `20` và `100`; response tương ứng có 20 và 100 trader.
- `orderby`: khóa sắp xếp; đã thử `profit` và `realized_profit`.
- `direction`: `desc` cho thứ tự giảm dần; đã kiểm tra với cả hai khóa trên.
- `tag`: tùy chọn; request `tag=dev` trả về một ví creator trong lần kiểm tra.
- Request từ browser có thêm tham số tracking/fingerprint như `device_id`, `tab_id`, `fp_did`, `client_id`, `app_ver`, locale và timezone. Gọi endpoint từ server chỉ với các tham số chức năng ở trên vẫn trả JSON `code: 0`, không cần các tham số tracking trong lần kiểm tra này.

### Cấu trúc response

```json
{
  "code": 0,
  "message": "success",
  "reason": "",
  "data": {
    "list": [
      {
        "address": "<trader wallet address>",
        "account_address": "<account address>",
        "buy_volume_cur": 5286.42,
        "buy_amount_cur": 36209943.71,
        "buy_tx_count_cur": 4,
        "sell_volume_cur": 16303.83,
        "sell_amount_cur": 24068497.33,
        "sell_tx_count_cur": 21,
        "avg_cost": 0.00014599,
        "avg_sold": 0.00067739,
        "realized_profit": 12709.89,
        "profit": 20861.34,
        "unrealized_profit": 8151.45,
        "balance": 12150306.40,
        "amount_percentage": 0.025,
        "usd_value": 9928.63,
        "native_balance": "17737566",
        "last_active_timestamp": 1793161094,
        "native_transfer": {
          "from_address": "<funding wallet address>",
          "name": null,
          "amount": "35.6",
          "timestamp": 1786298127,
          "tx_hash": "<transaction hash>"
        },
        "name": null,
        "avatar": null,
        "twitter_name": null,
        "twitter_username": null,
        "tags": ["fomo"],
        "maker_token_tags": ["top_holder", "bundler", "transfer_in"],
        "wallet_tag_v2": "TOP2"
      }
    ],
    "next": "<opaque response value>"
  }
}
```

Số liệu trên minh họa cấu trúc và quy mô field quan sát được; dữ liệu thật thay đổi. Trong response Solana quan sát được, `account_address` khác `address`. Dùng **`address`** làm trader wallet.

## Token metadata và Avg MC

Trader response có `avg_cost`, `avg_sold`, nhưng UI tính market cap trung bình bằng tổng nguồn cung token. Lấy metadata bằng:

```http
POST https://gmgn.ai/mrwapi/v1/multi_token_info
Content-Type: application/json
```

```json
{
  "chain": "sol",
  "addresses": ["HAsTKXYvv65zM7J6Cu5o5PcZsiKMQYo5oz4WPjgqwP6k"]
}
```

Request trả HTTP `200`, JSON `code: 0`; `data[0].total_supply = 485766656.342514` với token đã kiểm tra.

Công thức UI đã xác nhận trong client GMGN:

```text
buy average MC  = avg_cost * total_supply
sell average MC = avg_sold * total_supply
```

UI làm tròn/định dạng giá trị hiển thị. Số tính ra có thể hơi khác nếu metadata hoặc trader data được cập nhật giữa hai lần request.

## Đối chiếu cột trong bảng

| Cột UI | Field response hoặc phép tính | Ghi chú |
|---|---|---|
| Wallet | `address`, `name`, `avatar`, `twitter_name`, `twitter_username`, `tags`, `maker_token_tags`, `wallet_tag_v2` | Tên, avatar và social có thể null. |
| SOL Bal | `native_balance / 1e9` | Với response Solana quan sát được, số dư native ở raw lamports. |
| Last Active | `last_active_timestamp` | Unix timestamp tính bằng giây. |
| Bought | `buy_volume_cur`, `buy_amount_cur`, `buy_tx_count_cur` | Giá trị mua, lượng token và số giao dịch của token hiện tại. |
| Bought Avg MC | `avg_cost * total_supply` | Cần gọi metadata ở trên. |
| Sold | `sell_volume_cur`, `sell_amount_cur`, `sell_tx_count_cur` | Giá trị bán, lượng token và số giao dịch của token hiện tại. |
| Sold Avg MC | `avg_sold * total_supply` | Cần gọi metadata ở trên. |
| Realized | `realized_profit`, `realized_pnl` | UI định dạng profit và ratio riêng. |
| PnL | `profit`, `profit_change`, `unrealized_profit`, `unrealized_pnl` | Giá trị realtime có thể thay đổi giữa các lần đọc. |
| Remaining USD | `usd_value` | Giá trị hiện tại quy đổi USD. |
| Remaining amount / percent | `balance` hoặc `amount_cur`, `amount_percentage` | `amount_percentage` là fraction; nhân 100 để ra phần trăm. |
| Funding / TF Amount | `native_transfer.from_address`, `name`, `timestamp`, `amount`, `tx_hash` | Client tự tính thêm số ví cùng nguồn funding và số giao dịch cùng thời điểm; đó không phải field thô trong response quan sát được. |

## Callout và cột cá nhân hóa

Callout không nằm trong payload danh sách trader. Web client gọi request riêng có xác thực:

```http
POST https://gmgn.ai/api/v1/notification/callout/latest_by_users
Content-Type: application/json
Authorization: <GMGN Access token>
```

Body đã quan sát:

```json
{
  "chain": "sol",
  "call_token": "<token address>",
  "wallet_addresses": ["<trader wallet address>"]
}
```

Request từ browser trả HTTP `200` nhưng `data.list` rỗng với các địa chỉ mẫu. Replay từ backend trả HTTP `403` kèm HTML Cloudflare, cả khi không có Authorization và khi dùng Authorization hiện có trong browser. Vì vậy, chưa xác minh được response Callout không rỗng hoặc khả năng gọi endpoint đó từ backend. Không lưu hoặc ghi log Authorization token.

Following/remarking và các dữ liệu tracking cá nhân khác dùng request riêng gắn với user hiện tại; chúng không nằm trong response Top Traders chính.

## Phân trang và mức độ bao phủ

Response có giá trị opaque `data.next`, nhưng chưa xác minh được phân trang vượt quá 100 dòng đang hiển thị:

- Client bảng GMGN đặt `limit: 100`, `enableHasMore: false` và `loadMore` không làm gì.
- Thêm `cursor=<data.next>` trả HTTP `200` nhưng lặp lại toàn bộ 100 địa chỉ ban đầu.
- Thêm `next=<data.next>` trả HTTP `200`; 99/100 địa chỉ trùng tập ban đầu, wallet đứng đầu không đổi. Response live có thể refresh giữa hai request; kết quả này không chứng minh đã sang trang mới.

Không coi `data.next` là cursor hoạt động và không kết luận endpoint trả mọi trader. Mức dữ liệu đã xác minh tối đa là danh sách Top 100 quan sát được mỗi request.

## Lưu ý vận hành và giới hạn

- Kiểm tra cả HTTP status lẫn JSON `code`; HTTP thành công chưa đủ để kết luận dữ liệu hợp lệ.
- Endpoint Top Traders và metadata đều truy cập được từ server-side fetch không xác thực rõ ràng trong lần thử này. Điều đó không xác định chính sách sử dụng, độ ổn định endpoint, rate limit hoặc khả năng truy cập production lâu dài.
- Không xây cơ chế vượt Cloudflare challenge cho các endpoint phụ. Replay Callout từ backend bị `403`.
- Tên/social có thể thiếu; amount, giá trị tính theo giá, PnL và thứ hạng là snapshot live.
- Chỉ kiểm tra một token Solana. Chưa kiểm tra toàn bộ giá trị query, chain khác, limit lớn hơn, rate limit hoặc phân trang dài hạn.

## Ghi nhận kiểm chứng

Kiểm tra ngày 2026-10-28. Trader endpoint gọi từ server-side: HTTP `200`, JSON `code: 0`; `limit=100` trả 100 dòng, `limit=20` trả 20 dòng. Đã thử `profit desc`, `realized_profit desc` và `tag=dev`. Metadata trả HTTP `200`, JSON `code: 0`. Đã đối chiếu field mapping và công thức Avg MC với UI/client GMGN. Các giới hạn về Callout và cursor nêu ở trên.

Chi tiết capture đã loại thông tin xác thực: `local://gmgn-top-traders-endpoint-check.json` (artifact theo session, không phải file lưu bền trong repository).
