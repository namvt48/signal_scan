# Free Solana RPC: which transport a free tier can actually carry

Research date: **2026-09-17**. Scope: decide between `--feed block` (whole-chain
`getBlock`) and `--feed ws` (`logsSubscribe {mentions:[wallet]}` + periodic
`getSignaturesForAddress` sweep) for `scripts/wallet_watch.py`, and which free
endpoint to pin.

Method: community sources (GitHub issues, StackExchange, provider docs, status
pages, vendor-neutral benchmark sites) + one bounded first-party probe from this
VPS. Reddit's thread body is **not** available — Reddit returns HTTP 403 to
non-logged-in fetches (see §7). Claims that only exist in Reddit's blocked body
are marked as such.

---

## 1. Bottom line

**Switch the production watcher to `--feed ws`.**

Whole-chain `getBlock` scanning on a free tier is not a tuning problem, it is a
hard physical ceiling (§3). Per-wallet `logsSubscribe` for a handful of wallets
is the only free-viable transport, and it is already working in this repo
(`evidence/wallet_watch_ws.txt` shows two live detections on 2026-09-11 via
`feed=ws`).

Pin order for `--feed ws`:

1. **Helius free** (`wss://mainnet.helius-rpc.com/?api-key=…`) — the only free
   tier with *documented* WebSocket limits, so it is the only one you can design
   against. 5 concurrent connections, 10-minute idle timer, 1M credits/month.
2. **PublicNode** (`wss://solana-rpc.publicnode.com`) — free, no key, no
   documented limits; usable as fallback but treats multi-MB payloads badly
   (see §5).
3. `api.mainnet-beta.solana.com` — last-resort only, for the HTTP sweep, never
   for WS.

Endpoints to **stop using**:

- **Ankr free** — no WebSocket at all on Public or Freemium tiers.
- **dRPC free for Solana** — free tier contradicts itself across sources and
  blocks batches >3; see §4.3.
- **Whole-chain `getBlock` on any free endpoint** — §3.

---

## 2. What the official limits actually are (and why 403 happens)

Solana Foundation documents the public mainnet endpoint limits
(<https://solana.com/docs/references/clusters>):

> - Maximum number of requests per 10 seconds per IP: 100
> - Maximum number of requests per 10 seconds per IP for a single RPC: 40
> - Maximum concurrent connections per IP: 40
> - Maximum connection rate per 10 seconds per IP: 40
> - Maximum amount of data per 30 seconds: 100 MB

and is explicit about the consequences:

> The public RPC endpoints are not intended for production applications. Please
> use dedicated/private RPC servers when you launch your application, drop NFTs,
> etc. The public services are subject to abuse and rate limits may change
> without prior notice. Likewise, high-traffic websites may be blocked without
> prior notice.

> - 403 -- Your IP address or website has been blocked. It is time to run your
>   own RPC server(s) or find a private service.
> - 429 -- Your IP address is exceeding the rate limits. Slow down! Use the
>   `Retry-After` HTTP response header to determine how long to wait.

Note the docs now list `https://api.mainnet.solana.com`; `api.mainnet-beta.solana.com`
still answers (verified in §6). The 403 response is a **block**, not a throttle.
StackExchange has the exact body:

> `403` — `{"jsonrpc":"2.0","error":{"code": 403, "message":"Access forbidden, contact your app developer or support@rpcpool.com."}}`
> — <https://solana.stackexchange.com/questions/4576/>

The important nuance from the same thread:

> The public mainnet beta endpoints aggressively block requests with a CORS
> header, meaning requests from a browser. When you run it with Python, those
> CORS headers aren't present, so the endpoints are more permissive.

So a headless Python script is *less* likely to be 403'd than a browser, but the
403 is still IP/abuse based and permanent-until-changed. Also note: the limits
are enforced per-method *and* per-connection, not just per-second:

> You can still get 429 Too Many Requests even if you add sleep(), because Solana
> RPC enforces multiple limits (rate, concurrency, per-method)
> — <https://solana.stackexchange.com/questions/12906/>

Response headers expose the budget: `X-Ratelimit-Conn-Limit`,
`X-Ratelimit-Method-Limit`, `X-Ratelimit-Rps-Limit`, `X-Ratelimit-Tier`
(same thread).

---

## 3. Why transport A fails on free — the arithmetic

This repo already measured the per-block cost
(`docs/2026-09-15-gmgn-parity-and-block-feed.md` §5):

> - Local: p50 **1085ms**, p95 **2274ms**, **12.6MB** mỗi slot.
> - Server: trung bình **698ms** mỗi block, **9.66MB** mỗi slot (p50 691ms, p95 929ms).
> - **0** lần 413, **0** lần 429, **0** timeout.
> ...
> single-thread mất khoảng 0.7 đến 1.2 giây mỗi block, trong khi slot chỉ khoảng
> 0.4 giây.

Now apply the documented 100 MB / 30 s data cap:

```
public data cap      = 100 MB / 30 s        = 3.33 MB/s
observed block size  = ~7–10 MB             (jsonParsed + full)
=> sustainable rate  = 3.33 / 8             ≈ 0.42 blocks/s
required rate        = 1 / 0.4 s slot       = 2.50 blocks/s
=> coverage ceiling  ≈ 0.42 / 2.50           ≈ 17 %
```

**17 % is the ceiling, not a bad run.** The observed 13–40 % coverage is that
ceiling plus timing luck. It is also latency-bound independently of bandwidth:
one request per block at 0.68–0.91 s already caps you near 44–59 % even with
unlimited bandwidth. And the ceiling is *shrinking*: Solana cut mainnet slot
times from 400 ms to 350 ms in Aug 2026, with a 300 ms feature gate on mainnet
(<https://solana.com/> changelog, 2026-08-20 and 2026-08-27). A 350–300 ms slot
raises the required rate to 2.9–3.3 blocks/s.

Parallel requests do not rescue it: the 100 MB/30 s cap is per IP, and 40
concurrent connections will not raise a byte budget. This is why the local doc
already concludes:

> **khuyến nghị dùng RPC trả phí khi vận hành hơn khoảng 10 ví** để tránh lag-gap
> và 429.

and why the wider community says the same thing:

> For real-time apps, avoid RPC polling; use Geyser gRPC or managed streams.
> — <https://dev.to/onfinality/solana-indexer-diy-vs-managed-choosing-your-data-pipeline-16c5>

> We don't run a proxy... Solana's block rate makes them expensive to run —
> they're fine for a wallet, not for a bot.
> — <https://swiftnodes.io/blog/solana-rpc-429-rate-limits>

Vendor-neutral confirmation that the free field is thin: OpenChainBench, which
probes keyless endpoints every 60 s, states that as of 2026-09-17 only **five**
Solana endpoints still answer without a key:

> The 5 providers on this page: Solana Labs (api.mainnet-beta.solana.com),
> PublicNode, Lava, LeoRPC (publicly documented FREE key) and Solana Vibe
> Station. ... dRPC moved Solana to paid tiers, Ankr returns 403 without a key,
> OnFinality's shared public quota is permanently exhausted, Helius and Shyft
> are key-gated.
> — <https://openchainbench.com/benchmarks/solana-rpc>

Caveat: OpenChainBench probes `getSlot` (27 ms leader), not `getBlock`. `getSlot`
latency says nothing about multi-MB block throughput — do not read it as
"free Solana is fast".

### Verdict on A

Whole-chain scanning is a **paid or self-hosted** workload. Free options:
none. Cheapest real options: a paid RPC with enough RPS for `getBlock`, or
Yellowstone gRPC (Triton/Helius/Alchemy/Chainstack), or run a node.

One unverified free lead worth a 1-hour probe: PublicNode advertises a
**mainnet Yellowstone gRPC** endpoint. Its homepage lists "RPC · WS RPC ·
Yellowstone GRPC" for Solana, and
`solana-mainnet-yellowstone-grpc.publicnode.com:443` resolves and has port 443
open (probed 2026-09-17). No documentation, no published limits, no community
reports found — treat as unverified. If it works, an `account_include` filter
would replace both transports.

---

## 4. Free-tier provider-by-provider

### 4.1 Helius (free) — best documented WS, but note the metering

- WebSocket connection cap: "On the Free plan, you can make 5 simultaneous
  WebSocket connections."
  — <https://www.helius.dev/docs/faqs/websockets>
- Idle timer: "Websockets have a 10-minute inactivity timer; implementing health
  checks and sending pings every minute is heavily recommended to keep the
  websocket connection alive."
  — <https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe>
- `logsSubscribe` is available on all plans: "Standard Solana methods like
  `programSubscribe`, `logsSubscribe`, and `signatureSubscribe` are available on
  all plans."
  — <https://www.helius.dev/docs/rpc/websocket>
- **Gotcha:** WS is billed by data volume, not per notification: "WebSocket
  usage is metered at 2 credits per 0.1 MB of uncompressed streamed data."
  Same page. At 1M credits/month that is ~50 MB of streamed data per month.
  For a `mentions` filter on a handful of wallets (log payloads are
  ~500–2000 bytes each) that is generous; for an unfiltered or program-wide
  subscription it is not.
- Free plan size: 1M credits/month, 10 RPS
  (<https://docs.rpcplane.dev/guides/free-tier/>, corroborated by
  <https://coinsaga.com/news/technology/best-free-solana-rpc-node-providers-in-2026-top-5-options-for-developers/>).
- **Contradiction to weigh:** Helius' own team says WS is not production-grade:
  "we've found them to be quite brittle and unreliable in practice. It is very
  strongly recommended that you do not use them for mission-critical workflows
  as you will miss events."
  — <https://www.helius.dev/blog/solana-data-streaming>
  That is consistent with keeping the `getSignaturesForAddress` sweep as a
  reconciliation pass, which the current design already does.

### 4.2 PublicNode (free) — works, no limits published, weak on big payloads

- No key, no account. Homepage offers "RPC · WS RPC · Yellowstone GRPC".
- Limits: unpublished. "PublicNode does not publish exact rate limits. They are
  subject to change and are shared across all users."
  — <https://onfinality.io/en/rpc-assistant/publicnode-solana-rpc-endpoint>
  The same page warns "WebSocket disconnects: Free WebSocket endpoints may drop
  connections. Implement reconnection logic."
- Positive field report: "`solana-rpc.publicnode.com` — free, no API key, and it
  does not aggressively rate limit. It has been stable for two weeks with no
  403s." — <https://moltbook.com/post/60eb17be-4363-4c66-8bbc-adbd1e51845c>
- Another field report: "I've been running a script for hours and still not rate
  limited ... plus feels so much faster than helius"
  — r/solana `1idonhb` (title/OP body only; thread body inaccessible, §7).
- **This repo's own counter-evidence** — PublicNode is the endpoint that hurt
  the block feed:
  - `scripts/wallet_watch.py:253` — "publicnode/Cloudflare cụt getBlock lớn"
    (PublicNode/Cloudflare truncates large `getBlock` bodies).
  - `scripts/test_rpc_resilience.py` — "Prod thật: publicnode (Cloudflare) cụt
    body getBlock lớn ⇒ http_json raise".
  - `scripts/wallet_hist.py:36` — "publicnode trả history cụt, không báo lỗi"
    (returns truncated history **without an error**).
  - `scripts/wallet_watch.py:1033` — PublicNode with
    `maxSupportedTransactionVersion=0` gave "20/20 slot chết -32015".
  Both failure modes are silent-corruption shaped, which is worse than a clean
  429. So: PublicNode is acceptable for small WS payloads, not for multi-MB
  `getBlock`.

### 4.3 dRPC (free) — contradictory; do not pin

Three sources disagree, which by itself is the finding:

- dRPC's own Solana docs: "By signing up for a free dRPC account, you can access
  their Premium Solana RPC endpoints."
  — <https://drpc.org/docs/solana-api>
- OpenChainBench: "dRPC moved Solana to paid tiers."
- A July 2026 review: "when verified on July 8, 2026, the Solana chainlist page
  also displayed a temporary message saying the HTTPS and WSS endpoint fields
  were unavailable due to no active nodes."
  — <https://coinsaga.com/news/altcoin-news/drpc-solana-rpc-review-2026-free-plan-and-features/>
  The same review lists the free plan as $0 / 210M CU / 30 days / public nodes
  only / 100 RPS.
- dRPC's free-tier error table (its own skill repo) documents hard blocks:
  "| 47 | 403 | Batch >3 not allowed on free tier |", "| 46 | 408 | Free tier
  timeout | Request took too long on free tier. Upgrade for faster responses |",
  "| 53 | 403 | Free monthly limit reached |", "| 51 | 400 | Paid feature only |"
  — <https://github.com/drpcorg/drpc-agent-skills/blob/main/skills/drpc-rpc/errors.md>
- WS is CU-metered per event: "Subscription: 20 CU / Notification: 20 CU"
  — <https://drpc.org/docs/pricing/subscriptions/solana>

dRPC Solana free is a *maybe* at best; a free-tier timeout error code is
disqualifying for a latency-sensitive watcher.

### 4.4 Ankr — free tiers have **no WebSocket**

Ankr's own plan matrix is unambiguous:

> Connection | HTTPS | HTTPS | HTTPS and WebSocket
> (Public | Freemium | Premium)
> — <https://www.ankr.com/docs/rpc-service/service-plans/>

and the matching error: "| `-32092` | 403 | WebSocket is disabled | WebSocket
isn't enabled for this key. |"
— <https://www.ankr.com/docs/rpc-service/errors/overview/>

Cost if you did pay: "Solana | all methods | 500 API Credits" (same plans page);
Freemium is 200M credits/month → ~400k Solana calls/month. Public tier is
~1800 req/min guaranteed. Ankr also caps Solana ledger retention at ~100M slots
(~16 h) — "Requests via `getTransaction`, `getBlock`, `getSignaturesForAddress`,
etc. for slots older than this window will return `null` or an error."
— <https://www.ankr.com/docs/rpc-service/chains/chains-api/solana/>
The sweep on Ankr would silently go empty for anything older than ~16 h.

**Ankr free is out for transport B.**

### 4.5 Other free tiers (for completeness)

| Provider | Free allowance | RPS | WS on free? | Note |
|---|---|---|---|---|
| Alchemy | 30M CU/mo, renews | 25 | yes | <https://docs.rpcplane.dev/guides/free-tier/> |
| Chainstack | 3M RU/mo, 1 node | 25–30 | **yes, documented** | "1 node, WebSockets ... No time limit" — <https://coinsaga.com/news/technology/chainstack-solana-rpc-review-2026-free-plan-and-features/> |
| QuickNode | 10M credits, **once** (trial) | 15 | yes | "Does not sell overage; the endpoint stops when credits run out" — <https://docs.rpcplane.dev/guides/free-tier/> |
| Helius | 1M credits/mo | 10 | yes (5 conns) | §4.1 |
| OnFinality | 400K RU/day (~6M/mo) | 40 RU/s = 20 calls/s | yes | 2 RU per Solana call |
| Ankr | 200M credits/mo (freemium) | public-tier | **no** | §4.4 |

Chainstack free is the sleeper alternative: 3M RU/month, 25 RPS, and WebSockets
explicitly included on the free Developer plan. If Helius' 1M-credit cap or
5-connection cap bites, Chainstack is the documented fallback.

---

## 5. `logsSubscribe` for wallets — mechanics and gotchas

Official constraint that shapes the design:

> The `mentions` filter currently supports exactly one address. Listing more
> than one returns an `Invalid params` error.
> — <https://solana.com/docs/rpc/websocket/logssubscribe>

So N wallets = N subscriptions, not one subscription with N addresses. Those
N subscriptions can share one TCP connection, but providers cap total
subscriptions per connection — and when you exceed it, the failure is a silent
socket kill. From `solana-web3.js` issue #3381:

> So your provider nuked your connection, without warning, without a reason, and
> without due process. [close code 1006]
> ...
> Almost certainly what's happening is that `walletsToTrack` is too large, and
> your provider is refusing to allow you to make that many subscriptions over a
> single channel.
> — <https://github.com/solana-labs/solana-web3.js/issues/3381>

Idle-kill behavior differs by provider:

> Public RPC kills idle connections after 30 seconds; private providers hold them
> indefinitely. ... We send a ping every 25 seconds and expect a pong; missing
> pongs are the cleanest disconnect signal in your client logs.
> — <https://nolimitnodes.com/products/wss-nodes>

Redundancy is not optional:

> Notifications are not guaranteed to be lossless; implement your own
> reconciliation if needed.
> — <https://onfinality.io/en/learn/solana-rpc-websocket-guide>

> Reliability | Medium (rate limits, retries) | Low–Medium (fragile connections) | High
> (RPC polling | native RPC WebSockets | Yellowstone gRPC)
> — <https://blog.triton.one/complete-guide-to-solana-streaming-and-yellowstone-grpc/>

That table is the whole argument for keeping the sweep: WS is rated *less*
reliable than polling. The `--feed ws` design already pairs the subscription with
a periodic `getSignaturesForAddress` sweep, which is exactly the right shape.

### Verdict on B

`--feed ws` is the correct free-tier transport for a handful of wallets. Required
hardening, all of it cheap:

1. Ping every ≤60 s (Helius enforces a 10-minute idle timer; PublicNode may kill
   at 30 s). Treat a missed pong as a dead socket.
2. Reconnect with exponential backoff + jitter, and **resubscribe** — Solana
   subscriptions do not survive reconnect.
3. Sweep `getSignaturesForAddress` after every reconnect, keyed off a stored
   watermark. WS is not lossless.
4. One `logsSubscribe` per wallet (`mentions` takes exactly one address).
5. Keep `maxSupportedTransactionVersion=1`. The local doc already records that
   ver=0 killed 20/20 slots on PublicNode with `-32015`; note Agave 4.2 will
   introduce transaction v1 and break `getBlock`/`getTransaction` callers that
   do not declare support — keep the parameter current.
6. Do not put the GMGN oracle call in the watch loop (already documented in
   `docs/2026-09-15-...md` §6: IP ban after ~5 rapid calls).

---

## 6. First-party probe, 2026-09-17

Single `getBlock` with `encoding=jsonParsed, transactionDetails=full,
maxSupportedTransactionVersion=1, rewards=false` (the watcher's shape), from
this VPS:

| Endpoint | `getSlot` | `getBlock` time | payload | result |
|---|---|---|---|---|
| `https://solana-rpc.publicnode.com` | 252 ms | **676 ms** | **6.26 MB** (1147 txs) | valid JSON, no truncation |
| `https://api.mainnet-beta.solana.com` | 276 ms | **911 ms** | **7.80 MB** (1216 txs) | valid JSON, no truncation |

Observations:

- Both endpoints answered a multi-MB `getBlock` from a datacenter/VPS IP with
  **no 403 and no 429** today. The 403 problem is real but it is *abuse/IP*
  triggered, not blanket datacenter blocking — this IP is currently clean.
- Neither block was truncated on these two calls. PublicNode truncation is
  therefore *intermittent*, consistent with this repo's "Cloudflare cụt" note
  rather than a permanent condition.
- Payload varies a lot: 6.3–7.8 MB here vs 9.66 MB average in this repo's own
  20-slot sample. Budget for the average, not the sample.
- 676–911 ms per block against a ~400 ms slot confirms the single-thread
  shortfall in §3 independently.

---

## 7. Contradictions and thin evidence (stated explicitly)

1. **Reddit is unreadable.** `reddit.com/...json` returns HTTP 403; `r.jina.ai`
   proxy returns the same 403; `old.reddit.com` 302s. The r/solana stress-test
   thread `1rjkj3z` ("I ran consistent stress tests on free Solana RPC plans",
   2026-03-03) only yielded its intro via search cache. **Its per-provider
   numbers are the single biggest gap in this report** and could not be
   verified. If any provider ranking is load-bearing for the decision, ask
   someone with a Reddit login to export that thread before trusting Reddit
   consensus.
2. **dRPC free tier for Solana is genuinely ambiguous** — "moved to paid" vs
   "free account gives premium endpoints" vs "no active nodes" (§4.3). Treat as
   unstable, not as a viable pin.
3. **PublicNode is simultaneously "stable for two weeks, no 403s" and "truncates
   large getBlock bodies silently."** Both are credible: it behaves for small
   calls and misbehaves for multi-MB payloads. Do not use it as the primary
   `getBlock` endpoint.
4. **Ankr marketing vs Ankr docs.** "200M free API credits" oversells a tier
   whose own matrix has no WebSocket and whose Solana retention is ~16 h.
5. **Free-tier RPS numbers come mostly from aggregators** (rpcplane, coinsaga),
   not provider pages. Treat ±50 % as the error bar.
6. **Benchmarks are vendor-owned.** The only numbers comparing providers on
   `getBlock` came from vendor blogs (Helius' own dashboard:
   `getBlock` p50 Helius 189 ms / QuickNode 263 ms / Alchemy 705 ms /
   Chainstack 779 ms / Triton 995 ms — <https://www.helius.dev/benchmarks>).
   The Solana Foundation's neutral dashboard (launched 2026-07-30 at
   solana.com/data) probes `getBlock` but "does not issue a ranking or declare a
   winner"
   (<https://solanacompass.com/news/solana-foundation-launches-official-rpc-performance-dashboard-at-solanacomdata>).
   No neutral provider-vs-provider `getBlock` benchmark was found.
7. **PublicNode's mainnet Yellowstone gRPC endpoint is undocumented.** Existence
   verified (DNS + port 443 open), behavior and limits unverified. Not evidence
   of usability.

---

## 8. Concrete recommendation

```
--feed ws
primary   wss://mainnet.helius-rpc.com/?api-key=$HELIUS_KEY     # 5 conns, ping < 60s
fallback  wss://solana-rpc.publicnode.com                        # no key, ping < 30s
sweep     https://solana-rpc.publicnode.com   (small calls)  →  api.mainnet-beta only if publicnode 429s
```

- Keep `--feed block` available for backfill/debug, but do not run it as the
  production feed on a free endpoint — §3 shows it cannot exceed ~17–45 % and
  the slot time is still shrinking.
- If whole-chain coverage is genuinely required, the choices are: paid RPC with
  headroom for ~3 `getBlock`/s, Yellowstone gRPC, or a self-hosted node. There is
  no free path, and no community report of anyone running a whole-chain scanner
  on a free tier was found in this research.
- Optional 1-hour spike: probe
  `solana-mainnet-yellowstone-grpc.publicnode.com:443` with a `transactions`
  filter (`account_include: [wallet]`). If it answers, it replaces both
  transports for this use case. Unverified.
