"""Deterministic safety tests for native V3/V4 receipt decoding."""
import json
from io import BytesIO
from urllib.error import HTTPError

import pytest

from watchers.evm import receipt as receipt_mod
from watchers.common import config
from watchers.evm import rpc as rpc_mod
from watchers.evm.classify import TRANSFER_TOPIC, WRAPPED_NATIVE
from watchers.evm.receipt import (
    INITIALIZE_TOPIC,
    POOL_MANAGERS,
    SWAP_TOPIC,
    V3_FACTORIES,
    V3_SWAP_TOPIC,
    classify_native_swaps,
)

WALLET = "0xf703fd64093b50797abdc9e450632240fa2ba5d4"
BASE_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b"
BASE_TOKEN = "0xd3e592e728ae3461bd97c7a6b359e1043dd83ba3"
BASE_POOL = "0x83b7ac4bdd27787a2d19cfacc5284c43b29d408443ccbe2ab23424717441b1dd"
RH_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
RH_POOL = "0x54b075966cda994d3e709bb927b8e458f33f3de56c99850611af22466cb26dff"
RH_TOKEN = "0x15a65ce1c9698a91c8fc39c7e94fa0625b770abe"
BASE_WETH = "0x4200000000000000000000000000000000000006"
ZERO = "0x" + "0" * 40
BASE_HASH = "0xc2ca4706201300580b4ce63abbf5d03128e736d6c696ae2835259e936054d0ff"
RH_HASH = "0xf608cdaf89426fb65328fc22abe9c471477d6f2994e175dbac0fe1a7d9a6e4ac"
BASE_BLOCK = "0x32ab5dd"
RH_INIT_BLOCK = "0x5e1c465"
RH_BLOCK = "0x5e307d1"
BASE_BLOCK_HASH = "0x15e50ec56ae0d4b6c502b502a8a99f87c2c84abf9bbb26505dda27dc3ac03d80"
RH_BLOCK_HASH = "0xc251776301f6089a9648e77280562823ecc4f319b00994dd40ab29d0e893edb2"


def word(value):
    return f"{value:064x}"


def signed(value):
    return word(value % (1 << 256))


def topic_address(address):
    return "0x" + "0" * 24 + address[2:]


def transfer_log(token, value, sender=ZERO, recipient=WALLET):
    return {
        "address": token,
        "topics": [TRANSFER_TOPIC, topic_address(sender), topic_address(recipient)],
        "data": "0x" + word(value),
        "transactionHash": "0xabc",
        "blockNumber": "0x100",
    }


def swap_log(manager=BASE_MANAGER, pool=BASE_POOL, amount0=-100, amount1=90):
    return {"address": manager, "topics": [SWAP_TOPIC, pool, "0x" + word(1)],
            "data": "0x" + "".join(signed(v) for v in (amount0, amount1, 1, 1, 1, 1))}


def fixture(logs=None, value="0x999", sender=WALLET, status="0x1"):
    tx = {"from": sender, "hash": "0xabc", "value": value}
    receipt = {"status": status, "blockNumber": "0x100", "blockHash": "0xblock",
               "transactionHash": "0xabc", "logs": logs if logs is not None else
               [swap_log(), transfer_log(BASE_TOKEN, 90, sender=BASE_MANAGER)]}
    return tx, receipt


def init_row(manager, pool, currencies, block, block_hash):
    return {"address": manager, "topics": [INITIALIZE_TOPIC, pool,
            topic_address(currencies[0]), topic_address(currencies[1])],
            "blockNumber": block, "blockHash": block_hash, "data": "0x"}


def resolver_for(expected_manager, expected_pool, init):
    def resolver(method, params):
        assert method == "eth_getLogs"
        query = params[0]
        assert query["address"].lower() == expected_manager
        assert query["topics"] == [INITIALIZE_TOPIC, expected_pool]
        begin, end = int(query["fromBlock"], 16), int(query["toBlock"], 16)
        assert end - begin <= 9_999
        init_block = int(init["blockNumber"], 16)
        return [init] if begin <= init_block <= end else []
    return resolver


def test_native_buy_requires_pool_init_and_exact_wallet_output():
    tx, receipt = fixture()
    init = init_row(BASE_MANAGER, BASE_POOL, (BASE_WETH, BASE_TOKEN), "0x80", "0xinit")
    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18,
                                   resolver_for(BASE_MANAGER, BASE_POOL, init))
    assert len(events) == 1
    assert (events[0]["side"], events[0]["ca"], events[0]["qty_raw"]) == ("BUY", BASE_TOKEN, 90)
    assert events[0]["quote_raw"] == 100
    assert events[0]["router"] == f"uniswap-v4:{BASE_MANAGER}"


def test_v4_initialize_lookup_pages_backward_with_provider_safe_ranges():
    manager = BASE_MANAGER
    pool = "0x" + "f1" * 32
    token = "0x" + "7a" * 20
    block, init_block = 25_001, 8_000
    tx, receipt = fixture([
        swap_log(manager=manager, pool=pool),
        transfer_log(token, 90, sender=manager),
    ])
    receipt["blockNumber"] = hex(block)
    init = init_row(manager, pool, (ZERO, token), hex(init_block), "0xinit")
    ranges = []

    def resolve(method, params):
        assert method == "eth_getLogs"
        query = params[0]
        begin, end = int(query["fromBlock"], 16), int(query["toBlock"], 16)
        assert end - begin <= 9_999
        ranges.append((begin, end))
        return [init] if begin <= init_block <= end else []

    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolve)

    assert [(event["side"], event["ca"], event["qty_raw"]) for event in events] == [
        ("BUY", token, 90)
    ]
    assert ranges == [(15_002, 25_001), (5_002, 15_001)]


@pytest.fixture
def metadata_lookup_state(monkeypatch):
    monkeypatch.setattr(receipt_mod, "_pool_cache", {})
    monkeypatch.setattr(receipt_mod, "_pool_scans", {}, raising=False)
    rpc_mod.reset()
    yield
    rpc_mod.reset()


def limited_metadata_rpc(monkeypatch, init, queries, cap=None):
    def request(url, payload=None, timeout=20, headers=None):
        query = payload["params"][0]
        begin, end = int(query["fromBlock"], 16), int(query["toBlock"], 16)
        queries.append((begin, end))
        if cap is not None and end - begin + 1 > cap:
            body = json.dumps({"error": {
                "code": -32600,
                "message": f"eth_getLogs requests support up to a {cap} block range",
            }}).encode()
            raise HTTPError(url, 400, "range limit", {}, BytesIO(body))
        height = int(init["blockNumber"], 16)
        return {"result": [init] if begin <= height <= end else []}

    monkeypatch.setattr(config, "http_json", request)
    return lambda method, params: rpc_mod.call(
        "base", method, params, ["https://metadata.example"], tries=1,
    )


@pytest.mark.parametrize("cap", [10, 4_999])
def test_v4_lookup_recovers_from_provider_range_rejection(
    monkeypatch, metadata_lookup_state, cap,
):
    token, pool = "0x" + "79" * 20, "0x" + "f3" * 32
    tx, receipt = fixture([
        swap_log(pool=pool), transfer_log(token, 90, sender=BASE_MANAGER),
    ])
    receipt["blockNumber"] = hex(25_001)
    init = init_row(BASE_MANAGER, pool, (ZERO, token), hex(24_970), "0xinit")
    queries = []
    resolve = limited_metadata_rpc(monkeypatch, init, queries, cap)
    events = None
    for _ in range(8):
        try:
            events = classify_native_swaps(
                "base", WALLET, tx, receipt, lambda _: 18, resolve,
            )
            break
        except TimeoutError:
            pass
    assert events is not None, "bounded retries must eventually resolve metadata"
    assert [(event["side"], event["ca"], event["qty_raw"]) for event in events] == [
        ("BUY", token, 90),
    ]
    accepted = [(begin, end) for begin, end in queries if end - begin + 1 <= cap]
    assert any(begin <= 24_970 <= end for begin, end in accepted)
    assert all(next_end == begin - 1 for (begin, _), (_, next_end) in zip(accepted, accepted[1:]))


def test_v4_lookup_yields_and_resumes_without_rescanning_completed_pages(
    monkeypatch, metadata_lookup_state,
):
    token, pool = "0x" + "78" * 20, "0x" + "f4" * 32
    tx, receipt = fixture([
        swap_log(pool=pool), transfer_log(token, 90, sender=BASE_MANAGER),
    ])
    receipt["blockNumber"] = hex(300_001)
    init = init_row(BASE_MANAGER, pool, (ZERO, token), hex(1_000), "0xinit")
    queries = []
    resolve = limited_metadata_rpc(monkeypatch, init, queries)
    with pytest.raises(TimeoutError, match="metadata lookup pending"):
        classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolve)
    assert 0 < len(queries) <= receipt_mod.MAX_METADATA_QUERIES_PER_ATTEMPT
    resume_at = queries[-1][0] - 1
    completed = len(queries)
    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolve)
    assert queries[completed][1] == resume_at
    assert [(event["ca"], event["qty_raw"]) for event in events] == [(token, 90)]
    assert len(set(queries)) == len(queries)


def test_v4_lookup_preserves_alternating_anchor_cursors_for_same_pool(
    monkeypatch, metadata_lookup_state,
):
    token, pool = "0x" + "76" * 20, "0x" + "f6" * 32
    tx_a, receipt_a = fixture([
        swap_log(pool=pool), transfer_log(token, 90, sender=BASE_MANAGER),
    ])
    tx_b, receipt_b = fixture([
        swap_log(pool=pool), transfer_log(token, 90, sender=BASE_MANAGER),
    ])
    receipt_a["blockNumber"] = hex(500_001)
    receipt_b["blockNumber"] = hex(500_002)
    init = init_row(BASE_MANAGER, pool, (ZERO, token), hex(1_000), "0xinit")
    queries = []
    resolve = limited_metadata_rpc(monkeypatch, init, queries)
    monkeypatch.setattr(receipt_mod, "MAX_LOOKBACK", 500_000)
    results = [None, None]

    for _ in range(4):
        for index, tx, receipt in (
            (0, tx_a, receipt_a),
            (1, tx_b, receipt_b),
        ):
            receipt_mod._pool_cache.clear()
            try:
                results[index] = classify_native_swaps(
                    "base", WALLET, tx, receipt, lambda _: 18, resolve,
                )
            except TimeoutError:
                pass
        if all(results):
            break

    assert all(results), "both anchor scans must make progress despite alternating retries"
    assert [event["qty_raw"] for events in results for event in events] == [90, 90]


def test_v4_lookup_yields_after_elapsed_budget_without_losing_progress(
    monkeypatch, metadata_lookup_state,
):
    token, pool = "0x" + "77" * 20, "0x" + "f5" * 32
    tx, receipt = fixture([
        swap_log(pool=pool), transfer_log(token, 90, sender=BASE_MANAGER),
    ])
    receipt["blockNumber"] = hex(20_000)
    init = init_row(BASE_MANAGER, pool, (ZERO, token), hex(500), "0xinit")
    queries, clock = [], [0.0]
    resolve = limited_metadata_rpc(monkeypatch, init, queries)
    monkeypatch.setattr(receipt_mod.time, "monotonic", lambda: clock[0])

    def slow_resolve(method, params):
        result = resolve(method, params)
        if len(queries) == 1:
            clock[0] += 3.0
        return result

    with pytest.raises(TimeoutError, match="metadata lookup pending"):
        classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, slow_resolve)
    assert queries == [(10_001, 20_000)]
    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, slow_resolve)
    assert [(event["ca"], event["qty_raw"]) for event in events] == [(token, 90)]
    assert queries[1] == (1, 10_000)


def test_v4_lookup_does_not_treat_quota_as_a_range_limit(
    monkeypatch, metadata_lookup_state,
):
    tx, receipt = fixture()
    queries = []

    def exhausted(url, payload=None, timeout=20, headers=None):
        queries.append(payload)
        return {"error": {"code": 429, "message": "Monthly capacity limit exceeded"}}

    monkeypatch.setattr(config, "http_json", exhausted)
    resolve = lambda method, params: rpc_mod.call(
        "base", method, params, ["https://metadata.example"], tries=1,
    )
    with pytest.raises(rpc_mod.RpcUnavailable) as info:
        classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolve)
    assert info.value.category == "quota"
    assert len(queries) == 1

def test_v4_output_above_swap_delta_skips_metadata_lookup():
    pool = "0x" + "f2" * 32
    token = "0x" + "7b" * 20
    tx, receipt = fixture([
        swap_log(manager=BASE_MANAGER, pool=pool),
        transfer_log(token, 100, sender=BASE_MANAGER),
    ])

    def unexpected_metadata_lookup(*_):
        raise AssertionError("unmatched wallet output must not query pool metadata")

    assert classify_native_swaps(
        "base", WALLET, tx, receipt, lambda _: 18, unexpected_metadata_lookup
    ) == []

def test_transfer_without_verified_matching_native_swap_is_not_a_buy():
    tx, receipt = fixture([transfer_log(BASE_TOKEN, 90)])
    assert classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18,
                                 resolver_for(BASE_MANAGER, BASE_POOL, init_row(BASE_MANAGER, BASE_POOL, (BASE_WETH, BASE_TOKEN), "0x80", "0xi"))) == []


def test_swap_without_wallet_transfer_or_pool_metadata_is_not_a_buy():
    tx, receipt = fixture([swap_log()])
    assert classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, lambda *_: []) == []


def test_unrelated_pool_swap_and_malformed_manager_log_are_rejected():
    tx, receipt = fixture([swap_log(pool="0x" + "34" * 32), transfer_log(BASE_TOKEN, 90)])
    init = init_row(BASE_MANAGER, BASE_POOL, (BASE_WETH, BASE_TOKEN), "0x80", "0xi")
    resolve = lambda *_: [init]
    assert classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolve) == []
    receipt["logs"][0] = {"address": BASE_MANAGER, "topics": [SWAP_TOPIC], "data": "0x"}
    assert classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolve) == []


def test_partial_wallet_output_is_clamped_to_receipt_delta():
    tx, receipt = fixture([swap_log(), transfer_log(BASE_TOKEN, 80, sender=BASE_MANAGER)])
    init = init_row(BASE_MANAGER, BASE_POOL, (BASE_WETH, BASE_TOKEN), "0x80", "0xi")
    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18,
                                   resolver_for(BASE_MANAGER, BASE_POOL, init))
    assert len(events) == 1 and events[0]["qty_raw"] == 80
    assert events[0]["quote_raw"] == 100




@pytest.mark.parametrize("chain", ("base", "bsc", "robinhood", "eth"))
def test_native_v4_buy_is_decoded_on_every_watched_chain(chain):
    manager = next(iter(POOL_MANAGERS[chain]))
    pool_id_byte = {"base": "a1", "bsc": "a2", "robinhood": "a3", "eth": "a4"}[chain]
    pool = "0x" + pool_id_byte * 32
    token = "0x" + "f0" * 20
    tx, receipt = fixture([
        swap_log(manager=manager, pool=pool),
        transfer_log(token, 90, sender=manager),
    ])
    init = init_row(manager, pool, (ZERO, token), "0x80", "0xi")
    events = classify_native_swaps(
        chain, WALLET, tx, receipt, lambda _: 18,
        resolver_for(manager, pool, init),
    )
    assert len(events) == 1
    assert (events[0]["side"], events[0]["ca"], events[0]["qty_raw"]) == (
        "BUY", token, 90
    )


@pytest.mark.parametrize("chain", ("base", "bsc", "robinhood", "eth"))
def test_native_v3_buy_is_decoded_on_every_watched_chain(chain):
    receipt_mod._v3_pool_cache.clear()
    wrapped = WRAPPED_NATIVE[chain]
    pool_byte = {"base": "b1", "bsc": "b2", "robinhood": "b3", "eth": "b4"}[chain]
    pool = "0x" + pool_byte * 20
    token = "0x" + "f0" * 20
    factory = sorted(V3_FACTORIES[chain])[0]
    deposit = {
        "address": wrapped,
        "topics": [BASE_DEPOSIT_TOPIC, topic_address(WALLET)],
        "data": "0x" + word(100),
    }
    swap = {
        "address": pool,
        "topics": [V3_SWAP_TOPIC, topic_address("0x" + "44" * 20), topic_address(WALLET)],
        "data": "0x" + "".join(signed(value) for value in (100, -90, 1, 1, 1)),
    }
    tx, receipt = fixture([deposit, swap, transfer_log(token, 90, sender=pool)])

    def resolver(method, params):
        selector = params[0]["data"]
        return {
            "0xc45a0155": topic_address(factory),
            "0x0dfe1681": topic_address(wrapped),
            "0xd21220a7": topic_address(token),
        }[selector]

    events = classify_native_swaps(chain, WALLET, tx, receipt, lambda _: 18, resolver)
    assert len(events) == 1 and events[0]["qty_raw"] == 90
def test_all_verified_pool_configs_cover_each_watched_chain():
    expected = {"base", "bsc", "eth", "robinhood"}
    assert expected <= POOL_MANAGERS.keys()
    assert expected <= V3_FACTORIES.keys()

def test_native_v3_buy_requires_canonical_factory_and_deposit_evidence():
    receipt_mod._v3_pool_cache.clear()
    pool = "0x" + "55" * 20
    factory = "0x33128a8fc17869897dce68ed026d694621f6fdfd"
    deposit = {
        "address": BASE_WETH,
        "topics": [BASE_DEPOSIT_TOPIC, topic_address(WALLET)],
        "data": "0x" + word(100),
    }
    swap = {
        "address": pool,
        "topics": [V3_SWAP_TOPIC, topic_address("0x" + "44" * 20), topic_address(WALLET)],
        "data": "0x" + "".join(signed(value) for value in (100, -90, 1, 1, 1)),
    }
    tx, receipt = fixture([deposit, swap, transfer_log(BASE_TOKEN, 90, sender=pool)])

    def resolver(method, params):
        assert method == "eth_call"
        selector = params[0]["data"]
        return {
            "0xc45a0155": topic_address(factory),
            "0x0dfe1681": topic_address(BASE_WETH),
            "0xd21220a7": topic_address(BASE_TOKEN),
        }[selector]

    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18, resolver)
    assert len(events) == 1
    assert (events[0]["side"], events[0]["ca"], events[0]["qty_raw"]) == (
        "BUY", BASE_TOKEN, 90
    )
    assert events[0]["quote_raw"] == 100
    assert events[0]["router"] == "uniswap-v3"


def test_native_v3_rejects_noncanonical_pool_factory():
    receipt_mod._v3_pool_cache.clear()
    pool = "0x" + "66" * 20
    deposit = {
        "address": BASE_WETH,
        "topics": [BASE_DEPOSIT_TOPIC, topic_address(WALLET)],
        "data": "0x" + word(100),
    }
    swap = {
        "address": pool,
        "topics": [V3_SWAP_TOPIC, topic_address("0x" + "44" * 20), topic_address(WALLET)],
        "data": "0x" + "".join(signed(value) for value in (100, -90, 1, 1, 1)),
    }
    tx, receipt = fixture([deposit, swap, transfer_log(BASE_TOKEN, 90, sender=pool)])
    calls = iter([
        topic_address("0x" + "77" * 20),
        topic_address(BASE_WETH),
        topic_address(BASE_TOKEN),
    ])
    assert classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18,
                                 lambda *_: next(calls)) == []


BASE_DEPOSIT_TOPIC = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"
BASE_ROUTER = "0x854048098dbe227355d43a433624695520ce3a91"
BASE_DEPOSIT = {"address": BASE_WETH, "topics": [BASE_DEPOSIT_TOPIC, topic_address(BASE_ROUTER)],
                "data": "0x00000000000000000000000000000000000000000000000006d904eabd95bec4"}
# Minimal receipt evidence copied from the cached production transaction records.
BASE_SWAP = {"address": BASE_MANAGER, "topics": [SWAP_TOPIC, BASE_POOL,
    "0x000000000000000000000000bf4195ab0b03e1eb3345dd1e83bed7650b1ed123"],
    "data": "0xfffffffffffffffffffffffffffffffffffffffffffffffff926fb15426a413c00000000000000000000000000000000000000000188386bff61d75df4b13c5200000000000000000000000000000000000078955043938c4b8c6a5038c791c000000000000000000000000000000000000000000000d1365991164c620b1de100000000000000000000000000000000000000000000000000000000000327a80000000000000000000000000000000000000000000000000000000000001b58"}
BASE_TRANSFER = {"address": BASE_TOKEN, "topics": [TRANSFER_TOPIC,
    topic_address(BASE_MANAGER), topic_address(WALLET)],
    "data": "0x00000000000000000000000000000000000000000185c4de85c93ad22b29ba58",
    "transactionHash": BASE_HASH, "blockNumber": BASE_BLOCK}
RH_SWAP = {"address": RH_MANAGER, "topics": [SWAP_TOPIC, RH_POOL,
    "0x00000000000000000000000092475293e578c7d88651d160d2b0e45e04e4528b"],
    "data": "0xfffffffffffffffffffffffffffffffffffffffffffffffffbf5f278dbacc000000000000000000000000000000000000000000000000000f2739d4eddd1f6720000000000000000000000000000000000000007c39f72d8fb9bb851c46b4b06000000000000000000000000000000000000000000000015230eb2eaabff0f13000000000000000000000000000000000000000000000000000000000000a0200000000000000000000000000000000000000000000000000000000000002710"}
RH_TRANSFER = {"address": RH_TOKEN, "topics": [TRANSFER_TOPIC,
    topic_address(RH_MANAGER), topic_address(WALLET)],
    "data": "0x000000000000000000000000000000000000000000000000f2739d4eddd1f672",
    "transactionHash": RH_HASH, "blockNumber": RH_BLOCK}


def real_fixture(chain):
    if chain == "base":
        tx = {"from": WALLET, "hash": BASE_HASH, "value": "0x6eab9fa0a7d6630"}
        receipt = {"status": "0x1", "blockNumber": BASE_BLOCK, "blockHash": BASE_BLOCK_HASH,
                   "transactionHash": BASE_HASH, "logs": [BASE_DEPOSIT, BASE_SWAP, BASE_TRANSFER]}
        init = init_row(BASE_MANAGER, BASE_POOL, (BASE_WETH, BASE_TOKEN), "0x32ab5dd", BASE_BLOCK_HASH)
        return tx, receipt, BASE_MANAGER, BASE_POOL, BASE_TOKEN, init, 471201832478218714648001112
    tx = {"from": WALLET, "hash": RH_HASH, "value": "0x429d069189e0000"}
    receipt = {"status": "0x1", "blockNumber": RH_BLOCK, "blockHash": RH_BLOCK_HASH,
               "transactionHash": RH_HASH, "logs": [RH_SWAP, RH_TRANSFER]}
    init = init_row(RH_MANAGER, RH_POOL, (ZERO, RH_TOKEN), RH_INIT_BLOCK, RH_BLOCK_HASH)
    return tx, receipt, RH_MANAGER, RH_POOL, RH_TOKEN, init, 17470480341554820722


def test_real_base_transaction_native_input_buy():
    tx, receipt, _, _, token, _, qty = real_fixture("base")
    events = classify_native_swaps("base", WALLET, tx, receipt, lambda _: 18,
                                   lambda *_: (_ for _ in ()).throw(AssertionError("unexpected historical Initialize lookup")))
    assert len(events) == 1 and events[0]["side"] == "BUY"
    assert events[0]["ca"] == token and events[0]["qty_raw"] == qty
    pool_output = int(BASE_SWAP["data"][66:130], 16)
    assert pool_output >= events[0]["qty_raw"]


def test_real_robinhood_transaction_native_input_buy():
    tx, receipt, manager, pool, token, init, qty = real_fixture("robinhood")
    events = classify_native_swaps("robinhood", WALLET, tx, receipt, lambda _: 18,
                                   resolver_for(manager, pool, init))
    assert len(events) == 1 and events[0]["side"] == "BUY"
    assert events[0]["ca"] == token and events[0]["qty_raw"] == qty


def test_real_transactions_reject_wrong_value_wallet_missing_init_and_failed_receipt():
    for chain in ("base", "robinhood"):
        tx, receipt, manager, pool, token, init, _ = real_fixture(chain)
        resolve = resolver_for(manager, pool, init)
        wrong_value = dict(tx, value="0x0")
        assert classify_native_swaps(chain, WALLET, wrong_value, receipt, lambda _: 18, resolve) == []
        assert classify_native_swaps(chain, "0x" + "11" * 20, tx, receipt, lambda _: 18, resolve) == []
        if chain == "robinhood":
            missing = dict(receipt, logs=[log for log in receipt["logs"] if log is not RH_SWAP])
            assert classify_native_swaps(chain, WALLET, tx, missing, lambda _: 18, lambda *_: []) == []
        failed = dict(receipt, status="0x0")
        assert classify_native_swaps(chain, WALLET, tx, failed, lambda _: 18, resolve) == []


def test_real_transactions_reject_bad_signed_abi_and_excess_wallet_output():
    for chain in ("base", "robinhood"):
        tx, receipt, manager, pool, token, init, _ = real_fixture(chain)
        resolve = resolver_for(manager, pool, init)
        swap = BASE_SWAP if chain == "base" else RH_SWAP
        rest = [log for log in receipt["logs"] if log is not swap]
        malformed = dict(receipt, logs=[dict(swap, data="0x00"), *rest])
        assert classify_native_swaps(chain, WALLET, tx, malformed, lambda _: 18, resolve) == []
        extra = dict(receipt, logs=receipt["logs"] + [transfer_log(token, 10**40)])
        assert classify_native_swaps(chain, WALLET, tx, extra, lambda _: 18, resolve) == []
