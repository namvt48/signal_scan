# wallet-watch WS thrash — root cause + fix (A+B+C)

Host `root@194.163.187.250`, service `wallet-watch` (systemd, `/opt/wallet-watch`).
File sửa: `watchers/sol/feed.py` → `run_ws_feed`.

## Triệu chứng
`watch.log` ~30% dòng là `ws đứt` (6124 / 20000 dòng cuối). Cả 6 shard rớt cùng lúc:
`ConnectionClosedError: sent 1011 (internal error) keepalive ping timeout` / `no close frame received`.

## Nguyên nhân
`process_sig` chạy **đồng bộ trong event loop** (`feed.py`), gọi `config.rpc("getTransaction")`
= `urllib.request.urlopen` **blocking** (timeout 20s/endpoint + retry + `time.sleep(0.7)`).
Loop bị chặn ⇒ `websockets` không trả pong kịp (đang lấy `ping_interval=20`, **không** set
`ping_timeout` → default 20s) ⇒ tự đóng 1011. 6 shard chung 1 loop → chết chùm.
Phụ: reconnect `sleep(2)` phẳng nên 6 shard hồi cùng lúc.

## Fix (`watchers/sol/feed.py`)
- **A** — thêm `_worker(q)`: `await asyncio.to_thread(process_sig, …)`. Loop rảnh → pong kịp.
  Một worker duy nhất nên `st` vẫn đơn luồng (không cần lock). Shard `await q.put(...)`
  (queue `maxsize=2000`) thay vì gọi `process_sig` trực tiếp.
- **B** — `websockets.connect(..., ping_timeout=60)`.
- **C** — reconnect backoff mũ + jitter: `delay = backoff + random.random()`,
  `backoff = min(60, backoff*2)`, reset `backoff=1.0` sau subscribe OK.

## Deploy
`rsync watchers/sol/feed.py → /opt/wallet-watch/watchers/sol/feed.py`; xoá `__pycache__`;
`systemctl restart wallet-watch`.

## Evidence
| # | Kiểm chứng | Kết quả |
|---|---|---|
| 1 | `python3 -m py_compile watchers/sol/feed.py` | OK |
| 2 | md5 local == remote `/opt/wallet-watch/watchers/sol/feed.py` | `8d437693e9a4b5f415e709bc9984fe32` |
| 3 | `systemctl is-active wallet-watch` | active (từ 2026-10-02 11:22:50 CEST) |
| 4 | 6 shard subscribe lại | `shard 1..6/6 logsSubscribe 34/34/34/34/34/33 ví (tổng 203)` |
| 5 | lọc non-base58 còn chạy | `bỏ 2 ví …: dryflip_5CL7, 0x0e17fc4e33` |
| 6 | `ws đứt` sau fix (~2.5 phút) | **0 mới** (tổng 22767 không đổi; format decimal mới = 0) |
| 7 | `worker process_sig` lỗi | 0 |
| 8 | feed sống | tx tới 16:25:01 ICT, `# rpc/60s … getTransaction` |
| 9 | Trước fix | 6124 / 20000 dòng cuối là `ws đứt` (~30%) |
