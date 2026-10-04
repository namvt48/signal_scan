# Evidence — B: chặn ví sol non-base58 (2026-10-02)

Fix: (B1) validate base58/32-byte cho `chain:'sol'` tại API boundary + (B2) daemon
`wallet-watch` lọc non-base58 trước `logsSubscribe` — 1 ví rác không còn giết cả shard.

## Success criteria + evidence

| # | Tiêu chí | Lệnh / quan sát | Kết quả |
|---|----------|-----------------|---------|
| 1 | Validator JS đúng | `cd server && npx tsc --noEmit` | exit 0 |
| 2 | Không hồi quy | `cd server && npm test` | tests 577, **pass 577, fail 0** |
| 3 | POST/PATCH/import chặn non-base58 sol | `test/wallet-chain-key.test.ts` "non-base58 sol rejected → 400"; `wallet-clan` fixtures dùng pubkey thật | pass |
| 4 | Validator Python đúng | `_valid_pubkey`: `So111…112`/`EPjFW…t1v`/`1×32` → True; `dryflip_5CL72…`(len52)/`0x0e17…`/`w-buy` → False; `py_compile` ok | pass |
| 5 | API a+b build & chạy | in-image `tsc` ok; `/api/health` 8124=200, 8125=200 | ok |
| 6 | Mount đúng DB | `docker inspect`: a=`/root/signal_scan/data`, b=`/root/signal_scan_b/data-b` | ok |
| 7 | Daemon dùng code mới | md5 local == `/opt/wallet-watch/watchers/sol/feed.py` = `218f5716f807d0f9859d2040443ac1c4`; `systemctl is-active`=active | ok |

## Trước / sau restart daemon (`/opt/wallet-watch/watch.log`)

- Trước: `Invalid mentions` = 13186; shard 5/6 chết lặp `Invalid mentions`; tổng 205 ví.
- Dòng lọc: `# feed=ws bỏ 2 ví non-base58 (Helius từ chối cả shard): dryflip_5CL7, 0x0e17fc4e33` (line 215266).
- Sau: 6/6 shard subscribe, **tổng 203** (205−2).
- `awk NR>215266 /Invalid mentions/` = **0**; `/ws đứt shard/` = **0**.
- Dòng `Invalid mentions` mới nhất = 215260 (< 215266); +2 so với trước là của process cũ lúc chuyển giao, không tăng lại sau 5s.
- Heartbeat tươi; event `transfer … PUMP` chảy sau restart.

## Ghi chú
- 2 ví rác vẫn nằm trong DB (user: "kệ 2 ví đó"); B2 lọc lúc subscribe nên shard 5 sống.
- Forward-only: chỉ bắt tx TƯƠNG LAI, 5 tx lịch sử của "Ton" không hồi phục được.
- Rollback: `git checkout server/src/{api,db,shared/chain}.ts`; daemon: khôi phục `feed.py` cũ + restart.
