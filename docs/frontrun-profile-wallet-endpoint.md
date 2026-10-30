# Frontrun FOMO profile wallet endpoint

## Kết quả đã xác minh

Ngày 2026-10-28, kiểm tra profile `AvgJoesCrypto` tại `https://fomo.family/profile/AvgJoesCrypto?r=LoyalSafeBird` bằng Frontrun extension `0.0.440`.

Extension hiển thị 2 wallet: một `SOLANA`, một `EVM`. Gọi endpoint Frontrun từ server-side `fetch` trả HTTP `200` khi gửi session cookie Frontrun; gọi không cookie trả `401 No session token provided`. Response khớp với địa chỉ mà extension hiển thị.

Đây là endpoint riêng của Frontrun, không phải endpoint Fomo (`prod-api.fomo.family`) đang được dùng cho balances/swaps trong `server/src/fomo-api.ts`.

## Endpoint lấy wallet

```http
GET https://loadbalance.frontrun.pro/api/v1/twitter/fomo-profile-wallets/{handle}?fomoUserId={fomoUserId}
Cookie: __Secure-frontrun.session_token=<session cookie>
```

- `{handle}`: Fomo profile handle dạng chữ thường; ví dụ `avgjoescrypto`.
- `fomoUserId`: UUID của Fomo user. Extension gửi ID này cùng handle; chỉ truyền handle không đủ để xác minh danh tính.
- Authentication: session cookie Frontrun `__Secure-frontrun.session_token`. Cookie có thể được gửi header `Cookie` trong server-side request. Cookie value là credential nhạy cảm: chỉ lấy từ secret store/runtime được cấp quyền; không ghi vào file, log, source control, hoặc response chẩn đoán. Không dùng cookie trình duyệt cá nhân trên server production.

### Response đã quan sát

```json
{
  "data": {
    "wallets": [
      {
        "chain": "SOLANA",
        "address": "H2QSGECp13sFLJgdTsDtayX3dk18Dm6sQMSQKcew7Xzk",
        "activeChains": []
      },
      {
        "chain": "EVM",
        "address": "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1",
        "activeChains": ["BASE", "BSC", "ROBINHOOD"]
      }
    ]
  },
  "code": 200,
  "status": true,
  "message": "success"
}
```

`chain: "EVM"` là nhóm địa chỉ EVM chung; `activeChains` cho biết các mạng được Frontrun ghi nhận cho wallet đó. Đừng giả định một entry EVM tương ứng duy nhất với Ethereum mainnet.

## Endpoint lấy số lượng wallet

```http
GET https://loadbalance.frontrun.pro/api/v1/twitter/fomo-profile-wallets/{handle}/count?fomoUserId={fomoUserId}
Cookie: __Secure-frontrun.session_token=<session cookie>
```

Response mẫu đã quan sát cho profile này:

```json
{
  "data": { "count": 2, "twitterUsername": "AvgJoesCrypto" },
  "code": 200,
  "status": true,
  "message": "success"
}
```

## Resolve Fomo user ID

Extension lấy `fomoUserId` từ dữ liệu profile của Fomo, rồi gọi Frontrun với cả handle và ID. Trong lần kiểm tra này, profile API Fomo trả:

```json
{
  "handle": "AvgJoesCrypto",
  "id": "35a98e8f-d962-5256-9b39-89624b524e57"
}
```

Không suy ra ID từ handle hoặc dùng ID của profile khác. Handle-only request đến endpoint wallet đã trả `400` với `FOMO_PROFILE_IDENTITY_UNVERIFIED`.

Lần kiểm tra profile API Fomo khi gọi từ server-side hoặc browser không gửi credentials trả `431`/`unauthorized`; browser request có session và các header `app-build`, `app-language`, `x-supported-chains` trả `200`. Cách truy xuất/duy trì session Fomo không được xác minh trong lần kiểm tra này.

## Cách diễn giải lỗi đã kiểm tra

| Điều kiện | HTTP | Kết quả |
|---|---:|---|
| Frontrun wallet query có session cookie hợp lệ và đúng `fomoUserId` | 200 | Trả `data.wallets` |
| Thiếu Frontrun session cookie | 401 | `No session token provided` |
| Thiếu `fomoUserId` | 400 | `FOMO_PROFILE_IDENTITY_UNVERIFIED` |

Chưa kiểm tra hành vi với cookie hết hạn, rate limit, hạn mức tài khoản, hồ sơ không có wallet hoặc hợp đồng API công khai. HTTP `200` trong lần thử không chứng minh các điều kiện đó.

## Kết luận tích hợp

Có thể gọi endpoint Frontrun trực tiếp từ backend **nếu runtime có session cookie Frontrun hợp lệ và đã resolve đúng Fomo user ID**. Không thể dùng endpoint này như API keyless tương tự request Fomo hiện có: request không auth đã trả `401`. Trước khi đưa vào production, cần xác nhận quyền sử dụng API và quy trình cấp/refresh session với nhà cung cấp; không dùng cookie lấy từ browser cá nhân làm credential dịch vụ.

## Bằng chứng

Đã replay bằng server-side `fetch`, kiểm tra response wallet và count, kiểm tra lỗi khi thiếu session/ID, rồi so sánh address response với các liên kết explorer/GMGN trong panel extension. Chi tiết response và kết quả kiểm tra đã lưu trong artifact tạm `local://fomo-frontrun-wallet-check.json`; ảnh giao diện ở `/tmp/omp-sshots-15b7a7b632168d83.webp`. File artifact và ảnh không phải tài liệu lưu trữ lâu dài.
