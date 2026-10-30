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
    "eth": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
}
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
DECIMALS_SELECTOR = "0x313ce567"  # decimals()
EVM_CHAINS = ("base", "bsc", "robinhood", "eth")
DEFAULT_EVM_CHAINS = ("base", "bsc")

EXPLORER_TX = {
    "base": "https://basescan.org/tx/",
    "bsc": "https://bscscan.com/tx/",
    "robinhood": "https://robinhoodchain.blockscout.com/tx/",
    "eth": "https://etherscan.io/tx/",
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
    "eth": {
        "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "uniswap-v2",
        "0xe592427a0aece92de3edee1f18e0157c05861564": "uniswap-v3",
        "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "uniswap-v3-02",
        "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "uniswap-universal",
        "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch-v5",
        "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": "sushiswap",
    },
}

# Quote/stable assets (wrapped native + USD/EUR pegs). They are never the
# tracked wallet's CA. Every address was verified on-chain (symbol/decimals)
# on 2026-10-23; Robinhood canonical WETH/USDG per
# https://docs.robinhood.com/chain/contracts/.
QUOTE_TOKENS = {
    "base": {
        "0x4200000000000000000000000000000000000006": "WETH",
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
        "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "USDbC",
        "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
        "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
        "0x820c137fa70c8691f0e44dc420a5e53c168921dc": "USDS",
        "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": "USDe",
        "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2": "sUSDe",
        "0x417ac0e078398c154edfadd9ef675d30be60af93": "crvUSD",
        "0x368181499736d0c0cc614dbb145e2ec1ac86b8c6": "LUSD",
        "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": "EURC",
        "0xb2000000000000000000002feb517dfec7415344": "OUSD",
        "0x03569cc076654f82679c4ba2124d64774781b01d": "BOLD",
        "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": "AUSD",
        "0xd993935e13851dd7517af10687ec7e5022127228": "apxUSD",
        "0x26c358f7c5fedb20a6ddef108cd91efb6b8da0cb": "USDSM",
    },
    "bsc": {
        "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "WBNB",
        "0x55d398326f99059ff775485246999027b3197955": "USDT",
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
        "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
        "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3": "DAI",
        "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": "FDUSD",
        "0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9": "TUSD",
        "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": "USD1",
        "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": "USDe",
        "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2": "sUSDe",
        "0x45e51bc23d592eb2dba86da3985299f7895d66ba": "USDD",
        "0x90c97f71e18723b0cf0dfa30ee176ab653e89f40": "FRAX",
        "0xe2fb3f127f5450dee44afe054385d74c392bdef4": "crvUSD",
        "0x0782b6d8c4551b9760e74c0545a9bcd90bdc41e5": "lisUSD",
        "0x4268b8f0b87b6eae5d897996e6b845ddbd99adf3": "axlUSDC",
        "0x12f31b73d812c6bb0d735a218c086d44d5fe5f89": "EURA",
        "0x23e8a70534308a4aaf76fb8c32ec13d17a3bd89e": "lUSD",
        "0x07663837218a003e66310a01596af4bf4e44623d": "rUSD",
        "0x323665443cef804a3b5206103304bd4872ea4253": "USDV",
        "0x524bc91dc82d6b90ef29f76a3ecaabafffd490bc": "USDT",
        "0xf3527ef8de265eaa3716fb312c12847bfba66cef": "USDX",
        "0x7788a3538c5fc7f9c7c8a74eac4c898fc8d87d92": "sUSDX",
        "0x9356086146be5158e98ad827e21b5cf944699894": "USDa",
        "0x73a325103935b0b5e7aa3aca6dba74ad22f82b03": "sUSDa",
        "0xf81ac2e1a0373dde1bce01e2fe694a9b7e3bfcb9": "XUSD",
        "0x5a110fc00474038f6c02e89c707d638602ea44b5": "USDF",
        "0x917af46b3c3c6e1bb7286b9f59637fb7c65851fb": "asUSDF",
        "0xaf44a1e76f56ee12adbb7ba8acd3cbd474888122": "DUSD",
        "0x64748ea3e31d0b7916f0ff91b017b9f404ded8ef": "cUSDO",
        "0xb4818bb69478730ef4e33cc068dd94278e2766cb": "satUSD",
        "0x4f2760b32720f013e900dc92f65480137391199b": "sUSD1+",
        "0xb3b02e4a9fb2bd28cc2ff97b0ab3f6b3ec1ee9d2": "USDf",
        "0x5519a479da8ce3af7f373c16f14870bbeafda265": "bnbUSD",
        "0xd896bf804c01c4c0fa5c42bf6a4b15c465009481": "SCUSD1",
        "0xdd73ea766b80417c0607a3f08e34a0c415d89d56": "WEUSD",
        "0x4772d2e014f9fc3a820c444e3313968e9a5c8121": "yUSD",
        "0x392004bee213f1ff580c867359c246924f21e6ad": "USDD",
        "0x8ba9da757d1d66c58b1ae7e2ed6c04087348a82d": "sUSDD",
        "0xea953ea6634d55dac6697c436b1e81a679db5882": "USDu",
        "0x385c279445581a186a4182a5503094ebb652ec71": "sUSDu",
        "0x61a10e8556bed032ea176330e7f17d6a12a10000": "UUSD",
        "0x0bb150dfa86ea5d7742f07fefcd8e8eda81d64ef": "USDat",
        "0x9cd57d3685e6868cacaa8bdcaaf52cbdebf4fa25": "sUSDat",
        "0xa14556f13516c53ff035858ffd21e1625e7eadfd": "apyUSD",
        "0x6b3788fd6604bbf03c5378d24e57bb334baad4af": "apxUSD",
    },
    "robinhood": {
        "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
        "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
        "0xdb81a12de6c0aebeddf2d85d531dd50cac7366ef": "USDG",
        "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": "USDe",
    },
    "eth": {
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
        "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
        "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
        "0xdc035d45d973e3ec169d2276ddab16f1e407384f": "USDS",
        "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": "USDe",
        "0x9d39a5de30e57443bff2a8307a4256c8797a3497": "sUSDe",
        "0x6c3ea9036406852006290770bedfcaba0e23a0e8": "PYUSD",
        "0x8292bb45bf1ee4d140127049757c2e0ff06317ed": "RLUSD",
        "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": "FDUSD",
        "0x0000000000085d4780b73119b644ae5ecd22b376": "TUSD",
        "0x4f8e5de400de08b164e7421b3ee387f461becd1a": "USDD",
        "0x853d955acef822db058eb8505911ed77f175b99e": "FRAX",
        "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e": "crvUSD",
        "0x5f98805a4e8be255a32880fdec7f6728c6568ba0": "LUSD",
        "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": "GHO",
        "0x865377367054516e17014ccded1e7d814edc9ce4": "DOLA",
        "0x8e870d67f660d95d5be530380d0ec0bd388289e1": "USDP",
        "0x9f6f3991d525015a6f8caf062c83b62fd3ac4436": "OUSD",
        "0x4fabb145d64652a948d72533023f6e7a623c7c53": "BUSD",
        "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c": "EURC",
        "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8": "EURA",
        "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd": "GUSD",
        "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3": "MIM",
        "0x57ab1ec28d129707052df4df418d58a2d46d5f51": "sUSD",
        "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": "USD1",
        "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": "AUSD",
        "0x98a878b1cd98131b271883b390f68d2c90674665": "apxUSD",
        "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51": "EUROP",
        "0x8df723295214ea6f21026eeeb4382d475f146f9f": "EURQ",
        "0x50753cfaf86c094925bf976f218d043f8791e408": "EURR",
        "0xe2f2a5c287993345a840db3b0845fbc70f5935a5": "mUSD",
        "0xc83e27f270cce0a3a3a29521173a83f402c1768b": "USDQ",
        "0x7b43e3875440b44613dc3bc08e7763e6da63c8f8": "USDR",
        "0xe343167631d89b6ffc58b88d6b7fb0228795491d": "USDG",
        "0x399b29975cbe313c56269cd5097f5ae097fa2741": "USDSM",
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
    """Single trade ingest body; unknown valuation is omitted so admission stays fail-open."""
    qty = ev.get("qty") or 0.0
    body = {
        "wallet": ev["wallet"],
        "chain": ev["chain"],
        "ca": ev["ca"],
        "tx": ev["tx"],
        "ts": int(ts_ms),
        "side": "sell" if ev["side"] == "SELL" else "buy",
        "provenance": "cursor",
    }
    if usd is not None and usd > 0:
        body["amountUsd"] = float(usd)
        if qty > 0:
            body["price"] = float(usd) / qty
    return body


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
