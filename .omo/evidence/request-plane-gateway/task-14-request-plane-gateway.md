# Task 14 — TS config + wiring for GATEWAY_URL / caller token

Plan: `.omo/plans/request-plane-gateway.md` block at line 199 (todo 14).
Branch: current, direct mode. No commit made.

## Files

- `server/src/config.ts` — added `gatewayUrl: str('GATEWAY_URL','')` and
  `gatewayCallerToken: str('GATEWAY_CALLER_TOKEN','')`; added exported
  `gatewayClientFromConfig(): GatewayClient | null` (the pinned selection
  predicate: built IFF `config.gatewayUrl !== ''`, else `null`). NO loopback
  default on the TS side.
- `server/src/index.ts` — replaced the key-gated construction at `:29-30`.
  The gateway client is now built from config and passed into
  `NansenApiClient` / `GmgnMarketProvider`. Gateway set → both constructed
  REGARDLESS of key. Gateway unset → legacy key-gated path (key present →
  legacy client; key absent → `null`). `doorPostJson` fail-louds when the
  gateway is unset. Provider construction order and `createApp(provider.name)`
  unchanged. The `[index] listening` line now reports
  `nansenApi=` / `gmgnApi=` / `gateway=`.
- `server/test/gateway/config-wiring.test.ts` — NEW (5 tests).

## Command 1 — typecheck

```
$ cd server && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

## Command 2 — focused new test (verbatim)

```
$ npx tsx --test test/gateway/config-wiring.test.ts
✔ todo14: providers route to the configured gateway base URL + caller token (39.871824ms)
✔ todo14: GATEWAY_URL unset builds NO gateway client (empty, no loopback default) (2.47433ms)
✔ todo14: GATEWAY_URL set + NO keys still constructs nansen + gmgn (routes to gateway) (521.655563ms)
✔ todo14: GATEWAY_URL unset + NO key leaves the credit client null (legacy path) (497.448621ms)
✔ todo14: GATEWAY_URL unset + key builds the legacy key-gated client (gateway off) (506.516097ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
EXIT=0
```

The first test drives the REAL `NansenApiClient` + `GmgnMarketProvider` against
the config-built gateway client with a stubbed fetch, and asserts the exact
outbound URL + `Authorization` header:

```
urls == ['http://gateway:8130/v1/nansen/credit', 'http://gateway:8130/v1/gmgn/token-info']
auth == 'Bearer api-caller-token'  (both calls)
```

## Command 3 — full suite

```
$ cd server && npm test
ℹ tests 515
ℹ pass 515
ℹ fail 0
ℹ skipped 0
EXIT=0
```

Baseline was 510; +5 new tests = 515, zero failures.

## Command 4 — binary observable: real entrypoint boot, three env cases

```
$ env -u GATEWAY_URL -u GATEWAY_CALLER_TOKEN -u NANSEN_API_KEY -u GMGN_API_KEY \
    MODE=mock NANSEN_CRAWL=off DB_PATH=/tmp/t14-<port>.db SETUP_CACHE_FILE=/tmp/t14-<port>.cache.json \
    PORT=<port> [VAR=...] timeout 15 npx tsx src/index.ts | grep -m1 '\[index\] listening'
```

### Case A — `GATEWAY_URL` set, NO `NANSEN_API_KEY` / `GMGN_API_KEY`

```
2026-09-30T10:46:28.764Z INFO  [index] listening on :39321 mode=mock provider=mock nansenApi=on gmgnApi=on gateway=on chartSweep=off db=/tmp/t14-39321.db
```

`nansenApi=on` + `gmgnApi=on` with no keys → both providers CONSTRUCTED and
`gateway=on` → routing through the gateway. This is the acceptance case.

### Case B — `GATEWAY_URL` unset, NO keys (acceptance: no gateway client, key absent → null)

```
2026-09-30T10:46:43.725Z INFO  [index] listening on :39322 mode=mock provider=mock nansenApi=off gmgnApi=on gateway=off chartSweep=off db=/tmp/t14-39322.db
```

`gateway=off` → NO gateway client constructed; `nansenApi=off` → legacy
key-gated path with key absent yields `null`.

### Case C — `GATEWAY_URL` unset, `NANSEN_API_KEY` present (legacy key-gated path)

```
2026-09-30T10:46:58.785Z INFO  [index] listening on :39323 mode=mock provider=mock nansenApi=on gmgnApi=on gateway=off chartSweep=off db=/tmp/t14-39323.db
```

`gateway=off` + `nansenApi=on` → legacy path, key present → legacy client.

## Plan pins satisfied

- `gatewayUrl = str('GATEWAY_URL','')` — EMPTY when unset, no loopback default.
- Gateway-backed client built IFF `gatewayUrl !== ''`, REGARDLESS of key.
- Unset → legacy key-gated path (key present → client; absent → null).
- Provider construction order and `createApp(provider.name)` name string unchanged.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-14-request-plane-gateway.md
