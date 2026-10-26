# signal_scan

CT alpha-signal dashboard for memecoin tracking: token signal table (framework01), tracked-wallet management with CSV import/export, and a CA tracking queue.

UI-first: all data comes from a swappable service layer (`src/services/dataStore.ts`) backed by localStorage with mock seed data. The real API layer (Birdeye + GMGN pipeline, see docs/) will replace this implementation later without touching any component.

## Stack

Vite · React 18 · TypeScript (strict) · Tailwind CSS v4

## Dev

```bash
npm i
npm run dev       # dev server
npm run build     # tsc + vite -> dist/
npm run preview   # serve the production build locally
```

## CSV format

Header is `address,name,tags,chain,source` with an OPTIONAL trailing `clan` column (legacy 5-column files still import).

- `tags`: multiple tags inside one cell, separated by `;`
- `chain`: one of `sol`, `base`, `bsc`
- `clan` (optional): display-only label shown beside the wallet name (Wallet tab and the "Tracked by" rows). It never filters or routes anything.
- Rows with an empty address or an unknown chain are skipped and shown with a reason in the import preview before committing.

Example:

```csv
address,name,tags,chain,source,clan
0x6A2f9C4e1B7d3F8a5E0c2D6b9A4f7C1e3D5b8E2a,CT01,sniper;fresh-wallet,sol,gmgn,a
Fg9xK2mR7qT4vBn8cLd3Ws6Za1Py5Ue9HjA,CT03,whale,sol,birdeye,b
```

## Deploy (Docker)

```bash
docker build -t signal_scan .
docker run -d -p 8080:80 --name signal_scan signal_scan
# open http://<vps-ip>:8080
```

## Production deployment

Production runs as a single dashboard instance at <https://signal-scan.duckdns.org/> on `root@167.86.101.228`. The API and web bind to loopback port `8124`; Caddy is the public HTTPS entry point. Deploy with `make deploy INSTANCE=a DOMAIN=signal-scan.duckdns.org SHOW_FOMO=on`, then `make up` with the same instance settings.

Solana tracked wallets, EVM wallet groups, and FOMO users/trades/holdings share the A database. `SHOW_FOMO=on` enables the FOMO surface; it does not exclude Solana or EVM data. The gateway, monitor, public API, and host watchers use the single A API upstream. Keep the retired B directory and database for rollback; do not start its API while the merged deployment is active.

`scripts/merge_instance_data.py` merges B data into A. Back up both SQLite databases with the SQLite backup API before migration; the script itself uses WAL-safe snapshots and supports `--dry-run`. The migration reassigns B alert IDs in A's feed timeline; public alert consumers must discard old cursors and start from the new feed. Never run the merge against a live writer.

## Host monitoring dashboard

`make monitor-restart` updates the private monitor at `127.0.0.1:8126`; the separate public monitor dashboard is at <https://signal-scan.duckdns.org:8443/>. The dashboard, `/api/snapshot`, and `/api/history` expose service health plus provider usage and balance telemetry. Keep that data public only if acceptable. `MONITOR_API_TOKEN` remains private in `/root/signal-scan-monitor/monitor.env` (mode `0600`) and authenticates internal scraping and the A/FOMO alert feeds.

Telegram alert thresholds are configured separately for Dashboard (`market` + `wallet` origins) and FOMO (`fomo` origin). Both rulesets are served by the merged API and retain independent settings. The periodic Dashboard scan uses the same merged token data. Legacy Solana suppression on the former FOMO instance no longer applies.



The FOMO series shows request/outcome counters for the free prod bridge (`/balances`, `/swaps`), not a credit balance. Nansen shows the gateway's internal daily budget ledger, not an upstream account balance. GMGN has no integrated balance API, so it reports successful calls by configured key; RPC providers report per-endpoint request/error counts and observed quota exhaustion, not credit balances.


## Deploy (plain static hosting)

```bash
npm run build
```

Serve `dist/` with any web server. SPA fallback is required (unknown paths must serve `index.html`); see `nginx.conf` for a ready-made config with gzip and immutable caching for hashed assets.

## API swap

Components never touch localStorage directly; they only call `dataStore` from `src/services/dataStore.ts`, which implements the `DataStore` interface (async methods). To go live, re-implement that interface with `fetch()` calls against the alpha engine API. No component changes needed.

## Standalone read-only API

Configure a random `PUBLIC_API_EXPORT_TOKEN` in the backend's `server/.env` and the same value in `server/public-api.env` (copied from `server/public-api.env.example`). This credential is private between the public API service and the backend; external clients do not use or receive it. Keep both files secret.

`PUBLIC_API_INTERNAL_URL` and `PUBLIC_API_FOMO_INTERNAL_URL` in `server/public-api.env` both point to the merged A API (`http://signal-scan-api-a:3001`). The FOMO routes use the same private export credential and merged database as the main API; do not configure instance B as an upstream. `PUBLIC_API_PORT` defaults to `3010`. External callers do not need an API key or Bearer token.

Generate the internal credential with `openssl rand -hex 32`.

Lifecycle on the configured host:

```bash
make public-api-deploy        # initial enable; instance A only
make public-api-status
make public-api-logs
make public-api-down          # stop only the public API container
make public-api-up            # re-enable without restarting the dashboard
```

The service binds `127.0.0.1:3010`; instance A's Nginx routes `/api/v1/` over the private Docker network and the existing HTTPS domain. First deployment rebuilds/recreates the backend and web proxy to install the private export route. Later `public-api-down` only stops the standalone service, so dashboard API/login remains active while public API requests return `502` until the service starts again.
Endpoints: `GET /api/v1/tokens`, `/tokens/{chain}/{address}`, token `/market`, `/metrics`, `/history`, `/detail`, `/balance-chart`, `/activity`, `/api/v1/alerts`, `/api/v1/wallets`, `/wallets/{id}/trades`, `/api/v1/fomo/tokens`, `/fomo/tokens/{chain}/{address}`, `/fomo/tokens/{chain}/{address}/users`, `/fomo/alerts`, `/fomo/users`, `/fomo/users/{id}/trades`, `/fomo/users/{id}/positions`, `/fomo/wallets`, `/fomo/wallets/{id}/trades`, `/api/v1/chains`, `/api/v1/tiers`, `/api/v1/status`, plus WebSocket streams at `/api/v1/ws` and `/api/v1/fomo/ws`. All endpoints are unauthenticated. Alerts report retention gaps because the internal feed may prune acknowledged rows. Token, wallet, FOMO-token, FOMO-wallet, and FOMO-user lists use offset pagination; trades and alerts use IDs. The service applies one shared per-process limit of 120 requests per minute and a 16-request concurrency cap.

This service exposes wallet addresses, wallet-watch trades, FOMO users, FOMO tokens, FOMO alerts, FOMO wallets, FOMO trades, positions, and measured holdings publicly. It uses the existing HTTPS proxy and binds its container port to loopback by default. Historical data is limited to what the existing backend stores; no historical backfill is performed.

See [`docs/public-api.md`](docs/public-api.md) for endpoint parameters, response schemas, pagination and error handling.

Browsable pages are served by the same web container:

- <https://signal-scan.duckdns.org/api-docs.html> — endpoint reference.
- <https://signal-scan.duckdns.org/feature-history.html> — public API feature milestones (commit dates; the repo has no formal release tags).

Their sources are `public/api-docs.html`, `public/feature-history.html`, and `public/docs.css`. Publish them with `make docs-deploy` (instance A only; rebuilds/recreates `web` only, leaving `api` and `public-api` untouched).

## Tunables

`src/config.ts` holds `ENTRY_VOLUME_THRESHOLD` (24h volume under which a token shows a green entry) and other constants.

## Nansen setup: enrichment và kiểm soát request

- First-add, chart fallback và sweep dùng chung queue theo `(chain, CA)`: một job đang chạy, các caller cùng token dùng chung kết quả.
- Fresh cadence is governed by the durable `metric_poll_cache` gate; T100 and LF retries remain independent. T100 fresh data is not fetched again when only LF is missing; verified LF provenance at the matching resolution is reused after DB recovery.
- Freshness marker chỉ ghi khi lấy được dữ liệu. Cache format v2 giữ marker bị thiếu và lịch retry qua restart; đọc được cache v1 để tránh cold backfill khi nâng cấp.
- Queue xử lý tuần tự theo giới hạn gateway; mỗi job có deadline 30s và abort signal để request flows bị hủy khi hết hạn, nhường queue cho CA kế tiếp. Token mới hoặc thiếu T100/LF được ưu tiên; background được phục vụ sau tối đa tám job ưu tiên đang chờ.
- Gini/FW provider call có timeout riêng `GINI_METRIC_TIMEOUT_MS` (mặc định 30s); timeout abort request, ghi retry/backoff và giải phóng sweep cho CA kế tiếp. Response đến muộn không được ghi cache hoặc đè Fresh value gần nhất.
- Shared gateway FW/Gini requests forward the provider AbortSignal through Door admission to the in-page fetch. Cancellation removes queued work or aborts the browser fetch without penalizing Door state; the request still counts against rate budget if dispatch began.
- `LOG_LEVEL=info` shows lifecycle records for setup queue (`job enqueued/started/completed/failed`), FW (`fw_start/finish/applied/late_result`), series/T100, and LF. Each record carries CA+chain plus the event timestamp/outcome and relevant wait/run/backoff fields.
- Door logs correlate by `requestId` and CA+chain: admission wait, Door ID, dispatch classification/status/duration, and request finish/abort. They omit request payloads, Nansen URLs and proxy credentials. Logs use Docker's existing 10MB × 3 json-file rotation; `make gateway-log` follows the shared collector.
- T100 và FW/Gini là các nhánh dữ liệu độc lập; series T100 được ghi DB/cache ngay khi fetch thành công, không chờ LF. Timeout LF giữ lần ghi T100 và không nhân đôi observation/history; kết quả đến muộn sau khi job bị abort không được ghi tiếp.
- Door warmup/reconnect có deadline; Door hỏng được thử lại độc lập sau cooldown dù Door khác còn đang warming. Gateway `/health` giữ liveness riêng với trạng thái browser; mỗi `/api/health` cung cấp aggregate FW/T100 freshness riêng cho CA của instance đó, không lộ CA/proxy, và đọc lại shared setup cache khi gateway cập nhật file. Monitor đánh dấu workload idle là unknown và cảnh báo khi browser hoặc freshness không đạt; Nansen connectivity incident/recovery notifications chỉ gửi Discord, không fallback sang Telegram.
- Fresh% and T100 series/cache TTLs are 3h. Setup pass cap and gateway budgets are unchanged; no Hot/Warm/Cold or credit-accounting changes.
- Chart replay keeps the timestamp of the series fetch; a Fresh update does not make an old chart look newly fetched.
- FW values and history remain visible when the last successful sample is stale; stale or unknown-time values do not pass scoring or explicit Fresh Wallet filters. Freshness uses the configured setup TTL; stale-only rows stay incomplete so the zero-score gate does not deactivate them. Dashboard freshness labels and chart refresh-time details are shown only while **Show all factors (debug)** is enabled.
- T100 cell exposes sampled max-drawdown history in the same-size popup as Fresh Wallet; history retains the latest 256 successful observations, with no synthetic backfill.
- Holder chart stores up to 256 successful displayed counts and starts accumulating after this change (no backfill). Fresh, T100, and Holder markers share the same size; the visible T100 point tooltip shows a decrease from the previous plotted multiple and the point's peak-to-trough T100 token balance in rounded compact notation (for example, `129,090,067` → `129M`) when that balance declines.
- LF lấy bucket chứa thời điểm deploy (UTC hour khi tuổi ≤7 ngày, UTC day khi >7 ngày), không bỏ bucket ngày deploy vì timestamp intraday. Range Nansen loại bucket bằng `from`, nên request lùi thêm một bucket; anchor vẫn clamp tại bucket deploy để loại pre-genesis filler. Range hourly không vượt 7 ngày. Cache LF cũ thiếu provenance hoặc chuyển hourly→daily được kiểm chứng lại một lần; lỗi upstream hoặc response daily thiếu ngày deploy giữ nguyên LF/provenance cũ và retry, không ghi giá trị ngày kế tiếp. Khi replay cache, LF hiện có trong DB được ưu tiên.
- Cache chỉ có LF (không có series) vẫn khôi phục LF nếu DB đang thiếu. Writer chỉ cập nhật `genesis_bal IS NULL`, không ghi đè LF hiện có và không đổi bal/T100 hay timestamp ingest; không phát sinh request upstream.

Đo offline trước–sau: ba caller đồng thời giảm từ 6 xuống 2 request flows; trường hợp thiếu LF điền đủ bằng một request LF, không lấy lại T100; sweep hai token vẫn dùng 4 request flows nhưng không còn thời gian chờ theo cadence. Số liệu và harness lưu tại `.omo/evidence/nansen-setup-optimization.json`. Đây là request-equivalent credits, không phải số liệu production; phép đo không gọi Nansen thật.

- Kiểm chứng backend: chạy `npm run build` và `npm test` trong `server/`. Các test `setup-*`, `lf-write-once`, `tgm-flows`, `t100-window`, `poller`, `gateway/*` và `monitor.test.ts` bao phủ cache/retry qua restart, timeout/cancellation, queue progress, Door recovery, provider readiness và freshness.

## Gateway request dùng chung cho dashboard A/B

- GMGN chỉ gộp các request đồng thời có cùng `(chain, CA)`; địa chỉ EVM được chuẩn hóa không phân biệt hoa thường. Response đã hoàn tất không được lưu; mỗi outbound thực tế tạo `client_id` và timestamp mới. Tối đa một retry có giới hạn cho 429/5xx sau gate/backoff; không retry 400/401/403.
- Dữ liệu CA công khai từ Nansen token-information/holders/flows và Door essentials/volume/Gini, cùng DexScreener tokens/pairs/search/profiles/boosts, được chia sẻ theo tham số và TTL. Cache miss Nansen có phí chỉ được preflight/charge một lần bởi caller khởi tạo; caller nhập chung và cache hit không tạo request trả phí khác. Request Nansen theo wallet/profile không cache.
- Các lệnh đọc EVM/Solana JSON-RPC đi qua admission có giới hạn và cache/single-flight theo endpoint scope, chain, method, params. Read trạng thái mới dùng TTL ngắn; transaction bất biến dùng TTL dài hơn. JSON-RPC write không cache. Cache được chia sẻ giữa các RPC client trong cùng API process; cache gateway chia sẻ giữa các caller dashboard.
- Limiter xoay vòng caller cùng priority, giữ lịch essential trước background, và giới hạn queue theo kích thước/tuổi, retry và thời gian chờ gate. Quota EVM cấu hình riêng cho endpoint chính và fallback, mặc định mỗi endpoint tối đa 300 request/phút và bốn concurrent request.


## Shared public market state for dashboard A/B

- The gateway owns one `market.db` and one market-data poller for the union of A/B tracked CAs. Public token fields—including price/MC, symbol, icon metadata, volume, holders, Nansen metrics, and their poll/series/history caches—are read from this shared database.
- The gateway owns market refresh cadence and TTLs. A/B register their tracked-CA sets; adding/removing a CA changes the gateway's union. Each API request reads the latest committed shared values; the dashboard's existing 30-second refresh picks them up without a second per-instance market poller.
- Icon metadata tries DexScreener first, then the shared gateway retries CAs still missing an icon through GMGN token/info. Each pass handles at most 30 CAs and paces requests across `POLL_ICON_MS`; no-logo/errors use the durable exponential retry gate (up to 32× cadence, capped at 24h). Missing icons stay eligible while the CA remains active, and GMGN fills only an empty icon field, so it cannot replace an existing provider image.
- Gateway startup imports public market tables once; after both API instances have switched to the shared DB/cache, `make market-data-reconcile` force-merges later public rows from their legacy DBs and restarts the gateway to merge the final setup caches. This operation preserves freshness rules and never copies tracked lists, wallets, FOMO holdings, trades, or inflow state; those remain per instance.
- Gateway Fresh/T100 observations are copied into each API's local monitor queue before the feed is served. Each API enriches its copy with its own tracked-wallet holdings and keeps its own monitor acknowledgement cursor; the gateway deletes source rows only after both A and B have imported through them.
- `make monitor-deploy` starts the gateway and initializes/migrates the shared database before starting A/B APIs, which attach it through read-only views. Do not start shared-mode APIs before the gateway has initialized `/market-data/market.db`.
- API instances treat shared `token_state` as a gateway-owned read-only view; tier and prune cleanup only sweep per-instance data and never delete shared market rows.

## Cache metric theo chu kỳ và provenance

- SQLite `metric_poll_cache` lưu response thành công, thời điểm nhận response, lần thử gần nhất, thời điểm query kế tiếp và số lỗi liên tiếp theo `(chain, CA, dataset)`. Restart không reset giới hạn query.
- MC/essential cố định 30 phút. Trong GMGN, essential và volume dùng chung một gate token/info tối thiểu 30 phút; cùng response cấp timestamp cho cả hai dataset. Essential-gap, symbol backfill và first-add không bypass gate. Gini/Fresh giữ cadence cấu hình; Dex metadata không query nhanh hơn 30 phút.
- Timeout, denial hoặc rate limit không ghi đè response thành công hay `token_state`. Retry dùng exponential backoff, không sớm hơn cadence; sweep giãn request và ưu tiên CA đến hạn lâu nhất, vẫn giữ ưu tiên CA mới.
- `/api/signals` trả `dataUpdatedAt` cho MC, volume, holders, Fresh, symbol và icon. Hover MC/volume/holders/Fresh trên dashboard hiện thời điểm response thành công; chart giữ timestamp riêng của từng điểm.
- Hovering a tracked-wallet or FOMO-user Balance shows its measured token-unit amount with comma grouping. Tracked-wallet USD balances are recalculated from stored token amounts whenever that CA's price is written; trade/inflow history remains at detection-time values. FOMO-user USD balances are calculated from current price at read time. Amounts use the stored SQLite `REAL`/JavaScript number value, not raw on-chain integer precision.
- `GET /api/signals` giữ đầy đủ mảng tracked-wallet, FOMO-user và lịch sử chart để preview, aggregate và modal chi tiết hiện có giữ nguyên dữ liệu. Server cache assembled response trong process tối đa 1 giây, tách theo `allFactors`; API mutation thành công sẽ invalidate cache, còn dữ liệu do background poller ghi sẽ xuất hiện sau TTL.


## CA notes, percentage filters và Fresh chart (A/B)

- Nút note cạnh ticker mở editor rộng 504px, cao tối thiểu 350px trên desktop và tự co theo viewport; vùng nhập note cao tối thiểu 304px. Tooltip note đã lưu rộng tối đa 520px, cao tối đa 360px và tự giới hạn theo viewport. Biểu tượng note đã lưu có glyph 34px trong vùng bấm 52px. Note mới mặc định trống. Note đã lưu dùng bong bóng vàng có “!”; hover/focus trên desktop hoặc tap trên thiết bị cảm ứng mở tooltip màu vàng, click mở editor. Save hoặc Enter lưu, Esc hủy, Shift+Enter xuống dòng; editor hiển thị bộ đếm tối đa 2000 ký tự. Note lưu trong `tracked_cas.user_note` theo `(chain, CA)`; quyền ghi admin như Tier. `tracked_cas.note` giữ riêng nhãn nguồn scanner (`wallet-trade`, `fomo`, `auto:BUY by …`, `auto:SELL by …`), không điền vào note người dùng. Migration giữ nội dung note cũ không phải nhãn nguồn, không xóa provenance. Repair một lần làm trống nhãn auto bị migration trước sao chép, chỉ khi user note vẫn bằng nhãn nguồn; note đã sửa và những lần Save sau đó không bị reset khi restart. Hai instance giữ DB riêng.
- Quyền note trên A/B: admin mới được thêm/sửa và Save/Enter để lưu; viewer, service và role chưa resolve chỉ mở xem nội dung read-only, không có Save hay phím tắt ghi. API vẫn kiểm tra admin độc lập với giao diện và trả 403 cho các role khác khi ghi.
- More filters có Fresh wallets (%) và Tracked holding (%) min–max, bao gồm hai đầu khoảng. Fresh range dùng `nansen.rawFresh` chưa bị gate bởi setup, nên Fresh 5% vẫn lọc được trong khoảng 0–10% khi token đạt Top100. Trường trống không giới hạn; giá trị chưa biết không đáp ứng khoảng đang bật. Reset filters xóa các bộ lọc bổ sung.
- Hover/focus Fresh mở chart từ snapshot tích lũy theo lần cập nhật Fresh thành công; thời điểm ingest Fresh không dùng `token_state.fetched_at` chung. Khi có lịch sử Market Cap, chart chồng hai series cùng trục thời gian và dùng thang riêng: Fresh trục trái màu xanh lá, MC trục phải màu xanh dương. Popup Fresh được mở rộng tối đa 1500×960px (giới hạn theo viewport); SVG co giãn theo khung. MC trong popup Fresh được gộp còn tối đa 12 điểm, giữ endpoints và số mẫu trung bình; hover/tap/keyboard lên từng điểm MC hiển thị timestamp, giá trị USD và số mẫu nếu được gộp. Fresh vẫn hiển thị Fresh% như cũ; ArrowDown vào chart, ArrowLeft/ArrowRight di chuyển giữa điểm của cả hai series. Popup chart MC riêng giữ kích thước và hành vi hiện tại. Chart chỉ dùng snapshot hiện có, không query upstream, backfill hay tạo dữ liệu giả; lịch sử bắt đầu sau bản cập nhật và lưu tối đa 256 điểm.
- GMGN current MC updates only from a successful fresh quote. A successful response without a usable quote hides current price/MC; a failed request preserves the last successful sample. Historical MC snapshots remain available.
- Fresh chart popup renders only after its viewport position is measured, avoiding a top-left first frame. Focus within the popup keeps it open; leaving with Tab closes it.
- Dashboard A uses a 1px readability increase for shared labels, filters, and main table text; dashboard B sizing remains unchanged.
- Fresh% refresh prioritizes the oldest successful read; retry eligibility follows durable Gini cache state across restarts. Legacy failed FW rows receive one bounded probe within 5 minutes; transient Nansen Door challenges retry within the 5-minute setup sweep without growing exponential failure count. Real 403s and missing-Fresh responses retain durable backoff; successful 3-hour cadence, sweep cap 40, and request budgets remain unchanged. `POLL_SETUP_RETRY_MS` remains the exponential base for persistent FW and series/LF failures.
- Buying 24H / Sell 24H là gross DEX volume, không phải FOMO Sell PnL; styling hiện có giữ nguyên. BAL và Tracked inflow: >5K bold; >10K bold, vàng và cỡ chữ 1.2×; >20K cầu vồng. Holders >1,000 bold; Volume 24H <300K xanh lá và bold; Tracked holding >3% bold, >4.5% cầu vồng. Các ngưỡng là so sánh nghiêm ngặt trên giá trị gốc; màu cầu vồng dùng cùng gradient hiện tại.
- Solana wallet inflow stores one row per `(wallet, CA, tx, side)`. Same-CA swap hops are summed; known cost carried through intermediate route swaps is gross per-mint BUY inflow and is not reduced by a later SELL in the same transaction. A SELL is suppressed only when the wallet's net token delta is explicitly zero; unknown deltas keep the SELL. If the final mint appears only as a SELL quote, the watcher emits its BUY from the quote-side wallet net delta. BUY quantity uses positive wallet net quantity where available; per-hop event logs remain unchanged. For Pump.fun routes where the final token settles directly from one pool owner to another, the watcher infers the missing wallet endpoint only when one distinct-mint, same-frame leg uniquely confirms the direction and pool owner; ambiguous handoffs remain rejected.
- Default sort in the merged FOMO dashboard uses the newest 24h activity from either FOMO-user trades or tracked-wallet trades. A CA with no recent activity on either source sorts last; explicit column sorts and the non-FOMO dashboard order are unchanged.
- FOMO Bal giữ `amount` token từ user-level `/v2/users/{userId|handle}/balances` gọi qua bridge nội bộ `fomo-prod` (curl_cffi + Privy refresh). Alert dùng stable `userId` đã lưu/nhận được trước, fallback sang handle; response cập nhật mọi CA dashboard có tracked bởi user. Alert được gom 5 giây, balances thành công tối đa một lần/user/phút, không có user×CA sweep định kỳ. Balance không đổi không ghi lại row; response đầy đủ không còn balance cho CA đã tracked đặt holding về 0. `available:false`, payload sai hoặc lỗi upstream không ghi đè snapshot tốt; no-data giữ 60 giây, lỗi tăng backoff 60 giây → tối đa 5 phút (tôn trọng `Retry-After`), lưu riêng theo user+endpoint và chỉ xét lại khi có alert. Bridge `/health` chỉ đọc hạn token, không tốn request upstream.
- FOMO per-user `Buy $` is the exact sum of `trade_usd` for BUY events in the trailing 24h. If any in-window BUY amount is missing, it displays `—` (and aggregate inflow is also `—`) rather than a false `$0` or partial total; position `usd_value` and cost basis are not trade spend. Non-positive watcher-supplied BUY `tradeUsd` is normalized to unknown so swap enrichment can still run. For a newly ingested BUY with no `tradeUsd`, instance B queries one `/v2/users/{handle}/swaps` page through the free prod bridge; it matches by position ID when available, otherwise counts every same-CA/chain/five-second fill before accepting exactly one with a non-null swap trade ID and valid USD. Ambiguous responses remain unknown. Periodic position sweeps do not query swaps. The host watcher polls the same bridge every 60s and accepts roughly one minute of alert latency instead of the retired paid WebSocket.
- Dashboard A `Tracked by` rows show up to five wallets inline; `+N more` opens the full wallet list in a popup. Dashboard B shows up to five FOMO users and five native wallets inline; `+N more` counts all hidden users and wallets and opens the existing full activity popup. Both show Wallet → Rank → Group → Bal → TXs → Inflow → Age in the 384px column. Rank badges are colored S (gold), A (green), B (blue), C (orange), D (red); each qualified group is shown by its `G#` prefix with the full label on hover. Cohort labels refresh hourly from `/api/pnl/cohort-labels`; missing labels render as `—`, and a failed refresh preserves the last good snapshot. The Wallets tab also shows read-only Rank/Group after Name; cohort metadata is not part of wallet edits or CSV import/export.
- Production A/B read Rank/Group from the CT Wallet Alpha Engine on 228 over the private `signal-scan-cohort-labels` Docker network. The migrated cohort snapshot is served with provider refresh and startup backfill disabled; configure provider credentials before re-enabling either.
- Bal on instances A and B keeps its USD value and appends each tracked wallet or FOMO user's measured token-supply share; unknown holding or supply leaves the percentage out. Hovering a point in the active metric-history chart shows that series' value and timestamp in a compact tooltip beside the point.
- Dashboard summary tiles remain visible while signals load (showing `—`) and when the dashboard has no active signals; counts and volume show their available values.

- Regression modules: `server/test/fresh-history.test.ts`, `server/test/token-note.test.ts`, `server/test/signal-metrics.test.ts`, `server/test/fresh-range-api.test.ts`.


## Telegram periodic scan

- At each configured UTC+7 slot, the monitor combines due A/B entries into a short source/time/count header and per-token photo captions in the dedicated periodic channel. Photos are grouped in Telegram albums of at most 10 entries; no report document is sent.
- Each caption includes the scan slot, ticker, market cap, GMGN link, Nansen metrics, 24h volume, tracker holding, and X links. Photos use the same CA-keyed cached JPEG as the dashboard and upload bytes; missing provider logos use a deterministic chain+CA identicon.
- A failed source blocks partial reports. A delivery failure after the header is marked uncertain to avoid replaying a partially sent album. Feed values are a slot-time snapshot, not a from–to history window.
- Per-CA captions show Fresh Wallet values without stale/updated-time diagnostics. Server and credit status notifications are not sent to Telegram.

## Reference docs

- `docs/framework01-spec.md` - signal table column spec
- `docs/public-api.md` - standalone read-only Public API v1 reference
- `public/api-docs.html`, `public/feature-history.html` - browsable API reference and feature milestones
- `docs/alpha-engine-brief.md` - data science engine that will feed the dashboard later
