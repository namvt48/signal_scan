# Miss-trade test — fomo-watch daemon (instance b)

Date: 2026-09-30 (host CEST; all UTC below). Host `root@194.163.187.250`.
Scope: instance **b** only (`/opt/fomo-watch`, api `127.0.0.1:8125`). Instance A untouched.

## Question
Does the FOMO firehose watcher miss trades it should capture?

## Method (ground truth, not self-report)
Two observers on the same feed, same filter code:
1. The running daemon (`fomo-watch.service`, `python -m watchers.fomo`).
2. An **independent capture** connecting a 2nd socket with the same key and the
   same matcher (`watchers.fomo.feed.alert_body` + `_match`), logging every frame
   and classifying each drop reason. Verified safe: 2nd socket did NOT disturb the
   daemon (watch.log line count unchanged, 0 `ws đứt`).
Comparison key: `eventId`.

## Results

### Window 1 — 110s
- capture: 114 frames, `matched_uniq = 0`.
- daemon: 0 emits. DB unchanged. → agree.

### Window 2 — 240s (`04:46:54Z` → `04:51:24Z`)
```
frames=151  alert=138  buy_sell=95  matched=1  should=0
alertTypes: {perp:19, buy:55, thesis:24, sell:40}
dropped:    bad_chain  ('shiprekt88', chain='robinhood')
db_rows=1   should_emit_uniq=0   should_not_in_db=0
```
- The **only** watched-trader trade in the window was on chain `robinhood`,
  which is outside the by-design set `sol/base/bsc` → correctly dropped.
- `should_not_in_db = 0` → nothing the daemon should have emitted was missing.

### Daemon health (whole lifetime since 05:54:43 CEST start)
| counter | value |
|---|---|
| `# fomo socket connected` | 2 (one per process start) |
| `ws đứt` (reconnect) | 0 |
| `^  ! ` stderr errors | 0 |
| `ingest 404` | 0 |
| `frame non-JSON` skip | 0 |
| emits (`# fomo buy|sell`) | 0 |
| `fomo_trades` rows | 1 (earlier `--once` PUMP: emit → POST 200 → row → `tracked_cas note='fomo'`=1) |
| `fomo_state.json` | `emitted=1`, `seen=[b8770c20-…]` → emitted == rows (0 ingest loss) |

Blind-spot closed: unit has `StandardOutput=append:` **and**
`StandardError=append:/opt/fomo-watch/watch.log` → stderr (all drop/error lines)
really lands in watch.log, so "0 errors" is meaningful, not blind.

## Conclusion
**No missed trades observed.** Feed coverage delivered frames (~0.6/s), the daemon
and an independent observer agreed, ingest path proven (event → POST 200 → DB row),
and `emitted == DB rows` with zero error/404/reconnect lines.

## Caveats (not bugs observed, but real ceilings)
1. **Restart gap** — daemon was stopped+started at `04:30:09Z` (journal:
   "Stopping… Deactivated… Started"; cause not this session). Any alert in that
   instant is lost: no gap backfill by design.
2. **Fail-soft POST + unconditional `save_state`** (`feed.py:249-250`): a POST that
   fails (network/5xx) logs stderr but the event is still marked `seen` and saved →
   it will **never be retried** = permanent silent loss. Only visible as
   `! fomo-trade …` lines. Count so far: 0.
3. **Policy drops** (by design, not misses): `perp`/`thesis`/`listing` alert types,
   chains outside `sol/base/bsc` (e.g. `robinhood`), alerts with no `tokenAddress`.

EVIDENCE_RECORDED: evidence/2026-09-30-fomo-watch-miss-test.md
