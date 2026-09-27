# Solana RPC 429 fix (Helius) — 2026-09-22

## Symptom

`docker logs signal_scan-api-1` ~1012 lines/3 min of
`[poller] kickWalletHoldings <wallet> Error: solana rpc getTokenAccountsByOwner failed (<wallet6>): Error`.
Kicks/failures measured over 5 min: **1803 / 1815 = 99.3%**. Column "Tracked by / Holding %" for
chain `sol` goes stale (a failed call writes nothing — no data loss, no deletion).

The trailing `Error` was **not** the reason: `SolanaRpcClient.getTokenAccountsByOwner` deliberately kept
only `e.name` so a token-bearing endpoint URL can never reach the logs — which also discarded the status.

## Root cause (measured from server 250 with the container's own env)

| Probe (same URL/method as the app) | Result |
|---|---|
| `getTokenAccountsByOwner` while idle | **HTTP 200**, real data, 39,979 bytes, slot 449431557 |
| `getHealth` | **HTTP 429**, body `Too Many Requests`, returned in 0.07 s |
| 25 requests, no delay | 13×200 / **12×429** |
| 12 requests @0.12 s (~8 rps) | 11×200 / 1×429 |
| 6 requests @0.15 s (right after a burst) | 1×200 / **5×429** — the limiter stays tripped |
| 5 requests @0.35 s | **5/5 200** |
| 5 requests @0.6 s | 5/5 200 |
| 2 requests in parallel | 200 / 200 |

The key is valid and the method is right — the **per-method credit limiter** rejects the burst.
`walletTokenHoldings` fires `Promise.all` over **2 token programs per wallet** with no gap
(`providers/nansen.ts:608`), 198 tracked wallets, ~6 wallet kicks/s ⇒ **~12 rps** attempted.
`SolanaRpcClient` had **no 429 handling, no backoff**, and `SOLANA_RPC_URL` carries a **single
endpoint**, so one 429 was an immediate hard failure.

Not related to the 2-door proxy change (RPC goes direct from 250, not through a crawl door).

## Fix — `server/src/providers/solana.ts`

1. **Pacing**: `pace()` reserves the next start slot; requests on one client are spaced by
   `minIntervalMs = 300` (constructor arg, default), so concurrent callers queue instead of bursting.
   Applied to both `getTokenAccountsByOwner` and `getAssetInfo` (they share the limiter).
2. **429 backoff**: `post()` waits `RETRY_429_DELAYS_MS = [400, 800]` (honours a sane `Retry-After`,
   capped at 2 s) and retries the **same** endpoint before the caller burns the next one.
   Non-429 failures keep the previous "next endpoint" semantics (no retry on 503/JSON-RPC errors).
3. **Diagnosable but still token-safe**: locally-built messages (`SafeRpcError`) keep the status, so
   logs now read `solana rpc 429`; anything else (Node's `Failed to parse URL from <endpoint>`) still
   reduces to `e.name`.

Budget: 396 calls/sweep × 300 ms ≈ **119 s**, well inside `POLL_WALLETS_MS=900_000`. No Helius upgrade,
no cadence change, no poller change (frozen file untouched).

## Verification

- `npm run build` → exit 0.
- `npx tsx --test test/solana.test.ts` → **14/14** (11 existing + 3 new: 429-then-success retry,
  concurrent calls spaced, persistent 429 rejects with the status and never the token).
- `npm test` (full) → **150 pass / 0 fail** (150 `test(` across `test/*.ts`).
- Deployed: `make deploy` (build OK) + `make up` → api `Up`, web `HTTP 200`, `/api/health` healthy.
- **Failures after deploy: 1 / 5 min** (was 1803 / 5 min). The one remaining line now reads
  `solana rpc 429` — the new classification.
- Ran the **deployed** code inside the container (`/app/dist/providers/solana.js`, 6 real wallets):
  `RESULT ok=6 fail=0 ms=1539` with real holdings (`mints=75, 358, 2622, 16, 18, 36`) ≈ 256 ms/call.
- 2-door crawl unaffected: `loaded 2 proxies → 2 doors`, both doors `healthy`; DB WAL still advancing.

## Residual / notes

- 1 error per 5 min remains: the pace sits at the edge of what the key allows, and the limiter is
  per-account — if another service of the owner uses the same Helius key, it shares the budget.
  Local dev has no `SOLANA_RPC_URL` and no dev server running, so it is not a second consumer.
  If it matters: raise `minIntervalMs` to ~400 ms, or append a fallback endpoint to
  `SOLANA_RPC_URL` (`https://api.mainnet-beta.solana.com` answered 200 + jsonParsed in a probe).
- Side effect: DAS `getAssetInfo` floor calls are paced too (~300 ms each) on the metric sweeps —
  bounded by `POLL_HOT_MS/POLL_COLD_MS = 600 s`.
- Rollback: revert `server/src/providers/solana.ts` and redeploy (restores the unpaced behaviour that
  failed 99.3%).
- Unrelated infra quirk observed: `docker cp` from the ssh session on 250 fails with
  `lstat ... no such file or directory` while the same path is readable by `cat`; piping the script
  through `docker exec -i node --input-type=module` works.

## Follow-up: pace 300ms → 600ms (user request) + full-flow check on 250

Why the residual 429 survived the first fix: it is **Cloudflare**, not Helius —
probe from inside the api container returned `429 [server=cloudflare cf-ray=yes retry-after=1] "Too Many Requests"`
(plain text, no JSON-RPC error), so the ceiling is the SUSTAINED rate from this box
and the budget is shared with the DAS `getAsset` path (same client, same host).
Measured with the poller running: probe @500ms (2 rps) → 1/10 x 429; probe @300ms (3.3 rps) → 2/10 x 429.
300ms was also never verified — the clean measurement was 350ms.

Change: `minIntervalMs` 300 → **600** (one line, `server/src/providers/solana.ts`). 1.7 rps ≈ 17 req/10s;
a 396-call sweep is still ~240s against `POLL_WALLETS_MS=900_000`.

Gates: `tsc` exit 0 · `test/solana.test.ts` 14/14 · full suite **150 pass / 0 fail** ·
`make deploy` + `make up` OK (api Up since 2026-09-22T16:41:10Z).

| Check (250, ~20 min window) | Result |
|---|---|
| `solana rpc 429` | **1** (was 1803 / 5 min); lone hit 16:46:42Z, same minute as a `kickNansen` update |
| crawl doors | `loaded 2 proxies → 2 doors`, both `healthy`, `retire/transport fail = 0` |
| token metrics | `kickNansen … cached + extremes updated` every 30-75s; `token_state` 280 rows, `max(fetched_at)` = 1 s before the check |
| Solana holdings | `wallet_token_state` **793 rows, 793 with token_amount > 0** (real mints, e.g. `6GmAFSYs…`) |
| API | `/api/health` healthy; `/api/signals` 198 rows (all `sol`), `trackedBy>0` on 147, `trackedHolding>0` on 83; `/api/wallets` 198; `/api/tracked-cas` 280 |
| DB | `signal_scan.db-wal` mtime advancing |

Not a regression: `/api/tokens/:chain/:ca/detail` and `…/balance-chart` return 404 because both
routes are **commented out** in `server/src/api.ts:418-447` ("Re-enable by uncommenting this block") —
pre-existing, unrelated to this fix.

Remaining 1-in-20-min 429 is at the CF edge and needs either a slower pace (900ms) or a second
endpoint (`https://api.mainnet-beta.solana.com` was probed 200 + jsonParsed, no Helius CF rule).

EVIDENCE_RECORDED: evidence/2026-09-22-solana-rpc-429-fix.md

