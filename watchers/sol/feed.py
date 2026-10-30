"""Feed Solana: `run_ws_feed` (logsSubscribe{mentions}, 1 connection/key, shard
theo ví) và `run_block_feed` (getBlock tuần tự, forward-only) → `_handle_tx`
là emit path duy nhất.

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import json
import random
import sys
import threading
import time
import math
from typing import Any, Iterator

from watchers.common import config
from watchers.common.config import RPC_DEFAULTS, load_config_from_api
from watchers.common.emit import fmt, jl_write, watch_trade_event
from watchers.common.price import _warm_prices
from watchers.common.state import _beat, save_state
from watchers.sol.classify import TIER_A, TIER_B, _keys, _target_event, detect_events
from watchers.sol.recovery import initialize_tracking_window, reconcile_cycle
_PROCESS_LOCK = threading.RLock()



_MAJOR_MINTS = TIER_A | TIER_B

# (sig, wallet, mint, side, step) đã emit — cùng tx có thể tới 2 lần (ws + poll,
# hoặc 2 run khi watermark lùi); ponytail: set không cap trong 1 run, LRU nếu chật.
_emitted: set[tuple[str, str, str | None, str | None, int | None]] = set()


def _handle_tx(tx, sig, wallets, st, provenance="live") -> bool:
    """Classify and deliver one transaction; False keeps its source cursor open."""
    if config._cfg_next and time.time() >= config._cfg_next:
        load_config_from_api(wallets)
    cutoff = config._tracking_since_ms
    block_time = tx.get("blockTime")
    if not isinstance(cutoff, int) or isinstance(cutoff, bool) or cutoff <= 0:
        return False
    if (
        not isinstance(block_time, (int, float))
        or isinstance(block_time, bool)
        or not math.isfinite(block_time)
        or block_time <= 0
    ):
        return False
    event_ts_ms = int(block_time * 1000)
    if event_ts_ms < cutoff:
        return True
    meta = tx.get("meta") or {}
    keys = set(_keys(tx["transaction"]["message"], meta))
    keys |= {
        balance["owner"]
        for balance in (meta.get("preTokenBalances") or [])
        + (meta.get("postTokenBalances") or [])
        if balance.get("owner")
    }
    hits = [wallet for wallet in wallets if wallet in keys]
    if not hits:
        return True
    _warm_prices(tx)
    complete = True
    for wallet in hits:
        observation_start = st.get("sol_recovery", {}).get(wallet, {}).get("observation_start_ms")
        event_provenance = provenance
        if isinstance(observation_start, int) and event_ts_ms < observation_start:
            event_provenance = "historical"
        events = detect_events(tx, wallet)
        fresh = []
        for event in events:
            event["ts_epoch_ms"] = event_ts_ms
            event["provenance"] = event_provenance
            key = (sig, wallet, event.get("mint"), event.get("side"), event.get("step"))
            if key not in _emitted:
                fresh.append(event)
        route_events = [event for event in fresh if event.get("type") == "SWAP"]
        hops = [
            event
            for event in route_events
            if event.get("side") == "SELL"
            or (event.get("side") == "BUY" and (event.get("qty_net") or 0) > 0)
        ]
        delivered = True
        for event in _aggregate_watch_hops(route_events):
            if watch_trade_event(event, tx.get("blockTime")) is False:
                delivered = False
        if fresh and not hops:
            event = _target_event(tx, wallet, events)
            if event is not None:
                event["provenance"] = event_provenance
                event["ts_epoch_ms"] = event_ts_ms
                if watch_trade_event(event, tx.get("blockTime")) is False:
                    delivered = False
        if not delivered:
            complete = False
            continue
        st["wallets"].setdefault(wallet, {})["head"] = sig
        for event in fresh:
            key = (sig, wallet, event.get("mint"), event.get("side"), event.get("step"))
            _emitted.add(key)
            print(fmt(event), flush=True)
            jl_write(event)
    return complete

def _aggregate_watch_hops(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per (wallet, tx, CA, side), carrying closed-route buy cost."""
    route_costs = _route_costs(events)
    base_deltas: dict[tuple[str, str, str], float] = {}
    base_seen: set[tuple[str, str, str]] = set()
    base_unknown: set[tuple[str, str, str]] = set()
    quote_seen: set[tuple[str, str, str]] = set()
    quote_nonzero: set[tuple[str, str, str]] = set()
    quote_unknown: set[tuple[str, str, str]] = set()
    for event in events:
        if event.get("type") != "SWAP":
            continue
        base_key = (event["wallet"], event["sig"], event.get("mint"))
        if base_key[2] and "qty_net" in event:
            delta = event["qty_net"]
            if delta is None:
                base_seen.add(base_key)
            elif isinstance(delta, (int, float)) and not isinstance(delta, bool):
                base_seen.add(base_key)
                base_deltas[base_key] = base_deltas.get(base_key, 0.0) + delta
            else:
                base_unknown.add(base_key)
        quote_key = (event["wallet"], event["sig"], event.get("quote_mint"))
        if quote_key[2] and "quote_qty_net" in event:
            delta = event["quote_qty_net"]
            if isinstance(delta, (int, float)) and not isinstance(delta, bool):
                quote_seen.add(quote_key)
                if abs(delta) > 1e-9:
                    quote_nonzero.add(quote_key)
            else:
                quote_unknown.add(quote_key)
    zero_net_sells: set[tuple[str, str, str]] = set()
    for hop in events:
        if hop.get("side") != "SELL":
            continue
        delta_key = (hop["wallet"], hop["sig"], hop["mint"])
        base_zero = (
            delta_key in base_seen
            and delta_key not in base_unknown
            and abs(base_deltas.get(delta_key, 0.0)) <= 1e-9
        )
        quote_zero = (
            delta_key in quote_seen
            and delta_key not in quote_unknown
            and delta_key not in quote_nonzero
        )
        base_nonzero = abs(base_deltas.get(delta_key, 0.0)) > 1e-9
        if (base_zero or quote_zero) and not base_nonzero and delta_key not in quote_nonzero:
            zero_net_sells.add(delta_key)
    grouped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for hop in events:
        side = hop.get("side")
        if side == "SELL" and (hop["wallet"], hop["sig"], hop["mint"]) in zero_net_sells:
            continue
        if hop.get("type") != "SWAP" or not (
            side == "SELL" or (side == "BUY" and (hop.get("qty_net") or 0) > 0)
        ):
            continue
        key = (hop["wallet"], hop["sig"], hop["mint"], side)
        trade = grouped.get(key)
        if trade is None:
            trade = {**hop, "qty": 0.0, "quote_usd": 0.0, "_net_qty": 0.0}
            trade.pop("quote_qty", None)
            trade.pop("unit_price", None)
            grouped[key] = trade
        if side == "BUY":
            trade["_net_qty"] += hop.get("qty_net") or 0.0
        trade["qty"] += hop.get("qty") or 0.0
        trade["quote_usd"] += hop.get("quote_usd") or 0.0
    # A final token can arrive as the quote side of a SELL without any base-side
    # BUY event. Its owner net delta is the exact token quantity for that row.
    for hop in events:
        if hop.get("type") != "SWAP" or hop.get("side") != "SELL":
            continue
        mint = hop.get("quote_mint")
        qty_net = hop.get("quote_qty_net")
        if (
            not mint
            or mint in _MAJOR_MINTS
            or not isinstance(qty_net, (int, float))
            or qty_net <= 0
        ):
            continue
        key = (hop["wallet"], hop["sig"], mint, "BUY")
        if key in grouped:
            continue
        grouped[key] = {
            **hop,
            "mint": mint,
            "sym": hop.get("quote_sym"),
            "side": "BUY",
            "qty": qty_net,
            "qty_net": qty_net,
            "quote_mint": hop.get("mint"),
            "quote_sym": hop.get("sym"),
            "quote_qty": hop.get("qty"),
            "quote_usd": route_costs.get(mint, hop.get("quote_usd") or 0.0),
            "amount_basis": "route_cost",
            "_net_qty": qty_net,
        }
    for trade in grouped.values():
        if trade["side"] == "BUY":
            if trade["_net_qty"] > 0:
                trade["qty"] = trade["_net_qty"]
            if trade["mint"] in route_costs:
                trade["quote_usd"] = route_costs[trade["mint"]]
        trade.pop("_net_qty", None)
    return list(grouped.values())


def _route_add(
    inventory: dict[str, tuple[float, float | None]],
    mint: str,
    qty: float,
    cost_usd: float | None,
) -> None:
    if qty <= 0:
        return
    old_qty, old_cost = inventory.get(mint, (0.0, 0.0))
    cost = None if old_cost is None or cost_usd is None else old_cost + cost_usd
    inventory[mint] = (old_qty + qty, cost)


def _route_take(
    inventory: dict[str, tuple[float, float | None]], mint: str, qty: float
) -> tuple[float, float | None]:
    held, cost = inventory.get(mint, (0.0, None))
    taken = min(max(qty, 0.0), held)
    if taken <= 0:
        return 0.0, 0.0
    used_cost = cost * taken / held if cost is not None else None
    remaining = held - taken
    if remaining <= 1e-9:
        inventory.pop(mint, None)
    else:
        inventory[mint] = (
            remaining,
            cost - used_cost if cost is not None and used_cost is not None else None,
        )
    return taken, used_cost


def _route_costs(events: list[dict[str, Any]]) -> dict[str, float]:
    """Return the gross acquisition cost carried into each mint."""
    inventory: dict[str, tuple[float, float | None]] = {}
    buy_costs: dict[str, float] = {}
    ordered = sorted(events, key=lambda e: e.get("step") or 0)
    for event in ordered:
        if event.get("type") != "SWAP":
            continue
        mint = event.get("mint")
        quote_mint = event.get("quote_mint")
        qty = float(event.get("qty") or 0.0)
        quote_qty = float(event.get("quote_qty") or 0.0)
        usd = event.get("quote_usd")
        usd = float(usd) if isinstance(usd, (int, float)) else None
        if not mint or not quote_mint or qty <= 0:
            continue
        if event.get("side") == "BUY":
            used, used_cost = _route_take(inventory, quote_mint, quote_qty)
            unpriced_qty = max(0.0, quote_qty - used)
            if used_cost is not None and unpriced_qty <= 1e-9:
                cost = used_cost
            elif used_cost is not None and usd is not None and quote_qty > 0:
                cost = used_cost + usd * unpriced_qty / quote_qty
            elif used_cost is not None:
                cost = None
            else:
                cost = usd
            if cost is not None:
                buy_costs[mint] = buy_costs.get(mint, 0.0) + cost
            _route_add(inventory, mint, qty, cost)
        elif event.get("side") == "SELL":
            sold, sold_cost = _route_take(inventory, mint, qty)
            if sold_cost is not None and sold >= qty - 1e-9:
                cost = sold_cost
            elif sold_cost is not None and usd is not None:
                cost = sold_cost + usd * max(0.0, qty - sold) / qty
            elif sold_cost is not None:
                cost = None
            else:
                cost = usd
            if cost is not None:
                buy_costs[quote_mint] = buy_costs.get(quote_mint, 0.0) + cost
            _route_add(inventory, quote_mint, quote_qty, cost)
    return buy_costs


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
            else:
                kind = "retry"  # null/malformed result is not evidence a slot was skipped
        if isinstance(blk, dict):
            block_complete = True
            for tx in _block_txs(blk, slot):
                try:
                    handled = _handle_tx(tx, tx["transaction"]["signatures"][0], wallets, st, "cursor")
                except Exception as err:
                    print(f"  ! process slot {slot}: {type(err).__name__}: {str(err)[:80]}", file=sys.stderr)
                    handled = False
                if handled is False:
                    block_complete = False
                    break
            if not block_complete:
                blk = None
                kind = "retry"
                print(f"# retry slot {slot}: transaction delivery incomplete", flush=True)
        if isinstance(blk, dict):
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
        if kind == "skip":  # only explicit ledger-skip RPC errors are safe to advance
            st["block_slot"] = slot
            slot += 1
            attempts = 0
            unused += 1
        else:
            attempts += 1
            if opts["once"] and attempts >= _BLOCK_RETRY_MAX:
                raise RuntimeError(f"getBlock slot {slot} failed after {attempts} retries; cursor unchanged")
            delay = min(_RETRY_CAP_S, _RETRY_BASE_S * 2 ** min(attempts - 1, 10))
            time.sleep(delay)
            _beat()
            continue
        if opts["once"] and unused >= _ONCE_MAX_SLOTS:
            save_state(st)
            return


def _wss(url: str) -> str:
    """Endpoint websocket suy từ endpoint HTTP tương ứng."""
    return url.replace("https://", "wss://").replace("http://", "ws://")


_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _valid_pubkey(addr) -> bool:
    """base58 (bảng chữ Bitcoin) giải mã đúng 32 byte. Không checksum (sol key
    không có) — chỉ để loại rác non-base58: Helius `mentions` từ chối CẢ shard
    khi có 1 địa chỉ sai ⇒ 1 ví rác giết 33 ví (đo 2026-10-02: shard 5 chết vì
    'Kaduna'/'SerBeetle')."""
    if not 32 <= len(addr) <= 44:
        return False
    n = 0
    for c in addr:
        i = _B58.find(c)
        if i < 0:
            return False
        n = n * 58 + i
    lead = len(addr) - len(addr.lstrip("1"))
    return lead + (n.bit_length() + 7) // 8 == 32


# Helius free cap số subscription MỖI KEY: dồn 198 sub (1 logsSubscribe/ví) vào 1
# connection/1 key ⇒ `1013 Rate limit reached: Too many subscriptions`, mỗi
# reconnect lại đẩy đủ 198 sub ⇒ hố không nhận event (đo 09-24: mất 3 tx). Chia
# mỗi key 1 connection ⇒ ~33 sub/key, dưới cap.
def _ws_shards(items, n):
    """Chia vòng tròn `items` ra n shard rời nhau, phủ hết, lệch ≤1 phần tử."""
    n = max(1, min(n, len(items) or 1))
    return [items[i::n] for i in range(n)]


def process_sig(sig, wallets, st, err=None, provenance="live") -> bool:
    """Fetch and deliver one transaction; False leaves the recovery cursor unchanged."""
    if err is not None:
        return True
    try:
        tx = config.rpc(
            "getTransaction",
            [
                sig,
                {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": 1,
                    "commitment": "confirmed",
                },
            ],
        )
    except Exception as exc:
        print(f"  ! {sig[:12]}… getTransaction: {exc}", file=sys.stderr)
        return False
    if not tx:
        return False
    try:
        with _PROCESS_LOCK:
            handled = _handle_tx(tx, sig, list(wallets), st, provenance)
            if handled is False:
                return False
            save_state(st)
    except Exception as exc:
        print(f"  ! {sig[:12]}… process: {type(exc).__name__}: {str(exc)[:80]}", file=sys.stderr)
        return False
async def _reconcile_loop(wallets, st, interval=30.0):
    """Run bounded history reconciliation without blocking the websocket loop."""
    import asyncio

    interval = max(1.0, float(interval))
    while True:
        try:
            cutoff = config._tracking_since_ms
            if isinstance(cutoff, int) and not isinstance(cutoff, bool) and cutoff > 0:
                initialize_tracking_window(st, tuple(wallets), cutoff, _PROCESS_LOCK)
                await asyncio.to_thread(
                    reconcile_cycle, tuple(wallets), st, process_sig, _PROCESS_LOCK
                )
        except Exception as exc:
            print(
                f"  ! SOL recovery: {type(exc).__name__}: {str(exc)[:100]}",
                file=sys.stderr,
            )
        await asyncio.sleep(interval)


def run_ws_feed(wallets, st) -> None:
    """Maintain subscriptions for the latest authoritative SOL wallet list."""
    import asyncio

    try:
        import websockets
    except ImportError:
        sys.exit("feed=ws cần:  pip install websockets   (hoặc --feed block)")

    wallets[:] = [w for w in wallets if _valid_pubkey(w)]

    interval = max(1.0, float(getattr(config, "_SOL_RECONCILE_INTERVAL_S", 30.0)))

    async def _beat_loop():
        while True:
            _beat()
            await asyncio.sleep(30)

    async def _worker(q):
        while True:
            sig, err = await q.get()
            try:
                await asyncio.to_thread(process_sig, sig, wallets, st, err)
            except Exception as e:
                print(f"  ! worker process_sig {sig[:12]}…: {type(e).__name__}: {str(e)[:80]}", file=sys.stderr)
            finally:
                q.task_done()

    async def _shard(sid, sliced, eps, nshard, q):
        k = sid
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(
                    _wss(eps[k % len(eps)]), open_timeout=10,
                    ping_interval=20, ping_timeout=60, max_size=None,
                ) as ws:
                    for i, w in enumerate(sliced, 1):
                        await ws.send(json.dumps({
                            "jsonrpc": "2.0", "id": i, "method": "logsSubscribe",
                            "params": [{"mentions": [w]}],
                        }))
                        await asyncio.sleep(0.05)
                    print(f"# feed=ws shard {sid + 1}/{nshard} key#{k % len(eps)} logsSubscribe {len(sliced)} ví", flush=True)
                    _beat()
                    backoff = 1.0
                    while True:
                        m = json.loads(await ws.recv())
                        _beat()
                        if m.get("id") is not None and "params" not in m:
                            if "error" in m:
                                raise RuntimeError(m["error"]["message"])
                            continue
                        p = m.get("params") or {}
                        if "error" in p:
                            raise RuntimeError(str(p["error"])[:60])
                        v = p.get("result", {}).get("value", {})
                        if v.get("signature"):
                            await q.put((v["signature"], v.get("err")))
            except asyncio.CancelledError:
                raise
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                k += 1
                delay = backoff + random.random()
                print(f"  ! ws đứt shard {sid + 1} ({type(e).__name__}: {str(e)[:70]}) -> key kế, reconnect sau {delay:.1f}s", file=sys.stderr)
                await asyncio.sleep(delay)
                backoff = min(60.0, backoff * 2)

    async def _run():
        eps = [u for u in config.RPCS if u not in RPC_DEFAULTS] or list(config.RPCS)
        q: asyncio.Queue[tuple[str, Any]] = asyncio.Queue(maxsize=2000)
        shards: list[asyncio.Task] = []
        worker = asyncio.create_task(_worker(q))
        recovery = asyncio.create_task(_reconcile_loop(wallets, st, interval))
        beat = asyncio.create_task(_beat_loop())
        subscribed = None
        try:
            while True:
                if config._cfg_next == 0 or time.time() >= config._cfg_next:
                    load_config_from_api(wallets)
                latest = tuple(dict.fromkeys(w for w in wallets if _valid_pubkey(w)))
                if latest != subscribed:
                    old = shards
                    for task in old:
                        task.cancel()
                    if old:
                        await asyncio.gather(*old, return_exceptions=True)
                    subscribed = latest
                    slices = _ws_shards(list(latest), len(eps)) if latest else []
                    shards = [
                        asyncio.create_task(_shard(sid, part, eps, len(slices), q))
                        for sid, part in enumerate(slices)
                    ]
                await asyncio.sleep(min(30.0, config._CFG_REFRESH_S))
        finally:
            for task in shards:
                task.cancel()
            worker.cancel()
            recovery.cancel()
            beat.cancel()
            await asyncio.gather(*shards, worker, recovery, beat, return_exceptions=True)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
