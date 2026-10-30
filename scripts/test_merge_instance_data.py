#!/usr/bin/env python3
"""Synthetic test suite for scripts/merge_instance_data.py."""

import json
import os
import sqlite3
import tempfile
import unittest

from scripts.merge_instance_data import merge_databases


class TestMergeInstanceData(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_a = os.path.join(self.temp_dir.name, "a.db")
        self.db_b = os.path.join(self.temp_dir.name, "b.db")
        self.db_target = os.path.join(self.temp_dir.name, "merged.db")

        # Create schema in A
        self._init_db(self.db_a)
        # Create schema in B
        self._init_db(self.db_b)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _init_db(self, path: str) -> None:
        conn = sqlite3.connect(path)
        conn.executescript("""
            CREATE TABLE wallets (
                id TEXT PRIMARY KEY,
                address TEXT NOT NULL,
                name TEXT NOT NULL,
                tags TEXT NOT NULL,
                chain TEXT NOT NULL,
                source TEXT NOT NULL,
                clan TEXT,
                UNIQUE(address, chain)
            );
            CREATE TABLE wallet_token_state (
                wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
                ca TEXT NOT NULL,
                chain TEXT NOT NULL,
                token_amount REAL NOT NULL DEFAULT 0,
                balance_usd REAL,
                PRIMARY KEY (wallet_id, ca, chain)
            );
            CREATE TABLE wallet_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
                ca TEXT NOT NULL,
                chain TEXT NOT NULL,
                tx TEXT NOT NULL,
                side TEXT NOT NULL,
                ts INTEGER NOT NULL,
                amount_usd REAL NOT NULL,
                price REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'seed',
                UNIQUE(wallet_id, ca, chain, tx, side)
            );
            CREATE TABLE tracked_cas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT NOT NULL,
                chain TEXT NOT NULL,
                added_at TEXT NOT NULL,
                note TEXT NOT NULL,
                user_note TEXT,
                entry_usd REAL,
                status TEXT NOT NULL DEFAULT 'queued',
                UNIQUE(address, chain)
            );
            CREATE TABLE token_tiers (
                ca TEXT NOT NULL,
                chain TEXT NOT NULL,
                tier TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(ca, chain)
            );
            CREATE TABLE alert_metric_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ca TEXT NOT NULL,
                chain TEXT NOT NULL,
                metric TEXT NOT NULL,
                value REAL NOT NULL,
                response_at INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'market'
            );
            CREATE TABLE alert_metric_feed_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                acknowledged_id INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO alert_metric_feed_state (singleton, acknowledged_id) VALUES (1, 0);
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE fomo_users (
                id TEXT PRIMARY KEY,
                handle TEXT NOT NULL,
                name TEXT,
                user_id TEXT,
                source TEXT NOT NULL DEFAULT 'fomo',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE fomo_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fomo_user_id TEXT NOT NULL REFERENCES fomo_users(id) ON DELETE CASCADE,
                event_id TEXT NOT NULL UNIQUE,
                ca TEXT NOT NULL,
                chain TEXT NOT NULL,
                type TEXT NOT NULL,
                usd_value REAL,
                trade_usd REAL,
                price REAL,
                token TEXT,
                ts INTEGER NOT NULL
            );
        """)
        conn.close()

    def test_merge_data_and_origin_derivation(self) -> None:
        # Populate DB A
        conn_a = sqlite3.connect(self.db_a)
        conn_a.execute(
            "INSERT INTO wallets VALUES ('w_sol', 'SolAddr1111', 'Sol Wallet A', '[\"alpha\"]', 'sol', 'test', 'clan-a')"
        )
        conn_a.execute(
            "INSERT INTO wallets VALUES ('w_evm_common', '0x1111111111111111111111111111111111111111', 'EVM A', '[\"whale\"]', 'base', 'test', '')"
        )
        conn_a.execute(
            "INSERT INTO wallet_token_state VALUES ('w_evm_common', '0xca-state', 'base', 1.0, 100)"
        )
        conn_a.execute(
            "INSERT INTO tracked_cas VALUES (1, 'SolMint1111', 'sol', '2026-10-01', 'note-a', NULL, 100, 'active')"
        )
        conn_a.execute(
            "INSERT INTO settings VALUES ('telegramAlertRules.minFwPct', '15')"
        )
        # Shared market alert on A
        conn_a.execute(
            """INSERT INTO alert_metric_observations VALUES (
                1, 'SharedMint111', 'base', 'fresh', 30.5, 1700000000000,
                '{"symbol":"SHR","marketCap":10000}', 'market'
            )"""
        )
        conn_a.commit()
        conn_a.close()

        # Populate DB B
        conn_b = sqlite3.connect(self.db_b)
        # B has the same EVM wallet with different tags and id
        conn_b.execute(
            "INSERT INTO wallets VALUES ('w_evm_b_id', '0x1111111111111111111111111111111111111111', 'EVM B Name', '[\"sniper\"]', 'base', 'gmgn', 'clan-b')"
        )
        # B has a new BSC wallet
        conn_b.execute(
            "INSERT INTO wallets VALUES ('w_bsc_b', '0x2222222222222222222222222222222222222222', 'BSC Wallet', '[\"smart\"]', 'bsc', 'test', '')"
        )
        # Holdings on an existing wallet exercise conflict-upsert precedence.
        conn_b.execute(
            "INSERT INTO wallet_token_state VALUES ('w_evm_b_id', '0xca-state', 'base', 2.5, 200)"
        )
        # A new wallet's holding exercises the child FK remap path.
        conn_b.execute(
            "INSERT INTO wallet_token_state VALUES ('w_bsc_b', '0xca-state-bsc', 'bsc', 7.0, 700)"
        )
        # Trade on B linked to w_evm_b_id
        conn_b.execute(
            "INSERT INTO wallet_trades VALUES (1, 'w_evm_b_id', '0xca1', 'base', 'tx-1', 'buy', 1700000001000, 500, 1.2, 'watch')"
        )
        # FOMO user and trade
        conn_b.execute(
            "INSERT INTO fomo_users VALUES ('u_fomo_1', '@trader_bob', 'Bob', '102', 'fomo', 1700000000000)"
        )
        conn_b.execute(
            "INSERT INTO fomo_trades VALUES (1, 'u_fomo_1', 'fomo-evt-1', '0xca2', 'base', 'buy', 300, 300, 0.5, 'TOKEN', 1700000002000)"
        )
        conn_b.execute(
            "INSERT INTO settings VALUES ('fomoTelegramAlert.minFwPct', '25')"
        )
        # Duplicate market alert on B (same ca, chain, metric, value, response_at)
        conn_b.execute(
            """INSERT INTO alert_metric_observations VALUES (
                1, 'SharedMint111', 'base', 'fresh', 30.5, 1700000000000,
                '{"symbol":"SHR","marketCap":10000}', 'market'
            )"""
        )
        # Wallet trackerBuy on B (with trackerBuyer.address)
        conn_b.execute(
            """INSERT INTO alert_metric_observations VALUES (
                2, '0xca1', 'base', 'trackerBuy', 500, 1700000001000,
                '{"trackerBuyer":{"name":"EVM B Name","address":"0x1111111111111111111111111111111111111111"}}', ''
            )"""
        )
        # FOMO trackerBuy on B (no trackerBuyer.address)
        conn_b.execute(
            """INSERT INTO alert_metric_observations VALUES (
                3, '0xca2', 'base', 'trackerBuy', 300, 1700000002000,
                '{"trackerBuyer":{"name":"@trader_bob"}}', ''
            )"""
        )
        conn_b.commit()
        conn_b.close()

        # Run merge
        merge_databases(self.db_a, self.db_b, self.db_target, dry_run=False)

        # Verify results in merged target
        conn = sqlite3.connect(self.db_target)

        # 1. Wallets
        wallets = conn.execute("SELECT id, address, name, tags, chain, clan FROM wallets ORDER BY address").fetchall()
        self.assertEqual(len(wallets), 3)  # w_sol, w_evm_common, w_bsc_b
        # Check EVM wallet conflict resolution: B won for non-sol, tags unioned
        evm_w = [w for w in wallets if w[1] == "0x1111111111111111111111111111111111111111"][0]
        self.assertEqual(evm_w[0], "w_evm_common")  # canonical id kept
        self.assertEqual(evm_w[2], "EVM B Name")
        tags = json.loads(evm_w[3])
        self.assertEqual(sorted(tags), ["sniper", "whale"])  # union
        self.assertEqual(evm_w[5], "clan-b")

        # 2. Child trades remapped
        trades = conn.execute("SELECT wallet_id, tx, ca FROM wallet_trades").fetchall()
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0][0], "w_evm_common")  # remapped from w_evm_b_id
        holdings = conn.execute(
            "SELECT wallet_id, ca, token_amount, balance_usd FROM wallet_token_state ORDER BY wallet_id"
        ).fetchall()
        self.assertEqual(holdings, [
            ("w_bsc_b", "0xca-state-bsc", 7.0, 700.0),
            ("w_evm_common", "0xca-state", 2.5, 200.0),
        ])


        # 3. FOMO users and trades
        fomo_users = conn.execute("SELECT handle FROM fomo_users").fetchall()
        self.assertEqual(len(fomo_users), 1)
        self.assertEqual(fomo_users[0][0], "@trader_bob")
        fomo_trades = conn.execute("SELECT event_id FROM fomo_trades").fetchall()
        self.assertEqual(len(fomo_trades), 1)

        # 4. Settings
        settings = dict(conn.execute("SELECT key, value FROM settings").fetchall())
        self.assertEqual(settings["telegramAlertRules.minFwPct"], "15")
        self.assertEqual(settings["fomoTelegramAlert.minFwPct"], "25")

        # 5. Alerts deduplication and origin derivation
        alerts = conn.execute(
            "SELECT ca, metric, value, origin FROM alert_metric_observations ORDER BY id"
        ).fetchall()
        # 3 total: 1 shared (deduped), 1 wallet trackerBuy, 1 fomo trackerBuy
        self.assertEqual(len(alerts), 3)
        self.assertEqual(alerts[0], ("SharedMint111", "fresh", 30.5, "market"))
        self.assertEqual(alerts[1], ("0xca1", "trackerBuy", 500.0, "wallet"))
        self.assertEqual(alerts[2], ("0xca2", "trackerBuy", 300.0, "fomo"))

        # Feed cursor advanced
        feed_state = conn.execute("SELECT acknowledged_id FROM alert_metric_feed_state").fetchone()[0]
        self.assertEqual(feed_state, 3)

        # 6. FK check passes
        conn.execute("PRAGMA foreign_keys = ON")
        fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        self.assertEqual(fk_errors, [])
        conn.close()

        # 7. Second run is idempotent
        merge_databases(self.db_target, self.db_b, self.db_target, dry_run=False)
        conn = sqlite3.connect(self.db_target)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM wallets").fetchone()[0], 3)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM wallet_trades").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM alert_metric_observations").fetchone()[0], 3)
        conn.close()

    def test_reject_target_source_b_aliasing(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            merge_databases(self.db_a, self.db_b, self.db_b)
        self.assertIn("Target cannot be the same file as Source B", str(ctx.exception))

    def test_dry_run_preserves_target(self) -> None:
        non_existent_target = os.path.join(self.temp_dir.name, "should_not_exist.db")
        merge_databases(self.db_a, self.db_b, non_existent_target, dry_run=True)
        self.assertFalse(os.path.exists(non_existent_target), "Dry-run must not create target file")

        # Existing target with sentinel data must remain completely untouched
        existing_target = os.path.join(self.temp_dir.name, "existing.db")
        self._init_db(existing_target)
        c = sqlite3.connect(existing_target)
        c.execute("INSERT INTO settings VALUES ('sentinel', 'keep_me')")
        c.commit()
        c.close()

        merge_databases(self.db_a, self.db_b, existing_target, dry_run=True)
        c = sqlite3.connect(existing_target)
        settings = dict(c.execute("SELECT key, value FROM settings").fetchall())
        c.close()
        self.assertEqual(settings, {"sentinel": "keep_me"}, "Dry-run must not modify existing target file")

    def test_wal_backed_inputs(self) -> None:
        wal_a = os.path.join(self.temp_dir.name, "wal_a.db")
        wal_b = os.path.join(self.temp_dir.name, "wal_b.db")
        wal_target = os.path.join(self.temp_dir.name, "wal_target.db")
        self._init_db(wal_a)
        self._init_db(wal_b)

        # Connect to A in WAL mode, insert row, do not checkpoint
        c_a = sqlite3.connect(wal_a)
        c_a.execute("PRAGMA journal_mode = WAL")
        c_a.execute("INSERT INTO wallets VALUES ('w_wal_a', 'SolWalA', 'Wal A', '[]', 'sol', 'test', '')")
        c_a.commit()
        self.assertTrue(os.path.exists(wal_a + "-wal"), "Source A must have active WAL file")

        # Connect to B in WAL mode, insert row, do not checkpoint
        c_b = sqlite3.connect(wal_b)
        c_b.execute("PRAGMA journal_mode = WAL")
        c_b.execute("INSERT INTO wallets VALUES ('w_wal_b', '0xWalB', 'Wal B', '[]', 'base', 'test', '')")
        c_b.commit()
        self.assertTrue(os.path.exists(wal_b + "-wal"), "Source B must have active WAL file")

        # Run merge while WAL files are active
        merge_databases(wal_a, wal_b, wal_target, dry_run=False)

        c_a.close()
        c_b.close()

        # Target must contain both WAL-inserted rows
        c_t = sqlite3.connect(wal_target)
        wallets = dict(c_t.execute("SELECT id, chain FROM wallets").fetchall())
        c_t.close()
        self.assertEqual(wallets, {"w_wal_a": "sol", "w_wal_b": "base"})


if __name__ == "__main__":
    unittest.main()
