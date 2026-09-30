# Request-plane gateway — dual review receipt (round 9, APPROVED)

- Date: 2026-09-30
- Plan: `.omo/plans/request-plane-gateway.md`
- Live sha256 (re-validated after both lanes returned): `d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000` (300 lines)
- Round id: `rpg-20260930T090706Z`
- Outcome: **APPROVED — both lanes `VERDICT: OKAY`**, each echoing `Verified sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000`.

## Round-9 lanes

| lane | launch_id | session | verdict |
|---|---|---|---|
| momus | `bg_c951bff6` | `ses_f0e6e87e4ffeWAvFdFfN6emJFA` | OKAY |
| oracle (independent) | `bg_9dbe1815` | `ses_f0e6e7645ffe5d22xhdo1XC7xU` | OKAY |

Raw oracle output: `/home/namvt/.local/share/opencode/tool-output/tool_0f19430a4001D7LZIJdhJtWOGT`.

## Round-8 findings re-derived, all RESOLVED

1. (BLOCKER) `GATEWAY_URL`-unset semantics — one predicate now pinned everywhere: `gatewayUrl = str('GATEWAY_URL','')` (empty ⇒ disabled), client built iff non-empty, no TS loopback default (loopback only in Python todo 16). Todos 14 / 21 / commit-strategy agree.
2. (BLOCKER) free-door cutover site — todo 13 edit list names `index.ts:11` + `:35` and pins the three free-door URLs (`nansen.ts:47-49`); todo 10 reworded to cite `nansenSeries` (`crawl.ts:907`).
3. (cosmetic) `shm_size: 2g` matches `docker-compose.yml:40`.
4. (cosmetic) dependency-matrix asymmetry — fixed in the matrix rows; per-todo `Blocks:` lines still carry transitive-only extras (cosmetic, non-blocking).
5. (cosmetic) watcher ordering — 16 → 18 → 17 (fail-open before env wiring); gateway deploys at 21.
6. (notes) `nansen.ts:276` dead-cite removed; GMGN constructor strategy reconciled; `limiter.ts:58-59` gate rejection mapped to `503 {error:"gated"}`.

## Non-blocking notes carried forward (do NOT block execution)

1. Per-todo `Blocks:` lines (todo 6 lists 19; todo 13 lists 15) are transitive-only vs the matrix — harmless.
2. todo 10 cites `realConnect (:842)`; actual call site is `crawl.ts:857` (def `:708`).
3. Credit + DexScreener gateway route `endpoint` names are not pinned (only free-door mapping + `gmgn/token-info`); contract allows arbitrary ids, verified end-to-end by todo 12/22.
4. todo 2 `/health` asks for DoorPool stats but DoorPool relocates in todo 10 — forward reference; todo 2 acceptance only checks `{ok:true}`.

## Review history (9 rounds)

r1 BOTH CHANGES_REQUESTED · r2 momus OKAY / oracle 6 · r3 momus OKAY / oracle 9 (1 blocker) · r4 momus OKAY / oracle N1–N10 · r5 BOTH · r6 BOTH · r7 momus OKAY / oracle N1–N6 · r8 momus OKAY / oracle 2 blockers + 3 cosmetic (folded) · **r9 BOTH OKAY**.
