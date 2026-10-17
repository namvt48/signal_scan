"""Tests THUẦN (offline, không mạng) cho watchers/evm/classify.py — T8/D7.

Chạy: python3 -m pytest scripts/test_evm_classify.py -q
"""

import pytest

from watchers.evm import classify as cl

WALLET = "0x1111111111111111111111111111111111111111"
POOL = "0x3333333333333333333333333333333333333333"
FRIEND = "0x4444444444444444444444444444444444444444"
TOKEN = "0x2222222222222222222222222222222222222222"
TOKEN2 = "0x5555555555555555555555555555555555555555"
WETH = "0x4200000000000000000000000000000000000006"
UNISWAP = (
    "0x2626664c2603336e57b271c5c0b26f421741e481"  # Base, checksum gốc: …F421741e481
)
UNKNOWN = "0x9999999999999999999999999999999999999999"
TX = "0x" + "ab" * 32

DEC = {TOKEN: 6, TOKEN2: 18, WETH: 18}


def raw_log(frm, to, value, ca=TOKEN, tx=TX, block=100, idx=0):
    """Log eth_getLogs/eth_subscription đúng shape RPC (data uint256 padded 32B)."""
    return {
        "address": ca,
        "topics": [cl.TRANSFER_TOPIC, cl.pad_address(frm), cl.pad_address(to)],
        "data": "0x%064x" % value,
        "blockNumber": hex(block),
        "transactionHash": tx,
        "logIndex": hex(idx),
    }


def xfer(frm, to, value, ca=TOKEN):
    return {
        "tx": TX,
        "block": 100,
        "ca": ca.lower(),
        "from": frm.lower(),
        "to": to.lower(),
        "value": value,
    }


def mktx(to, transfers):
    return {"to": to, "transfers": transfers, "decimals_of": lambda ca: DEC.get(ca, 18)}


# ---------- pad / topic ----------


def test_pad_address_roundtrip():
    t = cl.pad_address(UNISWAP)
    assert t == "0x" + "0" * 24 + UNISWAP[2:]
    assert len(t) == 66
    assert cl.topic_to_address(t) == UNISWAP


def test_pad_address_rejects_junk():
    for bad in ("", "0x123", "11" * 20, "0x" + "z" * 40, WALLET + "!"):
        with pytest.raises(ValueError):
            cl.pad_address(bad)


def test_sub_topics_shape():
    subs = cl.sub_topics([WALLET])
    assert len(subs) == 2  # D7: from = topic1, to = topic2
    assert subs[0][0] == subs[1][0] == cl.TRANSFER_TOPIC
    assert subs[0][1] == [cl.pad_address(WALLET)] and subs[0][2] is None
    assert subs[1][1] is None and subs[1][2] == [cl.pad_address(WALLET)]


# ---------- decode_transfer_log ----------


def test_decode_valid_log():
    d = cl.decode_transfer_log(raw_log(WALLET, POOL, 5 * 10**17, ca=WETH, block=42))
    assert d == {
        "tx": TX,
        "block": 42,
        "ca": WETH,
        "from": WALLET,
        "to": POOL,
        "value": 5 * 10**17,
    }


def test_decode_rejects_junk():
    good = raw_log(WALLET, POOL, 1)
    topics = list(good["topics"])
    bad_topic0 = dict(good, topics=["0xdeadbeef"] + topics[1:])
    short_topics = dict(good, topics=good["topics"][:2])
    short_data = dict(good, data="0x05")  # không đúng uint256 32B
    bad_hex = dict(good, data="0x" + "z" * 64)
    no_tx = dict(good, transactionHash="")
    assert cl.decode_transfer_log(bad_topic0) is None
    assert cl.decode_transfer_log(short_topics) is None
    assert cl.decode_transfer_log(short_data) is None
    assert cl.decode_transfer_log(bad_hex) is None
    assert cl.decode_transfer_log(no_tx) is None
    assert cl.decode_transfer_log("not a dict") is None
    assert cl.decode_transfer_log({}) is None

def test_decode_call_trace_extracts_token_calls_and_ignores_reverted_frames():
    def word(value):
        return f"{value:064x}"

    trace = {
        "type": "CALL",
        "from": WALLET,
        "to": UNISWAP,
        "value": "0x0",
        "calls": [
            {
                "type": "CALL",
                "from": UNISWAP,
                "to": WETH,
                "input": "0x23b872dd" + word(int(WALLET, 16)) + word(int(POOL, 16)) + word(5 * 10**17),
                "value": "0x0",
            },
            {
                "type": "CALL",
                "from": POOL,
                "to": TOKEN,
                "input": "0xa9059cbb" + word(int(WALLET, 16)) + word(1000 * 10**6),
                "value": "0x0",
            },
            {
                "type": "CALL",
                "from": POOL,
                "to": TOKEN2,
                "input": "0xa9059cbb" + word(int(WALLET, 16)) + word(9),
                "value": "0x0",
                "error": "execution reverted",
            },
        ],
    }

    assert cl.decode_call_trace(trace, "base", TX, 100) == [
        xfer(WALLET, POOL, 5 * 10**17, ca=WETH),
        xfer(POOL, WALLET, 1000 * 10**6),
    ]
def test_decode_call_trace_includes_native_router_output():
    trace = {
        "type": "CALL",
        "from": POOL,
        "to": UNISWAP,
        "value": "0x0",
        "calls": [
            {
                "type": "CALL",
                "from": UNISWAP,
                "to": WALLET,
                "value": hex(2 * 10**18),
                "input": "0x",
            }
        ],
    }

    assert cl.decode_call_trace(trace, "base", TX, 100) == [
        xfer(UNISWAP, WALLET, 2 * 10**18, ca=WETH),
    ]

def test_call_trace_refund_reduces_native_quote_endpoint():
    trace = {
        "type": "CALL",
        "from": WALLET,
        "to": UNISWAP,
        "value": hex(10**18),
        "calls": [
            {
                "type": "CALL",
                "from": UNISWAP,
                "to": WALLET,
                "value": hex(10**17),
                "input": "0x",
            },
            {
                "type": "CALL",
                "from": POOL,
                "to": TOKEN,
                "input": "0xa9059cbb"
                + f"{int(WALLET, 16):064x}"
                + f"{1000 * 10**6:064x}",
                "value": "0x0",
            },
        ],
    }
    transfers = cl.decode_call_trace(trace, "base", TX, 100)

    events = cl.classify_swaps("base", WALLET, mktx(UNISWAP, transfers))

    assert len(events) == 1
    assert events[0]["side"] == "BUY" and events[0]["ca"] == TOKEN
    assert events[0]["qty_raw"] == 1000 * 10**6
    assert events[0]["quote_raw"] == 9 * 10**17






# ---------- chunk_ranges ----------


def test_chunk_ranges():
    assert cl.chunk_ranges(1, 10, 4) == [(1, 4), (5, 8), (9, 10)]
    assert cl.chunk_ranges(5, 4, 3) == []  # end < start
    assert cl.chunk_ranges(7, 7, 9) == [(7, 7)]  # 1 block
    assert cl.chunk_ranges(1, 3, 0) == [
        (1, 1),
        (2, 2),
        (3, 3),
    ]  # span≤0 → 1, không loop vô hạn


# ---------- router ----------


def test_router_name_case_insensitive():
    assert (
        cl.router_name("base", "0x2626664C2603336E57B271C5c0b26F421741e481")
        == "uniswap-v3"
    )
    assert (
        cl.router_name("bsc", "0x10ED43C718714eb63d5aA57B78B54704E256024E")
        == "pancake-v2"
    )
    assert cl.router_name("base", UNKNOWN) is None
    assert cl.router_name("base", None) is None
    assert cl.router_name("sol", UNISWAP) is None  # sai chain


def test_robinhood_chain_official_router_and_quotes():
    assert cl.EVM_CHAINS == ("base", "bsc", "robinhood")
    assert cl.DEFAULT_EVM_CHAINS == ("base", "bsc")
    router = "0xcaf681a66d020601342297493863e78c959e5cb2"
    universal = "0x8876789976decbfcbbbe364623c63652db8c0904"
    weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
    usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
    assert cl.router_name("robinhood", router.upper()) == "uniswap-v3"
    assert cl.router_name("robinhood", universal) == "uniswap-universal"
    assert cl.router_name("base", router) is None
    assert cl.QUOTE_TOKENS["robinhood"] == {weth: "WETH", usdg: "USDG"}
    buy_events = cl.classify_swaps(
        "robinhood", WALLET,
        mktx(router, [xfer(WALLET, POOL, 10**18, ca=weth),
                      xfer(POOL, WALLET, 10**6, ca=TOKEN)]),
    )
    assert len(buy_events) == 1
    buy = buy_events[0]
    assert buy["chain"] == "robinhood" and buy["side"] == "BUY"
    assert buy["quote_sym"] == "WETH"
    sell_events = cl.classify_swaps(
        "robinhood", WALLET,
        mktx(universal, [xfer(WALLET, POOL, 2 * 10**6, ca=TOKEN),
                         xfer(POOL, WALLET, 10**6, ca=usdg)]),
    )
    assert len(sell_events) == 1
    sell = sell_events[0]
    assert sell["side"] == "SELL" and sell["quote_sym"] == "USDG"
def test_buy_quote_for_token():
    events = cl.classify_swaps(
        "base",
        WALLET,
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 5 * 10**17, ca=WETH),
                xfer(POOL, WALLET, 1000 * 10**6, ca=TOKEN),
            ],
        ),
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["side"] == "BUY" and ev["ca"] == TOKEN
    assert ev["qty"] == pytest.approx(1000.0)
    assert ev["qty_raw"] == 1000 * 10**6
    assert ev["quote_sym"] == "WETH" and ev["quote_raw"] == 5 * 10**17
    assert ev["router"] == "uniswap-v3" and ev["tx"] == TX
    assert ev["token_in_ca"] == WETH and ev["token_out_ca"] == TOKEN
    assert ev["chain"] == "base" and ev["wallet"] == WALLET
    assert ev["type"] == "SWAP"


def test_sell_token_for_quote():
    events = cl.classify_swaps(
        "base",
        WALLET,
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 1000 * 10**6, ca=TOKEN),
                xfer(POOL, WALLET, 5 * 10**17, ca=WETH),
            ],
        ),
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["side"] == "SELL" and ev["ca"] == TOKEN
    assert ev["qty"] == pytest.approx(1000.0)
    assert ev["quote_sym"] == "WETH"
    assert ev["token_in_ca"] == TOKEN and ev["token_out_ca"] == WETH
def test_route_intermediate_cancels_and_split_output_sums():
    events = cl.classify_swaps(
        "base",
        WALLET,
        mktx(
            UNKNOWN,
            [
                xfer(WALLET, POOL, 10**18, ca=WETH),
                xfer(POOL, WALLET, 4 * 10**6, ca=TOKEN),
                xfer(WALLET, POOL, 4 * 10**6, ca=TOKEN),
                xfer(POOL, WALLET, 2 * 10**18, ca=TOKEN2),
                xfer(POOL, WALLET, 3 * 10**18, ca=TOKEN2),
            ],
        ),
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["side"] == "BUY" and ev["ca"] == TOKEN2
    assert ev["qty_raw"] == 5 * 10**18
    assert ev["qty"] == pytest.approx(5.0)
    assert ev["token_in_ca"] == WETH and ev["token_out_ca"] == TOKEN2


def test_token_to_token_emits_only_net_endpoints():
    events = cl.classify_swaps(
        "base",
        WALLET,
        mktx(
            UNKNOWN,
            [
                xfer(WALLET, POOL, 5000 * 10**6, ca=TOKEN),
                xfer(POOL, WALLET, 3 * 10**18, ca=TOKEN2),
            ],
        ),
    )
    assert [(ev["side"], ev["ca"]) for ev in events] == [
        ("SELL", TOKEN),
        ("BUY", TOKEN2),
    ]
    assert all(ev["token_in_ca"] == TOKEN for ev in events)
    assert all(ev["token_out_ca"] == TOKEN2 for ev in events)


def test_plain_transfer_skipped():
    events = cl.classify_swaps(
        "base", WALLET, mktx(FRIEND, [xfer(WALLET, FRIEND, 1000 * 10**6, ca=TOKEN)])
    )
    assert events == []
# ---------- classify_swaps ---------- 


def test_quote_only_or_empty_skipped():
    assert cl.classify_swaps("base", WALLET, mktx(UNISWAP, [])) == []
    events = cl.classify_swaps(
        "base",
        WALLET,
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 10**18, ca=WETH),
                xfer(POOL, WALLET, 2 * 10**9, ca="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
            ],
        ),
    )
    assert events == []


def test_wallet_case_insensitive():
    events = cl.classify_swaps(
        "base",
        WALLET.upper(),
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 10**18, ca=WETH),
                xfer(POOL, WALLET, 1000 * 10**6, ca=TOKEN),
            ],
        ),
    )
    assert len(events) == 1
    assert events[0]["side"] == "BUY" and events[0]["wallet"] == WALLET



def test_missing_decimals_does_not_emit_guessed_quantity():
    events = cl.classify_swaps(
        "base",
        WALLET,
        {
            "to": UNISWAP,
            "transfers": [
                xfer(WALLET, POOL, 10**18, ca=WETH),
                xfer(POOL, WALLET, 3 * 10**18, ca=TOKEN),
            ],
        },
    )
    assert events == []

# ---------- trade_body / fmt ----------


def test_trade_body():
    ev = {
        "wallet": WALLET,
        "chain": "base",
        "ca": TOKEN,
        "tx": TX,
        "side": "BUY",
        "qty": 1000.0,
    }
    b = cl.trade_body(ev, 250.0, 1_700_000_000_123)
    assert b == {
        "wallet": WALLET,
        "chain": "base",
        "ca": TOKEN,
        "tx": TX,
        "ts": 1_700_000_000_123,
        "amountUsd": 250.0,
        "price": 0.25,
        "side": "buy",
    }
    b2 = cl.trade_body(dict(ev, side="SELL"), None, 5.9)
    assert b2["side"] == "sell" and b2["amountUsd"] == 0.0 and b2["price"] == 0.0
    assert b2["ts"] == 5


def test_fmt_event_has_explorer_link():
    ev = {
        "wallet": WALLET,
        "chain": "bsc",
        "ca": TOKEN,
        "tx": TX,
        "side": "BUY",
        "qty": 1000.0,
        "router": "pancake-v2",
        "ts": "2026-09-27 12:00:00",
        "usd": 12.5,
    }
    s = cl.fmt_event(ev)
    assert s.startswith("2026-09-27 12:00:00") and "BUY" in s
    assert s.endswith(f"https://bscscan.com/tx/{TX}")
