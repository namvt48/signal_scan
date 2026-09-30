# F1 — Plan compliance audit (request-plane-gateway)

Plan: `.omo/plans/request-plane-gateway.md`
Auditor: orchestrator (direct read of every artifact; no code edited, no tests re-run — F3 owns live proofs).
Date: 2026-09-30 (Asia/Ho_Chi_Minh)
Range: `git log --oneline 639cdaa^..HEAD` → 21 commits, HEAD `d5c5beb`.

## Method

- Confirmed every plan checkbox 1..22 is `[x]` (plan lines 91,99,107,115,123,131,141,149,157,165,173,181,191,199,207,215,223,231,241,249,257,265).
- Read the acceptance-criteria block for every todo.
- Read all 22 evidence files in full at `.omo/evidence/request-plane-gateway/task-<N>-request-plane-gateway.md` and checked: file exists, contains the command(s) + verbatim output, acceptance criteria observably proven, and ends with `EVIDENCE_RECORDED:`.
- Confirmed `git status --short` shows no stray code changes (only untracked `.omo/` session artifacts).

## Per-todo compliance

| Todo | Criteria met? | One-line proof | Evidence file | Ends w/ EVIDENCE_RECORDED? |
|---|---|---|---|---|
| 1 Gateway entrypoint + build | Y | `tsc`=0; `gateway:build`→`dist/gateway/main.js`; `npm test` runs gateway smoke (temp-fail→exit 1 then reverted); boot logs line + clean SIGTERM; bad port exit 1 | Y | Y |
| 2 HTTP + per-caller auth + /health | Y | `/health`=200 `{ok:true}`; `/v1/x`=401; token A→`a`, B→`b` (auth.test.ts); `/metrics` unauth 401 | Y | Y |
| 3 Raw-payload contract | Y | contract.test.ts: raw body byte-identical, 4-header allowlist propagates, off-allowlist dropped, priority reaches limiter, 429 rides inside 200 | Y | Y |
| 4 Gateway compose project | Y | `docker compose config` exit 0: external net, `127.0.0.1:8130`, `gateway-chrome`, proxy mount; failure case (drop `external`) shown | Y | Y |
| 5 Shared-net membership + Makefile | Y | config: api on BOTH `default`+`signal-scan-gateway`; `make -n deploy` has gateway file; `-n up`/`-n gateway-up` print guard; `make status` unchanged | Y | Y |
| 6 Gateway env config | Y | defaults/overrides incl. `GMGN_PLAN_WEIGHT`+`RL_*`→buildSpecs; gateway boot w/o token exit 1; api boots w/ only caller token | Y | Y |
| 7 Nansen credit behind limiter (both seams) | Y | each route 1 upstream call; 429+`x-ratelimit-reset` propagated; 2nd concurrent credit call QUEUED not dropped | Y | Y |
| 8 GMGN weight bucket, never cached | Y | weight-1 consumes; empty bucket DELAYS (200); 2 identical→2 upstream; 403 arms gate (next=503) | Y | Y |
| 9 DexScreener per-class windows | Y | tokens 300 pass/#301 waits; profiles 60/#61 waits; raw body; literal `dexscreener` key survives; both old specs pass | Y | Y |
| 10 DoorPool relocation + door-stats | Y | door.test: budget counted, quarantined skipped 503, /health stats, DB-free grep, a `/api/health` fed+degrades; 9 door tests pass | Y | Y |
| 11 Selective TTL cache + single-flight | Y | cache.test (a)-(k) all pass: same-caller credit collapse, per-caller credit key, GMGN/flows excluded, hit short-circuits pre-flight | Y | Y |
| 12 Wave-2 integration | Y | integration.test: 1 call cross-caller DexScreener / same-caller Nansen info; 2 for cross-caller credit + GMGN; 429 propagation | Y | Y |
| 13 TS transports → gateway | Y | `tsc`=0; named test changes done (URL→gateway envelope); only `solana.ts:202` local limiter remains; npm test green | Y | Y |
| 14 TS config/wiring GATEWAY_URL | Y | predicate `gatewayUrl!==''`; URL set+no keys→nansen+gmgn constructed; unset→legacy (key→client, no key→null); 3 boot cases | Y | Y |
| 15 TS fail-open | Y | unreachable→sweep completes+warn; envelope.status 400→typed error; budget 429→typed error, fetch calls=1 | Y | Y |
| 16 Python client + price.py | Y | `python3 scripts/test_price_gateway.py` exit 0 (a)-(d); no `_GMGN_GAP_S`/`_GMGN_BAN_S`; emit/rpc/FOMO untouched | Y | Y |
| 17 Host systemd env wiring | Y | `systemctl show` includes gateway var names (both units); restart active; heartbeats advance; watcher token = `watcher` caller | Y | Y |
| 18 Python fail-open | Y | unreachable/malformed body→unknown, no raise; feed loop completes; red→green proving the fixed escape | Y | Y |
| 19 Credit accounting + equal split | Y | (a)-(f): half-cap per side, caller-scoped `budget_exceeded`, other routes live, day reset, gate NOT armed, cache hit=0 credit | Y | Y |
| 20 Metrics endpoint | Y | `/metrics` JSON: all 6 limiter keys + `credits{a,b}` + cache counters; `?format=text`; unauth 401 | Y | Y |
| 21 Deploy gateway + connect a+b | Y | net lists gateway+a-api+b-api; default net intact; both api `getent hosts gateway`+health 200; a `/api/health` 200; web/chrome start times unchanged; rollback cmd recorded | Y | **N — marker ABSENT** |
| 22 End-to-end verification | Y | (a) dedupe/cross-caller-credit/GMGN/flows deltas; (b) split+soft-deny+gate untouched; (c) fail-open a=b=200 w/ gw down; (d1) gateway NAT `194.163.187.250`≠(d2) proxy `167.86.101.228` | Y | Y |

## Findings

1. **BLOCKING — Todo 21 evidence file is missing the required `EVIDENCE_RECORDED:` terminator.**
   `.omo/evidence/request-plane-gateway/task-21-request-plane-gateway.md` (333 lines) ends with a
   blank line; `grep -c 'EVIDENCE_RECORDED'` = **0**. Plan requires every evidence file to end with
   it (plan:46, plan:269, success criterion plan:299) and F1 (plan:275) lists "`EVIDENCE_RECORDED:`
   recorded" as an audit criterion. The file's *content* is complete and every todo-21 acceptance
   criterion is observably proven (see table row 21); only the terminator is absent.
   **Remedy:** append `EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-21-request-plane-gateway.md`
   as the final line, then re-run F1. No content rework required.

2. **Accepted deviation (NOT a failure) — Todo 21 host dir `/opt` → `/root`.**
   Documented in the task-21 evidence (snap-docker cannot bind-mount `/opt`; probe reproduced), with
   the repo compose file pointed at `/root/signal-scan-gateway/`. Host-specific, blocking-only,
   documented with the working alternative. Does not by itself gate the verdict.

3. **Accepted deviation (NOT a failure) — Todo 22 flows/GMGN uncacheable.**
   The plan's literal "flows ⇒ misses +2" is not measurable because uncacheable requests bypass the
   cache counters; the implementation gives the STRICTER guarantee "never cached/collapsed"
   (`cache.ts:85,91`; unit test f + `cache.size()===0`). GMGN's live 429 blocked a live 2xx pair;
   uncacheability is proven by unit test (e) + `classifyRequest` returning `null`. Documented.

4. **No todo silently skipped.** All 22 checkboxes `[x]`, all 22 evidence files present and
   non-blank, each containing the exact command(s) and verbatim output.

5. **No secrets observed.** Evidence references env-file paths and variable names only; the one
   JSON artifact is a metrics snapshot; IPs recorded are public/host IPs.

## Verdict

All 22 todos meet their acceptance criteria and carry substantive evidence. Single blocker:
todo 21's evidence file does not end with the mandated `EVIDENCE_RECORDED:` terminator (finding 1).
That explicit, machine-checkable criterion (plan:275, plan:299) is unmet → F1 cannot pass as-is.
The fix is a one-line append followed by re-verification.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/f1-plan-compliance.md
REJECT
