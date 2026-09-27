# Data Science Brief — Tracked CT Wallet Alpha Engine

## 1. Objective

Xây dựng một **Tracked CT Wallet Analytics & Alpha Signal Engine** cho meme/low-cap token trading.

Input chính là **danh sách tracked CT wallets đã được xác định trước**. Đây là những wallets có track record tốt, có identity/context rõ ràng và đã được đánh giá là đáng follow.

Mục tiêu của Data Science không phải chỉ rank wallet theo PnL.

Mục tiêu là:

> **Phân tích historical behavior của từng tracked wallet để xác định wallet nào có information value cao, wallet đó tạo alpha trong loại setup nào, entry như thế nào, conviction ra sao, và khi wallet đó mua một token mới thì signal đó có predictive power đến đâu.**

Output cuối cùng cần phục vụ một **hybrid trading bot**:

```text
Tracked CT Wallet
        ↓
Wallet buys CA
        ↓
Generate Candidate
        ↓
Analyze Wallet Behavior
        ↓
Analyze Token / Market Context
        ↓
Calculate Signal Strength
        ↓
Alert
        ↓
Human Final Decision
```

---

# 2. Existing Data

Danh sách tracked wallets đã có sẵn.

Mỗi wallet có thể có:

```text
wallet_address
wallet_name / identity
wallet_category
source
```

Không cần xây wallet discovery/ranking từ đầu.

Task là xây **analytics layer phía sau danh sách wallet này**.

---

# 3. Core Research Questions

Data Science cần trả lời 6 câu hỏi chính:

### Q1 — Wallet nào thực sự có alpha?

Không chỉ dựa trên total PnL.

Cần đo:

> Khi wallet này mua một token, token đó outperform market/random baseline với xác suất bao nhiêu?

---

### Q2 — Wallet này giỏi ở loại setup nào?

Ví dụ:

* Early meme
* Low-cap
* Narrative rotation
* Volume expansion
* Breakout
* Post-breakout
* Very early launch
* Established token

Mỗi wallet có thể có một "specialization profile".

---

### Q3 — Wallet thường entry ở đâu?

Phân tích:

* Market cap at entry
* Token age at entry
* Liquidity at entry
* Volume at entry
* Price movement before entry
* Volume expansion before entry
* Holder structure at entry

Mục tiêu là xác định **historical sweet spot** của wallet.

---

### Q4 — Conviction có predictive power không?

Ví dụ:

Wallet bình thường mua $5K nhưng lần này mua $25K.

```text
Relative Conviction = 25K / 5K = 5x
```

Cần kiểm tra:

> Khi wallet có conviction cao hơn bình thường, forward return có tốt hơn không?

---

### Q5 — Multiple tracked wallets cùng mua có tạo alpha không?

Cần phân tích:

* Number of wallets
* Wallet quality
* Weighted wallet count
* Total capital
* Entry timing proximity
* Independent wallet clusters

Đặc biệt phải tránh:

> 5 wallets thực chất là cùng một actor/cluster.

---

### Q6 — Wallet signal có predictive power thật hay chỉ hindsight?

Mọi metric phải được kiểm tra bằng:

* Historical backtest
* Out-of-sample testing
* Walk-forward testing
* Realistic execution assumptions

---

# 4. Wallet Quality Metrics

Mỗi wallet cần có profile cơ bản:

```text
Total PnL
Realized PnL
Median ROI / trade
Win Rate
Profit Factor
Expectancy
Max Drawdown
Trade Count
Track Record Length
Consistency
```

Ưu tiên **median / distribution / risk-adjusted metrics** thay vì chỉ dùng average PnL.

Ví dụ cần tránh trường hợp:

```text
Wallet A:
2,000 trades
Total PnL: $5M

Wallet B:
80 trades
Total PnL: $800K
```

Wallet A không mặc định có signal value cao hơn B.

---

# 5. Selectivity Metrics

Cần đo wallet có selective hay không:

```text
Trades / day
Trades / week
Unique tokens / week
Unique tokens / month
Average holding period
% profitable trades
% trades reaching +X%
```

Có thể tạo:

### Selectivity Score

Mục tiêu:

> Wallet càng selective và vẫn tạo alpha tốt → signal value càng cao.

---

# 6. Entry Behavior

Đối với mỗi trade, cần lưu/derive:

```text
entry_timestamp
entry_price
entry_market_cap
entry_liquidity
entry_token_age

volume_1m
volume_5m
volume_15m
volume_30m

price_change_1m
price_change_5m
price_change_15m
price_change_30m

buy/sell ratio
holder count
```

Nếu data source cho phép, thêm:

```text
smart money activity
holder concentration
top holder changes
wallet labels
dev/team behavior
fund flow
```

---

# 7. Entry Timing Analysis

Cần xác định wallet thường vào:

### Theo token age

```text
0–5m
5–15m
15–30m
30m–1h
1–6h
6h+
```

### Theo market cap

```text
<$500K
$500K–$1M
$1M–$3M
$3M–$10M
$10M+
```

### Theo prior price movement

```text
0–5%
5–10%
10–25%
25–50%
50%+
```

### Theo volume expansion

Wallet vào:

```text
Before volume expansion
During volume expansion
After volume expansion
```

Mục tiêu là tìm:

> **Historical Entry Sweet Spot của từng wallet.**

---

# 8. Relative Conviction

Không dùng absolute buy size đơn thuần.

Cần derive:

```text
relative_buy_size =
current_buy_size /
wallet_historical_median_buy_size
```

Thêm:

```text
buy_size_percentile
position_size_percentile
current_buy / average_buy
current_buy / median_buy
```

Ví dụ:

```text
Normal buy = $5K
Current buy = $25K

Relative Conviction = 5x
```

Cần test relationship:

```text
Relative Conviction
        ↓
Forward Return
```

Ví dụ phân nhóm:

```text
1–1.5x
1.5–2x
2–3x
3–5x
5x+
```

Và đo:

```text
Forward return
Hit rate
MFE
MAE
Probability of +20%
Probability of +50%
Probability of -20%
```

---

# 9. Position Behavior

Cần phân biệt:

### Initial entry

```text
BUY $5K
```

với:

### Accumulation

```text
BUY $5K
↓
BUY $10K
↓
BUY $20K
```

và:

### Failed conviction

```text
BUY $20K
↓
SELL
```

Metrics:

```text
Initial buy
Follow-up buy
Accumulation rate
Buy velocity
Position increase %
Time between buys
```

Một wallet tăng position sau khi entry có thể là signal mạnh hơn initial buy đơn thuần.

---

# 10. Holding / Exit Behavior

Phân tích:

```text
Median holding time
Average holding time
MFE
MAE
Max drawdown during trade
Time to MFE
Time to +20%
Time to +50%
Time to +100%
```

Phân loại style:

```text
Scalper
Momentum trader
Swing trader
Conviction holder
```

Mục tiêu là hiểu:

> Wallet kiếm alpha bằng cách nào sau khi entry?

---

# 11. Wallet Specialization

Build:

## Wallet × Setup Matrix

Phân loại historical trades theo:

### Market Cap

### Token Age

### Narrative

### Chain

### Liquidity

### Volume state

### Price state

### Entry timing

Ví dụ:

| Setup              | W001 | W002 | W003 |
| ------------------ | ---: | ---: | ---: |
| Early low-cap      |   95 |   61 |   42 |
| Narrative rotation |   91 |   83 |   52 |
| Volume expansion   |   78 |   94 |   81 |
| Breakout           |   62 |   91 |   96 |
| Hype               |   21 |   55 |   73 |

Mục tiêu:

> Không chỉ biết W001 profitable, mà biết **W001 profitable ở đâu**.

---

# 12. Wallet Signal Value

Đây là metric quan trọng nhất.

Không chỉ:

> Wallet có PnL cao.

Mà:

> **Khi wallet này mua một token, xác suất token outperform baseline tăng bao nhiêu?**

Ví dụ:

```text
Baseline:

P(+50% / 2h) = 8%

W001:

P(+50% / 2h) = 21%
```

→ Signal Lift:

```text
21% / 8% = 2.63x
```

Cần calculate:

```text
Signal Lift
Absolute probability improvement
Expected return
Hit rate
MFE
MAE
```

cho từng wallet.

---

# 13. Wallet Consensus

Khi nhiều tracked wallets cùng mua một CA trong một time window:

```text
Wallet count
Weighted wallet count
Total buy volume
Weighted buy volume
Time dispersion
Buy velocity
```

Ví dụ:

```text
W001 → $10K → 14:32:17
W024 → $5K  → 14:32:48
W087 → $8K  → 14:33:11
W032 → $12K → 14:34:02
```

Derived features:

```text
wallet_count = 4
total_buy = $35K
median_wallet_quality
weighted_consensus
buy_velocity
time_to_consensus
```

---

# 14. Independent Wallet Clusters

Bắt buộc phải kiểm tra correlation.

Nếu:

```text
W001
W002
W003
W004
```

có:

* Same funding source
* Frequent transfers
* High trade overlap
* Same entry timing
* Same token behavior

thì 4 wallets không nên được tính như 4 independent signals.

Cần derive:

```text
wallet_cluster
cluster_size
cluster_correlation
funding_relationship
trade_similarity
entry-time similarity
token-overlap similarity
```

Final metric:

> **Independent CT Wallet Count**

Ví dụ:

```text
4 wallets
→ 1 cluster

Effective consensus = 1
```

vs:

```text
4 wallets
→ 4 independent clusters

Effective consensus = 4
```

---

# 15. Consensus × Conviction

Một factor cần test riêng:

```text
Wallet Consensus
×
Relative Conviction
```

Ví dụ:

### Setup A

```text
5 wallets
Average conviction = 1.1x
```

### Setup B

```text
3 wallets
Average conviction = 4.2x
```

Cần xác định:

> Cái nào có predictive power cao hơn?

Không assume trước.

---

# 16. Required Labels / Outcomes

Mỗi wallet entry cần có forward outcome:

```text
Return 5m
Return 15m
Return 30m
Return 1h
Return 2h
Return 4h
Return 24h
```

Thêm:

```text
MFE
MAE
Max drawdown
Time to +20%
Time to +50%
Time to +100%
```

Binary labels:

```text
Y_20_30m
Y_50_2h
Y_100_4h
Y_-20_30m
```

Ví dụ:

```text
Y_50_2h = 1
```

nếu token đạt +50% trong 2h sau wallet entry.

---

# 17. Baseline

Không được chỉ compare:

> Winning wallet trades vs losing wallet trades.

Cần benchmark với market/token baseline.

Ví dụ:

```text
Random token
Random token with same MC
Random token with same age
Random token with same liquidity
Random token with same volume regime
```

Mục tiêu là đo:

> **Wallet signal tạo thêm information bao nhiêu so với market conditions thông thường?**

---

# 18. Statistical Testing

Với mỗi factor cần kiểm tra:

```text
Mean
Median
Distribution
Quantiles
Hit rate
Confidence interval
Statistical significance
Sample size
```

Quan trọng:

> **Không chỉ nhìn average return.**

Ví dụ cần biết:

```text
Top 10% conviction
vs
Bottom 90%
```

có thực sự khác biệt hay không.

---

# 19. Factor Research

Các factor đầu tiên cần test:

### F1

Wallet Quality

### F2

Wallet Signal Lift

### F3

Wallet Selectivity

### F4

Relative Conviction

### F5

Entry Timing

### F6

Token Age at Entry

### F7

Market Cap at Entry

### F8

Buy / Liquidity

### F9

Wallet Consensus

### F10

Independent Wallet Count

### F11

Consensus × Conviction

### F12

Accumulation Velocity

### F13

Volume State

### F14

Price Extension

---

# 20. Alpha Score — V0

Sau khi research factor:

```text
CT Score
+
Consensus
+
Relative Conviction
+
Entry Timing
+
Buy Impact
+
Independent Cluster
+
Market Context
```

Ban đầu **rule-based / weighted score**.

Không cần ML ngay.

Mục tiêu của V0 là xác định:

> **Liệu một combination of measurable factors có predictive power hay không?**

---

# 21. Backtesting Requirements

Backtest phải tránh hindsight bias.

Mỗi signal chỉ được sử dụng information available **tại timestamp của entry**.

Không được sử dụng:

* Future price
* Future volume
* Future holder data
* Final PnL
* Current wallet status
* Current token status

để tạo feature tại thời điểm historical signal.

---

# 22. Walk-forward Testing

Ví dụ:

```text
TRAIN
Jan → Mar

TEST
Apr
```

Sau đó:

```text
TRAIN
Feb → Apr

TEST
May
```

Lặp lại theo rolling window.

Mục tiêu:

> kiểm tra alpha có tồn tại ngoài sample hay chỉ overfit historical data.

---

# 23. Execution-adjusted Backtest

Không giả định:

```text
Signal price = Fill price
```

Cần model:

```text
Signal timestamp
↓
Execution latency
↓
Expected entry price
↓
Slippage
↓
Fees
↓
Exit
```

Đặc biệt quan trọng với low-cap meme tokens.

---

# 24. Final Deliverables

Data Science phase cần tạo:

### A. Wallet Profile Dataset

Mỗi wallet có:

```text
Quality
Selectivity
Specialization
Entry behavior
Conviction behavior
Holding behavior
Signal Lift
```

### B. Trade/Event Dataset

Mỗi wallet entry có:

```text
Wallet features
Token features
Market features
Consensus features
Conviction features
Forward outcomes
```

### C. Wallet × Setup Matrix

Cho biết wallet nào mạnh ở setup nào.

### D. Factor Research Report

Cho biết factor nào có predictive power.

### E. Alpha Score V0

Rule-based score từ những factor đã được chứng minh.

### F. Backtest Report

Bao gồm:

```text
Return
Win rate
Expectancy
MFE
MAE
Drawdown
Sharpe/Sortino
Hit rate
Signal frequency
Slippage/fees
Out-of-sample performance
```

---

# 25. Priority

Không cần build tất cả cùng lúc.

## Priority 1 — Must Have

```text
Historical trades
Entry timestamp
Entry price
Entry MC
Entry liquidity
Entry volume
Wallet PnL
Wallet trade count
Relative buy size
Forward returns
MFE / MAE
```

## Priority 2 — High Value

```text
Wallet specialization
Entry timing
Consensus
Independent wallet clusters
Buy velocity
Buy / liquidity
Token age
Volume regime
```

## Priority 3 — Advanced

```text
Narrative classification
Wallet behavior clustering
ML
Predictive probability
Dynamic weighting
```

---

# 26. Key Principle

Đừng bắt đầu bằng việc hỏi:

> **"How do we build an AI that predicts meme coins?"**

Hãy bắt đầu bằng:

> **"What measurable characteristics make a tracked CT wallet's entry informative?"**

Sau đó:

> **"What combinations of CT behavior + on-chain conditions + market conditions create the highest probability of future outperformance?"**

Mục tiêu của Data Science là biến:

```text
CT buys token
```

thành:

```text
This wallet
+
this conviction
+
this timing
+
this market condition
+
this consensus
+
this setup
```

và quantify:

> **"Historically, how much alpha did this setup generate?"**

Đó sẽ là foundation cho hybrid alpha bot ở phase tiếp theo.
