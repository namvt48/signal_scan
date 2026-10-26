import unittest
from unittest.mock import patch

from watchers.common import config


class ApiWalletFilterTests(unittest.TestCase):
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
