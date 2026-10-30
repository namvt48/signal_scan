#!/usr/bin/env python3
"""Đối chiếu BUY GMGN với watcher EVM; snapshot → scan → replay → apply → verify.

Chạy trên host có API/gateway và env của watcher. Mọi stage lưu artifact để resume;
replay không mở journal live, không gửi event và không thay đổi cursor của watcher.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from collections import Counter
from contextlib import closing
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
ADDRESS = re.compile(r"0x[0-9a-f]{40}\Z")
TX_HASH = re.compile(r"0x[0-9a-f]{64}\Z")


def save(path: Path, value: object) -> None:
    """Atomically persist private resumable data with owner-only permissions."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
        file.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def load(path: Path):
    return json.loads(path.read_text())


def readonly(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def rows(connection, query, params=()):
    return [dict(row) for row in connection.execute(query, params)]


def snapshot(args) -> None:
    """Đóng băng ví, cửa sổ và trade baseline trong một read transaction."""
    target = args.output / "baseline.json"
    if target.exists():
        print(json.dumps({"baseline": str(target), "reused": True}))
        return
    from watchers.evm.journal import CHAINS

    end = int(time.time())
    start = end - args.hours * 3600
    with closing(readonly(args.db)) as db:
        db.execute("BEGIN")
        wallets = rows(db, "SELECT * FROM wallets WHERE chain != 'sol' ORDER BY chain,address")
        chains = {wallet["chain"] for wallet in wallets}
        if not chains or chains - set(CHAINS):
            raise ValueError(f"Chain EVM chưa được watcher hỗ trợ: {sorted(chains - set(CHAINS))}")
        for wallet in wallets:
            if not ADDRESS.fullmatch(wallet["address"].lower()):
                raise ValueError(f"Ví EVM không hợp lệ: {wallet['id']}")
        trades = rows(db, "SELECT t.*,w.address AS wallet FROM wallet_trades t "
                      "JOIN wallets w ON w.id=t.wallet_id WHERE t.chain!='sol' AND t.ts>=? AND t.ts<?",
                      (start * 1000, end * 1000))
        cas = rows(db, "SELECT * FROM tracked_cas WHERE chain!='sol'")
    with closing(readonly(args.journal)) as db:
        cursors = rows(db, "SELECT * FROM cursors")
    ict = ZoneInfo("Asia/Ho_Chi_Minh")
    data = {"start": start, "end": end, "start_ict": datetime.fromtimestamp(start, ict).isoformat(),
            "end_ict": datetime.fromtimestamp(end, ict).isoformat(), "wallets": wallets,
            "trades": trades, "tracked_cas": cas, "cursors": cursors}
    save(target, data)
    print(json.dumps({"baseline": str(target), "start": data["start_ict"], "end": data["end_ict"],
                      "wallets_by_chain": dict(Counter(w["chain"] for w in wallets)),
                      "baseline_trades": len(trades)}))


def read_activity(payload):
    """Phân biệt page rỗng hợp lệ với lỗi business hoặc envelope sai."""
    if not isinstance(payload, dict) or payload.get("code", 0) != 0:
        raise ValueError("GMGN business error hoặc response không phải object")
    data = payload.get("data", payload)
    if not isinstance(data, dict) or not isinstance(data.get("activities"), list):
        raise ValueError("GMGN response thiếu activities[]")
    cursor = data.get("next")
    if cursor is not None and not isinstance(cursor, str):
        raise ValueError("GMGN next cursor không phải string")
    activities = []
    for row in data["activities"]:
        if not isinstance(row, dict):
            raise ValueError("GMGN activity không phải object")
        try:
            timestamp = float(row.get("timestamp"))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("GMGN activity thiếu timestamp hợp lệ") from exc
        if not math.isfinite(timestamp) or timestamp <= 0:
            raise ValueError("GMGN activity thiếu timestamp hợp lệ")
        if timestamp >= 100_000_000_000:
            timestamp /= 1000
        normalized = dict(row)
        normalized["timestamp"] = timestamp
        activities.append(normalized)
    return activities, cursor or ""


class GmgnRequestStop(RuntimeError):
    """Stop all GMGN calls on a shared quota, gate, or transport failure."""


def _is_shared_request_stop(error: Exception) -> bool:
    status = getattr(error, "code", None) or getattr(error, "status", None)
    message = str(error).lower()
    return (
        status in (400, 401, 403, 429, 503)
        or error.__class__.__name__ == "URLError"
        or isinstance(error, (TimeoutError, ConnectionError))
        or any(
            marker in message
            for marker in ("rate_limit", "rate limit", "upstream status 400",
                           "upstream status 401", "upstream status 403",
                           "upstream status 429", "gateway denied: gated",
                           "budget_exceeded")
        )
    )


def wallet_pages(args, baseline, wallet):
    """Phân trang BUY giảm dần; cursor lặp hoặc timestamp đảo là lỗi coverage."""
    from watchers.common import config

    folder = args.output / "activity" / wallet["chain"] / wallet["address"].lower()
    state_path = folder / "state.json"
    state = load(state_path) if state_path.exists() else {"pages": 0, "cursor": "", "complete": False}
    seen = set()
    previous_oldest = None
    for page_index in range(state["pages"]):
        page_path = folder / f"page-{page_index:05d}.json"
        if not page_path.exists():
            raise ValueError(f"Missing persisted GMGN page {page_index}")
        cached = load(page_path)
        seen.add(cached["request_cursor"])
        if cached["rows"]:
            previous_oldest = min(row["timestamp"] for row in cached["rows"])
    while not state["complete"]:
        cursor = state["cursor"]
        page_index = state["pages"]
        page_path = folder / f"page-{page_index:05d}.json"
        if page_path.exists():
            cached = load(page_path)
            if cached["request_cursor"] != cursor:
                raise ValueError("Uncommitted GMGN page cursor does not match checkpoint")
            page_rows, next_cursor = cached["rows"], cached["next"]
        else:
            if cursor in seen:
                raise ValueError("GMGN cursor lặp, pagination chưa hoàn tất")
            request = {"wallet": wallet["address"], "chain": wallet["chain"], "limit": 20, "priority": 2}
            if cursor:
                request["cursor"] = cursor
            try:
                payload = config.gateway_json("/v1/gmgn/wallet-activity", request, timeout=120)
            except Exception as exc:
                if _is_shared_request_stop(exc):
                    raise GmgnRequestStop(f"{type(exc).__name__}: {exc}") from exc
                raise
            page_rows, next_cursor = read_activity(payload)
            save(page_path, {"request_cursor": cursor, "rows": page_rows, "next": next_cursor})
        timestamps = [row["timestamp"] for row in page_rows]
        if timestamps != sorted(timestamps, reverse=True):
            raise ValueError("GMGN page không sắp xếp timestamp giảm dần")
        if timestamps and previous_oldest is not None and max(timestamps) > previous_oldest:
            raise ValueError("GMGN pagination vượt ngược timestamp page trước")
        if next_cursor and not timestamps:
            raise ValueError("GMGN page rỗng nhưng có next: không thể chứng minh coverage")
        complete = not next_cursor or bool(timestamps and min(timestamps) < baseline["start"])
        state = {"pages": page_index + 1, "cursor": next_cursor, "complete": complete,
                 "reason": "window_boundary" if timestamps and min(timestamps) < baseline["start"] else "end"}
        save(state_path, state)
        seen.add(cursor)
        previous_oldest = min(timestamps) if timestamps else previous_oldest
        if not complete:
            time.sleep(1)
    return state


def build_manifest(args, baseline, statuses):
    expected = {}
    for wallet in baseline["wallets"]:
        folder = args.output / "activity" / wallet["chain"] / wallet["address"].lower()
        for page in sorted(folder.glob("page-*.json")):
            for row in load(page)["rows"]:
                if not baseline["start"] <= row["timestamp"] < baseline["end"]:
                    continue
                if str(row.get("event_type", row.get("type", ""))).lower() != "buy":
                    continue
                token = row.get("token")
                if not isinstance(token, dict):
                    raise ValueError("GMGN BUY thiếu token object")
                tx = str(row.get("tx_hash", "")).lower()
                ca = str(token.get("address", "")).lower()
                if not TX_HASH.fullmatch(tx) or not ADDRESS.fullmatch(ca):
                    raise ValueError("BUY GMGN thiếu tx hash/CA hợp lệ")
                key = (wallet["chain"], tx, wallet["address"].lower(), ca)
                expected.setdefault(key, {"chain": key[0], "tx": tx, "wallet": key[2], "ca": ca,
                                          "timestamp": row["timestamp"], "symbol": token.get("symbol"),
                                          "gmgn_rows": []})["gmgn_rows"].append(row)
    transactions = {}
    for row in expected.values():
        key = (row["chain"], row["tx"])
        transactions.setdefault(key, {"chain": key[0], "tx": key[1], "expected": []})["expected"].append(row)
    manifest = {"start": baseline["start"], "end": baseline["end"], "wallet_statuses": statuses,
                "coverage_complete": all(s.get("complete") for s in statuses),
                "transactions": list(transactions.values()), "buy_events": len(expected)}
    save(args.output / "manifest.json", manifest)
    return manifest


def scan(args) -> None:
    """Tiếp tục quét tất cả ví, ghi cả lỗi thay vì biến lỗi thành 0 BUY."""
    baseline = load(args.output / "baseline.json")
    statuses = []
    for index, wallet in enumerate(baseline["wallets"]):
        stop = False
        try:
            state = wallet_pages(args, baseline, wallet)
            result = {"chain": wallet["chain"], "wallet": wallet["address"], **state}
        except Exception as exc:
            stop = isinstance(exc, GmgnRequestStop)
            result = {"chain": wallet["chain"], "wallet": wallet["address"], "complete": False,
                      "error": f"{type(exc).__name__}: {exc}"[:240]}
        statuses.append(result)
        print(json.dumps(result), flush=True)
        if stop:
            statuses.extend({"chain": pending["chain"], "wallet": pending["address"],
                             "complete": False, "not_scanned": True}
                            for pending in baseline["wallets"][index + 1:])
            break
    manifest = build_manifest(args, baseline, statuses)
    print(json.dumps({"unique_transactions": len(manifest["transactions"]), "buy_events": manifest["buy_events"],
                      "coverage_complete": manifest["coverage_complete"]}), flush=True)
    if not manifest["coverage_complete"]:
        raise SystemExit(2)


def configure_replay(args):
    """Cache RPC read-only riêng, ưu tiên receipt/metadata journal hiện có."""
    from watchers.evm import feed

    original = feed.evm_rpc
    live = readonly(args.journal)

    def cached_rpc(chain, method, params, tries=3):
        digest = hashlib.sha256(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
        path = args.output / "rpc" / chain / f"{digest}.json"
        if path.exists():
            return load(path)["result"]
        kind = {"eth_getTransactionReceipt": "receipt", "eth_getTransactionByHash": "transaction"}.get(method)
        key = params[0] if kind else None
        if method == "eth_call" and params[0].get("data") == "0x313ce567":
            kind, key = "decimals", params[0]["to"].lower()
        row = live.execute("SELECT value FROM cache WHERE chain=? AND tx=? AND kind=?",
                           (chain, key, kind)).fetchone() if kind else None
        if row:
            value = json.loads(row["value"])
            value = hex(value) if kind == "decimals" else value
        else:
            value = original(chain, method, params, tries=tries)
        if value is None:
            raise RuntimeError(f"RPC {chain}:{method} trả null")
        save(path, {"method": method, "params": params, "result": value})
        return value

    feed.evm_rpc = cached_rpc
    return feed, live


def replay(args) -> None:
    """Chạy chính process_tx trong process độc lập; capture emit, không ghi production."""
    feed, live = configure_replay(args)
    manifest = load(args.output / "manifest.json")
    capture = []

    def capture_event(event, ts_unix):
        captured = {**event, "ts_unix": ts_unix}
        capture.append(captured)
        return captured

    feed.emit_swap = capture_event
    for tx in manifest["transactions"]:
        if args.chain and tx["chain"] != args.chain:
            continue
        path = args.output / "replay" / tx["chain"] / f"{tx['tx']}.json"
        if path.exists() and load(path).get("status") == "ok":
            continue
        capture.clear()
        try:
            transaction = feed.evm_rpc(tx["chain"], "eth_getTransactionByHash", [tx["tx"]])
            if str(transaction.get("hash", "")).lower() != tx["tx"]:
                raise ValueError("RPC trả transaction hash sai")
            block = int(transaction["blockNumber"], 16)
            feed.process_tx(tx["chain"], {"tx": tx["tx"], "block": block,
                                           "blockHash": transaction["blockHash"]},
                            {event["wallet"] for event in tx["expected"]}, transaction=transaction)
            result = {"status": "ok", "chain": tx["chain"], "tx": tx["tx"], "block": block,
                      "blockHash": transaction["blockHash"], "events": list(capture)}
        except Exception as exc:
            result = {"status": "error", "chain": tx["chain"], "tx": tx["tx"], "events": list(capture),
                      "error": f"{type(exc).__name__}: {exc}"[:300]}
        save(path, result)
        print(json.dumps({k: v for k, v in result.items() if k != "events"}), flush=True)
    live.close()
    compare(args)


def cached_rpc(args, chain, method, params):
    digest = hashlib.sha256(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
    path = args.output / "rpc" / chain / f"{digest}.json"
    return load(path).get("result") if path.exists() else None


def receipt_confirms_buy(args, event):
    """Require a successful sender-matched tx and an incoming positive CA transfer."""
    from watchers.evm.classify import decode_transfer_log

    tx_hash = event["tx"].lower()
    wallet = event["wallet"].lower()
    ca = event["ca"].lower()
    transaction = cached_rpc(args, event["chain"], "eth_getTransactionByHash", [tx_hash])
    receipt = cached_rpc(args, event["chain"], "eth_getTransactionReceipt", [tx_hash])
    if not isinstance(transaction, dict) or not isinstance(receipt, dict):
        return False
    if str(transaction.get("hash", "")).lower() != tx_hash:
        return False
    if str(transaction.get("from", "")).lower() != wallet:
        return False
    if str(receipt.get("transactionHash", "")).lower() != tx_hash or receipt.get("status") != "0x1":
        return False
    if transaction.get("blockNumber") != receipt.get("blockNumber"):
        return False
    return any(
        decoded["ca"] == ca and decoded["to"] == wallet and decoded["value"] > 0
        for log in receipt.get("logs", [])
        if (decoded := decode_transfer_log(log)) is not None
    )


def identity(event):
    return tuple(str(event[key]).lower() for key in ("chain", "tx", "wallet", "ca"))


def compare(args) -> None:
    """Compare the immutable pre-scan snapshot with production immediately before apply."""
    baseline = load(args.output / "baseline.json")
    manifest = load(args.output / "manifest.json")
    known = {identity(row) for row in baseline["trades"] if row["side"] == "buy"}
    initial_cas = {(row["chain"], row["address"].lower()) for row in baseline["tracked_cas"]}
    summary = {"coverage_complete": manifest["coverage_complete"], "chains": {}, "events": []}
    for wallet in baseline["wallets"]:
        summary["chains"].setdefault(wallet["chain"], {
            "wallets": 0, "gmgn_buys": 0, "baseline_present": 0, "present_before_apply": 0,
            "replay_matches": 0, "receipt_matches": 0, "unverified": 0,
            "replay_missing": 0, "replay_errors": 0,
            "pending_candidates": 0, "pending_deliveries": 0, "missing_cas": 0,
        })["wallets"] += 1
    with closing(readonly(args.db)) as api_db, closing(readonly(args.journal)) as journal_db:
        api_db.execute("BEGIN")
        journal_db.execute("BEGIN")
        tx_state = {}
        for tx in manifest["transactions"]:
            tx_key = (tx["chain"], tx["tx"])
            path = args.output / "replay" / tx["chain"] / f"{tx['tx']}.json"
            result = load(path) if path.exists() else {"status": "not_replayed", "events": []}
            found = {identity(row) for row in result["events"] if row["side"].lower() == "buy"}
            counts = summary["chains"][tx["chain"]]
            if tx_key not in tx_state:
                candidate = journal_db.execute(
                    "SELECT chain,tx,block,status,reason,attempts FROM candidates "
                    "WHERE chain=? AND tx=? ORDER BY block DESC LIMIT 1", tx_key
                ).fetchone()
                processed = journal_db.execute(
                    "SELECT 1 FROM processed WHERE chain=? AND tx=? LIMIT 1", tx_key
                ).fetchone()
                tx_state[tx_key] = {
                    "candidate": dict(candidate) if candidate else None,
                    "processed": processed is not None,
                }
            for event in tx["expected"]:
                event_key = identity(event)
                matches = event_key in found
                receipt_match = not matches and receipt_confirms_buy(args, event)
                trade = api_db.execute(
                    "SELECT 1 FROM wallet_trades t JOIN wallets w ON w.id=t.wallet_id "
                    "WHERE t.chain=? AND t.tx=? AND t.side='buy' AND lower(t.ca)=? "
                    "AND lower(w.address)=? LIMIT 1",
                    (event_key[0], event_key[1], event_key[3], event_key[2]),
                ).fetchone()
                ca = api_db.execute(
                    "SELECT 1 FROM tracked_cas WHERE chain=? AND lower(address)=? LIMIT 1",
                    (event_key[0], event_key[3]),
                ).fetchone()
                pending_delivery = journal_db.execute(
                    "SELECT 1 FROM outbox WHERE chain=? AND wallet=? AND ca=? AND tx=? "
                    "AND side='buy' AND delivered=0 LIMIT 1",
                    (event_key[0], event_key[2], event_key[3], event_key[1]),
                ).fetchone() is not None
                state = tx_state[tx_key]
                pending_candidate = state["candidate"] is not None and state["candidate"]["status"] == "pending"
                present_before_apply = trade is not None
                ca_was_tracked = ca is not None
                counts["gmgn_buys"] += 1
                counts["baseline_present"] += event_key in known
                counts["present_before_apply"] += present_before_apply
                counts["replay_matches"] += matches
                counts["receipt_matches"] += receipt_match
                counts["unverified"] += not (matches or receipt_match)
                counts["replay_missing"] += not (matches or receipt_match)
                counts["replay_errors"] += result["status"] != "ok"
                counts["pending_candidates"] += pending_candidate
                counts["pending_deliveries"] += pending_delivery
                counts["missing_cas"] += not ca_was_tracked
                summary["events"].append({
                    "chain": event_key[0], "tx": event_key[1], "wallet": event_key[2], "ca": event_key[3],
                    "symbol": event["symbol"], "baseline_present": event_key in known,
                    "present_before_apply": present_before_apply,
                    "ca_was_tracked_at_snapshot": (event_key[0], event_key[3]) in initial_cas,
                    "ca_was_tracked": ca_was_tracked, "replay_match": matches,
                    "receipt_match": receipt_match,
                    "replay_status": result["status"], "error": result.get("error"),
                    "candidate_before_apply": state["candidate"],
                    "processed_before_apply": state["processed"],
                    "outbox_pending_before_apply": pending_delivery,
                })
    save(args.output / "comparison.json", summary)
    print(json.dumps({"coverage_complete": summary["coverage_complete"], "chains": summary["chains"]}), flush=True)


def backup_db(args) -> str:
    """SQLite online backup trước mọi đợt ingest; không copy file WAL riêng lẻ."""
    destination = args.output / f"pre-apply-{time.time_ns()}.sqlite3"
    with closing(readonly(args.db)) as source, closing(sqlite3.connect(destination)) as backup:
        source.backup(backup)
        if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Backup DB không vượt integrity_check")
        backup.commit()
    os.chmod(destination, 0o600)
    return str(destination)


def apply(args) -> None:
    """Chỉ ingest BUY được cả GMGN và watcher xác nhận; không price/alert lịch sử giả."""
    from watchers.common import config

    comparison = load(args.output / "comparison.json")
    if not comparison["coverage_complete"]:
        raise RuntimeError("GMGN scan incomplete; từ chối apply")
    unmatched = [event for event in comparison["events"]
                 if not event["replay_match"] and not event["receipt_match"]]
    if unmatched:
        raise RuntimeError(f"Parser/receipt chưa xác nhận {len(unmatched)} BUY; từ chối apply")
    baseline_needed = {
        identity(event)
        for event in comparison["events"]
        if not event["present_before_apply"] or not event["ca_was_tracked"]
    }
    backup = backup_db(args)
    results = []
    evidence_by_key = {identity(event): event for event in comparison["events"]}
    for tx in load(args.output / "manifest.json")["transactions"]:
        path = args.output / "replay" / tx["chain"] / f"{tx['tx']}.json"
        decoded = load(path)
        parsed = {identity(event): event for event in decoded["events"] if event["side"].lower() == "buy"}
        for expected in tx["expected"]:
            key = identity(expected)
            evidence = evidence_by_key[key]
            if key not in baseline_needed:
                continue
            event = parsed.get(key)
            timestamp = event["ts_unix"] if event else expected["timestamp"]
            body = {"chain": expected["chain"], "wallet": expected["wallet"], "ca": expected["ca"],
                    "tx": expected["tx"], "ts": int(timestamp * 1000), "side": "buy", "provenance": "historical"}
            response = config.http_json(f"{args.api_url}/api/wallet-watch/trades", body,
                                        timeout=30, headers=config.api_headers())
            inserted = response.get("inserted") if isinstance(response, dict) else None
            if not isinstance(response, dict) or not (
                (isinstance(inserted, int) and not isinstance(inserted, bool))
                or response.get("skipped") == "pass-tier"
            ):
                raise ValueError("Ingest response không hợp lệ")
            results.append({**body, "verification": "parser" if event else "receipt+gmgn",
                            "response": response})
            save(args.output / "apply.json", {"backup": backup, "coverage_complete": True,
                                               "results": results})
    save(args.output / "apply.json", {"backup": backup, "coverage_complete": True, "results": results})
    print(json.dumps({"backup": backup, "posted": len(results),
                      "inserted": sum(row["response"].get("inserted", 0) for row in results)}))


def verify(args) -> None:
    """Đọc DB sau ingest, xác minh trade unique và CA queue cho từng BUY."""
    applied = load(args.output / "apply.json")
    verified = []
    with closing(readonly(args.db)) as db:
        for row in applied["results"]:
            trades = rows(db, "SELECT t.* FROM wallet_trades t JOIN wallets w ON w.id=t.wallet_id "
                          "WHERE t.chain=? AND lower(w.address)=? AND lower(t.ca)=? AND lower(t.tx)=? "
                          "AND t.side='buy'",
                          (row["chain"], row["wallet"], row["ca"], row["tx"]))
            cas = rows(db, "SELECT * FROM tracked_cas WHERE chain=? AND lower(address)=?",
                       (row["chain"], row["ca"]))
            skipped = row["response"].get("skipped") == "pass-tier"
            ok = skipped or (len(trades) == 1 and len(cas) == 1)
            verified.append({"chain": row["chain"], "tx": row["tx"], "ca": row["ca"], "wallet": row["wallet"],
                             "trade_count": len(trades), "ca_count": len(cas), "pass_tier": skipped, "ok": ok})
    save(args.output / "verification.json", {"all_ok": all(row["ok"] for row in verified), "events": verified})
    print(json.dumps({"verified_events": len(verified), "all_ok": all(row["ok"] for row in verified)}))
    if not all(row["ok"] for row in verified):
        raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("snapshot", "scan", "replay", "compare", "apply", "verify"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--db", default="/root/signal_scan/data/signal_scan.db")
    parser.add_argument("--journal", default="/opt/fomo-wallet-watch/data/evm_watch_journal.sqlite3")
    parser.add_argument("--api-url", default="http://127.0.0.1:8124")
    parser.add_argument("--hours", type=int, default=12)
    parser.add_argument("--chain", choices=("base", "bsc", "eth", "robinhood"))
    parser.add_argument("--watcher-pid", type=int)
    args = parser.parse_args()
    if args.hours <= 0:
        parser.error("--hours phải >0")
    if args.watcher_pid:
        entries = Path(f"/proc/{args.watcher_pid}/environ").read_bytes().split(b"\0")
        for entry in entries:
            if b"=" in entry:
                key, value = entry.split(b"=", 1)
                os.environ[key.decode()] = value.decode()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(args.output, 0o700)
    globals()[args.stage](args)


if __name__ == "__main__":
    main()
