import unittest
from unittest import mock

import bridge


class _Response:
    status_code = 200
    content = b"{}"
    headers = {}


class UpstreamHeaderTest(unittest.TestCase):
    """The balances endpoint defaults to Solana without x-supported-chains."""

    def setUp(self) -> None:
        self.requests: list[tuple[str, dict[str, str]]] = []

        def fake_get(url: str, params=None, headers=None, **_kwargs):
            self.requests.append((url, dict(headers or {})))
            return _Response()

        self.patchers = [
            mock.patch.object(bridge.curl_requests, "get", side_effect=fake_get),
            mock.patch.object(bridge.TOKENS, "access_token", return_value="token"),
            mock.patch.object(bridge.PACER, "wait", return_value=None),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()

    def test_balances_swaps_and_trades_list_declare_supported_chains(self) -> None:
        bridge.upstream_get("/v2/users/user-id/balances", {})
        bridge.upstream_get("/v2/users/user-id/swaps", {"limit": "100"})
        bridge.upstream_get("/trades", {"userId": "user-id", "orderBy": "closedAt"})
        self.assertEqual(len(self.requests), 3)
        for _, headers in self.requests:
            self.assertEqual(headers.get("x-supported-chains"), bridge.SUPPORTED_CHAINS)

    def test_trade_detail_does_not_declare_supported_chains(self) -> None:
        bridge.upstream_get("/trades/trade-id", {})
        self.assertNotIn("x-supported-chains", self.requests[0][1])


if __name__ == "__main__":
    unittest.main()
