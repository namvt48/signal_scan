#!/usr/bin/env python3
"""Merge instance A (Solana) and instance B (EVM/FOMO) SQLite databases into a single database.

Usage:
    python3 scripts/merge_instance_data.py --source-a /path/to/a.db --source-b /path/to/b.db --target /path/to/merged.db [--dry-run]
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import uuid
from typing import Dict, List, Set, Tuple


def ensure_origin_column(conn: sqlite3.Connection) -> None:
    cols = [row[1] for row in conn.execute("PRAGMA table_info(alert_metric_observations)").fetchall()]
    if "origin" not in cols:
        conn.execute("ALTER TABLE alert_metric_observations ADD COLUMN origin TEXT NOT NULL DEFAULT 'market'")
    conn.execute("""
        UPDATE alert_metric_observations SET origin = CASE
            WHEN metric IN ('fresh', 't100') THEN 'market'
            WHEN json_extract(snapshot_json, '$.trackerBuyer.address') IS NOT NULL OR chain = 'sol' THEN 'wallet'
            ELSE 'fomo'
        END
    """)


def merge_wallets(conn: sqlite3.Connection) -> Dict[str, str]:
    """Merge wallets from b into main. Returns mapping from b_id -> canonical_id."""
    b_wallets = conn.execute("SELECT id, address, name, tags, chain, source, clan FROM b.wallets").fetchall()
    id_map: Dict[str, str] = {}
    inserted = 0
    updated = 0

    for b_id, b_addr, b_name, b_tags_json, b_chain, b_source, b_clan in b_wallets:
        existing = conn.execute(
            "SELECT id, tags, clan, source FROM main.wallets WHERE address = ? AND chain = ?",
            (b_addr, b_chain)
        ).fetchone()

        if existing:
            canonical_id, a_tags_json, a_clan, a_source = existing
            id_map[b_id] = canonical_id
            if b_chain != "sol":
                # Union tags
                try:
                    a_tags: Set[str] = set(json.loads(a_tags_json or "[]"))
                except Exception:
                    a_tags = set()
                try:
                    b_tags: Set[str] = set(json.loads(b_tags_json or "[]"))
                except Exception:
                    b_tags = set()
                merged_tags = sorted(a_tags | b_tags)
                merged_clan = b_clan if (b_clan and b_clan.strip()) else a_clan
                conn.execute(
                    "UPDATE main.wallets SET name = ?, tags = ?, clan = ?, source = ? WHERE id = ?",
                    (b_name, json.dumps(merged_tags), merged_clan, b_source, canonical_id)
                )
                updated += 1
        else:
            # Check ID collision
            id_conflict = conn.execute("SELECT 1 FROM main.wallets WHERE id = ?", (b_id,)).fetchone()
            new_id = str(uuid.uuid4()) if id_conflict else b_id
            id_map[b_id] = new_id
            conn.execute(
                "INSERT INTO main.wallets (id, address, name, tags, chain, source, clan) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_id, b_addr, b_name, b_tags_json, b_chain, b_source, b_clan or "")
            )
            inserted += 1

    print(f"  [wallets] inserted: {inserted}, updated: {updated}, total mapped: {len(id_map)}")
    return id_map


def merge_wallet_child_tables(conn: sqlite3.Connection, id_map: Dict[str, str]) -> None:
    # 1. wallet_token_state
    b_states = conn.execute("SELECT wallet_id, ca, chain, token_amount, fetched_at FROM b.wallet_token_state").fetchall()
    inserted_states = 0
    for w_id, ca, chain, amount, fetched_at in b_states:
        canon_id = id_map.get(w_id, w_id)
        res = conn.execute(
            """INSERT INTO main.wallet_token_state (wallet_id, ca, chain, token_amount, fetched_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(wallet_id, ca, chain) DO UPDATE SET
                   token_amount = excluded.token_amount,
                   fetched_at = MAX(wallet_token_state.fetched_at, excluded.fetched_at)""",
            (canon_id, ca, chain, amount, fetched_at)
        )
        if res.rowcount:
            inserted_states += 1
    print(f"  [wallet_token_state] merged: {len(b_states)}")

    # 2. wallet_trades
    b_trades = conn.execute(
        "SELECT wallet_id, ca, chain, tx, side, ts, amount_usd, price, source FROM b.wallet_trades"
    ).fetchall()
    inserted_trades = 0
    for w_id, ca, chain, tx, side, ts, amount_usd, price, source in b_trades:
        canon_id = id_map.get(w_id, w_id)
        res = conn.execute(
            """INSERT OR IGNORE INTO main.wallet_trades (wallet_id, ca, chain, tx, side, ts, amount_usd, price, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (canon_id, ca, chain, tx, side, ts, amount_usd, price, source)
        )
        if res.rowcount:
            inserted_trades += 1
    print(f"  [wallet_trades] inserted: {inserted_trades} (out of {len(b_trades)})")


def merge_tracked_cas(conn: sqlite3.Connection) -> None:
    b_cas = conn.execute("SELECT address, chain, added_at, note, user_note, entry_usd, status FROM b.tracked_cas").fetchall()
    inserted = 0
    updated = 0
    for addr, chain, added_at, note, user_note, entry_usd, status in b_cas:
        existing = conn.execute(
            "SELECT status, entry_usd, note, user_note, added_at FROM main.tracked_cas WHERE address = ? AND chain = ?",
            (addr, chain)
        ).fetchone()
        if existing:
            a_status, a_entry_usd, a_note, a_user_note, a_added_at = existing
            merged_status = "queued" if (status == "queued" or a_status == "queued") else a_status
            merged_entry_usd = a_entry_usd if a_entry_usd is not None else entry_usd
            merged_note = a_note if (a_note and len(a_note) >= len(note or "")) else note
            merged_user_note = a_user_note if (a_user_note and len(a_user_note) >= len(user_note or "")) else user_note
            conn.execute(
                """UPDATE main.tracked_cas
                   SET status = ?, entry_usd = ?, note = ?, user_note = ?
                   WHERE address = ? AND chain = ?""",
                (merged_status, merged_entry_usd, merged_note, merged_user_note, addr, chain)
            )
            updated += 1
        else:
            conn.execute(
                """INSERT INTO main.tracked_cas (address, chain, added_at, note, user_note, entry_usd, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (addr, chain, added_at, note, user_note, entry_usd, status)
            )
            inserted += 1
    print(f"  [tracked_cas] inserted: {inserted}, updated: {updated}")


def merge_fomo_tables(conn: sqlite3.Connection) -> None:
    fomo_tables = [
        ("fomo_users", "id"),
        ("fomo_user_wallets", "fomo_user_id, address, chain"),
        ("fomo_trades", "event_id"),
        ("fomo_holdings", "fomo_user_id, ca, chain"),
        ("fomo_api_holdings", "fomo_user_id, ca, chain"),
        ("fomo_positions", "fomo_user_id, ca, chain, trade_id"),
        ("fomo_user_snapshots", "fomo_user_id"),
        ("fomo_position_snapshots", "fomo_user_id"),
        ("fomo_api_request_state", "resource"),
    ]
    for table, pkey in fomo_tables:
        has_table_b = conn.execute(f"SELECT 1 FROM b.sqlite_master WHERE type='table' AND name='{table}'").fetchone()
        has_table_main = conn.execute(f"SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='{table}'").fetchone()
        if not has_table_b or not has_table_main:
            continue
        cols = [r[1] for r in conn.execute(f"PRAGMA b.table_info({table})").fetchall()]
        cols_str = ", ".join(cols)
        res = conn.execute(f"INSERT OR REPLACE INTO main.{table} ({cols_str}) SELECT {cols_str} FROM b.{table}")
        count = conn.execute(f"SELECT COUNT(*) FROM main.{table}").fetchone()[0]
        print(f"  [{table}] total rows in main: {count}")


def merge_settings(conn: sqlite3.Connection) -> None:
    # 1. Insert missing settings from B
    conn.execute("INSERT OR IGNORE INTO main.settings (key, value) SELECT key, value FROM b.settings")
    # 2. Overwrite fomoTelegramAlert.* settings with B's values
    conn.execute("""
        INSERT INTO main.settings (key, value)
        SELECT key, value FROM b.settings WHERE key LIKE 'fomoTelegramAlert.%'
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    """)
    print("  [settings] merged settings with B winning for fomoTelegramAlert")


def merge_alerts(conn: sqlite3.Connection) -> Tuple[int, int]:
    ensure_origin_column(conn)
    b_has_origin = "origin" in [r[1] for r in conn.execute("PRAGMA b.table_info(alert_metric_observations)").fetchall()]

    # Insert deduplicated alerts from B
    b_rows = conn.execute(f"""
        SELECT ca, chain, metric, value, response_at, snapshot_json,
               {'origin' if b_has_origin else "''"} as origin
        FROM b.alert_metric_observations
        ORDER BY id
    """).fetchall()

    inserted = 0
    deduped = 0
    for ca, chain, metric, value, resp_at, snap_json, orig in b_rows:
        if not orig:
            if metric in ('fresh', 't100'):
                derived_origin = 'market'
            else:
                try:
                    snap = json.loads(snap_json)
                    derived_origin = 'wallet' if (snap.get('trackerBuyer', {}).get('address') or chain == 'sol') else 'fomo'
                except Exception:
                    derived_origin = 'wallet' if chain == 'sol' else 'fomo'
        else:
            derived_origin = orig

        # Check existing
        existing = conn.execute("""
            SELECT 1 FROM main.alert_metric_observations
            WHERE ca = ? AND chain = ? AND metric = ? AND response_at = ? AND value = ?
        """, (ca, chain, metric, resp_at, value)).fetchone()

        if existing:
            deduped += 1
            continue

        conn.execute("""
            INSERT INTO main.alert_metric_observations (ca, chain, metric, value, response_at, snapshot_json, origin)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (ca, chain, metric, value, resp_at, snap_json, derived_origin))
        inserted += 1

    # Advance feed state
    conn.execute("""
        UPDATE main.alert_metric_feed_state
        SET acknowledged_id = (SELECT COALESCE(MAX(id), 0) FROM main.alert_metric_observations)
        WHERE singleton = 1
    """)
    print(f"  [alert_metric_observations] inserted: {inserted}, deduped: {deduped}")
    return inserted, deduped

def sqlite_backup(src_path: str, dst_path: str) -> None:
    """Safely snapshot a SQLite database using the native backup API.
    Works cleanly on WAL-mode databases without omitting uncheckpointed transactions.
    """
    src_conn = sqlite3.connect(src_path)
    try:
        dst_conn = sqlite3.connect(dst_path)
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()


def merge_databases(source_a: str, source_b: str, target: str, dry_run: bool = False) -> None:
    if not os.path.exists(source_a):
        raise FileNotFoundError(f"Source A database not found: {source_a}")
    if not os.path.exists(source_b):
        raise FileNotFoundError(f"Source B database not found: {source_b}")

    real_a = os.path.realpath(source_a)
    real_b = os.path.realpath(source_b)
    real_target = os.path.realpath(target)

    if real_target == real_b:
        raise ValueError(
            f"Target cannot be the same file as Source B ({source_b}): "
            "overwriting source B before attaching it would destroy source B data"
        )

    print(f"Merging databases:\n  A: {source_a}\n  B: {source_b}\n  Target: {target} (dry_run={dry_run})")

    tmp_dry_run_path = None
    if dry_run:
        # Perform dry run in an isolated temp database snapshot; target is never created or touched
        tmp_dry_run_path = f"{target}.dry_run_tmp_{uuid.uuid4().hex}.db"
        sqlite_backup(source_a, tmp_dry_run_path)
        working_target = tmp_dry_run_path
    elif real_target == real_a:
        # In-place merge on A: create automatic native backup
        backup_path = f"{source_a}.pre-merge-backup"
        if not os.path.exists(backup_path):
            sqlite_backup(source_a, backup_path)
            print(f"Created pre-merge backup at: {backup_path}")
        working_target = target
    else:
        # Write to target path using native SQLite backup to checkpoint/capture WAL cleanly
        sqlite_backup(source_a, target)
        working_target = target

    conn = sqlite3.connect(working_target)
    conn.execute("PRAGMA foreign_keys = OFF")

    try:
        conn.execute("ATTACH DATABASE ? AS b", (source_b,))
        conn.execute("BEGIN TRANSACTION")

        print("\n1. Merging wallets...")
        id_map = merge_wallets(conn)

        print("\n2. Merging wallet child tables...")
        merge_wallet_child_tables(conn, id_map)

        print("\n3. Merging tracked CAs...")
        merge_tracked_cas(conn)

        print("\n4. Merging token tiers & auxiliary tables...")
        has_tiers = conn.execute("SELECT 1 FROM b.sqlite_master WHERE type='table' AND name='token_tiers'").fetchone()
        if has_tiers:
            conn.execute("""
                INSERT INTO main.token_tiers (ca, chain, tier, updated_at)
                SELECT ca, chain, tier, updated_at FROM b.token_tiers
                WHERE 1
                ON CONFLICT(ca, chain) DO UPDATE SET
                    tier = excluded.tier,
                    updated_at = excluded.updated_at
                WHERE excluded.updated_at > token_tiers.updated_at
            """)
        for aux in ("blocked_cas", "zero_holdings", "token_avatar_cache"):
            has_b = conn.execute(f"SELECT 1 FROM b.sqlite_master WHERE type='table' AND name='{aux}'").fetchone()
            if has_b:
                conn.execute(f"INSERT OR IGNORE INTO main.{aux} SELECT * FROM b.{aux}")

        has_t100 = conn.execute("SELECT 1 FROM b.sqlite_master WHERE type='table' AND name='t100_first_observations'").fetchone()
        if has_t100:
            conn.execute("""
                INSERT INTO main.t100_first_observations (ca, chain, first_multiple, recorded_at)
                SELECT ca, chain, first_multiple, recorded_at FROM b.t100_first_observations
                WHERE 1
                ON CONFLICT(ca, chain) DO UPDATE SET
                    first_multiple = excluded.first_multiple,
                    recorded_at = excluded.recorded_at
                WHERE excluded.recorded_at < t100_first_observations.recorded_at
            """)

        print("\n5. Merging FOMO tables...")
        merge_fomo_tables(conn)

        print("\n6. Merging settings...")
        merge_settings(conn)

        print("\n7. Merging alerts...")
        merge_alerts(conn)

        print("\n8. Checking foreign keys...")
        conn.execute("PRAGMA foreign_keys = ON")
        fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_errors:
            raise RuntimeError(f"Foreign key check failed with errors: {fk_errors}")
        print("  Foreign key check passed with 0 violations.")

        if dry_run:
            print("\nDry-run requested: rolling back and preserving target unchanged.")
            conn.execute("ROLLBACK")
        else:
            conn.execute("COMMIT")
            print("\nMerge successfully committed to target database!")
    finally:
        conn.close()
        if tmp_dry_run_path and os.path.exists(tmp_dry_run_path):
            try:
                os.remove(tmp_dry_run_path)
            except Exception:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge instance A and B databases into a unified database")
    parser.add_argument("--source-a", required=True, help="Path to instance A database (base)")
    parser.add_argument("--source-b", required=True, help="Path to instance B database")
    parser.add_argument("--target", required=True, help="Path to target merged database")
    parser.add_argument("--dry-run", action="store_true", help="Perform merge in transaction and rollback")
    args = parser.parse_args()

    merge_databases(args.source_a, args.source_b, args.target, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
