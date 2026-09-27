# Pair-scoped holdings queries + CA wipe (2026-09-23)

User directive: "query cặp CA-wallet chứ không query linh tinh" / "xóa sạch CA trên dashboard rồi chạy lại".

## What changed

Holdings are now queried per **(CA, wallet) pair** instead of per wallet-program scan.

- `db.ts`: `walletsLinkedToCas()` → `trackedByPairs(cas)` (DISTINCT ca+wallet, `side='buy' AND source='watch'`)
  and new `trackedCasForWallet(walletId)` (tracked CAs a wallet is linked to).
- `providers/solana.ts`: `getTokenAccountsByOwner(wallet, string | {mint})` — `{mint}` sends the
  mint filter, `string` keeps the legacy `{programId}` shape (8 existing call sites unchanged).
  Measured on real Helius: `{mint}` = 200 / 766 B / 1 account / 126 ms; the `{programId}` call issued
  right after it 429'd.
- `providers/nansen.ts`: `walletTokenHoldings(wallet, chain, cas?)` — one RPC call per pair, the
  `Promise.all` over `TOKEN_PROGRAM_IDS` is gone (the mint filter resolves SPL vs Token-2022 itself).
  `cas` omitted = tracked CAs on that chain (legacy broad call). Non-sol credit door takes the same list.
- `ingest.ts`: `replaceWalletBalances` is **pair-scoped** — deletes only the `(wallet_id, ca)` rows it
  was handed, and an `amount <= 0` pair deletes its row (sold-out position must decay, not freeze).
- `poller.ts`: `walletSweep` iterates pairs; `kickWalletHoldingsFor` iterates pairs of the given CAs;
  `kickWallet(..., cas)` no-ops on an empty list; `kickWalletRow(row, ca?)` = one pair on a trade event,
  the wallet's own CAs on add/edit.
- `api.ts`: the watch-trade path kicks the single `(wallet, parsed.ca)` pair.

Cost: 108 pairs vs the previous 94 coarse calls (+15% calls, each 766 B / one CA instead of a
~40 kB scan of up to 2622 unrelated mints).

## Verification (local)

- `npx tsx --test test/*.test.ts` → **189 tests, 189 pass, 0 fail** (RC=0). Rewritten: the 2 old
  "2 calls/wallet" contract tests → pair contract + 11-wallet × 2-CA = 22 calls. Added: mint-vs-programId
  request-shape test (`solana.test.ts`), pair-scoped 0-deletes-and-siblings-survive test (`poller.test.ts`).
- `npx tsc --noEmit` → exit 0 (test/ is outside the tsc build; its 2 pre-existing `'eth'` errors remain).
- Deploy `make restart`: api+web recreated, `HTTP 200`, `/api/health` `healthy:true`.
- Container artifact: `poller.js` has 3× `trackedByPairs`, 0× `walletsLinkedToCas`; `nansen.js` has the
  `mint: ca` call and references `TOKEN_PROGRAM_IDS` only in a doc comment (no code path).

## CA wipe (prod, irreversible)

- Backup first (WAL-safe `sqlite3.backup()`): `data/signal_scan.db.bak-preca-wipe-20260923T091352Z`, 1 478 656 B.
- `docker compose stop api` → DELETE in one transaction: `tracked_cas`, `token_state`,
  `wallet_token_state`, `wallet_trades`, `nansen_series`, `holder_snapshots` (+ their `sqlite_sequence`
  rows) → `docker compose start api`.
- After: those 6 tables = 0; kept `wallets` = 198, `settings` = 12. `/api/signals` = `[]`.
- Restore if needed: stop api, `cp data/signal_scan.db.bak-preca-wipe-20260923T091352Z data/signal_scan.db`, start api.

## Re-run state (feed is live)

- `wallet-watch.service` active, `NRestarts=0`, `heartbeat` fresh; stdout/stderr → `/opt/wallet-watch/watch.log`
  (NOT journald — journalctl only shows unit lifecycle).
- Daemon log carries no 429 and no POST errors; last swap logged 16:09:59 ICT (= 11:09 CEST, before the wipe).
- Events are sparse by config, not by failure: the daemon takes `min_usd=$50 source=api`
  (`# min_usd=$50 source=api` in watch.log), and its ws feed keeps reconnect-looping (pre-existing).
- The dash refills as the daemon's 198 wallets trade and post swaps ≥ $50 → CA insert + `source='watch'`
  BUY link + pair kick.
- Observed 11:16→11:23 (7 min poll): rows stayed 0 — NOT a failure, verified on all three sides:
  daemon heartbeat age **58.7 s** (loop turning on its 60 s sweep), `watch.log` silent since 16:09:59 ICT
  (no detected swap at all since), Helius `getSignaturesForAddress` → **200, 3 sigs, newest blockTime =
  the 11:09 BABYCATE tx** (that wallet has not traded since), pair `getTokenAccountsByOwner {mint}` →
  **200 in 131 ms** (no 429 at the prod 1500 ms interval). nginx shows 0 `POST /api/trades` only because
  the web container was recreated at 11:13 (logs reset), not because the pipe is down.
- api log after restart: `[poller] walletSweep done in 3ms` = the new pair path live (0 tracked CAs →
  `trackedByPairs([])` → 0 pairs → 0 queries).

## Open risks

- `SOLANA_RPC_MIN_INTERVAL_MS=1500` in prod is still a mitigation, not a root fix: the daemon shares the
  same Helius key and calls `getSignaturesForAddress` for 198 wallets every 60 s (~3.3 rps, unpaced).
  Helius' limit that bit us is per-method (`getTokenAccountsByOwner`), so the pair sweep no longer
  competes for it — but a lower interval needs that daemon sweep widened (120-180 s) or a second key.
- `SECURITY`: `SOLANA_RPC_URL`'s api-key and `NANSEN_API_KEY` were exposed in this session's transcript
  → rotate.
