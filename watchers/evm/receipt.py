"""Fail-closed Uniswap v4 native swap recovery from verified pool events.

Protocol references: Uniswap v4-core IPoolManager.sol defines Initialize and
Swap; official deployments are documented at
https://docs.uniswap.org/contracts/v4/deployments.
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any, Callable
from watchers.evm.classify import QUOTE_TOKENS, WRAPPED_NATIVE, decode_transfer_log

_POOL_CACHE_LIMIT = 4096
_pool_cache: dict[tuple[str, str, str], tuple[str, str]] = {}
_pool_cache_lock = threading.Lock()
_v3_pool_cache: dict[tuple[str, str], tuple[str, str]] = {}

# Bound metadata lookup work per candidate attempt. The cursor survives retry
# cycles in this process; a restart safely starts another bounded scan.
MAX_METADATA_QUERIES_PER_ATTEMPT = 16
MAX_METADATA_SECONDS_PER_ATTEMPT = 2.0
_pool_scans: dict[tuple[str, str, str, int], dict[str, Any]] = {}

# Official Uniswap v4 PoolManager deployments on all watched EVM chains:
# https://docs.uniswap.org/contracts/v4/deployments
POOL_MANAGERS = {
    "base": {"0x498581ff718922c3f8e6a244956af099b2652b2b"},
    "bsc": {"0x28e2ea090877bf75740558f6bfb36a5ffee9e9df"},
    "robinhood": {"0x8366a39cc670b4001a1121b8f6a443a643e40951"},
    "eth": {"0x000000000004444c5dc75cb358380d2e3de08a90"},
}
SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
ZERO = "0x0000000000000000000000000000000000000000"
DEPOSIT_TOPIC = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"
V3_FACTORIES = {
    "base": {"0x33128a8fc17869897dce68ed026d694621f6fdfd"},
    "bsc": {
        "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7",
        "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
    },
    "robinhood": {"0x1f7d7550b1b028f7571e69a784071f0205fd2efa"},
    "eth": {"0x1f98431c8ad98523631ae4a59f267346ea31f984"},
}
V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
_v3_pool_cache: dict[tuple[str, str], tuple[str, str]] = {}

MAX_LOOKBACK = 2_000_000
MAX_INITIALIZE_LOG_RANGE = 10_000


def _hex_int(value: Any) -> int | None:
    try:
        return int(value, 16) if isinstance(value, str) and value.startswith("0x") else None
    except ValueError:
        return None


def _topic_address(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) != 66 or not value.startswith("0x"):
        return None
    address = "0x" + value[-40:].lower()
    return address if value[2:26] == "0" * 24 else None


def _range_limit(message: str, span: int) -> int:
    """Parse a provider block-span cap; otherwise halve without guessing."""
    match = re.search(
        r"(?:up to (?:a )?|limited to 0\s*-\s*)([\d,]+) block range",
        message,
        re.IGNORECASE,
    )
    if match is None:
        return max(1, span // 2)
    return max(1, int(match.group(1).replace(",", "")))


def _pool_metadata(chain: str, manager: str, pool_id: str, block: int,
                   rpc_call: Callable[[str, list], Any]) -> tuple[str, str] | None:
    """Resolve canonical pool currencies in bounded, resumable Initialize pages."""
    cache_key = (chain, manager, pool_id)
    scan_key = (*cache_key, block)
    with _pool_cache_lock:
        cached = _pool_cache.get(cache_key)
        if cached is not None:
            return cached
        scan = _pool_scans.get(scan_key)
        if scan is None:
            scan = {
                "start": max(0, block - MAX_LOOKBACK),
                "end": block,
                "span": MAX_INITIALIZE_LOG_RANGE,
            }
            _pool_scans[scan_key] = scan
            while len(_pool_scans) > _POOL_CACHE_LIMIT:
                _pool_scans.pop(next(iter(_pool_scans)))

    queries = 0
    attempt_started = time.monotonic()

    while scan["end"] >= scan["start"]:
        if (
            queries >= MAX_METADATA_QUERIES_PER_ATTEMPT
            or time.monotonic() - attempt_started >= MAX_METADATA_SECONDS_PER_ATTEMPT
        ):
            raise TimeoutError("v4 pool metadata lookup pending")
        end = scan["end"]
        begin = max(scan["start"], end - scan["span"] + 1)
        try:
            rows = rpc_call("eth_getLogs", [{
                "address": manager,
                "fromBlock": hex(begin),
                "toBlock": hex(end),
                "topics": [INITIALIZE_TOPIC, pool_id],
            }])
        except RuntimeError as exc:
            endpoint_key = getattr(exc, "endpoint_key", None)
            message = str(exc).lower()
            if endpoint_key is None or not any(
                term in message for term in ("range", "too many", "results limit", "blocks range")
            ):
                raise
            scan["span"] = min(scan["span"], _range_limit(message, scan["span"]))
            queries += 1
            continue
        queries += 1
        if not isinstance(rows, list):
            raise RuntimeError("eth_getLogs returned invalid v4 pool metadata")
        matches = []
        for row in rows:
            topics = row.get("topics") if isinstance(row, dict) else None
            log_block = _hex_int(row.get("blockNumber")) if isinstance(row, dict) else None
            if (
                not isinstance(topics, list)
                or len(topics) != 4
                or str(topics[0]).lower() != INITIALIZE_TOPIC
                or str(topics[1]).lower() != pool_id
                or str(row.get("address", "")).lower() != manager
                or log_block is None
                or not begin <= log_block <= end
            ):
                continue
            currency0, currency1 = _topic_address(topics[2]), _topic_address(topics[3])
            if currency0 and currency1 and currency0 < currency1:
                matches.append((currency0, currency1))
        if matches:
            result = matches[0] if len(set(matches)) == 1 else None
            if result is not None:
                with _pool_cache_lock:
                    _pool_cache[cache_key] = result
                    if len(_pool_cache) > _POOL_CACHE_LIMIT:
                        _pool_cache.pop(next(iter(_pool_cache)))
                    _pool_scans.pop(scan_key, None)
            return result
        scan["end"] = begin - 1

    with _pool_cache_lock:
        _pool_scans.pop(scan_key, None)
    return None


def _decode_swap(log: dict) -> tuple[str, str, int, int] | None:
    topics, data = log.get("topics"), log.get("data")
    if not isinstance(topics, list) or len(topics) != 3 or str(topics[0]).lower() != SWAP_TOPIC:
        return None
    if not isinstance(data, str) or len(data) != 2 + 6 * 64 or not data.startswith("0x"):
        return None
    if any(c not in "0123456789abcdefABCDEF" for c in data[2:]):
        return None
    pool_id = str(topics[1]).lower()
    sender = _topic_address(topics[2])
    if len(pool_id) != 66 or any(c not in "0123456789abcdef" for c in pool_id[2:]) or sender is None:
        return None
    words = [int(data[2 + i * 64:2 + (i + 1) * 64], 16) for i in range(6)]
    if any((1 << 127) <= words[i] < (1 << 256) - (1 << 127) for i in (0, 1)):
        return None
    amounts = [v - (1 << 256) if v >> 255 else v for v in words[:2]]
    return pool_id, sender, amounts[0], amounts[1]

def _decode_v3_swap(log: dict) -> tuple[str, str, int, int] | None:
    topics, data = log.get("topics"), log.get("data")
    if (
        not isinstance(topics, list)
        or len(topics) != 3
        or str(topics[0]).lower() != V3_SWAP_TOPIC
        or not isinstance(data, str)
        or not data.startswith("0x")
        or len(data) != 2 + 5 * 64
        or any(c not in "0123456789abcdefABCDEF" for c in data[2:])
    ):
        return None
    sender, recipient = _topic_address(topics[1]), _topic_address(topics[2])
    if sender is None or recipient is None:
        return None
    amounts = [int(data[2 + i * 64:2 + (i + 1) * 64], 16) for i in range(2)]
    amounts = [amount - (1 << 256) if amount >> 255 else amount for amount in amounts]
    return sender, recipient, amounts[0], amounts[1]


def _v3_pool_metadata(
    chain: str, pool: str, rpc_call: Callable[[str, list], Any]
) -> tuple[str, str] | None:
    cache_key = (chain, pool)
    with _pool_cache_lock:
        cached = _v3_pool_cache.get(cache_key)
    if cached is not None:
        return cached
    results = [
        rpc_call("eth_call", [{"to": pool, "data": selector}, "latest"])
        for selector in ("0xc45a0155", "0x0dfe1681", "0xd21220a7")
    ]
    if not all(isinstance(result, str) and len(result) == 66 for result in results):
        raise RuntimeError(f"invalid V3 pool metadata response for {pool}")
    factory, token0, token1 = (_topic_address(result) for result in results)
    if (
        factory not in V3_FACTORIES.get(chain, set())
        or token0 is None
        or token1 is None
        or token0 >= token1
    ):
        return None
    currencies = (token0, token1)
    with _pool_cache_lock:
        _v3_pool_cache[cache_key] = currencies
        if len(_v3_pool_cache) > _POOL_CACHE_LIMIT:
            _v3_pool_cache.pop(next(iter(_v3_pool_cache)))
    return currencies


def _wallet_token_flows(transfers: list[dict], wallet: str) -> tuple[dict[str, int], dict[str, set[str]]]:
    received: dict[str, int] = {}
    sources: dict[str, set[str]] = {}
    for transfer in transfers:
        ca = transfer["ca"]
        if transfer["to"] == wallet:
            received[ca] = received.get(ca, 0) + transfer["value"]
            sources.setdefault(ca, set()).add(transfer["from"])
        if transfer["from"] == wallet:
            received[ca] = received.get(ca, 0) - transfer["value"]
    return received, sources


def _wrapped_deposits(chain: str, logs: list[dict]) -> set[int]:
    wrapped = WRAPPED_NATIVE.get(chain)
    amounts = set()
    for log in logs:
        if not isinstance(log, dict):
            continue
        topics = log.get("topics")
        amount = _hex_int(log.get("data"))
        if (
            wrapped
            and str(log.get("address", "")).lower() == wrapped
            and isinstance(topics, list)
            and len(topics) == 2
            and str(topics[0]).lower() == DEPOSIT_TOPIC
            and amount is not None
        ):
            amounts.add(amount)
    return amounts


def _output_candidates(
    chain: str,
    manager: str,
    sender: str,
    received: dict[str, int],
    sources: dict[str, set[str]],
) -> list[str]:
    quotes = QUOTE_TOKENS.get(chain, {})
    return [
        ca
        for ca, amount in received.items()
        if amount > 0
        and ca not in quotes
        and (manager in sources.get(ca, set()) or sender in sources.get(ca, set()))
    ]


def _native_input(
    chain: str, currency: str, delta: int, value: int, wrapped_deposits: set[int]
) -> bool:
    if delta >= 0:
        return False
    amount = -delta
    if currency == ZERO:
        return amount <= value
    return currency == WRAPPED_NATIVE.get(chain) and (
        amount in wrapped_deposits or amount <= value
    )


def _native_output_pairs(
    chain: str,
    manager: str,
    sender: str,
    pool_id: str,
    amounts: tuple[int, int],
    block: int,
    value: int,
    wrapped_deposits: set[int],
    received: dict[str, int],
    sources: dict[str, set[str]],
    metadata_cache: dict[tuple[str, str], tuple[str, str] | None],
    rpc_call: Callable[[str, list], Any],
) -> list[tuple[str, int, int]]:
    output_candidates = _output_candidates(chain, manager, sender, received, sources)
    if not any(
        received.get(ca, 0) <= output_delta
        for output_delta in amounts
        if output_delta > 0
        for ca in output_candidates
    ):
        return []
    has_wrapped_input = any(delta < 0 and -delta in wrapped_deposits for delta in amounts)
    key = (manager, pool_id)
    currencies = None
    if not has_wrapped_input:
        if key not in metadata_cache:
            metadata_cache[key] = _pool_metadata(chain, manager, pool_id, block, rpc_call)
        currencies = metadata_cache[key]
        if currencies is None:
            return []

    pairs = []
    for index, input_delta in enumerate(amounts):
        output_delta = amounts[1 - index]
        input_ca = currencies[index] if currencies else WRAPPED_NATIVE.get(chain)
        if not _native_input(chain, input_ca, input_delta, value, wrapped_deposits):
            continue
        if output_delta <= 0:
            continue
        candidates = [currencies[1 - index]] if currencies else output_candidates
        for output_ca in candidates:
            if output_ca in (ZERO, WRAPPED_NATIVE.get(chain)):
                continue
            if manager not in sources.get(output_ca, set()) and sender not in sources.get(output_ca, set()):
                continue
            wallet_output = received.get(output_ca, 0)
            if 0 < wallet_output <= output_delta:
                pairs.append((output_ca, input_delta, output_delta))
    return pairs


def classify_native_swaps(
    chain: str,
    wallet: str,
    transaction: dict,
    receipt: dict,
    decimals_of: Callable[[str], int],
    rpc_call: Callable[[str, list], Any],
) -> list[dict]:
    """Recover native-funded V3/V4 buys using canonical pools and wallet evidence."""
    managers = POOL_MANAGERS.get(chain, set())
    if not managers or not isinstance(transaction, dict) or not isinstance(receipt, dict):
        return []
    wallet = wallet.lower()
    value = _hex_int(transaction.get("value"))
    if (
        str(transaction.get("from", "")).lower() != wallet
        or _hex_int(receipt.get("status")) != 1
        or value is None
        or value <= 0
    ):
        return []
    block = _hex_int(receipt.get("blockNumber"))
    logs = receipt.get("logs") or []
    if block is None or not isinstance(logs, list):
        return []
    transfers = [item for log in logs if (item := decode_transfer_log(log))]
    received, sources = _wallet_token_flows(transfers, wallet)
    wrapped_deposits = _wrapped_deposits(chain, logs)
    metadata_cache = {}
    output_totals: dict[str, dict[str, Any]] = {}

    for log in logs:
        if not isinstance(log, dict):
            continue
        manager = str(log.get("address", "")).lower()
        if manager not in managers:
            continue
        decoded = _decode_swap(log)
        if decoded is None:
            continue
        pool_id, sender, amount0, amount1 = decoded
        pairs = _native_output_pairs(
            chain, manager, sender, pool_id, (amount0, amount1), block, value,
            wrapped_deposits, received, sources, metadata_cache, rpc_call,
        )
        for ca, input_delta, output_delta in pairs:
            total = output_totals.setdefault(
                ca, {"output": 0, "quote": 0, "router": f"uniswap-v4:{manager}"}
            )
            if total["router"] != f"uniswap-v4:{manager}":
                total["router"] = "multi-protocol"
            total["output"] += output_delta
            total["quote"] += -input_delta

    if wrapped_deposits:
        for log in logs:
            if not isinstance(log, dict):
                continue
            topics = log.get("topics")
            if not isinstance(topics, list) or not topics or str(topics[0]).lower() != V3_SWAP_TOPIC:
                continue
            pool = str(log.get("address", "")).lower()
            currencies = _v3_pool_metadata(chain, pool, rpc_call)
            decoded = _decode_v3_swap(log)
            if currencies is None or decoded is None:
                continue
            _sender, recipient, amount0, amount1 = decoded
            for index, input_delta in enumerate((amount0, amount1)):
                output_delta = (amount1, amount0)[index]
                if (
                    currencies[index] != WRAPPED_NATIVE.get(chain)
                    or input_delta <= 0
                    or input_delta not in wrapped_deposits
                    or output_delta >= 0
                ):
                    continue
                output_ca = currencies[1 - index]
                if (
                    output_ca in QUOTE_TOKENS.get(chain, {})
                    or output_ca in (ZERO, WRAPPED_NATIVE.get(chain))
                    or received.get(output_ca, 0) <= 0
                    or received[output_ca] > -output_delta
                    or not ({pool, recipient} & sources.get(output_ca, set()))
                ):
                    continue
                total = output_totals.setdefault(
                    output_ca, {"output": 0, "quote": 0, "router": "uniswap-v3"}
                )
                if total["router"] != "uniswap-v3":
                    total["router"] = "multi-protocol"
                total["output"] += -output_delta
                total["quote"] += input_delta

    events = []
    for ca, total in output_totals.items():
        output_raw = received[ca]
        if output_raw > total["output"]:
            continue
        try:
            decimals = int(decimals_of(ca))
        except (TypeError, ValueError, OverflowError):
            continue
        if not 0 <= decimals <= 36:
            continue
        events.append({
            "type": "SWAP", "chain": chain, "wallet": wallet, "side": "BUY",
            "ca": ca, "qty_raw": output_raw, "qty": output_raw / 10**decimals,
            "router": total["router"],
            "quote_sym": "BNB" if chain == "bsc" else "ETH",
            "quote_raw": total["quote"], "token_in_ca": None,
            "token_out_ca": ca,
            "tx": transaction.get("hash") or receipt.get("transactionHash") or "",
        })
    return events


