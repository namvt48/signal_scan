# issues - nansen-groundtruth-parity


## [C0] discriminator (b) plan-vs-measurement conflict -> T4 re-derive
Todo 4 must NOT assume rd=RELAY for real fee legs. Plan C7 premise disproven. Update C7 + add C7-real + update mutation-check (ii).
## [C2] oracle divergence 1bPapYy2 -> T5 classifies TRANSFER_FALSE_POSITIVE
## [PROVIDER] worker-low / direct worker-* sessions crash with "content[].thinking in the thinking mode must be passed back to the API". Use category-based Sisyphus-Junior only. Crashed session ses_f38128bebffehStxKWzE5SWQyj abandoned.
## [T2 deviation] extra fixture 5fgRuKgt not in sorted(transfer_only)[:5] (rank 181) - fetched as Appendix A, documented.

## 2026-09-22 — Task 4: fee-leg SELL Option A (B1)
- Plan text for C3 says "SELL A + BUY B + fee of A", but condition (c) requires same-mint BUY. Resolved test as SELL A + BUY B + fee of B; added C3-conflict to lock fee-of-A non-promotion.
- Amendment required explicit `C7-real`; added as an explicit case aliasing C1 because C1 is exactly the C0/B1 shape (`rd=POOL` but dst not a step pool).
- Mutation (i) produced broader failures than the minimum C2/C4: C3-conflict, C8, and integration-RxrDxxL2 also ERROR when the same-mint BUY guard is removed. This is acceptable because required C2/C4 fail, but it means any future "no steps" short-circuit can weaken the mutation gate.
- `ruleA_real_regress.py` remains exit=1 by design in this workspace because `/opt/wallet-watch/wallet_watch.py` is absent.
- Fee promotion changes `step`/`n_steps` and trace output for affected txs; downstream consumers that assume only paired DEX steps per tx should be checked separately.
## [T6] USDC price entry in prices.json is 0.004528 (DexScreener best-liquidity pair with
USDC as baseToken — production token_info quirk, same value production would cache).
Harmless for parity: _quote_px/ui_price hardcode USDC→1.0; _info[USDC] only feeds _dsym.
Do not "fix" by hand-editing the snapshot — capture_prices rewrites from ww._info.
## [T6] fetch_tx retries null results 3× (fetch22 precedent) — a genuinely aged-out sig
costs ~4.7s before UNAVAILABLE. Acceptable; cache makes it one-time per sig.
## [T6-FIX] .ruff_cache recreated by PostToolUse ruff hook on every py edit — removed as
final step; if it reappears after this session, it is the hook, not task code. Do NOT
gitignore/allowlist it per verifier; just delete (no git in this repo anyway).

## [T7-signal] RxrDxxL2/3ZLekZYq TYPE_MISMATCH: detector emits 2 SELL vs truth 1 (over-emission, NOT fee promotion — sell_fee=0). Oracle-divergence family (C2 precedent). Todo 8: root-cause in report from trace; do NOT tune detector.
## [T7-signal] G9 max_raw=5.23 on dry-run subset (meas=13): outlier usd_ratio inflates p90; drift=0.9951 fine at p50. Todo 8 full run must print p50/p90/max for phase-2 threshold work.
## [T7-note] Pre-existing LSP diagnostics in untouched files (test_nansen_parity.py ModuleType attr-assign = known basedpyright quirk per T6 learnings; wallet_watch.py:971 min-overload). md5s unchanged this task; no .py modified in T7.
