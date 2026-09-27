# T2 Verdict — Nansen free app-questions door vs EVM chain slugs

**Date:** 2026-09-27 · **Plan:** `.omo/plans/evm-base-bsc.md` · **Risk:** R1
**Probe:** `scripts/probe_nansen_evm.mjs` · **Raw evidence:** `evidence/T2-nansen-evm-probe.json`

## VERDICT: BLOCKED-LOCALLY (Cloudflare + sidecar required) — R1 UNRESOLVED, must re-run on instance B

## What was probed

Exact free-door request shape from `server/src/providers/nansen.ts`:

- Endpoints: `POST https://app.nansen.ai/api/questions/tgm-essential-data` and `.../tgm-holders-gini-stats`
- Body: `{ parameters: { chain: <slug>, tokenAddress: <ca> }, filters: {}, pagination: { page: 1, recordsPerPage: 100 }, order: { order: 'desc' } }` — slug goes in `parameters.chain` (via `nansenWebChain` → `chainSlugs(chain).nansen`, `server/src/shared/chain-slugs.ts`)
- Chains: `sol`→`solana` (control, CA = USDC `EPjFW...Dt1v`), `base`→`base` (CA = USDC `0x8335...2913`), `bsc`→`bnb` (CA = WBNB `0xbb4C...095c`), plus fake slug `notachain` as unsupported-chain discriminator
- Transport (a): browser door — puppeteer-core over CDP `CRAWL_WS_ENDPOINT` (default `ws://chrome:3000`), same-origin fetch from `app.nansen.ai/token-god-mode` after `cf_clearance` (identical to `crawl.ts` `realConnect`/`inPageFetch`)
- Transport (b): plain HTTPS from node (documented fallback; `crawl.ts` header says CF blocks non-browser TLS clients)

## Results (local machine, no sidecar)

| Transport | Result |
|---|---|
| door (CDP) | `CDP endpoint unreachable: ws://chrome:3000` — no chrome sidecar exists locally |
| https | **403 Cloudflare challenge HTML for ALL 7 requests**, including the `solana` control AND the fake slug |

Key observation: the solana control — which works in production — got the same 403 HTML locally as `base`/`bnb`. The block is **transport-level (Cloudflare), not chain-level**. No signal about EVM slug acceptance can be extracted from this machine. This is the expected, acceptable BLOCKED-LOCALLY outcome per the task brief.

## Re-run on instance B (browser sidecar + proxies exist)

From the repo root on the deploy host (194.163.187.250), instance B dir `/root/signal_scan_b`, api container has `puppeteer-core` in `/app/node_modules` and reaches `ws://chrome:3000`:

```bash
cd /root/signal_scan_b
docker compose -p signal_scan_b cp scripts/probe_nansen_evm.mjs api:/app/probe_nansen_evm.mjs
docker compose -p signal_scan_b exec api node /app/probe_nansen_evm.mjs
```

(If `scripts/` was not synced by `make deploy INSTANCE=b`, first `scp scripts/probe_nansen_evm.mjs root@194.163.187.250:/root/signal_scan_b/scripts/`.)

The script auto-writes `evidence/T2-nansen-evm-probe.json` relative to its own location and prints the verdict. Note: inside the container the evidence path resolves to `/app/../evidence` — copy it out afterwards with:

```bash
docker compose -p signal_scan_b cp api:/evidence/T2-nansen-evm-probe.json evidence/T2-nansen-evm-probe.json 2>/dev/null || true
```

## How to read the instance-B output

- `base`+`bnb` → **200 with JSON payload**, solana control 200 ⇒ **SUPPORTED** — T3+ may rely on the free door for EVM gini/fresh.
- solana 200 but `base`/`bnb` → **400/404/422 with a chain-specific error** (compare against the `notachain` fake slug's error) ⇒ **UNSUPPORTED** — per plan R1: stop, reopen the gini-source decision (GMGN / drop column / Nansen paid).
- Anything else ⇒ INCONCLUSIVE — inspect the per-chain `snippet` fields in the evidence JSON.

## Constraints honored

- `nansen.ts` / `crawl.ts` / server sweep code: untouched (read-only).
- No EVM added to any server chain list.
- No keys/cookies/proxy creds in output (free door needs no apikey; URLs redacted via `//user:pass@` → `//`).
