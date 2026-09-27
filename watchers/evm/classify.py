"""Logic THUẦN cho watcher EVM: topic padding, decode log Transfer ERC-20,
allowlist DEX router, classify buy/sell, chia chunk block-range, dựng body
trade/event. KHÔNG IO — mọi hàm unit-test offline được. IO (WS/RPC) ở
`watchers/evm/feed.py`. T8, plan evm-base-bsc (D7).

Mọi địa chỉ router/quote dưới đây ĐÃ verify kèm nguồn (docs chính thức hoặc
explorer name tag) — xem `evidence/T8-routers.txt`. KHÔNG thêm địa chỉ chưa
verify. EVM address không phân biệt hoa/thường ⇒ khoá map đều lowercase.
"""

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
DECIMALS_SELECTOR = "0x313ce567"  # decimals()
EVM_CHAINS = ("base", "bsc")

EXPLORER_TX = {"base": "https://basescan.org/tx/", "bsc": "https://bscscan.com/tx/"}

# Allowlist DEX router per chain (D7). Swap NGOÀI allowlist ⇒ bỏ qua (chống noise:
# transfer thường, airdrop, aggregator lạ). Nguồn verify: evidence/T8-routers.txt.
ROUTERS = {
    "base": {
        "0x2626664c2603336e57b271c5c0b26f421741e481": "uniswap-v3",
        "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": "aerodrome",
        # BaseSwap router THẬT (seed trong plan sai suffix …Fe37A921 — xem evidence)
        "0x327df1e6de05895d2ab08513aadd9313fe505d86": "baseswap",
    },
    "bsc": {
        "0x10ed43c718714eb63d5aa57b78b54704e256024e": "pancake-v2",
        "0x13f4ea83d0bd40e75c8222255bc855a974568dd4": "pancake-v3-smart",
        "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8": "biswap",
        "0x0eb6949e725a295ecb3beacfc3766610bc970bef": "biswap-smart",
    },
}

# Quote token per chain — chân "tiền" của swap: ví NHẬN quote = SELL token kia,
# ví GỬI quote = BUY token kia. Token ngoài list này coi là token đích (CA).
QUOTE_TOKENS = {
    "base": {
        "0x4200000000000000000000000000000000000006": "WETH",
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
        "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
    },
    "bsc": {
        "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "WBNB",
        "0x55d398326f99059ff775485246999027b3197955": "USDT",
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
        "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
    },
}


# ---------- topic / address ----------


def pad_address(addr: str) -> str:
    """0x + 40 hex → topic 32-byte (`0x` + 24 số 0 + 40 hex lowercase).
    Raise ValueError nếu không phải EVM address hợp lệ — fail loud, không đoán."""
    a = addr.strip().lower()
    if not (
        a.startswith("0x")
        and len(a) == 42
        and all(c in "0123456789abcdef" for c in a[2:])
    ):
        raise ValueError(f"bad EVM address: {addr!r}")
    return "0x" + "0" * 24 + a[2:]


def topic_to_address(topic: str) -> str:
    """Topic 32-byte → 0x address lowercase (12 byte padding đầu bị bỏ)."""
    return "0x" + topic.lower()[-40:]


def wallet_topics(wallets):
    """[addr…] → topic filter cho eth_subscribe/eth_getLogs (đã pad)."""
    return [pad_address(w) for w in wallets]


def sub_topics(wallets):
    """2 topic-filter phủ MỌI chiều ví (plan D7): from = topic1, to = topic2."""
    t = wallet_topics(wallets)
    return [
        [TRANSFER_TOPIC, t, None],
        [TRANSFER_TOPIC, None, t],
    ]


# ---------- decode log ----------


def decode_transfer_log(log):
    """Raw log (dict JSON-RPC: eth_getLogs / eth_subscription / receipt.logs) →
    dict {tx, block, ca, from, to, value} của 1 ERC-20 Transfer; None nếu không
    phải Transfer hoặc shape dị dạng (thiếu topic, data không đúng uint256…)."""
    if not isinstance(log, dict):
        return None
    topics = log.get("topics") or []
    if len(topics) < 3 or str(topics[0]).lower() != TRANSFER_TOPIC:
        return None
    data = log.get("data") or ""
    tx, ca = log.get("transactionHash"), log.get("address")
    if not (isinstance(tx, str) and tx and isinstance(ca, str) and ca):
        return None
    try:
        if len(data) != 66 or not data.startswith("0x"):  # uint256 = đúng 32 byte
            return None
        value = int(data, 16)
        block = int(log.get("blockNumber") or "", 16)
    except ValueError:
        return None
    return {
        "tx": tx,
        "block": block,
        "ca": ca.lower(),
        "from": topic_to_address(topics[1]),
        "to": topic_to_address(topics[2]),
        "value": value,
    }


# ---------- router / chunk ----------


def router_name(chain: str, addr):
    """Tên router allowlist của `addr` trên `chain`; None nếu ngoài allowlist."""
    if not isinstance(addr, str):
        return None
    return ROUTERS.get(chain, {}).get(addr.lower())


def chunk_ranges(start: int, end: int, span: int):
    """[start..end] inclusive → list chunk (a,b) liên tiếp, rộng ≤ span, phủ kín
    không trùng lặp; [] khi end < start. span ≤ 0 bị ép về 1 (không loop vô hạn)."""
    span = max(1, span)
    out, a = [], start
    while a <= end:
        b = min(a + span - 1, end)
        out.append((a, b))
        a = b + 1
    return out


# ---------- classify ----------


def _sum_side(transfers, wallet, field):
    """{token_ca: tổng value} của các transfer mà `wallet` đứng phía `field`
    ('from' = gửi đi, 'to' = nhận về)."""
    out: dict[str, int] = {}
    for t in transfers:
        if t[field] == wallet:
            out[t["ca"]] = out.get(t["ca"], 0) + t["value"]
    return out


def classify_swap(chain, wallet, tx):
    """1 tx (qua router allowlist) → ĐÚNG 1 event swap cho `wallet`, hoặc None.

    `tx` = {"to": addr đích của tx, "transfers": [decode_transfer_log…],
            "decimals_of": callable(ca)->int}. Luật (D7):
      - tx.to KHÔNG phải router allowlist ⇒ None (không phải swap qua router).
      - BUY  = ví NHẬN token ngoài quote (multi-hop token→token: cạnh nhận thắng —
               ví mở vị thế mới, khớp mục đích signal table);
      - SELL = không có cạnh nhận non-quote nhưng ví GỬI token ngoài quote;
      - token nhiều chân (route tách) ⇒ lấy chân value raw lớn nhất; qty scale
        theo decimals; quote leg (nếu có) lấy tổng quote gửi/nhận.
    """
    router = router_name(chain, tx.get("to"))
    if router is None:
        return None
    wallet = wallet.lower()
    transfers = tx.get("transfers") or []
    quotes = QUOTE_TOKENS.get(chain, {})
    sent, got = _sum_side(transfers, wallet, "from"), _sum_side(transfers, wallet, "to")
    got_nq = {c: v for c, v in got.items() if c not in quotes and v > 0}
    sent_nq = {c: v for c, v in sent.items() if c not in quotes and v > 0}
    if got_nq:
        side, legs, quote_legs = "BUY", got_nq, sent
    elif sent_nq:
        side, legs, quote_legs = "SELL", sent_nq, got
    else:
        return None  # chỉ toàn quote↔quote hoặc ví không chuyển gì — không phải swap
    ca = max(legs, key=lambda c: legs[c])
    raw = legs[ca]
    dec = tx.get("decimals_of")
    raw_dec = dec(ca) if callable(dec) else 18
    decimals = int(raw_dec) if isinstance(raw_dec, (int, float, str)) else 18
    q_ca = max(quote_legs, key=lambda c: quote_legs[c]) if quote_legs else None
    return {
        "type": "SWAP",
        "chain": chain,
        "wallet": wallet,
        "side": side,
        "ca": ca,
        "qty_raw": raw,
        "qty": raw / 10**decimals,
        "router": router,
        "quote_sym": quotes.get(q_ca) if q_ca else None,
        "quote_raw": quote_legs.get(q_ca) if q_ca else None,
        "tx": transfers[0]["tx"] if transfers else "",
    }


# ---------- emit shape ----------


def trade_body(ev, usd, ts_ms):
    """Body POST /api/wallet-watch/trades (T4: server tra wallet theo
    (address, chain); side lowercase 'buy'/'sell'). `usd` None = chưa định giá
    được ⇒ amountUsd 0 (server fail-open, như semantics watch_trade_body Sol)."""
    qty = ev.get("qty") or 0.0
    return {
        "wallet": ev["wallet"],
        "chain": ev["chain"],
        "ca": ev["ca"],
        "tx": ev["tx"],
        "ts": int(ts_ms),
        "amountUsd": float(usd) if usd else 0.0,
        "price": float(usd) / qty if usd and qty > 0 else 0.0,
        "side": "sell" if ev["side"] == "SELL" else "buy",
    }


def fmt_event(ev) -> str:
    """Dòng log console (emit.fmt của Sol hardcode solscan ⇒ EVM có fmt riêng)."""
    w = ev["wallet"]
    side = str(ev.get("side") or "")
    col = {"BUY": "\033[32m", "SELL": "\033[31m"}.get(side, "")
    money = f" ≈ ${ev['usd']:,.2f}" if ev.get("usd") else ""
    leg = f" ← {ev['quote_sym']}" if ev.get("quote_sym") else ""
    return (
        f"{ev.get('ts', '')} {col}{side:<6}\033[0m {w[:6]}…{w[-4:]} [{ev['chain']}]"
        f"  {ev['qty']:,.6f} {ev['ca'][:10]}…{leg}{money}"
        f"  via {ev['router']}  {EXPLORER_TX[ev['chain']]}{ev['tx']}"
    )
