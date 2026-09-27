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


# ---------- classify_swap ----------


def test_buy_quote_for_token():
    ev = cl.classify_swap(
        "base",
        WALLET,
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 5 * 10**17, ca=WETH),  # gửi quote
                xfer(POOL, WALLET, 1000 * 10**6, ca=TOKEN),  # nhận token
            ],
        ),
    )
    assert ev is not None
    assert ev["side"] == "BUY" and ev["ca"] == TOKEN
    assert ev["qty"] == pytest.approx(1000.0)  # 6 decimals
    assert ev["quote_sym"] == "WETH" and ev["quote_raw"] == 5 * 10**17
    assert ev["router"] == "uniswap-v3" and ev["tx"] == TX
    assert ev["chain"] == "base" and ev["wallet"] == WALLET
    assert ev["type"] == "SWAP"


def test_sell_token_for_quote():
    ev = cl.classify_swap(
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
    assert ev is not None
    # nhận WETH + gửi TOKEN ⇒ cạnh GỬI non-quote thắng ⇒ SELL TOKEN
    assert ev["side"] == "SELL" and ev["ca"] == TOKEN
    assert ev["qty"] == pytest.approx(1000.0)
    assert ev["quote_sym"] == "WETH"


def test_token_to_token_single_buy_event():
    ev = cl.classify_swap(
        "base",
        WALLET,
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 10**18, ca=TOKEN),
                xfer(POOL, WALLET, 7 * 10**18, ca=TOKEN2),
            ],
        ),
    )
    assert ev is not None and ev["side"] == "BUY" and ev["ca"] == TOKEN2
    assert ev["quote_sym"] is None  # không có chân quote


def test_multi_leg_picks_largest_raw():
    ev = cl.classify_swap(
        "base",
        WALLET,
        mktx(
            UNISWAP,
            [
                xfer(WALLET, POOL, 10**18, ca=WETH),
                xfer(POOL, WALLET, 100 * 10**6, ca=TOKEN),  # route tách: 2 chân nhận
                xfer(POOL, WALLET, 2 * 10**18, ca=TOKEN2),
            ],
        ),
    )
    assert ev is not None
    assert ev["side"] == "BUY" and ev["ca"] == TOKEN2  # raw 2e18 > 1e8


def test_unknown_router_skipped():
    assert (
        cl.classify_swap(
            "base",
            WALLET,
            mktx(
                UNKNOWN,
                [
                    xfer(WALLET, POOL, 10**18, ca=WETH),
                    xfer(POOL, WALLET, 1000 * 10**6, ca=TOKEN),
                ],
            ),
        )
        is None
    )


def test_plain_transfer_skipped():
    # ví chuyển token cho bạn, không qua router ⇒ không event
    assert (
        cl.classify_swap(
            "base",
            WALLET,
            mktx(
                FRIEND,
                [
                    xfer(WALLET, FRIEND, 1000 * 10**6, ca=TOKEN),
                ],
            ),
        )
        is None
    )


def test_quote_only_or_empty_skipped():
    assert cl.classify_swap("base", WALLET, mktx(UNISWAP, [])) is None
    assert (
        cl.classify_swap(
            "base",
            WALLET,
            mktx(
                UNISWAP,
                [
                    xfer(WALLET, POOL, 10**18, ca=WETH),  # chỉ quote↔quote
                    xfer(
                        POOL,
                        WALLET,
                        2 * 10**9,
                        ca="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                    ),
                ],
            ),
        )
        is None
    )


def test_wallet_case_insensitive():
    ev = cl.classify_swap(
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
    assert ev is not None
    assert ev["side"] == "BUY" and ev["wallet"] == WALLET


def test_missing_decimals_of_defaults_18():
    ev = cl.classify_swap(
        "base",
        WALLET,
        {
            "to": UNISWAP,
            "transfers": [xfer(POOL, WALLET, 3 * 10**18, ca=TOKEN)],
        },
    )
    assert ev is not None
    assert ev["qty"] == pytest.approx(3.0)


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
