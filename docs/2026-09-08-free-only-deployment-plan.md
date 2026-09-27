# Free-only Deployment Plan — Poller + Snapshot + API
**Ngày:** 2026-09-08 · **Constraint:** $0 API, không realtime (delay chấp nhận 1-15'), kiến trúc phải nâng cấp được lên paid (Birdeye WS) mà không viết lại.

## Quyết định đã chốt (từ phân tích docs + API research)

| Quyết định | Giá trị |
|---|---|
| Provider duy nhất v0 | GMGN Agent API (free, Ed25519 signed, IPv4-only) |
| Birdeye | Bỏ khỏi vòng lặp. Free tier (1 rps/30K CU) vô dụng cho production. Giữ làm upgrade path realtime sau này |
| Nansen | Bỏ hẳn (free = 10 cr/ngày) |
| Transport | REST poll — token sweep 60s, holders sweep 15m, wallet sweep 15m |
| 9 cột | Tất cả chạy được free. Delay: cột 1/4/7/9 = 1-2'; cột 2/3/5/6 = 5-15' |
| 3b (T100↓) | Tự poll `token_top_holders` → snapshot → diff. **Snapshot bắt đầu càng sớm càng tốt — mỗi ngày trễ = mất 1 ngày point-in-time history vĩnh viễn** |
| Tier (cột 8) | N/A theo spec — trả `null`, UI hiện `—` |

## Kiến trúc

```
poller (cron loops, GMGN qua RateLimiter leaky-bucket W=1:20rps / W=5:4rps)
   → SQLite (WAL): token_state, holder_snapshots, wallet_token_state, wallet_trades, wallets, tracked_cas
   → Express API (/api/signals, /api/wallets, /api/tracked-cas, /api/health)
   → nginx proxy /api → UI (DataStore interface giữ nguyên, chỉ đổi implementation)
```

## Extension seam cho paid sau này (yêu cầu của user)

1. **`MarketDataProvider` interface** — poller/API chỉ biết interface. GMGN impl hôm nay; Birdeye adapter sau này thêm file mới, không đụng pipeline.
2. **MODE env** = `mock | gmgn`. Mock provider (deterministic) cho phép chạy full pipeline không cần key — demo/test ngay hôm nay.
3. Cadence + threshold nằm trong config/env — đổi không cần sửa code.
4. Khi mua Birdeye: thêm `providers/birdeye.ts` + WS ingest push vào cùng DB — poller thành fallback, API/UI không đổi.

## Gate chưa giải được (chặn MODE=gmgn, không chặn mock)

1. **GMGN wire protocol**: `GMGN_PRIVATE_KEY` là request-signing key (đã verify từ docs) nhưng header/định dạng chữ ký nằm trong `gmgn-cli` — xác nhận khi tạo key tại gmgn.ai/ai (cần Ed25519 pubkey upload + IPv4 egress).
2. **GMGN_BASE_URL** — không expose trên trang docs public; confirm cùng lúc.
3. `wallet_activity` historical depth — verify bằng call thật khi có key (sống còn cho backtest).

## Phạm vi lần này (deliverable)

- `server/` — Node 20 + TypeScript: provider interface, mock provider, gmgn provider (signing cô lập 1 hàm + VERIFY marker), rate limiter, SQLite, poller 3 sweep, API, tests (node:test, stdlib).
- Frontend: `restDataStore` qua `VITE_API_BASE`, mock localStorage thành fallback; dev qua Vite proxy `/api`.
- Deploy: docker-compose (web + api), nginx proxy, Makefile chuyển sang compose, target mới `make api-log`.
- Không đụng: components, docs cũ, Makefile deploy pattern.

## Metis review (qwen3.8-max-0902, 2026-09-08) — findings đã incorporate

**Blockers phải sửa khi build:** (1) `wallet_trades` dedupe `UNIQUE(wallet_id, ca, tx, side)` + INSERT OR IGNORE; (2) GMGN `event_type` whitelist buy/sell (không default-to-buy); (3) guard chia cho mc=0/holders=0 ở assembler; (4) `wallet_token_state` delete+insert per wallet trong transaction (sell-off phải decay).

**Decisions chốt:** `nansen.score` = count factor PASS, threshold env-configurable (FRESH_MIN=10, T100_MIN=5, LF bucket [30,100] từ spec) — placeholder chờ T duyệt; `trackedInflow` = cumulative; `trackedBy` = holding OR buy ≤ 7 ngày (`TRACKED_BY_WINDOW_MS`); T100 = cohort zero-fill trên prev-set, exclude addr_type=2 (filter theo prev snapshot), pairing = latest snapshot ≤ now-24h, thiếu → undefined; schema: PK `(ca, chain)` cho token_state, UNIQUE address wallets / (address,chain) tracked_cas, FK cascade + `PRAGMA foreign_keys=ON`, `fetched_at` trên token_state, index `(ca, taken_at DESC)`, retention snapshot ~72h (env `SNAPSHOT_RETENTION_MS`); **ingest layer tách khỏi poller** (seam thật cho WS sau này — poller và WS-ingest tương lai cùng gọi ingest, dedupe theo tx khiến push+poll共存 an toàn); poller = self-scheduling setTimeout + try/catch per task + single provider instance; precompute signal lúc sweep, API chỉ SELECT; `tier` widen thêm `null` (chạm types.ts + TierBadge — chấp nhận); mock provider phải dùng chung CA pool với seed tracked_cas (nếu không cột 2/5/6 trống trong demo); Entry threshold giữ client-side (không duplicate ở server); validation ở REST boundary (chain ∈ CHAINS, address non-empty → 400); migration localStorage→REST: server start rỗng, re-import CSV.


## Ước lượng sai lệch được đánh dấu rõ (không giấu)

- `lf` = current MC ($M) — xấp xỉ cho exchange-balance-at-listing (không có data lịch sử).
- `t100.multiple` = `1 + pct/10` — placeholder tuning knob cho tới khi T định nghĩa hệ số.
- Holder count chưa trừ burn/LP (spec cho phép ở v0).
