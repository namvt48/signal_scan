# Evidence: gmgn-parity-fixes — plan APPROVED (Momus round 4)

**Date:** 2026-09-15 · **Planner:** Prometheus (read-only; no production edits) · **Gate:** `status: approved` in `.omo/drafts/gmgn-parity-fixes.md`
**Plan:** `.omo/plans/gmgn-parity-fixes.md` (v4, 367 lines) · **Reviewer session:** `ses_f5bf4477effefC8ZuZVogOV2pH` (Momus – Plan Critic)
**Constraint honored:** GMGN API never called — oracle is the offline fixture `.omo/drafts/gmgn-parity-fixes-fixture/gmgn_rows_fixture.json` (29 rows / 9 sigs / 12 tx JSONs, frozen).

## Verdict

`APPROVE` — 0 blocker, 2 non-blocking nits (both applied to the plan in this session).

Review history: round 1 REJECT (3 blockers) → v2; round 2 REJECT (MB1/MB2/MB3 + 4 notes) → v3; round 3 REJECT (1 blocker + 6 nits) → v4; round 4 APPROVE.

## Numbers measured independently this round (Momus re-measured, not trusting planner)

| Claim | Measured | Status |
|---|---|---|
| base/quote via tiered BFS rank vs 29 oracle pairs | 29/29 exact | ✓ |
| `quote_inferred == True` count | **1** (only `58pWphuG`, OS↔CARDS both rank 1.0; OS lex < CARDS, both 44 ch) | ✓ blocker from round 3 closed (v3 said 3) |
| `base == OS` on all 3 OS↔CARDS rows | 3/3 | ✓ (`3nzGD2WV`/`3BbWVS3K`: rank OS 2.0 > CARDS 1.0 ⇒ no flag) |
| TIER_A-only baseline | 25/29 (v3's 24/29 was wrong) | ✓ |
| Round-3 nit #2 (delta `151.32806600000004` "not reproducible") | **RETRACTED by reviewer**: positional `zip` of `pre/postTokenBalances` = 0 hits; by `accountIndex` 29 → `3BbWVS3K` raw `151328066`, `3nzGD2WV` raw `450798346`; `len_pre=15` vs `len_post=16` (ATA opened mid-tx) | ✓ F32 upheld; §3 Bước 5 + F28 stand |
| All 8 Bước-5 raw deltas under `accountIndex` pairing | CARDS `6407891356`/`20291655959`/`26699547315`, ORE `954606921880`, XBT `99683568257`/`619015554003`, USDC `450798346`/`151328066` | ✓ no per-row fee signal exists ⇒ `amount_basis="gross_leg"` constant (D18) |
| OS raw artifact | `11033477248449751` present 3× in `58pWphuG.json`; `…752` 0×, `…750` 0× ⇒ 1 raw unit at dec 9, rel `9.063e-17` (plan says 9.1e-17) | ✓ no transcription typo (D17 clean) |
| Mutation-test raws | `638160364952` 1×, `102766565214` 1×, both in `33hqSn4Q.json` | ✓ T9 mutation #4 valid |
| D19 denominator | gross: `0.0775` → `7.7500%`; oracle: `0.0775/0.9225 = 8.40108…%` > 8% ⇒ false fail on correct code | ✓ formula pinned in T8 (L281) |
| ORE stored artifact | stored string `9.46722534902` vs emitted `9.467225349019857` → rel `1.5e-14` | ✓ §2.2 intro softened |
| Six fee-row overstates (gross denominator) | 0.2025 / 7.7500 / 0.8259 / 4.8524 / 0.2018 / 0.2401 % — all ≤ 8% | ✓ ORE recomputed: `(9.5460692188−9.467225349)/9.5460692188 = 0.8259%` exact |
| §2.3 oracle table vs fixture | multiset-equal over 29 rows = True; per-sig counts match; `G` markers = 6; exact/gross split 23/6 | ✓ |
| Fixture shape frozen | root keys 12/12; `result` 0; `loadedAddresses` 0; `programIdIndex` 0/67 top-level & 0/347 incl. inner; 9 sigs; 3 duplicate pairs byte-identical (sha8 `58562576`/`55fe63dc`/`c335708d`); rows root `{source,caveat,tx_key,rows}`; `tx_hash` 29/29 (no `sig`); `event_type` 29/29 (no `side`); `token.decimals` 0/29 vs `quote_token.decimals` 29/29 | ✓ plan §2.5 anchors T1/T8 executable |
| Legacy `amount_includes_lp_fee` | exactly 1 occurrence (changelog L15 only) | ✓ MB1 closed |

## Nits applied post-approval

1. Plan L3: `D1–D18` → `D1–D19`; status → `**APPROVED** (v4 — Momus round 4…)`.
2. Plan §2.2 intro: dropped "khớp tới chữ số cuối" → `~1e-14` + artifact note (F31b).

## Owner locks (unchanged through all rounds, must not be re-litigated by the worker)

- **D14/D18:** fee-charged steps emit GROSS; constant field `amount_basis="gross_leg"` on every event; no per-DEX fee decode; no per-row fee flag; `amount_basis` must never be derived from the `G` marker, `dex_native`, `launchpad`, or `price` (test-oracle-only data).
- **D19:** `rel_overstate = (emitted − oracle) / emitted`; gate tolerances must not be loosened (§5.6).
- **D15/D16:** rank BFS rule for base/quote (launchpad labels forbidden); side by POOL-endpoint leg direction (wallet-anchor rule is inferior: 18/29).
- **D17:** no hand-typed mint/address/WALLET literals in code or tests — build from fixture (precedent: F25, F29).
- Gate: 29/29 side + base/quote + step-count; amounts exact rel 1e-6 on 23 rows; 6 fee rows `gross ≥ oracle` && `rel_overstate ≤ 8%`.

## Next step (user action)

Plan is decision-complete for a zero-interview worker run: `/start-work` (tasks T1→T12, evidence to `.omo/evidence/gmgn-parity-fixes/`, deploy target `root@194.163.187.250:/opt/wallet-watch/` at T11).
