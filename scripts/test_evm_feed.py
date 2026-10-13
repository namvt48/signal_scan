"""Tests offline cho watchers/evm/feed.py + main.load_wallets — T8/D7.
KHÔNG mạng thật: mọi JSON-RPC đi qua FakeEvm monkeypatch vào seam
`config.http_json`. Chạy: python3 -m pytest scripts/test_evm_feed.py -q
"""

import json
import os
import threading
from typing import Any

import pytest

from watchers.common import config
from watchers.common import state as st_mod
from watchers.evm import feed
from watchers.evm import main as emain

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
        range_error_message="exceed maximum block range",
    ):
        self.latest = latest
        self.logs = logs or []
        self.receipts = receipts or {}
        self.transactions = transactions or {}
        self.max_span = max_span
        self.range_error_message = range_error_message
        self.decimals = decimals
        self.block_time = block_time
        self.getlogs_calls: list[tuple[str, int, int]] = []
        self.receipt_calls: list[str] = []
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
        m, p = payload["method"], payload["params"]
        if m == "eth_blockNumber":
            r = hex(self.latest)
        elif m == "eth_getLogs":
            q = p[0]
            a, b = int(q["fromBlock"], 16), int(q["toBlock"], 16)
            self.getlogs_calls.append((chain, a, b))
            if self.max_span and b - a + 1 > self.max_span:
                self.range_errors += 1
                return {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": {"code": -32000, "message": self.range_error_message},
                }
            r = [l for l in self.logs if a <= int(l["blockNumber"], 16) <= b]
        elif m == "eth_getTransactionReceipt":
            self.receipt_calls.append(p[0])
            r = self.receipts.get(p[0])
        elif m == "eth_getTransactionByHash":
            r = self.transactions.get(p[0])
        elif m == "eth_getBlockByNumber":
            r = {"timestamp": hex(self.block_time)}
        elif m == "eth_call":  # decimals()
            r = hex(self.decimals)
        else:
            r = None
        return {"jsonrpc": "2.0", "id": 1, "result": r}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Cache module sạch + state/heartbeat trỏ tmp + sleep/price stub (offline)."""
    feed._seen_tx.clear()
    feed._decimals.clear()
    feed._block_ts.clear()
    feed._tracked.clear()
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
    assert calls == [primary] * 3 + [secondary]




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
    assert calls == ["https://alchemy.example/base"] * 3 + [feed.DEFAULT_RPC["base"]]


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

def test_backfill_halves_when_provider_requires_contract_address(monkeypatch, trades):
    fake = FakeEvm(
        latest=20,
        max_span=1,
        range_error_message="Please specify an address in your request",
    )
    use_fake(monkeypatch, fake)
    monkeypatch.setenv("BSC_RPC_URL", "https://bsc-rpc.publicnode.com")
    st = {"evm": {"bsc": {"last_block": 1}}}
    feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 4})
    assert st["evm"]["bsc"]["last_block"] == 20
    assert fake.range_errors == 4  # both topics rejected across two halved ranges
    successful = [(a, b) for chain, a, b in fake.getlogs_calls if chain == "bsc" and a == b]
    assert successful == [(block, block) for block in range(2, 21) for _ in range(2)]
    first_range_errors = fake.range_errors
    fake.latest = 22
    feed.backfill("bsc", [WALLET], st, {"conf": 1, "span": 4})
    assert st["evm"]["bsc"]["last_block"] == 22
    assert fake.range_errors == first_range_errors


def test_address_required_logs_error_skips_retries(monkeypatch):
    fake = FakeEvm(
        latest=20,
        max_span=1,
        range_error_message="Please specify an address in your request",
    )
    use_fake(monkeypatch, fake)
    with pytest.raises(RuntimeError, match="Please specify an address"):
        feed.get_logs("bsc", 2, 3, feed.cl.sub_topics([WALLET])[0])
    assert fake.range_errors == 1


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


def test_poll_feed_bounds_backfill_for_each_chain(monkeypatch, trades):
    fake = FakeEvm(
        latest=100,
        max_span=1,
        range_error_message="Please specify an address in your request",
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


def test_backfill_cold_start_at_tip(monkeypatch, trades):
    fake = FakeEvm(latest=1000, logs=[])
    use_fake(monkeypatch, fake)
    st: dict[str, Any] = {}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert st["evm"]["base"]["last_block"] == 993
    assert fake.getlogs_calls == [("base", 993, 993)] * 2  # đúng tip, 2 sub filter


def test_non_router_and_reverted_tx_skipped(monkeypatch, trades):
    receipts = {
        TX: {
            "status": "0x1",
            "to": "0x8888888888888888888888888888888888888888",
            "logs": swap_receipt()["logs"],
        },  # không phải router allowlist
    }
    fake = FakeEvm(
        latest=1000, logs=[raw_log(WALLET, POOL, 10**6, block=995)], receipts=receipts
    )
    use_fake(monkeypatch, fake)
    st = {"evm": {"base": {"last_block": 990}}}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert trades == [] and st["evm"]["base"]["last_block"] == 993

    # tx revert (status 0x0) ⇒ không event dù logs có đủ shape swap
    feed._seen_tx.clear()
    receipts[TX] = dict(swap_receipt(), status="0x0")
    st = {"evm": {"base": {"last_block": 990}}}
    feed.backfill("base", [WALLET], st, {"conf": 8, "span": 500})
    assert trades == []


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

def test_bsc_publicnode_http_default_and_override(monkeypatch):
    assert feed.rpc_url("bsc") == "https://bsc-rpc.publicnode.com"
    monkeypatch.setenv("BSC_RPC_URL", "https://rpc.example/bsc")
    assert feed.rpc_url("bsc") == "https://rpc.example/bsc"
    fake = FakeEvm()
    use_fake(monkeypatch, fake)
    feed.get_logs("bsc", 10, 10, [])
    assert fake.getlogs_calls == [("bsc", 10, 10)]



def test_selected_robinhood_wallet_refresh(monkeypatch):
    rows = [{"address": "0x" + "c3" * 20, "chain": "robinhood"},
            {"address": "0x" + "b2" * 20, "chain": "bsc"}]
    monkeypatch.setattr(config, "http_json", lambda *a, **kw: rows)
    per, src = emain.load_wallets("/no-file", ("robinhood",))
    assert src == "api" and per == {"robinhood": ["0x" + "c3" * 20]}

def withdrawal_log(wallet, value, ca="0x0bd7d308f8e1639fab988df18a8011f41eacad73"):
    return {
        "address": ca,
        "topics": [
            "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
            "0x" + "0" * 24 + wallet.lower()[2:],
        ],
        "data": "0x%064x" % value,
    }


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
                "logs": [outgoing, withdrawal_log(WALLET, 2 * 10**18)],
            },
        },
        transactions={
            TX: {"from": WALLET, "value": hex(10**18)},
            tx_sell: {"from": WALLET, "value": "0x0"},
        },
    )
    use_fake(monkeypatch, fake)
    feed.process_log("robinhood", incoming, {WALLET})
    feed.process_log("robinhood", outgoing, {WALLET})
    assert [trade["side"] for trade in trades] == ["buy", "sell"]
    assert all(trade["chain"] == "robinhood" for trade in trades)
    assert [trade["amountUsd"] for trade in trades] == pytest.approx([500, 200])
def test_refresh_cfg_failsoft(monkeypatch):
    per = {"base": ["0xold"], "bsc": []}

    def dead(url, payload=None, timeout=20, headers=None):
        raise OSError("api down")

    monkeypatch.setattr(config, "http_json", dead)
    monkeypatch.setattr(emain, "_wallets_path", "/nonexistent/wallets.txt")
    emain.refresh_cfg(per)  # không raise
    assert per == {"base": ["0xold"], "bsc": []}  # API chết ⇒ giữ nguyên ví


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
