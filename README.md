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
- Giữ nguyên Fresh% TTL 6h, T100 TTL 12h, setup pass cap và budget a/b. Không triển khai Hot/Warm/Cold hay thay credit accounting.
- Chart replay giữ timestamp của lần lấy series, không coi lần cập nhật Fresh% là một lần lấy chart mới.
- LF lấy bucket chứa thời điểm deploy (UTC hour khi tuổi ≤7 ngày, UTC day khi >7 ngày), không bỏ bucket ngày deploy vì timestamp intraday. Range Nansen loại bucket bằng `from`, nên request lùi thêm một bucket; anchor vẫn clamp tại bucket deploy để loại pre-genesis filler. Range hourly không vượt 7 ngày. Cache LF cũ thiếu provenance hoặc chuyển hourly→daily được kiểm chứng lại một lần; lỗi upstream hoặc response daily thiếu ngày deploy giữ nguyên LF/provenance cũ và retry, không ghi giá trị ngày kế tiếp. Khi replay cache, LF hiện có trong DB được ưu tiên.
- Cache chỉ có LF (không có series) vẫn khôi phục LF nếu DB đang thiếu. Writer chỉ cập nhật `genesis_bal IS NULL`, không ghi đè LF hiện có và không đổi bal/T100 hay timestamp ingest; không phát sinh request upstream.

Đo offline trước–sau: ba caller đồng thời giảm từ 6 xuống 2 request flows; trường hợp thiếu LF điền đủ bằng một request LF, không lấy lại T100; sweep hai token vẫn dùng 4 request flows nhưng không còn thời gian chờ theo cadence. Số liệu và harness lưu tại `.omo/evidence/nansen-setup-optimization.json`. Đây là request-equivalent credits, không phải số liệu production; phép đo không gọi Nansen thật.

Kiểm chứng backend: chạy `npm run build` và `npm test` trong `server/`. Các test `setup-*`, `lf-write-once`, `tgm-flows`, `t100-window`, `poller` và `gateway/*` bao phủ cache/retry qua restart, concurrent callers, ưu tiên hàng đợi và HTTP first-add.

## CA notes, percentage filters và Fresh chart (A/B)

- Nút note cạnh ticker mở popup; note mới mặc định trống. Save hoặc Enter lưu, Esc hủy, Shift+Enter xuống dòng. Note tối đa 2000 ký tự, lưu trong `tracked_cas.user_note` theo `(chain, CA)`; quyền ghi admin như Tier. `tracked_cas.note` giữ riêng nhãn nguồn scanner (`wallet-trade`, `fomo`, `auto:BUY by …`, `auto:SELL by …`), không điền vào note người dùng. Migration giữ nội dung note cũ không phải nhãn nguồn, không xóa provenance. Repair một lần làm trống nhãn auto bị migration trước sao chép, chỉ khi user note vẫn bằng nhãn nguồn; note đã sửa và những lần Save sau đó không bị reset khi restart. Hai instance giữ DB riêng.
- Quyền note trên A/B: admin mới được thêm/sửa và Save/Enter để lưu; viewer, service và role chưa resolve chỉ mở xem nội dung read-only, không có Save hay phím tắt ghi. API vẫn kiểm tra admin độc lập với giao diện và trả 403 cho các role khác khi ghi.
- More filters có Fresh wallets (%) và Tracked holding (%) min–max, bao gồm hai đầu khoảng. Fresh range dùng `nansen.rawFresh` chưa bị gate bởi setup, nên Fresh 5% vẫn lọc được trong khoảng 0–10% khi token đạt Top100. Trường trống không giới hạn; giá trị chưa biết không đáp ứng khoảng đang bật. Reset filters xóa các bộ lọc bổ sung.
- Hover/focus Fresh để xem chart từ snapshot tích lũy ở mỗi lần cập nhật Fresh thành công, kể cả khi giá trị không đổi; thời điểm ingest Fresh gần nhất không dùng `token_state.fetched_at` chung. Lịch sử bắt đầu sau bản cập nhật, giữ tối đa 256 điểm. Chart không query upstream, không backfill hay tạo dữ liệu giả; chưa đủ điểm hiển thị trạng thái rõ ràng. TTL Fresh 6h và budget Nansen giữ nguyên.
- Fresh refresh trong setup sweep ưu tiên lần lấy thành công cũ nhất; khi cả hai queue có debt, dành 1/5 cap (ít nhất 1 slot) cho series/LF-only — cap 40 dành 8 slot, còn lại cho Fresh. Slot queue trống được dùng cho queue còn lại; cap=1 luân phiên qua các pass và lưu lượt trong DB. Các Fresh read trong pass được hoàn tất trước khi chờ queue series. `POLL_SETUP_SWEEP_MS` mặc định 5 phút để phục vụ backlog; TTL Fresh, `POLL_SETUP_RETRY_MS` failure backoff và `SETUP_PASS_CAP` vẫn độc lập và giữ nguyên.
- Buying 24H / Sell 24H là gross DEX volume, không phải FOMO Sell PnL. Buying >10K lớn 1.2× + bold, >50K vàng, >100K cầu vồng. Sell đỏ, >5K bold, >10K lớn 1.2×. Inflow >10K bold, >200K cầu vồng. Ngưỡng tính từ USD gốc, dùng dấu `>`; Sell PnL hiện có giữ nguyên ý nghĩa.
- Sort mặc định dash FOMO theo `fomoBuyAt`: BUY FOMO mới nhất của đúng `(chain, CA)`, không bị giới hạn bởi cửa sổ stats 24h. SELL không đẩy CA lên; chưa có BUY xếp cuối. Sort theo cột và thứ tự dash A giữ nguyên. Age của FOMO by vẫn là giao dịch gần nhất (BUY hoặc SELL), không phải thời điểm dùng để sort BUY.
- Regression modules: `server/test/fresh-history.test.ts`, `server/test/token-note.test.ts`, `server/test/signal-metrics.test.ts`, `server/test/fresh-range-api.test.ts`.


## Reference docs

- `docs/framework01-spec.md` - signal table column spec
- `docs/alpha-engine-brief.md` - data science engine that will feed the dashboard later
