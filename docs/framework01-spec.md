# CT alpha bot signal_ Framework01

| Column | Definition | Logic / Calculation | Display |
| --- | --- | --- | --- |
| **CA** | Contract Address của token | Lấy CA/token address từ source scan | Shortened CA `0xABC...` + click để copy |
| **Tracked By** | Các tracked wallet đang hold/buy token | List các wallet thuộc tracked-wallet database có interaction với token | `CT01 · CT07 · CT12` |
| **Nansen Setup** | Tổng hợp 3 setup signal từ Nansen | Check **Fresh Wallet + Top100 Decrease + Low Float** | `3/3 — Fresh 18.4% · T100 ↓8.7% ×1.5 · LF 74M` |
| **Holder** | Tổng số holders hiện tại | `Current unique holders` | `12.4K` |
| **Tracked Inflow** | Tổng tiền tracked wallets đã đưa vào token | `Σ buy USD` của tracked wallets trong window tracking | `$84K` |
| **Tracked Holding** | Tỷ lệ supply hiện đang nằm trong tracked wallets | `Tracked wallets current balance / circulating supply × 100` | `3.82%` |
| **24H Volume** | Trading volume trong 24h | `DEX 24H buy + sell volume` | `$182K` |
| **Tier** | Quality/risk classification của token | Dựa trên overall setup + on-chain + narrative + whale/social confirmation | `S / A / B` |
| **Entry** | Trạng thái token có thể vào lệnh hay chưa | Chủ yếu dựa trên **24H Volume cooldown** | 🟢 / 🟡 |

# 1. `CA`

**Purpose:** định danh token.

**Logic:**

```
CA = token contract address
```

**UI:**

- Shorten: `0xABC...`
- [ ]  Click → copy full CA.
- Có thể thêm link mở explorer/GMGN sau.

---

# 2. `Tracked By (Cái này đợi Label xong nhá)`

Đây là **wallet-level signal**.

Ví dụ:

```
CT01 · CT07 · CT12
```

Nghĩa là 3 tracked wallets đang có interaction/holding với token.

### Logic

```
Tracked By =
all tracked wallets currently holding token
OR
tracked wallets that recently bought token
```

T recommend **ưu tiên current holding**, vì dashboard đang dùng nó để xác định Smart Money Convergence.

Có thể sort:

```
CT01 · CT07 · CT12
```

thay vì random.

---

# 3. `Nansen Setup`

Đây là **3-factor setup score**:

### A. Fresh Wallet

Tỷ lệ fresh wallets tham gia token.

Ví dụ:

```
Fresh 18.4%
```

→ 18.4% holders được xác định là fresh/new wallets.

### B. Top100 Decrease

Theo dõi mức giảm holding của Top 100 holders.

Lấy mức cao nhất / cho mức thấp nhất → Ra hệ số, Hệ số càng cao càng được ưu tiên trên Dashboard

Ví dụ:

```
T100 ↓8.7% ×1.5
```

### C. Exchange Balance First list

Điều kiện lây (Exchange Balance ngay lúc list nằm trong khoảng 30M → 100M) 

Exchange Balance First list càng thấp càng được ưu tiên trên Dashboard

Ví dụ:

```
LF 74M
```

→ token đang nằm trong Low Float bucket, với value `$74M`.

### Tổng hợp

```
3/3
```

= pass cả 3 setup.

```
2/3
```

= pass 2/3.

```
1/3
```

= pass 1/3.

**Quan trọng:** `3/3`, `2/3`, `1/3` là **signal count**, không phải score cuối cùng.

1 CA có thể có 1 loại  set up, hoặc xuất hiện 2/3 loại

Chúng ta sẽ để hiển thị như thế này

![image.png](CT%20alpha%20bot%20signal_%20Framework01/image.png)

---

# 4. `Holder (Cái này kéo API realtime về là được)`

**Definition:**

> Tổng số unique wallets đang hold token.
> 

```
Holder = unique token holders
```

Ví dụ:

```
12,400 → 12.4K
```

Không tính:

- burn address
- LP/pool address
- known exchange/system wallets

nếu data provider đã identify được.

---

# 5. 24h`Tracked Inflow`

Đây là **capital flow từ tracked wallets**.

Ví dụ:

```
$84K
```

Có nghĩa tracked wallets đã **buy/inflow $84K** vào token trong tracking window.

### Công thức

```
Tracked Inflow
= Σ USD value of tracked-wallet buys
```

Nếu muốn tracking từ lúc token được phát hiện thì nên đặt tên khác, ví dụ `Cumulative Tracked Inflow`.

---

# 6. `Tracked Holding`

Đây là metric rất quan trọng.

Nó trả lời:

> **Tracked wallets hiện đang kiểm soát bao nhiêu % supply?**
> 

### Formula

```
Tracked Holding %
=
Current balance held by tracked wallets
÷
circulating / relevant token supply
× 100
```

Ví dụ:

```
3.82%
```

→ tracked wallets đang nắm tổng cộng 3.82% supply.

**Lưu ý:** Không lấy `Tracked Inflow / Market Cap` để tính cái này.

Phải lấy **current balance**.

---

# 7. `24H Volume (Này cũng kéo API real time về)`

**Definition:**

Tổng trading volume của token trong 24h gần nhất.

```
24H Volume
= Buy Volume + Sell Volume
```

Tốt nhất lấy **DEX volume** trên chain đang track.

Ví dụ:

```
$182K
$280K
$420K
```

Đây là input chính cho Entry.

---

# 8. `Tier (Cột này tạm thời để N/A, sẽ bổ sung logic sau)`

Tier là **overall quality classification**, không đơn thuần dựa vào Nansen Setup.

### S — Highest conviction

Token có:

- Smart money convergence mạnh
- On-chain setup tốt
- Whale acceptance
- Social/narrative mạnh
- Liquidity đủ
- Risk rug cực thấp
- Upside còn tốt

→ **Highest conviction**

### A — Strong

- Setup confirmed
- Smart money tốt
- Whale acceptance
- Social/narrative ổn
- On-chain healthy

→ **Good entry candidate**

### B — Speculative

- On-chain setup tốt
- Narrative có
- Market cap thấp
- Nhưng chưa đủ confirmation

→ **Smaller allocation / higher risk**

---

# 9. `Entry`

Đây là **timing layer**, tách khỏi Tier.

### 🟢 Green — Entry Available

```
24H Volume < $300K
```

→ Volume đã cooldown → có thể consider entry.

### 🟡 Yellow — Waiting

```
24H Volume ≥ $300K
```

→ Volume còn nóng → chờ cooldown.

Ví dụ screenshot:

| Token | 24H Volume | Entry |
| --- | --- | --- |
| ABC | $182K | 🟢 |
| DEF | $280K | 🟢 |
| GHI | $420K | 🟡 |

### Dev logic

```
if volume_24h < ENTRY_VOLUME_THRESHOLD:
    Entry = GREEN
else:
    Entry = YELLOW
```

Trong đó:

```
ENTRY_VOLUME_THRESHOLD = $300,000
```

**Nên để threshold configurable**, không hard-code.