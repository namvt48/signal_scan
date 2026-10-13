"""Feed EVM: WS `eth_subscribe('logs')` where available, poll `eth_getLogs`
chunked for all supported chains; backfill from last processed block and emit
only after confirmations. IO side — logic pure in `watchers/evm/classify.py`.
All HTTP goes through `config.http_json` so tests can monkeypatch that seam.

State: `st["evm"][chain]["last_block"]` — lưu SAU mỗi chunk hoàn thành ⇒
reconnect/restart không mất khúc giữa (continuity, R1). Provider giới hạn
range getLogs ⇒ tự halve chunk rồi chia lại phần còn lại (R2).
"""

import asyncio
import json
import os
import sys
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime

from watchers.common import config, emit, price
from watchers.common import state as st_mod
from watchers.evm import classify as cl

DEFAULT_RPC = {
    "base": "https://mainnet.base.org",
    # Topic-only eth_getLogs works here; configure BSC_RPC_URL to use another provider.
    "bsc": "https://bsc-rpc.publicnode.com",
    # Robinhood official HTTP RPC; WS requires provider-specific configuration.
    "robinhood": "https://rpc.mainnet.chain.robinhood.com",
}
DEFAULT_CONFIRMATIONS = (
    8  # Base ~2s / BSC ~3s block ⇒ ~16-24s trễ, ngoài độ sâu reorg thường
)
DEFAULT_CHUNK = 500  # R2: bề rộng eth_getLogs; halve khi provider chê range
POLL_MAX_CHUNKS_PER_CHAIN = 16
_BSC_LOGS_POOL = ThreadPoolExecutor(max_workers=2)
_SEEN_MAX = 4096

_seen_tx: set[str] = (
    set()
)  # txhash đã xử lý trong run — 2 sub from/to đẩy cùng tx 2 lần
_decimals: dict[str, int] = {}  # "chain:ca" -> int (cache decimals())
_block_ts: dict[tuple[str, int], int] = {}  # (chain, block) -> unix ts
_tracked: set[tuple[str, str]] = set()  # (chain, ca) đã POST tracked-cas trong run


# ---------- transport ----------


def rpc_urls(chain):
    """Configured endpoints in order, followed by the public endpoint once."""
    env = {
        "base": "BASE_RPC_URL",
        "bsc": "BSC_RPC_URL",
        "robinhood": "ROBINHOOD_RPC_URL",
    }[chain]
    configured = [url.strip() for url in os.environ.get(env, "").split(",") if url.strip()]
    return list(dict.fromkeys((*configured, DEFAULT_RPC[chain])))


def rpc_url(chain):
    """First configured endpoint; used for websocket derivation and cursor scope."""
    return rpc_urls(chain)[0]


def wss_url(chain):
    env = {
        "base": "BASE_WSS_URL",
        "bsc": "BSC_WSS_URL",
        "robinhood": "ROBINHOOD_WSS_URL",
    }[chain]
    u = os.environ.get(env)
    if u:
        return u
    if chain == "robinhood":
        return None
    return rpc_url(chain).replace("https://", "wss://").replace("http://", "ws://")


def evm_rpc(chain, method, params, tries=3):
    """Call the configured primary, then public fallback after retriable errors."""
    last_category = "unknown error"
    for url in rpc_urls(chain):
        for i in range(tries):
            try:
                out = config.http_json(
                    url,
                    {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                    timeout=20,
                )
                if isinstance(out, dict) and "error" in out:
                    raise RuntimeError(str((out["error"] or {}).get("message"))[:120])
                return out.get("result") if isinstance(out, dict) else None
            except Exception as e:
                message = str(e).lower()
                if method == "eth_getLogs" and "specify an address" in message:
                    raise
                if any(word in message for word in ("exceed", "range")):
                    last_category = "provider range limit"
                elif any(word in message for word in ("limit", "too many", "results")):
                    last_category = "provider request limit"
                else:
                    last_category = type(e).__name__
                if i < tries - 1:
                    time.sleep(0.5 * (i + 1))
    raise RuntimeError(f"evm rpc {chain} {method} failed ({last_category})")




def block_number(chain):
    r = evm_rpc(chain, "eth_blockNumber", [])
    if not isinstance(r, str) or not r:
        raise RuntimeError(f"evm rpc {chain} eth_blockNumber: result dị dạng {r!r}")
    return int(r, 16)


def get_logs(chain, a, b, topics):
    r = evm_rpc(
        chain,
        "eth_getLogs",
        [{"fromBlock": hex(a), "toBlock": hex(b), "topics": topics}],
    )
    return r if isinstance(r, list) else []

def _range_logs(chain, start, end, wallets):
    """Fetch both transfer directions concurrently only on BSC's one-block RPC."""
    topics = cl.sub_topics(wallets)
    if chain != "bsc":
        return [
            log
            for topic in topics
            for log in get_logs(chain, start, end, topic)
        ]
    futures = [
        _BSC_LOGS_POOL.submit(get_logs, chain, start, end, topic) for topic in topics
    ]
    wait(futures)
    return [log for future in futures for log in future.result()]


def confirmed(block, latest, conf):
    """True khi block đã có ≥ conf confirmations (latest - block + 1 ≥ conf)."""
    return latest - block + 1 >= conf


def token_decimals(chain, ca):
    key = f"{chain}:{ca}"
    if key not in _decimals:
        d = 18  # mặc định ERC-20 khi eth_call fail — qty sai scale còn hơn mất event
        try:
            r = evm_rpc(
                chain, "eth_call", [{"to": ca, "data": cl.DECIMALS_SELECTOR}, "latest"]
            )
            if isinstance(r, str) and r:
                v = int(r, 16)
                if 0 <= v <= 36:
                    d = v
        except Exception:
            pass
        _decimals[key] = d
    return _decimals[key]


def block_ts(chain, block):
    key = (chain, block)
    if key not in _block_ts:
        ts = int(time.time())
        try:
            b = evm_rpc(chain, "eth_getBlockByNumber", [hex(block), False])
            if isinstance(b, dict) and b.get("timestamp"):
                ts = int(b["timestamp"], 16)
        except Exception:
            pass
        if len(_block_ts) > 1024:
            _block_ts.clear()  # ponytail: clear-all; LRU nếu phình
        _block_ts[key] = ts
    return _block_ts[key]


def _sort_logs(logs):
    """2 filter from/to trả log trùng nhau (self-transfer) + lẫn thứ tự —
    dedup theo (tx, logIndex) rồi sort (block, logIndex) để classify theo trình tự."""
    seen, out = set(), []
    for l in sorted(
        logs,
        key=lambda x: (
            int(x.get("blockNumber") or "0x0", 16),
            int(x.get("logIndex") or "0x0", 16),
        ),
    ):
        k = (l.get("transactionHash"), l.get("logIndex"))
        if k not in seen:
            seen.add(k)
            out.append(l)
    return out


# ---------- emit ----------


def _track_ca(ev, usd):
    """--track: POST CA vào /api/tracked-cas (chain-aware — emit.track_post_body
    hardcode 'sol' nên KHÔNG tái dùng). Fail-soft — duyệt TỪNG TX, chỉ cache
    (chain,ca) SAU khi server xác nhận (không raise / 409); KHÔNG cache TRƯỚC
    khi POST (lỗi mạng/400-500 trước đây vẫn cache ⇒ CA bị nuốt cả run — cùng
    lớp bug emit._posted_mints, 2026-09-30)."""
    if not config._track or ev["side"] != "BUY":
        return
    key = (ev["chain"], ev["ca"])
    if key in _tracked:
        return
    body = {
        "address": ev["ca"],
        "chain": ev["chain"],
        "note": f"auto:{ev['side']} by {ev['wallet']} {ev['tx']}",
    }
    if usd:
        body["usd"] = usd
    try:
        config.http_json(f"{config._api_url}/api/tracked-cas", body, timeout=5)
    except urllib.error.HTTPError as ex:
        if ex.code != 409:  # 409 = đã tracked = ok (như emit.track_event)
            print(f"  ! track {ev['ca'][:8]}…: HTTP {ex.code}", file=sys.stderr)
            return  # KHÔNG cache ⇒ TX sau thử lại
    except Exception as ex:
        print(
            f"  ! track {ev['ca'][:8]}…: {type(ex).__name__}: {str(ex)[:60]}",
            file=sys.stderr,
        )
        return  # KHÔNG cache
    _tracked.add(key)


def emit_swap(ev, ts_unix):
    """Giá (DexScreener chain-aware qua common.price) → gate min_usd → console +
    jsonl + POST trade (body có `chain` — server T4 tra wallet theo (address,chain)).
    Chưa định giá được (usd None) ⇒ VẪN emit với amountUsd 0 — fail-open như Sol."""
    px = price.get_price_usd(ev["ca"], ev["chain"])
    usd = ev["qty"] * px if px else None
    if usd is not None and usd < config.min_usd:
        return None
    ev["ts"] = datetime.fromtimestamp(ts_unix, config.ICT).strftime("%Y-%m-%d %H:%M:%S")
    ev["usd"] = usd or 0.0
    print(cl.fmt_event(ev), flush=True)
    emit.jl_write(ev)
    emit.post_trade(cl.trade_body(ev, usd, int(ts_unix * 1000)))
    _track_ca(ev, usd)
    return ev


# ---------- tx processing ----------


def process_tx(chain, t, wallets):
    """1 transfer đã decode của ví → receipt → gate router allowlist (D7) →
    classify ĐÚNG 1 event/wallet/tx → emit. Dedup txhash (2 sub from/to)."""
    txh = t["tx"]
    if txh in _seen_tx:
        return None
    if len(_seen_tx) > _SEEN_MAX:
        _seen_tx.clear()  # ponytail: clear-all; LRU nếu cần chặt
    _seen_tx.add(txh)
    rc = evm_rpc(chain, "eth_getTransactionReceipt", [txh])
    if not isinstance(rc, dict) or rc.get("status") != "0x1":
        return None  # revert / chưa có receipt ⇒ không swap
    to = rc.get("to")
    if cl.router_name(chain, to) is None:
        return None  # không phải router allowlist (transfer thường, dapp lạ…)
    transfers = [
        d for d in (cl.decode_transfer_log(x) for x in rc.get("logs") or []) if d
    ]
    transaction = evm_rpc(chain, "eth_getTransactionByHash", [txh])
    out = []
    for w in wallets:
        wallet_transfers = [x for x in transfers if x["from"] == w or x["to"] == w]
        if not wallet_transfers:
            continue
        enriched = list(transfers)
        # Native input counts only when wallet sent native value to this
        # allowlisted router tx and received an ERC-20 in its receipt.
        if (
            isinstance(transaction, dict)
            and str(transaction.get("from") or "").lower() == w
            and int(transaction.get("value") or "0x0", 16) > 0
            and any(x["to"] == w for x in wallet_transfers)
        ):
            enriched.append(
                {
                    "tx": txh,
                    "ca": cl.WRAPPED_NATIVE[chain],
                    "from": w,
                    "to": to.lower(),
                    "value": int(transaction["value"], 16),
                }
            )
        # Native output requires canonical wrapped-native Withdrawal indexed
        # to wallet plus an outgoing ERC-20 leg in this allowlisted router tx.
        if any(x["from"] == w for x in wallet_transfers):
            for log in rc.get("logs") or []:
                amount = cl.decode_withdrawal_log(log, chain, w)
                if amount:
                    enriched.append(
                        {
                            "tx": txh,
                            "ca": cl.WRAPPED_NATIVE[chain],
                            "from": to.lower(),
                            "to": w,
                            "value": amount,
                        }
                    )
        ev = cl.classify_swap(
            chain,
            w,
            {
                "to": to,
                "transfers": enriched,
                "decimals_of": lambda ca: token_decimals(chain, ca),
            },
        )
        if ev:
            ev["block"] = t["block"]
            r = emit_swap(ev, block_ts(chain, t["block"]))
            if r:
                out.append(r)
    return out or None


def process_log(chain, log, wallets):
    t = cl.decode_transfer_log(log)
    if t is None or (t["from"] not in wallets and t["to"] not in wallets):
        return None
    return process_tx(chain, t, wallets)


# ---------- backfill ----------


def backfill(chain, wallets, st, opts):
    """Fetch a bounded block slice; persist cursor and provider range size."""
    latest = block_number(chain)
    end = latest - opts["conf"] + 1
    if end < 0:
        return True
    cs = st.setdefault("evm", {}).setdefault(chain, {})
    start = int(cs.get("last_block") or 0) + 1
    if not cs.get("last_block"):
        start = end  # cold start = bắt đầu từ tip, không bò lại lịch sử
    if start > end:
        return True
    wl = set(wallets)
    endpoint = rpc_url(chain)
    cached_span = cs.get("chunk_span") if cs.get("chunk_rpc") == endpoint else None
    span = max(1, int(cached_span or opts["span"]))
    print(
        f"# backfill {chain}: block {start}..{end} (latest {latest}, conf {opts['conf']}, chunk {span})",
        flush=True,
    )
    todo, i = cl.chunk_ranges(start, end, span), 0
    max_chunks = opts.get("max_chunks")
    while i < len(todo):
        a, b = todo[i]
        try:
            logs = _range_logs(chain, a, b, wl)
        except RuntimeError as e:
            msg = str(e).lower()
            if b > a and any(
                k in msg
                for k in ("exceed", "range", "limit", "too many", "results", "specify an address")
            ):
                span = max(1, (b - a + 1) // 2)
                cs["chunk_rpc"] = endpoint
                cs["chunk_span"] = span
                st_mod.save_state(st)
                todo, i = cl.chunk_ranges(a, end, span), 0  # chia lại phần còn lại
                print(
                    f"# getLogs {chain} chê range → halve chunk còn {span}: {str(e)[:80]}",
                    flush=True,
                )
                continue
            raise
        for log in _sort_logs(logs):
            try:
                process_log(chain, log, wl)
            except (
                Exception
            ) as e:  # log dị dạng không giết backfill (fail-soft như sol)
                print(
                    f"  ! backfill log {chain}: {type(e).__name__}: {str(e)[:80]}",
                    file=sys.stderr,
                )
        cs["last_block"] = b
        st_mod.save_state(st)
        st_mod._beat()
        i += 1
        if max_chunks and i >= max_chunks and b < end:
            return False
    return True


# ---------- feeds ----------


def run_poll_feed(per, st, opts):
    """Poll each chain in bounded chunks; don't let a lagging chain starve others."""
    poll_opts = {
        **opts,
        "max_chunks": opts.get("max_chunks", POLL_MAX_CHUNKS_PER_CHAIN),
    }
    while True:
        r = opts.get("refresh")
        if r:
            r(per)
        backlog = False
        for chain, wallets in per.items():
            if wallets and not backfill(chain, wallets, st, poll_opts):
                backlog = True
        st_mod.save_state(st)
        if opts.get("once"):
            return
        if not backlog:
            time.sleep(opts["sleep"])
        st_mod._beat()


def run_ws_feed(per, st, opts):
    for chain, wallets in per.items():
        if wallets and not wss_url(chain):
            raise RuntimeError(
                f"feed=ws requires {chain.upper()}_WSS_URL; use --feed poll otherwise"
            )
    try:
        import websockets
    except ImportError:
        sys.exit("feed=ws cần:  pip install websockets   (hoặc chạy --feed poll)")

    async def _chain_loop(chain, wallets):
        backoff = 2
        while True:
            try:
                r = opts.get("refresh")
                if r:
                    r(per)  # wallets/min_usd mới từ API; sub cũ giữ tới reconnect kế
                wl = set(wallets)
                async with websockets.connect(
                    wss_url(chain), open_timeout=10, ping_interval=20, max_size=None
                ) as ws:
                    backoff = 2
                    nsub = 0
                    for i, topics in enumerate(cl.sub_topics(wl), 1):
                        await ws.send(
                            json.dumps(
                                {
                                    "jsonrpc": "2.0",
                                    "id": i,
                                    "method": "eth_subscribe",
                                    "params": ["logs", {"topics": topics}],
                                }
                            )
                        )
                        nsub = i
                    for _ in range(
                        nsub
                    ):  # chờ đủ kết quả sub, error ⇒ raise ⇒ reconnect
                        m = json.loads(await ws.recv())
                        if isinstance(m, dict) and "error" in m:
                            raise RuntimeError(str(m["error"])[:120])
                    print(
                        f"# feed=ws {chain}: eth_subscribe logs {len(wl)} ví, {nsub} sub (from/to) — {config._mask(wss_url(chain))}",
                        flush=True,
                    )
                    # (re)connect ⇒ backfill khúc hở từ last_block trước đã (R1)
                    await asyncio.to_thread(backfill, chain, wallets, st, opts)
                    pend = []
                    while True:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
                        except asyncio.TimeoutError:
                            raw = None
                        if raw is not None:
                            m = json.loads(raw)
                            res = (m.get("params") or {}).get("result") or {}
                            if isinstance(res, dict) and res.get("topics"):
                                pend.append(res)
                            if len(pend) > _SEEN_MAX:
                                del pend[: len(pend) - _SEEN_MAX]
                        st_mod._beat()
                        if not pend:
                            continue
                        latest = await asyncio.to_thread(block_number, chain)
                        keep = []
                        for log in pend:
                            b = int(log.get("blockNumber") or "0x0", 16)
                            if not confirmed(b, latest, opts["conf"]):
                                keep.append(log)  # chờ đủ confirmations mới emit
                                continue
                            try:
                                await asyncio.to_thread(process_log, chain, log, wl)
                            except Exception as e:
                                print(
                                    f"  ! ws log {chain}: {type(e).__name__}: {str(e)[:80]}",
                                    file=sys.stderr,
                                )
                        pend = keep
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                print(
                    f"  ! ws {chain} đứt ({type(e).__name__}: {str(e)[:70]}) → reconnect {backoff}s",
                    file=sys.stderr,
                )
                await asyncio.sleep(backoff)
                backoff = min(60, backoff * 2)

    async def _run():
        await asyncio.gather(*[_chain_loop(c, per[c]) for c in per if per[c]])

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
