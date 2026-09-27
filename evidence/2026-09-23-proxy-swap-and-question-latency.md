# 2026-09-23 — swap proxy chậm + đo latency thật của câu hỏi Nansen

## Việc đã làm (prod `root@194.163.187.250`, `/root/signal_scan`)

- Backup: `/root/signal_scan/data/proxies-server.txt.bak-20260923T102634Z`
- Thay proxy chậm `194.163.187.250:31133` bằng `http://130.110.103.245:3128`
  (giữ nguyên `167.86.101.228:31128`). File sau swap = 2 dòng, door 0 = `.228`, door 1 = `130.110.103.245`.
- Restart: `docker compose restart api` (LƯU Ý: `make restart` KHÔNG tồn tại trong Makefile trên prod).
- Log xác nhận: `[crawl] loaded 2 proxies → 2 doors`, `0` dòng `proxy line skipped`.

## Chọn proxy thế nào (4 ứng viên http-only, vì `parseProxyFile` chỉ nhận http/https)

| proxy | tcp | egress | code | time |
|---|---|---|---|---|
| `159.65.233.169:54321` | closed | - | - | - |
| `130.110.103.245:3128` | OPEN | 130.110.103.245 | 200 | **0.585s** |
| `210.77.10.67:10808` | closed | - | - | - |
| `62.90.73.225:3128` | closed | - | - | - |

`130.110.103.245:3128` cũng là dòng đầu của `data/proxies-stable.txt` ("OK 7/7 | egress 130.110.103.245").
Scan trong container `signal_scan-api-1` KHÔNG dùng được: image thiếu `curl` → stage B luôn `https-alive 0/1`.

## Đo sau swap (`/api/health`, `docker logs`)

- doors: `[(0,'healthy',requests=1,200), (1,'healthy',requests=1,200)]`, `budgetUsed` 0–1 / 40 → **limit không phải nút cổ chai**.
- door0 (`167.86.101.228`): `warmup-ok` → `promoted tgm-essential-data status=200` sau **0.41s**.
- door1 (`130.110.103.245`): `warmup-ok` 3.56s → `promoted tgm-volume-details status=200` sau **32.17s**.

## Phát hiện quan trọng — latency là của PATH, không phải proxy

| path | proxy cũ `.250` (trước swap) | proxy mới `130.110.103.245` |
|---|---|---|
| `tgm-essential-data` | — | **0.41s** |
| `tgm-volume-details` | **26.02s** (sau warmup 10.15s) | **32.17s** (sau warmup 3.56s) |

→ `tgm-volume-details` ≈ 26–32s trên CẢ HAI proxy ⇒ latency nằm ở câu hỏi Nansen, không phải proxy.
Đính chính claim trước ("proxy chậm 26s/request"): 26s là chi phí path `tgm-volume-details`;
khiếm khuyết thật của proxy cũ là **warmup 10.15s** (so với 0.56–3.56s) và hay chết (outage 10:04).

## Vì sao "trước nhanh, giờ chậm" (cùng cách query)

1. Trước: đọc từ cache — `nansen-cache.json` + in-memory, `kickNansen ... cached + extremes updated` trong **0.07s**.
2. Outage 10:04 (2 door retired → mọi câu 502) + CA wipe xoá `token_state` ⇒ phải fetch lại thật ⇒ trả giá ~30s/câu.
3. Pacing giãn: volume 1h → 6 CA ≈ **8 phút/CA**; setup 12h → ≈ **96 phút/CA** (slotMs = interval×0.8/count).
4. Kick fail trong outage **không retry** tới slot kế tiếp (1h/12h) ⇒ CA trống lâu.
5. Cache hiện chỉ 5 entry (`taken_at`, `anchor_at`, `genesis_bal`, `series`, `series_from`, `t100_multiple`, `t100_pct`);
   EMBER / INUVIDIA / JEANPHIL chưa có entry ⇒ chưa có setup.

## Chưa fix (đề xuất)

1. Warm tay volume+setup cho 3 CA thiếu (mỗi câu ~30s, budget 30/path/60s dư sức).
2. Retry 1 lần khi kick 502 (sau khi pool hồi) — fix #2 lần trước.
3. Hạ `POLL_SETUP_MS`(12h)/`POLL_VOLUME_MS`(1h) hoặc `SWEEP_PACE_FACTOR`(0.8) — đánh đổi rủi ro CF 403/429.

## Bằng chứng lệnh

- `curl -x http://130.110.103.245:3128 https://api.ipify.org` → `200` `0.585s`
- `docker logs signal_scan-api-1 | grep '\[door'` → 4 `warmup-ok` + 4 `promoted`, không `403/429`, không `re-warm-fail`
- `/api/health` doors `healthy/200`, `budgetUsed=1/40`

EVIDENCE_RECORDED: evidence/2026-09-23-proxy-swap-and-question-latency.md
