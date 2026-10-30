import copy
import unittest
from unittest.mock import patch

import threading
import time
from watchers.sol import recovery


class SolRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.previous_interval = recovery._RPC_INTERVAL
        recovery._RPC_INTERVAL = 0.0
        self.signatures = [f"sig-{index}" for index in range(250, 0, -1)]
        self.processed = []
        self.fixture_block_time = int(time.time())
        self.had_tracking_anchor = hasattr(recovery.config, "_tracking_since_ms")
        self.previous_tracking_anchor = getattr(recovery.config, "_tracking_since_ms", None)
        recovery.config._tracking_since_ms = self.fixture_block_time * 1000

    def tearDown(self):
        recovery._RPC_INTERVAL = self.previous_interval
        if self.had_tracking_anchor:
            recovery.config._tracking_since_ms = self.previous_tracking_anchor
        else:
            del recovery.config._tracking_since_ms

    def rpc(self, method, params):
        if method != "getSignaturesForAddress":
            raise AssertionError(method)
        _, options = params
        rows = [
            {"signature": sig, "err": None, "blockTime": self.fixture_block_time}
            for sig in self.signatures
        ]
        if "until" in options:
            rows = rows[: next(i for i, row in enumerate(rows) if row["signature"] == options["until"])]
        if "before" in options:
            rows = rows[next(i for i, row in enumerate(rows) if row["signature"] == options["before"]) + 1 :]
        return rows[: options["limit"]]

    def process(self, sig, wallets, _state, err, provenance):
        self.processed.append((wallets[0], sig, err))
        return True

    def test_more_than_page_history_is_oldest_first_and_resumable(self):
        st = {"wallets": {}}
        lock = threading.RLock()
        with patch.object(recovery.config, "rpc", side_effect=self.rpc), patch.object(recovery, "save_state"):
            for _ in range(4):
                recovery.reconcile_cycle(["wallet"], st, self.process, state_lock=lock)
        self.assertEqual([item[1] for item in self.processed], list(reversed(self.signatures[:250])))
        self.assertEqual(st["sol_recovery"]["wallet"]["signature"], self.signatures[0])


    def test_over_400_signatures_resumes_from_existing_checkpoint_after_restart(self):
        self.signatures = [f"sig-{index}" for index in range(1000, 0, -1)]
        st = {"wallets": {"wallet": {"head": "sig-500"}}}
        with patch.object(recovery.config, "rpc", side_effect=self.rpc), patch.object(
            recovery, "save_state"
        ):
            recovery.reconcile_cycle(["wallet"], st, self.process)
            self.assertEqual(st["sol_recovery"]["wallet"]["signature"], "sig-500")
            self.assertEqual(st["sol_recovery"]["wallet"]["scan"]["before"], "sig-601")
            st = copy.deepcopy(st)
            recovery.reconcile_cycle(["wallet"], st, self.process)
            recovery.reconcile_cycle(["wallet"], st, self.process)

        self.assertEqual(len(self.processed), 500)
        self.assertEqual({item[1] for item in self.processed}, {
            f"sig-{index}" for index in range(501, 1001)
        })
        self.assertEqual(st["sol_recovery"]["wallet"]["signature"], "sig-1000")
        self.assertNotIn("scan", st["sol_recovery"]["wallet"])

    def test_page_budget_exhaustion_keeps_checkpoint_until_history_is_fully_scanned(self):
        st = {"wallets": {"wallet": {"head": "sig-1"}}}
        with (
            patch.object(recovery, "MAX_PAGES_PER_WALLET", 1),
            patch.object(recovery.config, "rpc", side_effect=self.rpc),
            patch.object(recovery, "save_state"),
        ):
            recovery.reconcile_cycle(["wallet"], st, self.process)
            self.assertEqual(st["sol_recovery"]["wallet"]["signature"], "sig-1")
            self.assertEqual(st["sol_recovery"]["wallet"]["scan"]["before"], "sig-151")
            st = copy.deepcopy(st)
            recovery.reconcile_cycle(["wallet"], st, self.process)
            self.assertEqual(st["sol_recovery"]["wallet"]["signature"], "sig-1")
            recovery.reconcile_cycle(["wallet"], st, self.process)

        self.assertEqual(len(self.processed), 249)
        self.assertEqual(st["sol_recovery"]["wallet"]["signature"], "sig-250")
        self.assertNotIn("scan", st["sol_recovery"]["wallet"])
    def test_false_callback_retries_same_signature_after_restart(self):
        st = {"wallets": {}}
        attempts = []

        def transient(sig, wallets, state, err, provenance):
            attempts.append(sig)
            return len(attempts) > 1

        with patch.object(recovery.config, "rpc", side_effect=self.rpc), patch.object(recovery, "save_state"):
            recovery.reconcile_cycle(["wallet"], st, transient)
            self.assertIsNone(st["sol_recovery"]["wallet"].get("signature"))
            recovery.reconcile_cycle(["wallet"], st, transient)
        self.assertEqual(attempts[0], attempts[1])

    def test_rpc_failure_does_not_checkpoint_and_retries(self):
        st = {"wallets": {}}
        calls = 0

        def flaky_rpc(method, params):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("temporary")
            return self.rpc(method, params)

        with patch.object(recovery.config, "rpc", side_effect=flaky_rpc), patch.object(recovery, "save_state"):
            recovery.reconcile_cycle(["wallet"], st, self.process)
            self.assertIsNone(st["sol_recovery"]["wallet"].get("signature"))
            recovery.reconcile_cycle(["wallet"], st, self.process)
        self.assertTrue(self.processed)

    def test_restart_continues_history_and_wallets_are_independent(self):
        st = {"wallets": {"wallet-a": {"head": self.signatures[10]}}}
        with patch.object(recovery.config, "rpc", side_effect=self.rpc), patch.object(recovery, "save_state"):
            recovery.reconcile_cycle(["wallet-a", "wallet-b"], st, self.process)
        wallet_a = [item[1] for item in self.processed if item[0] == "wallet-a"]
        wallet_b = [item[1] for item in self.processed if item[0] == "wallet-b"]
        self.assertEqual(len(wallet_a), 10)
        self.assertEqual(len(wallet_b), 250)
        self.assertEqual(st["sol_recovery"]["wallet-a"]["signature"], self.signatures[0])
        self.assertEqual(st["sol_recovery"]["wallet-b"]["signature"], self.signatures[0])

    def test_shared_signature_is_processed_for_each_wallet(self):
        st = {"wallets": {}}
        def same_signature_rpc(_method, _params):
            return [{"signature": "shared", "err": None}]
        with patch.object(recovery.config, "rpc", side_effect=same_signature_rpc), patch.object(recovery, "save_state"):
            recovery.reconcile_cycle(["wallet-a", "wallet-b"], st, self.process)
        self.assertEqual({wallet for wallet, _, _ in self.processed}, {"wallet-a", "wallet-b"})

    def test_empty_wallet_list_does_nothing_and_removed_wallet_is_not_mutated(self):
        st = {"wallets": {}, "sol_recovery": {"removed": {"signature": "old"}}}
        with patch.object(recovery.config, "rpc") as rpc, patch.object(recovery, "save_state"):
            recovery.reconcile_cycle([], st, self.process)
            recovery.reconcile_cycle(["new"], st, self.process)
        rpc.assert_called_once()
        self.assertEqual(st["sol_recovery"]["removed"], {"signature": "old"})
        self.assertIn("new", st["sol_recovery"])



    def test_cycle_rotates_start_wallet_after_budget_exhaustion(self):
        st = {"wallets": {}}
        seen = []
        clock = [0.0]

        def work(wallet, *_args):
            seen.append(wallet)
            clock[0] += 2.0

        with (
            patch.object(recovery, "MAX_SECONDS_PER_CYCLE", 1.0),
            patch.object(recovery.time, "monotonic", side_effect=lambda: clock[0]),
            patch.object(recovery, "reconcile_wallet", side_effect=work),
            patch.object(recovery, "save_state"),
        ):
            recovery.reconcile_cycle(["a", "b", "c"], st, self.process)
            recovery.reconcile_cycle(["a", "b", "c"], st, self.process)
        self.assertEqual(seen, ["a", "b"])

    def test_tracking_window_persists_deploy_cutoff_for_current_and_new_wallets(self):
        deploy_at_ms = 1_800_000_000_610
        st = {"wallets": {}}
        with patch.object(recovery, "save_state") as save:
            recovery.initialize_tracking_window(st, ["first"], deploy_at_ms)
            self.assertEqual(st["sol_tracking_since_ms"], deploy_at_ms)
            self.assertEqual(st["sol_recovery"]["first"]["since_ms"], deploy_at_ms)
            recovery.initialize_tracking_window(st, ["first", "added"], deploy_at_ms)
        self.assertEqual(st["sol_recovery"]["first"]["since_ms"], deploy_at_ms)
        self.assertEqual(st["sol_recovery"]["added"]["since_ms"], deploy_at_ms)
        self.assertGreaterEqual(save.call_count, 1)

    def test_restart_preserves_persisted_deploy_cutoff(self):
        st = {
            "sol_tracking_since_ms": 1_700_000_000_000,
            "sol_recovery": {"wallet": {"since_ms": 1_700_000_000_000}},
        }
        with patch.object(recovery, "save_state"):
            recovery.initialize_tracking_window(st, ["wallet"], 1_700_000_000_000)
        self.assertEqual(recovery.tracking_since_ms(st, "wallet"), 1_700_000_000_000)

    def test_old_blocktime_stops_pagination_and_cutoff_boundary_is_inclusive(self):
        st = {
            "sol_tracking_since_ms": 1_700_000_000_000,
            "sol_recovery": {"wallet": {"since_ms": 1_700_000_000_000}},
            "wallets": {},
        }
        calls = []

        def timed_rpc(_method, params):
            calls.append(params[1])
            return [
                {"signature": "new", "err": None, "blockTime": 1_700_000_001},
                {"signature": "boundary", "err": None, "blockTime": 1_700_000_000},
                {"signature": "old", "err": None, "blockTime": 1_699_999_999},
            ]

        with patch.object(recovery.config, "_tracking_since_ms", 1_700_000_000_000), patch.object(
            recovery.config, "rpc", side_effect=timed_rpc
        ), patch.object(recovery, "save_state"):
            recovery.reconcile_wallet("wallet", st, self.process, 10**20)
        self.assertEqual([item[1] for item in self.processed], ["boundary", "new"])
        self.assertEqual(len(calls), 1)

    def test_legacy_pending_rows_are_discarded_on_upgrade(self):
        st = {
            "wallets": {"wallet": {"head": "historical-head"}},
            "sol_recovery": {
                "wallet": {
                    "signature": "historical-checkpoint",
                    "scan": {
                        "pending": [{"signature": "historical-pending", "err": None}],
                        "head": "historical-head",
                        "anchor": "historical-checkpoint",
                    },
                }
            },
        }
        with patch.object(recovery.time, "time", return_value=1_800_000_000), patch.object(
            recovery, "save_state"
        ), patch.object(recovery.config, "rpc", return_value=[]):
            recovery.initialize_tracking_window(st, ["wallet"], 1_800_000_000_000)
            recovery.reconcile_wallet("wallet", st, self.process, 10**20)
        self.assertEqual(self.processed, [])
        self.assertNotIn("scan", st["sol_recovery"]["wallet"])

    def test_missing_row_blocktime_is_deferred_to_process_callback(self):
        st = {
            "sol_tracking_since_ms": 1_700_000_000_000,
            "sol_recovery": {"wallet": {"since_ms": 1_700_000_000_000}},
            "wallets": {},
        }
        with patch.object(recovery.config, "rpc", return_value=[{"signature": "unknown-time", "err": None}]), patch.object(
            recovery, "save_state"
        ):
            recovery.reconcile_wallet("wallet", st, self.process, 10**20)
        self.assertEqual([item[1] for item in self.processed], ["unknown-time"])

    def test_first_observation_boundary_survives_restart_without_rewriting_legacy_cursors(self):
        state = {"wallets": {"existing": {"head": "persisted-signature"}}}
        with patch.object(recovery.time, "time", return_value=1_800_000_000), patch.object(recovery, "save_state"):
            recovery.initialize_tracking_window(state, ["new", "existing"], 1_700_000_000_000)
        first = state["sol_recovery"]["new"]["observation_start_ms"]
        with patch.object(recovery.time, "time", return_value=1_800_010_000), patch.object(recovery, "save_state"):
            recovery.initialize_tracking_window(state, ["new", "existing"], 1_700_000_000_000)
        self.assertEqual(state["sol_recovery"]["new"]["observation_start_ms"], first)
        self.assertNotIn("observation_start_ms", state["sol_recovery"]["existing"])

if __name__ == "__main__":
    unittest.main()
