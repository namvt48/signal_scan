# Chain-scoped holdings (fix chain-blind joins) — 2026-09-28

## Objective
`% holding` (and the two CA-delete gates) joined on `ca` ALONE, so an address tracked
on two chains pooled both chains' positions. User: "sửa đi và deploy lại".

## Root cause
`wallet_token_state` IS chain-scoped (`db.ts:284`, PK `(wallet_id, ca, chain)`, T3
migration `db.ts:255-291`) and `tracked_cas` is `UNIQUE(address, chain)` (`db.ts:114`),
but 6 readers ignored the column. Two stale comments (old `db.ts:643`, `db.ts:752`)
asserted "wallet_token_state has no chain column (CHAINS is sol-only)" — false, and
that falsehood is what licensed the bug.

| # | Site | Fix |
|---|---|---|
| 1 | `signals.ts` `sumHoldingAmountByCa` | key `${chain}:${ca}`, `GROUP BY s.chain, s.ca`, `t.chain = s.chain` |
| 2 | `signals.ts` `sumHoldingAmount` | `chain` param, `WHERE s.ca = ? AND s.chain = ?` |
| 3 | `signals.ts` `trackedWalletStatsByCa` | `${chain}:${ca}` key, chain on members CTE + both joins |
| 4 | `signals.ts` `trackedWalletStats` | `chain` param, chain on both joins |
| 5 | `db.ts` `pruneUntrackedCas` | `s.chain = t.chain`, `wt.chain = s.chain`, `w.chain = t.chain` |
| 6 | `db.ts` `listCaScoreGateCandidates` | `wts.chain = t.chain`, `wt.chain = wts.chain` |
| + | `db.ts` `sweepOrphanedCaData` | `t.chain = wallet_token_state.chain` (same class, found while fixing the comment above it) |

Call sites `signals.ts:444` (holding) and `:451` (wallets) now look up `${c.chain}:${c.address}`.

## RED (new test file, before the fix) — 5/5 failing
`server/test/chain-scoped-holdings.test.ts`, same address on base AND bsc:
cross-chain symptom reproduced — `trackedHolding` read **75% on BOTH rows** (should be
25% / 50%), `balUsd` pooled, `pruneUntrackedCas` returned `[]` instead of `['base']`,
`listCaScoreGateCandidates` spared `base:GDUP` because `bsc:GDUP` was held.

## GREEN
```
✔ sumHoldingAmountByCa: one bucket per (chain, ca), never merged
✔ assembleSignals: trackedHolding comes from its own chain (25% base / 50% bsc)
✔ trackedWalletStatsByCa: balUsd never crosses chains
✔ pruneUntrackedCas: a position on ANOTHER chain must not spare a CA
✔ listCaScoreGateCandidates: a position on ANOTHER chain must not spare a 0/3 CA
```
`npx tsc --noEmit` → exit 0.
`npm test` → **tests 356 / pass 356 / fail 0** (baseline 351 + 5 new; zero regressions).
Existing batch≡per-CA locks updated to the new `(chain, ca)` contract
(`assemble-signals-batch.test.ts`, `signals.test.ts`, `wallet-clan.test.ts`).

## Pre-deploy: proven no-op on live data
`/app/chain-audit.mjs` against `/data/signal_scan.db` (read-only), before deploy:
```json
{"noop":true,"dupTracked":[],"stateMismatch":[],"tradeMismatch":[],"walletTradeChain":0,
 "counts":{"tracked_cas":463,"wallets":201,"wallet_token_state":580,"watch_trades":35226}}
```
No address tracked on >1 chain, no chain-mismatched state row or watch trade, no wallet
trading off its own chain ⇒ every changed query returns byte-identical results today.
The fix is a **latent-bug fix**: it changes nothing now and locks the invariant before a
shared `0x…` address appears on base + bsc.

## Deploy (instance a only)
`make deploy` → `signal_scan-api` + `signal_scan-web` built, `== deploy OK — instance=a
port=8124 dir=/root/signal_scan`. `make up` → `signal_scan-api-1 Recreated/Started`.
- `docker compose ps`: api Up, web Up `127.0.0.1:8124->80/tcp`, chrome Up.
- `curl localhost:8124/` → **HTTP 200**; `/api/health` → `"healthy":true`.
- Fix present in the RUNNING container: `src/db.ts` lines 649 (sweep), 688/690/693
  (prune), 771/773 (gate); `src/signals.ts:271` `${r.chain}:${r.ca}`, `:444`/`:451`
  call sites. `grep -c 'no chain column' src/db.ts` → **0**.
- Ingest alive across the deploy: `watch_trades` 35 226 → 35 232, `wallet_token_state`
  580 → 581.

## End-to-end read path
`GET /api/signals` (service token) → **HTTP 200**, `rows=264`,
`holdingNonZero=195`, e.g. `sol:FPT65CmLh8gDJq6nZnpFMSQN7dkGBTchzypfeA4FPrFA` →
`trackedHolding=0.7397251028292298`. The new SQL prepares and runs against the real DB.

## Honest limits
- On today's data the fix is verifiably a **no-op**; it prevents a future wrong number,
  it does not correct a wrong number now. No live figure was previously misreported.
- Instance b (`/root/signal_scan_b`, 8125) untouched.
- Not committed (user: "Chưa commit").

EVIDENCE_RECORDED: evidence/2026-09-28-chain-scoped-holdings.md
