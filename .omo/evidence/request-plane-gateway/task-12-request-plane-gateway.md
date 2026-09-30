# Task 12 — Wave 2 end-to-end route integration tests — Evidence

- Plan: `.omo/plans/request-plane-gateway.md` (todo 12)
- Commit: `test(gateway): end-to-end route integration tests`
- Branch: `feat/fomo-user-watch`

## Scope delivered
- `server/test/gateway/integration.test.ts` — boots the gateway with stubbed
  UPSTREAMS ONLY (real auth + contract + limiter + selective cache + door) and
  exercises every route through the real HTTP layer.

## Provenance
Worker session `ses_f0e26606cffe691xfp5E7zUY22` wrote
`server/test/gateway/integration.test.ts`, then crashed at its final report turn
with the known provider fault (`The content[].thinking in the thinking mode must
be passed back to the API`). The orchestrator re-ran the verification below
against the on-disk tree and recorded this evidence.

## Verification

### `cd server && npx tsc --noEmit`
exit 0.

### `npm test`
```
ℹ tests 510
ℹ pass 510
ℹ fail 0
```

### integration specs (verbatim)
```
✔ route matrix: /health is public; /metrics and every /v1 route need a caller bearer
✔ /v1/proxy forwards the byte-verbatim raw body through the real limiter; a malformed contract is a 400
✔ selective cache: 2 identical CROSS-CALLER DexScreener requests → 1 upstream call (17.5677ms)
✔ selective cache: 2 identical SAME-CALLER Nansen token-information requests → 1 upstream call (16.719058ms)
✔ selective cache: 2 identical CROSS-CALLER Nansen credit requests → 2 upstream calls (18.698326ms)
✔ GMGN exception: 2 identical requests → 2 upstream calls and the cache stays empty (18.426812ms)
✔ /v1/nansen/door passes the app-question through the door seam and maps its status
✔ 429 propagation: a GMGN 429 rides the 200 envelope, arms the gate, then the next call is 503 gated (30.256113ms)
✔ 429 propagation: both DexScreener classes surface the upstream 429 (no gate, no retry) (15.370759ms)
✔ 429 propagation: a Nansen credit 429 surfaces after the real limiter retry (no swallow) (13.638212ms)
```

## Acceptance mapping
- 1 upstream call for 2 identical CROSS-CALLER DexScreener requests. PASS
- 1 upstream call for 2 identical SAME-CALLER Nansen token-information requests. PASS
- 2 calls for 2 identical CROSS-CALLER Nansen credit requests. PASS
- 2 calls for 2 identical GMGN requests (never cached). PASS
- 429 propagation for ALL limiters (GMGN arms the gate → 503; DexScreener surfaces;
  Nansen credit surfaces after the real retry — no swallow). PASS

## Notes
- The limiter and cache are NOT stubbed — only the network upstreams (injected
  `*Upstream` deps). The route matrix re-asserts public `/health` vs bearer-gated
  `/metrics` + `/v1/*`, and `/v1/proxy` byte-verbatim forwarding + 400 on a bad
  contract.
- No gateway bug surfaced; the integration spec passes against the as-built src.

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-12-request-plane-gateway.md
