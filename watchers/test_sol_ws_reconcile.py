import asyncio
import unittest
from unittest.mock import patch

from watchers.sol import feed, recovery


class SolWebsocketReconcileTests(unittest.TestCase):
    def test_reconcile_loop_recovers_signature_without_notification(self):
        wallet = "So11111111111111111111111111111111111111112"
        state = {"wallets": {wallet: {"head": "baseline"}}}
        signature_params = []

        def rpc(method, params):
            if method == "getSignaturesForAddress":
                options = params[1]
                signature_params.append(options)
                return [{"signature": "missed", "err": None}] if options.get("until") == "baseline" else []
            if method == "getTransaction":
                return {
                    "transaction": {"message": {}},
                    "meta": {},
                    "blockTime": 1_700_000_000,
                }
            raise AssertionError(method)

        async def run_until_recovered():
            task = asyncio.create_task(feed._reconcile_loop([wallet], state, interval=3600))
            try:
                for _ in range(300):
                    if state.get("sol_recovery", {}).get(wallet, {}).get("signature") == "missed":
                        return
                    await asyncio.sleep(0.01)
                raise AssertionError("reconciliation did not recover the missed signature")
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        with (
            patch.object(feed.config, "_cfg_next", float("inf")),
            patch.object(feed.config, "_tracking_since_ms", 1_700_000_000_000),
            patch.object(feed.config, "rpc", side_effect=rpc),
            patch.object(feed, "save_state"),
            patch.object(recovery, "save_state"),
            patch.object(feed, "_keys", return_value=[wallet]),
            patch.object(feed, "_warm_prices"),
            patch.object(feed, "detect_events", return_value=[]),
        ):
            asyncio.run(run_until_recovered())

        self.assertTrue(any("until" in params for params in signature_params))
        self.assertEqual(state["sol_recovery"][wallet]["signature"], "missed")
        self.assertEqual(state["wallets"][wallet]["head"], "missed")


if __name__ == "__main__":
    unittest.main()
