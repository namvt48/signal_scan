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
import re
import sys
import threading
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime

from watchers.common import config, emit, price
from watchers.common import state as st_mod
from watchers.evm import classify as cl
from watchers.evm import delivery, journal as journal_mod, rpc

DEFAULT_RPC = {
    "base": "https://mainnet.base.org",
    # Topic-only eth_getLogs works here; configure BSC_RPC_URL to use another provider.
    "bsc": "https://bsc-rpc.publicnode.com",
    # Robinhood official HTTP RPC; WS requires provider-specific configuration.
    "robinhood": "https://rpc.mainnet.chain.robinhood.com",
    # Publicnode is fast for head blocks/logs; flashbots handles archive ranges.
    "eth": "https://ethereum-rpc.publicnode.com",
}
DEFAULT_CONFIRMATIONS = (
    8  # Base ~2s / BSC ~3s block ⇒ ~16-24s trễ, ngoài độ sâu reorg thường
)
DEFAULT_CHUNK = 500  # R2: bề rộng eth_getLogs; halve khi provider chê range
POLL_MAX_CHUNKS_PER_CHAIN = 16
CHUNK_RECOVER_AFTER = 16  # successful chunks before probing a wider getLogs range
_BSC_LOGS_POOL = ThreadPoolExecutor(max_workers=2)
_SEEN_MAX = 4096

_journal = None
_seen_tx: set[tuple[str, str]] = set()  # transaction dedupe remains process-local without journal
_startup_checked: set[str] = set()  # chains that already applied the startup backlog policy
_decimals: dict[str, int] = {}  # "chain:ca" -> int (cache decimals())
_block_ts: dict[tuple[str, int], int] = {}  # (chain, block) -> unix ts
_tracked: set[tuple[str, str]] = set()
_candidate_errors: dict[tuple[str, str], float] = {}
_trace_defer_logged: set[str] = set()

_chain_locks: dict[str, threading.RLock] = {}
_chain_locks_guard = threading.Lock()


def _chain_lock(chain):
    with _chain_locks_guard:
        return _chain_locks.setdefault(chain, threading.RLock())


def configure_journal(store):
    """Enable durable EVM cursor, candidate, and trade delivery storage."""
    global _journal
    _journal = store
    delivery.configure(store)


def save_state(state):
    """Persist EVM state through WAL in production, JSON for legacy callers."""
    if _journal is None:
        st_mod.save_state(state)
    else:
        _journal.save_state(state)

def _save_state(state):
    save_state(state)


def rpc_health_reset():
    """Reset provider cooldowns for isolated test processes."""
    rpc.reset()


# ---------- transport ----------


def rpc_urls(chain):
    """Configured endpoints in order, followed by the public endpoint once."""
    env = {
        "base": "BASE_RPC_URL",
        "bsc": "BSC_RPC_URL",
        "robinhood": "ROBINHOOD_RPC_URL",
        "eth": "ETH_RPC_URL",
    }[chain]
    configured = [url.strip() for url in os.environ.get(env, "").split(",") if url.strip()]
    return list(dict.fromkeys((*configured, DEFAULT_RPC[chain])))


def rpc_url(chain):
    """First configured endpoint; used for websocket derivation and cursor scope."""
    return rpc_urls(chain)[0]


def wss_urls(chain):
    """Ordered WSS pool: explicit overrides first, derived HTTP endpoints second."""
    if chain in _env_chains("EVM_WSS_DISABLED_CHAINS"):
        return []
    env = {
        "base": "BASE_WSS_URL",
        "bsc": "BSC_WSS_URL",
        "robinhood": "ROBINHOOD_WSS_URL",
        "eth": "ETH_WSS_URL",
    }[chain]
    configured = [url.strip() for url in os.environ.get(env, "").split(",") if url.strip()]
    if configured:
        return list(dict.fromkeys(configured))
    if chain == "robinhood":
        return []
    return [
        url.replace("https://", "wss://").replace("http://", "ws://")
        for url in rpc_urls(chain)
        if url.startswith(("https://", "http://"))
    ]


def wss_url(chain):
    urls = wss_urls(chain)
    return urls[0] if urls else None


def _trace_disabled(chain):
    return chain in _env_chains("EVM_TRACE_DISABLED_CHAINS")


def _trace_urls(chain, endpoint=None):
    if _trace_disabled(chain):
        return []
    if endpoint:
        return [url.strip() for url in endpoint.split(",") if url.strip()]
    env = {
        "base": "BASE_TRACE_RPC_URL",
        "bsc": "BSC_TRACE_RPC_URL",
        "robinhood": "ROBINHOOD_TRACE_RPC_URL",
        "eth": "ETH_TRACE_RPC_URL",
    }[chain]
    configured = [url.strip() for url in os.environ.get(env, "").split(",") if url.strip()]
    return configured or rpc_urls(chain)


class RpcFeedError(RuntimeError):
    def __init__(self, message, category, retry_after):
        super().__init__(message)
        self.category = category
        self.retry_after = retry_after


def evm_rpc(chain, method, params, tries=3):
    """Call eligible providers once each; cool down quota or network failures."""
    try:
        return rpc.call(chain, method, params, rpc_urls(chain), tries=tries, timeout=20)
    except rpc.MethodUnavailable as exc:
        raise RuntimeError(f"evm rpc {chain} {method} method unavailable") from exc
    except rpc.RpcUnavailable as exc:
        category = {
            "quota": "provider capacity/rate limit",
            "permission": "provider authorization/permission",
            "range": "provider range limit",
            "transport": "provider transport error",
            "cooldown": "provider cooldown",
        }.get(exc.category, "provider error")
        raise RpcFeedError(
            f"evm rpc {chain} {method} failed ({category})",
            exc.category,
            exc.retry_after,
        ) from exc


class TraceMethodUnavailable(RuntimeError):
    pass


def trace_rpc(chain, method, params, endpoint=None):
    """Use trace-capable endpoints with the shared cooldown and capability cache."""
    if _trace_disabled(chain):
        raise TraceMethodUnavailable(f"trace disabled for {chain}")
    endpoints = _trace_urls(chain, endpoint)
    try:
        return rpc.call(chain, method, params, endpoints, tries=len(endpoints), timeout=30)
    except rpc.MethodUnavailable as exc:
        raise TraceMethodUnavailable(str(exc)) from exc
    except rpc.RpcUnavailable as exc:
        raise RpcFeedError(
            f"trace RPC {chain} {method} unavailable ({exc.category})",
            exc.category,
            exc.retry_after,
        ) from exc




def trace_filter_candidates(chain, start, end, wallets):
    """Find transactions with a tracked address as a nested CALL from/to."""
    if _trace_disabled(chain):
        return {}
    env = {
        "base": "BASE_TRACE_INDEX_RPC_URL",
        "bsc": "BSC_TRACE_INDEX_RPC_URL",
        "robinhood": "ROBINHOOD_TRACE_INDEX_RPC_URL",
        "eth": "ETH_TRACE_INDEX_RPC_URL",
    }[chain]
    endpoint = os.environ.get(env, "").strip()
    if not endpoint:
        return {}
    tracked = sorted({str(wallet).lower() for wallet in wallets})
    tracked_set = set(tracked)
    candidates = {}
    for field in ("fromAddress", "toAddress"):
        rows = trace_rpc(
            chain,
            "trace_filter",
            [{"fromBlock": hex(start), "toBlock": hex(end), field: tracked}],
            endpoint=endpoint,
        )
        if not isinstance(rows, list):
            raise RuntimeError(f"trace_filter returned invalid result for {chain}:{field}")
        for row in rows:
            txh = str(row.get("transactionHash") or "").lower()
            action = row.get("action") or {}
            matched = {
                str(action.get(key) or "").lower()
                for key in ("from", "to")
            } & tracked_set
            if not txh or not matched:
                raise RuntimeError(f"trace_filter returned invalid row for {chain}:{field}")
            candidates.setdefault(txh, set()).update(matched)
    return candidates
def _parity_trace_tree(traces):
    """Convert Parity trace_transaction rows into callTracer's nested call shape."""
    if not isinstance(traces, list):
        return None
    nodes, root = {}, None
    for item in sorted(
        (item for item in traces if isinstance(item, dict)),
        key=lambda row: tuple(row.get("traceAddress") or []),
    ):
        action = item.get("action") or {}
        path = tuple(item.get("traceAddress") or [])
        kind = str(item.get("type") or "").upper()
        if kind == "CALL":
            kind = str(action.get("callType") or "call").upper()
        elif kind == "SUICIDE":
            kind = "SELFDESTRUCT"
        result = item.get("result") or {}
        frame = {
            "type": kind,
            "from": action.get("from") or action.get("address"),
            "to": action.get("to") or action.get("refundAddress"),
            "value": action.get("value") or "0x0",
            "input": action.get("input") or "0x",
            "output": result.get("output") or "0x",
            "error": item.get("error"),
            "calls": [],
        }
        nodes[path] = frame
        if not path:
            root = frame
        elif path[:-1] in nodes:
            nodes[path[:-1]]["calls"].append(frame)
    return root


def trace_transaction(chain, txh):
    """Fetch one call tree with no retry/fan-out; fail closed if tracing is absent."""
    config_trace = {"tracer": "callTracer", "tracerConfig": {"onlyTopCall": False}}
    try:
        trace = trace_rpc(chain, "debug_traceTransaction", [txh, config_trace])
    except TraceMethodUnavailable:
        try:
            trace = _parity_trace_tree(trace_rpc(chain, "trace_transaction", [txh]))
        except Exception as exc:
            raise RpcFeedError(
                f"trace unavailable for {chain}:{txh}: {exc}",
                getattr(exc, "category", "trace"),
                getattr(exc, "retry_after", 0.0),
            ) from exc
    except Exception as exc:
        raise RpcFeedError(
            f"trace unavailable for {chain}:{txh}: {exc}",
            getattr(exc, "category", "trace"),
            getattr(exc, "retry_after", 0.0),
        ) from exc
    if not isinstance(trace, dict):
        raise RuntimeError(f"trace unavailable for {chain}:{txh}: empty call tree")
    return trace




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
    key = f"{chain}:{ca.lower()}"
    if key not in _decimals and _journal is not None:
        cached = _journal.get_cache(chain, ca.lower(), "decimals")
        if isinstance(cached, int) and not isinstance(cached, bool) and 0 <= cached <= 36:
            _decimals[key] = cached
    if key not in _decimals:
        result = evm_rpc(
            chain, "eth_call", [{"to": ca, "data": cl.DECIMALS_SELECTOR}, "latest"]
        )
        if not isinstance(result, str) or not result.startswith("0x"):
            raise RuntimeError(f"missing decimals() result for {chain}:{ca}")
        try:
            decimals = int(result, 16)
        except ValueError as exc:
            raise RuntimeError(f"invalid decimals() result for {chain}:{ca}") from exc
        if not 0 <= decimals <= 36:
            raise RuntimeError(f"out-of-range decimals() result for {chain}:{ca}")
        _decimals[key] = decimals
        if _journal is not None:
            _journal.put_cache(chain, ca.lower(), "decimals", decimals, 0)
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
    """Price and classify a swap, then durably enqueue its API event when configured."""
    px = price.get_price_usd(ev["ca"], ev["chain"])
    usd = ev["qty"] * px if px else None
    if usd is not None and usd < config.min_usd:
        return None
    ev["ts"] = datetime.fromtimestamp(ts_unix, config.ICT).strftime("%Y-%m-%d %H:%M:%S")
    ev["usd"] = usd or 0.0
    print(cl.fmt_event(ev), flush=True)
    emit.jl_write(ev)
    body = cl.trade_body(ev, usd, int(ts_unix * 1000))
    if _journal is not None:
        body["block"] = ev.get("block", 0)
        body["blockHash"] = ev.get("blockHash", "")
        delivery.post_trade(body)
    else:
        emit.post_trade(body)
    _track_ca(ev, usd)
    return ev


# ---------- tx processing ----------


def _merge_trace_transfers(receipt_transfers, trace_transfers):
    """Use receipt logs when present; keep only trace legs not already logged."""
    remaining = {}
    for item in receipt_transfers:
        key = (item["ca"], item["from"], item["to"], item["value"])
        remaining[key] = remaining.get(key, 0) + 1
    merged = list(receipt_transfers)
    for item in trace_transfers:
        key = (item["ca"], item["from"], item["to"], item["value"])
        if remaining.get(key, 0):
            remaining[key] -= 1
        else:
            merged.append(item)
    return merged

def _cached_rpc(chain, tx_hash, block, kind, load):
    if _journal is not None:
        cached = _journal.get_cache(chain, tx_hash, kind)
        if cached is not None:
            return cached
    result = load()
    if _journal is not None and result is not None:
        _journal.put_cache(chain, tx_hash, kind, result, block)
    return result


def _mark_processed(chain, tx_hash, block, block_hash, seen_key):
    if _journal is not None:
        _journal.mark_tx(chain, tx_hash, block, block_hash)
    _seen_tx.add(seen_key)


def _process_receipt(chain, tx_hash, block):
    return _cached_rpc(
        chain,
        tx_hash,
        block,
        "receipt",
        lambda: evm_rpc(chain, "eth_getTransactionReceipt", [tx_hash]),
    )


def _process_transaction(chain, tx_hash, block):
    return _cached_rpc(
        chain,
        tx_hash,
        block,
        "transaction",
        lambda: evm_rpc(chain, "eth_getTransactionByHash", [tx_hash]),
    )


def _process_trace(chain, tx_hash, block):
    return _cached_rpc(
        chain, tx_hash, block, "trace", lambda: trace_transaction(chain, tx_hash)
    )


def process_tx(chain, t, wallets, transaction=None, trace_wallets=()):
    """Classify one confirmed tx and persist completion only after durable emission."""
    txh = t["tx"].lower()
    block = t["block"]
    block_hash = str(t.get("blockHash") or (transaction or {}).get("blockHash") or "")
    seen_key = (chain, txh)
    if _journal is not None:
        if _journal.seen(chain, txh, block_hash):
            return None
    elif seen_key in _seen_tx:
        return None
    if len(_seen_tx) >= _SEEN_MAX:
        _seen_tx.clear()

    receipt = _process_receipt(chain, txh, block)
    if not isinstance(receipt, dict):
        raise RuntimeError(f"missing transaction receipt for {chain}:{txh}")
    status = str(receipt.get("status") or "").lower()
    if status == "0x0":
        _mark_processed(chain, txh, block, block_hash, seen_key)
        return None
    if status != "0x1":
        raise RuntimeError(f"invalid transaction receipt status for {chain}:{txh}")

    transfers = [
        item
        for item in (cl.decode_transfer_log(log) for log in receipt.get("logs") or [])
        if item
    ]
    transaction_loaded = transaction is not None
    emitted, trace_legs = [], None
    to = receipt.get("to") or (
        transaction.get("to") if isinstance(transaction, dict) else None
    )
    forced_wallets = {str(wallet).lower() for wallet in trace_wallets}
    for wallet in {str(value).lower() for value in wallets}:
        wallet_transfers = [
            item for item in transfers if item["from"] == wallet or item["to"] == wallet
        ]
        tx_touches_wallet = (
            wallet in forced_wallets
            or (
                isinstance(transaction, dict)
                and (
                    str(transaction.get("from") or "").lower() == wallet
                    or str(transaction.get("to") or "").lower() == wallet
                )
            )
        )
        if not wallet_transfers and not tx_touches_wallet:
            continue
        direct_contracts = {item["ca"] for item in wallet_transfers}
        if (
            cl.router_name(chain, to) is None
            and isinstance(to, str)
            and to.lower() in direct_contracts
        ):
            continue

        tx_args = {
            "to": to,
            "tx": txh,
            "transfers": list(transfers),
            "decimals_of": lambda ca: token_decimals(chain, ca),
        }
        events = cl.classify_swaps(chain, wallet, tx_args)
        if not events and (wallet_transfers or tx_touches_wallet):
            if not transaction_loaded:
                transaction = _process_transaction(chain, txh, block)
                transaction_loaded = True
                if not isinstance(transaction, dict):
                    raise RuntimeError(f"missing transaction body for {chain}:{txh}")
            if trace_legs is None:
                trace = _process_trace(chain, txh, block)
                trace_legs = cl.decode_call_trace(trace, chain, txh, block)
            tx_args["transfers"] = _merge_trace_transfers(transfers, trace_legs)
            events = cl.classify_swaps(chain, wallet, tx_args)

        for event in events:
            event["block"] = block
            event["blockHash"] = block_hash
            posted = emit_swap(event, block_ts(chain, block))
            if posted:
                emitted.append(posted)

    _mark_processed(chain, txh, block, block_hash, seen_key)
    return emitted or None




def _queue_log(chain, log, wallets):
    if _journal is None:
        return process_log(chain, log, wallets)
    with _chain_lock(chain):
        _journal.record_log(chain, log)
        if log.get("removed"):
            block = int(log.get("blockNumber") or "0x0", 16)
            _journal.rewind(chain, max(0, block - 1))
            return None
        transfer = cl.decode_transfer_log(log)
        if transfer and (
            transfer["from"] in wallets or transfer["to"] in wallets
        ):
            transfer["blockHash"] = str(log.get("blockHash") or "")
            _journal.enqueue_candidate(
                chain,
                transfer["tx"],
                transfer["block"],
                transfer["blockHash"],
            )
        _journal.complete_log(chain, log)
        return transfer


def _drain_candidates(chain, wallets, confirmed_through=None):
    if _journal is None:
        return []
    with _chain_lock(chain):
        return _drain_candidates_locked(chain, wallets, confirmed_through)


def _drain_candidates_locked(chain, wallets, confirmed_through):
    if _journal is None:
        return []
    if _journal.halted(chain):
        raise journal_mod.DeepReorgError(f"chain halted after deep reorg: {chain}")
    emitted = []
    for candidate in _journal.pending_candidates(chain):
        block = int(candidate["block"])
        if confirmed_through is not None and block > confirmed_through:
            continue
        transaction = candidate.get("transaction")
        context = {
            "tx": candidate["tx"],
            "block": block,
            "blockHash": candidate.get("blockHash") or "",
        }
        try:
            result = process_tx(
                chain,
                context,
                wallets,
                transaction=transaction,
                trace_wallets=candidate.get("trace_wallets") or (),
            )
        except journal_mod.DeepReorgError:
            raise
        except Exception as exc:
            key = (chain, candidate["tx"])
            now = time.time()
            trace_blocked = isinstance(exc, TraceMethodUnavailable) or (
                getattr(exc, "category", None) == "trace"
            )
            if trace_blocked and _trace_disabled(chain):
                if chain not in _trace_defer_logged:
                    print(
                        f"  # trace disabled for {chain}: pending candidates "
                        "deferred without trace RPC calls",
                        file=sys.stderr,
                    )
                    _trace_defer_logged.add(chain)
                _journal.defer_candidate(
                    chain,
                    candidate["tx"],
                    block,
                    candidate.get("blockHash") or "",
                    now + 3600.0,
                    increment_attempts=False,
                )
                continue
            if now - _candidate_errors.get(key, 0) >= 60:
                print(
                    f"  ! pending candidate {chain}:{candidate['tx'][:12]} "
                    f"kept for retry ({type(exc).__name__}: {str(exc)[:80]})",
                    file=sys.stderr,
                )
                _candidate_errors[key] = now
            attempt = int(candidate.get("attempts", 0))
            delay = min(3600.0, 2.0 ** min(attempt, 11))
            delay = max(delay, float(getattr(exc, "retry_after", 0.0)))
            _journal.defer_candidate(
                chain,
                candidate["tx"],
                block,
                candidate.get("blockHash") or "",
                now + delay,
            )
            continue
        _candidate_errors.pop((chain, candidate["tx"]), None)
        _journal.complete_candidate(
            chain, candidate["tx"], block, candidate.get("blockHash") or ""
        )
        if result:
            emitted.extend(result)
    return emitted


def _recover_inbox(chain, wallets, confirmed_through):
    if _journal is None:
        return
    for log in _journal.pending_logs(chain):
        block = int(log.get("blockNumber") or "0x0", 16)
        if block <= confirmed_through:
            _queue_log(chain, log, wallets)


def process_log(chain, log, wallets):
    if _journal is not None:
        _queue_log(chain, log, wallets)
        return _drain_candidates(chain, wallets)
    transfer = cl.decode_transfer_log(log)
    if transfer is None or (
        transfer["from"] not in wallets and transfer["to"] not in wallets
    ):
        return None
    return process_tx(chain, transfer, wallets)


def scan_block_transactions(chain, block, wallets, trace_candidates=None):
    """Persist candidates from one full block before its caller advances the cursor."""
    result = evm_rpc(chain, "eth_getBlockByNumber", [hex(block), True])
    if not isinstance(result, dict) or not isinstance(result.get("transactions"), list):
        raise RuntimeError(f"invalid full block response for {chain}:{block}")
    tracked = {str(wallet).lower() for wallet in wallets}
    block_hash = str(result.get("hash") or "")
    trace_candidates = trace_candidates or {}
    candidates = []
    for tx in result["transactions"]:
        if not isinstance(tx, dict):
            raise RuntimeError(f"invalid transaction in {chain}:{block}")
        txh = str(tx.get("hash") or "").lower()
        forced = trace_candidates.get(txh, set())
        sender = str(tx.get("from") or "").lower()
        recipient = str(tx.get("to") or "").lower()
        if sender not in tracked and recipient not in tracked and not forced:
            continue
        if not txh:
            raise RuntimeError(f"tracked block transaction has no hash in {chain}:{block}")
        if _journal is None:
            process_tx(
                chain,
                {"tx": txh, "block": block, "blockHash": block_hash},
                tracked,
                transaction=tx,
                trace_wallets=forced,
            )
        else:
            candidates.append(
                {
                    "tx": txh,
                    "block": block,
                    "blockHash": block_hash,
                    "transaction": tx,
                    "trace_wallets": sorted(forced),
                }
            )
    return candidates

def _env_chains(name):
    return {
        value.strip().lower()
        for value in os.environ.get(name, "").split(",")
        if value.strip()
    }


def backfill_transaction_blocks(chain, wallets, st, chain_state, end, opts):
    """Discover candidates in bounded blocks, then durably advance each block."""
    if chain in _env_chains("EVM_TX_SCAN_DISABLED_CHAINS"):
        if chain_state.get("last_tx_block") != end:
            chain_state["last_tx_block"] = end
            _save_state(st)
        return True
    if not wallets:
        return True
    if _journal is not None:
        _drain_candidates(chain, wallets, end)
    cursor = chain_state.get("last_tx_block")
    start = min(int(chain_state.get("last_block") or end), end) if cursor is None else int(cursor) + 1
    if start > end:
        return True
    raw_limit = os.environ.get(f"EVM_MAX_TX_BLOCKS_{chain.upper()}")
    limit_name = f"EVM_MAX_TX_BLOCKS_{chain.upper()}"
    if raw_limit is None:
        raw_limit = os.environ.get("EVM_MAX_TX_BLOCKS")
        limit_name = "EVM_MAX_TX_BLOCKS"
    if raw_limit is None:
        limit = int(opts.get("max_tx_blocks", 4))
    else:
        try:
            limit = int(raw_limit)
        except ValueError as exc:
            raise ValueError(f"{limit_name} must be an integer") from exc
    limit = max(1, limit)
    stop = min(end, start + limit - 1)
    trace_candidates = trace_filter_candidates(chain, start, stop, wallets)
    for block in range(start, stop + 1):
        candidates = scan_block_transactions(chain, block, wallets, trace_candidates)
        if _journal is not None:
            _journal.advance_candidate_block(chain, candidates, block)
        chain_state["last_tx_block"] = block
        _save_state(st)
        st_mod._beat()
        if _journal is not None:
            _drain_candidates(chain, wallets, block)
    return stop == end


# ---------- backfill ----------


def _startup_backfill_limit():
    """Seconds of downtime still replayed at startup; 0 = always jump to latest."""
    raw = os.environ.get("EVM_MAX_STARTUP_BACKFILL_SECONDS", "900")
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("EVM_MAX_STARTUP_BACKFILL_SECONDS must be an integer") from exc
    return max(0, value)


def _chain_chunk_cap(chain):
    raw = os.environ.get("EVM_CHUNK_CAPS", "")
    for item in raw.split(","):
        key, _, value = item.partition("=")
        if key.strip() != chain:
            continue
        try:
            return max(1, int(value.strip()))
        except ValueError:
            return None
    return None


def _chain_confirmations(chain, opts):
    raw = os.environ.get(f"EVM_CONFIRMATIONS_{chain.upper()}")
    if raw is None:
        return int(opts["conf"])
    try:
        return max(1, int(raw))
    except ValueError as exc:
        raise ValueError(
            f"EVM_CONFIRMATIONS_{chain.upper()} must be an integer"
        ) from exc


def _backfill_locked(chain, wallets, st, opts):
    """Reconcile confirmed logs, journaling every event before committing its range."""

    if _journal is not None and _journal.halted(chain):
        return False
    latest = block_number(chain)
    end = latest - _chain_confirmations(chain, opts) + 1
    if end < 0:
        return True
    cs = st.setdefault("evm", {}).setdefault(chain, {})
    if _journal is not None:
        cs.update(_journal.state(chain))
        _recover_inbox(chain, set(wallets), end)
    if "last_tx_block" not in cs:
        previous = int(cs.get("last_block") or end)
        cs["last_tx_block"] = previous - 1
        _save_state(st)
    if chain not in _startup_checked:
        _startup_checked.add(chain)
        last = int(cs.get("last_block") or 0)
        updated = cs.get("updated_at")
        if last and updated is not None and end > last:
            idle = time.time() - float(updated)
            if idle > _startup_backfill_limit():
                cs["last_block"] = end
                cs["last_tx_block"] = end
                cs["chunk_ok"] = 0
                cs["updated_at"] = int(time.time())
                if _journal is not None:
                    _journal.advance_cursor(chain, "last_block", end)
                    _journal.advance_cursor(chain, "last_tx_block", end)
                _save_state(st)
                print(
                    f"# skip backlog {chain}: idle {int(idle)}s, "
                    f"{end - last} block → latest {end}",
                    flush=True,
                )
    start = int(cs.get("last_block") or 0) + 1
    if not cs.get("last_block") and not cs.get("recovery"):
        start = end
    disabled_logs = _env_chains("EVM_LOGS_DISABLED_CHAINS")
    if chain in disabled_logs:
        if cs.get("last_block") != end:
            cs["last_block"] = end
            cs["updated_at"] = int(time.time())
            if _journal is not None:
                _journal.advance_cursor(chain, "last_block", end)
            _save_state(st)
        return backfill_transaction_blocks(chain, wallets, st, cs, end, opts)
    if start > end:
        if _journal is not None:
            _drain_candidates(chain, set(wallets), end)
        return backfill_transaction_blocks(chain, wallets, st, cs, end, opts)
    wl = set(wallets)
    endpoint = rpc_url(chain)
    endpoint_id = rpc.endpoint_key(endpoint)
    same_endpoint = cs.get("chunk_endpoint_id") in (None, endpoint_id)
    cached_span = cs.get("chunk_span") if same_endpoint else None
    caps = cs.get("chunk_caps")
    if not isinstance(caps, dict):
        caps = {}
        legacy_cap = cs.pop("chunk_cap", None)
        if isinstance(legacy_cap, int) and legacy_cap > 0:
            caps[cs.get("chunk_endpoint_id") or endpoint_id] = legacy_cap
        cs["chunk_caps"] = caps
    target_span = max(1, int(opts["span"]))
    forced_cap = _chain_chunk_cap(chain)
    if forced_cap:
        target_span = min(target_span, forced_cap)
    cap = caps.get(endpoint_id)
    if isinstance(cap, int) and cap > 0:
        target_span = min(target_span, cap)
    span = min(max(1, int(cached_span or target_span)), target_span)
    if cs.get("chunk_span") != span:
        cs["chunk_span"] = span
        _save_state(st)
    cs["chunk_endpoint_id"] = endpoint_id
    cs.pop("chunk_rpc", None)
    if span < target_span and int(cs.get("chunk_ok") or 0) >= CHUNK_RECOVER_AFTER:
        span = min(target_span, span * 2)
        cs["chunk_span"] = span
        cs["chunk_ok"] = 0
        _save_state(st)
        print(f"# getLogs {chain} chê range → recover chunk {span}", flush=True)
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
        except RuntimeError as exc:
            message = str(exc).lower()
            rate_limited = any(
                marker in message
                for marker in (
                    "capacity",
                    "quota",
                    "rate limit",
                    "request limit",
                    "too many requests",
                    "429",
                )
            )
            if b > a and not rate_limited and any(
                marker in message
                for marker in (
                    "exceed",
                    "range",
                    "limit",
                    "too many",
                    "results",
                    "specify an address",
                )
            ):
                span = max(1, (b - a + 1) // 2)
                err_key = getattr(exc, "endpoint_key", None) or endpoint_id
                cap_match = re.search(r"up to (?:a )?(\d+) block range", message)
                if cap_match is None:
                    cap_match = re.search(
                        r"limited to 0 - (\d+) blocks? range", message
                    )
                if cap_match:
                    cap = max(1, int(cap_match.group(1)))
                    caps[err_key] = cap
                    if err_key == endpoint_id:
                        span = min(span, cap)
                if err_key != endpoint_id:
                    # Fallback provider chê range: giữ nguyên span của endpoint chính.
                    _save_state(st)
                    raise
                cs["chunk_span"] = span
                cs["chunk_ok"] = 0
                _save_state(st)
                todo, i = cl.chunk_ranges(a, end, span), 0
                print(
                    f"# getLogs {chain} chê range → halve chunk còn {span}: {str(exc)[:80]}",
                    flush=True,
                )
                continue
            raise
        for log in _sort_logs(logs):
            _queue_log(chain, log, wl)
        cs["chunk_ok"] = int(cs.get("chunk_ok") or 0) + 1
        cs["last_block"] = b
        cs["updated_at"] = int(time.time())
        if _journal is not None:
            _journal.advance_cursor(chain, "last_block", b)
            cs.pop("recovery", None)
        _save_state(st)
        st_mod._beat()
        if _journal is not None:
            _drain_candidates(chain, wl, end)
        i += 1
        if max_chunks and i >= max_chunks and b < end:
            return False
    return backfill_transaction_blocks(chain, wl, st, cs, end, opts)

def backfill(chain, wallets, st, opts):
    with _chain_lock(chain):
        return _backfill_locked(chain, wallets, st, opts)


# ---------- feeds ----------


def run_poll_feed(per, st, opts):
    """Poll chains in bounded chunks; back off on RPC/receipt errors."""
    poll_opts = {
        **opts,
        "max_chunks": opts.get("max_chunks", POLL_MAX_CHUNKS_PER_CHAIN),
    }
    while True:
        refresh = opts.get("refresh")
        if refresh:
            refresh(per)
        backlog = False
        errors = []
        for chain, wallets in per.items():
            if not wallets:
                continue
            try:
                if not backfill(chain, wallets, st, poll_opts):
                    backlog = True
            except Exception as exc:
                errors.append((chain, exc))
                backlog = True
                print(
                    f"  ! poll {chain}: {type(exc).__name__}: {str(exc)[:80]}",
                    file=sys.stderr,
                )
        _save_state(st)
        if opts.get("once"):
            if errors:
                chain, error = errors[0]
                raise RuntimeError(f"poll failed for {chain}") from error
            return
        retry_after = max(
            (float(getattr(error, "retry_after", 0.0)) for _, error in errors),
            default=0.0,
        )
        if errors:
            time.sleep(max(opts["sleep"], retry_after))
        elif backlog:
            time.sleep(opts.get("backlog_sleep", 0.5))
        else:
            time.sleep(opts["sleep"])
        st_mod._beat()


def hybrid_feed_plan(per):
    """Use log subscriptions where a WSS URL exists; poll only missing chains."""
    ws_chains, poll_chains = {}, {}
    for chain, wallets in per.items():
        if not wallets:
            continue
        target = ws_chains if wss_urls(chain) else poll_chains
        target[chain] = wallets
    return ws_chains, poll_chains


async def _poll_chain_loop(chain, wallets, per, st, opts):
    poll_opts = {
        **opts,
        "max_chunks": opts.get("max_chunks", POLL_MAX_CHUNKS_PER_CHAIN),
    }
    while True:
        refresh = opts.get("refresh")
        if refresh:
            refresh(per)
        try:
            complete = await asyncio.to_thread(backfill, chain, wallets, st, poll_opts)
        except Exception as exc:
            print(
                f"  ! poll fallback {chain}: {type(exc).__name__}: {str(exc)[:80]}",
                file=sys.stderr,
            )
            delay = max(opts.get("sleep", 3.0), float(getattr(exc, "retry_after", 0.0)))
        else:
            delay = opts.get("sleep", 3.0) if complete else opts.get("backlog_sleep", 0.5)
        await asyncio.sleep(delay)
        st_mod._beat()


async def _subscribe_wallet_logs(ws, wallets):
    topics = cl.sub_topics(wallets)
    for request_id, filters in enumerate(topics, 1):
        await ws.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "eth_subscribe",
                    "params": ["logs", {"topics": filters}],
                }
            )
        )
    acknowledgements = set()
    pending = {}
    while len(acknowledgements) < len(topics):
        message = json.loads(await ws.recv())
        if isinstance(message, dict) and "id" in message:
            if "error" in message:
                raise RuntimeError(str(message["error"])[:120])
            if not isinstance(message.get("result"), str):
                raise RuntimeError("invalid eth_subscribe acknowledgement")
            acknowledgements.add(message["id"])
            continue
        result = (message.get("params") or {}).get("result") or {}
        if isinstance(result, dict) and result.get("topics"):
            key = (result.get("transactionHash"), result.get("logIndex"))
            pending.setdefault(key, result)
    return pending

async def _persist_pending_logs(chain, wallets, pending):
    if _journal is None:
        return
    for log in pending.values():
        await asyncio.to_thread(_queue_log, chain, log, wallets)


async def _handle_new_head(chain, header, st, head_state):
    if not isinstance(header, dict) or not header.get("hash"):
        return
    value = header.get("number") or "0"
    height = int(value, 16) if isinstance(value, str) else int(value)
    head_state["height"] = max(height, head_state.get("height") or 0)
    if _journal is None or _journal.halted(chain):
        return
    stored = _journal.headers(chain)
    by_height = {item["height"]: item["hash"] for item in stored}
    latest = stored[-1]["height"] if stored else None
    if latest is None:
        _journal.record_header(chain, header)
        return
    if latest is not None and height > latest:
        parent = by_height.get(height - 1)
        if parent and parent == header.get("parentHash"):
            _journal.record_header(chain, header)
            return
        if height > latest + 1:
            block = await asyncio.to_thread(
                evm_rpc, chain, "eth_getBlockByNumber", [hex(latest), False]
            )
            if block and block.get("hash") == by_height[latest]:
                _journal.record_header(chain, header)
                return
    elif latest is not None and height < latest:
        return
    elif by_height.get(height) == header.get("hash"):
        return
    ancestor = 0
    if stored:
        offsets = (1, 2, 4, 8, 16, 32, 64, 128, 256)
        for offset in offsets:
            index = max(0, len(stored) - 1 - offset)
            candidate = stored[index]["height"]
            if candidate >= latest:
                continue
            block = await asyncio.to_thread(
                evm_rpc, chain, "eth_getBlockByNumber", [hex(candidate), False]
            )
            if block and block.get("hash") == by_height.get(candidate):
                ancestor = candidate
                break
    try:
        _journal.rewind(chain, ancestor)
    except journal_mod.DeepReorgError:
        raise
    _journal.record_header(chain, header)
    st.setdefault("evm", {}).setdefault(chain, {}).update(_journal.state(chain))
    print(f"# reorg {chain}: rewind to block {ancestor}", file=sys.stderr, flush=True)


async def _accept_ws_notification(message, chain, wallets, pending, st, head_state):
    result = (message.get("params") or {}).get("result") or {}
    if not isinstance(result, dict):
        return
    if _journal is not None and _journal.halted(chain):
        return
    if result.get("topics"):
        key = (result.get("transactionHash"), result.get("logIndex"))
        if result.get("removed"):
            pending.pop(key, None)
            if _journal is not None:
                await asyncio.to_thread(_queue_log, chain, result, wallets)
        else:
            pending.setdefault(key, result)
            if _journal is not None:
                await asyncio.to_thread(_queue_log, chain, result, wallets)
    elif result.get("number") and result.get("parentHash"):
        await _handle_new_head(chain, result, st, head_state)


async def _subscribe_new_heads(ws, chain, wallets, pending, st, head_state):
    request_id = 10000
    await ws.send(json.dumps({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "eth_subscribe",
        "params": ["newHeads"],
    }))
    while True:
        message = json.loads(await ws.recv())
        if isinstance(message, dict) and message.get("id") == request_id:
            if "error" in message or not isinstance(message.get("result"), str):
                raise RuntimeError(f"newHeads subscription failed: {message.get('error')}")
            return
        await _accept_ws_notification(message, chain, wallets, pending, st, head_state)


async def _consume_ws_logs(ws, chain, wallets, opts, pending, st=None, head_state=None):
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
    except asyncio.TimeoutError:
        raw = None
    if raw is not None:
        await _accept_ws_notification(
            json.loads(raw), chain, wallets, pending, st, head_state or {}
        )
    if not pending:
        st_mod._beat()
        return pending
    latest = (
        (head_state or {}).get("height")
        if (head_state or {}).get("head_updates")
        else None
    )
    if latest is None:
        now = time.monotonic()
        latest = (head_state or {}).get("fallback_height")
        if latest is None or now >= (head_state or {}).get("next_poll", 0):
            latest = await asyncio.to_thread(block_number, chain)
            if head_state is not None:
                head_state["fallback_height"] = latest
                head_state["next_poll"] = now + opts.get("head_poll_interval", 5.0)
    confirmed_through = latest - _chain_confirmations(chain, opts) + 1
    keep = {}
    for key, log in pending.items():
        block = int(log.get("blockNumber") or "0x0", 16)
        if block > confirmed_through:
            keep[key] = log
    if _journal is not None:
        await asyncio.to_thread(_drain_candidates, chain, wallets, confirmed_through)
    else:
        for key, log in pending.items():
            if key not in keep:
                await asyncio.to_thread(process_log, chain, log, wallets)
    st_mod._beat()
    return keep


def _reconcile_delay(chain, complete, opts):
    """Keep tx-scan chains continuous; log chains may idle between reconciles."""
    backlog = float(opts.get("backlog_sleep", 0.5))
    if not complete:
        return backlog
    tx_scan = (
        chain in _env_chains("EVM_LOGS_DISABLED_CHAINS")
        and chain not in _env_chains("EVM_TX_SCAN_DISABLED_CHAINS")
    )
    if tx_scan:
        return backlog
    return float(opts.get("reconcile_interval", 30.0))


async def _reconcile_ws_chain(chain, wallets, per, st, opts):
    poll_opts = {
        **opts,
        "max_chunks": opts.get("max_chunks", POLL_MAX_CHUNKS_PER_CHAIN),
    }
    while True:
        refresh = opts.get("refresh")
        if refresh:
            refresh(per)
        try:
            complete = await asyncio.to_thread(backfill, chain, wallets, st, poll_opts)
            delay = _reconcile_delay(chain, complete, opts)
        except Exception as exc:
            print(f"  ! reconcile {chain}: {type(exc).__name__}: {str(exc)[:80]}", file=sys.stderr)
            delay = max(opts.get("sleep", 3.0), float(getattr(exc, "retry_after", 0.0)))
        await asyncio.sleep(delay)
        st_mod._beat()



async def _seed_ws_head(chain, st, head_state):
    header = await asyncio.to_thread(
        evm_rpc, chain, "eth_getBlockByNumber", ["latest", False]
    )
    if not isinstance(header, dict) or not header.get("hash"):
        raise RuntimeError(f"invalid latest header for {chain}")
    await _handle_new_head(chain, header, st, head_state)
async def _run_ws_session(chain, wallets, per, st, opts, websockets, endpoint):
    refresh = opts.get("refresh")
    if refresh:
        refresh(per)
    wallet_set = set(wallets)
    async with websockets.connect(
        endpoint, open_timeout=10, ping_interval=20, max_size=None
    ) as ws:
        rpc.succeeded(endpoint, "wss")
        pending = await _subscribe_wallet_logs(ws, wallet_set)
        await _persist_pending_logs(chain, wallet_set, pending)
        head_state = {"height": None, "head_updates": False}
        try:
            await _subscribe_new_heads(
                ws, chain, wallet_set, pending, st, head_state
            )
            head_state["head_updates"] = True
        except Exception as exc:
            print(
                f"  ! newHeads unavailable {chain}: {type(exc).__name__}; "
                "using paced HTTP head checks",
                file=sys.stderr,
            )
        try:
            await _seed_ws_head(chain, st, head_state)
        except journal_mod.DeepReorgError:
            raise
        except Exception as exc:
            print(
                f"  ! latest header unavailable {chain}: {type(exc).__name__}",
                file=sys.stderr,
            )
        print(
            f"# feed=ws {chain}: subscribed logs+heads for {len(wallet_set)} wallets "
            f"(from/to) — {config._mask(endpoint)}",
            flush=True,
        )
        reconcile = asyncio.create_task(
            _reconcile_ws_chain(chain, wallets, per, st, opts)
        )
        try:
            while True:
                pending = await _consume_ws_logs(
                    ws, chain, wallet_set, opts, pending, st, head_state
                )
        finally:
            reconcile.cancel()
            try:
                await reconcile
            except asyncio.CancelledError:
                pass


async def _recover_ws_disconnect(chain, wallets, st, opts, endpoint, exc, backoff):
    category = rpc._error_category(exc)
    category = category if category in ("quota", "permission") else "transport"
    if endpoint:
        rpc.failed(
            endpoint,
            category,
            rpc._retry_after(exc, time.time()),
            method="wss",
        )
    print(
        f"  ! ws {chain} disconnected ({type(exc).__name__}: {str(exc)[:70]}) "
        f"→ reconcile + reconnect in {backoff}s",
        file=sys.stderr,
    )
    try:
        await asyncio.to_thread(
            backfill,
            chain,
            wallets,
            st,
            {**opts, "max_chunks": opts.get("max_chunks", POLL_MAX_CHUNKS_PER_CHAIN)},
        )
    except Exception as recovery_exc:
        print(
            f"  ! reconnect reconcile {chain}: {type(recovery_exc).__name__}: "
            f"{str(recovery_exc)[:70]}",
            file=sys.stderr,
        )
        backoff = max(backoff, int(getattr(recovery_exc, "retry_after", 0)))
    await asyncio.sleep(backoff)
    return min(60, backoff * 2)


async def _ws_chain_loop(chain, wallets, per, st, opts, websockets):
    backoff = 2
    endpoints = wss_urls(chain)
    while True:
        if _journal is not None and _journal.halted(chain):
            await asyncio.sleep(opts.get("halt_check_interval", 60.0))
            continue
        endpoint = wss_url(chain)
        try:
            ready = rpc.ready_urls(endpoints, "wss")
            if not ready:
                delay = rpc._next_retry(endpoints, "wss", time.time())
                await asyncio.sleep(max(1.0, delay))
                continue
            endpoint = ready[0]
            await _run_ws_session(
                chain, wallets, per, st, opts, websockets, endpoint
            )
            backoff = 2
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:
            backoff = await _recover_ws_disconnect(
                chain, wallets, st, opts, endpoint, exc, backoff
            )


def run_ws_feed(per, st, opts):
    """Subscribe to wallet logs and heads; bounded HTTP reconciliation fills gaps."""
    hybrid = bool(opts.get("hybrid"))
    ws_chains, poll_chains = hybrid_feed_plan(per)
    if poll_chains and not hybrid:
        chain = next(iter(poll_chains))
        raise RuntimeError(
            f"feed=ws requires {chain.upper()}_WSS_URL; use --feed hybrid or poll"
        )
    try:
        import websockets
    except ImportError:
        if hybrid:
            print("  ! websockets package missing; using paced poll feed", file=sys.stderr)
            return run_poll_feed(per, st, opts)
        sys.exit("feed=ws requires websockets; install it or use --feed poll")

    async def _run():
        loops = [
            _ws_chain_loop(chain, wallets, per, st, opts, websockets)
            for chain, wallets in ws_chains.items()
        ]
        loops.extend(
            _poll_chain_loop(chain, wallets, per, st, opts)
            for chain, wallets in poll_chains.items()
        )
        if loops:
            await asyncio.gather(*loops)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass




def run_hybrid_feed(per, st, opts):
    """Prefer WSS logs/heads, reconcile after disconnect, and poll chains without WSS."""
    return run_ws_feed(per, st, {**opts, "hybrid": True})
