# 2026-09-23 — Setup: retry until complete, then 12h; empty CAs back off (no spam)

Directive (user, verbatim):
- "nên có cơ chế query setup (t100/lf/series) đủ, khi mà đủ tất cả các thông tin của một CA rồi thì mới đến interval 12h"
- "nhưng mà có mấy CA mới thì sẽ rỗng rồi cũng nên có cơ chế không spam query những cái như thế"

## Change
- `server/src/config.ts` — new knob `pollSetupRetryMs` (`POLL_SETUP_RETRY_MS`, default 1h): retry cadence while a CA's setup is incomplete.
- `server/src/poller.ts`
  - `needsSetup(ca)` filter: a CA is owed a pass unless its cache entry is **fresh** (`isSetupCacheFresh`) **and** its row is complete (`nansenScore(...).complete` = symbol + supply + price + fresh% + T100 + genesis). Fresh+complete → skipped (the 12h cadence).
  - `setupSweep` now paces over `config.pollSetupRetryMs` instead of `config.pollSetupMs`.
  - Empty-CA backoff: a pass that leaves no fresh cache entry counts as a miss; next attempt = `min(POLL_SETUP_MS, max(60s, POLL_SETUP_RETRY_MS * 2^misses))` → 2h → 4h → 8h → 12h. A storable pass clears the ladder.
  - `startPoller` registers the task at `pollSetupRetryMs`, phase-anchored on `systemDeployAt`; log: `setup sweep every 3600000ms (retries until a CA is complete, then 43200000ms)`.
- `server/test/setup-retry-until-complete.test.ts` — new regression (2 tests).
- `server/test/setup-sweep-prune.test.ts` — env `POLL_SETUP_RETRY_MS=1000` (slot math unchanged: 0.8 × 1000 / 2 = 400ms).

## Local evidence
```
RED (before fix):
  ✖ setup retry: COMPLETE + fresh cache: must NOT be re-queried (12h cadence)  1 !== 0
  ✖ setup spam guard: empty CA must NOT be hammered on the next pass (backoff)  2 !== 1
GREEN (after fix):
  ✔ setup retry: missing setup is re-queried every pass; a COMPLETE CA sits on the 12h cache
  ✔ setup spam guard: a CA whose setup keeps coming back EMPTY backs off after one attempt
  ℹ tests 2 · pass 2 · fail 0
npm test (full):   ℹ tests 192 · pass 192 · fail 0 · duration 15499ms
npx tsc --noEmit:  exit 0
```

## Prod evidence (root@194.163.187.250, /root/signal_scan)
Deploy `make restart` → `docker compose build` OK, api recreated, `HTTP 200 /`, `/api/health` `healthy:true` door0 `healthy 200`.
```
[poller] setupSweep anchored to systemDeployAt=2026-09-23T06:00:06.610Z — next pass in 974s
[poller] setup sweep every 3600000ms (retries until a CA is complete, then 43200000ms)
[crawl] loaded 2 proxies → 2 doors
```
Inventory at 2026-09-23T10:44Z (`token_state`×`nansen-cache.json` join, 12h freshness):

| bucket | n | CAs |
|---|---|---|
| SKIP (fresh entry + complete row) | 6 | STONK 4.3h · LYNKS 1.2h · CLIP 0.9h · CHICK 0.6h · SRI 0.5h · PUMP 0.1h |
| QUERY (no entry, incomplete) | 5 | EMBER · BABYNEET · INUVIDIA · JEANPHIL · BPCHAN |

Every capped/stale CA has an entry ⇒ the 6 landed a setup pass this morning; the 5 without entries are exactly the incomplete ones the retry exists for. Next pass (11:00:06Z, 1h mark) must query **only those 5**, paced `0.8h/5 ≈ 9.6 min` apart.

## Verification — one-off `setupSweep` on PROD data (no 20-min wait)
Ran inside the api container against the real DB/cache/pool with `POLL_SETUP_RETRY_MS=1000` **for that process only** (prod config untouched), then PASS 2 immediately after:
- `docker compose exec -T -e POLL_SETUP_RETRY_MS=1000 api node --input-type=module` → `open(DB_PATH)` → `loadSetupCache()` → `new NansenMarketProvider((u,b)=>browserPostJson(u,b), nansenApi, listTrackedCas)` → `setupSweep(provider)` ×2.

| PASS 1 | result |
|---|---|
| fetched | exactly the 5 pending (EMBER, INUVIDIA, JEANPHIL wrote entries `age 0.6–0.7m`; BABYNEET + BPCHAN attempted, `skipped cache write … incomplete pass`) |
| untouched | the 6 fresh+complete (entries `0.5h–4.3h`, **0 log mentions**) + WALTER/WHALE (new, complete, 3.5m/5.5m) |
| win | **EMBER went symbol-only NULL → `none (complete)`** — the exact CA the user flagged |

| PASS 2 | result |
|---|---|
| door promotions | **0** (`pass2 door lines: NONE`) |
| only line | `[setup-cache] applied DH8Gp1Jy (sol) from file cache — 0 door requests` |

So: complete+fresh → skipped (cadence), incomplete → queried once, empty → attempted once then laddered, second pass → **zero Nansen requests**.

Post-state: `entries=11`, `tracked=13`, all complete except `INUVIDIA (price NULL — owned by the token-info path, not setup; hourly cache-apply, 0 door requests)` and `BABYNEET / BPCHAN (no Nansen series yet → backoff ladder; not hammered)`.


## Note
- `data/nansen-cache.json` is `{version, entries:[...]}` (array) — read `entries`, not the top-level key count.
- Reproduce anytime (≤3 min, no wait for the hourly mark):
```
ssh root@194.163.187.250 "cd /root/signal_scan && docker compose exec -T -e POLL_SETUP_RETRY_MS=1000 api node --input-type=module" <<'JS'
import { open, listTrackedCas } from './dist/db.js';
import { loadSetupCache } from './dist/setup-cache.js';
import { browserPostJson } from './dist/crawl.js';
import { NansenApiClient, NansenMarketProvider } from './dist/providers/nansen.js';
import { setupSweep } from './dist/poller.js';
import { config } from './dist/config.js';
open(process.env.DB_PATH); loadSetupCache();
const p = new NansenMarketProvider((u,b) => browserPostJson(u,b), config.nansenApiKey ? new NansenApiClient(config.nansenApiKey) : null, listTrackedCas);
await setupSweep(p); await setupSweep(p);  // pass 2 must hit 0 doors
process.exit(0);
JS
```
- (Rejected) no new dependency, no new table/file: the ladder is an in-memory Map; a restart at worst costs one extra attempt per empty CA.
- (Deferred) `needsSetup` uses the full `nansenScore(...).complete` (symbol+supply+price+fresh%+T100+genesis) per the user's "đủ tất cả các thông tin" — a CA missing only a non-setup field (`price`, e.g. INUVIDIA) stays on the hourly list but costs **0 door requests** (cache re-apply). Tighten to setup-only fields if that log line gets noisy.

EVIDENCE_RECORDED: evidence/2026-09-23-setup-retry-until-complete.md

