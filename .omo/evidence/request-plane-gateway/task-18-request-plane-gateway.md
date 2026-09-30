# Todo 18 — Python fail-open for price lookups (`request-plane-gateway`)

Plan block: `.omo/plans/request-plane-gateway.md:231` — "Make the Python gateway
client degrade on failure - return the existing 'unknown price' result ... and
never crash the feed loop. Do NOT cache-price-and-lie."

## What changed

- `watchers/common/price.py` — in `gmgn_info()`, moved `return _gmgn_of(env)`
  **inside** the existing `try` (5-line diff). Why: `_gmgn_of` raises
  `AttributeError` on a malformed-but-2xx GMGN body (`data`/`token` not a dict,
  e.g. `{"code":0,"data":"oops"}`); called outside the `try` that exception
  escaped `gmgn_info` -> `token_info` -> the feed loop. Now every gateway
  failure shape falls back to DexScreener, never raises.
- `scripts/test_price_gateway.py` — added cases (e) unreachable, (f) malformed
  envelope, (g) malformed GMGN body + feed-loop iteration. Runnable via
  `python3 scripts/test_price_gateway.py`.

Scope held: `emit.py`, `rpc()` (config.py:241), the FOMO WSS, and
`config.gateway_json`'s envelope contract are UNTOUCHED. No cache-and-lie: the
existing unknown path (`_info[key] = (mint[:6]+"…", 0.0)`, `_info_miss`) is
unchanged — `get_price_usd` still returns `None` when unknown.

## Commands + verbatim output

### 1. `python3 scripts/test_price_gateway.py`  (exit 0)

```
$ python3 scripts/test_price_gateway.py; echo "EXIT=$?"
  ! gmgn: URLError: <urlopen error [Errno 111] Connection refused>
  ! gmgn: AttributeError: 'str' object has no attribute 'get'
OK (a): gmgn_info → POST /v1/gmgn/token-info, bearer đúng, parse (BTCX, 0.00097206308)
OK (a2): QUOTE_SOURCE=gmgn → token_info đi gateway GMGN
OK (b): token_info → POST /v1/dexscreener, parse (MET, 0.3311), không đụng GMGN
OK (c): không còn _GMGN_GAP_S/_GMGN_BAN_S/_gmgn_next_ok (gateway là single writer)
OK (d): gateway 500 → 'price unknown', không raise
OK (e): gateway unreachable → unknown; feed loop + _warm_prices chạy hết, không raise
OK (f): envelope méo (list/HTML/body rỗng) → 'price unknown', không raise
OK (g): GMGN data méo → 'price unknown', không raise (không thoát AttributeError)
PASS: price gateway — GMGN + DexScreener đi qua gateway, bỏ gate client, fail-open (T18)
EXIT=0
```

Note the two stderr lines are the *caught* failures logged by `gmgn_info`
(connection refused = unreachable case (e); `AttributeError` = the malformed GMGN
body case (g) that previously escaped) — proving the handler now absorbs them.

### 2. Red → green (test catches the bug it names)

Pre-fix file swapped in (`git show dfd2c82:watchers/common/price.py`), test run,
then the fixed file restored and re-run. The pre-fix run fails EXACTLY at (g),
with the stack escaping `token_info` into the would-be feed loop:

```
--- PRE-FIX price.py in place; running test (expect (g) to fail) ---
...
OK (f): envelope méo (list/HTML/body rỗng) → 'price unknown', không raise
Traceback (most recent call last):
  File ".../scripts/test_price_gateway.py", line 242, in main
    sym, px = price.token_info("GmgnBadDataMint")
  File ".../watchers/common/price.py", line 139, in token_info
    sym, px = gmgn_info(mint, chain)
  File ".../watchers/common/price.py", line 70, in gmgn_info
    return _gmgn_of(env)
  File ".../watchers/common/price.py", line 49, in _gmgn_of
    tok = tok.get("token") or tok
AttributeError: 'str' object has no attribute 'get'
PRE_FIX_EXIT=1
--- fix restored ---
RESTORED_EXIT=0
PASS: price gateway — GMGN + DexScreener đi qua gateway, bỏ gate client, fail-open (T18)
```

### 3. Scope check  `git diff --stat`

```
$ git diff --stat -- watchers/common/price.py scripts/test_price_gateway.py
 scripts/test_price_gateway.py | 114 +++++++++++++++++++++++++++++++++++++++---
 watchers/common/price.py      |   5 +-
 2 files changed, 110 insertions(+), 9 deletions(-)
```

Only the 2 in-scope files changed; `config.py` / `emit.py` / FOMO WSS untouched.

## Acceptance mapping

| Plan acceptance | Case | Evidence |
|---|---|---|
| gateway unreachable ⇒ `token_info` unknown + feed-loop iteration completes | (e) `Connection refused` → `("Unreac…", 0.0)`; `get_price_usd` → `None`; 3-iteration loop + `_warm_prices` complete | run #1 |
| malformed gateway body ⇒ unknown, no exception | (f) envelope LIST, HTML non-JSON, `{status:200,body:null}` all → unknown; (g) GMGN `data` non-dict → unknown (was the escaping `AttributeError`) | run #1 + #2 |
| never crash feed loop / no cache-and-lie | exception cannot escape `gmgn_info`; unknown symbol `(mint[:6]+"…", 0.0)` + 60s `_info_miss` retry unchanged | price.py diff |

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-18-request-plane-gateway.md
