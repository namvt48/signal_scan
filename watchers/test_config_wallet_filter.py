import unittest
from unittest.mock import patch

from watchers.common import config


class ApiWalletFilterTests(unittest.TestCase):
    def test_api_settings_loads_deployment_cutoff(self):
        old_cutoff = config._tracking_since_ms
        try:
            with patch.object(config, "_api_url", "http://api"), patch.object(
                config,
                "http_json",
                return_value={"values": {"minUsd": 5}, "trackingSinceMs": 1_800_000_000_000},
            ):
                self.assertEqual(config._api_min_usd(), 5.0)
                self.assertEqual(config._tracking_since_ms, 1_800_000_000_000)
        finally:
            config._tracking_since_ms = old_cutoff

    def test_solana_filter_excludes_evm_wallet_even_if_api_chain_is_mislabeled(self):
        wallets = [
            {"address": "So11111111111111111111111111111111111111112", "chain": "sol"},
            {"address": "0x1234567890123456789012345678901234567890", "chain": "sol"},
            {"address": "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", "chain": "base"},
        ]
        with patch.object(config, "_api_url", "http://api"), patch.object(
            config, "http_json", return_value=wallets
        ):
            self.assertEqual(
                config._api_wallets("sol"),
                ["So11111111111111111111111111111111111111112"],
            )


if __name__ == "__main__":
    unittest.main()
