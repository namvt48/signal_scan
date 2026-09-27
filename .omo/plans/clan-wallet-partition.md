# Plan: cột `clan` (nhãn hiển thị) + thêm 1 danh sách ví

Trạng thái: CHỜ CHỐT 1 ĐIỂM · Ngày: 2026-09-24 · Sửa lần 2 (bỏ lọc theo clan)

## 0. Sửa so với bản 1
User chốt: **`clan` chỉ là một cái tên bên cạnh `name` của wallet** — hiển thị thuần.
→ BỎ toàn bộ: lọc theo clan, header `X-Clan`, `trackedCasForClan`, `?clan=`, mọi thay đổi
`trackedWalletStats` / `sumHoldingAmount` / `assembleSignals`. **Không lọc gì theo clan.**

## 1. Mục tiêu
- Thêm cột `clan` vào ví: hiện **cạnh `tracked by`** (bảng signal) và **1 cột trong tab Wallet** (cạnh Name).
- Ví cũ → gán clan mặc định `a`.
- Thêm được **một danh sách ví khác** (import như danh sách hiện tại).
- Không đụng logic track/filter. `clan` không tham gia bất kỳ truy vấn nào.

## 2. Ràng buộc
- **KHÔNG fix bug MC = 0** (`nansen.ts`, `ingest.ts` không đụng).
- **Không lọc/track theo clan.** `clan` là text hiển thị.
- Daemon `scripts/wallet_watch.py` không đổi logic hiện có.
- Giữ nguyên hành vi cũ khi ví chưa có clan.

## 3. Thay đổi

### 3.1 Backend — schema + CRUD (chỉ lưu & trả về)
`server/src/db.ts`
- `WalletRow` (+ `clan: string | null`), `WalletInput` (+ `clan: string`), `ImportCandidate` (+ `clan: string`).
- `SCHEMA wallets` thêm `clan TEXT`; migration ALTER kiểu ad-hoc (mẫu `entry_usd`, `db.ts:204`).
- `UPDATE wallets SET clan = 'a' WHERE clan IS NULL;` (ví cũ).
- `listWallets` / `insertWallet` / `updateWallet` / `importWallets`: thêm cột `clan` vào SELECT/INSERT/UPDATE. **Không đổi WHERE.**
- `trackedByPairs`: `w.*` đã tự mang `clan` → không cần sửa.

`server/src/api.ts`
- `WalletJson` / `WalletBody` (+ `clan`), `toWallet` (+ `clan: row.clan ?? ''`).
- `parseWalletBody` / `parseWalletPatch` / `parseImportRows`: nhận `clan` (optional).
- `GET /api/wallets`, `GET /api/signals`: **không đổi** (không tham số clan).

`server/src/signals.ts`
- `TrackedWalletStat` (+ `clan?: string`).
- `trackedWalletStats`: thêm `w.clan AS clan` vào SELECT + map ra output. **Không đổi WHERE/GROUP/ORDER.**

### 3.2 Frontend — chỉ hiển thị
`src/types.ts`: `Wallet` (+ `clan?: string`), `TrackedWalletStat` (+ `clan?: string`).
`src/services/dataStore.ts`: `ImportRow` (+ `clan?: string`); `CSV_HEADER` + `'clan'`; `parseWalletsCsv` đọc `clan` (optional, CSV 5 cột cũ vẫn parse).
`src/components/WalletsPage.tsx`: cột **Clan** cạnh `Name` (bảng chính + skeleton + preview import); `downloadCsv` header thêm `clan`; `WalletModal` Draft + ô `clan`.
`src/components/SignalTable.tsx`: `WalletTable` thêm cột **Clan** cạnh `Wallet` (header + cell) — cập nhật `WALLET_COLS`.

### 3.3 Deploy — 2 instance, DB riêng (user chốt **A**)
Cùng 1 repo/image, 2 compose project. Mỗi instance: `api` + `chrome` + `web` + `data/` riêng.

- `docker-compose.yml`: bỏ hardcode `8124`; dùng `PORT` + `DATA_DIR` từ env. Thêm `COMPOSE_PROJECT_NAME`.
- `server/.env.a` / `server/.env.b` (hoặc biến Make): `PORT`, `DB_PATH`, `NANSEN_API_KEY`, `CRAWL_PROXY_FILE` riêng.
- `Makefile`: `INSTANCE ?= a`, `PORT ?= 8124`, `DATA_DIR ?= ./data`; `make deploy INSTANCE=b` → project `signal_scan_b`, port 8125, `./data-b`.
- `.gitignore`/rsync: loại `.env.*` và `data-*`.

### 3.4 Wallet-watch — **KHÔNG tách service mới** (trả lời câu hỏi user)
Vì 2 DB riêng, chọn 1 trong 2 (mặc định **A1**):
- **A1 (chọn, 0 dòng code)**: chạy **2 daemon cùng script**, mỗi cái `--api-url` trỏ API của mình
  (`:8124` và `:8125`), `--jsonl`/heartbeat path riêng. Ví chung ở cả 2 list → mỗi DB nhận trade của mình (đúng ý "chung ví").
  ↳ Chỉ là cấu hình + 2 entry watchdog (ops), không sửa `wallet_watch.py`.
- **A2 (không chọn)**: 1 daemon, `--api-url` lặp → phải sửa script (union ví 2 API + route event về API sở hữu ví).

## 5. Kiểm thử
1. `cd server && npm run build` → exit 0.
2. Migration: DB cũ → `SELECT DISTINCT clan FROM wallets` = `a`.
3. `GET /api/wallets` trả `clan`; `GET /api/signals` → `trackedWallets[].clan` có giá trị.
4. CSV export có cột `clan`; import lại ra đúng clan.
5. `npm run build` FE → exit 0; `lsp_diagnostics` sạch file đã sửa.
6. `server/test/signals.test.ts` lỗi sẵn có — không tính hỏng mới.

## 6. Ngoài phạm vi
- Fix MC = 0. Lọc/track theo clan. Tách wallet-watch thành service mới.

## 7. Rủi ro
- CSV 5 cột cũ (không có `clan`) vẫn phải parse được → `clan` optional, thiếu → `''`.
- `importWallets` là `INSERT OR IGNORE` dedupe theo address → nếu ví đã tồn tại ở instance kia (DB riêng) không ảnh hưởng.
