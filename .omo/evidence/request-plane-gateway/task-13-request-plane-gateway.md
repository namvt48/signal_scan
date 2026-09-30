# Task 13 — Point TS provider transports at the gateway

Plan: `.omo/plans/request-plane-gateway.md` block `- [ ] 13.` (line 191).
Scope: `server/src/providers/{nansen,gmgn,dexscreener}.ts`, `server/src/index.ts`,
`server/src/poller.ts`, `server/src/gateway-client.ts` (new), named tests.

## What changed

- NEW `server/src/gateway-client.ts`: `GatewayClient` (injectable `{baseUrl, callerToken}`,
  POST → unwrap `{status, body, headers}` envelope, throw `HttpError` on a gateway denial) +
  route-path constants + `gatewayClientFromEnv()` (env stopgap `GATEWAY_URL`/`GATEWAY_CALLER_TOKEN`,
  NO loopback default).
- `providers/nansen.ts`: `NansenApiClient.post` now POSTs to `/v1/nansen/credit` via the gateway
  (`{endpoint, body, priority:1}`); removed the local `limiters.run('nansen-credit', …)` + `postOnce`;
  DROPPED `creditSpend`/`creditsSpent()`/`resetCreditsSpent`; exported `doorEndpointFor(url)`
  (URL→door endpoint map) so `index.ts` can drive the free door through the gateway.
- `providers/gmgn.ts`: `fetchTokenInfo` POSTs to `/v1/gmgn/token-info` (`{ca, chain, priority}`);
  dropped `X-APIKEY` SEND, `randomUUID`, `gmgnChain`, and the local `limiters.run('gmgn', …)`.
  `key` ctor param kept accepted-but-ignored (`void this.apiKey;`).
- `providers/dexscreener.ts`: `fetchIcons` POSTs to `/v1/dexscreener`
  (`{endpoint:'tokens', params:{addresses}, priority:2}`); dropped local `limiters.run('dexscreener', …)`
  and the unused `timeoutMs` param (gateway owns timeouts); never-throw skip-and-continue preserved.
- `index.ts`: dropped `import { browserPostJson } from './crawl.js'`; the door `PostJson` now calls
  `gateway.call(GW_NANSEN_DOOR_PATH, {endpoint, body})`. Per the pin, the GMGN key-gated construction
  (`config.gmgnApiKey ? new GmgnMarketProvider(...) : null`) is GONE → `gmgnApi` is built unconditionally.
  NOTE/conflict: the `nansenApi` key gate at `:29` was intentionally LEFT as-is — plan todo 14
  explicitly owns the `index.ts:29-30` gate rewrite + the `gatewayUrl !== ''` predicate.
- `poller.ts`: dropped `creditsSpent` import (`:42`) and the now-dead credit-delta log lines
  (`:401/435` setupSweep, `:651/659` flowsSweep). Poller call sites unchanged.

Untouched (per plan): `providers/solana.ts`, `providers/evm.ts`, `crawl.ts`, `gateway/*`.

## Acceptance evidence

### 1. `npx tsc --noEmit`

```
$ cd server && npx tsc --noEmit; echo "TSC_EXIT=$?"
TSC_EXIT=0
```

### 2. `npm test` (full suite)

```
$ cd server && npm test 2>&1; echo "TEST_EXIT=$?"
...
ℹ tests 510
ℹ suites 0
ℹ pass 510
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31750.558301
TEST_EXIT=0
```

Baseline was 510 → still 510, now including the changed/added tests below.

### 3. Named test changes — focused run (verbatim)

```
$ npx tsx --test --test-name-pattern="currentBalance|tokenFlows|live chart path|429 becomes an HttpError" \
    test/nansen.test.ts test/tgm-flows.test.ts test/gmgn.test.ts
✔ GmgnMarketProvider: a 429 becomes an HttpError so the layer can gate (47.91067ms)
✔ NansenApiClient.currentBalance: gateway URL + envelope unwrap + data[0] parse (9.978659ms)
✔ tokenFlows: ONE gateway request, per_page 1000, no order_by/filters (51.461029ms)
✔ live chart path: refreshSeries → seriesAtRung fetches through the gateway (16.185276ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

- `test/nansen.test.ts:4` — `creditsSpent, resetCreditsSpent` import DELETED (ESM load would fail otherwise).
- `test/nansen.test.ts` creditsSpent test REMOVED alongside the dropped counter.
- `test/nansen.test.ts` `currentBalance` test REWRITTEN: asserts URL `http://gateway:8130/v1/nansen/credit`,
  envelope `{status, body, headers}` unwrap, `endpoint=/api/v1/profiler/address/current-balance`,
  inner `body.{chain,filters,pagination}`, `priority=1`.
- `test/nansen.test.ts:524` `class RecordingApi extends NansenApiClient` + `new RecordingApi('key')`
  still compile and pass (full suite green).
- `test/tgm-flows.test.ts` `tokenFlows` test REWRITTEN: `bodies[0].pagination` now read from the
  envelope's inner `body`; asserts gateway URL + `endpoint=/api/v1/tgm/flows`.
- `test/tgm-flows.test.ts` NEW `live chart path` test: `refreshSeries` → `seriesAtRung` with
  `setPollerDeps(stubProvider, new NansenApiClient('test-key', gateway))`; asserts every call goes to
  `http://gateway:8130/v1/nansen/credit`.
- `test/gmgn.test.ts:127-143` — UNCHANGED; the ctor `new GmgnMarketProvider('k')` still compiles and the
  test passes (429 → `HttpError(429)`).

### 4. Greps

```
$ grep -rn "limiters.run(" src/providers/nansen.ts src/providers/gmgn.ts src/providers/dexscreener.ts
NONE

$ grep -rn "limiters.run(" src/providers/solana.ts
202:    return limiters.run('solana-rpc', { priority: 1 }, async () => {
count=1

$ grep -n "browserPostJson" src/index.ts
NONE
```

`crawl.ts` still imports/re-exports `browserPostJson` from `gateway/door.js` (untouched, expected).

## Notes / conflicts

- `providers/solana.ts:202` keeps the only remaining local `limiters.run` (RPC stays local) — confirmed count=1.
- `index.ts:29` `nansenApi` key gate deliberately NOT changed: plan todo 14 owns that line + predicate.
- `index.ts:30` GMGN key gate removed per the task pin.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-13-request-plane-gateway.md
