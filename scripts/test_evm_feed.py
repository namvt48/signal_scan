"""Tests offline cho watchers/evm/feed.py + main.load_wallets — T8/D7.
KHÔNG mạng thật: mọi JSON-RPC đi qua FakeEvm monkeypatch vào seam
`config.http_json`. Chạy: python3 -m pytest scripts/test_evm_feed.py -q
"""

import asyncio
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from typing import Any
from urllib.error import HTTPError

import pytest

from watchers.common import config
from watchers.common import state as st_mod
from watchers.evm import feed
from watchers.evm import main as emain
from watchers.evm.journal import Journal

WALLET = "0x1111111111111111111111111111111111111111"
POOL = "0x3333333333333333333333333333333333333333"
TOKEN = "0x2222222222222222222222222222222222222222"
WETH = "0x4200000000000000000000000000000000000006"
WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
UNISWAP = "0x2626664c2603336e57b271c5c0b26f421741e481"
PANCAKE = "0x10ed43c718714eb63d5aa57b78b54704e256024e"
TX = "0x" + "ab" * 32
BLOCK_TIME = 1_700_000_000


def raw_log(frm, to, value, ca=TOKEN, tx=TX, block=990, idx=0):
    return {
        "address": ca,
        "topics": [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x" + "0" * 24 + frm.lower()[2:],
            "0x" + "0" * 24 + to.lower()[2:],
        ],
        "data": "0x%064x" % value,
        "blockNumber": hex(block),
        "transactionHash": tx,
        "logIndex": hex(idx),
    }


def swap_receipt(to=UNISWAP, status="0x1"):
    """BUY TOKEN bằng WETH qua router: ví gửi quote, nhận token."""
    return {
        "status": status,
        "to": to,
        "logs": [
            raw_log(WALLET, POOL, 5 * 10**17, ca=WETH, idx=1),
            raw_log(POOL, WALLET, 1000 * 10**6, ca=TOKEN, idx=2),
        ],
    }


class FakeEvm:
    """JSON-RPC EVM giả lập — thế vào config.http_json. Không network."""

    def __init__(
        self,
        latest=1000,
        logs=None,
        receipts=None,
        max_span=None,
        decimals=6,
        block_time=BLOCK_TIME,
        transactions=None,
        traces=None,
        blocks=None,
        trace_filters=None,
        range_error_message="exceed maximum block range",
    ):
        self.latest = latest
        self.logs = logs or []
        self.receipts = receipts or {}
        self.transactions = transactions or {}
        self.traces = traces or {}
        self.blocks = blocks or {}
        self.trace_filters = trace_filters or {}
        self.max_span = max_span
        self.range_error_message = range_error_message
        self.decimals = decimals
        self.block_time = block_time
        self.getlogs_calls: list[tuple[str, int, int]] = []
        self.receipt_calls: list[str] = []
        self.transaction_calls: list[str] = []
        self.trace_calls: list[str] = []
        self.trace_filter_calls: list[dict] = []
        self.block_calls: list[int] = []
        self.range_errors = 0

    def __call__(self, url, payload=None, timeout=20, headers=None):
        assert payload is not None
        chain = (
            "base"
            if "base.org" in url
            else "bsc"
            if "bsc" in url
            else "robinhood"
            if "robinhood" in url
            else "?"
        )
        method, params = payload["method"], payload["params"]
        if method == "eth_blockNumber":
            result = hex(self.latest)
        elif method == "eth_getLogs":
            query = params[0]
            start, end = int(query["fromBlock"], 16), int(query["toBlock"], 16)
            self.getlogs_calls.append((chain, start, end))
            if self.max_span and end - start + 1 > self.max_span:
                self.range_errors += 1
                return {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {"code": -32000, "message": self.range_error_message},
                }
            result = [
                log
                for log in self.logs
                if start <= int(log["blockNumber"], 16) <= end
            ]
        elif method == "eth_getTransactionReceipt":
            self.receipt_calls.append(params[0])
            result = self.receipts.get(params[0])
        elif method == "eth_getTransactionByHash":
            self.transaction_calls.append(params[0])
            result = self.transactions.get(params[0])
        elif method == "debug_traceTransaction":
            self.trace_calls.append(params[0])
            result = self.traces.get(params[0])
        elif method == "trace_filter":
            self.trace_filter_calls.append(params[0])
            key = "from" if "fromAddress" in params[0] else "to"
            result = self.trace_filters.get(key, [])
        elif method == "eth_getBlockByNumber":
            number = int(params[0], 16)
            if params[1]:
                self.block_calls.append(number)
                result = self.blocks.get(number, {"transactions": []})
            else:
                result = {"timestamp": hex(self.block_time)}
        elif method == "eth_call":  # decimals()
            result = hex(self.decimals)
        else:
            result = None
        return {"jsonrpc": "2.0", "id": 1, "result": result}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Cache module sạch + state/heartbeat trỏ tmp + sleep/price stub (offline)."""
    feed._seen_tx.clear()
    feed._startup_checked.clear()
    feed._decimals.clear()
    feed._block_ts.clear()
    feed._tracked.clear()
    feed._trace_defer_logged.clear()
    feed.rpc_health_reset()
    monkeypatch.setattr(st_mod, "STATE_PATH", str(tmp_path / "evm_state.json"))
    monkeypatch.setattr(st_mod, "HEARTBEAT", str(tmp_path / "hb_evm"))
    monkeypatch.setattr(feed.time, "sleep", lambda s: None)
    monkeypatch.setattr(feed.price, "get_price_usd", lambda ca, chain="sol": 1.0)
    monkeypatch.setattr(config, "min_usd", 0.5)
    yield


@pytest.fixture
def trades(monkeypatch):
    out: list[dict[str, object]] = []
    monkeypatch.setattr(feed.emit, "post_trade", out.append)
    return out


def use_fake(monkeypatch, fake):
    monkeypatch.setattr(config, "http_json", fake)


# ---------- helpers thuần ----------


def test_concurrent_state_saves_use_distinct_atomic_files(monkeypatch, tmp_path):
    monkeypatch.setattr(st_mod, "STATE_PATH", str(tmp_path / "state.json"))
    all_written = threading.Barrier(4)
    original_dump = json.dump

    def synchronized_dump(state, handle):
        original_dump(state, handle)
        all_written.wait(timeout=5)

    monkeypatch.setattr(st_mod.json, "dump", synchronized_dump)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(st_mod.save_state, {"writer": i}) for i in range(4)]
        for future in futures:
            future.result(timeout=5)

    saved = st_mod.load_state()
    assert saved["writer"] in range(4)


def test_confirmed():
    assert feed.confirmed(95, 100, 6)  # 100-95+1 = 6 ≥ 6
    assert not feed.confirmed(96, 100, 6)  # 5 < 6


def test_sort_logs_dedup_and_order():
    l1 = raw_log(WALLET, POOL, 1, block=5, idx=1)
    l2 = raw_log(WALLET, POOL, 2, block=5, idx=0)
    l3 = raw_log(WALLET, POOL, 3, block=4, idx=9)
    assert feed._sort_logs([l1, l1, l2, l3]) == [
        l3,
        l2,
        l1,
    ]  # dedup (tx,logIndex) + sort


def test_track_ca_caches_only_after_success(monkeypatch):
    """duyệt từng TX: chỉ cache (chain,ca) SAU khi POST ok; lỗi POST KHÔNG được
    nuốt CA (cùng lớp bug emit._posted_mints, 2026-09-30)."""
    monkeypatch.setattr(config, "_track", True)
    calls: list[dict] = []

    def ok(url, body, timeout=None):
        calls.append(body)
        return None

    ev = {"side": "BUY", "chain": "base", "ca": TOKEN, "wallet": WALLET, "tx": TX}

    monkeypatch.setattr(config, "http_json", ok)
    feed._track_ca(ev, 100.0)
    assert ("base", TOKEN) in feed._tracked, "POST ok ⇒ phải cache"
    feed._track_ca(ev, 100.0)  # đã tracked ⇒ không POST lại
    assert len(calls) == 1, f"đã tracked ⇒ không POST lại, got {len(calls)}"

    feed._tracked.clear()

    def boom(url, body, timeout=None):
        raise RuntimeError("network down")

    monkeypatch.setattr(config, "http_json", boom)
    feed._track_ca(ev, 100.0)  # lỗi ⇒ KHÔNG cache
    assert ("base", TOKEN) not in feed._tracked, "lỗi POST KHÔNG được cache"

    monkeypatch.setattr(config, "http_json", ok)
    feed._track_ca(ev, 100.0)  # TX sau ⇒ thử lại
    assert len(calls) == 2, f"TX sau phải POST lại sau lỗi, got {len(calls)}"


def test_wss_url_derived_and_env_override(monkeypatch):
    assert feed.wss_url("base") == "wss://mainnet.base.org"
    monkeypatch.setenv("BSC_WSS_URL", "wss://example.com/ws")
    assert feed.wss_url("bsc") == "wss://example.com/ws"
    monkeypatch.setenv("BASE_RPC_URL", "https://rpc.example.com/base")
    assert feed.rpc_url("base") == "https://rpc.example.com/base"
    assert feed.wss_url("base") == "wss://rpc.example.com/base"


def test_rpc_urls_preserves_key_order_and_public_fallback(monkeypatch):
    primary = "https://base-mainnet.g.alchemy.com/v2/first"
    secondary = "https://base-mainnet.g.alchemy.com/v2/second"
    monkeypatch.setenv("BASE_RPC_URL", f" {primary} , {secondary} , {primary} ")

    assert feed.rpc_url("base") == primary
    assert feed.rpc_urls("base") == [primary, secondary, feed.DEFAULT_RPC["base"]]


def test_rpc_fails_over_to_second_configured_key_before_public(monkeypatch):
    primary = "https://base-mainnet.g.alchemy.com/v2/first"
    secondary = "https://base-mainnet.g.alchemy.com/v2/second"
    monkeypatch.setenv("BASE_RPC_URL", f"{primary},{secondary}")
    calls = []

    def primary_fails(url, payload=None, timeout=20, headers=None):
        calls.append(url)
        if url == primary:
            raise OSError("primary unavailable")
        return {"jsonrpc": "2.0", "id": 1, "result": "0x123"}

    monkeypatch.setattr(config, "http_json", primary_fails)

    assert feed.evm_rpc("base", "eth_blockNumber", []) == "0x123"
    assert calls == [primary, secondary]




def test_rpc_falls_back_to_public_endpoint_after_primary_failures(monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", "https://alchemy.example/base")
    calls = []

    def primary_then_public(url, payload=None, timeout=20, headers=None):
        calls.append(url)
        if url == "https://alchemy.example/base":
            raise OSError("primary unavailable")
        return {"jsonrpc": "2.0", "id": 1, "result": "0x123"}

    monkeypatch.setattr(config, "http_json", primary_then_public)

    assert feed.evm_rpc("base", "eth_blockNumber", []) == "0x123"
    assert calls == ["https://alchemy.example/base", feed.DEFAULT_RPC["base"]]


def test_http_range_error_carries_endpoint_identity():
    url = "https://alchemy.example/robinhood"
    body = BytesIO(
        json.dumps(
            {
                "error": {
                    "code": -32600,
                    "message": (
                        "Under the Free tier plan, you can make eth_getLogs "
                        "requests with up to a 10 block range."
                    ),
                }
            }
        ).encode()
    )
    exc = HTTPError(url, 400, "Bad Request", {}, body)
    with pytest.raises(feed.rpc._PermanentRpcError) as info:
        feed.rpc._handle_http_error(url, "eth_getLogs", exc)
    assert info.value.endpoint_key == feed.rpc.endpoint_key(url)
    assert "10 block range" in str(info.value)


def test_mask_redacts_path_tokens_and_query_credentials():
    path_url = "https://base-mainnet.g.alchemy.com/v2/sensitive"
    query_url = "https://rpc.example/rpc?api-key=sensitive"

    assert config._mask(path_url) == "https://base-mainnet.g.alchemy.com/v2/***"
    assert config._mask(query_url) == "https://rpc.example/***?***"

# ---------- backfill ----------


def test_backfill_scans_persists_and_posts_trade(monkeypatch, trades):
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 10**17, ca=WETH, block=990)],
        receipts={TX: swap_receipt()},
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 985}}}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    # end = 1000-8+1 = 993 ⇒ quét 986..993; log block 990 nằm trong range
    assert st["evm"]["base"]["last_block"] == 993
    assert json.load(open(st_mod.STATE_PATH))["evm"]["base"]["last_block"] == 993
    assert os.path.exists(st_mod.HEARTBEAT)  # watchdog beacon
    assert len(trades) == 1
    b = trades[0]
    assert b["chain"] == "base" and b["ca"] == TOKEN and b["side"] == "buy"
    assert b["amountUsd"] == pytest.approx(1000.0)  # qty 1000 × $1 (stub)
    assert b["price"] == pytest.approx(1.0)
    assert b["ts"] == BLOCK_TIME * 1000
    assert fake.receipt_calls == [TX]  # 2 sub filter trùng log ⇒ dedup, receipt 1 lần

def test_backfill_and_block_scan_coalesce_same_transaction(monkeypatch, trades):
    tx = {"hash": TX, "from": WALLET, "to": UNISWAP, "value": "0x0"}
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 10**17, ca=WETH, block=993)],
        receipts={TX: swap_receipt()},
        blocks={993: {"transactions": [tx]}},
    )
    use_fake(monkeypatch, fake)
    state = {"evm": {"base": {"last_block": 992}}}

    feed.backfill("base", [WALLET], state, {"conf": 8, "span": 500})

    assert len(trades) == 1 and trades[0]["tx"] == TX
    assert fake.receipt_calls == [TX]
    assert fake.trace_calls == []




def test_backfill_confirmation_gate(monkeypatch, trades):
    log_tip = raw_log(WALLET, POOL, 10**17, ca=WETH, block=1000)
    fake = FakeEvm(latest=1000, logs=[log_tip], receipts={TX: swap_receipt()})
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 999}}}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    # end = 993 < start 1000 ⇒ KHÔNG quét, log ở tip chưa đủ 8 confirmations
    assert trades == [] and fake.getlogs_calls == []
    assert st["evm"]["base"]["last_block"] == 999
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert len(trades) == 1
    assert st["evm"]["base"]["last_block"] == 1000
    assert all(b <= 1000 for _, a, b in fake.getlogs_calls)


def test_startup_skips_large_backlog(monkeypatch, trades):
    fake = FakeEvm(latest=1000, logs=[])
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("EVM_MAX_STARTUP_BACKFILL_SECONDS", "900")
    st = {
        "evm": {
            "base": {
                "last_block": 1,
                "last_tx_block": 1,
                "updated_at": time.time() - 3600,
            }
        }
    }
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    base = st["evm"]["base"]
    assert base["last_block"] == 1000
    assert base["last_tx_block"] == 1000
    assert fake.getlogs_calls == []


def test_startup_replays_small_backlog(monkeypatch, trades):
    fake = FakeEvm(latest=1000, logs=[])
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("EVM_MAX_STARTUP_BACKFILL_SECONDS", "900")
    st = {
        "evm": {
            "base": {
                "last_block": 900,
                "last_tx_block": 900,
                "updated_at": time.time() - 10,
            }
        }
    }
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert st["evm"]["base"]["last_block"] == 1000
    assert fake.getlogs_calls


def test_startup_without_timestamp_still_backfills(monkeypatch, trades):
    fake = FakeEvm(latest=1000, logs=[])
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 1}}}
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert st["evm"]["base"]["last_block"] == 1000
    assert fake.getlogs_calls


def test_backfill_chunk_halving_on_range_error(monkeypatch, trades):
    fake = FakeEvm(latest=1000, logs=[], max_span=100)  # provider chỉ nhận chunk ≤100
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 1}}}
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert st["evm"]["base"]["last_block"] == 1000  # quét tới cùng dù phải halve
    assert fake.range_errors > 0
    # mỗi chunk gọi getLogs 2 lần (2 sub filter from/to) ⇒ dedupe trước khi check phủ
    ok = sorted({(a, b) for c, a, b in fake.getlogs_calls if b - a + 1 <= 100})
    assert ok[0][0] == 2 and ok[-1][1] == 1000  # phủ kín 2..1000…
    for (a1, b1), (a2, _) in zip(ok, ok[1:]):
        assert a2 == b1 + 1  # …không hở khúc nào (R1)


def test_backfill_recovers_chunk_span_after_successes(monkeypatch, trades):
    """Range hẹp do lỗi tạm thời không được kẹt vĩnh viễn: span phải nới lại."""
    fake = FakeEvm(latest=1000, logs=[])
    use_fake(monkeypatch, fake)
    monkeypatch.setattr(feed, "CHUNK_RECOVER_AFTER", 2)
    endpoint_id = feed.rpc.endpoint_key(feed.rpc_url("base"))
    st = {
        "evm": {
            "base": {
                "last_block": 1,
                "chunk_span": 5,
                "chunk_ok": 2,
                "chunk_endpoint_id": endpoint_id,
            }
        }
    }
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500, "max_chunks": 16})
    assert st["evm"]["base"]["chunk_span"] == 10
    assert {b - a + 1 for _, a, b in fake.getlogs_calls} == {10}

    # Lần kế tiếp: đủ successes ⇒ nới tiếp 10 → 20
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500, "max_chunks": 16})
    assert st["evm"]["base"]["chunk_span"] == 20


def test_backfill_honors_provider_block_range_cap(monkeypatch, trades):
    """Alchemy free tier cap 10 block: halve về đúng cap và không nới quá cap."""
    fake = FakeEvm(
        latest=1000,
        logs=[],
        max_span=10,
        range_error_message=(
            "Under the Free tier plan, you can make eth_getLogs requests "
            "with up to a 10 block range."
        ),
    )
    use_fake(monkeypatch, fake)
    monkeypatch.setattr(feed, "CHUNK_RECOVER_AFTER", 2)
    endpoint_key = feed.rpc.endpoint_key(feed.rpc_url("base"))
    st = {"evm": {"base": {"last_block": 1}}}
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    base = st["evm"]["base"]
    assert base["chunk_span"] == 10
    assert base["chunk_caps"] == {endpoint_key: 10}
    assert base["last_block"] == 1000
    widths = [b - a + 1 for _, a, b in fake.getlogs_calls[1:]]
    assert max(widths) == 10 and min(widths) >= 1

    st2 = {
        "evm": {
            "base": {
                "last_block": 1,
                "chunk_span": 10,
                "chunk_caps": {endpoint_key: 10},
                "chunk_ok": 99,
            }
        }
    }
    feed.backfill("base", [WALLET], st2, {"conf": 1, "span": 500})
    assert st2["evm"]["base"]["chunk_span"] == 10


def test_fallback_range_cap_does_not_poison_active_span(monkeypatch):
    """Public 429 → Alchemy cap 10: cap thuộc Alchemy, không ghi đè span public."""
    primary = "https://public.example/robinhood"
    fallback = "https://alchemy.example/robinhood"
    monkeypatch.setenv("ROBINHOOD_RPC_URL", f"{primary},{fallback}")
    monkeypatch.setenv("EVM_TX_SCAN_DISABLED_CHAINS", "robinhood")
    monkeypatch.setattr(feed, "CHUNK_RECOVER_AFTER", 2)
    recovered = {"value": False}
    calls: list[tuple[str, int, int]] = []

    def fake(url, payload=None, timeout=20, headers=None):
        assert payload is not None
        method = payload["method"]
        if method == "eth_blockNumber":
            return {"jsonrpc": "2.0", "id": 1, "result": hex(1000)}
        assert method == "eth_getLogs"
        query = payload["params"][0]
        calls.append((url, int(query["fromBlock"], 16), int(query["toBlock"], 16)))
        if url == primary and not recovered["value"]:
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"code": 429, "message": "Too Many Requests"},
            }
        if url == primary:
            return {"jsonrpc": "2.0", "id": 1, "result": []}
        if url == fallback:
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {
                    "code": -32600,
                    "message": (
                        "Under the Free tier plan, you can make eth_getLogs "
                        "requests with up to a 10 block range."
                    ),
                },
            }
        raise OSError("public endpoint unavailable")

    monkeypatch.setattr(config, "http_json", fake)
    primary_key = feed.rpc.endpoint_key(primary)
    fallback_key = feed.rpc.endpoint_key(fallback)
    st = {
        "evm": {
            "robinhood": {
                "last_block": 1,
                "chunk_span": 500,
                "chunk_endpoint_id": primary_key,
            }
        }
    }
    with pytest.raises(RuntimeError):
        feed.backfill("robinhood", [WALLET], st, {"conf": 1, "span": 500})
    base = st["evm"]["robinhood"]
    assert base["chunk_span"] == 500
    assert base["chunk_caps"] == {fallback_key: 10}

    recovered["value"] = True
    feed.rpc_health_reset()
    feed.backfill("robinhood", [WALLET], st, {"conf": 1, "span": 500})
    assert base["last_block"] == 1000
    assert base["chunk_span"] == 500
    assert any(
        url == primary and b - a + 1 == 500 for url, a, b in calls
    )


def test_chain_chunk_cap_override(monkeypatch, trades):
    monkeypatch.setenv("EVM_CHUNK_CAPS", "base=10, bsc=50")
    assert feed._chain_chunk_cap("base") == 10
    assert feed._chain_chunk_cap("bsc") == 50
    assert feed._chain_chunk_cap("robinhood") is None

    fake = FakeEvm(latest=25, logs=[])
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 1, "chunk_span": 500}}}
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert st["evm"]["base"]["last_block"] == 25
    assert st["evm"]["base"]["chunk_span"] == 10


def test_backfill_does_not_halve_on_rate_limit(monkeypatch, trades):
    fake = FakeEvm(
        latest=1000,
        logs=[],
        max_span=1,
        range_error_message="HTTP 429: Too Many Requests",
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 1, "chunk_span": 5}}}
    with pytest.raises(RuntimeError):
        feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert st["evm"]["base"]["chunk_span"] == 5
    assert st["evm"]["base"]["last_block"] == 1

def test_backfill_does_not_halve_on_request_limit(monkeypatch, trades):
    fake = FakeEvm(
        latest=1000,
        logs=[],
        max_span=1,
        range_error_message="request limit reached",
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 1, "chunk_span": 5}}}
    with pytest.raises(RuntimeError):
        feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    assert st["evm"]["base"]["chunk_span"] == 5
    assert st["evm"]["base"]["last_block"] == 1


def test_address_less_logs_do_not_halve_or_advance(monkeypatch, trades):
    fake = FakeEvm(
        latest=20,
        max_span=1,
        range_error_message="Please specify an address in your request",
    )
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("BSC_RPC_URL", "https://bsc-rpc.publicnode.com")
    st = {"evm": {"bsc": {"last_block": 1}}}
    with pytest.raises(RuntimeError, match="authorization/permission"):
        feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 4})
    assert st["evm"]["bsc"]["last_block"] == 1
    assert fake.range_errors == 1


def test_address_required_logs_error_skips_retries(monkeypatch):
    fake = FakeEvm(
        latest=20,
        max_span=1,
        range_error_message="Please specify an address in your request",
    )
    use_fake(monkeypatch, fake)
    with pytest.raises(RuntimeError, match="authorization/permission"):
        feed.get_logs("bsc", 2, 3, feed.cl.sub_topics([WALLET])[0])
    assert fake.range_errors == 1

def test_evm_rpc_does_not_retry_permission_failures(monkeypatch):
    calls = []

    def forbidden(*args, **kwargs):
        calls.append(args[1]["method"])
        raise OSError("HTTP Error 403: Forbidden")

    monkeypatch.setattr(feed, "rpc_urls", lambda chain: ["https://single-rpc.invalid"])
    monkeypatch.setattr(config, "http_json", forbidden)

    with pytest.raises(RuntimeError, match="authorization/permission"):
        feed.evm_rpc("base", "eth_getTransactionReceipt", [TX])

    assert calls == ["eth_getTransactionReceipt"]

def test_evm_rpc_does_not_retry_rate_limited_provider(monkeypatch):
    calls = []

    def limited(*args, **kwargs):
        calls.append(args[1]["method"])
        raise OSError("HTTP 429: quota exceeded")

    monkeypatch.setattr(feed, "rpc_urls", lambda chain: ["https://single-rpc.invalid"])
    monkeypatch.setattr(config, "http_json", limited)

    with pytest.raises(RuntimeError, match="capacity/rate limit"):
        feed.evm_rpc("base", "eth_getTransactionReceipt", [TX])

    assert calls == ["eth_getTransactionReceipt"]


def test_bsc_fetches_transfer_directions_concurrently(monkeypatch, trades):
    fake = FakeEvm(latest=10)
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("BSC_RPC_URL", "https://bsc-rpc.publicnode.com")
    barrier = threading.Barrier(2)
    original = config.http_json

    def rendezvous(url, payload=None, timeout=20, headers=None):
        if payload and payload.get("method") == "eth_getLogs":
            barrier.wait(timeout=2)
        return original(url, payload=payload, timeout=timeout, headers=headers)

    monkeypatch.setattr(config, "http_json", rendezvous)
    feed.backfill("bsc", [WALLET], {}, {"conf": 1, "span": 1})
    assert fake.getlogs_calls == [("bsc", 10, 10)] * 2


def test_disabled_logs_chain_uses_full_block_without_getlogs(monkeypatch, trades):
    fake = FakeEvm(latest=10)
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("EVM_LOGS_DISABLED_CHAINS", "bsc")
    st = {"evm": {"bsc": {"last_block": 1, "last_tx_block": 9}}}
    feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 4})
    assert fake.getlogs_calls == []
    assert fake.block_calls == [10]
    assert st["evm"]["bsc"]["last_block"] == 10
    assert st["evm"]["bsc"]["last_tx_block"] == 10


def test_disabled_tx_scan_chain_advances_without_block_calls(monkeypatch):
    fake = FakeEvm(latest=10)
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("EVM_TX_SCAN_DISABLED_CHAINS", "robinhood")
    st = {"evm": {"robinhood": {"last_block": 9, "last_tx_block": 5}}}
    feed.backfill("robinhood", [WALLET], st, {"conf": 1, "span": 4})
    assert fake.block_calls == []
    assert st["evm"]["robinhood"]["last_tx_block"] == 10


def test_poll_feed_bounds_backfill_for_each_chain(monkeypatch, trades):
    fake = FakeEvm(
        latest=100,
        max_span=1,
        range_error_message="block range exceeds limit",
    )
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("BSC_RPC_URL", "https://bsc-rpc.publicnode.com")
    chains = ("base", "bsc", "robinhood")
    st = {"evm": {chain: {"last_block": 1} for chain in chains}}
    per = {chain: [WALLET] for chain in chains}

    feed.run_poll_feed(
        per,
        st,
        {"conf": 1, "span": 20, "max_chunks": 2, "sleep": 0, "once": True},
    )

    for chain in chains:
        assert st["evm"][chain]["last_block"] == 3
        successful = {
            start
            for name, start, end in fake.getlogs_calls
            if name == chain and start == end
        }
        assert successful == {2, 3}


def test_backfill_parses_1rpc_block_range_cap(monkeypatch, trades):
    """1rpc: 'limited to 0 - 50 blocks range' phải lưu cap, không halve mù."""
    fake = FakeEvm(
        latest=1000,
        logs=[],
        max_span=50,
        range_error_message="eth_getLogs is limited to 0 - 50 blocks range",
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 1}}}
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 500})
    base = st["evm"]["base"]
    endpoint_key = feed.rpc.endpoint_key(feed.rpc_url("base"))
    assert base["chunk_span"] == 50
    assert base["chunk_caps"] == {endpoint_key: 50}
    assert base["last_block"] == 1000


def test_backfill_tx_scan_limit_from_env(monkeypatch, trades):
    monkeypatch.setenv("EVM_LOGS_DISABLED_CHAINS", "bsc")
    monkeypatch.setenv("EVM_MAX_TX_BLOCKS", "16")
    monkeypatch.delenv("BSC_TRACE_INDEX_RPC_URL", raising=False)
    fake = FakeEvm(latest=100, logs=[])
    use_fake(monkeypatch, fake)
    st = {"evm": {"bsc": {"last_block": 100, "last_tx_block": 0}}}
    feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 4})
    assert st["evm"]["bsc"]["last_tx_block"] == 16
    assert fake.block_calls == list(range(1, 17))


def test_backfill_tx_scan_limit_per_chain_overrides_global(monkeypatch, trades):
    monkeypatch.setenv("EVM_MAX_TX_BLOCKS", "16")
    monkeypatch.setenv("EVM_MAX_TX_BLOCKS_BASE", "4")
    fake = FakeEvm(latest=100, logs=[])
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 100, "last_tx_block": 0}}}
    feed.backfill("base", [WALLET], st, {"conf": 1, "span": 4})
    assert st["evm"]["base"]["last_tx_block"] == 4
    assert fake.block_calls == [1, 2, 3, 4]


def test_backfill_tx_scan_limit_defaults_to_four(monkeypatch, trades):
    monkeypatch.setenv("EVM_LOGS_DISABLED_CHAINS", "bsc")
    monkeypatch.delenv("EVM_MAX_TX_BLOCKS", raising=False)
    monkeypatch.delenv("BSC_TRACE_INDEX_RPC_URL", raising=False)
    fake = FakeEvm(latest=100, logs=[])
    use_fake(monkeypatch, fake)
    st = {"evm": {"bsc": {"last_block": 100, "last_tx_block": 0}}}
    feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 4})
    assert st["evm"]["bsc"]["last_tx_block"] == 4
    assert fake.block_calls == [1, 2, 3, 4]


def test_reconcile_delay_keeps_tx_scan_continuous(monkeypatch):
    monkeypatch.setenv("EVM_LOGS_DISABLED_CHAINS", "bsc")
    monkeypatch.setenv("EVM_TX_SCAN_DISABLED_CHAINS", "robinhood")
    assert feed._reconcile_delay("bsc", True, {}) == 0.5
    assert feed._reconcile_delay("bsc", False, {}) == 0.5
    assert feed._reconcile_delay("base", True, {}) == 30.0
    assert feed._reconcile_delay("base", False, {}) == 0.5


def test_trace_rpc_disabled_never_hits_network(monkeypatch):
    monkeypatch.setenv("EVM_TRACE_DISABLED_CHAINS", "base")
    monkeypatch.setattr(
        feed.rpc, "call", lambda *args, **kwargs: pytest.fail("unexpected trace RPC")
    )
    with pytest.raises(feed.TraceMethodUnavailable):
        feed.trace_rpc("base", "debug_traceTransaction", ["0x"])
    assert feed.trace_filter_candidates("base", 1, 2, {WALLET}) == {}


def test_trace_disabled_defers_pending_without_archiving(monkeypatch, tmp_path):
    monkeypatch.setenv("EVM_TRACE_DISABLED_CHAINS", "base")
    store = Journal(str(tmp_path / "trace-defer.sqlite"))
    feed.configure_journal(store)
    try:
        store.enqueue_candidate("base", TX, 10, "hash")

        def unavailable(*args, **kwargs):
            raise feed.RpcFeedError("trace unavailable", "trace", 0)

        monkeypatch.setattr(feed, "process_tx", unavailable)
        feed._drain_candidates("base", {WALLET}, confirmed_through=20)
        now = time.time()
        assert store.pending_candidates("base", now=now) == []
        due = store.pending_candidates("base", now=now + 3700)
        assert [item["tx"] for item in due] == [TX]
        assert due[0]["attempts"] == 0

        # Trace provider available again: candidate vẫn còn pending và xử lý được.
        monkeypatch.delenv("EVM_TRACE_DISABLED_CHAINS")
        store.defer_candidate(
            "base", TX, 10, "hash", 0, increment_attempts=False
        )
        monkeypatch.setattr(feed, "process_tx", lambda *args, **kwargs: [])
        feed._drain_candidates("base", {WALLET}, confirmed_through=20)
        assert store.pending_candidates("base", now=time.time() + 1) == []
    finally:
        feed.configure_journal(None)
        store.close()


def test_backfill_cold_start_at_tip(monkeypatch, trades):
    fake = FakeEvm(latest=1000, logs=[])
    use_fake(monkeypatch, fake)
    st: dict[str, Any] = {}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert st["evm"]["base"]["last_block"] == 993
    assert fake.getlogs_calls == [("base", 993, 993)] * 2  # đúng tip, 2 sub filter


def test_unknown_router_pair_detected_and_reverted_tx_skipped(monkeypatch, trades):
    receipts = {TX: swap_receipt(to="0x8888888888888888888888888888888888888888")}
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 10**6, block=991)],
        receipts=receipts,
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 990}}}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert len(trades) == 1
    assert trades[0]["side"] == "buy" and trades[0]["ca"] == TOKEN
    assert fake.transaction_calls == []  # ERC-20 endpoints need receipt only
    feed._seen_tx.clear()
    receipts[TX] = dict(swap_receipt(), status="0x0")
    st = {"evm": {"base": {"last_block": 990}}}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert len(trades) == 1


def test_token_to_token_watch_emits_both_wallet_endpoints(monkeypatch, trades):
    tx_hash = "0x" + "cd" * 32
    receipt = {
        "status": "0x1",
        "to": "0x8888888888888888888888888888888888888888",
        "logs": [
            raw_log(WALLET, POOL, 5000 * 10**6, ca=TOKEN, tx=tx_hash, idx=1),
            raw_log(POOL, WALLET, 3 * 10**18, ca="0x5555555555555555555555555555555555555555", tx=tx_hash, idx=2),
        ],
    }
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 5000 * 10**6, ca=TOKEN, tx=tx_hash, block=991)],
        receipts={tx_hash: receipt},
    )
    use_fake(monkeypatch, fake)
    feed.backfill(
        "base",
        [WALLET],
        {"evm": {"base": {"last_block": 990}}},
        {"conf": 8, "span": 500},
    )

    assert [(trade["side"], trade["ca"], trade["tx"]) for trade in trades] == [
        ("sell", TOKEN, tx_hash),
        ("buy", "0x5555555555555555555555555555555555555555", tx_hash),
    ]
    assert fake.transaction_calls == []


def test_unavailable_decimals_does_not_advance_cursor(monkeypatch, trades):
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 10**6, block=991)],
        receipts={TX: swap_receipt()},
        decimals=37,
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 990}}}

    with pytest.raises(RuntimeError, match="out-of-range decimals"):
        feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert st["evm"]["base"]["last_block"] == 990
    assert trades == []



def test_receipt_failure_keeps_cursor_and_retries_same_tx(monkeypatch, trades):
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 10**6, block=991)],
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 990}}}

    with pytest.raises(RuntimeError, match="missing transaction receipt"):
        feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert st["evm"]["base"]["last_block"] == 990
    assert ("base", TX.lower()) not in feed._seen_tx

    fake.receipts[TX] = swap_receipt()
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert len(trades) == 1 and trades[0]["ca"] == TOKEN
    assert st["evm"]["base"]["last_block"] == 993

def test_bsc_pancake_sell(monkeypatch, trades):
    receipt = {
        "status": "0x1",
        "to": PANCAKE,
        "logs": [
            raw_log(WALLET, POOL, 1000 * 10**6, ca=TOKEN, idx=1),  # gửi token
            raw_log(POOL, WALLET, 5 * 10**17, ca=WBNB, idx=2),  # nhận WBNB
        ],
    }
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 1000 * 10**6, block=999)],
        receipts={TX: receipt},
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"bsc": {"last_block": 998}}}
    feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 500})
    assert len(trades) == 1
    assert trades[0]["chain"] == "bsc" and trades[0]["side"] == "sell"
    assert trades[0]["ca"] == TOKEN
    assert st["evm"]["bsc"]["last_block"] == 1000


# ---------- emit ----------


def test_emit_swap_min_usd_gate(monkeypatch, trades):
    ev = {
        "wallet": WALLET,
        "chain": "base",
        "ca": TOKEN,
        "tx": TX,
        "side": "BUY",
        "qty": 1000.0,
        "router": "uniswap-v3",
    }
    monkeypatch.setattr(config, "min_usd", 2000.0)
    assert feed.emit_swap(dict(ev), BLOCK_TIME) is None and trades == []
    monkeypatch.setattr(config, "min_usd", 0.5)
    assert feed.emit_swap(dict(ev), BLOCK_TIME) is not None and len(trades) == 1


def test_emit_swap_no_price_failopen(monkeypatch, trades):
    # chưa định giá được (None) ⇒ VẪN emit, amountUsd 0 — không được tự bỏ trade thật
    monkeypatch.setattr(feed.price, "get_price_usd", lambda ca, chain="sol": None)
    ev = {
        "wallet": WALLET,
        "chain": "base",
        "ca": TOKEN,
        "tx": TX,
        "side": "BUY",
        "qty": 1000.0,
        "router": "uniswap-v3",
    }
    assert feed.emit_swap(ev, BLOCK_TIME) is not None
    assert trades[0]["amountUsd"] == 0.0 and trades[0]["price"] == 0.0


# ---------- poll feed ----------


def test_poll_once(monkeypatch, trades):
    fake = FakeEvm(
        latest=1000,
        logs=[raw_log(WALLET, POOL, 10**17, ca=WETH, block=990)],
        receipts={TX: swap_receipt()},
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 985}, "bsc": {"last_block": 985}}}
    feed.run_poll_feed(
        {"base": [WALLET], "bsc": []},
        st,
        {"conf": 8, "span": 500, "once": True, "sleep": 0},
    )
    assert len(trades) == 1 and trades[0]["chain"] == "base"
    assert st["evm"]["base"]["last_block"] == 993
    assert st["evm"]["bsc"]["last_block"] == 985  # chain không ví ⇒ không đụng


# ---------- main.load_wallets ----------


def test_load_wallets_api_filters_by_chain(monkeypatch, tmp_path):
    rows = [
        {"address": "0x" + "A1" * 20, "chain": "base"},
        {"address": "So11111111111111111111111111111111111111112", "chain": "sol"},
        {"address": "0x" + "b2" * 20, "chain": "bsc"},
        "junk",
        {"address": "", "chain": "base"},
        {"address": "0x" + "a1" * 20, "chain": "base"},  # trùng (case) ⇒ dedup
    ]
    monkeypatch.setattr(
        config, "http_json", lambda url, payload=None, timeout=20, headers=None: rows
    )
    per, src = emain.load_wallets(str(tmp_path / "nope.txt"))
    assert src == "api"
    assert per == {"base": ["0x" + "a1" * 20], "bsc": ["0x" + "b2" * 20]}


def test_load_wallets_api_excludes_explicit_exclusion_tag(monkeypatch, tmp_path):
    included = "0x" + "a1" * 20
    excluded = "0x" + "e1" * 20
    rows = [
        {"address": included, "chain": "base", "tags": ["status:UNVERIFIED", "WHALE"]},
        {"address": excluded, "chain": "base", "tags": ["status:EXCLUDE", "OWN_WALLET"]},
    ]
    monkeypatch.setattr(config, "http_json", lambda *a, **kw: rows)

    per, src = emain.load_wallets(str(tmp_path / "nope.txt"))

    assert src == "api"
    assert per == {"base": [included], "bsc": []}


def test_load_wallets_file_fallback(monkeypatch, tmp_path):
    def dead(url, payload=None, timeout=20, headers=None):
        raise OSError("api down")

    monkeypatch.setattr(config, "http_json", dead)
    p = tmp_path / "wallets.txt"
    p.write_text("# comment\n\n0x" + "11" * 20 + "\nSolAddrNotEvm\n0xshort\n")
    per, src = emain.load_wallets(str(p))
    assert src == "file"
    assert (
        per["base"] == per["bsc"] == ["0x" + "11" * 20]
    )  # chỉ dòng 0x42hex, cả 2 chain



def test_robinhood_rpc_defaults_and_explicit_wss(monkeypatch):
    assert feed.rpc_url("robinhood") == "https://rpc.mainnet.chain.robinhood.com"
    assert feed.wss_url("robinhood") is None
    monkeypatch.setenv("ROBINHOOD_RPC_URL", "https://rpc.example/rh")
    monkeypatch.setenv("ROBINHOOD_WSS_URL", "wss://rpc.example/rh")
    assert feed.rpc_url("robinhood") == "https://rpc.example/rh"
    assert feed.wss_url("robinhood") == "wss://rpc.example/rh"


def test_wss_disabled_forces_poll_for_all_chains(monkeypatch):
    monkeypatch.setenv("EVM_WSS_DISABLED_CHAINS", "base,bsc")
    for name in ("BASE_WSS_URL", "BSC_WSS_URL", "ROBINHOOD_WSS_URL"):
        monkeypatch.delenv(name, raising=False)
    assert feed.wss_urls("base") == []
    assert feed.wss_urls("bsc") == []
    per = {chain: [WALLET] for chain in ("base", "bsc", "robinhood")}
    ws_chains, poll_chains = feed.hybrid_feed_plan(per)
    assert ws_chains == {}
    assert set(poll_chains) == {"base", "bsc", "robinhood"}


def test_hybrid_feed_plan_uses_ws_and_polls_missing_chain(monkeypatch):
    for name in (
        "BASE_RPC_URL",
        "BSC_RPC_URL",
        "BASE_WSS_URL",
        "BSC_WSS_URL",
        "ROBINHOOD_WSS_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    per = {chain: [WALLET] for chain in ("base", "bsc", "robinhood")}

    ws_chains, poll_chains = feed.hybrid_feed_plan(per)
    assert set(ws_chains) == {"base", "bsc"}
    assert set(poll_chains) == {"robinhood"}

    monkeypatch.setenv("ROBINHOOD_WSS_URL", "wss://rpc.example/rh")
    ws_chains, poll_chains = feed.hybrid_feed_plan(per)
    assert set(ws_chains) == {"base", "bsc", "robinhood"}
    assert poll_chains == {}


def test_ws_subscription_keeps_logs_arriving_before_acks():
    log = {
        "topics": [feed.cl.TRANSFER_TOPIC],
        "transactionHash": TX,
        "logIndex": "0x1",
    }

    class FakeWs:
        def __init__(self):
            self.sent = []
            self.messages = [
                json.dumps({"params": {"result": log}}),
                json.dumps({"id": 2, "result": "sub-2"}),
                json.dumps({"id": 1, "result": "sub-1"}),
            ]

        async def send(self, message):
            self.sent.append(json.loads(message))

        async def recv(self):
            return self.messages.pop(0)

    ws = FakeWs()
    pending = asyncio.run(feed._subscribe_wallet_logs(ws, [WALLET]))
    assert len(ws.sent) == 2
    assert pending == {(TX, "0x1"): log}


def test_pre_ack_wss_log_is_journaled_before_session_processing(tmp_path):
    log = raw_log(WALLET, POOL, 1, block=995)
    store = Journal(str(tmp_path / "pre-ack.sqlite"))
    feed.configure_journal(store)
    try:
        asyncio.run(
            feed._persist_pending_logs(
                "base", {WALLET}, {(TX, log["logIndex"]): log}
            )
        )
        assert [item["tx"] for item in store.pending_candidates("base")] == [TX]
    finally:
        feed.configure_journal(None)
        store.close()
def test_ws_head_confirms_log_into_durable_candidate_without_block_poll(monkeypatch, tmp_path):
    log = raw_log(WALLET, POOL, 1, block=995)
    store = Journal(str(tmp_path / "ws-journal.sqlite"))
    feed.configure_journal(store)
    try:
        monkeypatch.setattr(
            feed, "block_number", lambda chain: pytest.fail("unexpected block poll")
        )
        monkeypatch.setattr(feed, "_drain_candidates", lambda *args: [])

        class FakeWs:
            async def recv(self):
                return json.dumps({"params": {"result": log}})

        pending = asyncio.run(
            feed._consume_ws_logs(
                FakeWs(),
                "base",
                {WALLET},
                {"conf": 6},
                {},
                {},
                {"height": 1000, "head_updates": True},
            )
        )
        assert pending == {}
        assert [item["tx"] for item in store.pending_candidates("base")] == [TX]
    finally:
        feed.configure_journal(None)
        store.close()


def test_ws_processing_error_keeps_uncommitted_log(monkeypatch):
    log = {
        "topics": [feed.cl.TRANSFER_TOPIC],
        "transactionHash": TX,
        "logIndex": "0x1",
        "blockNumber": "0x3e7",
    }

    class FakeWs:
        async def recv(self):
            return json.dumps({"params": {"result": log}})

    monkeypatch.setattr(feed, "block_number", lambda chain: 1000)

    def fail(*args):
        raise RuntimeError("receipt unavailable")

    monkeypatch.setattr(feed, "process_log", fail)
    pending = {}
    with pytest.raises(RuntimeError, match="receipt unavailable"):
        asyncio.run(
            feed._consume_ws_logs(FakeWs(), "base", {WALLET}, {"conf": 1}, pending)
        )
    assert pending == {(TX, "0x1"): log}



def test_eth_rpc_defaults_and_confirmation_override(monkeypatch, trades):
    assert feed.rpc_url("eth") == "https://ethereum-rpc.publicnode.com"
    monkeypatch.setenv("ETH_RPC_URL", "https://rpc.example/eth")
    assert feed.rpc_url("eth") == "https://rpc.example/eth"
    monkeypatch.setenv("EVM_CONFIRMATIONS_ETH", "4")
    assert feed._chain_confirmations("eth", {"conf": 8}) == 4
    assert feed._chain_confirmations("base", {"conf": 8}) == 8

    fake = FakeEvm(latest=100, logs=[])
    use_fake(monkeypatch, fake)
    st = {"evm": {"eth": {"last_block": 50}}}
    feed.backfill("eth", [WALLET], st, {"conf": 8, "span": 4})
    assert st["evm"]["eth"]["last_block"] == 97


def test_eth_wss_disabled_keeps_eth_on_poll(monkeypatch):
    monkeypatch.setenv("EVM_WSS_DISABLED_CHAINS", "base,bsc,eth")
    assert feed.wss_urls("eth") == []
    ws_chains, poll_chains = feed.hybrid_feed_plan({"eth": [WALLET]})
    assert ws_chains == {}
    assert poll_chains == {"eth": [WALLET]}


def test_rpc_permanent_range_error_fails_over_to_next_endpoint(monkeypatch):
    primary = "https://rpc.primary"
    secondary = "https://rpc.secondary"
    monkeypatch.setenv("BASE_RPC_URL", f"{primary},{secondary}")
    calls = []

    def fake(url, payload=None, timeout=20, headers=None):
        calls.append(url)
        if url == primary:
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"code": -32602, "message": "exceed maximum block range: 500"},
            }
        return {"jsonrpc": "2.0", "id": 1, "result": []}

    monkeypatch.setattr(config, "http_json", fake)
    assert feed.get_logs("base", 10, 10, []) == []
    assert calls == [primary, secondary]


def test_bsc_publicnode_http_default_and_override(monkeypatch):
    assert feed.rpc_url("bsc") == "https://bsc-rpc.publicnode.com"
    monkeypatch.setenv("BSC_RPC_URL", "https://rpc.example/bsc")
    assert feed.rpc_url("bsc") == "https://rpc.example/bsc"
    fake = FakeEvm()
    use_fake(monkeypatch, fake)
    feed.get_logs("bsc", 10, 10, [])
    assert fake.getlogs_calls == [("bsc", 10, 10)]


def test_rpc_quota_failure_fails_over_without_retrying_same_endpoint(monkeypatch):
    primary = "https://rpc.primary"
    secondary = "https://rpc.secondary"
    monkeypatch.setenv("BASE_RPC_URL", f"{primary},{secondary}")
    calls = []

    def rpc(url, payload=None, timeout=20, headers=None):
        calls.append(url)
        if url == primary:
            return {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"message": "Monthly capacity limit exceeded"},
            }
        return {"jsonrpc": "2.0", "id": 1, "result": "0x2"}

    monkeypatch.setattr(config, "http_json", rpc)
    assert feed.evm_rpc("base", "eth_blockNumber", []) == "0x2"
    assert calls == [primary, secondary]



def test_selected_robinhood_wallet_refresh(monkeypatch):
    rows = [{"address": "0x" + "c3" * 20, "chain": "robinhood"},
            {"address": "0x" + "b2" * 20, "chain": "bsc"}]
    monkeypatch.setattr(config, "http_json", lambda *a, **kw: rows)
    per, src = emain.load_wallets("/no-file", ("robinhood",))
    assert src == "api" and per == {"robinhood": ["0x" + "c3" * 20]}



def test_native_input_and_output_require_router_erc20_receipt(monkeypatch, trades):
    tx_sell = "0x" + "cd" * 32
    incoming = raw_log(POOL, WALLET, 500 * 10**6, ca=TOKEN, idx=2)
    outgoing = raw_log(WALLET, POOL, 200 * 10**6, ca=TOKEN, tx=tx_sell)
    router = "0x8876789976decbfcbbbe364623c63652db8c0904"
    fake = FakeEvm(
        logs=[incoming, outgoing],
        receipts={
            TX: {"status": "0x1", "to": router, "logs": [incoming]},
            tx_sell: {
                "status": "0x1", "to": router,
                "logs": [outgoing],
            },
        },
        transactions={
            TX: {"from": WALLET, "value": hex(10**18)},
            tx_sell: {"from": WALLET, "value": "0x0"},
        },
        traces={
            TX: {
                "type": "CALL",
                "from": WALLET,
                "to": router,
                "value": hex(10**18),
                "calls": [],
            },
            tx_sell: {
                "type": "CALL",
                "from": WALLET,
                "to": router,
                "value": "0x0",
                "calls": [
                    {
                        "type": "CALL",
                        "from": router,
                        "to": WALLET,
                        "value": hex(2 * 10**18),
                        "input": "0x",
                    }
                ],
            },
        },
    )
    use_fake(monkeypatch, fake)
    feed.process_log("robinhood", incoming, {WALLET})
    feed.process_log("robinhood", outgoing, {WALLET})
    assert [trade["side"] for trade in trades] == ["buy", "sell"]
    assert all(trade["chain"] == "robinhood" for trade in trades)
    assert [trade["amountUsd"] for trade in trades] == pytest.approx([500, 200])
    assert fake.transaction_calls == [TX, tx_sell]
    assert fake.trace_calls == [TX, tx_sell]
def test_process_tx_nets_native_refund_before_emitting_quote_raw(monkeypatch):
    tx_hash = "0x" + "fd" * 32
    router = "0x8876789976decbfcbbbe364623c63652db8c0904"
    token_output = raw_log(POOL, WALLET, 1000 * 10**6, tx=tx_hash)
    trace = {
        "type": "CALL",
        "from": WALLET,
        "to": router,
        "value": hex(10**18),
        "calls": [
            {
                "type": "CALL",
                "from": router,
                "to": WALLET,
                "value": hex(10**17),
                "input": "0x",
            }
        ],
    }
    fake = FakeEvm(
        receipts={tx_hash: {"status": "0x1", "to": router, "logs": [token_output]}},
        transactions={tx_hash: {"from": WALLET, "to": router, "value": hex(10**18)}},
        traces={tx_hash: trace},
    )
    use_fake(monkeypatch, fake)
    events = []
    monkeypatch.setattr(feed, "emit_swap", lambda event, ts: events.append(dict(event)) or event)

    feed.process_log("robinhood", token_output, {WALLET})

    assert len(events) == 1
    assert events[0]["quote_raw"] == 9 * 10**17
    assert events[0]["qty_raw"] == 1000 * 10**6
    assert fake.trace_calls == [tx_hash]


def test_router_native_output_uses_call_trace(monkeypatch, trades):
    tx_sell = "0x" + "ef" * 32
    router = "0x8876789976decbfcbbbe364623c63652db8c0904"
    trace = {
        "type": "CALL",
        "from": WALLET,
        "to": router,
        "value": "0x0",
        "calls": [
            {
                "type": "CALL",
                "from": router,
                "to": WALLET,
                "value": hex(2 * 10**18),
                "input": "0x",
            }
        ],
    }
    fake = FakeEvm(
        receipts={
            tx_sell: {
                "status": "0x1",
                "to": router,
                "logs": [raw_log(WALLET, POOL, 200 * 10**6, tx=tx_sell)],
            }
        },
        transactions={tx_sell: {"from": WALLET, "value": "0x0"}},
        traces={tx_sell: trace},
    )
    use_fake(monkeypatch, fake)

    feed.process_log(
        "robinhood",
        raw_log(WALLET, POOL, 200 * 10**6, tx=tx_sell),
        {WALLET},
    )

    assert len(trades) == 1
    assert trades[0]["side"] == "sell" and trades[0]["ca"] == TOKEN
    assert trades[0]["amountUsd"] == pytest.approx(200)
    assert fake.trace_calls == [tx_sell]


def test_block_scan_discovers_tracked_sender_without_transfer_log(monkeypatch, trades):
    tx_hash = "0x" + "fa" * 32
    router = UNISWAP

    def word(value):
        return f"{value:064x}"

    trace = {
        "type": "CALL",
        "from": WALLET,
        "to": router,
        "value": "0x0",
        "calls": [
            {
                "type": "CALL",
                "from": router,
                "to": WETH,
                "input": "0x23b872dd"
                + word(int(WALLET, 16))
                + word(int(POOL, 16))
                + word(5 * 10**17),
                "value": "0x0",
            },
            {
                "type": "CALL",
                "from": POOL,
                "to": TOKEN,
                "input": "0xa9059cbb"
                + word(int(WALLET, 16))
                + word(1000 * 10**6),
                "value": "0x0",
            },
        ],
    }
    tx = {
        "hash": tx_hash,
        "from": WALLET,
        "to": router,
        "value": "0x0",
    }
    fake = FakeEvm(
        latest=1000,
        receipts={tx_hash: {"status": "0x1", "to": router, "logs": []}},
        traces={tx_hash: trace},
        blocks={993: {"transactions": [tx]}},
    )
    use_fake(monkeypatch, fake)
    state = {"evm": {"base": {"last_block": 992}}}

    feed.backfill("base", [WALLET], state, {"conf": 8, "span": 500})

    assert [(trade["side"], trade["ca"], trade["tx"]) for trade in trades] == [
        ("buy", TOKEN, tx_hash),
    ]
    assert fake.block_calls == [992, 993]
    assert fake.transaction_calls == []
    assert fake.trace_calls == [tx_hash]


def test_trace_filter_finds_internal_wallet_call_without_wallet_transfer(monkeypatch, trades):
    tx_hash = "0x" + "fc" * 32
    router = UNISWAP

    def word(value):
        return f"{value:064x}"

    trace = {
        "type": "CALL",
        "from": POOL,
        "to": "0x6666666666666666666666666666666666666666",
        "value": "0x0",
        "calls": [
            {
                "type": "CALL",
                "from": "0x6666666666666666666666666666666666666666",
                "to": WALLET,
                "value": "0x0",
                "calls": [
                    {
                        "type": "CALL",
                        "from": WALLET,
                        "to": router,
                        "value": "0x0",
                        "calls": [
                            {
                                "type": "CALL",
                                "from": router,
                                "to": WETH,
                                "input": "0x23b872dd"
                                + word(int(WALLET, 16))
                                + word(int(POOL, 16))
                                + word(5 * 10**17),
                                "value": "0x0",
                            },
                            {
                                "type": "CALL",
                                "from": POOL,
                                "to": TOKEN,
                                "input": "0xa9059cbb"
                                + word(int(WALLET, 16))
                                + word(1000 * 10**6),
                                "value": "0x0",
                            },
                        ],
                    }
                ],
            }
        ],
    }
    tx = {
        "hash": tx_hash,
        "from": POOL,
        "to": "0x6666666666666666666666666666666666666666",
        "value": "0x0",
    }
    fake = FakeEvm(
        latest=1008,
        receipts={tx_hash: {"status": "0x1", "to": tx["to"], "logs": []}},
        traces={tx_hash: trace},
        blocks={993: {"transactions": [tx]}},
        trace_filters={
            "from": [
                {
                    "transactionHash": tx_hash,
                    "action": {"from": WALLET, "to": router},
                }
            ]
        },
    )
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("BASE_TRACE_INDEX_RPC_URL", "https://trace-index.test")
    state = {"evm": {"base": {"last_block": 992}}}

    feed.backfill("base", [WALLET], state, {"conf": 8, "span": 500})

    assert [(trade["side"], trade["ca"], trade["tx"]) for trade in trades] == [
        ("buy", TOKEN, tx_hash),
    ]
    assert len(fake.trace_filter_calls) == 2
    assert fake.block_calls == [992, 993, 994, 995]
    assert fake.trace_calls == [tx_hash]


def test_unavailable_trace_does_not_advance_block_cursor(monkeypatch, trades):
    tx_hash = "0x" + "fb" * 32
    tx = {"hash": tx_hash, "from": WALLET, "to": UNISWAP, "value": "0x0"}
    fake = FakeEvm(
        latest=1000,
        receipts={tx_hash: {"status": "0x1", "to": UNISWAP, "logs": []}},
        blocks={993: {"transactions": [tx]}},
    )
    use_fake(monkeypatch, fake)
    state = {"evm": {"base": {"last_block": 992}}}

    with pytest.raises(RuntimeError, match="trace"):
        feed.backfill("base", [WALLET], state, {"conf": 8, "span": 500})

    assert state["evm"]["base"]["last_block"] == 993
    assert state["evm"]["base"]["last_tx_block"] == 992


def test_refresh_cfg_failsoft(monkeypatch):
    per = {"base": ["0xold"], "bsc": []}

    def dead(url, payload=None, timeout=20, headers=None):
        raise OSError("api down")

    monkeypatch.setattr(config, "http_json", dead)
    monkeypatch.setattr(emain, "_wallets_path", "/nonexistent/wallets.txt")
    emain.refresh_cfg(per)  # không raise
    assert per == {"base": ["0xold"], "bsc": []}  # API chết ⇒ giữ nguyên ví




def test_main_once_migrates_journal_and_stops_delivery_worker(monkeypatch, tmp_path):
    for obj, name in (
        (config, "_api_url"),
        (config, "_track"),
        (config, "_cfg_cli_min_usd"),
        (config, "_evm_ignore_api_min_usd"),
        (config, "min_usd"),
        (feed.emit, "_jsonl"),
        (st_mod, "STATE_PATH"),
        (st_mod, "HEARTBEAT"),
        (emain, "HERE"),
        (emain, "_wallets_path"),
    ):
        monkeypatch.setattr(obj, name, getattr(obj, name, None), raising=False)
    monkeypatch.setattr(emain, "HERE", str(tmp_path))
    state_path = tmp_path / "evm_watch_state.json"
    state_path.write_text(
        json.dumps(
            {
                "evm": {
                    "base": {
                        "last_block": 10,
                        "last_tx_block": 8,
                        "chunk_rpc": "https://secret.example/token",
                    }
                }
            }
        )
    )
    fake = FakeEvm(latest=1000, logs=[])

    def request(url, payload=None, timeout=20, headers=None):
        if url.endswith("/api/wallets"):
            return [{"address": WALLET, "chain": "base"}]
        return fake(url, payload, timeout, headers)

    monkeypatch.setenv("BASE_RPC_URL", "https://mainnet.base.org")
    monkeypatch.setattr(config, "http_json", request)
    monkeypatch.setattr(sys, "argv", [
        "watcher",
        "--chains",
        "base",
        "--feed",
        "poll",
        "--once",
        "--no-min-usd-gate",
        "--api-url",
        "http://api.test",
    ])

    emain.main()
    assert feed._journal is None
    assert fake.getlogs_calls
    assert fake.block_calls == [9, 10, 11, 12]
    assert feed._journal is None
    store = Journal(str(tmp_path / "evm_watch_journal.sqlite3"))
    try:
        assert store.state("base")["last_block"] == 993
        assert store.state("base")["last_tx_block"] == 12
        assert "secret" not in (tmp_path / "evm_watch_journal.sqlite3").read_bytes().decode(
            "latin1", errors="ignore"
        )
    finally:
        store.close()

def test_new_head_rewinds_unconfirmed_fork_and_pending_trade(monkeypatch, tmp_path):
    store = Journal(str(tmp_path / "head-journal.sqlite"))
    feed.configure_journal(store)
    try:
        store.save_state({"evm": {"base": {"last_block": 102, "last_tx_block": 102}}})
        for height in range(100, 103):
            store.record_header(
                "base",
                {
                    "number": hex(height),
                    "hash": f"canonical-{height}",
                    "parentHash": f"canonical-{height - 1}",
                },
            )
        store.enqueue(
            {
                "chain": "base",
                "wallet": WALLET,
                "ca": TOKEN,
                "tx": TX,
                "side": "BUY",
            },
            102,
            "canonical-102",
        )
        rpc_calls = []

        def canonical_header(chain, method, params):
            rpc_calls.append((chain, method, params))
            if params[0] == "0x65":
                return {"hash": "canonical-101"}
            if params[0] == "0x67":
                return {"hash": "fork-103"}
            raise AssertionError((chain, method, params))

        monkeypatch.setattr(feed, "evm_rpc", canonical_header)
        state = {"evm": {"base": {"last_block": 102, "last_tx_block": 102}}}
        asyncio.run(
            feed._handle_new_head(
                "base",
                {"number": "0x67", "hash": "fork-103", "parentHash": "fork-102"},
                state,
                {},
            )
        )
        assert state["evm"]["base"]["last_block"] == 101
        assert store.due(now=0) == []
        assert store.headers("base")[-1]["hash"] == "fork-103"
        assert rpc_calls == [
            ("base", "eth_getBlockByNumber", ["0x65", False])
        ]
        rpc_calls.clear()
        asyncio.run(
            feed._handle_new_head(
                "base",
                {"number": "0x69", "hash": "fork-105", "parentHash": "fork-104"},
                state,
                {},
            )
        )
        assert rpc_calls == [
            ("base", "eth_getBlockByNumber", ["0x67", False])
        ]
        assert store.headers("base")[-1]["hash"] == "fork-105"
    finally:
        feed.configure_journal(None)
        store.close()

def test_price_pairs_matches_evm_address_case_insensitively():
    from watchers.common import price as price_mod

    checksummed = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"
    from_log = checksummed.lower()
    pairs = [
        {
            "baseToken": {"address": checksummed, "symbol": "DEGEN"},
            "quoteToken": {
                "address": "0x4200000000000000000000000000000000000006",
                "symbol": "WETH",
            },
            "priceUsd": "0.0011",
            "priceNative": "0.0000004",
        }
    ]
    assert price_mod._price_from_pairs(pairs, from_log) == ("DEGEN", 0.0011)


def test_wss_handshake_failures_use_increasing_backoff(monkeypatch):
    backoffs = []
    endpoint = "wss://provider.invalid"

    async def fail_session(*args):
        raise OSError("HTTP 429 quota exceeded")

    async def stop_after_second_failure(
        chain, wallets, st, opts, failed_endpoint, exc, backoff
    ):
        backoffs.append(backoff)
        if len(backoffs) == 2:
            raise asyncio.CancelledError
        return backoff * 2

    monkeypatch.setattr(feed, "wss_urls", lambda chain: [endpoint])
    monkeypatch.setattr(feed, "wss_url", lambda chain: endpoint)
    monkeypatch.setattr(feed.rpc, "ready_urls", lambda urls, method: [endpoint])
    monkeypatch.setattr(feed, "_run_ws_session", fail_session)
    monkeypatch.setattr(feed, "_recover_ws_disconnect", stop_after_second_failure)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(feed._ws_chain_loop("base", [WALLET], {}, {}, {}, None))

    assert backoffs == [2, 4]
