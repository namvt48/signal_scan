# task-0 - FOMO alert capture (keyless, 0 credits)

Status: DONE during planning. This artifact is the empirical ground truth the plan
(`.omo/plans/fomo-user-watch.md`) cites; the executor does NOT re-capture.

## How to reproduce
```
node .omo/scripts/fomo-probe.mjs        # 115s, writes the JSONL below, prints the summary
```
Script: `.omo/scripts/fomo-probe.mjs` (planning tooling - not product code, no key used).
Raw capture: `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl` (109 messages, 68,562 bytes).

## Method
- Endpoint: `wss://api.fomoapi.io/ws/alerts`, connected with NO key.
- No key => the free delayed tier (~60s), which costs 0 credits. Alerts arrived marked `replay:true` (97/102).
- Window: 115s. Captured 109 messages, of which 102 were alerts.

## Measured results

Envelope `type` distribution: `{"welcome":1,"alert":102,"heartbeat":6}`. A bare `ping`/`pong`
string also occurs. Only `alert` frames carry trades.

Alert discriminator is **`alertType`** (the top-level `type` is ALWAYS the literal `"alert"`):
`{"buy":36,"sell":41,"perp":12,"thesis":13}`. (`listing` <1% per the docs; not seen.)

Key presence across the 102 alerts:
```
type 102, replay 97, id 102, alertType 102, source 102, trader 102, token 102,
eventId 102, userId 102, tradeId 102, swapId 102, transferId 102, tokenAddress 102(*),
chainId 102, chain 102, notificationType 102, usdValue 102(*), text 102, ts 102, raw 102,
positionValueUsd 36, realizedPnlUsd 41, avatar 13, tokenImage 13, tradeUsd 17,
tradeUsdSource 17, txHash 17, execTs 17, execLagMs 17, fillMatch 18,
fillCandidates 1, txHashCandidates 1
(*) present as a KEY on all rows, but NULL on some - see below.
```
- `trader` is the HANDLE, non-empty on 102/102 => handle matching WORKS.
- `eventId` unique on 102/102 => the dedupe key.
- `tokenAddress` non-null 90/102: the 12 nulls are EXACTLY the 12 `perp` rows.
- No `handle`/`userHandle`/`username`/`displayName` key exists anywhere.

Chain: `{"ethereum":15,"robinhood":23,"solana":35,"hyperliquid":12,"bsc":12,"base":5}`
chainId: `{"1":15,"56":12,"1337":12,"4663":23,"8453":5,"1399811149":35}`
Only `solana -> sol`, `base -> base`, `bsc -> bsc` are storable (repo `Chain` union is sol|base|bsc).
`ethereum`, `robinhood`, `hyperliquid`, and perp-chain `1337` MUST be dropped at the daemon.

Money (the reason the plan bans a net-inflow figure):
```
per alertType   n    usdValue  realizedPnlUsd  positionValueUsd  tradeUsd  txHash
buy            36    36        0               36                11        11
sell           41    41        41              0                 6         6
perp           12    0         0               0                 0         0
thesis         13    1         0               0                 0         0
```
- buy: `usdValue` == `positionValueUsd` on 36/36 (byte-equal) = POST-FILL SIZE.
- sell: `usdValue` == `realizedPnlUsd` on 41/41 (byte-equal) = SIGNED REALISED PnL.
- perp/thesis: no money field.
=> `usdValue` is not one currency across directions; `SUM(buy) - SUM(sell)` is invalid.

Timing: `ts` = publish time, epoch ms. `execLagMs` observed range -3000..54 (n=17).
`replay:true` on 97/102 = delayed-tier delivery, not an error.

Text: `text` is a pre-rendered string, e.g. `"kangshifu bought $STOCKER ($3K size)"` (log lines only).

## Load
102 alerts / 115s ~= 0.9 alerts/s across 6 chains. One shared socket + a local
set-membership test needs no backpressure, sharding, or worker pool.

## Docs caveat carried into the plan
FOMO's own feed is large trades only: "do not compute market share, trade counts, or
volume from it". The column tooltip and the runbook must repeat this.

## One full sample alert (verbatim)
```json
{"type":"alert","replay":true,"id":"alrt_1790655915000_6078","alertType":"buy","source":"feed","trader":"kangshifu","token":"STOCKER","eventId":"5c5fe914-2c94-5540-a8eb-f37c9cf674e7","userId":"ced061d9-ebc5-544b-b6c3-eec67138b92b","tradeId":"e9c2e133-0c34-4486-ab43-5b65b7b5cd5e","swapId":null,"transferId":null,"tokenAddress":"0x75e2fc69ff2ac12af65ba7d321bbf4f878c535d2","chainId":1,"chain":"ethereum","notificationType":null,"usdValue":2985,"positionValueUsd":2985,"text":"kangshifu bought $STOCKER ($3K size)","ts":1790655915000,"raw":{"text":"kangshifu bought $STOCKER ($3K size)","title":""}}
```
Note this particular sample is `chain:"ethereum"` => the daemon DROPS it (not in the Chain union).
