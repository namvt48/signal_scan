"""Durability and reorg tests for the EVM journal."""

import tempfile
import unittest
from pathlib import Path

from watchers.evm.journal import DeepReorgError, Journal


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "journal.sqlite")
        self.journal = Journal(self.path)

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def test_wal_reopen_replay_and_outbox_persistence(self):
        log = {"blockNumber": "0x10", "blockHash": "hash", "transactionHash": "tx", "logIndex": "0x1"}
        self.journal.record_log("base", log)
        self.journal.record_log("base", log)
        self.assertEqual(self.journal.pending_logs("base"), [log])
        self.journal.enqueue({"chain": "base", "wallet": "w", "ca": "c", "tx": "t", "side": "buy"}, 16, "hash")
        self.journal.enqueue({"chain": "base", "wallet": "w", "ca": "c", "tx": "t", "side": "buy"}, 16, "hash")
        self.journal.close()
        self.journal = Journal(self.path)
        self.assertEqual(self.journal.pending_logs("base"), [log])
        self.assertEqual(len(self.journal.due(now=0)), 1)
        self.assertEqual(self.journal.stats(), {"pending": 1, "blocked": 0, "delivered": 0})

    def test_cursor_migration_and_sanitization(self):
        state = {"evm": {"base": {"last_block": 90, "last_tx_block": 80, "chunk_span": 12, "chunk_rpc": "https://user:secret@host/key"}}}
        loaded = self.journal.load_state(state)
        self.assertEqual(loaded["evm"]["base"]["last_block"], 90)
        self.assertNotIn("chunk_rpc", loaded["evm"]["base"])
        self.journal.advance_cursor("base", "last_block", 95)
        self.journal.advance_cursor("base", "last_block", 20)
        self.assertEqual(self.journal.state("base")["last_block"], 95)
        self.journal.save_state(state)
        self.journal.close()
        self.journal = Journal(self.path)
        self.assertEqual(self.journal.load_state({})["evm"]["base"]["last_block"], 95)
        self.assertNotIn("secret", Path(self.path).read_bytes().decode("latin1", errors="ignore"))

    def test_removed_log_cancels_pending_log_candidate_and_outbox(self):
        log = {"blockNumber": "0x20", "blockHash": "hash", "transactionHash": "tx", "logIndex": "0x0"}
        self.journal.record_log("bsc", log)
        self.journal.enqueue_candidate("bsc", "tx", 32, "hash", trace_wallets=["w"])
        self.journal.enqueue({"chain": "bsc", "wallet": "w", "ca": "c", "tx": "tx", "side": "buy"}, 32, "hash")
        self.journal.record_log("bsc", {**log, "removed": True})
        self.assertEqual(self.journal.pending_logs("bsc"), [])
        self.assertEqual(self.journal.pending_candidates("bsc"), [])
        self.assertEqual(self.journal.due(now=0), [])

    def test_candidate_merge_and_completion(self):
        self.journal.enqueue_candidate("base", "tx", 4, "h", transaction={"to": "x"}, trace_wallets=["a"])
        self.journal.enqueue_candidate("base", "tx", 4, "h", trace_wallets=["b"])
        candidate = self.journal.pending_candidates("base")[0]
        self.assertEqual(candidate["trace_wallets"], ["a", "b"])
        self.assertEqual(candidate["transaction"], {"to": "x"})
        self.journal.complete_candidate("base", "tx", 4, "h")
        self.assertEqual(self.journal.pending_candidates("base"), [])

    def test_candidate_block_and_cursor_commit_atomically(self):
        self.journal.advance_candidate_block(
            "base",
            [{"tx": "tx", "blockHash": "hash", "trace_wallets": ["wallet"]}],
            25,
        )
        self.assertEqual(self.journal.state("base")["last_tx_block"], 25)
        self.assertEqual(self.journal.pending_candidates("base")[0]["tx"], "tx")

    def test_candidate_insert_failure_rolls_back_cursor_and_rows(self):
        with self.assertRaises(KeyError):
            self.journal.advance_candidate_block(
                "base",
                [{"tx": "first"}, {}],
                25,
            )
        self.assertEqual(self.journal.state("base"), {})
        self.assertEqual(self.journal.pending_candidates("base"), [])

    def test_delivered_event_deep_reorg_persistently_halts(self):
        self.journal.enqueue({"chain": "robinhood", "wallet": "w", "ca": "c", "tx": "tx", "side": "sell"}, 40, "h")
        item = self.journal.due(now=0)[0]
        self.journal.ack(item["id"])
        self.journal.save_state({"evm": {"robinhood": {"last_block": 50, "last_tx_block": 45}}})
        with self.assertRaises(DeepReorgError):
            self.journal.rewind("robinhood", 30)
        self.assertTrue(self.journal.halted("robinhood"))
        self.assertEqual(self.journal.due(now=0), [])
        self.journal.close()
        self.journal = Journal(self.path)
        self.assertTrue(self.journal.halted("robinhood"))
        self.assertEqual(self.journal.state("robinhood")["last_block"], 30)



    def test_header_ring_rewinds_with_reorg_cursor(self):
        for height in range(10, 14):
            self.journal.record_header(
                "base",
                {
                    "number": hex(height),
                    "hash": f"hash-{height}",
                    "parentHash": f"hash-{height - 1}",
                },
            )
        self.journal.rewind("base", 11)
        headers = self.journal.headers("base")
        self.assertEqual([item["height"] for item in headers], [10, 11])
        self.journal.record_header(
            "base",
            {"number": "0xc", "hash": "fork-12", "parentHash": "hash-11"},
        )
        self.assertEqual(self.journal.headers("base")[-1]["hash"], "fork-12")

    def test_zero_ancestor_replays_from_genesis_until_cursor_commits(self):
        self.journal.save_state(
            {"evm": {"base": {"last_block": 100, "last_tx_block": 100}}}
        )
        self.journal.rewind("base", 0)
        self.assertTrue(self.journal.state("base")["recovery"])
        self.journal.advance_cursor("base", "last_block", 1)
        self.assertNotIn("recovery", self.journal.state("base"))


    def test_failed_candidate_has_persisted_retry_deadline(self):
        self.journal.enqueue_candidate("base", "tx", 20, "hash")
        self.journal.defer_candidate("base", "tx", 20, "hash", 100)
        self.assertEqual(self.journal.pending_candidates("base", now=99), [])
        item = self.journal.pending_candidates("base", now=100)[0]
        self.assertEqual(item["attempts"], 1)
if __name__ == "__main__":
    unittest.main()
