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

## A/B Docker routing

The A/B Compose projects share the external `signal-scan-gateway` network. Cross-project web-to-API and API-to-Chrome traffic MUST use the per-instance aliases `signal-scan-api-a/b` and `signal-scan-chrome-a/b`; generic Compose aliases `api` and `chrome` resolve ambiguously on that shared network. `make monitor-deploy` runs `make routing-smoke` after recreating both instances to verify DNS, rendered Nginx upstreams, and proxied health requests.

Production Signal Scan runs on `root@167.86.101.228`. `make monitor-deploy` deploys both dashboard instances, the shared gateway, and monitor; after both APIs are healthy, `make watchers-up` enables the wallet, FOMO, and EVM watcher services and verifies the persistent wallet watchdog.


## Host monitoring dashboard

`make monitor-deploy` deploys the public monitor at <https://signal-scan.duckdns.org:8443/>; no login is required. The dashboard, `/api/snapshot`, and `/api/history` expose service health plus provider usage and balance telemetry to anyone with the URL. Keep it public only if that data is acceptable to share. `MONITOR_API_TOKEN` remains private in `/root/signal-scan-monitor/monitor.env` (mode `0600`) and authenticates internal scraping and the A/B alert feed.

Set `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` in that server-side file to enable Discord monitor alerts. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the same file to enable Telegram alerts, then run `make monitor-restart`. Telegram alerts include a token avatar when available, or a letter badge matching the dashboard's fallback avatar when the token has no icon, plus a GMGN-linked ticker, market cap, trigger, Nansen Fresh/Top100/Low Float, tracked-wallet holding %, the dashboard's Tracked in count, tracked wallet identities, and UTC+7 event time. B alerts also include FOMO users. Twitter handles and CA search on X are clickable links. Tracker Buying reasons identify the wallet name/address and show that BUY's USD amount.
Telegram alert thresholds are configured in the separate **Telegram alert thresholds** panel beside **Signal thresholds** on instance A. Each panel has its own Save action and status. The global MC filter uses Min MC/Max MC in K USD; set either bound to -1 to disable that side. With a bound active, MC must be available and inside the inclusive range. FW alerts require current FW >= Min FW and relative growth > FW growth; Min FW applies only to FW alerts. T100 alerts require relative growth > T100 growth from a positive prior baseline, independently of Min FW. Each qualifying FW/T100 observation can alert separately, including both metrics for one CA. FW growth, Min FW, and T100 growth default to 30%, 15%, and 30%. Tracker Buying is independent of FW/T100 growth gates and alerts only when one priced Wallet Watch BUY strictly exceeds its configured threshold in thousands of USD; set it to 0 to disable. Telegram outbox claims each alert before sending. Retries occur only after an explicit Telegram 429 rejection; ambiguous network/5xx results and interrupted sends are marked `uncertain` and are not automatically resent, avoiding duplicate messages at the cost of requiring manual review when delivery is unknown. Saving on instance A persists rules immediately; the central monitor reads the current rules from A's alert feed.


The FOMO series uses the account usage snapshot from FOMO's API. Nansen shows the gateway's internal daily budget ledger, not an upstream account balance. GMGN has no integrated balance API, so it reports successful calls by configured key; RPC providers report per-endpoint request/error counts and observed quota exhaustion, not credit balances.


## Deploy (plain static hosting)

```bash
npm run build
```

Serve `dist/` with any web server. SPA fallback is required (unknown paths must serve `index.html`); see `nginx.conf` for a ready-made config with gzip and immutable caching for hashed assets.

## API swap

Components never touch localStorage directly; they only call `dataStore` from `src/services/dataStore.ts`, which implements the `DataStore` interface (async methods). To go live, re-implement that interface with `fetch()` calls against the alpha engine API. No component changes needed.

## Tunables

`src/config.ts` holds `ENTRY_VOLUME_THRESHOLD` (24h volume under which a token shows a green entry) and other constants.

## Nansen setup: enrichment và kiểm soát request

- First-add, chart fallback và sweep dùng chung queue theo `(chain, CA)`: một job đang chạy, các caller cùng token dùng chung kết quả.
- Fresh%, T100 và LF retry độc lập. T100 còn fresh không bị mua lại khi chỉ thiếu LF; LF có provenance đúng resolution được dùng lại, kể cả khi khôi phục DB từ cache.
- Freshness marker chỉ ghi khi lấy được dữ liệu. Cache format v2 giữ marker bị thiếu và lịch retry qua restart; đọc được cache v1 để tránh cold backfill khi nâng cấp.
- Queue xử lý tuần tự theo giới hạn gateway, không giãn cả vòng theo TTL. Token mới hoặc thiếu T100/LF được ưu tiên; background được phục vụ sau tối đa tám job ưu tiên đang chờ.
- Fresh% TTL remains 6h; the T100 series/cache TTL is 3h. Setup pass cap and gateway budgets are unchanged; no Hot/Warm/Cold or credit-accounting changes.
- Chart replay keeps the timestamp of the series fetch; a Fresh update does not make an old chart look newly fetched.
- T100 cell exposes sampled max-drawdown history in the same-size popup as Fresh Wallet; history retains the latest 256 successful observations, with no synthetic backfill.
- Holder chart stores up to 256 successful displayed counts and starts accumulating after this change (no backfill). Fresh, T100, and Holder markers share the same size; T100 hover detail shows a decrease from the previous plotted value to the selected value.
- LF lấy bucket chứa thời điểm deploy (UTC hour khi tuổi ≤7 ngày, UTC day khi >7 ngày), không bỏ bucket ngày deploy vì timestamp intraday. Range Nansen loại bucket bằng `from`, nên request lùi thêm một bucket; anchor vẫn clamp tại bucket deploy để loại pre-genesis filler. Range hourly không vượt 7 ngày. Cache LF cũ thiếu provenance hoặc chuyển hourly→daily được kiểm chứng lại một lần; lỗi upstream hoặc response daily thiếu ngày deploy giữ nguyên LF/provenance cũ và retry, không ghi giá trị ngày kế tiếp. Khi replay cache, LF hiện có trong DB được ưu tiên.
- Cache chỉ có LF (không có series) vẫn khôi phục LF nếu DB đang thiếu. Writer chỉ cập nhật `genesis_bal IS NULL`, không ghi đè LF hiện có và không đổi bal/T100 hay timestamp ingest; không phát sinh request upstream.

Đo offline trước–sau: ba caller đồng thời giảm từ 6 xuống 2 request flows; trường hợp thiếu LF điền đủ bằng một request LF, không lấy lại T100; sweep hai token vẫn dùng 4 request flows nhưng không còn thời gian chờ theo cadence. Số liệu và harness lưu tại `.omo/evidence/nansen-setup-optimization.json`. Đây là request-equivalent credits, không phải số liệu production; phép đo không gọi Nansen thật.

Kiểm chứng backend: chạy `npm run build` và `npm test` trong `server/`. Các test `setup-*`, `lf-write-once`, `tgm-flows`, `t100-window`, `poller` và `gateway/*` bao phủ cache/retry qua restart, concurrent callers, ưu tiên hàng đợi và HTTP first-add.

## Gateway request dùng chung cho dashboard A/B

- GMGN chỉ gộp các request đồng thời có cùng `(chain, CA)`; địa chỉ EVM được chuẩn hóa không phân biệt hoa thường. Response đã hoàn tất không được lưu; mỗi outbound thực tế tạo `client_id` và timestamp mới. Tối đa một retry có giới hạn cho 429/5xx sau gate/backoff; không retry 400/401/403.
- Dữ liệu CA công khai từ Nansen token-information/holders/flows và Door essentials/volume/Gini, cùng DexScreener tokens/pairs/search/profiles/boosts, được chia sẻ theo tham số và TTL. Cache miss Nansen có phí chỉ được preflight/charge một lần bởi caller khởi tạo; caller nhập chung và cache hit không tạo request trả phí khác. Request Nansen theo wallet/profile không cache.
- Các lệnh đọc EVM/Solana JSON-RPC đi qua admission có giới hạn và cache/single-flight theo endpoint scope, chain, method, params. Read trạng thái mới dùng TTL ngắn; transaction bất biến dùng TTL dài hơn. JSON-RPC write không cache. Cache được chia sẻ giữa các RPC client trong cùng API process; cache gateway chia sẻ giữa các caller dashboard.
- Limiter xoay vòng caller cùng priority, giữ lịch essential trước background, và giới hạn queue theo kích thước/tuổi, retry và thời gian chờ gate. Quota EVM cấu hình riêng cho endpoint chính và fallback, mặc định mỗi endpoint tối đa 300 request/phút và bốn concurrent request.

## Cache metric theo chu kỳ và provenance

- SQLite `metric_poll_cache` lưu response thành công, thời điểm nhận response, lần thử gần nhất, thời điểm query kế tiếp và số lỗi liên tiếp theo `(chain, CA, dataset)`. Restart không reset giới hạn query.
- MC/essential cố định 30 phút. Trong GMGN, essential và volume dùng chung một gate token/info tối thiểu 30 phút; cùng response cấp timestamp cho cả hai dataset. Essential-gap, symbol backfill và first-add không bypass gate. Gini/Fresh giữ cadence cấu hình; Dex metadata không query nhanh hơn 30 phút.
- Timeout, denial hoặc rate limit không ghi đè response thành công hay `token_state`. Retry dùng exponential backoff, không sớm hơn cadence; sweep giãn request và ưu tiên CA đến hạn lâu nhất, vẫn giữ ưu tiên CA mới.
- `/api/signals` trả `dataUpdatedAt` cho MC, volume, holders, Fresh, symbol và icon. Hover MC/volume/holders/Fresh trên dashboard hiện thời điểm response thành công; chart giữ timestamp riêng của từng điểm.


## CA notes, percentage filters và Fresh chart (A/B)

- Nút note cạnh ticker mở editor rộng 504px, cao tối thiểu 350px trên desktop và tự co theo viewport; vùng nhập note cao tối thiểu 304px. Tooltip note đã lưu rộng tối đa 520px, cao tối đa 360px và tự giới hạn theo viewport. Biểu tượng note đã lưu có glyph 34px trong vùng bấm 52px. Note mới mặc định trống. Note đã lưu dùng bong bóng vàng có “!”; hover/focus trên desktop hoặc tap trên thiết bị cảm ứng mở tooltip màu vàng, click mở editor. Save hoặc Enter lưu, Esc hủy, Shift+Enter xuống dòng; editor hiển thị bộ đếm tối đa 2000 ký tự. Note lưu trong `tracked_cas.user_note` theo `(chain, CA)`; quyền ghi admin như Tier. `tracked_cas.note` giữ riêng nhãn nguồn scanner (`wallet-trade`, `fomo`, `auto:BUY by …`, `auto:SELL by …`), không điền vào note người dùng. Migration giữ nội dung note cũ không phải nhãn nguồn, không xóa provenance. Repair một lần làm trống nhãn auto bị migration trước sao chép, chỉ khi user note vẫn bằng nhãn nguồn; note đã sửa và những lần Save sau đó không bị reset khi restart. Hai instance giữ DB riêng.
- Quyền note trên A/B: admin mới được thêm/sửa và Save/Enter để lưu; viewer, service và role chưa resolve chỉ mở xem nội dung read-only, không có Save hay phím tắt ghi. API vẫn kiểm tra admin độc lập với giao diện và trả 403 cho các role khác khi ghi.
- More filters có Fresh wallets (%) và Tracked holding (%) min–max, bao gồm hai đầu khoảng. Fresh range dùng `nansen.rawFresh` chưa bị gate bởi setup, nên Fresh 5% vẫn lọc được trong khoảng 0–10% khi token đạt Top100. Trường trống không giới hạn; giá trị chưa biết không đáp ứng khoảng đang bật. Reset filters xóa các bộ lọc bổ sung.
- Hover/focus Fresh mở chart từ snapshot tích lũy theo lần cập nhật Fresh thành công; thời điểm ingest Fresh không dùng `token_state.fetched_at` chung. Khi có lịch sử Market Cap, chart chồng hai series cùng trục thời gian và dùng thang riêng: Fresh trục trái màu xanh lá, MC trục phải màu xanh dương. Popup Fresh được mở rộng tối đa 1500×960px (giới hạn theo viewport); SVG co giãn theo khung. MC trong popup Fresh được gộp còn tối đa 12 điểm, giữ endpoints và số mẫu trung bình; hover/tap/keyboard lên từng điểm MC hiển thị timestamp, giá trị USD và số mẫu nếu được gộp. Fresh vẫn hiển thị Fresh% như cũ; ArrowDown vào chart, ArrowLeft/ArrowRight di chuyển giữa điểm của cả hai series. Popup chart MC riêng giữ kích thước và hành vi hiện tại. Chart chỉ dùng snapshot hiện có, không query upstream, backfill hay tạo dữ liệu giả; lịch sử bắt đầu sau bản cập nhật và lưu tối đa 256 điểm.
- GMGN current MC updates only from a successful fresh quote. A successful response without a usable quote hides current price/MC; a failed request preserves the last successful sample. Historical MC snapshots remain available.
- Fresh chart popup renders only after its viewport position is measured, avoiding a top-left first frame. Focus within the popup keeps it open; leaving with Tab closes it.
- Dashboard A uses a 1px readability increase for shared labels, filters, and main table text; dashboard B sizing remains unchanged.
- Fresh refresh trong setup sweep ưu tiên lần lấy thành công cũ nhất; khi cả hai queue có debt, dành 1/5 cap (ít nhất 1 slot) cho series/LF-only — cap 40 dành 8 slot, còn lại cho Fresh. Slot queue trống được dùng cho queue còn lại; cap=1 luân phiên qua các pass và lưu lượt trong DB. Các Fresh read trong pass được hoàn tất trước khi chờ queue series. `POLL_SETUP_SWEEP_MS` mặc định 5 phút để phục vụ backlog; TTL Fresh, `POLL_SETUP_RETRY_MS` failure backoff và `SETUP_PASS_CAP` vẫn độc lập và giữ nguyên.
- Buying 24H / Sell 24H là gross DEX volume, không phải FOMO Sell PnL; styling hiện có giữ nguyên. BAL và Tracked inflow: >5K bold; >10K bold, vàng và cỡ chữ 1.2×; >20K cầu vồng. Holders >1,000 bold; Volume 24H <300K xanh lá và bold; Tracked holding >3% bold, >4.5% cầu vồng. Các ngưỡng là so sánh nghiêm ngặt trên giá trị gốc; màu cầu vồng dùng cùng gradient hiện tại.
- Sort mặc định dash FOMO theo `fomoActivityAt`: FOMO BUY/SELL mới nhất hoặc native wallet watch trade mới nhất của đúng `(chain, CA)`, trên toàn bộ lịch sử; SELL/native trade cũng đẩy CA lên, CA chưa có activity xếp cuối. Sort theo cột và thứ tự mặc định dash A giữ nguyên. Age trong FOMO by là trade gần nhất của từng FOMO user trong cửa sổ stats 24h, không phải activity timestamp dùng để sort CA.
- FOMO by hiển thị Bal theo số token hiện giữ × giá USD hiện tại của đúng chain; holding chưa đo hoặc thiếu giá hiển thị `—`, số dư đo được bằng 0 hiển thị `$0`.
- FOMO per-user `Buy $` is the exact sum of `trade_usd` for BUY events in the trailing 24h. If any in-window BUY amount is missing, it displays `—` (and aggregate inflow is also `—`) rather than a false `$0` or partial total; position `usd_value` and cost basis are not trade spend. Non-positive alert-supplied BUY `tradeUsd` is normalized to unknown so swap enrichment can still run. For a newly ingested BUY with no alert `tradeUsd`, instance B queries one `/v2/users/{handle}/swaps` page (250 API credits); it matches by position ID when available, otherwise counts every same-CA/chain/five-second fill before accepting exactly one with a non-null swap trade ID and valid USD. Ambiguous or incomplete responses remain unknown. Periodic position sweeps do not query swaps.
- Dashboard A `Tracked by` rows show Wallet → Rank → Group → Bal → TXs → Inflow → Age in the 384px column. Rank badges are colored S (gold), A (green), B (blue), C (orange), D (red); each qualified group is shown by its `G#` prefix with the full label on hover. Cohort labels refresh hourly from `/api/pnl/cohort-labels`; missing labels render as `—`, and a failed refresh preserves the last good snapshot. The Wallets tab also shows read-only Rank/Group after Name; cohort metadata is not part of wallet edits or CSV import/export.

- Regression modules: `server/test/fresh-history.test.ts`, `server/test/token-note.test.ts`, `server/test/signal-metrics.test.ts`, `server/test/fresh-range-api.test.ts`.


## Reference docs

- `docs/framework01-spec.md` - signal table column spec
- `docs/alpha-engine-brief.md` - data science engine that will feed the dashboard later
