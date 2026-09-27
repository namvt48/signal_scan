---
slug: rpc-realtime-inflow
status: awaiting-approval
intent: clear
review_required: false
classification: standard
pending-action: approval brief presented — chờ user okay thì write .omo/plans/rpc-realtime-inflow.md (scaffold không --draft-only → Metis → append todos)
approach: >
  Thêm tầng real-time ingest mới (server/src/realtime.ts) stream sự kiện on-chain
  trực tiếp từ public RPC (WSS) cho 4 chain (bsc/sol/eth/base), decode thành
  WalletActivity rồi ghi qua seam ingest.insertTrades (dedupe UNIQUE(wallet_id,ca,tx,side))
  — push + poll cùng tồn tại; walletSweep Nansen 15' giữ nguyên làm reconciliation/backfill.
  trackedInflow/Tracked By trở nên realtime (giây) không tốn thêm credit, $0.
---

# Draft: rpc-realtime-inflow

## Components (topology ledger)
<!-- id | outcome (one line) | status | evidence path -->
- C1 | EVM realtime log-stream (bsc/eth/base): eth_subscribe("logs") lọc Transfer theo tracked-CAs × tracked-wallets → WalletActivity → insertTrades | active | server/src/ingest.ts:185, server/src/providers/nansen.ts:368
- C2 | Solana realtime sig-stream: logsSubscribe mentions=[wallet] (fan-out 1 sub/ví) → getTransaction(jsonParsed) → parse SPL transfer mint∈tracked-CAs → insertTrades | active | (research: mentions=1 limit)
- C3 | Wiring + lifecycle + config: index.ts start hook, env (RPC_*), auto-reconnect, refresh filter khi wallets/CAs thay đổi, docker-compose, health | active | server/src/index.ts, server/src/config.ts, docker-compose.yml

## Open assumptions (announced defaults)
<!-- assumption | adopted default | rationale | reversible? -->
- RPC endpoints | dRPC keyless WSS primary (wss://bsc.drpc.org, wss://eth.drpc.org, wss://base.drpc.org) + publicnode fallback; Solana public wss://api.mainnet-beta.solana.com + optional HELIUS_* env | research-verified free, supports logs sub multi-address+topics (dRPC); publicnode zero-documented-limits làm redundancy; toàn bộ env-overridable | yes (env)
- "block trực tiếp" hiện thực bằng log/event subscription (server-side filter), không parse full-block | eth_subscribe("logs") / logsSubscribe — full-block (BSC 0.45s, ETH 12s blocks hàng trăm tx) không khả thi trên free tier; log sub cũng là "trực tiếp từ RPC", nhẹ hơn hàng chục lần | yes
- USD valuation cho trade RPC-path | amount × token_state.price (refresh 2'/lần qua tokenSweep, đã có sẵn); thiếu price → ghi amount_usd=0 + insertTrades thêm self-heal ON CONFLICT UPDATE (0→giá trị thật khi Nansen sweep bắt lại cùng tx) | lazy, không cần price feed mới; reconciliation tự lành | yes
- Gap khi restart/reconnect | KHÔNG cần persistent cursor: walletSweep Nansen 15' vẫn chạy = tầng đối soát, dedupe tx-hash khiến push+poll an toàn (design gốc của ingest.ts) | dùng lại seam có sẵn | yes (nếu cắt Nansen mới cần cursor)
- Reorg | accept latest (EVM) / confirmed (Solana); trade bị reorg ở lại DB — xác suất không đáng kể với dashboard, Nansen sweep không tái xác nhận row đã dedupe | known limitation, ghi docs | yes
- Balances (trackedHolding) | giữ nguyên Nansen 15' — realtime chỉ phủ trades (đúng yêu cầu "inflow"); replaceWalletBalances là full-replace, delta realtime sẽ xung đột semantics | scope discipline | yes
- Số subs EVM | 2 subscription/chain (buy = topics[T,null,[wallets]], sell = topics[T,[wallets],null]), address=[tracked CAs] | server-side filter tối đa, notification volume ≈ số trade thật | yes

## Findings (cited - path:lines)
- trackedInflow 24h = SUM(amount_usd) wallet_trades buy 24h — server/src/signals.ts:53-61 (sumTrackedBuyUsd), assembleSignals:194
- Nguồn trades hiện tại: walletSweep mỗi 900s (WALLET_SWEEP_SEC, server/src/config.ts:37) → Nansen dexTrades 1 credit/wallet + currentBalance 1 credit/(wallet,CA) — server/src/poller.ts:150-171, server/src/providers/nansen.ts:367-395,502-522
- FE poll /api/signals 30s — src/components/SignalTable.tsx:34-35
- Seam được THIẾT KẾ SẴN cho push ingest: header server/src/ingest.ts:1-4 "future WS ingest calls the same ones, push + poll coexist safely"; dedupe UNIQUE(wallet_id,ca,tx,side) — server/src/db.ts:138-150; docs/2026-09-08-free-only-deployment-plan.md (mục "ingest layer tách khỏi poller")
- poller có ceiling detector "upgrade path: paid WS provider" — server/src/poller.ts:179-183 → hướng này thay bằng FREE RPC
- Chains: bsc/sol/eth/base — server/src/shared/chain.ts:3; seed wallets có đủ 4 chain — src/services/dataStore.ts:163-172 (8 ví)
- Server runtime: node:20-slim — server/Dockerfile:2; deps chỉ better-sqlite3/express/puppeteer-core — server/package.json (KHÔNG có lib EVM/WS; Node 20 không có global WebSocket stable — stable từ v22.4, research)
- ERC-20 Transfer topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef (hằng số, không cần keccak lib)
- V2 Swap topic0 = 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822; V3/PancakeV3 Swap = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67 (dùng cho receipt-check xác nhận DEX trade)
- RESEARCH (librarian, sources trong session): dRPC free 210M CU/30d, 20 CU/notification, logs sub multi-address+topics OK (docs drpc.org); publicnode WSS 3 chain EVM + solana, không công bố limit; BSC 0.45s block (Fermi 2026-01), ETH 12s, Base 2s; Solana logsSubscribe mentions=CHỈ 1 address (solana.com docs) + SPL transfer mention ATA không phải owner NHƯNG wallet là signer tx của chính nó → mentions=[wallet] bắt được; public solana 100 req/10s/IP, 40 conn/IP; Helius free 1M credits/mo, 5 WSS conn, getTransaction ~10 credits; Ankr free HTTP getLogs range ≤1000 blocks; eth_getLogs HTTP fallback cap 10k logs

## Decisions (with rationale)
- F1 = BOTH, tách cột nguồn (user 2026-09-11): wallet_trades thêm cột `src TEXT NOT NULL DEFAULT 'dex'` ('dex'|'transfer'; migration ALTER TABLE theo pattern sẵn có db.ts:182 — rows cũ đều từ Nansen dexTrades nên default 'dex' đúng). RPC path: match Transfer → fetch receipt → có Swap topic (V2 0xd78ad95…/V3 0xc42079f9…) cùng tx ⇒ src='dex', không ⇒ src='transfer' (receipt-fetch fail ⇒ bảo thủ 'transfer'). trackedInflow (sumTrackedBuyUsd) + trackedByNames chỉ tính src='dex' — semantics cột dashboard bất biến, transfer rows = data capture cho UI sau.
- F1 kéo theo: insertTrades dedupe upgrade — INSERT … ON CONFLICT(wallet_id,ca,tx,side) DO UPDATE với promotion hierarchy: excluded.src='dex' thắng current.src='transfer' (Nansen sweep promote rows RPC bảo thủ), amount_usd>0 thắng amount_usd=0 (self-heal price-missing), KHÔNG bao giờ downgrade dex→transfer. UNIQUE constraint giữ nguyên.
- F2 = giữ FE poll 30s (user): KHÔNG đụng file FE nào; data tươi ≤ ~30s thay vì ≤ ~15'30s.
- F3 = node:20 + dep `ws` (user): không bump image, không rủi ro better-sqlite3 prebuild.
- F4 = tests-after (user): node:test stdlib + tsx theo pattern server/test hiện có; pure decoders (EVM log/receipt→WalletActivity, Solana jsonParsed tx→WalletActivity) + fake-WS in-process e2e (ws server trong test → assert rows SQLite).

## Scope IN
- Server-side real-time ingest module (EVM bsc/eth/base + Solana), ghi vào wallet_trades qua insertTrades — kèm promotion upsert ở trên
- Schema: ALTER TABLE wallet_trades ADD COLUMN src (migration idempotent) + sumTrackedBuyUsd/trackedByNames filter src='dex'
- Config env mới (RPC_REALTIME, RPC_WSS_BSC/ETH/BASE/SOL defaults dRPC/publicnode, SOL optional HELIUS_RPC_WSS), index.ts wiring (chỉ bật khi mode!=mock), auto-reconnect + ping keepalive, refresh filter khi wallets/tracked-CAs đổi (re-subscribe khi set hash đổi)
- docker-compose: RPC_REALTIME=on cho service api (giống NANSEN_CRAWL)
- Health endpoint mở rộng: trạng thái sub/last-event mỗi chain + tests node:test

## Scope OUT (Must NOT have)
- KHÔNG đụng FE (components/dataStore/SignalTable giữ nguyên, kể cả interval 30s)
- Không UI mới cho transfer rows (data capture only, hiển thị = việc khác sau này)
- Không thay wallet_token_state/balances semantics (vẫn Nansen sweep)
- Không bỏ walletSweep Nansen (reconciliation + balance; tần suất vẫn env-tunable, mặc định 900s giữ nguyên)
- Không persistent block cursor / reorg rollback logic
- Không paid provider; không API key bắt buộc (Helius optional)
- Không backfill lịch sử qua RPC (NANSEN_BACKFILL_FROM đường Nansen giữ nguyên)
- Không Solana ATA fan-out cho transfer thụ động (chỉ bắt tx do chính ví ký — mentions=[wallet]; nhận quà không ký = Nansen sweep bù)

## Open questions
- (đã chốt hết F1-F4 — không còn fork mở)

## Approval gate
status: awaiting-approval
Brief đã trình bày (chat). User okay → scaffold plan (không --draft-only) → Metis gap analysis → append todos → TL;DR cuối → CLEAR+review_required=false nên hỏi 1 câu: start-work now hay dual high-accuracy review trước.
