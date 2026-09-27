# trackedBy single source — 2026-09-22

## Decision (user, verbatim)
> "trackedBy giờ chỉ có một nguồn là detect buy bằng wallet watch thì mới thêm wallet
> và CA đó vào, từ đó bắt đầu tính inflow, không backfill lại lịch sử"

`trackedByNames()` now has EXACTLY ONE provenance: `wallet_trades` rows with
`side='buy' AND source='watch' AND ts >= @since`. The holding half
(`wallet_token_state.token_amount > 0`) was removed.

## Files changed
- `server/src/signals.ts` — doc comment rewritten + `trackedByNames()` holding EXISTS dropped.
- `server/test/signals.test.ts` — 3 tests updated, 2 added (single source).

### signals.ts diff (shape)
- BEFORE: `WHERE EXISTS (wallet_token_state … token_amount > 0) OR EXISTS (wallet_trades … source='watch')`
- AFTER : `WHERE EXISTS (wallet_trades … side='buy' AND ts >= @since AND source='watch')`
- `@ca` / `@since` params unchanged; `SELECT DISTINCT w.name` unchanged; `.sort()` unchanged;
  signature `trackedByNames(ca: string, buySinceTs: number)` unchanged.
- `sumHoldingAmount()` (line 75) and the `trackedHolding` computation in `assembleSignals`
  (line 264) are UNTOUCHED.

## Caller list (all references)
```
src/signals.ts:63   (doc mention in sumTrackedBuyUsd)
src/signals.ts:94   export function trackedByNames
src/signals.ts:275  trackedBy: trackedByNames(c.address, now - TRACKED_BY_WINDOW_MS)
```
Sole caller is `assembleSignals`; it consumes only the returned `string[]` for the
`trackedBy` DTO field. No other caller depended on the holding half.
`TRACKED_BY_WINDOW_MS`, thresholds and windows are unchanged.

## Grep proof — branch A is gone
```
$ grep -n "wallet_token_state" server/src/signals.ts
77:    .prepare('SELECT COALESCE(SUM(token_amount), 0) AS total FROM wallet_token_state WHERE ca = ?')
```
Only remaining hit is inside `sumHoldingAmount()` (line 77). No `wallet_token_state`
reference remains inside `trackedByNames()`.

## RED proof — asserts fail on pre-change code
Before touching `signals.ts`, the tests were updated and run against the OLD two-branch
code:
```
✖ trackedBy: a watch buy OLDER than the window is NOT returned, even while holding
✖ trackedBy: holding-only wallet is NOT returned (no watch buy on CA_B)
✖ trackedBy: a wallet holding a CA with NO token_state is NOT returned (holding no longer lights it up)
ℹ tests 152
ℹ pass 149
ℹ fail 3
```
These are exactly the 3 assertions that exist to kill the holding half — they go red on
the old code because the old `OR EXISTS (wallet_token_state …)` branch still returned the
holding-only wallets. This is not a temp-revert guess: it is the observed pre-change run.

## GREEN proof — build + tests after the change
```
$ cd server && npm run build   → BUILD_EXIT=0
$ cd server && npm test        → TEST_EXIT=0
ℹ tests 152
ℹ pass 152
ℹ fail 0
ℹ todo 0
```
Baseline before this task was 150 pass / 0 fail; the two added tests bring the total to
152. `door-pool.test.ts` untouched and still 13 tests, green.

## Tests proving the 4 required cases
| Case | Test |
|---|---|
| (a) holding-only wallet NOT returned | `trackedBy: holding-only wallet is NOT returned (no watch buy on CA_B)`; `trackedBy: a wallet holding a CA with NO token_state is NOT returned (holding no longer lights it up)` |
| (b) watch buy inside window IS returned | `trackedBy: a watch buy INSIDE the window is returned` |
| (c) watch buy older than buySinceTs NOT returned | `trackedBy: a watch buy OLDER than the window is NOT returned, even while holding` |
| (d) buy with source='nansen' NOT returned | `trackedBy and trackedInflow read only source='watch' buys` (pre-existing, still green) |

## Intended consequence (acknowledged)
With production 250 intentionally STOPPED, CAs previously listed only via the holding
half will show an empty `trackedBy` until a fresh watch BUY lands. That is the intended
behavior — "không backfill lại lịch sử". No backfill was added.

## Not touched
`server/test/door-pool.test.ts`, `server/src/poller.ts`, `server/src/api.ts`,
`server/src/snapshot.ts`, `server/src/providers/nansen.ts`, FE `src/**`,
`docker-compose.yml`, `.env.example`, `docs/**`. No git, no deploy, no ssh, no new deps.
