import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch

from watchers.common import config
from watchers.sol import feed


class _FakeWebSocket:
    def __init__(self, subscriptions):
        self.subscriptions = subscriptions

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def send(self, message):
        self.subscriptions.append(json.loads(message)["params"][0]["mentions"][0])

    async def recv(self):
        await asyncio.Future()


class SolWebsocketRefreshTests(unittest.TestCase):
    def _run_refreshes(self, initial_wallets, transitions):
        wallets = list(initial_wallets)
        connections = []
        api_refreshes = 0
        transition_index = 0
        real_sleep = asyncio.sleep

        class Connector:
            def __call__(self, *_args, **_kwargs):
                subscriptions = []
                connections.append(subscriptions)
                return _FakeWebSocket(subscriptions)

        def refresh_from_api(current_wallets):
            nonlocal api_refreshes, transition_index
            api_refreshes += 1
            if transition_index < len(transitions) and api_refreshes > 1:
                current_wallets[:] = transitions[transition_index]
                transition_index += 1
            config._cfg_next = 0

        async def controlled_sleep(delay):
            task = asyncio.current_task()
            if delay == 1:
                if transition_index == 0:
                    for _ in range(100):
                        if connections and len(connections[0]) == len(initial_wallets):
                            break
                        await real_sleep(0)
                elif transition_index >= len(transitions):
                    expected_latest = len(wallets)
                    for _ in range(100):
                        if not expected_latest or (
                            len(connections) > 1
                            and len(connections[-1]) == expected_latest
                        ):
                            break
                        await real_sleep(0)
                    task.cancel()
                await real_sleep(0)
            else:
                await real_sleep(0)

        with (
            patch.object(config, "RPCS", ["https://rpc.example"]),
            patch.object(config, "_cfg_next", 0),
            patch.object(config, "_CFG_REFRESH_S", 1),
            patch.object(feed, "_beat"),
            patch.object(feed, "load_config_from_api", side_effect=refresh_from_api),
            patch.object(feed, "reconcile_cycle"),
            patch.dict(sys.modules, {"websockets": types.SimpleNamespace(connect=Connector())}),
            patch("asyncio.sleep", side_effect=controlled_sleep),
        ):
            with self.assertRaises(asyncio.CancelledError):
                feed.run_ws_feed(wallets, {})
        self.assertGreaterEqual(api_refreshes, len(transitions) + 1)
        return connections

    def test_idle_refresh_resubscribes_added_and_removed_addresses(self):
        old = "11111111111111111111111111111111"
        retained = "So11111111111111111111111111111111111111112"
        added = "SysvarRent111111111111111111111111111111111"
        subscriptions = self._run_refreshes([old, retained], [[retained, added]])
        self.assertEqual(subscriptions, [[old, retained], [retained, added]])

    def test_empty_latest_list_cancels_all_shards(self):
        first = "11111111111111111111111111111111"
        second = "So11111111111111111111111111111111111111112"
        subscriptions = self._run_refreshes([first, second], [[]])
        self.assertEqual(subscriptions, [[first, second]])

    def test_periodic_refresh_runs_without_websocket_transactions(self):
        original = "11111111111111111111111111111111"
        replacement = "So11111111111111111111111111111111111111112"
        subscriptions = self._run_refreshes([original], [[replacement]])
        self.assertEqual(subscriptions, [[original], [replacement]])


if __name__ == "__main__":
    unittest.main()
