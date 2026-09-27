"""Feed Solana: `run_ws_feed` (logsSubscribe{mentions}, 1 connection/key, shard
theo ví) và `run_block_feed` (getBlock tuần tự, forward-only) → `_handle_tx`
là emit path duy nhất.

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import json
import sys
import time
from typing import Any, Iterator

from watchers.common import config
from watchers.common.config import RPC_DEFAULTS, load_config_from_api
from watchers.common.emit import fmt, jl_write, track_event, watch_trade_event
from watchers.common.price import _warm_prices
from watchers.common.state import _beat, save_state
from watchers.sol.classify import _keys, _target_event, detect_events

# (sig, wallet, mint, side, step) đã emit — cùng tx có thể tới 2 lần (ws + poll,
# hoặc 2 run khi watermark lùi); ponytail: set không cap trong 1 run, LRU nếu chật.
_emitted: set[tuple[str, str, str | None, str | None, int | None]] = set()


def _handle_tx(tx, sig, wallets, st) -> None:
    """Emit path DUY NHẤT — chỉ block feed gọi: tx lấy TRỰC TIẾP từ getBlock của
    slot đang quét (KHÔNG crawl sig lịch sử của ví). Mỗi ví tracked có mặt trong
    accountKeys → detect_swaps → print + jl_write + track_event, rồi cập nhật
    head. KHÔNG save_state — caller tự quyết nhịp lưu.

    `_warm_prices` chạy TRƯỚC detect_swaps (giá quote phải có sẵn trong cache);
    `_target_event` gộp cả tx về ĐÚNG 1 token đích để `track_event` — log/
    `events.jsonl` vẫn giữ đủ MỌI step để soi route."""
    if config._cfg_next and time.time() >= config._cfg_next:  # ~5 phút/lần, chỉ khi tới hạn
        load_config_from_api(wallets)
    # FIX discovery: accountKeys (dù đã merge ALT qua _keys) vẫn bỏ sót ví chỉ
    # xuất hiện qua ATA của nó — 3jjAdrCK: EC2f5Dn nhận 15.000 USDC mà KHÔNG nằm
    # trong accountKeys ⇒ tx vô hình, không event, không CA. Owner trong
    # pre/postTokenBalances là nguồn "ví có liên quan" đầy đủ, sẵn có trong
    # payload (0 RPC thêm).
    _meta = tx.get("meta") or {}
    keys = set(_keys(tx["transaction"]["message"], _meta))
    keys |= {
        b["owner"]
        for b in (_meta.get("preTokenBalances") or [])
        + (_meta.get("postTokenBalances") or [])
        if b.get("owner")
    }
    hits = [w for w in wallets if w in keys]
    if (
        not hits
    ):  # tx không dính ví nào ⇒ KHÔNG warm giá (bottleneck cũ: 0.1s/mint × mọi tx)
        return
    _warm_prices(tx)
    for w in hits:
        st["wallets"].setdefault(w, {})["head"] = sig
        evs = detect_events(tx, w)
        ms = int((tx.get("blockTime") or time.time()) * 1000)  # §5.4 mốc epoch-ms
        fresh = []
        for ev in evs:
            ev["ts_epoch_ms"] = ms
            key = (sig, w, ev.get("mint"), ev.get("side"), ev.get("step"))
            if key in _emitted:  # §5.5 dedupe tường minh theo hop
                continue
            _emitted.add(key)
            fresh.append(ev)
            print(fmt(ev), flush=True)
            jl_write(ev)
        # POST theo TỪNG hop net>0 (Q5): trước đây 1 CA/tx ⇒ hop 2..n mất khỏi
        # queue/Tracked by. _target_event giữ làm fallback cho rule A (OTC fill:
        # ví bán, không có BUY event nào của chính ví). `fresh` rỗng = tx đã xử lý
        # (ws+poll trùng, hoặc watermark lùi) ⇒ không post lại.
        hops = [
            e
            for e in fresh
            if e.get("type") == "SWAP"
            and (
                (e.get("side") == "BUY" and (e.get("qty_net") or 0) > 0)
                or e.get("side") == "SELL"
            )
        ]
        for ev in hops:
            track_event(ev)
            watch_trade_event(ev, tx.get("blockTime"))
        if fresh and not hops:
            ev = _target_event(tx, w, evs)
            if ev is not None:
                track_event(ev)
                watch_trade_event(ev, tx.get("blockTime"))


# T7 §5.8: tham số getBlock cố định của block feed (hoist ra module để
# run_block_feed < 50 dòng). maxSupportedTransactionVersion: đo 2026-09-15 trên
# publicnode — ver 0 ⇒ 20/20 slot chết -32015 "Transaction version (1) is not
# supported" (mainnet đã có tx version-1); ver 1 ⇒ block thật ~10-14MB/slot.
_BLOCK_PARAMS = {
    "encoding": "jsonParsed",
    "transactionDetails": "full",
    "maxSupportedTransactionVersion": 1,
    "rewards": False,
    "commitment": "confirmed",
}

# --once: trần số slot không dùng được (skip/None/malformed) liên tiếp trước khi
# save + return — --once KHÔNG được thành vòng quét vô hạn.
_ONCE_MAX_SLOTS = 5

# lossless: lỗi getBlock được PHÂN LOẠI. Chỉ slot 'skipped' THẬT mới bỏ; lỗi tạm
# thời ⇒ retry ĐÚNG slot đó (skip-mọi-lỗi là nguồn mất data cũ); hết
# _BLOCK_RETRY_MAX lần vẫn lỗi ⇒ log rõ + tiến 1 slot (mất ≤1 slot, không âm thầm).
_BLOCK_RETRY_MAX = 30
_RETRY_BASE_S = 1.0
_RETRY_CAP_S = 30.0
_LAG_WARN = 50  # chỉ để in cảnh báo; KHÔNG bao giờ nhảy slot vì lag


def _block_err_kind(msg: str) -> str:
    """Phân loại message lỗi getBlock: 'skip' = slot thật sự bị bỏ (result null
    hoặc -32004 'skipped'/'missing due to ledger jump'); còn lại = 'retry' (tạm
    thời, hoặc block chưa lan tới node). rpc() chỉ giữ text, không giữ code."""
    m = msg.lower()
    if "skipped" in m or "missing due to" in m or "missing from ledger" in m:
        return "skip"
    return "retry"


def _block_txs(blk, slot) -> Iterator[dict[str, Any]]:
    """Block entry → tx dict dạng getTransaction (không fetch lần 2, §T7)."""
    for en in blk.get("transactions") or []:
        yield {
            "slot": slot,
            "blockTime": blk.get("blockTime"),
            "transaction": en["transaction"],
            "meta": en.get("meta"),
            "version": en.get("version"),
        }


def run_block_feed(wallets, st, opts) -> None:
    """Block-scan TUẦN TỰ, không mất data.

    - Đi liên tục slot+1; lag chỉ là CẢNH BÁO (catch-up tuần tự), KHÔNG nhảy.
    - Lỗi tạm thời ⇒ retry ĐÚNG slot (backoff); chỉ slot 'skipped' thật mới bỏ.
    - block_slot = slot cuối đã xong ⇒ restart chỉ reprocess (downstream
      idempotent), không mất block.
    - Tx chỉ lấy từ getBlock của slot hiện tại — KHÔNG crawl sig lịch sử của ví.
    --once: xử lý 1 block rồi thoát (test)."""
    cur = int(config.rpc("getSlot", [{"commitment": "confirmed"}]))
    b = st.get("block_slot")
    slot = b + 1 if b is not None else cur
    prev_slot = st.get("prev_block_slot")
    print(
        f"# feed=block: resume slot {slot} | head {cur} | gap {max(0, cur - slot)}",
        flush=True,
    )
    attempts = 0
    unused = 0
    last_warn = 0.0
    _beat()
    while True:
        cur = int(config.rpc("getSlot", [{"commitment": "confirmed"}]))
        if cur - slot > _LAG_WARN and time.monotonic() - last_warn > 30:
            print(
                f"# lag {cur - slot} slot (đang ở {slot} < head {cur}) — catch-up tuần tự",
                flush=True,
            )
            last_warn = time.monotonic()
        if slot > cur:
            if opts["once"]:
                save_state(st)
                return
            time.sleep(opts["sleep"])
            _beat()
            continue
        blk = None
        try:
            r = config.rpc("getBlock", [slot, _BLOCK_PARAMS])
        except RuntimeError as err:
            kind = _block_err_kind(str(err))
            if kind != "skip":
                print(f"# retry slot {slot} (lần {attempts + 1}): {err}", flush=True)
        else:
            if isinstance(r, dict) and isinstance(r.get("transactions"), list):
                blk = r
                kind = "ok"
            elif isinstance(r, dict):
                kind = "retry"  # malformed ⇒ thử lại
            else:
                kind = "skip"  # result null ⇒ slot thật sự bị bỏ
        if isinstance(blk, dict):
            for tx in _block_txs(blk, slot):
                _handle_tx(tx, tx["transaction"]["signatures"][0], wallets, st)
            ps = blk.get("parentSlot")
            if prev_slot is not None and isinstance(ps, int) and ps < prev_slot:
                print(
                    f"# WARN slot {slot}: parentSlot {ps} < prev {prev_slot} (reorg?)",
                    flush=True,
                )
            st["block_slot"] = slot
            st["prev_block_slot"] = prev_slot = slot
            save_state(st)  # lưu MỖI block ⇒ restart resume chính xác
            _beat()
            slot += 1
            attempts = 0
            if opts["once"]:
                return
            continue
        if kind == "skip":  # slot thật sự bị bỏ — bình thường
            st["block_slot"] = slot
            slot += 1
            attempts = 0
            unused += 1
        else:  # retry — thử lại đúng slot
            attempts += 1
            if attempts >= _BLOCK_RETRY_MAX:
                print(
                    f"# GIVEUP slot {slot} sau {attempts} lần thử — tiến 1 slot",
                    flush=True,
                )
                st["block_slot"] = slot
                slot += 1
                attempts = 0
                unused += 1
            else:
                time.sleep(min(_RETRY_CAP_S, _RETRY_BASE_S * 2 ** (attempts - 1)))
                _beat()
                continue
        # --once KHÔNG được quét vô hạn trên chuỗi slot chết; thoát có save_state
        # để block_slot persist cho resume.
        if opts["once"] and unused >= _ONCE_MAX_SLOTS:
            save_state(st)
            return


def _wss(url: str) -> str:
    """Endpoint websocket suy từ endpoint HTTP tương ứng."""
    return url.replace("https://", "wss://").replace("http://", "ws://")


# Helius free cap số subscription MỖI KEY: dồn 198 sub (1 logsSubscribe/ví) vào 1
# connection/1 key ⇒ `1013 Rate limit reached: Too many subscriptions`, mỗi
# reconnect lại đẩy đủ 198 sub ⇒ hố không nhận event (đo 09-24: mất 3 tx). Chia
# mỗi key 1 connection ⇒ ~33 sub/key, dưới cap.
def _ws_shards(items, n):
    """Chia vòng tròn `items` ra n shard rời nhau, phủ hết, lệch ≤1 phần tử."""
    n = max(1, min(n, len(items) or 1))
    return [items[i::n] for i in range(n)]


def process_sig(sig, wallets, st, err=None) -> None:
    """Fetch 1 tx rồi emit qua _handle_tx (dedupe theo hop nằm TRONG _handle_tx).
    err!=None = tx fail ⇒ không fetch."""
    if err is not None:
        return
    try:
        tx = config.rpc(
            "getTransaction",
            [
                sig,
                {
                    "encoding": "jsonParsed",
                    # mainnet có tx version-1; ver=0 ⇒ -32015 "Transaction version
                    # (1) is not supported" ⇒ MẤT MỌI tx v1 (cùng defect của
                    # _BLOCK_PARAMS — đo 2026-09-15).
                    "maxSupportedTransactionVersion": 1,
                    "commitment": "confirmed",
                },
            ],
        )
    except Exception as e:
        print(f"  ! {sig[:12]}… getTransaction: {e}", file=sys.stderr)
        return
    if not tx:
        return
    _handle_tx(tx, sig, wallets, st)
    save_state(st)


def run_ws_feed(wallets, st) -> None:
    """Feed chính: ws `logsSubscribe` (1 sub/ví) — node push ngay sig của tx có
    nhắc ví. Chia ví ra `len(RPCS)` connection, MỖI KEY 1 connection — rớt thì
    shard đó đổi key kế. FORWARD-ONLY: KHÔNG crawl getSignaturesForAddress (nguồn
    CA cũ). Ví ký giao dịch của chính nó ⇒ có trong accountKeys ⇒ `mentions` luôn
    khớp, không miss CA (tx bên thứ 3 chỉ chạm ATA là log-only, không sinh CA)."""
    import asyncio

    try:
        import websockets
    except ImportError:
        sys.exit("feed=ws cần:  pip install websockets   (hoặc --feed block)")

    async def _beat_loop():
        while True:  # watchdog coi heartbeat là sống; ví im lặng vẫn phải đập nhịp
            _beat()
            await asyncio.sleep(30)

    async def _shard(sid, sliced, eps, nshard):
        k = sid  # shard khởi động ở key riêng ⇒ các connection không trùng key
        while True:
            try:
                async with websockets.connect(
                    _wss(eps[k % len(eps)]),
                    open_timeout=10,
                    ping_interval=20,
                    max_size=None,
                ) as ws:
                    for i, w in enumerate(
                        sliced, 1
                    ):  # public chỉ nhận 1 address/mentions/sub ⇒ 1 sub mỗi ví
                        await ws.send(
                            json.dumps(
                                {
                                    "jsonrpc": "2.0",
                                    "id": i,
                                    "method": "logsSubscribe",
                                    "params": [{"mentions": [w]}],
                                }
                            )
                        )
                    print(
                        f"# feed=ws shard {sid + 1}/{nshard} key#{k % len(eps)}"
                        f" logsSubscribe {len(sliced)} ví (tổng {len(wallets)})",
                        flush=True,
                    )
                    _beat()
                    while True:
                        m = json.loads(await ws.recv())
                        _beat()
                        if m.get("id") is not None and "params" not in m:
                            if "error" in m:
                                raise RuntimeError(m["error"]["message"])
                            continue
                        p = m.get("params") or {}
                        if "error" in p:  # lỗi trên kênh subscribe ⇒ reconnect
                            raise RuntimeError(str(p["error"])[:60])
                        v = p.get("result", {}).get("value", {})
                        if v.get("signature"):
                            # ponytail: process_sig đồng bộ trong event loop (chặn
                            # recv ~0.1–1s/tx) — đủ vì lượng tx/ví thấp; nghẽn thì
                            # đẩy sang to_thread + lock quanh st.
                            process_sig(v["signature"], wallets, st, v.get("err"))
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                k += 1
                print(
                    f"  ! ws đứt shard {sid + 1} ({type(e).__name__}: {str(e)[:70]})"
                    " -> key kế, reconnect sau 2s",
                    file=sys.stderr,
                )
                await asyncio.sleep(2)

    async def _run():
        # chỉ shard trên endpoint CHÍNH: default (publicnode/mainnet-beta) không
        # nhận logsSubscribe ⇒ shard thừa chỉ reconnect-loop (log cũ "ws đứt shard 7").
        eps = [u for u in config.RPCS if u not in RPC_DEFAULTS] or list(config.RPCS)
        slices = _ws_shards(wallets, len(eps))
        tasks = [asyncio.create_task(_beat_loop())]
        for sid, sliced in enumerate(slices):
            tasks.append(asyncio.create_task(_shard(sid, sliced, eps, len(slices))))
        await asyncio.gather(*tasks)

    asyncio.run(_run())
