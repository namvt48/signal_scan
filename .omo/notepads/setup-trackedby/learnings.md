
## 2026-09-22 — trackedByNames single source (wallet_watch only)

- **What changed (exact lines)**
  - `server/src/signals.ts:82-107` (old) → doc comment rewritten; the
    `WHERE EXISTS (wallet_token_state … token_amount > 0) OR EXISTS (wallet_trades …)`
    collapsed to a single `WHERE EXISTS (wallet_trades … side='buy' AND ts >= @since
    AND source='watch')`. `@ca`/`@since`, `SELECT DISTINCT w.name`, `.sort()`,
    `buySinceTs` signature all kept verbatim. Function now spans `server/src/signals.ts:82-105`.
  - `server/test/signals.test.ts` — updated `assembleSignals: trackedBy = …` (rename),
    `trackedBy: holding-only wallet is NOT returned (no watch buy on CA_B)` (was the
    8-day-old-buy test, expectation `['CT01']` → `[]`), and the CT03 no-token_state test
    (expectation `['CT03']` → `[]`); added `trackedBy: a watch buy INSIDE the window is
    returned` and `trackedBy: a watch buy OLDER than the window is NOT returned, even
    while holding`.

- **Caller list**: `trackedByNames` has exactly ONE caller —
  `server/src/signals.ts:275` (`assembleSignals`) → `trackedBy: trackedByNames(c.address,
  now - TRACKED_BY_WINDOW_MS)`. No other src or test caller; tests exercise it indirectly
  through `assembleSignals`.

- **Test names added**: `trackedBy: a watch buy INSIDE the window is returned`;
  `trackedBy: a watch buy OLDER than the window is NOT returned, even while holding`.

- **Proof of real test (RED)**: updated the tests first and ran against the OLD code →
  3 fail / 149 pass (152 total): the 3 holding-half assertions go red, because the old
  `OR EXISTS (wallet_token_state …)` still returned the holding-only wallets. Then the
  code change made all 152 pass / 0 fail; build exit 0.

- **Surprises / notes**
  - `insertTrades(walletId, activities)` defaults `source='nansen'`. The pre-existing
    `tx5` fixture (CT02, CA_B, 8d old) therefore never had `source='watch'` — its
    exclusion in the old test was *partly* about the window and *partly* about source.
    The new dedicated (c) case adds an explicit `source='watch'`, 8d-old buy on a wallet
    that ALSO holds, so the window alone is what excludes it.
  - `wallet_token_state` still appears once in `signals.ts` (line 77, `sumHoldingAmount`)
    by design — `trackedHolding` is unchanged and must keep reading it.
  - Baseline was 150 pass / 0 fail; +2 tests → 152. `door-pool.test.ts` (frozen, 13 tests)
    untouched and green.

## 2026-09-23 — setup fill-on-add: verified line numbers for the plan

Task: author `.omo/plans/setup-fill-on-add.md` (NO source edits, no ssh, no git). All lines
below re-read from the working tree THIS session (2026-09-23), not copied from memory.

**Verified (brief matched):**
- `refreshSeries` = `server/src/poller.ts:282`; sole caller `setupSweep` = `poller.ts:230`.
- `setupSweep` scheduled at `poller.ts:552`, gated by `config.crawlEnabled` at `poller.ts:551`
  (`config.ts:80`, default `off`).
- `POLL_SETUP_MS` = `config.ts:56`, default `43_200_000`.
- `passThroughAnalytics` = `poller.ts:214`; `kickCAs` = `poller.ts:483`; `kickToken` = `poller.ts:499`;
  `kickNansen` = `poller.ts:510` (the only other `updateTokenAnalytics` caller, and it passes the
  analytics through unchanged → cannot fill t100/lf).
- `seriesFromMs` = `snapshot.ts:147` (body at `:148` `Math.max(now - capMs, deployedAt || 0)`).
- `exchangeAnchorLf` = `snapshot.ts:84` (`minAt` clamp at `:91`); `t100Genesis` = `snapshot.ts:56`;
  `seriesReachesStart` = `snapshot.ts:107`; `LF_WINDOWS` = `snapshot.ts:161`;
  `RUNG_SPAN_DAYS` = `snapshot.ts:140`; `tfFor` = `snapshot.ts:171`.
- `nansen_series` table = `db.ts:167`; `token_state` = `db.ts:109`; `settings` = `db.ts:178`.
- `POST /api/tracked-cas` = `api.ts:345`; `kickCAs` fired at `api.ts:372`.
- `server/test/door-pool.test.ts` = exactly 13 `test(` calls (grep -c).
- `data/` is excluded from deploy: `Makefile:50` `rsync ... --exclude data`; `make ssh-rm`
  (`Makefile:90`) DOES delete `data/` inside REMOTE_DIR.
- Reset marker `2026-09-22T16:56:28Z` = `evidence/2026-09-22-ca-reset-250.md` ("Run 2026-09-22
  16:56:28Z"); the 12-CA state (`t100_multiple` 0/12, `genesis_bal` 0/12, `anchor_at` 0/12),
  `setupSweep done in 1ms`, and the `seriesAtRung …403` / `series cut … n=0` logs are all in that
  same evidence file. `~61 auto-adds/hour` = that file line 41.
- `settings` table already writes a migration marker: `db.ts:228-230` gates the one-time
  `genesis_bal = NULL` reset on `lfRule === '2026-09-11-leftmost'` → precedent for a new
  `systemDeployAt` key.

**Corrections vs brief (use the real value):**
- `/api/signals` is `api.ts:256`, not `:257`.
- `seriesFromMs` function head is `snapshot.ts:147`; the formula line is `:148`. Cite both.
- "`refreshSeries` is the ONLY writer of `genesis_bal`" is true only in Nansen mode:
  `upsertTokenInfo` (`ingest.ts:30-99`) also writes `genesis_bal` via
  `genesis_bal = COALESCE(excluded.genesis_bal, token_state.genesis_bal)` (`ingest.ts:66`), but
  only when the provider supplies `info.genesisBal` — `providers/mock.ts:91` does, Nansen omits.
  `t100_multiple` / `anchor_at` are written ONLY by `updateTokenAnalytics` (`ingest.ts:159-192`),
  whose only callers are `refreshSeries` (`poller.ts:299`) and pass-through `kickNansen`
  (`poller.ts:514`). So the brief's conclusion holds for production.
- `updateTokenAnalytics` is an `UPDATE` (`ingest.ts:166`), not an upsert → a cache rehydrate cannot
  write analytics before the `token_state` row exists (it is created by the essential sweep /
  `kickToken`). Rehydrate must be lazy (apply when the row exists) or add an upsert.

**Observed production facts I could NOT re-measure here** (no local DB — `data/signal_scan.db`
does not exist locally): the 12 CA / 12-of-12 numbers and the `settings` values
(freshMinPct 15, lfMax 1e8, lfMin 3e7, maxMc 1.5e7, minMc 15000, minUsd 50, t100MinMultiple 1.2 —
plus retired lfMaxPct/lfRule/t100MinPct + allFactors = 11 rows). Cited in the plan as observed
from `evidence/2026-09-22-ca-reset-250.md` + the 2026-09-22 session, marked as such.


## T2 (2026-09-23) — setup-cache.ts file cache: API surface for T3 (VERBATIM signatures)

New leaf module `server/src/setup-cache.ts` (runtime imports: `config.js`, `shared/chain.js` ONLY;
`import type { SeriesPoint } from './db.js'` is erased — no cycle, no better-sqlite3 pulled in).

Exported API (T3 consumes verbatim):
- `interface SetupCacheEntry { ca: string; chain: Chain; taken_at: number; window: string;
  series_from: number; series: SeriesPoint[]; exchange: SeriesPoint[]; t100_pct: number;
  t100_multiple: number; anchor_at: number; genesis_bal: number }` (plan §4 shape; SeriesPoint
  ≡ crawl.ts BalancePoint structurally → seriesAtRung/exchangeLf results pass WITHOUT casts, and
  entry.series replays into upsertNansenSeries without casts)
- `cacheKey(ca: string, chain: Chain): string` → `` `${chain}:${ca}` `` — build trackedKeys with this
- `loadSetupCache(file: string = config.setupCacheFile): Map<string, SetupCacheEntry>` — call ONCE at
  startup (index.ts, after/near `open(config.dbPath)`); missing/empty/corrupt/unreadable → empty map +
  ONE `[setup-cache]` warn, NEVER throws. Optional `file` param mirrors db.ts `open(path)` seam (tests).
  NOTE: put/prune persist to the file bound by the LAST load (`activeFile`) — always load before put.
- `getSetupCacheEntry(ca: string, chain: Chain): SetupCacheEntry | undefined`
- `putSetupCacheEntry(entry: SetupCacheEntry): void` — upsert + atomic persist (`<file>.tmp` → rename,
  `mkdirSync recursive`); persist failure = warn + keep in-memory entry, never throws, no stale *.tmp
- `isSetupCacheFresh(entry: SetupCacheEntry, now: number): boolean` — `now - taken_at < config.pollSetupMs`;
  exactly POLL_SETUP_MS ⇒ STALE (strict <)
- `pruneSetupCache(now: number, trackedKeys: ReadonlySet<string>): number` — drops key ∉ trackedKeys OR
  age > 7×pollSetupMs (exactly 7× SURVIVES, strict >); persists only when dropped>0; returns drop count
  (caller logs — no logging inside)

Config: `config.setupCacheFile = str('SETUP_CACHE_FILE', join(dirname(dbPath), 'nansen-cache.json'))`
where `dbPath = str('DB_PATH', './data/signal_scan.db')` (hoisted const). Resolved defaults:
local → `data/nansen-cache.json`; prod → docker-compose.yml:34 sets `DB_PATH=/data/signal_scan.db` ⇒
`/data/nansen-cache.json` (bind mount `./data:/data`) — NO compose/.env.example edit needed.
`make ssh-rm` (Makefile:90) deletes it — destructive-by-design, documented in config docblock.

Envelope on disk: `{"version":1,"entries":[...]}` compact JSON. Load validation is per-entry
all-or-nothing (one malformed point rejects that record; valid siblings survive; malformed count
warned ONCE). version≠1 or entries-not-array ⇒ whole file rejected (empty map).

Tests: `server/test/setup-cache.test.ts`, 9 tests, temp dirs via mkdtempSync only (never ./data).
Baseline before T2: 152 pass / 0 fail. After: **161 pass / 0 fail**, build exit 0,
door-pool.test.ts untouched (13 tests, md5 0eb56449b9c28faf4585189afa5c3eeb).
Surprises: none — tsx does NOT typecheck (LSP/tsc is the type gate; tests are excluded from `tsc`
via tsconfig `exclude: ["test"]`); node:test runs each test file in its own process, so module-level
cache state is per-file — each test re-binds via loadSetupCache(tmpPath) for isolation.

## T3+T5 (2026-09-23) — rehydrate + phase-anchored cadence DONE

Baseline before T3+T5: 161 pass / 0 fail. After: **171 pass / 0 fail**, build exit 0,
door-pool.test.ts untouched (13/13).

For T4 (the early paced trigger):
- `refreshSeries(ca, chain)` is EXPORTED from poller.ts — awaits, one CA, door-guarded (a fresh
  file-cache entry → zero fetches; incomplete passes refused by the C3 storable guard). T4 only
  needs to call it once the row exists (kickToken/upsertTokenInfo creates the row; F3=queue means
  calling before the row is a logged no-op, the next pass applies).
- Fake-door harness to copy: `installFakeDoor` in `server/test/setup-rehydrate.test.ts` —
  DoorPool over a fake DoorConn counting NANSEN_HOURLY_STATS_URL fetches, injected via
  `setPoolForTest(pool)` (exported seam in crawl.ts); `await new Promise(setImmediate)` after
  `pool.start()` so warm() finishes (warm only connects, never fetches). Working fake
  DoorPoolConfig: proxies [], pathBudget 1000, budgetWindowMs 60_000, doorCapPerMin 1000,
  warmupTimeoutMs/requestTimeoutMs 1000, quarantineJitterMs 0. Distinguish series vs exchange in
  the fake conn by `body.parameters.label` ('exchange' vs 'top_100_holders').
- `cacheSeriesWindows` is EXPORTED from poller.ts (crawl.ts balanceSeries replays file-cache
  entries through the SAME slicer — window semantics must stay identical between fetch and replay).
- `seriesAtRung` now returns `{points, from, window}` (SeriesFetch); `exchangeLf` returns
  `{total, points}` — the cache record needs the raw points + window metadata, not just scalars.
- `systemDeployAt` (settings, epoch-ms string) written by db.open() once when absent — available
  everywhere after open; `nextPhaseDelayMs(anchorAt, now, intervalMs)` exported from poller.ts.
  On-boundary fires immediately: a fresh deploy is boundary n=0, so the first setup pass still
  runs at boot while staying phase-locked.
- setup-cache.ts safety guards: `ensureLoaded()` lazy hydrate before the first persist (C1),
  empty tracked set → prune no-op without persist (C2), `isStorable()` refuses anything
  parseEntry would drop on reload (C3).
- Test env trick: set `SETUP_CACHE_FILE` BEFORE the first `await import('../src/setup-cache.js')`
  to bind the module default to a temp file (node:test = one process per file, so this is safe).

## T4 (2026-09-23) — early paced setup trigger DONE

Baseline before T4: 171 pass / 0 fail. After: **173 pass / 0 fail**, build exit 0,
door-pool.test.ts untouched (13/13, md5 0eb56449b9c28faf4585189afa5c3eeb).

- Trigger: `kickSetupEarly(cas: readonly { address: string; chain: Chain }[]): void`
  (EXPORTED, poller.ts) + private `drainEarlySetup()` + `earlySetupIdle(): Promise<void>`
  (test seam). Gated on `config.crawlEnabled`.
- Wired in `kickCAs` (poller.ts ONLY, api.ts untouched):
  `void kickToken(...).then(() => kickSetupEarly([c]))` — `kickToken` now RETURNS its
  promise (resolves after `upsertTokenInfo`, never rejects), so the early pass always
  runs AFTER the token_state row exists. That chain IS the ordering guarantee
  (refreshSeries no-ops without the row).
- Pacing: pending-list + ONE serialized promise chain (`earlySetupDrain =
  earlySetupDrain.then(drainEarlySetup)`) — never N simultaneous passes; each batch goes
  through the EXISTING `pacedFor(batch, config.newCaPriorityMs, ...)` (queue-jump window
  1h ⇒ 2 req/CA far under 30/min/path + 40/min/door). No second scheduler invented.
- Measured counts (fake door, test/setup-early-kick.test.ts, 2 tests): 2 CAs no-cache →
  doorFetches 6 (2 early-pass + 1 pre-existing kickNansen series per CA),
  exchangeFetches 2 (= one pass/CA), maxActiveExchange 1; fresh cache → 0 fetches.
- Test env trick (before src imports): NANSEN_CRAWL=on + NEW_CA_PRIORITY_MS=1000 shrinks
  the pacedFor slot to test size; all assertions are counts, never wall-clock.
- kickNansen still costs 1 series fetch per add (pre-existing, unchanged, does NOT write
  the setup cache) — a no-cache add totals 3 door requests, a cached add 0.

## T6 (2026-09-23) — verification tổng DONE (evidence + roll-up, no source edit)

T6 re-ran every gate itself; measured NOW:
- `cd server && npm run build` → BUILD_EXIT=0 (tsc, clean).
- `cd server && npm test` → **173 pass / 0 fail** (duration_ms 25798.88) — matches T2/T3+T5/T4, counted not copied.
- `md5sum server/test/door-pool.test.ts` → `0eb56449b9c28faf4585189afa5c3eeb` (frozen, 13/13).
- Changed-file window `find server/src server/test -newermt '2026-09-23 10:00'` → 11 files:
  test/setup-cache.test.ts (10:25), src/config.ts (10:26), test/setup-cache-safety.test.ts (11:06),
  test/setup-rehydrate.test.ts (11:07), test/setup-cadence.test.ts (11:08), src/setup-cache.ts (11:11),
  src/db.ts (11:12), src/crawl.ts (11:16), src/index.ts (11:16), test/setup-early-kick.test.ts (11:46),
  src/poller.ts (11:47).
- Frozen mtimes all pre-window: snapshot.ts 2026-09-21 21:41, api.ts 2026-09-21 22:22,
  providers/nansen.ts 2026-09-22 20:51, door-pool.test.ts 2026-09-22 10:12.

Baseline chain confirmed as measured: 152 → 161 → 171 → 173, 0 fail throughout.

Roll-up written: `evidence/2026-09-23-setup-fill-on-add.md` gets a `## T6 — verification tổng` section
(measured gates + RED→GREEN chain + 11-file list + 4-requirement matrix + frozen-file proof +
deploy checklist + 3 known observations), re-terminated with the literal `EVIDENCE_RECORDED:` line.

Deploy is STILL not authorised — 250 remains PAUSED. Deploy checklist recorded for later:
(i) `data/nansen-cache.json` survives `make deploy` (`--exclude data`, Makefile:50) but is WIPED by
`make ssh-rm` (Makefile:90, destructive by design); (ii) boot log `[setup-cache] loaded N entries … (pruned N)`;
(iii) `[poller] setupSweep anchored to systemDeployAt=<iso> …`; (iv) on add `[poller] early setup pass <ca8> (<chain>)`
then `[setup-cache] applied <ca8> (sol) from file cache — 0 door requests`; (v) build 0 + 173/173 verified
LOCALLY only, NOT yet on 250.

Carried forward (recorded, not fixed): (1) each new CA = 1 extra series fetch (~2 door req/CA, zero credit, in budget);
(2) `earlySetupDrain` has no defensive `.catch()` — unreachable today (per-item fn is try/caught), future hardening;
(3) burst spacing `newCaPriorityMs(1h) × sweepPaceFactor(0.8) / batch.length` per CA while a single add runs immediately.

## F2 fix (2026-09-23) — setupSweep prune: fresh tracked set, not the sweep-start snapshot

- Bug: prune reused the sweep-start `cas` snapshot; the sweep is paced across ~0.8×POLL_SETUP_MS
  (~9.6h prod), so a mid-sweep add (real path: kickCAs → kickSetupEarly → refreshSeries →
  putSetupCacheEntry) got its fresh entry deleted. Fix = ONE fresh `listTrackedCas()` read at
  prune time (poller.ts:268-269), same sync block as `pruneSetupCache` — NO await between, no
  new race window. `cas` still drives pacedFor; `newCasFirst` NOT used at prune (set membership);
  setup-cache.ts semantics untouched. `setupSweep` EXPORTED as test seam (refreshSeries/pacedFor
  precedent) — scheduler stays the sole prod caller.
- Test: `server/test/setup-sweep-prune.test.ts` (1 test). Recipe that worked: env
  `NANSEN_CRAWL=on` + `POLL_SETUP_MS=1000` + `NEW_CA_PRIORITY_MS=1000` BEFORE src imports →
  pacedFor slot = max(250, 1000×0.8/2) = 400ms — a real setTimeout macrotask, while the whole
  early-kick path (kickToken→drain→refreshSeries→put) resolves in microtasks/setImmediate, so
  "entry written BEFORE prune" is deterministic without wall-clock asserts. Seed 2 old CAs (no
  token_state rows → sweep items are cheap no-ops), start `setupSweep(provider)` (snapshot taken
  synchronously at call), THEN insertTrackedCa(NEW)+kickCAs([NEW]); `awaitRow(NEW)` before
  `earlySetupIdle()` (kickSetupEarly chains one microtask AFTER kickToken resolves — polling the
  row on setImmediate guarantees the chain is registered); assert precondition (entry exists,
  t100_multiple 1.5, genesis_bal 120), then `await sweep`, then survival.
- RED proof: against unfixed code the log line `[setup-cache] pruned 1 entries` + failed survival
  assert (actual undefined) — right reason, not import error. NOTE: export `setupSweep` FIRST as a
  separate seam step, else the test's RED is an import failure.
- Measured: baseline 176/0 → after 177/0, build exit 0, door-pool md5 0eb56449b9c28faf4585189afa5c3eeb.
- Carried forward: index.ts:21 boot prune already reads listTrackedCas() fresh (was never affected).

## symbolBackfill quota fix (2026-09-23) — window bound on listCaTargetsMissingSymbol

- Leak: unbounded selector → every never-resolving CA retried forever by symbolBackfillSweep
  (5 min cadence, 10 DAS credits/getAsset) = 2,880 cr/day/stuck-CA (≈8.64% free pool each,
  linear). Survives crawl pause — sweep is the only task outside the crawlEnabled block.
- Fix = symmetry, not machinery: `listCaTargetsMissingSymbol(withinMs)` + `AND t.added_at >= ?`
  (ISO-string `since`, textual compare — established db.ts pattern), mirroring
  `listCaTargetsMissingEssential` exactly. New config key `symbolBackfillWindowMs`
  (SYMBOL_BACKFILL_WINDOW_MS, default 1h = essentialGapWindowMs). No retry counter, no column,
  no migration, no cadence change. `.env.example` frozen — key NOT added there.
- SQL gotcha: original WHERE was `s.symbol IS NULL OR trim(s.symbol) = ''` — adding AND requires
  parenthesizing the OR, else precedence silently changes semantics.
- Test recipe for aged rows: `insertTrackedCa` stamps added_at=now; backdate via
  `getDb().prepare("UPDATE tracked_cas SET added_at = ? WHERE address = ?").run(iso, addr)`
  with now−2h ISO string; assert 1h-window selector returns []. Existing now-stamped tests
  prove fresh rows still land inside the window.
- Measured: baseline 177/0 → after 178/0 (+1 new test), build exit 0, door-pool md5
  0eb56449b9c28faf4585189afa5c3eeb intact.
- Recorded not fixed (window-bounded now): non-sol assetInfo returns {} (0 cr but set-immortal);
  getAssetInfo loops ALL RPC endpoints → stuck mint can cost 10 cr × endpoints per sweep.

## 2026-09-23 — deploy+wipe 250: 3 cái bẫy đã sập

1. **Đo proxy từ HOST qua IP public của chính server = 000 → ĐỎ HERRING.**
   `curl -x http://194.163.187.250:31133 https://api.nansen.ai/` từ chính 250 trả 000 (hairpin NAT + tinyproxy
   `Allow` chỉ có `127.0.0.1` + `172.23.0.0/16`), làm tưởng proxy chết. Test ĐÚNG = từ đúng network của app:
   `docker run --rm --network signal_scan_default curlimages/curl:latest -x "$PROXY" https://api.nansen.ai/`
   → CẢ 2 proxy đều 200. Subnet app = `172.23.0.0/16` (gw .1, api .3).
2. **`[door N] retired reason=broken-proxy` KHÔNG đồng nghĩa proxy hỏng.** Nếu log trước đó có
   `promoted path=... status=200` thì door đó đã từng chạy → retire do 3 transport-fail liên tiếp (transient:
   403 interstitial của Nansen/Cloudflare). Pool tự retire, còn door khác gánh, `no door budget ... skip` khi hết budget.
3. **Backup SQLite đang bật WAL: KHÔNG dùng `cp`** (mất WAL chưa checkpoint). Dùng `python3 -c "src.backup(dst)"`.
   `make deploy` có `--exclude data` nên DB + `.env` sống qua deploy; chỉ `make ssh-rm` mới xoá cả `data/`.

Cách chốt phạm vi wipe: KHÔNG đoán — hỏi (wallets 198 / settings 11 / events.jsonl 59MB khác nhau vật chất, prod + không undo).
