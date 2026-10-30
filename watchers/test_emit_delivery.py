import unittest
from unittest.mock import patch

from watchers.common import config, emit


class EmitDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.track = config._track
        self.api_url = config._api_url
        config._track = True
        config._api_url = "http://watcher.test"

    def tearDown(self):
        config._track = self.track
        config._api_url = self.api_url


    def test_daemon_bodies_include_required_provenance(self):
        event = {
            "type": "SWAP",
            "side": "BUY",
            "mint": "Mint",
            "wallet": "Wallet",
            "sig": "Signature",
            "ts_epoch_ms": 1_700_000_000_000,
            "provenance": "cursor",
        }
        trade = emit.watch_trade_body(event, 1_700_000_000)
        self.assertEqual(trade["provenance"], "cursor")

    def test_watch_trade_event_reports_http_failure_for_recovery(self):
        event = {
            "side": "SELL",
            "mint": "Mint",
            "wallet": "Wallet",
            "sig": "Signature",
            "qty": 1.0,
            "quote_usd": 5.0,
            "provenance": "live",
        }
        with patch.object(emit.urllib.request, "urlopen", side_effect=OSError("offline")):
            result = emit.watch_trade_event(event, 1_700_000_000)
        self.assertIs(result, False)

    def test_post_trade_reports_http_failure_for_recovery(self):
        trade = {"wallet": "Wallet", "chain": "sol", "ca": "Mint", "tx": "Signature", "side": "sell"}
        with patch.object(emit.urllib.request, "urlopen", side_effect=OSError("offline")):
            result = emit.post_trade(trade)
        self.assertIs(result, False)

    def test_disabled_optional_posts_are_successful_noops(self):
        config._track = False
        event = {"side": "SELL", "mint": "Mint", "wallet": "Wallet", "sig": "Signature"}
        self.assertIs(emit.watch_trade_event(event), True)


if __name__ == "__main__":
    unittest.main()
