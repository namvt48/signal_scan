import unittest
from unittest.mock import patch

from watchers.sol import feed


class SolDeliveryRetryTests(unittest.TestCase):
    def setUp(self):
        self.old_cfg_next = feed.config._cfg_next
        self.old_tracking_since_ms = feed.config._tracking_since_ms
        feed.config._cfg_next = float("inf")
        feed.config._tracking_since_ms = 1_700_000_000_000
        feed._emitted.clear()
        self.event = {
            "type": "SWAP",
            "wallet": "wallet",
            "sig": "signature",
            "mint": "mint",
            "side": "BUY",
            "step": 1,
            "qty_net": 2.0,
        }
        self.tx = {
            "blockTime": 1_700_000_000,
            "transaction": {"message": {}},
            "meta": {},
        }

    def tearDown(self):
        feed.config._cfg_next = self.old_cfg_next
        feed.config._tracking_since_ms = self.old_tracking_since_ms
        feed._emitted.clear()

    def _patched(self, watch_result=True):
        return (
            patch.object(feed, "_keys", return_value=["wallet"]),
            patch.object(feed, "_warm_prices"),
            patch.object(feed, "detect_events", return_value=[dict(self.event)]),
            patch.object(
                feed,
                "_aggregate_watch_hops",
                side_effect=lambda events: [dict(events[0])] if events else [],
            ),
            patch.object(feed, "watch_trade_event", return_value=watch_result),
            patch.object(feed, "fmt", return_value="event"),
            patch.object(feed, "jl_write"),
        )

    def _state(self, since_ms=1_700_000_000_000):
        return {
            "wallets": {},
            "sol_tracking_since_ms": since_ms,
            "sol_recovery": {"wallet": {"signature": None, "since_ms": since_ms}},
        }

    def test_pre_deploy_buy_never_posts_either_ca_or_trade(self):
        state = self._state(since_ms=1_700_000_001_000)
        feed.config._tracking_since_ms = state["sol_tracking_since_ms"]
        patches = self._patched()
        with patches[0], patches[1] as warm, patches[2] as detect, patches[3], \
                patches[4] as trade, patches[5], patches[6]:
            self.assertIs(feed._handle_tx(self.tx, "signature", ["wallet"], state), True)
        warm.assert_not_called()
        detect.assert_not_called()
        trade.assert_not_called()
        self.assertNotIn("head", state["wallets"].get("wallet", {}))
        self.assertEqual(feed._emitted, set())

    def test_deploy_boundary_buy_posts_once_across_duplicate_delivery(self):
        state = self._state()
        feed.config._tracking_since_ms = state["sol_tracking_since_ms"]
        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], \
                patches[4] as trade, patches[5], patches[6]:
            self.assertIs(feed._handle_tx(self.tx, "signature", ["wallet"], state), True)
            self.assertIs(feed._handle_tx(self.tx, "signature", ["wallet"], state), True)
        self.assertEqual(trade.call_count, 1)
        self.assertEqual(state["wallets"]["wallet"]["head"], "signature")

    def test_unknown_block_time_is_retried_not_admitted_as_now(self):
        for block_time in (None, 0, -1, float("nan"), float("inf"), True, "1700000000"):
            with self.subTest(block_time=block_time):
                state = self._state()
                patches = self._patched()
                with patches[0], patches[1], patches[2], patches[3], \
                        patches[4] as trade, patches[5], patches[6]:
                    self.assertIs(feed._handle_tx(
                        {**self.tx, "blockTime": block_time}, "signature", ["wallet"], state,
                    ), False)
                trade.assert_not_called()
                self.assertNotIn("head", state["wallets"].get("wallet", {}))

    def test_failed_trade_post_does_not_dedupe_and_retry_posts_again(self):
        state = self._state()
        patches = self._patched(watch_result=False)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            self.assertIs(feed._handle_tx(self.tx, "signature", ["wallet"], state), False)
        self.assertEqual(feed._emitted, set())
        self.assertNotIn("head", state["wallets"].get("wallet", {}))

        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6]:
            self.assertIs(feed._handle_tx(self.tx, "signature", ["wallet"], state), True)
        self.assertEqual(len(feed._emitted), 1)
        self.assertEqual(state["wallets"]["wallet"]["head"], "signature")

    def test_bootstrap_history_cannot_be_labeled_as_new_cursor_buys(self):
        state = self._state()
        state["sol_recovery"]["wallet"]["observation_start_ms"] = 1_700_000_001_000
        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], patches[4] as send, patches[5], patches[6]:
            feed._handle_tx(self.tx, "before-observation", ["wallet"], state, "cursor")
            old = send.call_args.args[0]["provenance"]
            feed._handle_tx({**self.tx, "blockTime": 1_700_000_002}, "after-observation", ["wallet"], state, "cursor")
            new = send.call_args.args[0]["provenance"]
        self.assertEqual((old, new), ("historical", "cursor"))



if __name__ == "__main__":
    unittest.main()
