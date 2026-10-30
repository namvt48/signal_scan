import unittest
from unittest.mock import patch

from watchers.sol import feed


class SolBlockFeedTests(unittest.TestCase):
    def test_null_block_retries_same_slot_then_processes_block(self):
        state = {"block_slot": 9}
        responses = [
            10,
            10,
            None,
            10,
            {"parentSlot": 9, "transactions": []},
        ]
        with (
            patch.object(feed.config, "rpc", side_effect=responses) as rpc,
            patch.object(feed.time, "sleep"),
            patch.object(feed, "save_state"),
            patch.object(feed, "_beat"),
        ):
            feed.run_block_feed([], state, {"once": True, "sleep": 0})
        block_calls = [item for item in rpc.call_args_list if item.args[0] == "getBlock"]
        self.assertEqual([item.args[1][0] for item in block_calls], [10, 10])
        self.assertEqual(state["block_slot"], 10)

    def test_once_retries_exhaustion_keeps_previous_checkpoint(self):
        state = {"block_slot": 9}
        responses = [10, 10, None, 10, None]
        with (
            patch.object(feed.config, "rpc", side_effect=responses) as rpc,
            patch.object(feed.time, "sleep"),
            patch.object(feed, "save_state"),
            patch.object(feed, "_beat"),
            patch.object(feed, "_BLOCK_RETRY_MAX", 2),
            self.assertRaisesRegex(RuntimeError, "cursor unchanged"),
        ):
            feed.run_block_feed([], state, {"once": True, "sleep": 0})
        block_calls = [item for item in rpc.call_args_list if item.args[0] == "getBlock"]
        self.assertEqual([item.args[1][0] for item in block_calls], [10, 10])
        self.assertEqual(state["block_slot"], 9)


if __name__ == "__main__":
    unittest.main()
