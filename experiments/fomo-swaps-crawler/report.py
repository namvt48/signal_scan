#!/usr/bin/env python3
"""Read-only report for the standalone FOMO swaps crawler."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--top", type=int, default=20)
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    db = sqlite3.connect(f"file:{data_dir / 'fomo_swaps.db'}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    latest = data_dir / "latest_cycle.json"
    if latest.exists():
        print("== latest cycle ==")
        print(latest.read_text().strip())

    print("\n== counts ==")
    for table in ("users", "swap_events", "ca_inflow", "cycles", "user_errors"):
        row = db.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
        print(f"{table}: {row['n']}")

    print("\n== recent cycles ==")
    for row in db.execute(
        "SELECT id, started_at, users_ok, http_429, http_503, errors, credits_cost, "
        "credits_remaining_after, interval_seconds, duration_ms, stop_reason "
        "FROM cycles ORDER BY id DESC LIMIT 5"
    ):
        print(dict(row))

    print(f"\n== top {args.top} CAs by total inflow ==")
    for row in db.execute(
        "SELECT chain, ca, ROUND(SUM(inflow_usd), 2) AS inflow_usd, "
        "SUM(buy_count) AS buys, COUNT(DISTINCT user_id) AS users "
        "FROM ca_inflow GROUP BY chain, ca ORDER BY inflow_usd DESC LIMIT ?",
        (args.top,),
    ):
        print(dict(row))

    print(f"\n== top {args.top} user/CA positions ==")
    for row in db.execute(
        "SELECT handle, chain, ca, ROUND(inflow_usd, 2) AS inflow_usd, buy_count, last_seen_at "
        "FROM ca_inflow ORDER BY inflow_usd DESC LIMIT ?",
        (args.top,),
    ):
        print(dict(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
