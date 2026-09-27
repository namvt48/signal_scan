# Linked-only wallet sweep — 2026-09-23

## Ask (user, verbatim)

"chỉ call CA đó đối với các ví Tracked by chứ, giờ tracked by, tracked inflow, tracked holding đều
lấy từ wallet watch, không tự query và chỉ query các wallet liên quan đến CA đó và không query toàn
bộ các wallet dù không liên quan"

## Why (measured before the change)

- `walletSweep` called `listWallets()` = `SELECT * FROM wallets` (no chain/active filter) → **198**
  wallets per pass, 2 RPC calls each (`Promise.all` over SPL + Token-2022) = **396
  `getTokenAccountsByOwner` calls per sweep**, of which the wallets any CA links to are **47**.
- `getTokenAccountsByOwner` is the only method that logs 429 (3× in a 5-min window at
  `SOLANA_RPC_MIN_INTERVAL_MS=800`; 0 at 2000).
- `sumHoldingAmount(ca)` summed `wallet_token_state` over **every** wallet, so a wallet the CA is
  not `Tracked by` still counted toward Tracked holding.
- `pruneUntrackedCas`'s "still held" clause had the same blindness: a leftover row from an unlinked
  wallet kept a CA alive.

## Changes

| File | Change |
|---|---|
| `server/src/poller.ts:424-431` | `walletSweep` now iterates `walletsLinkedToCas(listTrackedCas().map(c => c.address))`; `listWallets` import dropped |
| `server/src/signals.ts:76-95` | `sumHoldingAmount` scoped with `EXISTS (watch BUY on that wallet+ca)` — Tracked holding can only count wallets `trackedByNames` lists |
| `server/src/db.ts:466-497` | `pruneUntrackedCas` holding clause requires the same watch-BUY link |

## Verification

- `cd server && npm test` → **187 tests / 187 pass / 0 fail** (was 186; +1 new).
  - New: `sumHoldingAmount: counts a CA's holders, never an unlinked wallet's leftover rows`.
  - Rewritten: `walletSweep: writes holdings for linked wallets only, never queries the rest` —
    asserts `seen === ['wallet-addr-1']` and that the unlinked wallet gets no row.
  - Fixture updates forced by the new rule: `prune-untracked-cas` (HELD needs a watch buy; new
    UNLINKED_HELD case must be dropped) and `signals.test` (CA_B holding now comes from a wallet
    with an 8d watch buy, so `Tracked holding` = 1e-4 while `trackedBy` stays `[]`).
- `npm run build` (tsc) → exit 0. LSP clean: `poller.ts`, `db.ts`, `signals.ts`.
- Deployed `make restart` → api `Up`, web `HTTP 200 — localhost:8124`, `/api/health` healthy.
  `docker inspect` → `RestartCount=0 ExitCode=0 OOM=false` (no crash loop).
- Deployed artifacts carry the change: `grep -c walletsLinkedToCas /app/dist/poller.js` = 3,
  `listWallets` gone from `poller.js`.
- Prod set sizes (read-only SQL): `tracked_cas = 95`, **linked wallets = 47**, total wallets = 198
  → sweep volume 396 → 94 RPC calls per pass (**-76%**).
- `solana rpc 429` lines since deploy: **0** (window ~5 min).

## Not verified / next

- The sweep tick itself (≤ `POLL_WALLETS_MS` = 15 min) had not been observed at write time:
  `walletSweep` logs only errors and prunes, so a clean pass is silent. Follow-up: watch for
  `prune untracked CA` (any CA that only an unlinked wallet held will now drop — expected) and
  keep counting `solana rpc 429`.
- `SOLANA_RPC_MIN_INTERVAL_MS` is **1500** in prod (was set 2000 → 800 → 1500). 800 measured 3×429
  per 5 min; the shared Helius key (daemon `getSignaturesForAddress` over 198 wallets every
  `--sweep` 60s ≈ 3.3 rps) is the remaining load source.
- Pending user decision: "xóa hết data CA đi chạy lại từ đầu" — scope not yet fixed (no dedicated
  reset target exists; `make ssh-rm` nukes the whole `REMOTE_DIR` incl. the DB).
