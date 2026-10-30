from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backfill_evm_gmgn_buys as backfill

WALLET = "0x" + "1" * 40
OTHER_WALLET = "0x" + "2" * 40
TX = "0x" + "a" * 64
CA = "0x" + "b" * 40


def activity(timestamp, tx=TX, ca=CA, event_type="buy"):
    return {"timestamp": timestamp, "tx_hash": tx, "event_type": event_type,
            "token": {"address": ca, "symbol": "TOKEN"}}


def test_read_activity_normalizes_millisecond_timestamps_and_preserves_cursor():
    rows, cursor = backfill.read_activity({"data": {"activities": [activity(1_800_000_000_000)], "next": "c1"}})

    assert rows[0]["timestamp"] == 1_800_000_000
    assert cursor == "c1"


def test_read_activity_rejects_infinite_timestamps():
    with pytest.raises(ValueError, match="timestamp hợp lệ"):
        backfill.read_activity({"data": {"activities": [activity(float("inf"))]}})


def test_wallet_pages_resumes_page_written_before_checkpoint(tmp_path, monkeypatch):
    folder = tmp_path / "activity" / "base" / WALLET
    folder.mkdir(parents=True)
    backfill.save(folder / "page-00000.json", {
        "request_cursor": "", "rows": [activity(190), activity(180)], "next": "c1"
    })
    calls = []
    second_page = {"data": {"activities": [activity(90)], "next": ""}}
    monkeypatch.setattr("watchers.common.config.gateway_json", lambda path, body, timeout: calls.append(body) or second_page)
    monkeypatch.setattr(backfill.time, "sleep", lambda _: None)

    state = backfill.wallet_pages(SimpleNamespace(output=tmp_path), {"start": 100},
                                 {"chain": "base", "address": WALLET})

    assert state["complete"] is True
    assert state["pages"] == 2
    assert len(calls) == 1
    assert calls[0]["cursor"] == "c1"
    assert (folder / "page-00001.json").exists()


def test_wallet_pages_stops_for_shared_rate_limit(tmp_path, monkeypatch):
    calls = []

    def rate_limited(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("gateway upstream status 429")

    monkeypatch.setattr("watchers.common.config.gateway_json", rate_limited)

    with pytest.raises(backfill.GmgnRequestStop):
        backfill.wallet_pages(SimpleNamespace(output=tmp_path), {"start": 100},
                              {"chain": "base", "address": WALLET})
    assert len(calls) == 1

def test_scan_stops_all_remaining_wallets_on_upstream_bad_request(tmp_path, monkeypatch):
    backfill.save(tmp_path / "baseline.json", {
        "start": 100, "end": 200,
        "wallets": [{"chain": "base", "address": WALLET},
                    {"chain": "base", "address": OTHER_WALLET}],
    })
    calls = []

    def bad_request(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("gateway upstream status 400")

    monkeypatch.setattr("watchers.common.config.gateway_json", bad_request)
    args = SimpleNamespace(output=tmp_path)

    with pytest.raises(SystemExit) as stopped:
        backfill.scan(args)

    assert stopped.value.code == 2
    assert calls == [1]
    manifest = backfill.load(tmp_path / "manifest.json")
    assert manifest["coverage_complete"] is False
    assert manifest["wallet_statuses"][1]["not_scanned"] is True


def test_manifest_deduplicates_same_wallet_ca_tx_but_keeps_other_wallet(tmp_path):
    baseline = {"start": 100, "end": 200, "wallets": [
        {"chain": "base", "address": WALLET}, {"chain": "base", "address": OTHER_WALLET}
    ]}
    for wallet, rows in ((WALLET, [activity(150), activity(150)]),
                         (OTHER_WALLET, [activity(151)])):
        folder = tmp_path / "activity" / "base" / wallet
        backfill.save(folder / "page-00000.json", {"request_cursor": "", "rows": rows, "next": ""})

    manifest = backfill.build_manifest(SimpleNamespace(output=tmp_path), baseline,
                                       [{"wallet": WALLET, "complete": True},
                                        {"wallet": OTHER_WALLET, "complete": True}])

    assert manifest["buy_events"] == 2
    assert len(manifest["transactions"]) == 1
    assert len(manifest["transactions"][0]["expected"]) == 2
    assert len(manifest["transactions"][0]["expected"][0]["gmgn_rows"]) == 2


def test_manifest_ignores_non_buy_rows(tmp_path):
    baseline = {"start": 100, "end": 200, "wallets": [{"chain": "base", "address": WALLET}]}
    folder = tmp_path / "activity" / "base" / WALLET
    backfill.save(folder / "page-00000.json", {"request_cursor": "", "rows": [activity(150, event_type="transferIn")], "next": ""})

    manifest = backfill.build_manifest(SimpleNamespace(output=tmp_path), baseline, [{"complete": True}])

    assert manifest["buy_events"] == 0
    assert manifest["coverage_complete"] is True


def test_apply_refuses_unverified_replay_before_backup(tmp_path):
    backfill.save(tmp_path / "comparison.json", {
        "coverage_complete": True,
        "events": [{"replay_match": False, "receipt_match": False}],
    })
    args = SimpleNamespace(output=tmp_path, db=str(tmp_path / "missing.db"))

    with pytest.raises(RuntimeError, match="Parser/receipt chưa xác nhận"):
        backfill.apply(args)

    assert not list(tmp_path.glob("pre-apply-*.sqlite3"))


def test_receipt_confirmation_requires_successful_matching_tx_and_ca_transfer(tmp_path):
    args = SimpleNamespace(output=tmp_path)
    from watchers.evm.classify import TRANSFER_TOPIC

    topic = TRANSFER_TOPIC
    transfer = {
        "transactionHash": TX, "blockNumber": "0x1", "address": CA,
        "topics": [topic, "0x" + "0" * 24 + OTHER_WALLET[2:],
                   "0x" + "0" * 24 + WALLET[2:]],
        "data": "0x" + "0" * 63 + "1",
    }
    values = {
        "eth_getTransactionByHash": {"hash": TX, "from": WALLET, "blockNumber": "0x1"},
        "eth_getTransactionReceipt": {"transactionHash": TX, "status": "0x1",
                                      "blockNumber": "0x1", "logs": [transfer]},
    }
    for method, value in values.items():
        digest = backfill.hashlib.sha256(
            backfill.json.dumps([method, [TX]], sort_keys=True).encode()
        ).hexdigest()
        backfill.save(tmp_path / "rpc" / "base" / f"{digest}.json", {"result": value})
    event = {"chain": "base", "tx": TX, "wallet": WALLET, "ca": CA}

    assert backfill.receipt_confirms_buy(args, event)

    values["eth_getTransactionReceipt"]["status"] = "0x0"
    digest = backfill.hashlib.sha256(
        backfill.json.dumps(["eth_getTransactionReceipt", [TX]], sort_keys=True).encode()
    ).hexdigest()
    backfill.save(tmp_path / "rpc" / "base" / f"{digest}.json",
                  {"result": values["eth_getTransactionReceipt"]})
    assert not backfill.receipt_confirms_buy(args, event)


def prepare_apply(tmp_path, ca_tracked):
    db_path = tmp_path / "api.db"
    sqlite3.connect(db_path).close()
    event = {"chain": "base", "tx": TX, "wallet": WALLET, "ca": CA,
             "side": "buy", "ts_unix": 150}
    backfill.save(tmp_path / "comparison.json", {
        "coverage_complete": True,
        "events": [{**event, "replay_status": "ok", "replay_match": True,
                    "present_before_apply": True, "ca_was_tracked": ca_tracked}],
    })
    backfill.save(tmp_path / "manifest.json", {
        "transactions": [{"chain": "base", "tx": TX, "expected": [event]}],
    })
    replay = tmp_path / "replay" / "base" / f"{TX}.json"
    backfill.save(replay, {"events": [event]})
    return SimpleNamespace(output=tmp_path, db=str(db_path), api_url="http://api")


def test_apply_backfills_receipt_verified_buy_when_parser_is_blocked(tmp_path, monkeypatch):
    from watchers.common import config

    db_path = tmp_path / "api.db"
    sqlite3.connect(db_path).close()
    event = {"chain": "base", "tx": TX, "wallet": WALLET, "ca": CA,
             "side": "buy", "timestamp": 150}
    backfill.save(tmp_path / "comparison.json", {
        "coverage_complete": True,
        "events": [{**event, "replay_match": False, "receipt_match": True,
                    "present_before_apply": True, "ca_was_tracked": False}],
    })
    backfill.save(tmp_path / "manifest.json", {
        "transactions": [{"chain": "base", "tx": TX, "expected": [event]}],
    })
    backfill.save(tmp_path / "replay" / "base" / f"{TX}.json", {"events": []})
    calls = []
    monkeypatch.setattr(config, "http_json",
                        lambda url, body, **kwargs: calls.append(body) or {"inserted": 1})
    monkeypatch.setattr(config, "api_headers", lambda: {})

    backfill.apply(SimpleNamespace(output=tmp_path, db=str(db_path), api_url="http://api"))

    assert calls[0]["ts"] == 150_000
    assert backfill.load(tmp_path / "apply.json")["results"][0]["verification"] == "receipt+gmgn"


def test_apply_does_not_repost_trade_and_ca_already_present(tmp_path, monkeypatch):
    from watchers.common import config

    calls = []
    monkeypatch.setattr(config, "http_json", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(config, "api_headers", lambda: {})
    args = prepare_apply(tmp_path, ca_tracked=True)

    backfill.apply(args)

    assert calls == []


def test_apply_submits_historical_buy_without_fabricating_price_or_amount(tmp_path, monkeypatch):
    from watchers.common import config

    calls = []

    def record(url, body, **kwargs):
        calls.append((url, body))
        return {"inserted": 0}

    monkeypatch.setattr(config, "http_json", record)
    monkeypatch.setattr(config, "api_headers", lambda: {})
    args = prepare_apply(tmp_path, ca_tracked=False)

    backfill.apply(args)

    assert len(calls) == 1
    assert calls[0][0] == "http://api/api/wallet-watch/trades"
    assert calls[0][1]["side"] == "buy"
    assert calls[0][1]["provenance"] == "historical"
    assert "amountUsd" not in calls[0][1]
    assert "price" not in calls[0][1]
