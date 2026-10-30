import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import request_guard



class FakeUpstreamGuardIntegrationTest(unittest.TestCase):
    @contextmanager
    def _request(self, guard, statuses, slot=None):
        import threading
        from http.server import ThreadingHTTPServer
        from types import SimpleNamespace
        from urllib.error import HTTPError
        from urllib.request import urlopen

        import bridge
        calls = []

        def fake_get(url, **kwargs):
            calls.append(url)
            response = statuses.pop(0)
            status, headers, *gates = response
            if gates:
                entered, release = gates[0]
                entered.set()
                if not release.wait(timeout=5):
                    raise TimeoutError("test response gate timed out")
            return SimpleNamespace(status_code=status, headers=headers, content=b'{"fake":true}')

        server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with mock.patch.object(bridge, "GUARD", guard), \
             mock.patch.object(bridge, "TOKENS") as tokens, \
             mock.patch.object(bridge, "PACER") as pacer, \
             mock.patch.object(bridge, "SLOTS", slot if slot is not None else bridge.SLOTS), \
             mock.patch.object(bridge.curl_requests, "get", side_effect=fake_get):
            tokens.access_token.return_value = "fake-token"
            pacer.wait.return_value = None
            try:
                def get(path):
                    try:
                        with urlopen(f"http://127.0.0.1:{server.server_port}{path}") as response:
                            return response.status, {name.lower(): value for name, value in response.headers.items()}, response.read()
                    except HTTPError as response:
                        return response.code, {name.lower(): value for name, value in response.headers.items()}, response.read()
                yield get, calls, tokens
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_403_on_one_endpoint_latches_all_endpoints_without_more_upstream_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(20, 100, 1000))
            with self._request(guard, [(403, {})]) as (get, calls, tokens):
                first = get("/v2/users/example/balances")
                second = get("/trades/example")
                self.assertEqual(first[0], 403)
                self.assertEqual(second[0], 503)
                self.assertEqual(second[1]["x-fomo-guard"], "suspended")
                self.assertEqual(second[1]["x-fomo-retry-handled"], "1")
                self.assertEqual(len(calls), 1)
                self.assertEqual(tokens.access_token.call_count, 1)

    def test_queued_handler_cannot_send_after_first_handler_receives_403(self):
        import threading

        class ObservedSlot:
            def __init__(self):
                self._semaphore = threading.BoundedSemaphore(1)
                self._lock = threading.Lock()
                self._attempts = 0
                self._exits = 0
                self.second_queued = threading.Event()
                self.second_acquired = threading.Event()

            def __enter__(self):
                with self._lock:
                    self._attempts += 1
                    if self._attempts == 2:
                        self.second_queued.set()
                self._semaphore.acquire()
                with self._lock:
                    if self._attempts >= 2:
                        self.second_acquired.set()
                return self

            def __exit__(self, *_):
                self._semaphore.release()
                with self._lock:
                    self._exits += 1
                    first_exit = self._exits == 1
                if first_exit:
                    self.second_acquired.wait(timeout=2)

        from threading import Event, Thread

        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(20, 100, 1000))
            slot = ObservedSlot()
            first_entered, release_first = Event(), Event()
            statuses = [(403, {}, (first_entered, release_first)), (200, {})]
            with self._request(guard, statuses, slot) as (get, calls, _):
                results = {}
                first = Thread(target=lambda: results.setdefault(
                    "first", get("/v2/users/example/balances")))
                second = Thread(target=lambda: results.setdefault(
                    "second", get("/trades/example")))
                first.start()
                self.assertTrue(first_entered.wait(timeout=2), "first fake upstream call did not start")
                second.start()
                try:
                    self.assertTrue(slot.second_queued.wait(timeout=2), "second handler was not queued")
                finally:
                    release_first.set()
                first.join(timeout=5)
                second.join(timeout=5)
                self.assertFalse(first.is_alive())
                self.assertFalse(second.is_alive())
                self.assertEqual(results["first"][0], 403)
                self.assertEqual(results["second"][0], 503)
                self.assertEqual(results["second"][1]["x-fomo-guard"], "suspended")
                self.assertEqual(len(calls), 1)

    def test_budget_exhaustion_is_shared_and_returns_full_window_delay(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(1, 10, 100))
            with self._request(guard, [(200, {})]) as (get, calls, _):
                self.assertEqual(get("/v2/users/example/balances")[0], 200)
                status, headers, _ = get("/trades/example")
                self.assertEqual(status, 429)
                self.assertEqual(headers["x-fomo-guard"], "budget_exhausted")
                self.assertGreaterEqual(int(headers["retry-after"]), 1)
                self.assertEqual(len(calls), 1)

    def test_unlimited_quota_mode_keeps_403_suspension(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            "os.environ", {"FOMO_REQUEST_QUOTA_MODE": "unlimited"}
        ):
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(1, 1, 1))
            with self._request(guard, [(200, {}), (403, {})]) as (get, calls, _):
                self.assertEqual(get("/v2/users/example/swaps")[0], 200)
                self.assertEqual(get("/v2/users/example/balances")[0], 403)
                self.assertEqual(get("/trades/example")[0], 503)
                self.assertEqual(guard.snapshot()["state"], "suspended")
                self.assertEqual(len(calls), 2)

    def test_unlimited_quota_mode_keeps_retry_after_cooldown(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            "os.environ", {"FOMO_REQUEST_QUOTA_MODE": "unlimited"}
        ):
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(0, 0, 0))
            with self._request(guard, [(429, {"retry-after": "300"})]) as (get, calls, _):
                self.assertEqual(get("/v2/users/example/swaps")[0], 429)
                status, headers, _ = get("/trades/example")
                self.assertEqual(status, 429)
                self.assertEqual(headers["x-fomo-guard"], "cooldown")
                self.assertEqual(headers["retry-after"], "300")
                self.assertEqual(len(calls), 1)

    def test_429_without_retry_after_uses_global_cooldown_default(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(20, 100, 1000))
            with self._request(guard, [(429, {})]) as (get, calls, _):
                first = get("/v2/users/example/swaps")
                second = get("/trades/example")
                self.assertEqual(first[0], 429)
                self.assertEqual(second[0], 429)
                self.assertEqual(second[1]["x-fomo-guard"], "cooldown")
                self.assertEqual(second[1]["retry-after"], "60")
                self.assertEqual(len(calls), 1)

    def test_503_retry_after_defers_all_endpoints_without_retrying(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(20, 100, 1000))
            with self._request(guard, [(503, {"retry-after": "75"})]) as (get, calls, _):
                first = get("/v2/users/example/balances")
                second = get("/trades/example")
                self.assertEqual(first[0], 503)
                self.assertEqual(second[0], 429)
                self.assertEqual(second[1]["retry-after"], "75")
                self.assertEqual(len(calls), 1)
    def test_transient_5xx_retries_are_bounded_and_each_attempt_is_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(3, 10, 100))
            with self._request(guard, [(500, {}), (502, {}), (200, {})]) as (get, calls, _):
                status, _, _ = get("/v2/users/example/swaps")
                self.assertEqual(status, 200)
                self.assertEqual(len(calls), 3)
                state = guard.snapshot()
                self.assertEqual(state["state"], "budget_exhausted")

class PersistentGuardBehaviorTest(unittest.TestCase):
    def test_suspension_persists_and_reset_retains_quota_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "guard.json")
            guard = request_guard.RequestGuard(path, enabled="true", limits=(1, 2, 3))
            guard.authorize()
            guard.suspend()
            restarted = request_guard.RequestGuard(path, enabled="true", limits=(1, 2, 3))
            with self.assertRaises(request_guard.GuardError) as blocked:
                restarted.authorize()
            self.assertEqual(blocked.exception.state, "suspended")
            restarted.reset()
            with self.assertRaises(request_guard.GuardError) as limited:
                restarted.authorize()
            self.assertEqual(limited.exception.state, "budget_exhausted")

    def test_disabled_zero_quota_and_corrupt_state_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "guard.json")
            for guard in (request_guard.RequestGuard(path, enabled="false", limits=(1, 1, 1)),
                          request_guard.RequestGuard(path, enabled="true", limits=(0, 1, 1))):
                with self.assertRaises(request_guard.GuardError) as blocked:
                    guard.authorize()
                self.assertEqual(blocked.exception.state, "paused")
            Path(path).write_text("not-json")
            with self.assertRaises(request_guard.GuardError) as corrupt:
                request_guard.RequestGuard(path, enabled="true", limits=(1, 1, 1)).authorize()
            self.assertEqual(corrupt.exception.state, "state_error")

    def test_unlimited_mode_still_requires_enablement_and_valid_state(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            "os.environ", {"FOMO_REQUEST_QUOTA_MODE": "unlimited"}
        ):
            path = str(Path(directory) / "guard.json")
            guard = request_guard.RequestGuard(path, enabled="false", limits=(0, 0, 0))
            with self.assertRaises(request_guard.GuardError) as paused:
                guard.authorize()
            self.assertEqual(paused.exception.state, "paused")
            Path(path).write_text("not-json")
            with self.assertRaises(request_guard.GuardError) as corrupt:
                request_guard.RequestGuard(path, enabled="true", limits=(0, 0, 0)).authorize()
            self.assertEqual(corrupt.exception.state, "state_error")

    def test_unlimited_quota_mode_bypasses_caps_but_preserves_suspension(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            "os.environ", {"FOMO_REQUEST_QUOTA_MODE": "unlimited"}
        ):
            path = str(Path(directory) / "guard.json")
            initial_windows = {"minute": {"start": 120, "count": 1}}
            Path(path).write_text(json.dumps({
                "version": 1, "suspended": False, "cooldown_until": 0,
                "windows": initial_windows,
            }))
            guard = request_guard.RequestGuard(
                path, enabled="true", limits=(1, 1, 1), clock=lambda: 120
            )
            for _ in range(5):
                guard.authorize()
            state = json.loads(Path(path).read_text())
            self.assertEqual(state["windows"], initial_windows)

            state["suspended"] = True
            Path(path).write_text(json.dumps(state))
            restarted = request_guard.RequestGuard(
                path, enabled="true", limits=(1, 1, 1), clock=lambda: 120
            )
            with self.assertRaises(request_guard.GuardError) as blocked:
                restarted.authorize()
            self.assertEqual(blocked.exception.state, "suspended")

    def test_failed_suspension_persistence_still_blocks_this_process(self):
        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(10, 10, 10))
            with mock.patch.object(guard, "_save", side_effect=OSError("disk unavailable")):
                guard.suspend()
                with self.assertRaises(request_guard.GuardError) as blocked:
                    guard.check()
            self.assertEqual(blocked.exception.state, "suspended")

    def test_concurrent_reservations_cannot_overspend_shared_budget(self):
        from concurrent.futures import ThreadPoolExecutor

        with tempfile.TemporaryDirectory() as directory:
            guard = request_guard.RequestGuard(str(Path(directory) / "guard.json"),
                                               enabled="true", limits=(5, 20, 100))

            def reserve():
                try:
                    guard.authorize()
                    return True
                except request_guard.GuardError as exc:
                    if exc.state == "budget_exhausted":
                        return False
                    raise

            with ThreadPoolExecutor(max_workers=12) as workers:
                results = list(workers.map(lambda _: reserve(), range(20)))
            self.assertEqual(sum(results), 5)

    def test_retry_after_accepts_seconds_and_http_date(self):
        from email.utils import formatdate
        import bridge
        self.assertEqual(bridge._retry_after("120"), 120)
        deadline = 2_000_000_000
        with unittest.mock.patch.object(bridge.time, "time", return_value=deadline - 10):
            self.assertEqual(bridge._retry_after(formatdate(deadline, usegmt=True)), 10)


if __name__ == "__main__":
    unittest.main()
