# learnings - nansen-groundtruth-parity


## [T1/T2/T3 done] verified baseline + probe + pure core
- T1: tx-sample 990 rows/19 fields, groups 743, shapes 346/134/254/9, usd_null 13; md5 tx-sample=6edc3702cecb4740dad17716284bc867; md5 wallet_watch=3a8739be96405bb94926bf8cb0e454cc. 9 suites: 7 exit0, fix_ruleA_cas + ruleA_real_regress exit1 BY DESIGN (FileNotFoundError /opt/wallet-watch/wallet_watch.py).
- T2: `.probe/nansen-parity/trace-22.md` = 22 numbered entries + CONCLUSION TABLE C0-C5 + Appendix A. 24 fixtures (23 valid + 1 QA null `1111..1`). fetch_errors.json = 1 entry, endpoint PINNED api.mainnet-beta.solana.com.
- T3: `scripts/nansen_parity.py` pure core, 17/17 tests, md5 579e5ab7019d2657dcbc82016fa91451. 2 out-of-spec decisions: usd_ratio(x,0)->None, fee_usd_gate_ok eps 1e-9.
- CONVENTION: tests are plain `assert`, run `python3 scripts/test_*.py`, NEVER pytest. `ruleA_real_regress.py`/`fix_ruleA_cas.py` fail by design — keep that exact error.

## [C0 - CRITICAL for T4] 9/9 real fee legs measure rd=POOL
- `role(dst) != "POOL"` AS WRITTEN BLOCKS EVERY REAL FEE LEG. Proof: 48Y3e48T4z fee leg dst=AiL1eURq.. owner=3CgvbiM3.. pre=361676716052 post=366569794672 Δ=4893078620; 4893078620/1e8 = 48.9307862 == fee amount exactly.
- Fee collector GAINS balance in-tx => balance-based role() stamps POOL. It is NOT any step pool (step pools: CD5HDt23sjGud5VTWsv51BMPey2Qf9qH5cyswWmjBDdq, GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL).
- => (b) MUST be re-derived: B1 (preferred) dst is not a pool account of the tx's paired steps; B2 drop (b) if measured on all 22 fixtures to admit zero false positives.
- C3: RxrDxxL2 0.50% leg (amt 0.033718955) has rs=RELAY => killed by (a); sibling seq=9 (amt 6.74379102, rs=WALLET, rd=RELAY, no_pool_endpoint) blocked ONLY by (c) same-mint SELL/SELL = real "(c) has teeth" case.
- C2: 1bPapYy2 emits 2 events vs Nansen 0 => GMGN/Nansen ORACLE DIVERGENCE (T5 G2 candidate), NOT a detector bug.

## Todo 5 PART 1/2 (constants + side_of + classify) — 2026-09-22
- TDD order held: 21 tests appended FIRST → real RED (17 old PASS / 21 new FAIL
  with AttributeError, correct reason) → implementation → GREEN 38/38 EXIT=0.
- Spec deviation logged: test 8 `net_rel < 1e-12` is arithmetically impossible
  with the spec's own binding inputs (actual 3.0686e-12; fee qty 48.930786 vs
  truth 48.9307862 ⇒ 1.5e-7 abs). Test uses `< 1e-11`; verified numerically
  BEFORE writing. See evidence file.
- D6-step-2 objection (TFP checks literal `events` vs D2-filtered `evs`)
  implemented as specified + logged in classify docstring and evidence; part 2 /
  todo 6 decides what to pass.
- `fee_exempt=N` flag appended unconditionally (literal spec reading).
- Record key order via single `_record` builder + dict.update (update preserves
  insertion order) — one literal, no duplication between UNAVAILABLE and main
  path.
- Runner auto-discovers test_* from globals() at call time; tests must be
  inserted BEFORE the `if __name__ == "__main__"` block, not after it.
- Evidence: .omo/evidence/task-5-nansen-groundtruth-parity.txt
- md5 after: nansen_parity.py 909e7a5f5d63cfad7e94d40a4db07c82 (479 lines),
  test_nansen_parity.py 8fdf1ce9c329b92312c26afe3e1a08c2 (680 lines).

## 2026-09-22 — Task 4: fee-leg SELL Option A (B1)
- Amendment C0 confirmed: balance-derived `role(dst)` cannot discriminate fee collectors; 9/9 real fee legs have `rd=POOL`.
- Working discriminator B1: promote only when candidate `dst`/`dst_owner` is NOT a pool account/pool owner referenced by any paired step in the same tx.
- Candidate capture must happen at `_legs_with_roles` reject sites (`aggregator_frame`, `plumbing`, `no_pool_endpoint`), then be filtered after paired steps exist.
- `program` for `aggregator_frame` candidates must be nearest aggregator on stack; using parent program is correct for `no_pool_endpoint`, and `leg["encl"]` is unavailable/invalid for rejected legs.
- Fee event must inherit quote/unit_price from nearest same-mint BUY step by `|Δseq|`, then regular BUY `qty_net` must be recomputed with `net_adj = net_owner + fee_out`.
- Calling `_promote_fee_candidates` even when `steps == []` makes mutation check (i) fail C2 as required; an outer `if steps` guard would hide the missing condition (c) on transfer-only txs.
- `3fec2kXP.json` actual wallet is `FhsbQzAJWVDNwaH61cTo6XkkfEsmSYMZKs9VJHH32bVG`; plan/initial test typo `...EsmYMZ...` produced 0 events.

## Todo 5 PART 2/2 (reporting half) — 2026-09-22
- TDD again: 8 tests appended FIRST → real RED (38 old PASS / 8 new FAIL with
  AttributeError on GATE_NAMES/pass_bar/summarize — correct reason) → impl →
  GREEN 46/46 EXIT=0. basedpyright 0 errors on both files.
- basedpyright "all" mode gotcha: double-subscript on a heterogeneous inferred
  dict (`summary['class_counts'][c]`) errors on the union value type; annotating
  a local `dict` also errors (reportMissingTypeArgument + union assignment).
  Clean fix matching repo style: tiny private helper with UNANNOTATED param
  (`_class_count_row`) — param infers Unknown, same reason pass_bar is clean.
- _six_records fixture shares one sig between buy-only MATCH and UNAVAILABLE so
  n_sigs < n_records; NA (mixed-sign) record is also shape buy_sell — G4 over
  the fixture is False by construction (sell_fee=0), so G4 boundaries are
  tested on dedicated fixtures instead.
- G10 bad-case trick: single fee record with quote_usd = truth*0.8 makes drift
  == that record's own usd_ratio_raw (0.9945), so adj = 0.804 > 15% gate.
- A formatter (black-style) reflows this repo's files after edits — anchor
  Edit oldString on post-format text, not on what you originally wrote.
- write_report prints the whole report (spec-mandated) — GREEN log contains
  the full report text; PASS-grep still works.
- Evidence appended (>> only): .omo/evidence/task-5-nansen-groundtruth-parity.txt
  (28172 bytes, part 1 intact).
- md5 after part 2: nansen_parity.py caa5b597cf2ffe31736ff57ffe555ae9 (911 lines),
  test_nansen_parity.py 963247939773b31bb2b3f4f9dc3c5a7c (982 lines).

## [2026-09-22T09:47:28Z] T4 + T5 VERIFIED (orchestrator)
- T4 wallet_watch.py md5 e57b910f0677e196f8158ee8de5df034; 16/16 fee-leg + 8 legacy suites EXIT=0; ruleA keeps FileNotFoundError. (b) re-derived B1 (rd=POOL rejected).
- T5 nansen_parity.py md5 caa5b597cf2ffe31736ff57ffe555ae9, 911 dong, test 982 dong 46/46 EXIT=0.
- Plan amended: Must-have (b), todo4 mutation(ii), todo5 QA, F2(e), Success#7 -> B1 wording.
- checkbox 4 + 5 => [x]. Plan now 5 [x] / 7 [ ].
- CARRY TO T6 (do not re-open): TRANSFER_FALSE_POSITIVE test uses literal events not ca-filtered evs; C2 (1bPapYy2) is TFP either way, no gate affected.

## Todo 6 (IO layer) — 2026-09-22
- TDD held: 10 T6 tests appended FIRST → RED 47/56 (9 fail AttributeError — correct
  reason; fixtures-root-level test passed pre-impl since it only reads disk) → impl →
  GREEN 56/56 EXIT=0. LSP 0 errors both files.
- detect_swaps IS network-free by construction (wallet_watch.py:981 "Không network"):
  _dsym → _info.get → _sym hardcode fallback; _quote_px hardcodes USDC/USDT=1.0,
  WSOL=_sol_px, else _info.get. The REAL network-leak vectors for parity are
  capture_prices misses (token_info/DexScreener) and empty _sol_px — not the detector.
- prices.json (36 mints incl WSOL+USDC, sol_usd 116.62) built with exactly 1 network
  call: pre-seed ww._info from prices22.json (todo-2 snapshot) → capture_prices only
  fetched missing USDC. Universe of all 24 fixtures = 36 mints; prices22 covered 35.
- capture_prices snapshot MUST be written from ww._info (trace22 semantics), not from
  the incoming snap dict — first impl merged only fetched mints and silently dropped
  35 pre-seeded entries (caught by n_prices=2 assertion before smoke).
- basedpyright: assignment to module attrs (`np_.X = …`) errors reportAttributeAccessIssue
  on ModuleType even when X exists at runtime; reads are fine. Monkeypatch via
  setattr/getattr in tests.
- Smoke (5 sigs, all cached): network calls: 0, 5 records — 4 MATCH + 1
  TRANSFER_FALSE_POSITIVE (1bPapYy2 = C2 oracle divergence, reject_trace non-empty
  from PAIR/STEP lines so classify's TRACE_REQUIRED raise never fires).
- wallet_watch.py md5 unchanged e57b910f0677e196f8158ee8de5df034; top-level
  .probe/nansen-parity/{parity.jsonl,report.md} still absent (todo 8 owns them);
  all 8 baseline suites green, ruleA keeps FileNotFoundError by design.
- Evidence: .omo/evidence/task-6-nansen-groundtruth-parity.txt
- md5 after: nansen_parity.py (1238 lines), test_nansen_parity.py (56 tests) — see evidence.

## Todo 6 FIX round — 2026-09-22
- `--seed` collision fixed: snapshot path flag renamed `--prices`; `--seed` is now
  `type=int default=None` (RNG). Todo 7's literal `--limit 20 --seed 42` works:
  select_sigs(pop, limit=17, seed=42) verified set-equal to
  random.Random(42).sample(sorted(pop), 17). Local Random only; global state untouched
  (asserted via random.getstate() before/after in test).
- `--sigs` tokens are now PREFIXES (superset of exact match — full sig is its own
  prefix). Reason: verifier's mandated smoke command uses prefixes; exact-only would
  select 0 sigs and clobber smoke/parity.jsonl with 0 records. Full-sig behaviour
  proved unchanged by test (select_sigs(pop, sigs=["sig001","sig010"])).
- PostToolUse verify hook runs ruff on py edits and RECREATES .ruff_cache after every
  deletion — delete it as the LAST step after all py edits (md/txt appends don't trigger).
- Formatter-reflowed file strikes again (T5 learning): python .replace() patch scripts
  must re-read the CURRENT text; assert-on-old-text saved me from a silent no-op patch
  (assert failed → file unwritten → visible, vs partial mutation).
- Final: 59/59 tests EXIT=0, fee_leg 16/16 EXIT=0, smoke (prefix cmd) EXIT=0 +
  `network calls: 0` + 5 records (4 MATCH + 1 TFP), missing-truth EXIT=2, LSP 0 errors.
- md5 after fix: nansen_parity.py / test_nansen_parity.py — see evidence FIX section.
## [2026-09-22T10:25:01Z] T6 VERIFIED after 1 reject
- Blocker fixed: --seed was price-snapshot path (plan T7 :180 needs RNG seed 42) -> --seed=int RNG, --prices=snapshot path; select_sigs seeded mode.
- .ruff_cache/ scope violation deleted.
- md5 nansen_parity.py 19276f573cf81f204a0b37f4f4994373 (1298 ln), test 6f1f660b6079f00846d9f569d7cef3ac (1323 ln), 59/59 tests.
- CARRY TO T7: --sigs matches by PREFIX; with --sigs given, --seed is ignored -> to get exactly 17 sampled + 3 fixture sigs, pass all 20 via --sigs.

## Todo 7 (dry-run 20 sig) — 2026-09-22
- 20-sig set: random.Random(42).sample(sorted(pop733),17) + 3 fixture sigs, overlap empty, union 20; passed as FULL sigs via --sigs (prefix-safe) + --limit 20.
- Expected groups for the 20 = 21 (RxrDxxL2 has 2 ca groups) — parity.jsonl 21 lines == independent count 21.
- UNAVAILABLE 0/20 = 0% ⇒ hard stop NOT fired; todo 8 unblocked. network calls run1=28 (17 new tx + ~11 price), run2=0, diff byte-identical (md5 4e780d529d5d15552aa349e38356b613).
- Failure QA (delete 3eNZ8cUN cache → rerun): network calls: 1, record unchanged, full file identical — refetch stable, no pruning divergence.
- Gates: G1 False (1 TYPE_MISMATCH = RxrDxxL2/3ZLekZYq ev sell:2 vs truth sell:1, sell_fee:0 ⇒ 0.50% leg NOT promoted, guard held); G7 False 11/13; G9 False (max_raw 5.23); G4/G6/G10/G12 True; G13 not measured in-run (suites green separately: 59/59 + 16/16).
- Same-ca landed: only fixture 48Y3e48T (1 of 9): fee SELL present, fee_usd_ratios=[1.0542] (quote_usd non-null), net_owner_delta=0.0 <1e-6.
- Non-MATCH traces are all `not_spl` rejects; mismatch comes from comparator (USD/AMOUNT/TYPE), recorded as signals — detector untouched, nansen_parity.py md5 19276f573cf81f204a0b37f4f4994373 unchanged.
- prices.json grew 36→48 mints cache-first (sol_usd 116.62); fixtures 25→42.
- Evidence: .omo/evidence/task-7-nansen-groundtruth-parity.txt
## [2026-09-22T10:36:11Z] T7 VERIFIED
- 20 sig = Random(42).sample(pop733,17) + 3 fixture sigs; 21 groups/21 lines; UNAVAILABLE 0%; hard stop NOT fired.
- md5 dryrun/parity.jsonl 4e780d529d5d15552aa349e38356b613 (deterministic across 2 runs).
- Gates: only G1/G7/G9 False, all traced to the 5 non-MATCH records (3 USD_MISMATCH, 2 AMOUNT_MISMATCH net_rel 0.03, 1 TYPE_MISMATCH 3ZLekZYq). G13 None.
- CARRY TO T8: G13 needs the oracle (gmgn 29/29 + backtest 29/29 + 3fec2kXP==2) or it stays None and F1 cannot assert 13 gates. Do NOT fix the detector; root-cause 100% of non-MATCH.

## T8 verdict (2026-09-22, tail completion)
- T8 COMPLETE. Full-run artifacts final: parity.jsonl md5 84943fb665e145e03ac384b0ba8e7956 (743 rows, 24 fields, 0 dup keys), report.md md5 e3e50e687cfc80f73ba068854e025410 (251 root-cause entries = 100% non-MATCH). Both UNCHANGED after session.
- Gates: G4/G6/G12/G13 True; G1(50)/G2(24)/G3(36)/G5(6/8)/G7(409/489)/G8(476/498)/G9/G10(8/9)/G11(11v13) False — all root-caused, no threshold touched.
- G13 True nhờ `--oracle` flag: gmgn_ok=True backtest_ok=True 3fec2kXP=2 (EXPECT_COUNT untouched).
- G11 gap 2 explained: 2 usd-null groups (4184uVCQPTEi/GvFe6EjS, 4o7ZDdK2NRsy/4UnNG97k) FINAL class AMOUNT_MISMATCH — precedence swallows DEFERRED_USD_NULL when type+amount fail. Precedence artifact, not lost deferral.
- G5 6/8: 5AFpPgjmDNA8 + 5WxwFDpxtHBG missing SELL side — sold-mint legs killed by Jupiter aggregator_frame/no_pool_endpoint designed rejects; same coverage-gap family as G3.
- Determinism probe (24-sig subset, network calls: 0): 10/24 rows fully byte-identical, 14/24 differ ONLY in usd_ratio_adj = raw/median(run-set) — set-size normalization, recomputed exactly (<1e-12, subset drift 1.0109448365). usd_ratio_raw identical 24/24. VERDICT IDENTICAL. Log: .probe/nansen-parity/t8-determinism.log.
- Suites: 59/59 + 16/16 + 29/29 + 29/29 green; ruleA_real_regress exit 1 by design (missing /opt/wallet-watch/wallet_watch.py).
- Audit whitelist clean except server/.env (mtime 12:45:35, out-of-band — NOT T8; harness never writes server/). Flagged for orchestrator.
- Evidence: .probe/EVIDENCE-2026-09-22-nansen-groundtruth-parity.md + .omo/evidence/task-8-nansen-groundtruth-parity.txt. .ruff_cache removed.

## F4 fix — G11 gap-2 root cause in report.md (2026-09-22)
- F4 rejected because Phase-2 `### DEFERRED_USD_NULL` listed only the 11 class==DEFERRED sigs; the 2 truth usd-null groups outranked by AMOUNT_MISMATCH were invisible → G11 `False deferred=11 truth_null=13` looked unexplained.
- Fix was generator-level: `_phase2_lines` now iterates ALL `notes.usd_null is True` groups, annotating non-deferred ones `OUTRANKED by <class> (CLASS_PRECEDENCE)`, plus closing sum sentence `n_def deferred + n_outranked = N truth usd-null, no deferral lost`.
- KEY INSIGHT: CLASS_PRECEDENCE means a group failing BOTH usd-null AND type/amount gates lands in the type/amount class, so DEFERRED count (11) < truth usd-null count (13) is EXPECTED — no deferral lost. G11 is a precedence artifact, not a harness bug.
- report.md REGENERATED via harness CLI (`--oracle '{"gmgn_ok":true,"backtest_ok":true,"fec2kxp_events":2}'`, warm cache → `network calls: 0`), NEVER hand-edited. parity.jsonl stayed byte-identical (84943fb6…, 743 lines) proving detection logic untouched.
- Suites green post-fix: nansen_parity 59/59, fee_leg 16/16, gmgn 29/29, backtest --from-fixture 29/29. test_write_report_sections asserts headers only → no test update needed.
- New report.md md5 6a913c172e5a8ab019de800864a386d6 (2797 lines); nansen_parity.py 48616981ef06e4987ff1178903e126e0 (1710 lines).
