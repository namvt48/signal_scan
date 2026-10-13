# FOMO EVM wallet watch - runbook (2026-10-07)

**Scope:** Instance B only. Add one generic `EVM` wallet address; the API stores one row per supported chain (`base`, `bsc`, `robinhood`) so the existing chain-aware watcher, trade ingester, and holdings poller can use it without changing the wallet address at each screen.

## Coverage contract

The FOMO-only daemon runs `watchers.evm` with `--chains base,bsc,robinhood --feed poll --no-min-usd-gate` and posts to instance B (`127.0.0.1:8125`). It reads all three chain rows from `/api/wallets`, writes trades through `/api/wallet-watch/trades`, and keeps its cursor/heartbeat under `/opt/fomo-wallet-watch/data`. Its systemd unit is `fomo-evm-wallet-watch.service`; deploy/start it with `make fomo-evm-watch-deploy` after instance B is healthy. It uses `/opt/fomo-watch/fomo.env` for the existing service token. It does not restart or edit instance A's `wallet-watch.service`.

RPC configuration:

| Chain | Ordered RPC pool | Final fallback |
|---|---|---|
| Base | `BASE_RPC_URL`: Alchemy key 1, then key 2 | `https://mainnet.base.org` |
| BSC | `BSC_RPC_URL`: Alchemy key 1, then key 2 | `https://bsc-rpc.publicnode.com` |
| Robinhood | `ROBINHOOD_RPC_URL`: Alchemy key 1, then key 2 | `https://rpc.mainnet.chain.robinhood.com` |

Each env value is a comma-separated ordered URL list in the root-only `/root/signal-scan-monitor/alchemy-rpc.env`, shared by the FOMO watcher and instance-B API (holdings reads). Both clients append their public endpoint as the final fallback. The second Alchemy key is enabled for BSC; Alchemy currently rejects it for Base and Robinhood because those networks are not enabled in that app. Until enabled in Alchemy, failover proceeds to the public endpoint for those networks. Robinhood HTTP chain ID is 4663. BSC public RPC may reject wide or anonymous `eth_getLogs` ranges; the watcher narrows ranges, but public-provider throughput may not meet real-time coverage.

Apply/restart both readers with `make fomo-rpc-apply INSTANCE=b`; this recreates only instance-B API, checks its health, then deploys/restarts the FOMO watcher.

The watcher classifies ERC-20 transfers only when the transaction receipt targets a router in `watchers/evm/classify.py`'s per-chain allowlist. It additionally reconstructs native-coin input from the transaction value and native output from the wrapped-native `Withdrawal` event, but only on those allowlisted router transactions and only alongside the wallet's ERC-20 swap leg.

**Coverage limits:** swaps through unlisted routers/aggregators, router-less native transfers, and unsupported transaction shapes are not classified. Cold start begins at the current finalized tip; historical trades are not backfilled. Poll mode now caps work at 16 chunks per chain per turn and immediately rotates among chains while any cursor has backlog, so BSC cannot block Base or Robinhood. Each chain's lag still depends on its RPC throughput; BSC's anonymous endpoint remains below reliable real-time capacity.

## Wallet UI and import

On the FOMO Wallets screen, choose `EVM (Base · BSC · Robinhood)` and enter a `0x` plus 40-hex address. Add, edit, and delete operate on the three-chain group; edits share name/tags/source/clan and imports use `chain=evm`. Export writes one generic EVM row. Existing chain-specific EVM rows are additively backfilled to the other supported EVM chains on instance B startup; instance A does not run this migration.

For the imported wallet list, a non-empty emoji is prefixed to the display name and retained as an `emoji:` tag; `x_handle`, each `flags` value, and `status` are retained as `x:`, `flag:`, and `status:` tags. A non-empty `group` maps to `clan`. `status:EXCLUDE` remains visible in the wallet list but is excluded from the EVM watcher; other statuses are watched. This batch has no values for `funder_address`, `cluster_id`, trade metrics, or `notes`.

## FOMO by semantics

The `FOMO by` breakdown keeps social FOMO-watch-list users and native tracked wallets in separate lists. Native rows show the configured wallet name, balance USD, buy/sell counts, net inflow, and last activity. `Tracked in` counts both lists. FOMO-user holding percentage remains the FOMO-user metric; native wallet balance/holding follows the chain-specific native wallet poller and is not merged into FOMO-user statistics.

### Holding source, freshness, and completeness

- Social FOMO-user holding is API-first: one `/v2/users/{handle}/balances` request returns all supported chains, refreshed at most once per user per 24 hours. The endpoint is handle-scoped; it does not query an arbitrary native wallet address.
- For each tracked `(chain, CA)`, percentage is `amount / chain-scoped totalSupply × 100`. Use the stored token supply first; if unavailable, query that chain’s EVM `totalSupply()`. The API amount remains useful if supply cannot be read; percentage is then unknown.
- A balance present in a fresh snapshot is valid even when the snapshot is truncated. An omitted tracked CA is zero only when the response is available, complete, and untruncated, and each returned row for supported chains is interpretable. A malformed supported-chain row (including a null/non-numeric amount) downgrades completeness, so omitted CAs stay unknown; an older API row is not mixed into a newer partial snapshot. Fresh FOMO positions and then fresh RPC measurements provide fallback. Reverted `balanceOf` calls and incomplete multi-wallet sums are unknown, not zero.
- Native tracked-wallet balances remain a separate RPC-backed metric. The FOMO balances endpoint cannot replace native-address `balanceOf` reads.
- The balances endpoint costs 250 credits per user request and returns at most about 100 rows. At the 138 distinct FOMO users observed on instance B, one daily refresh is approximately 1.035 million credits per 30-day month. Hourly polling would exceed the observed API quota; do not increase cadence without checking the account plan.


## Verification

Offline detector coverage: `python3 -m pytest scripts/test_evm_classify.py scripts/test_evm_feed.py -q`. API group contract/migration coverage: `npm --prefix server test` (`evm-wallet-groups.test.ts`). Builds: `npm run build` and `npm --prefix server run build`.

## Verification recorded

- `npm run build` — passed; Vite built 4,610 modules.
- `npm --prefix server run build` — passed.
- `npm --prefix server test` — 688 tests passed, including EVM add/import/edit/delete and additive startup migration.
- `python3 -m pytest scripts/test_evm_classify.py scripts/test_evm_feed.py -q` — 45 passed, including `status:EXCLUDE` filtering plus per-chain bounded polling, RPC range caching, BSC fast-fail/concurrent topic requests, and Base/BSC/Robinhood classification.
- Browser smoke on local FOMO build: FOMO-by popup displayed four native wallet names; adding an EVM address produced one `EVM` row; CSV parser/local-store smoke accepted `chain=evm`, added one row, skipped a duplicate in the same batch, and expanded the address into Base/BSC/Robinhood.
- Production-container RPC probes: Base returned chain ID 8453 and filtered `eth_getLogs` succeeded; `bsc-rpc.publicnode.com` returned chain ID 56 and topic-only `eth_getLogs` succeeded for one block; Robinhood returned chain ID 4663 and filtered `eth_getLogs` succeeded. These probes prove endpoint reachability, not sustained throughput.
- Holding regressions: `npx tsx --test test/fomo-holdings.test.ts` (13 passed), `test/fomo-signals.test.ts` (19), `test/evm.test.ts` (17), and `test/poller.test.ts` (6). The API sweep fixture verifies chain-scoped Base/BSC/Robinhood percentages and that only a fresh complete/untruncated snapshot can infer zero.
- Latest server suite: `npm test` — 695 passed. `npm run build` and `npm --prefix server run build` — passed; Vite transformed 4,610 modules.
- Read-only instance-B RPC sample: `balanceOf` and `totalSupply` succeeded on Base, BSC, and Robinhood; sampled Robinhood wallet held 6.493578995521597 tokens of the sampled token. This proves sample endpoint reachability, not sustained provider uptime.
- Browser smoke on local FOMO build reached the authorized sign-in page with no browser errors; no claim about the protected signal table because credentials were unavailable.


## Deployment state

Production deployment recorded 2026-10-07: instance B API health returned `healthy=true`; `fomo-evm-wallet-watch.service` was active with `NRestarts=0`, loaded four wallet rows per chain; instance A's `wallet-watch.service` remained active. Before the bounded-poll fix at 12:35:23 CEST, cursors lagged Base 80, BSC 561, Robinhood 1,504 blocks, confirming cross-chain delay during BSC backfill. After deployment, at 12:36:52 CEST all three were advancing (lags: Base 10, BSC 545, Robinhood 25); at 12:38:04 they were Base 11, BSC 529, Robinhood 27. The bounded scheduler fixes cross-chain starvation. BSC still lags because the anonymous RPC is below real-time throughput. Deploy restarts only the FOMO unit.

2026-10-07 FOMO wallet import: 33 unique addresses became 99 database rows (33 per chain); 29 new groups were added and 4 existing groups' display metadata was updated from the supplied list. The watcher loaded 32 addresses per chain from instance B's API and excluded the one `status:EXCLUDE` wallet. `make fomo-evm-watch-deploy` left the FOMO EVM unit active; instance A API returned HTTP 200 and `wallet-watch.service` remained active. The database backup is `/root/signal_scan_b/data-b/signal_scan.db.pre-fomo-wallet-import-20261007180207`. Browser inspection of production `:8125` stopped at the authorized sign-in page; database and watcher/API behavior were verified directly.

API-first holding release: `make deploy INSTANCE=b && make up INSTANCE=b` rebuilt/restarted only instance B API/web on port 8125; B `/api/health` returned `healthy=true` and web HTTP 200. A remained up on port 8124 with web HTTP 200 and healthy API. The FOMO balance snapshots are paced asynchronously after startup; exact coverage and remaining unknowns are recorded below, and unknowns are never treated as zero.

Post-deploy holding coverage: all 138 active FOMO API target users received a snapshot attempt; 127 snapshots were fresh/available, 9 unavailable, 2 without a usable fresh capture time, and 37 marked truncated. Across active EVM `(user, CA, chain)` alert pairs, fresh percentages from API/position/RPC sources covered Base 6/9, BSC 52/64, and Robinhood 114/114. The remaining 15 pairs (3 Base, 12 BSC) had truncated snapshots, no discovered per-chain wallet in `fomo_user_wallets`, and no fresh FOMO position amount (8 BSC absent, 4 BSC stale). One Base profile has an optional `wallet_evm`, but that single address is not proof of the user's complete multi-wallet set, so it is not treated as a complete zero-capable source. These remain unknown in the dashboard (partial sums use `≈`; all-unknown cells show `—`), not false zeroes. The current FOMO API contract cannot guarantee those rows: its balance list truncates around 100 and does not paginate, and the affected users lack a verified complete wallet set for RPC fallback.

2026-10-07 null-amount safety correction: `fetchFomoBalances` now downgrades completeness when a supported-chain row is malformed, including null/non-numeric/negative amounts or a missing token address; an omitted tracked CA from that snapshot is therefore not inferred as zero. The end-to-end regression sends a complete/untruncated snapshot with `amount:null` and verifies that no `fomo_api_holdings` row is written and the stored snapshot is incomplete. `npx tsx --test test/fomo-holdings.test.ts` — 14 passed; `npm test` — 696 passed; server and dashboard builds passed (Vite transformed 4,610 modules). Redeployed only B with `make deploy INSTANCE=b && make up INSTANCE=b`; SSH localhost checks returned API `healthy=true` and web HTTP 200 for both A (8124) and B (8125). Existing stored API holding rows were not rewritten by this correction.
