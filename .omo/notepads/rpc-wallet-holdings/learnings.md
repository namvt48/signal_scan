
## 2026-09-16 — Solana RPC holdings path: session learnings

- `Chain` is `['sol']` only (`server/src/shared/chain.ts`), so the spec's non-sol
  `currentBalance` fallback is unreachable by type. Kept (spec MUST NOT #3) and
  exercised in a test via an explicit `as unknown as Chain` cast.
- `walletTokenHoldings` FILTERS to tracked mints before returning, so
  `rows.length === trackedCasHeld` by construction; a test must not assert them
  as independent values.
- Live public endpoint `api.mainnet-beta.solana.com`: one wallet × 2 programs
  (SPL + Token-2022) = 2 requests, ~0.6–1.4 s. Token-2022 is NOT optional —
  13 of 21 tracked mints for the probe wallet came from Token-2022.
- A sustained 11-wallet sweep (22 heavy calls) does NOT finish in 300 s against
  the public endpoint; measure call count with a stubbed fetch (test) instead of
  hammering production RPC.
- `trackedByNames` is a UNION of `token_amount > 0` AND a buy inside the window,
  so column 5 keeps its pre-change meaning; only the holding amount source moved.

## 2026-09-16 — DEFECT: shared try/catch inerted the RPC holdings path

- **Defect**: `walletSweep` wrapped `walletActivity` (paid Nansen dexTrades, 403
  "Insufficient credits" when exhausted) AND `walletTokenHoldings` (free Solana
  RPC) in ONE try/catch. A 403 on the credit door aborted the whole iteration →
  `replaceWalletBalances` never ran. The credit-free holdings feature was dead
  exactly in its target scenario (prod: `wallet_token_state` stuck at 14 rows).
- **Fix** (`server/src/poller.ts`): split into TWO try/catch blocks inside the
  `pacedFor` callback; order preserved (activity/trades → holdings). Log tags now
  `[poller] walletSweep activity` / `[poller] walletSweep holdings`. `walletSweep`
  exported for testability (was module-private and untested — why this shipped).
- **Test**: `server/test/poller.test.ts` — `walletSweep: activity 403 still
  writes the credit-free RPC holdings` (fake provider name='nansen',
  `walletActivity` rejects 403, `walletTokenHoldings` resolves `[{ca:'CA1', amount:123}]`;
  asserts walletSweep resolves AND `wallet_token_state.token_amount === 123`).
  Suite: 80 → 81 passing, 0 failing.
- **Same shared-catch pattern still lives in `kickWallet`** (poller.ts, the
  on-demand kick path). Not in scope here; if credits stay exhausted the kick
  path still drops holdings. Flag for a follow-up.
- `walletTokenBalances` / `sumHoldingUsd`: no survivors repo-wide (grep clean
  outside node_modules).

## 2026-09-16 — kickWallet isolated too (same root cause, on-demand path)

- `kickWallet` (on-demand wallet click → same "Tracked by"/"Holding %" columns)
  had the identical shared try/catch. Now two isolated try/catch (order preserved,
  still `void`, no signature change); tags `[poller] kickWallet activity|holdings`.
- Test added to the SAME file: `kickWallet: activity 403 still writes the
  credit-free RPC holdings` (distinct wallet + CA2/456 to prove independence).
- Suite: 81 → 82 passing, 0 failing.
- **Test-harness trap**: `walletSweep` uses `listWallets()` + `pacedFor`, so a
  second wallet registered in the shared `before()` made the sweep sleep
  `900000*0.8/2` = 6 min between wallets — the suite "hung" (caught with a
  `timeout` wrapper). Register the kick wallet INLINE in its own test, not in
  `before()`, so the sweep still sees exactly one wallet.
- Both callers now agree: activity failure never gates holdings.

## 2026-09-16 — evidence rows 147/148/150 (files 04 + 05)

- **`04-mock-sweep.txt`** closes spec line 147. Real `MODE=mock` (config.ts:18-19 literal) →
  `seedIfEmpty()` 8 wallets + 4 tracked CAs → real `startPoller`/`walletSweep` on `:memory:`.
  Wrote 13 `wallet_token_state` rows; `assembleSignals()` rendered BOTH columns non-trivially for
  all 4 tracked CAs (e.g. `trackedBy ["CT04","CT05","CT08"]`, `trackedHolding 1.769`). Mock is also
  the clean control for the formula swap: mock `market_cap = price × supply`, so old
  (`Σbalance_usd/market_cap`) and new (`Σtoken_amount/supply`) match EXACTLY (diff 0 on 4/4).
- **`05-holding-parity.txt`** closes spec line 148 + 150. 21 real CAs (not the required 3), amounts
  from `02-live-single-wallet.json`, real supply via RPC `getTokenSupply`, real price/mc via
  DexScreener (the proxy — Nansen credits 403, no local prod `token_state` dump; every number was
  fetched, none estimated). 8/21 diff < 1% (0.0056%–0.99%) where the market source's implied supply
  matches RPC total supply → the price-cancellation identity is CONFIRMED on real data.
- **13/21 show a LARGE diff (max 82004.8%, `XsueG8…`)** — this is spec escalate #2, surfaced loudly.
  Cause is measured, not guessed: `diff` ≡ `|1 − (price×supply)/marketCap|`, i.e. the two data sources
  disagree on SUPPLY basis. Three sub-causes visible: (a) DexScreener placeholder supply = 1000.00
  exactly (XsCPL9d/XsoCS1/XsueG8) — a proxy artifact, cannot occur in prod where mc+supply come from
  the same Nansen tokenInfo call; (b) circulating mc vs RPC total supply (USD1tt 158M vs 1.32B, 3ZLek,
  Eic/BoTx/Xs3e/METv); (c) when `fdv = price × total supply` is used the diff collapses (<1%) again.
  **UNRESOLVED**: which supply basis Nansen essential-data gives `token_state.market_cap` vs `.supply`.
  Prod `prod-signals.json` cannot settle it (only 2/405 signals have non-zero `trackedHolding`, captured
  during the credit-door defect window). Needs user sign-off before trusting `Holding %` on such tokens.
- Line 150 arithmetic: `2 programIds × 11 wallets = 22 RPC requests/sweep`; `02` has
  `rpcRequests: 2, trackedCasHeld: 21` for ONE wallet → the count does NOT scale with CAs
  (`nansen.ts:536` maps `TOKEN_PROGRAM_IDS` (2 entries) and filters mints locally). Old door was
  `11 × 405 = 4455` credits/sweep (spec's 499-CA figure predates `prod-tracked-cas.json`'s 405 rows).
- **No CA excluded**: all 21 had real supply + real price/mc; the script's `MISSING -> EXCLUDED` branch
  was never taken (summary 21/21 complete). The only CAs a naive reading might expect to exclude —
  XsCPL9d/XsoCS1/XsueG8/98sMhv — are INCLUDED and reported, because their bad supply is the finding.

## 2026-09-16 — security MEDIUM fix: endpoint token leak (audit finding)
- **Leak mechanism**: `solana.ts` stored the RAW error (`last = e`) and interpolated it into the final
  throw. For a syntactically invalid configured endpoint, Node's `fetch` throws
  `TypeError: Failed to parse URL from <the entire raw URL>` — so the token-bearing endpoint reached
  `console.error` via `poller.ts:168,177,344`. Reproduced RED: the pre-fix rejection read
  `... failed (WALLET): TypeError: Failed to parse URL from not-a-url-with-SECRETTOKEN123`.
- **Fix**: catch now stores only a safe classification `e instanceof Error ? e.name : 'error'`; the
  final `throw new Error(...)` shape is unchanged. `parseRpcEndpoints` now drops entries whose
  `new URL(s)` parse fails or whose protocol is not http(s), so an unparseable string never reaches
  `fetch` (all-invalid → constructor's existing `no endpoints configured` loud throw).
- **Test name**: `SolanaRpcClient: a syntactically invalid endpoint never leaks the URL/token into
  the rejection` (`server/test/solana.test.ts`) — asserts the rejection message lacks both
  `SECRETTOKEN123` and `not-a-url`. Confirmed RED before the fix, GREEN after.
- **Evidence**: `.omo/evidence/rpc-wallet-holdings/06-tests.txt` now covers spec §13 row 2
  (`npm test` → 0 failures, pasted output: tests 83 / pass 83 / fail 0, `TSC_EXIT=0`).


## 2026-09-16 — silent-wipe path in `parseTokenAccounts` (adversarial review)

- **Defect**: `parseTokenAccounts` (`server/src/providers/solana.ts`) only threw on a
  malformed ENVELOPE (`result`/`result.value` not an array). A VALID envelope
  (`result.value` = array) whose entries carry NO `parsed.info` (Node returns raw
  base64 `data` for accounts its parser can't handle, e.g. unknown Token-2022
  extensions — see `scripts/wallet_watch.py:343`) was `continue`d per-entry → empty
  Map, NO throw. Chain: `nansen.walletTokenHoldings` → `[]` → `ingest.replaceWalletBalances`
  runs `DELETE FROM wallet_token_state WHERE wallet_id = ?` and inserts nothing →
  that wallet's `Tracked by` / `Holding %` silently collapse to 0.
- **Guard**: count entries with a valid non-empty `mint` (`parsed`), incremented
  BEFORE the amount check (so mint + `amount <= 0` still counts as parsed). After the
  loop: `if (parsed === 0 && value.length > 0) throw new Error('solana rpc: getTokenAccountsByOwner returned accounts with no parsed token info')`.
  The throw propagates out of `getTokenAccountsByOwner` (parse call is inside the
  per-endpoint `try`) → next endpoint tried; on exhaustion the caller keeps prior rows.
- **An EMPTY `value` array must NEVER throw** — it is the legitimate "holds none of
  these tracked mints" case (the caller's `tracked` filter is what legitimately yields `[]`).
- **Tests** (`server/test/solana.test.ts`, both new):
  `parseTokenAccounts: a non-empty list with no parsed info throws (never a silent empty result)`
  (RED before fix — returned Map size 0 instead of throwing) and
  `parseTokenAccounts: an empty value array is a legitimate empty result (no throw)`.
  Suite 83 → 85 pass / 0 fail; `npx tsc --noEmit` exit 0.
