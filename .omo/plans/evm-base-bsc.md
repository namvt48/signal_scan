# Plan: evm-base-bsc — thêm EVM (Base + BSC) vào signal_scan

**Slug:** `evm-base-bsc` · **Status:** **APPROVED** (v1 — Momus round 1, verdict OKAY, 0 blocker; ~25 ref §2 đã verify trực tiếp trên disk) · **Owner decisions:** locked (D1–D11)
**Working dir:** `/home/namvt/Desktop/dev-space/signal_scan` (**KHÔNG phải git repo** ⇒ evidence ghi ra file, không có VCS diff)
**Instance đích:** chỉ **instance B** (`make deploy INSTANCE=b` — dir `/root/signal_scan_b`, port 8125, DB `data-b`, `SHOW_CLAN=on`, title `fomo`). Instance A giữ **Solana-only**, không đổi hành vi.
**Nguyên tắc:** mirror cơ chế Solana hiện tại; chỉ EVM-specific ở transport/classify.

---

## 1. Goal (definition of done)

Instance B chạy được **cả Solana lẫn Base + BSC** trên cùng DB/poller:
1. Signal table hiển thị CA EVM (`base`/`bsc`) với đầy đủ cột như Sol (price/mc/vol/holders/fresh/t100/lf/symbol) lấy từ GMGN + Nansen free crawl.
2. Wallet EVM: holdings (`wallet_token_state`) đi qua **EVM RPC** (không credit Nansen); trades (`wallet_trades`) đi qua **daemon EVM Python** độc lập (WS `eth_subscribe`).
3. 2 chain EVM (`base`, `bsc`) không đụng khoá dữ liệu nào (cùng `0x` address/CA trên 2 chain vẫn tách đúng).
4. Instance A deploy lại vẫn chạy y như cũ (Sol only, không hồi quy).
5. `watchers/` là nơi duy nhất chứa daemon production; `scripts/` chỉ còn probe/test/fixture.

Definition of done cần evidence file cho từng mục (§7).

---

## 2. Ground truth đã verify (đọc trước khi code)

### 2.1 Kiến trúc chain hiện tại (đã chain-parameterized)
- `server/src/shared/chain.ts:3` — `CHAINS = ['sol']`; mirror FE `src/types.ts:1`. **Đây là khoá type duy nhất.**
- `server/src/providers/provider.ts:102-118` — `MarketDataProvider` mọi method nhận `chain: Chain` (không cần đổi interface).
- `server/src/providers/composite.ts:22-27` — route theo `MetricKind` (essential/volume→GMGN, gini→Nansen), chain-blind.
- `server/src/providers/dexscreener.ts:20` — `/latest/dex/tokens` keyless, chain-agnostic.
- `signals.ts`, `snapshot.ts`, `detail.ts`, `crawl.ts` — chain-agnostic.

### 2.2 Chỗ sẽ THROW khi gặp chain EVM (bắt buộc sửa)
- `server/src/providers/gmgn.ts:40-43` — `gmgnChain()` chỉ `sol`, else throw.
- `server/src/providers/nansen.ts:92-97` — `nansenWebChain()` `{sol:'solana'}`, else throw.
- `server/src/providers/nansen.ts:500-505` — `nansenApiChain()` `{sol:'solana'}`, else throw.
- `server/src/providers/nansen.ts:611-613` — `assetInfo()` `chain==='sol' ? rpc : {}`.

### 2.3 Chỗ khoá chain-blind (blocker cho 2 chain EVM)
- `server/src/db.ts:97` — `wallets.address TEXT NOT NULL UNIQUE` (chain-blind).
- `server/src/db.ts:336` — `findWalletByAddress(address)` tra address-only.
- `server/src/db.ts:150-157` — `wallet_token_state` PK`(wallet_id, ca)` **không** chain.
- `server/src/db.ts:158-171` — `wallet_trades` `UNIQUE(wallet_id, ca, tx, side)` **không** chain.
- `server/src/ingest.ts:235-256` — `replaceWalletBalances` chỉ dùng `chain` để tra price, INSERT **không** ghi chain.
- `server/src/ingest.ts:262-288` — `insertTrades` bỏ chain (dù `WalletActivity.chain` có).
- `server/src/api.ts:157-166` — `WatchTrade` **không** có `chain`; `api.ts:423` dùng `findWalletByAddress(parsed.wallet)`.
- `server/src/poller.ts:830` — `kickWalletHoldingsFor` gate `if (chain !== 'sol') continue`.

### 2.4 Sol hiện đi qua đâu (mirror cho EVM)
- **Holdings**: `server/src/providers/solana.ts` `SolanaRpcClient.getTokenAccountsByOwner` (mint-filtered, 1 call/pair), gọi từ `nansen.ts:685-697`; chạy **trong** Docker (TS), cùng poller.
- **Trades**: `scripts/wallet_watch.py` (2057 dòng, Python) — `logsSubscribe{mentions}` (WS) / `getSignaturesForAddress` (poll); chạy **ngoài** Docker, deploy = `scp /opt/wallet-watch` + systemd (`make deploy` KHÔNG ship `scripts/`).
- **Price**: `wallet_watch.py` đã dùng DexScreener (`token_info` :528, `_price_from_pairs` :490) + GMGN optional (:435).

### 2.5 Slug per-provider (đã verify)
| chain | canonical | GMGN | Nansen | DexScreener | chainId |
|---|---|---|---|---|---|
| Solana | `sol` | `sol` | `solana` | `solana` | — |
| Base | `base` | `base` | `base` | `base` | 8453 |
| BSC | `bsc` | `bsc` | **`bnb`** | `bsc` | 56 |

### 2.6 Clan / instance B đã có sẵn (không phải việc mới)
- `wallets.clan` + migrate idempotent `db.ts:233-235`; API `api.ts:88/111/133`; `signals.ts:36-37/137/157`.
- FE gate `SHOW_CLAN`: `src/config.ts:9`, `SignalTable.tsx:33/54/70`, `WalletsPage.tsx:25/77/197/279`.
- Makefile instance b: `SHOW_CLAN=on`, port 8125, `data-b`.

---

## 3. Quyết định đã chốt (D1–D11)

- **D1** Thêm `base`, `bsc` vào `CHAINS`; giữ `sol`. Canonical slug = `base`, `bsc`.
- **D2** Map slug trung tâm 1 chỗ (theo §2.5): canonical→{gmgn, nansen, dexscreener, chainId, explorer, nativeSymbol}. `bsc`→nansen `bnb` là điểm lệch phải nhớ.
- **D3** RPC: **Alchemy free, 1 key dùng chung**, 2 URL chain-aware (`base-mainnet.g.alchemy.com/v2/<key>`, `bnb-mainnet.g.alchemy.com/v2/<key>`). Env mới `BASE_RPC_URL`, `BSC_RPC_URL`. Fallback keyless: `mainnet.base.org`, `bsc-dataseed.binance.org`.
- **D4** Không thêm provider class. EVM tái dùng GMGN (essential/volume) + Nansen **free crawl** (gini/fresh) bằng cách mở rộng map §2.2. Không dùng Nansen credit API cho EVM.
- **D5** Holdings EVM đi **EVM RPC**: `Multicall3` (`0xcA11bde05977b3631167028862bE2a173976CA11`) batch `balanceOf`, cache `decimals()`. Thay credit door cho EVM; bỏ gate sol-only ở `poller.ts:830` (đổi thành "chain có nguồn RPC holdings").
- **D6** Wallet watch EVM = **daemon Python riêng**, chạy độc lập, EVM-only, 2 chain (Base+BSC). Không đụng daemon Sol.
- **D7** Detect EVM: **WS `eth_subscribe('logs')`** với `topics:[Transfer,[w1..],null]` + `[Transfer,null,[w1..]]` (2 sub/chain phủ mọi ví); fallback `eth_getLogs` chunked + backfill khi WS reconnect; chờ **N confirmations** trước emit; classify buy/sell qua **DEX router/pool allowlist** (Base: Uniswap V3/Aerodrome/BaseSwap; BSC: PancakeSwap V2/V3/BiSwap); price DexScreener.
- **D8** Migration schema: `wallets` `UNIQUE(address,chain)`; `findWalletByAddress(address,chain)` + daemon POST kèm `chain`; `wallet_token_state` + `wallet_trades` thêm `chain` vào khoá.
- **D9** EVM chỉ chạy instance B; B chạy Sol+EVM. A không đổi.
- **D10** Clean architecture: `watchers/` (production: `common/`, `sol/`, `evm/`), `scripts/` (probe/test/fixture), `docs/research/` (gom research ở root).
- **D11** Không đụng project khác ngoài `signal_scan/` (`market-replay/`, `data-engineering/`...).

---

## 4. Tasks

### P0 — Nền (chặn mọi thứ)

- [ ] **T1** Mở rộng chain + map trung tâm
  - Files: `server/src/shared/chain.ts`, `src/types.ts`, (mới) `server/src/shared/chain-slugs.ts`
  - Việc: `CHAINS = ['sol','base','bsc']`; map canonical→{gmgn,nansen,dexscreener,chainId,explorer,nativeSymbol}; thay `gmgnChain`/`nansenWebChain`/`nansenApiChain` đọc từ map.
  - Acceptance: `npx tsc -p server` sạch; map có đủ 3 chain × 4 provider; `bsc→bnb` đúng.
  - deps: —
  - Evidence: `evidence/T1-typecheck.txt`; in map ra `evidence/T1-chain-map.txt`.

- [ ] **T2** Verify Nansen free crawl nhận chain EVM
  - Files: probe (mới) `scripts/probe_nansen_evm.py` hoặc dùng `crawl.ts` trực tiếp
  - Việc: gọi app-questions free endpoint với chain `base`/`bnb` trên 1 CA EVM thật; xác nhận không 403/404 và có `gini`/`fresh`.
  - Acceptance: có kết quả thật cho cả `base` và `bnb` (hoặc kết luận rõ: nếu free endpoint KHÔNG hỗ trợ EVM → dừng, chuyển phương án gini).
  - deps: —
  - Evidence: `evidence/T2-nansen-evm-probe.json` + ghi chú verdict.

- [ ] **T3** Migration schema chain-aware
  - Files: `server/src/db.ts`
  - Việc: `wallets` `UNIQUE(address,chain)` (rebuild table idempotent vì SQLite không drop UNIQUE) ; `wallet_token_state` PK`(wallet_id,ca,chain)`; `wallet_trades` `UNIQUE(wallet_id,ca,chain,tx,side)`. Giữ pattern migrate idempotent như `db.ts:233`.
  - Acceptance: mở DB cũ → migrate không mất row; mở lần 2 → no-op; A (chỉ sol) migrate vẫn chạy.
  - deps: —
  - Evidence: `evidence/T3-migrate.txt` (before/after counts).

- [x] **T4** Tra wallet theo (address, chain) + trade kèm chain — DONE 2026-09-27
  - Files: `server/src/db.ts`, `server/src/api.ts`, `server/src/ingest.ts`
  - Việc: `findWalletByAddress(address, chain)`; `WatchTrade` thêm `chain` (validate `isChain`); endpoint `/api/wallet-watch/trades` tra theo `(address, chain)`; `insertTrades`/`replaceWalletBalances` ghi `chain`.
  - Acceptance: POST cùng address khác chain → vào đúng wallet; `wallet_trades` có chain; test `wallet-watch-trade.test.ts` cập nhật + PASS.
  - deps: T1, T3
  - Evidence: `server/test/wallet-watch-trade.test.ts` PASS + `evidence/T4-rows.txt`.
  - Kết quả: resolver (address,chain); `WatchTrade.chain` vắng → 'sol' (compat daemon Sol đang deploy), lạ → 400; dup-guard POST/PATCH wallet key theo (address,chain); `insertTrades` ghi `a.chain` (giữ ON CONFLICT T3); `replaceWalletBalances` ghi chain + DELETE scope chain (sol sweep không xoá được row base); `emit.py::post_trade` default `chain='sol'`. Tests: 292 pass (283+9 mới: `wallet-chain-key.test.ts` + 4 case trong `wallet-watch-trade.test.ts`); tsc clean (server+root); pytest 59 pass. Probe: `scripts/t4_chain_rows_probe.ts`.

### P1 — EVM data + holdings (đọc)

- [ ] **T5** EVM RPC holdings client + bỏ gate sol-only
  - Files: (mới) `server/src/providers/evm.ts`; `server/src/providers/nansen.ts` (nhánh `walletTokenHoldings`), `server/src/poller.ts:830`
  - Việc: client EVM per-chain (config `BASE_RPC_URL`/`BSC_RPC_URL`); `walletTokenHoldings` cho chain EVM = Multicall3 `balanceOf` (scale theo `decimals()` cache) cho các CA được yêu cầu; native token bỏ qua (như SOL). Gate `kickWalletHoldingsFor` đổi thành "chain có RPC source".
  - Acceptance: 1 ví EVM ↔ holdings đúng token units; missing RPC config → skip êm, không crash; A không đổi.
  - deps: T1, T3, T4
  - Evidence: `server/test/*` mới/ cập nhật PASS + `evidence/T5-holdings.json` (mu/live).

- [ ] **T6** EVM signals end-to-end (data read)
  - Files: không thêm provider; chỉ verify luồng GMGN+Nansen map đã mở ở T1
  - Việc: seed/ thêm 1 CA `base` + 1 CA `bsc` thật; chạy 1 vòng `essentialSweep`/`volumeSweep`/`setupSweep`; xác nhận `token_state` có price/mc/vol/holders + `nansen_fresh_pct`.
  - Acceptance: `/api/signals` trả row base+bsc đủ cột; không throw `gmgn: unsupported chain` / `nansen: unsupported chain`.
  - deps: T1, T2
  - Evidence: `evidence/T6-signals.json`.

### P2 — Wallet watch EVM (daemon Python)

- [x] **T7** Clean architecture `watchers/` — DONE 2026-09-27
  - Files: `watchtr/`mới: `watchers/common/{price,emit,state}.py`, `watchers/sol/{feed,classify}.py` (tách từ `scripts/wallet_watch.py`, GIỮ hành vi); `scripts/` giữ probe/test/fixture.
  - Việc: tách `wallet_watch.py` thành package, KHÔNG đổi logic Sol; cập nhật import test; giữ entrypoint tương thích (`python -m watchers.sol` hoặc shim).
  - Acceptance: test Sol hiện có (`test_wallet_watch.py`, `test_route_detect.py`, `test_gmgn_api_parity.py`) PASS với module mới; output event không đổi.
  - deps: —
  - Evidence: log test PASS + `evidence/T7-sol-parity.txt`.
  - Kết quả: package `watchers/{__init__,common/{config,state,price,emit},sol/{classify,feed,main,__main__}}.py`; `scripts/wallet_watch.py` = shim namespace-phẳng (0 logic, giữ `ww.http_json`/`ww.STATE_PATH` monkeypatch + mutation gate) ⇒ **0 test phải sửa**, 59 pytest PASS + 9 script-style PASS. Parity AST: 60/64 def byte-identical, 55/55 const identical; 4 diff = seam có chủ đích (`main` bỏ `global` vì ref đã qualify; `watch_trade_event`→`post_trade`; `gmgn_info`/`token_info` nhận `chain="sol"`, cache key `<chain>:<ca>` cho CA EVM). Seam mới cho T8: `get_price_usd(ca, chain)` + `post_trade(trade)`. Evidence: `evidence/T7-{tree,entrypoint,sol-parity}.txt`.

- [ ] **T8** EVM watcher `watchers/evm/` (mới)
  - Files: `watchers/evm/{feed,classify,main}.py`; dùng chung `watchers/common/price.py` + `emit.py`
  - Việc:
    - feed: WS `eth_subscribe logs` (Transfer topic + OR ví, from/to), fallback `eth_getLogs` chunked; reconnect → backfill từ block cuối; chờ N confirmations.
    - classify: lấy `eth_getTransactionReceipt` → phát hiện swap qua router/pool allowlist per chain → side buy/sell; decimals scale.
    - price: DexScreener `/latest/dex/tokens/{ca}` → `amountUsd`; POST `/api/wallet-watch/trades` kèm `chain`.
    - config: `BASE_RPC_URL`/`BSC_RPC_URL` + WS endpoints; ví đọc từ API như Sol.
  - Acceptance: trên testnet/1 ví thật, mua/bán trên Base và BSC → POST đúng 1 event/trade, `side` đúng, `amountUsd` hợp lý; reconnect không mất event (backfill).
  - deps: T4, T7
  - Evidence: `evidence/T8-evm-events.jsonl` + `evidence/T8-reconnect.txt`.

- [ ] **T9** Deploy daemon EVM trên B (systemd)
  - Files: systemd unit + ghi chú deploy (như Sol: `scp` + systemd, KHÔNG qua `make deploy`)
  - Acceptance: service chạy trên B, log có event, restart tự động.
  - deps: T8
  - Evidence: `evidence/T9-service.txt` (status + tail log).

### P3 — FE + polish

- [ ] **T10** FE chain-aware
  - Files: `src/components/SignalTable.tsx:104` (explorer `gmgn.ai/{slug}/token/`), `src/components/WalletsPage.tsx:71` (placeholder), `src/types.ts` (đã ở T1)
  - Việc: explorer map theo chain (Base `/base/`, BSC `/bsc/`); placeholder address trung tính; CSV import/export tự nhận EVM (đã qua `CHAINS`).
  - Acceptance: CA base/bsc → link đúng; import CSV chain `base`/`bsc` OK.
  - deps: T1
  - Evidence: `evidence/T10-fe.txt` + `npm run build` exit 0.

### P4 — Kiểm chứng

- [ ] **T11** Regression instance A
  - Việc: `make deploy` (A) + `make test`; xác nhận Sol-only không hồi quy (DB migrate chạy, signals cũ N cột).
  - deps: T1, T3, T4, T5, T10
  - Evidence: `evidence/T11-instance-a.txt`.

---

## 5. Risks / verify-needed (phải xác nhận trong lúc làm, không được giả định)

- **R1** Nansen **free crawl** có thực sự nhận chain EVM (`base`/`bnb`) không — T2 chứng minh. Nếu KHÔNG ⇒ gini EVM cần nguồn khác (GMGN? bỏ cột? Nansen paid?) → mở lại quyết định. **→ RESOLVED 2026-09-27:** door (CDP) trả 200 cho `base` + `bnb` (cả 2 question, 2 lần chạy); control `notachain` → 400 kèm allowlist có `base`/`bnb`. Evidence: `evidence/T2b-nansen-evm-door.txt`, `evidence/T2-nansen-evm-probe.instanceA.json`. T6 UNBLOCKED.
- **R2** Alchemy free WS `eth_subscribe` có trên **cả** Base và BNB Chain không; và `eth_getLogs` range cap per chain (Base block ~2s, BSC nhanh) → chunk size.
- **R3** Reorg Base/BSC → số N confirmations an toàn; Sol dùng cơ chế riêng nên **không** port thẳng.
- **R4** GMGN weight budget: 1 key dùng chung, Free **5 call/s** (`gmgn.ts:19-21`); 3 chain trên B tranh nhau → kiểm capacity, chấp nhận giảm cadence nếu cần.
- **R5** DexScreener rate limit (60-300/min) chia giữa watcher price + icon sweep → cache price.
- **R6** `Multicall3` có mặt trên Base (có) và BSC (có) — verify địa chỉ trước khi hardcode.
- **R7** Daemon EVM đọc "ví theo dõi" từ API: cần API trả ví theo chain (T4) — đảm bảo endpoint lọc/trả `chain`.

---

## 6. Out of scope

- Chain EVM khác (eth/arb) — D1 chỉ base+bsc; thêm sau = thêm dòng map, không thêm code path.
- Nansen credit API cho EVM (D4 từ chối).
- Token detail page / balance-chart (đang disabled, `api.ts:456-488`) — không mở lại.
- Đổi cơ chế gini/fresh của Solana.
- Đụng instance A logic ngoài việc migrate schema an toàn.
- Project khác ngoài `signal_scan/` (D11).

---

## 7. Evidence convention

Repo **không phải git** ⇒ mọi bằng chứng ghi ra file dưới `evidence/` với tên như trên (T1..T11). Mỗi task Done ⇔ file evidence tồn tại + nội dung chứng minh acceptance. Không có evidence = chưa xong.
