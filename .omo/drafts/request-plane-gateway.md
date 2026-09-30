---
slug: request-plane-gateway
status: drafting
intent: clear
review_required: true
plan_path: .omo/plans/request-plane-gateway.md
plan_sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
review_round_id: rpg-20260930T090706Z
pending-action: none - round 9 approved by both lanes (momus + oracle OKAY); execute via $start-work
review:
  momus:
    status: pending
    workspace_root: null
    runtime_home: null
    target: .omo/plans/request-plane-gateway.md
    round_id: rpg-20260930T080556Z
    plan_sha256: 6efe6f6bb20bc0a32e6acadc937e804ddebaa07989b51bbc018778f37ccdaf9a
    launch_id: "208813847"
    session: ses_f0ea675c9ffeogoblpRw7rvWxu
    result: CHANGES_REQUESTED
  independent:
    status: pending
    workspace_root: null
    runtime_home: null
    target: .omo/plans/request-plane-gateway.md
    round_id: rpg-20260930T080556Z
    plan_sha256: 6efe6f6bb20bc0a32e6acadc937e804ddebaa07989b51bbc018778f37ccdaf9a
    launch_id: "2729730862"
    session: ses_f0ea666d7ffefDcEUu5YumDim8
    result: CHANGES_REQUESTED
approach: Extract a single-writer "request-plane" outbound gateway service that owns the scarce/shared request/response providers (Nansen credit API, Nansen free browser door, GMGN, DexScreener; RPC-over-HTTP optional) and returns RAW provider payloads; instances a and b keep their business logic and DBs and call the gateway over the internal network. Stream plane (Solana/EVM WS, FOMO WSS) stays in-process per instance. Reuse the existing server/src/ratelimit/ module and crawl.ts DoorPool rather than writing new limiters.
review_model: ai-box/qwen3.8-max-0902  # user-specified reviewer model for the high-accuracy review
---

# Draft: request-plane-gateway

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

| id | outcome (one line) | status |
|---|---|---|
| C1 gateway-service | One single-writer service owns every shared req/resp upstream (Nansen credit, Nansen browser door, GMGN, DexScreener) and returns RAW provider payloads | active |
| C2 ts-adapter | server a+b route each provider call through the gateway instead of calling upstream directly (replace provider injection) | active |
| C3 py-adapter | watchers (sol/evm/fomo) route GMGN/DexScreener egress through the gateway | active |
| C4 budget-policy | Nansen credit reserve for a + cap for b; all per-provider limits single-writer | active |
| C5 deploy-topology | compose network + Makefile so both instances resolve and reach the gateway | active |
| C6 observability-failopen | /health, per-provider metrics, degrade-not-block, no-lost-requests | active |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| Implementation language | TypeScript; new service reuses `server/src/ratelimit/` + `crawl.ts` DoorPool | limiter + door pool already exist in TS; a rewrite is pure cost | hard (new service) |
| Stream plane | Solana/EVM WS + FOMO WSS stay in-process per instance | each instance needs its own live subscription; measured per-account/per-instance | yes |
| Gateway payload | Raw upstream pass-through | keeps business logic + DB inside a/b | yes |
| RPC-over-HTTP | NOT in v1 (leave solana-rpc / evm-rpc local) | latency-sensitive + already paced per-instance; revisit if shared pressure appears | yes |
| Nansen free browser door | gateway is sole writer with a conservative internal budget | upstream publishes NO quota; Nansen ToS forbids circumvention | yes |
| Fail mode | instances degrade (serve cached/stale), never block writes | availability > strictness | yes |

## Findings (cited - path:lines)

**Rate-control module (reuse target)**
- `server/src/ratelimit/index.ts:5` — `limiters = new LimiterRegistry(buildSpecs(config.gmgnPlanWeight))`; specs `spec.ts:10-53`: `gmgn`, `solana-rpc`, `nansen-credit`, `nansen-door` (**spec'd + tested, ZERO prod call sites**), `dexscreener`.
- 4 prod call sites only: `providers/solana.ts:202`, `providers/nansen.ts:360`, `providers/gmgn.ts:171`, `providers/dexscreener.ts:118`; health snapshot `api.ts:474`.
- `ratelimit/types.ts:62` `HttpError(status, header, message)`; `log.ts:140` `timed(label, fields, fn)`.
- Door budget lives OUTSIDE the registry: `crawl.ts:425-426` uses `config.crawlPathBudget`(30)/`crawlDoorCapPerMin`(40).

**Injection seam (TS)**
- poller depends on 2 interfaces only: `MarketDataProvider` (`providers/provider.ts`) + `TokenFlowsClient` (`providers/nansen.ts:323-325`); wired at `poller.ts:1041` (`startPoller`) + `poller.ts:878` (`setPollerDeps`).
- Construction `index.ts:29-46`; mode gating `config.ts:27-32`; `NANSEN_API_KEY`/`GMGN_API_KEY` null-gate; `NANSEN_CRAWL` gate `config.ts:159`.
- Cadence: metric essential 1h/5m, volume 15m, gini 1h; `tokenInfo` on CA add; `assetInfo` 5m; `walletTokenHoldings` 15m; `tokenFlows` 1h/12h. HTTP triggers `api.ts:533,563,669,735,781`; no GET triggers provider.
- DEAD / never wire: `nansen.ts:419` dexTrades, `nansen.ts:433` currentBalance, `nansen.ts:266` balanceExtremes (class never built), `crawl.ts:906` nansenSeries, `crawl.ts:923` balanceSeries, `detail.ts:53` buildTokenDetail.

**Python choke points**
- `watchers/common/config.py:97` `http_json(url,payload,timeout,headers)` = single transport; `:207` `rpc()` round-robin; `:38-41` Solana RPC defaults; `:64` `_api_url` default `http://127.0.0.1:8124`.
- `watchers/common/price.py:31,61-76` GMGN (`X-APIKEY`, t=10); `:158-160` DexScreener (t=15, default source).
- `watchers/common/emit.py` POSTs to OUR api (`/api/tracked-cas`, `/api/wallet-watch/trades`) = internal, NOT gateway scope. `watchers/evm/feed.py:24-29` EVM RPC defaults; `watchers/fomo/feed.py:39` WSS + `:99/:205` own api.
- Watchers are NOT in docker-compose; host systemd `/opt/wallet-watch`, `/opt/fomo-watch`.

**Deploy topology**
- `docker-compose.yml` = 3 services (`chrome`,`api`,`web`); **NO `networks:` key** → separate default nets `signal_scan_default` vs `signal_scan_b_default` (a and b cannot resolve each other today).
- a: `BIND=127.0.0.1 PORT=8124` behind host Caddy `signal-scan.duckdns.org`; b: `BIND=0.0.0.0 PORT=8125`, no Caddy (`Makefile:53-68`).
- b override is HOST-ONLY `/root/signal_scan_b/docker-compose.override.yml` (NANSEN_CRAWL off) — not in repo.
- `Makefile:84` `FILES` list: a new root file will NOT deploy unless added; rsync line 94 ships `server src` only.

**Upstream limits (docs / measured)**
- Nansen API per-key: Free 15/s · 300/min; Pro 75/s · 1500/min. Credits: `tgm/token-information`=1, `tgm/flows`=1, `tgm/holders`=5 (150 with premium_labels), web-search=5 / web-fetch=20. Free = 10-credit daily floor; Pro = 2000-credit monthly top-up; $10/10k credits.
- Nansen `app.nansen.ai/api/questions/*` (free browser door): NOT documented, no published quota, ToS forbids indirect/circumventing use.
- GMGN `openapi.gmgn.ai`: leaky bucket `rate=10 cap=10` (track routes 20/20, weights 1-3) **+ IP allowlist** (403 `AUTH_IP_BLOCKED`); `docs.gmgn.ai` also states "1 request/second".
- DexScreener: 60/min (profiles group) and 300/min (pairs/tokens/search); no API key; per-IP scope NOT officially stated.

## Decisions (with rationale)
1. Gateway = request plane only; streams stay local (measured: FOMO WS is per-account; RPC WS per-instance).
2. Gateway returns raw provider payloads; a/b keep business logic + DB (avoids re-implementing logic in a new service).
3. Reuse `server/src/ratelimit/` + `crawl.ts` DoorPool as the single writer (module exists; DoorPool is single-process by design; Redis would force a distributed rewrite).
4. v1 scope = Nansen credit + Nansen door + GMGN + DexScreener; RPC-over-HTTP deferred.
5. Nansen credits are the only real money budget → SPLIT EQUALLY between caller `a` and caller `b` (user decision 2026-09-30; SUPERSEDES the earlier "a reserve / b cap" wording in C4 above). Over-half = soft-deny for that caller only. Budget is env-configurable; the tier is not yet known so the default is conservative.
6. Callers are identified by SEPARATE bearer tokens (`a` vs `b`), because one shared token cannot attribute credit use (Metis C2).
7. Cache + single-flight apply to endpoints with DETERMINISTIC params only: Nansen `token-information`/`holders` + DexScreener tokens/pairs/search; GMGN is excluded (fresh client_id/timestamp per call, Metis C4); time-windowed Nansen flows are excluded from dedupe (moving `from`/`to`, keys never collide). For CREDIT-bearing Nansen endpoints the cache/single-flight KEY INCLUDES THE CALLER (cross-caller share impossible, split stays exact); cross-caller sharing is for non-credit endpoints only. Any joiner pays 0; request order = auth -> cache -> budget pre-flight -> limiter -> upstream.
8. The DoorPool's own budgets govern the browser door; the never-wired `nansen-door` limiter stays unwired to avoid double-governing (Metis M4).
9. Fail-open means "warn + skip the sweep" (the instance's own DB is unaffected); it does NOT mean a cross-process stale cache (Metis C3).

## Scope IN
- New gateway service container + shared network; a, b and watchers call it.
- Centralize `gmgn` / `nansen-credit` / `nansen-door` / `dexscreener` limiters + the DoorPool.
- Raw-payload HTTP contract, `/health` + per-provider metrics, configurable-TTL cache.
- Nansen credit reserve(a)/cap(b) policy.
- Makefile/compose deploy wiring for both instances.

## Scope OUT (Must NOT have)
- No stream/WS proxying (Solana, EVM, FOMO WSS stay in-process).
- No business logic, no DB writes, no FE changes inside the gateway.
- Do NOT alter instance a's runtime beyond adding it as a gateway client; no restart of unrelated a services.
- No second limiter implementation; no new dependency without justification.
- No RPC-over-HTTP in v1 (deferred).

## Open questions
- Q1 network topology (blocks the whole "shared" premise).
- Q2 v1 scope: RPC-over-HTTP in or out.
- Q3 Nansen budget policy + plan tier.
- Q4 test strategy.

## Approval gate
status: approved
<!-- Approved 2026-09-30 (user answered all 4 forks). Plan written, Metis gap analysis folded. Dual high-accuracy review dispatched. Reviewer model requested by user: ai-box/qwen3.8-max-0902. -->
<!-- This durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

## Review round
phase: review_round_9_approved
review_required: true
plan_path: .omo/plans/request-plane-gateway.md
plan_sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
review_round_id: rpg-20260930T090706Z
round_status: approved
pending-action: none - round 9 approved by both lanes (momus + oracle OKAY); execute via $start-work
round_1:
  round_id: rpg-20260930T080556Z
  plan_sha256: 6efe6f6bb20bc0a32e6acadc937e804ddebaa07989b51bbc018778f37ccdaf9a
  verdict: BOTH CHANGES_REQUESTED
  fail_backup: /tmp/opencode/rpg-round1.md
  cited_issues_and_fixes:
    - docker_net_trap: api joining only the external net drops the project default net -> web->api + api->chrome break. FIX todo 5 (api on BOTH nets) + todo 21 verify + todo 4 rename chrome->gateway-chrome.
    - silent_test_skip: npm test globs only test/*.test.ts test/ratelimit/*.test.ts -> test/gateway/* skipped. FIX todo 1 extends the glob.
    - dedupe_ineffective: Nansen flows params to=now differ per call -> never dedupes. FIX todos 11/22 restrict to deterministic endpoints + assert flows NOT deduped.
    - softdeny_arms_gate: budget 429 inside limiter would arm the shared gate + retry, harming the other caller. FIX todo 19 pre-flight OUTSIDE limiters.run, distinct error, no gate arm, no retry.
    - doormove_drags_db: crawl.ts imports db.js -> gateway would carry better-sqlite3. FIX todo 10 DB-free extraction + api.ts:473 fail-open read.
    - refs: nansen.ts:276 dead -> live door nansen.ts:573,580; "Decisions 3" -> Decisions 3,7. + rollback path + x-nansen-credits-cost allowlist + 403 AUTH_IP_BLOCKED backoff + fail-open wording.
round_2:
  round_id: rpg-20260930T081033Z
  plan_sha256: 9ba4d374c593fd40b2c344da6ba2a6f486aeffa85863687d0f92df56e245e9fa
  fail_backup: /tmp/opencode/rpg-round2.md
  verdict:
    momus: OKAY (1 non-blocking note: gmgn.ts:200 cite was wrong)
    oracle: CHANGES_REQUESTED (6 findings, 4 execution-failing)
  cited_issues_and_fixes:
    - doormove_breaks_9_tests: test/door-pool.test.ts:20, test/setup-http-e2e.test.ts:42, setup-early-kick:32, setup-rehydrate:16, setup-field-ttl:35, lf-write-once:12, setup-pass-cap:24, setup-sweep-prune:29, setup-retry-until-complete:25 import DoorPool/setPoolForTest from ../src/crawl.js; ESM missing export = SyntaxError -> npm test fails. FIX todo 10 mandates a crawl.ts RE-EXPORT shim + lists the 9 tests + npm test acceptance.
    - dexscreener_key_breaks_tests: spec.test.ts:16 + dexscreener-via-layer.test.ts:6 require literal `dexscreener` key; "two keys" would fail them. FIX todo 9 pins "keep dexscreener key + class dimension".
    - gmgn_gate_status_only: Gate/GateSpec match numeric status only (gate.ts:9-23, types.ts:11-16); cannot gate "403-with-code". FIX todo 8 gates ALL gmgn 403s (documented assumption) and does NOT touch shared Gate/HttpError.
    - external_net_breaks_up: new external net hard-deps every up/deploy. FIX todo 5 adds docker network create guard to the up target too.
    - wrong_nginx_cite: api:8124 -> actual api:3001. FIX todo 5 citation.
    - crosscaller_credit_attribution: undefined who pays on deduped call. FIX todos 11/19: same-caller-only sharing for credit-bearing Nansen calls; cross-caller dedupe non-credit only.
    - minors: evm.ts has no limiters.run (todo 13 solana-only); ledger Decision 7 stale re flows (fixed); todo 4 gateway CRAWL_WS_ENDPOINT must be gateway-chrome:3000; server/Dockerfile.gateway NOT in $(FILES) (server/ rsynced wholesale).
round_3:
  round_id: rpg-20260930T081430Z
  plan_sha256: 3be4f4e872a3f8842258d78383641efa45d87dfa55f937f7a50d442adc5711de
  fail_backup: /tmp/opencode/rpg-round3.md (this file was copied AFTER round-3 fixes so it is the round-4 input, not a pre-fix baseline; the pre-round-3 baseline equals the round-3 sha)
  verdict:
    momus: OKAY
    oracle: CHANGES_REQUESTED (9 findings, 1 blocker)
  cited_issues_and_fixes:
    - crosscaller_nansen_claim (BLOCKER): todos 12 + 22 said cross-caller Nansen/DexScreener dedupe == 1, contradicting todo 11(h) + Scope + Success. FIX: split - cross-caller DexScreener == 1 (non-credit), cross-caller Nansen credit == 2; Scope + Success + todo 22 (a) + todo 11 acceptance rewritten.
    - credit_cache_key_per_caller (HIGH): credit cache/single-flight key must INCLUDE the caller. FIX: todo 11 CREDIT RULE now keys credit by caller (cross-caller share impossible); acceptance (i) cross-caller credit within TTL -> 2 upstream + 2 charges.
    - samecaller_joiner_pays_zero (MED): joiner credit undefined. FIX: todo 11 rule - ANY joiner pays 0; acceptance (j) N same-caller concurrent credit -> 1 upstream, charged exactly 1.
    - cache_vs_budget_order (MED): ordering pinned. FIX: todo 11 REQUEST ORDER auth -> cache -> budget pre-flight -> limiter -> upstream; todo 19 cache-hit note + acceptance (k) over-budget 0-credit cache hit still served.
    - boot_fail_loud_shared_config (MED): shared config.ts throw would crash a/b. FIX: todo 6 - fail-loud lives in gateway/main.ts, config.ts parses with safe defaults; acceptance split (gateway exits != 0; api boots with only its own token).
    - shim_symbol_list (MIN): FIX: todo 10 enumerates DoorPool/setPoolForTest/poolStatsOrNull/browserPostJson + 6 types; note a re-export does not bind locally so nansenSeries re-imports browserPostJson.
    - unused_import_noUnusedLocals (MIN): FIX: todo 10 - remove unused `import { poolStatsOrNull }` at api.ts:46.
    - citation_nits (MIN): FIX: todo 10 (:906 does NOT touch db, only :923; lazy poolSingleton :826/:843-874 note) + todo 5 (nginx.conf:20 set $api_upstream, :21 proxy_pass).
    - dependency_matrix_row11 (MIN): verified FALSE POSITIVE (matrix row 11 already `7,9,22`, matching todo 11 `Blocks: 7,9,22`); no edit needed.
round_4:
  round_id: rpg-20260930T081944Z
  plan_sha256: 5c2f48ca8bd4782c921232117a48ef9dcd095a83ad7d6e732e84c9b93a1d85e6
  fail_backup: /tmp/opencode/rpg-round3.md (round-4 input; not a pre-fix baseline)
  verdict:
    momus: OKAY (non-blocking notes only)
    oracle: CHANGES_REQUESTED (N1-N10; no BLOCKER remaining, no round-3 finding fully re-opened except finding 6 partial)
  cited_issues_and_fixes:
    - N1 credential_custody: gateway must hold NANSEN_API_KEY/GMGN_API_KEY; a/b share ONE Nansen key. FIX todo 6 (config surface + env-file custody) + shared-key statement.
    - N2 rollback_exactness: cutover state must not live in committed compose. FIX todos 14/21 - GATEWAY_URL/GATEWAY_CALLER_TOKEN in host-only server/.env (env_file); one exact rollback command pair.
    - N3 api_door_stats_owner: no todo named api.ts:473. FIX todo 10 - rewrite api.ts:473 to token-authed gateway /health fetch, fail-open.
    - N4 shim_incomplete: explicit list still omitted classify/Classification/parseProxyFile; 241-807 not self-contained. FIX todo 10 - move classify/Classification/parseProxyFile/maskProxyUrl/pathKey/withTimeout/realConnect/buildPage/warm/inPageFetch/BROWSER_FAILURE_PREFIX into door.ts; add classify/Classification/parseProxyFile to shim.
    - N5 raw_vs_error_bodies: non-2xx that arms a gate cannot forward the body. FIX todo 3 explicit statement.
    - N6 header_count: allowlist is four, not three (+ x-nansen-credits-remaining note). FIX todo 3.
    - N7 dep_asymmetry: row 11 Blocks 7,9 vs rows 7/9 Depends 3,6. FIX matrix row 11 -> Depends 3,7,8,9 / Blocks 22; todo 11 header.
    - N8 dexscreener_key_mapping: pin which class keeps the key. FIX todo 9 - `dexscreener`=pairs/tokens/search 300/min, new `dexscreener-profiles`=profiles/boosts 60/min.
    - N9 api_side_var + shared_net_alias: name GATEWAY_URL/GATEWAY_CALLER_TOKEN; `api` alias on shared net benign. FIX todos 14/4.
    - N10 budget_soft_cap: check-then-act overshoot. FIX todo 19 - optimistic soft cap stated.
round_5:
  round_id: rpg-20260930T082455Z
  plan_sha256: 63452ffe6b19bafbe9e80962ec98039236e30a867c30b7db3bf2cd9f44b1e81f
  fail_backup: /tmp/opencode/rpg-round4.md (round-5 input; not a pre-fix baseline)
  verdict:
    momus: CHANGES_REQUESTED (dependency finding M1 + credential-mechanism note + citation drift M4)
    oracle: CHANGES_REQUESTED (F1-F9; N1/N2 not genuinely resolved, N4 partial)
  cited_issues_and_fixes:
    - F1 credential_split_breaks_key_gates (HIGH): removing NANSEN_API_KEY/GMGN_API_KEY nulls the index.ts:29/30 clients -> credit path (index.ts:46 -> poller.ts:880) + GMGN silently vanish; gmgn.ts:129/180 X-APIKEY; price.py:66-69 key guard. FIX todo 6 (mechanism) + todo 14 (rewrite key-gates to gate on GATEWAY_URL) + todo 13 (GMGN built without a key).
    - F2 transport_swap_vs_tests_unchanged (HIGH): todo 13 claimed "existing provider tests unchanged" but nansen.test.ts:410 asserts the upstream URL, :524 subclasses NansenApiClient, :383 exercises creditsSpent. FIX todo 13 acceptance names the exact tests + drops the false claim.
    - F3 rollback_restores_nothing (HIGH): blanking GATEWAY_URL/TOKEN yields fail-open stale, NOT the pre-cutover path (todo 14 unset=loopback default; todo 6 removed keys). FIX todo 21 + commit strategy - rollback = git checkout <pre-todo-13-sha> / redeploy prior image; blank-vars = labelled stop-gap only.
    - F4 doorpool_move_list_incomplete (MED): realConnect deps doorWsEndpoint/UA/TOKEN_GOD_MODE/WARM_POLL_MS omitted -> crawl<->door cycle returns; getPool binds parseProxyFile/new DoorPool/realConnect. FIX todo 10.
    - F5 wire_shape_unpinned (MED): envelope vs mirrored status + budget-429 HTTP status undefined. FIX todo 3 PIN THE WIRE SHAPE (HTTP 200 + {status,body,headers}; gateway denials 401/400/429 + {error}) + todo 15 reconciled.
    - F6 egress_paths_conflated (MED): the ipify probe measures the door/proxy IP, but todo 22(d) checked the GMGN allowlist. FIX todo 22 split (d1) host-NAT vs (d2) door/proxy.
    - F7 local_credit_counter_unspecified (MED): nansen.ts:341-396 creditSpend/creditsSpent consumers poller.ts:401/435/651/659. FIX todo 13 - drop the local counter, repoint the two log lines.
    - F8 health_noauth_egressip (LOW): /health no-auth leaks egressIp while todo 10 called it token-authed. FIX todos 2/10 - internal-only by design, drop the wording.
    - F9 citation_nits (LOW): nansen.ts:382 -> actual :380; DoorPool region 241-633 (transport 635-796), not 241-807. FIXED.
    - M1 dependency_21_missing_15 (MED): the cutover todo 21 could deploy adapter code without fail-open. FIX matrix row 15 Blocks += 21, row 21 Depends += 15, todo 21 blocked-by += 15.
    - M2 matrix_row11_parallel12 (LOW): row 11 "parallelize with 12" while 12 depends on 11. FIX row 11 -> "-".
    - M4 test_citation_drift (LOW): setup-field-ttl.test.ts:35 -> :19; door-pool.test.ts:20 -> :11. FIXED (9-test list corrected).
round_6:
  round_id: rpg-20260930T083236Z
  plan_sha256: 5d4863110e9fab4676e9910847481f54f8c7cf05dafe0d513cc0e4748c85b4c0
  fail_backup: /tmp/opencode/rpg-round5.md (round-6 input; not a pre-fix baseline)
  verdict:
    momus: CHANGES_REQUESTED (findings 1-8)
    oracle: CHANGES_REQUESTED (NF1-NF4; F1,F3-F9,N1,N3-N10 resolved, F2 partial)
  cited_issues_and_fixes:
    - M1/NF1 test_list_incomplete (HIGH): todo 13's named test list omitted server/test/tgm-flows.test.ts:386-411 (asserts bodies[0].pagination; ctor :388) and server/test/nansen.test.ts:4 (creditsSpent/resetCreditsSpent import -> ESM load fails once the counter is dropped); ctor arity sites nansen.test.ts:543 + gmgn.test.ts:136. FIX todo 13 - COMPLETE named set + PIN CONSTRUCTOR STRATEGY (NansenApiClient/GmgnMarketProvider KEEP the key param accepted-but-ignored; only the X-APIKEY send is dropped, so all existing ctor sites run unchanged).
    - M2/NF3 rollback_incomplete (MED): Makefile deploy (@91-95) is `docker compose build` ONLY (no recreate); and the rollback did not restore a's host server/.env upstream keys removed by the cutover. FIX todo 21 + commit strategy - `git checkout <sha> -- server/ docker-compose.yml && make deploy INSTANCE=a && make up INSTANCE=a` + restore a pre-cutover server/.env backup (record path only, never values).
    - M3 dependency_edge_16 (MED): todo 16 routes GMGN (todo 8) but was blocked only on 9. FIX todo 16 + matrix row 16 -> Depends 8,9.
    - M4 public_egressip (MED): a's /api/health is access:'public' (auth.ts:111) and would carry egressIp/proxy strings. FIX todo 10 - the api-side payload MUST STRIP egressIp (raw egressIp only on the loopback+private gateway /health).
    - NF2 door_edge_7_10 (MED): todo 7's free-door route uses the moved DoorPool (todo 10). FIX todo 7 blocked-by 3,6,10 + matrix rows 7 (parallel 8,9) and 10 (parallel 8,9).
    - M6 move_list_types (LOW): todo 10 omitted the type/const block crawl.ts:49-108,180-187,208. FIXED.
    - M7 rl_star_env (LOW): RL_* read from process.env in ratelimit/spec.ts:3-7, not config.ts. FIX todo 6 correction (set the same RL_* vars in the gateway env file; do NOT add dead config.ts fields).
    - M5 ctor_sites (LOW): gmgn.test.ts:136 ctor. FIXED via the ctor strategy.
    - NF4 unpinned_paths (LOW): gateway proxy-file path + python watcher token var unpinned. FIX todos 6/16/17 - gateway CRAWL_PROXY_FILE=/data/proxies.txt (a's /data/proxies-server.txt vestigial after todo 10); watchers use GATEWAY_URL + GATEWAY_CALLER_TOKEN (same names as api).
    - M8 citation_nits (LOW): api.ts:38 -> :46; Makefile .PHONY @89. FIXED.
round_7:
  round_id: rpg-20260930T083930Z
  plan_sha256: 3c06ac219ad22844515c96b774e27d7319416ac1a178c71071e8d26290a4150d
  fail_backup: /tmp/opencode/rpg-round6.md (round-7 input; not a pre-fix baseline)
  verdict:
    momus: OKAY (2 non-blocking nits: tgm-flows :411->:405 citation; dependency-matrix asymmetry row 1/4 + row 22 missing 10/11)
    oracle: CHANGES_REQUESTED (N1-N6; verified sha 3c06ac21; fold-back: M1-M5,M7,M8 + NF1(listing),NF2-NF4 resolved, M6 partial)
  cited_issues_and_fixes:
    - N1 constructor_strategy_fails_tsc (HIGH): the round-6-pinned "keep key param accepted-but-ignored" fails `npx tsc --noEmit` - TS6138 (param-property declared-but-never-read) / TS6133 (plain unused param) under noUnusedLocals:true, at gmgn.ts:129 + nansen.ts:354. FIX todo 13 - pin a concrete no-op (`void this.apiKey;` in the ctor body, or `_apiKey?: string`).
    - N2 move_list_missing_types (MED): todo 10 omitted `interface Door` (crawl.ts:210-237) + `type DoorConnWithEgress` (:239). FIXED.
    - N3 unused_import_poller42 (LOW/MED): poller.ts:42 unused `creditsSpent` import once the counter is dropped -> TS6133. FIX todo 13 edit list names poller.ts:42.
    - N4 citation_drift (LOW): tgm-flows pagination assertion is :405 (not :411); creditsSpent test spans nansen.test.ts:383-403 (not :383-398). FIXED.
    - N5 request_body_field (MED): request payload had no field for a POST upstream JSON body -> tgm-flows passthrough impossible. FIX todo 3 - add `body` field (raw JSON forwarded byte-verbatim; params = URL/query only).
    - N6 unpinned_paths_and_limits (LOW/MED): gateway host dir + env/proxy file paths, gateway-chrome mem/shm limits, no-downtime statement, Makefile deploy phrasing. FIX todo 4 (pin /opt/signal-scan-gateway/{gateway.env,proxies.txt} + mirror chrome limits) + todo 21 (deploy also scp/rsync, no recreate; accepted seconds-of-502 limitation).
    - momus_nits: dependency matrix row 4 now Depends 1 (todo 4 needs Dockerfile.gateway from todo 1); row 22 Depends += 10,11; tgm-flows :411->:405. FIXED.
round_8:
  round_id: rpg-20260930T085751Z
  plan_sha256: 19faef0d2e35251388e6f5bf9a199c1d72ff92561b4acc1e28218a08875fae0d
  fail_backup: /tmp/opencode/rpg-round7.md (round-8 input; not a pre-fix baseline)
  verdict:
    momus: OKAY (5 non-blocking notes: matrix redundant edges 6->19 / 13->15; docker-compose shm_size 1gb vs actual 2g; nansen.ts:276 dead-cite; todo-13 ctor wording vs :195; limiter.ts:58-59 gate-blocked unmapped)
    oracle: CHANGES_REQUESTED (2 BLOCKERS + 3 cosmetic; N1-N6 re-derived RESOLVED; verified sha 19faef0d)
  cited_issues_and_fixes:
    - B1 gateway_url_unset_contradiction (BLOCKER): todo 14 acceptance vs todo 21 + commit strategy gave contradictory GATEWAY_URL-unset semantics (loopback default vs legacy key-gated path); selection predicate unpinned. FIX todo 14 - PIN `gatewayUrl = str('GATEWAY_URL','')` (empty => gateway DISABLED), construct the gateway client iff `gatewayUrl !== ''`, NO loopback default on the TS side (loopback belongs to the host watchers, todo 16); reworded todo 14 acceptance + todo 21 + commit-strategy ROLLBACK to the same semantics.
    - B2 free_door_cutover_site_unnamed (BLOCKER): index.ts:11 import + :35 injection of browserPostJson named in no edit list; todo 10 cited index.ts:11 as a shim consumer while asserting the api never builds a pool. FIX todo 13 edit list adds `index.ts:11` (delete the import) + `:35` (inject a gateway-backed PostJson) + pins the URL->endpoint map for the three free-door URLs (nansen.ts:47-49, called :589/:616/:620); todo 10 shim parenthetical now cites `nansenSeries` (crawl.ts:907).
    - C1 shm_size_value (cosmetic): todo 4 `shm_size: 1gb` -> `2g` (actual docker-compose.yml:40; mem_limit 6g @:31). FIXED.
    - C2 matrix_asymmetry (cosmetic): row 6 Blocks 19 (19.dep={7,11}) + row 13 Blocks 15 (15.dep={14}). FIX rows 6/13 to direct dependents only.
    - C3 watcher_env_before_deploy (cosmetic): todo 17 wired host systemd env before the gateway deploy (todo 21) -> crash window. FIX todo 18 (Python fail-open) now precedes todo 17 (16 -> 18 -> 17); matrix rows 17/18 updated + a caveat added to todo 17.
    - C4 nansen_276_dead_cite (cosmetic): dropped `276` from todo 13 references.
    - C5 ctor_wording (cosmetic): todo 13 GMGN sentence reconciled with the CONSTRUCTOR STRATEGY (key param stays, value ignored).
    - C6 gate_blocked_unmapped (cosmetic): todo 3 contract now maps the limiter's gate-already-blocked rejection (ratelimit/limiter.ts:58-59) to 503 `{error:"gated"}` + `x-gateway-gated-until`.
  post_fix_plan_sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
  fail_backup_after_fold: /tmp/opencode/rpg-round8.md
round_9:
  round_id: rpg-20260930T090706Z
  plan_sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
  fail_backup: /tmp/opencode/rpg-round8.md (round-9 input; not a pre-fix baseline)
  verdict:
    momus: OKAY (6/6 round-8 findings resolved; 1 cosmetic carryover - stale per-todo "Blocks:" entries 19/15 vs matrix rows 6/13, transitive-only, harmless)
    independent: OKAY (all load-bearing citations re-derived real; 4 non-blocking notes: same Blocks carryover; realConnect cite :842 vs actual :857; credit+DexScreener endpoint names unpinned; todo 2 /health forward-ref to DoorPool stats (todo 10))
  verified_sha256:
    momus: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
    independent: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
  outcome: APPROVED (both lanes). Plan frozen; execute via $start-work.
review:
  momus:
    status: approved
    workspace_root: /home/namvt/Desktop/dev-space/signal_scan
    runtime_home: null
    target: .omo/plans/request-plane-gateway.md
    round_id: rpg-20260930T090706Z
    plan_sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
    launch_id: bg_c951bff6
    session: ses_f0e6e87e4ffeWAvFdFfN6emJFA
    result: OKAY (round 9; Verified sha256 d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000)
  independent:
    status: approved
    workspace_root: /home/namvt/Desktop/dev-space/signal_scan
    runtime_home: null
    target: .omo/plans/request-plane-gateway.md
    round_id: rpg-20260930T090706Z
    plan_sha256: d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000
    launch_id: bg_9dbe1815
    session: ses_f0e6e7645ffe5d22xhdo1XC7xU
    result: OKAY (round 9; Verified sha256 d28ef1dd699652f73dddafd9179dd1710a1182fdc29c46202b0ca8cddcc2d000)
