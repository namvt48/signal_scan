"""Pure EVM watcher logic: decode ERC-20 Transfer logs, net wallet balance changes,
classify swap endpoints, split block ranges, and build trade/event bodies. No IO;
RPC and websocket access lives in `watchers/evm/feed.py`.

Router and quote addresses are verified against official deployment documentation;
Robinhood sources are cited beside its mappings. Do not add unverified addresses.
EVM addresses are case-insensitive, so map keys are lowercase.
"""

WRAPPED_NATIVE = {
    "base": "0x4200000000000000000000000000000000000006",
    "bsc": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    "robinhood": "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
}
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
DECIMALS_SELECTOR = "0x313ce567"  # decimals()
EVM_CHAINS = ("base", "bsc", "robinhood")
DEFAULT_EVM_CHAINS = ("base", "bsc")

EXPLORER_TX = {
    "base": "https://basescan.org/tx/",
    "bsc": "https://bscscan.com/tx/",
    "robinhood": "https://robinhoodchain.blockscout.com/tx/",
}

# Known DEX router labels for emitted logs. Unknown routers are classified from
# paired net wallet-token movements rather than rejected by this mapping.
# https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
ROUTERS = {
    "base": {
        "0x2626664c2603336e57b271c5c0b26f421741e481": "uniswap-v3",
        "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": "aerodrome",
        "0x327df1e6de05895d2ab08513aadd9313fe505d86": "baseswap",
    },
    "bsc": {
        "0x10ed43c718714eb63d5aa57b78b54704e256024e": "pancake-v2",
        "0x13f4ea83d0bd40e75c8222255bc855a974568dd4": "pancake-v3-smart",
        "0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8": "biswap",
        "0x0eb6949e725a295ecb3beacfc3766610bc970bef": "biswap-smart",
    },
    "robinhood": {
        "0xcaf681a66d020601342297493863e78c959e5cb2": "uniswap-v3",
        "0x8876789976decbfcbbbe364623c63652db8c0904": "uniswap-universal",
    },
}

# Robinhood official token contracts:
# https://docs.robinhood.com/chain/contracts/
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
    "robinhood": {
        "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
        "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
    },
}

# Native legs are reconstructed from transaction value or wrapped-native
# Withdrawal events, then included in the same net-endpoint calculation.
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


def decode_call_trace(trace, chain, tx, block):
    """Decode successful native-value moves and standard ERC-20 transfer calls."""
    if not isinstance(trace, dict):
        return []
    out = []
    pending = [trace]
    while pending:
        frame = pending.pop()
        if not isinstance(frame, dict) or frame.get("error"):
            continue
        kind = str(frame.get("type") or "").upper()
        sender = str(frame.get("from") or "").lower()
        recipient = str(frame.get("to") or "").lower()
        calldata = str(frame.get("input") or "").lower()
        if (
            kind == "CALL"
            and len(recipient) == 42
            and recipient.startswith("0x")
            and len(calldata) >= 10
        ):
            selector = calldata[:10]
            payload = calldata[10:]
            words = [payload[i : i + 64] for i in range(0, len(payload), 64)]

            def address_at(index):
                word = words[index]
                if len(word) != 64 or word[:24] != "0" * 24:
                    raise ValueError("invalid ABI address")
                return "0x" + word[-40:]

            try:
                if selector == "0xa9059cbb" and len(payload) == 128:
                    source, destination, amount = sender, address_at(0), int(words[1], 16)
                elif selector == "0x23b872dd" and len(payload) == 192:
                    source, destination, amount = (
                        address_at(0),
                        address_at(1),
                        int(words[2], 16),
                    )
                else:
                    source = destination = ""
                    amount = 0
                result = str(frame.get("output") or "").lower()
                if result.startswith("0x") and len(result) == 66 and int(result, 16) == 0:
                    amount = 0
                if source and destination and amount:
                    out.append(
                        {
                            "tx": tx,
                            "block": block,
                            "ca": recipient,
                            "from": source,
                            "to": destination,
                            "value": amount,
                        }
                    )
            except (IndexError, ValueError):
                pass

        if kind in {"CALL", "CREATE", "SELFDESTRUCT"}:
            try:
                native_amount = int(str(frame.get("value") or "0x0"), 16)
            except ValueError:
                native_amount = 0
            if native_amount and len(sender) == 42 and len(recipient) == 42:
                out.append(
                    {
                        "tx": tx,
                        "block": block,
                        "ca": WRAPPED_NATIVE[chain],
                        "from": sender,
                        "to": recipient,
                        "value": native_amount,
                    }
                )
        children = frame.get("calls")
        if isinstance(children, list):
            pending.extend(reversed(children))
    return out


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


def _net_side(transfers, wallet):
    """Return exact per-token balance deltas for one wallet in the receipt."""
    net: dict[str, int] = {}
    for transfer in transfers:
        ca = transfer["ca"].lower()
        if transfer["from"] == wallet:
            net[ca] = net.get(ca, 0) - transfer["value"]
        if transfer["to"] == wallet:
            net[ca] = net.get(ca, 0) + transfer["value"]
    return {ca: raw for ca, raw in net.items() if raw}


def classify_swaps(chain, wallet, tx):
    """Collapse transfer logs to the wallet's net input/output token endpoints.

    Every returned event is one observed token balance change. Intermediate
    route legs that cancel at the wallet are omitted; split transfers aggregate
    by token contract. ERC-20 sides must pair with an opposite quote or token
    movement, so a plain token send is not reported as a swap.
    """
    wallet = wallet.lower()
    transfers = tx.get("transfers") or []
    net = _net_side(transfers, wallet)
    quotes = QUOTE_TOKENS.get(chain, {})
    assets = {ca: raw for ca, raw in net.items() if ca not in quotes}
    if not assets:
        return []

    inputs = {ca: raw for ca, raw in net.items() if raw < 0}
    outputs = {ca: raw for ca, raw in net.items() if raw > 0}
    if not inputs or not outputs:
        return []

    decimals_of = tx.get("decimals_of")
    if not callable(decimals_of):
        return []

    token_in_ca = next(iter(inputs)) if len(inputs) == 1 else None
    token_out_ca = next(iter(outputs)) if len(outputs) == 1 else None
    router_addr = tx.get("to")
    router = router_name(chain, router_addr) or (
        router_addr.lower() if isinstance(router_addr, str) else "unknown"
    )
    tx_hash = tx.get("tx") or (transfers[0].get("tx") if transfers else "")
    events = []
    for ca in sorted(assets):
        raw = assets[ca]
        try:
            decimals = int(decimals_of(ca))
        except (TypeError, ValueError, OverflowError):
            return []
        if not 0 <= decimals <= 36:
            return []
        side = "BUY" if raw > 0 else "SELL"
        opposite_quotes = {
            quote_ca: quote_raw
            for quote_ca, quote_raw in net.items()
            if quote_ca in quotes and (quote_raw < 0 if side == "BUY" else quote_raw > 0)
        }
        quote_ca = next(iter(opposite_quotes)) if len(opposite_quotes) == 1 else None
        if side == "BUY":
            source_ca, destination_ca = token_in_ca, ca if token_out_ca == ca else None
        else:
            source_ca, destination_ca = ca if token_in_ca == ca else None, token_out_ca
        events.append(
            {
                "type": "SWAP",
                "chain": chain,
                "wallet": wallet,
                "side": side,
                "ca": ca,
                "qty_raw": abs(raw),
                "qty": abs(raw) / 10**decimals,
                "router": router,
                "quote_sym": quotes.get(quote_ca) if quote_ca else None,
                "quote_raw": abs(opposite_quotes[quote_ca]) if quote_ca else None,
                "token_in_ca": source_ca,
                "token_out_ca": destination_ca,
                "tx": tx_hash,
            }
        )
    return events


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
