#!/usr/bin/env python3
"""Read-only audit and guarded repair plan for Solana multi-hop wallet trades."""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator

TOLERANCE = 1e-8


def event_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.iterdir() if p.is_file() and
                  (p.name.endswith(".jsonl") or p.name.endswith(".jsonl.gz")))


def records(directory: Path) -> Iterator[tuple[str, int, dict[str, Any]]]:
    for path in event_files(directory):
        opener = gzip.open if path.name.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as stream:
            for line_no, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError(f"{path}:{line_no}: event is not an object")
                yield str(path), line_no, value


def finite_nonnegative(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        return None
    result = float(value)
    return result if math.isfinite(result) and result >= 0 else None


def close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=TOLERANCE, abs_tol=TOLERANCE)


def table_rows(conn: sqlite3.Connection) -> tuple[list[dict[str, Any]], dict[str, str]]:
    info = conn.execute("PRAGMA table_info(wallet_trades)").fetchall()
    if not info:
        raise ValueError("wallet_trades table not found")
    cols = {r[1].lower(): r[1] for r in info}
    def choose(*names: str) -> str:
        for name in names:
            if name in cols:
                return cols[name]
        raise ValueError(f"wallet_trades missing expected column among {names}")
    mapping = {"id": choose("id"), "wallet_id": choose("wallet_id"),
               "ca": choose("ca", "mint", "token_address"), "chain": choose("chain"),
               "tx": choose("tx", "signature", "sig"), "side": choose("side"),
               "amount": choose("amount_usd", "amountusd"), "price": choose("price"),
               "source": choose("source")}
    wallet_info = conn.execute("PRAGMA table_info(wallets)").fetchall()
    wallet_cols = {r[1].lower(): r[1] for r in wallet_info}
    if "id" not in wallet_cols or "address" not in wallet_cols:
        raise ValueError("wallets table must contain id and address")
    names = ",".join('wt."' + x.replace('"', '""') + '"' for x in mapping.values())
    rows = [dict(zip(mapping, row[:-1])) | {"wallet": row[-1]} for row in conn.execute(
        f'SELECT {names}, w."{wallet_cols["address"]}" FROM wallet_trades wt '
        f'JOIN wallets w ON wt."{mapping["wallet_id"]}"=w."{wallet_cols["id"]}"'
    )]
    return rows, mapping


def audit(db: Path, events_dir: Path) -> dict[str, Any]:
    uri = f"file:{db.resolve()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows, mapping = table_rows(conn)
    finally:
        conn.close()
    # Dedupe identity exactly mirrors watcher _emitted; same identity with different
    # values is quarantined rather than letting delivery order determine the result.
    identities: dict[tuple[Any, ...], dict[str, Any]] = {}
    conflicts: set[tuple[Any, ...]] = set()
    malformed: list[dict[str, Any]] = []
    for file, line, e in records(events_dir):
        if e.get("type") != "SWAP" or not ((e.get("side") == "BUY" and finite_nonnegative(e.get("qty_net")) is not None and e.get("qty_net") > 0) or e.get("side") == "SELL"):
            continue
        ident = (e.get("sig"), e.get("wallet"), e.get("mint"), e.get("side"), e.get("step"))
        if (not all(isinstance(x, str) and x for x in ident[:4])
                or isinstance(ident[4], bool) or not isinstance(ident[4], int)):
            malformed.append({"file": file, "line": line, "reason": "missing identity or invalid step"})
            continue
        normalized = {"event": e, "file": file, "line": line}
        prior = identities.get(ident)
        if prior is not None:
            old = prior["event"]
            fields = ("qty", "quote_usd", "ts_epoch_ms", "qty_net")
            if any(old.get(k) != e.get(k) for k in fields):
                conflicts.add(ident)
        else:
            identities[ident] = normalized
    grouped: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    unknown: set[tuple[str, str, str, str]] = set()
    for ident, item in identities.items():
        e = item["event"]
        key = (e["wallet"], e["mint"], e["sig"], e["side"].lower())
        grouped[key].append(item)
        if ident in conflicts or finite_nonnegative(e.get("qty")) is None or finite_nonnegative(e.get("quote_usd")) is None:
            unknown.add(key)
    groups_by_row: dict[Any, list[tuple[tuple[str, str, str, str], list[dict[str, Any]]]]] = defaultdict(list)
    excluded = defaultdict(int)
    matched = 0
    identity_index: dict[tuple[str, str, str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        identity_index[(str(row["wallet"]), str(row["ca"]), str(row["tx"]),
                        str(row["chain"]).lower(), str(row["side"]).lower(),
                        str(row["source"]).lower())].append(row)
    for key, hops in grouped.items():
        wallet, mint, sig, side = key
        matches = identity_index.get((wallet, mint, sig, "sol", side, "watch"), [])
        if len(matches) != 1:
            excluded["unmatched" if not matches else "ambiguous_match"] += 1
            continue
        matched += 1
        groups_by_row[matches[0]["id"]].append((key, hops))
    proposals = []
    for row in rows:
        candidates = groups_by_row.get(row["id"], [])
        if not candidates:
            continue
        if len(candidates) != 1:
            excluded["ambiguous_group"] += 1
            continue
        key, hops = candidates[0]
        if key in unknown:
            excluded["unknown_or_conflicting"] += 1
            continue
        if len(hops) < 2:
            excluded["single_hop"] += 1
            continue
        qtys = [float(x["event"]["qty"]) for x in hops]
        usds = [float(x["event"]["quote_usd"]) for x in hops]
        stamps = [x["event"].get("ts_epoch_ms") for x in hops]
        if any(not isinstance(t, (int, float)) or isinstance(t, bool) for t in stamps) or len(set(stamps)) != 1:
            excluded["timestamp_inconsistent"] += 1
            continue
        old_amount = finite_nonnegative(row["amount"])
        total_qty, total_usd = sum(qtys), sum(usds)
        if old_amount is None or not any(close(old_amount, v) for v in usds):
            excluded["old_amount_not_individual_hop"] += 1
            continue
        if close(old_amount, total_usd) or total_qty <= 0 or total_usd < 0:
            excluded["not_repairable"] += 1
            continue
        proposals.append({"id": row["id"], "wallet": key[0], "ca": key[1], "tx": key[2], "side": key[3],
                          "old_amount_usd": row["amount"], "old_price": row["price"],
                          "proposed_amount_usd": total_usd, "proposed_price": total_usd / total_qty,
                          "hop_evidence": [{"step": x["event"].get("step"), "qty": q, "quote_usd": u,
                                            "ts_epoch_ms": x["event"].get("ts_epoch_ms"), "file": x["file"], "line": x["line"]}
                                           for x, q, u in zip(hops, qtys, usds)]})
    return {"version": 1, "db": str(db.resolve()), "events_dir": str(events_dir.resolve()),
            "counts": {"rows_examined": len(rows), "matched_evidence": matched,
                       "candidate_rows": len(proposals), "candidate_unique_cas": len({p["ca"] for p in proposals}),
                       "unknown_or_conflicting_groups": sum(v for k, v in excluded.items() if k == "unknown_or_conflicting"),
                       "conflicting_duplicate_identities": len(conflicts), "unmatched_groups": excluded["unmatched"],
                       "excluded": dict(excluded), "malformed_events": len(malformed)},
            "proposals": proposals, "conflicts": [{"sig": k[0], "wallet": k[1], "mint": k[2], "side": k[3], "step": k[4]} for k in sorted(conflicts, key=str)],
            "malformed": malformed}


def apply_plan(db: Path, events_dir: Path, plan_path: Path) -> int:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("version") != 1 or plan.get("db") != str(db.resolve()):
        raise ValueError("plan version/database mismatch")
    fresh = audit(db, events_dir)
    if plan.get("proposals") != fresh["proposals"]:
        raise ValueError(
            "plan does not match fresh audit; refusing apply (reapplying a completed "
            "plan fails closed because the original amount no longer matches a hop)"
        )
    backup = db.with_name(db.name + ".pre-hop-reconcile.bak")
    if backup.exists():
        raise FileExistsError(f"backup already exists: {backup}")
    src = sqlite3.connect(f"file:{db.resolve()}?mode=ro", uri=True)
    dst = sqlite3.connect(backup)
    try:
        src.backup(dst)
        dst.commit()
        if dst.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError(f"SQLite backup integrity check failed: {backup}")
    finally:
        dst.close()
        src.close()
    conn = sqlite3.connect(db)
    try:
        conn.execute("BEGIN IMMEDIATE")
        rows, m = table_rows(conn)
        by_id = {r["id"]: r for r in rows}
        for p in plan["proposals"]:
            row = by_id.get(p["id"])
            if row is None:
                raise ValueError(f"row {p['id']} disappeared")
            if close(float(row["amount"]), p["proposed_amount_usd"]) and close(float(row["price"]), p["proposed_price"]):
                continue
            if row["amount"] != p["old_amount_usd"] or row["price"] != p["old_price"]:
                raise ValueError(f"row {p['id']} changed since plan")
            q = f'UPDATE wallet_trades SET "{m["amount"]}"=?, "{m["price"]}"=? WHERE "{m["id"]}"=? AND "{m["amount"]}" IS ? AND "{m["price"]}" IS ?'
            cur = conn.execute(q, (p["proposed_amount_usd"], p["proposed_price"], p["id"], p["old_amount_usd"], p["old_price"]))
            if cur.rowcount != 1:
                raise ValueError(f"conditional update failed for row {p['id']}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return len(plan["proposals"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--events-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--apply-plan", type=Path, help="explicit previously written audit JSON; mutates DB")
    args = parser.parse_args()
    try:
        if args.apply_plan:
            count = apply_plan(args.db, args.events_dir, args.apply_plan)
            print(f"Applied {count} planned rows; backup: {args.db}.pre-hop-reconcile.bak")
        result = audit(args.db, args.events_dir)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(result["counts"], sort_keys=True))
        return 0
    except Exception as exc:
        print(f"reconcile_sol_hops: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
