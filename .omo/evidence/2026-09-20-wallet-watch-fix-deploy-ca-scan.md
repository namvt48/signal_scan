# wallet_watch 4-defect fix + deploy + CA rescan — 2026-09-20

## Artifacts
| what | path | sha256 |
|---|---|---|
| fixed watcher | `scripts/wallet_watch.py` (local) = `/opt/wallet-watch/wallet_watch.py` (server, 61277 B) | `fbf104e26936ebd8f5cdad141583bb844c8de9d00ff3f9ab2137ec2285bedd14` |
| pre-fix original (server backup) | `/opt/wallet-watch/wallet_watch.py.bak.preDefectFix.20260920T175453` (58565 B) | `b36e645b5d02eef6a1f5ebed9705d60132cd398fc033a09d77270c11cfbc4da7` |
| regression tests | `scripts/test_wallet_watch.py` | `f2a58367ef255f03bfda6914c2dba2d8715e6aa9a21dbd3cdce029443e698066` |
| CA validator | `scripts/ca_verify.py` (server copy `/tmp/ca_verify.py`) | `--selftest` 6/6 |

## Fixes shipped (3/4)
- (a) discovery — `_handle_tx`: tracked-wallet keys = `_keys(message, meta)` ∪ `{owner}` from `meta.pre/postTokenBalances`, so a wallet visible only via its ATA is no longer skipped.
- (c) watermark — `fetch_new_sigs`: `out[:cap]` → `out[-cap:]` (keep OLDEST cap sigs; return shape unchanged ⇒ `backtest_parity.py:170` unaffected).
- (d) unsigned receive — new `_recv_event()` + branch in `_target_event` when wallet signed nothing and has no BUY: `amount_basis="net_delta"`, `quote_usd=0.0`, `usd_pending=True` ⇒ `track_post_body` → None ⇒ events.jsonl/log only, no CA post.

## Not fixed (1/4) — defect (b) multi-owner amount inflation
Fix (`party` field + `_same_party` guard in `_match_pairs`) implemented, measured, **reverted**:
- broke 3 known-good rows in `test_wallet_watch.py` (2mneSLq2D3 FLCW 31386721.0969 · 4arviYxdWk JUPCAT 325262.4987 · UPNTbDWnxn3 WUFF 1488274.0) and `test_block_feed.py` (29→26 events) because legit Jupiter multi-hop routes pair legs with a relayer party (`9PQNbk`, `HU23r7`) against the wallet's own leg (`AcKpsk`);
- on tx `5HE3GrDne` it kept another trader's pair (ARu4n5/ARu4n5) and dropped the wallet's 3 real `HTmQz7` buys.
- True net in `5HE3GrDne`: `HTmQz7` +591,289.486346 / USDC −3,499.999999; detector emitted 4 steps summing 609,576.79 (+3.1%, inside oracle `GROSS_CAP = 0.08`). Needs route reconstruction, not a party filter.

## Test evidence (local, final files)
`test_wallet_watch.py` exit 0 · `test_route_detect.py` 15/15 · `test_block_feed.py` 19/19 · `test_wallet_watch_config.py` PASS · `test_rpc_resilience.py` 13/13 · `test_gmgn_api_parity.py` (T8) steps 29/29 · identity 29/29 · side 29/29 · amounts exact 23/29 + 6 gross · `MUTATION GATE 4/4 RED(FAIL)→GREEN(PASS) ALL OK` · byte-identical after 4 in-process mutations: True.

RED proof on the pre-fix file (`/tmp/orig_wallet_watch.py`, sha `b36e645b…`): (a) wallet with ATA-only presence skipped = True · (b) kept newest `S00,S01,S02` = True · (d) receive-only → `None` = True ⇒ each new test fails on the old code.

## Deploy evidence (root@194.163.187.250)
- `sha256sum /opt/wallet-watch/wallet_watch.py` → `fbf104e26936ebd8…` (= local), size 61277.
- `systemctl restart wallet-watch` → `is-active: active`, MainPID 3228252, journal: no traceback/error.
- `GET http://127.0.0.1:8124/api/wallets` → 198 wallets / 193 named (unchanged).
- `wallet_watch_state.json` → keys `wallets`,`block_slot`; wallets 208 before = 208 after restart (watermarks preserved).
- `events.jsonl` 72934 → 72936 within ~2 min ⇒ live. Sample new event: `{ts 09-20 22:56:27, wallet 2h7Ns9w2…LucrbmzB, mint 9BB6NFEc…pump, side BUY, amount_basis gross_leg, quote_usd 501.396581105906, usd_pending False}`.

## CA rescan (post-deploy, read-only snapshot → `/tmp/live_ca_check3.db`)
`VALID=1057 INVALID=0 UNCERTAIN(kept)=0 verified=1057/1057` · refs elsewhere `{nansen_series:0, wallet_token_state:0, wallet_trades:0}` · report `/tmp/live_ca_report3.json`.
Prior scans: backup DB 1044/1044 valid; live 1055/1055 (`/tmp/live_ca_report.json`), 1056/1056 (`/tmp/live_ca_report2.json`).
⇒ nothing invalid to delete; `--apply` intentionally NOT run (would be a no-op).
