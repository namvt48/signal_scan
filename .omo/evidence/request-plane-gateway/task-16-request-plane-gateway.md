# Task 16 — Python gateway client + route price.py (drop the local GMGN gate)

Plan: `.omo/plans/request-plane-gateway.md` (todo 16, line 215).
Branch/date: current branch, direct mode.

## What changed (scope: exactly 3 files)

- `watchers/common/config.py` — added the gateway client:
  - env: `GATEWAY_URL` (default `http://127.0.0.1:8130`, loopback default for the
    host Python watchers) + `GATEWAY_CALLER_TOKEN` (same two names as the api
    client, todo 14). No secret value stored.
  - `gateway_json(path, payload, timeout=20)` reuses the existing `http_json` and
    sends `Authorization: Bearer <GATEWAY_CALLER_TOKEN>` (omitted when the token
    is empty → gateway 401, fail-closed). It unwraps the pinned wire envelope
    `{status, body, headers}` (contract.ts): 2xx → `json.loads(body)`; gateway
    denial `{error}` / non-2xx upstream / empty body → raise (caller fail-opens).
- `watchers/common/price.py`:
  - GMGN (`gmgn_info`) now calls `config.gateway_json("/v1/gmgn/token-info", {ca, chain})`.
  - DexScreener (inside `token_info`) now calls
    `config.gateway_json("/v1/dexscreener", {endpoint:"tokens", params:{addresses: mint}})`.
  - REMOVED the redundant client-side GMGN gate `_GMGN_GAP_S` / `_GMGN_BAN_S` /
    `_gmgn_next_ok` (and `import uuid`, `GMGN_TOKEN_INFO`); parsing/shape unchanged.
- `scripts/test_price_gateway.py` — NEW acceptance test (stubbed loopback gateway).

NOT touched: `watchers/common/emit.py`, `rpc()` (`config.py:207`), the FOMO WSS.

## 1. Acceptance — `python3 scripts/test_price_gateway.py`

```
$ cd /home/namvt/Desktop/dev-space/signal_scan && python3 scripts/test_price_gateway.py
OK (a): gmgn_info → POST /v1/gmgn/token-info, bearer đúng, parse (BTCX, 0.00097206308)
OK (a2): QUOTE_SOURCE=gmgn → token_info đi gateway GMGN
OK (b): token_info → POST /v1/dexscreener, parse (MET, 0.3311), không đụng GMGN
OK (c): không còn _GMGN_GAP_S/_GMGN_BAN_S/_gmgn_next_ok (gateway là single writer)
OK (d): gateway 500 → 'price unknown', không raise
PASS: price gateway — GMGN + DexScreener đi qua gateway, bỏ gate client
EXIT=0
```

The stub is a real loopback `http.server` on an ephemeral port (no internet). It
records every POST and returns the raw pass-through envelope `{status, body,
headers}`. The assertions prove:

- (a) `gmgn_info("GMGNmint","sol")` POSTs `/v1/gmgn/token-info` exactly once, with
  `Authorization: Bearer watcher-test-token` and body `{"ca":"GMGNmint","chain":"sol"}`,
  and parses the returned raw GMGN body into `("BTCX", 0.00097206308)`.
  (a2) with `QUOTE_SOURCE=gmgn`, `token_info` also goes through the GMGN gateway.
- (b) `token_info(DEX_MINT)` POSTs `/v1/dexscreener` once with body
  `{"endpoint":"tokens","params":{"addresses": DEX_MINT}}` and parses the raw
  DexScreener body into `("MET", 0.3311)` — and does NOT touch the GMGN route.
- (c) no local GMGN gap timer remains: `_GMGN_GAP_S`, `_GMGN_BAN_S`,
  `_gmgn_next_ok` are all absent from the module.
- (d) a gateway upstream 500 (`{status:500, body:null}`) yields the existing
  "price unknown" (`token_info` → 0.0, `get_price_usd` → None), no raise (T18 seam).

## 2. No local GMGN gap timer — direct grep

```
$ grep -rn "_GMGN_GAP\|_GMGN_BAN\|_gmgn_next_ok" watchers/
(none)
```

## 3. Existing watcher tests touching price.py / config.py

```
$ python3 scripts/test_wallet_watch.py
... PASS: wallet_watch — qty_net / per-hop POST / rotate jsonl / phantom §4.1   EXIT=0
   (incl. `_gmgn_of` parse + `_use_gmgn` assertions — both unchanged)

$ python3 scripts/test_wallet_watch_config.py
... PASS: toàn bộ test config-from-API   EXIT=0

$ python3 scripts/test_gmgn_api_parity.py
... MUTATION GATE: 4/4 RED(FAIL)→GREEN(PASS) · ALL OK
PASS steps 29/29 · identity 29/29 · side 29/29 · amounts exact 23/29 + 6 gross   EXIT=0

$ python3 scripts/test_route_detect.py
OK: per-step route detection 18/18   EXIT=0

$ python3 scripts/test_fomo_watch.py
PASS: fomo-watch 70/70 (offline, deterministic)   EXIT=0

$ python3 -m pytest scripts/test_evm_classify.py scripts/test_evm_feed.py -q
35 passed   EXIT=0

$ python3 scripts/test_nansen_parity.py          EXIT=0  (OK: nansen_parity pure core 59/59)
$ python3 scripts/test_nansen_fee_leg.py         EXIT=0  (OK: 16/16 fee-leg cases passed)
$ python3 scripts/test_evm_isolation.py          EXIT=0
$ python3 scripts/test_ws_feed.py                EXIT=0  (OK: ws-feed 24/24)
$ python3 scripts/test_block_feed.py             EXIT=0  (OK: block-feed 16/16)
$ python3 scripts/test_rpc_resilience.py         EXIT=0  (OK: rpc-resilience 14/14)
$ python3 scripts/test_price_gateway.py          EXIT=0
```

Note: `python3 -m pytest scripts/` aborts at collection on `scripts/test_fomo_watch.py`
(`AssertionError: NETWORK SOCKET from parity...`) because that file is a script-style
hermetic test that blocks sockets at import time — pre-existing, unrelated to this
change (it passes when run directly, EXIT=0 above). Same for the other script-style
tests, which are run directly, not via pytest.

## 4. Diff (my three files only)

`git status --short` shows only `watchers/common/config.py`, `watchers/common/price.py`
(modified) and `scripts/test_price_gateway.py` (new) from this task; other modified
files in the tree belong to other todos and were not touched.

- Deleted: `GMGN_TOKEN_INFO`, `_GMGN_GAP_S`, `_GMGN_BAN_S`, `_gmgn_next_ok`, `import uuid`.
- Added: `GMGN_TOKEN_INFO_PATH = "/v1/gmgn/token-info"`, `config._gateway_url`,
  `config._gateway_token`, `config.gateway_json(...)`; GMGN + DexScreener call sites routed.

## 5. Constraints honoured

- No `emit.py`, no `rpc()`, no FOMO WSS change.
- No secret VALUE anywhere (only env var NAMES; test token is a fake literal).
- No `git add` / commit / branch / push performed.
- Wire shape/parse identical: `_gmgn_of` and `_price_from_pairs` untouched.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-16-request-plane-gateway.md
