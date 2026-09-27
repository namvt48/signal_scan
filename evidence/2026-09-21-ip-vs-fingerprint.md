# CF limiter Nansen: key theo IP hay theo fingerprint/JA3?

Ngày 2026-09-21. Mục đích: chốt xem có cần mua proxy để query Nansen nhiều hơn, hay giới hạn bám theo fingerprint (proxy vô dụng).

## Phương pháp

Cùng một browser binary (`browserless/chrome:1.61-chrome-stable`, Chrome **121.0.6167.85**), cùng UA spoof
(`Chrome/131.0.0.0`), cùng patch `navigator.webdriver`, cùng flow: `goto https://app.nansen.ai/token-god-mode`
→ chờ → `POST` hai path API. Chỉ **IP nguồn** khác nhau.

| | IP A (local) | IP C (`167.86.101.228`) |
|---|---|---|
| `.../tgm-holders-gini-stats` | **429** `retry-after: 2204` (975B, 71ms) | **200** (458B, 682ms) |
| `.../tgm-volume-details` | **429** `retry-after: 2204` (975B, 71ms) | **200** (561B, 259ms) |
| JA3 / Chrome build | Chrome 121 | Chrome 121 (giống hệt) |

IP C đo lần đầu (chỉ chờ cố định 4s) còn ra: gini **403** body `<!DOCTYPE html>...<title>Just a moment...</title>`
(6472B, 29ms) + volume 200. Đo lại với vòng poll chờ challenge:

```
timeline: [{ t: 2.5, title: "Nansen AI - Trade Everything Onchain with AI", url: .../token-god-mode }]
cfCookies: [ "cf_clearance@.nansen.ai", "__cf_bm@.nansen.ai" ]
giniRetry: { status: 200, ms: 682, len: 458 }
```

## Kết luận

1. **Khoá của CF limiter là IP.** Cùng JA3, cùng thời điểm: IP A bị chặn, IP C được phục vụ đầy đủ.
   ⇒ proxy / xoay IP **có tác dụng**. IP datacenter đủ dùng (IP C là VPS, trả 200 ngay).
2. **Mỗi IP mới phải tự qua CF challenge trước.** Chưa có `cf_clearance` mà đã gọi API → **403 interstitial
   `Just a moment...`** (không phải 429, không phải 1015). Gọi sau khi challenge qua → 200.
3. **Phạt leo thang theo IP**: sau khi bị trip, cả 2 path trả 429 cùng một `retry-after` (2204s) dù trước đó
   luật có vẻ theo path (test trộn path tránh được trip ở session trước).
4. Body khi bị limit: CF **Error 1015**, `zone: app.nansen.ai`, 975 bytes, `retry-after` ~2797s — đúng như
   bằng chứng incident `evidence/2026-09-21-vol-1h-column.md`.

## Phát hiện phụ: prod đang tự bóp cổ (lúc đo)

Trên `194.163.187.250`: breaker **đang mở** (`[nansen] ... Error: crawl transport unhealthy — fast-fail`),
**0 × 429** trong 500 dòng log cuối, `signal_scan-chrome-1` ăn **2.306GiB / 3GiB**, log chrome có dòng
`Setting up page` lặp lại **mỗi ~4.5s** ⇒ vòng lặp: fetch trước khi `cf_clearance` kịp có → 403 interstitial
→ `crawl.ts` coi 403 là "clearance cũ" → `invalidatePage()` → page mới → 403 → … IP prod bị phạt thì challenge
không bao giờ qua ⇒ vòng lặp vĩnh viễn, không tự hồi.

Đối chiếu code: `server/src/crawl.ts` chỉ xử lý 403 (`if (out.status !== 403 || attempt === 2) return out;`),
**429 đi thẳng ra ngoài**, `retry-after` không đọc, và `breaker.fail()` chỉ đếm lỗi *thrown* nên breaker không
mở khi bị limit.

## Việc cần làm (chưa áp dụng)

- `crawl.ts`: đọc `retry-after` khi 429; phân biệt 403-interstitial (challenge chưa qua) với 403 thật;
  **không** rebuild page trong vòng lặp dày; chờ `cf_clearance` thay vì sleep cứng 4s.
- Áp cadence theo `evidence/2026-09-21-vol-1h-column.md` (`POLL_WALLETS_MS=5400000`, `POLL_HOT_MS=1800000`,
  `POLL_COLD_MS=7200000` ⇒ ~32 req/min).
- Nếu cần > trần/1 IP: browser-level proxy, sticky theo IP, xoay khi bị trip.

## Test pool proxy datacenter (10 IP, user `gyoerbgk`)

Format `host:port:user:pass`, HTTP proxy + auth, egress = chính IP đó (không phải gateway).

| Kết quả | |
|---|---|
| Reachable từ VPS | **6/10** (`31.59.20.176:6754`, `45.38.107.97:6014`, `198.105.121.200:6462`, `64.137.96.74:6641` chết hẳn — TCP drop cả socks5) |
| Chrome qua proxy | Được: `egressIp` = IP proxy ⇒ `--proxy-server` qua query string của browserless v1 hoạt động, `page.authenticate()` lo auth |
| `cf_clearance` | Cả 6 đều lấy được (2.5–5s) |
| API `gini` | **1/6 lần đầu 200** (`84.247.60.125`), 5/6 **403 interstitial**. Chạy lại vài phút sau: **6/6 × 403**, kể cả chính IP vừa 200 |
| Egress ổn định? | **Có** — 5/5 lần sample trong 1 session cùng IP ⇒ không phải xoay upstream phá cookie binding |

Kết luận phụ: `cf_clearance` là điều kiện cần, **không đủ**. CF còn cổng riêng trên path API, chấm theo
reputation của IP. IP pool là **IP dùng chung** nên điểm này trôi theo thời gian ⇒ verdict lật trong vài phút.

Đối chứng IP riêng cùng lúc (VPS `167.86.101.228`, không proxy): **4/4 × 200** (`ms` 164–758, body 457–458B).

⇒ **Proxy dùng được phải là IP riêng/không chia sẻ.** Pool datacenter dùng chung (dù có auth + sticky) không
đủ tin cậy cho Nansen. Đường rẻ và chắc: mỗi IP riêng một door (VPS riêng, đã chứng minh 200 ổn định).



- `/.probe/inline-probe.mjs`, `/.probe/challenge-probe.mjs` (tự chứa; chạy trong container `node:20-slim`
  với `--net=host`, trỏ `WS=ws://127.0.0.1:3009` vào chrome container), `/.probe/mk-payload.mjs` sinh
  `/tmp/fn.json`. Trên `167.86.101.228`: `docker run -d --name nansen-chrome-test -p 127.0.0.1:3009:3000
  -m 2g --shm-size=1g browserless/chrome:1.61-chrome-stable` (đã dọn container sau khi đo).
- Probe cũ đo trần/đường dẫn: `/.probe/p43-probe*.mjs`, raw `/.probe-p8-raw.json`.
