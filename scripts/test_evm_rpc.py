"""Deterministic tests for EVM provider cooldown and capability handling."""

import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from email.message import Message
from urllib.error import HTTPError

from watchers.common import config
from watchers.evm import rpc


class RpcTests(unittest.TestCase):
    def setUp(self):
        rpc.reset()
        self.now = [1000.0]
        rpc._clock = lambda: self.now[0]
        self.original = config.http_json
        self.urls = ["https://user:secret@one.example/rpc?token=abc", "https://two.example/rpc"]

    def tearDown(self):
        config.http_json = self.original
        rpc._clock = __import__("time").time
        rpc._rate_clock = __import__("time").monotonic
        rpc._rate_sleep = __import__("time").sleep
        rpc.reset()

    def test_failover_and_cooldown(self):
        calls = []
        def request(url, payload, timeout=20):
            calls.append(url)
            if "one.example" in url:
                raise OSError("offline")
            return {"result": 7}
        config.http_json = request
        self.assertEqual(rpc.call("base", "eth_blockNumber", [], self.urls), 7)
        self.assertEqual(calls, self.urls)
        self.assertEqual(rpc.ready_urls(self.urls, "eth_blockNumber"), [self.urls[1]])

    def test_method_unsupported_cached(self):
        calls = []
        def request(url, payload, timeout=20):
            calls.append(url)
            return {"error": {"code": -32601}}
        config.http_json = request
        with self.assertRaises(rpc.MethodUnavailable):
            rpc.call("base", "trace_block", [1], self.urls)
        self.assertEqual(rpc.ready_urls(self.urls, "trace_block"), [])
        self.assertEqual(len(calls), 2)


    def test_json_rpc_quota_cools_down_and_fails_over(self):
        calls = []
        def request(url, payload, timeout=20):
            calls.append(url)
            if "one.example" in url:
                return {"error": {"code": -32005, "message": "Monthly capacity rate limit"}}
            return {"result": "0x10"}
        config.http_json = request
        self.assertEqual(rpc.call("base", "eth_blockNumber", [], self.urls), "0x10")
        self.assertEqual(calls, self.urls)
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_blockNumber"), [])

    def test_json_rpc_range_error_stays_distinguishable(self):
        def request(url, payload, timeout=20):
            return {"error": {"code": -32000, "message": "block range exceeds limit"}}
        config.http_json = request
        with self.assertRaisesRegex(RuntimeError, "range"):
            rpc.call("base", "eth_getLogs", [], [self.urls[0]])
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_getLogs"), [self.urls[0]])

    def test_http_400_range_body_is_permanent_not_transport(self):
        import io
        import json as _json
        body = _json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32600,
                "message": "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.",
            },
        }).encode()
        def request(url, payload, timeout=20):
            raise HTTPError(url, 400, "bad request", Message(), io.BytesIO(body))
        config.http_json = request
        with self.assertRaisesRegex(RuntimeError, "10 block range"):
            rpc.call("bsc", "eth_getLogs", [], [self.urls[0]])
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_getLogs"), [self.urls[0]])

    def test_address_less_logs_are_permission_not_range(self):
        calls = []
        def request(url, payload, timeout=20):
            calls.append(url)
            if "one.example" in url:
                return {"error": {"code": -32600, "message": "Please specify an address in your request"}}
            return {"result": []}
        config.http_json = request
        self.assertEqual(rpc.call("bsc", "eth_getLogs", [], self.urls), [])
        self.assertEqual(calls, self.urls)
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_getLogs"), [])

    def test_method_not_found_text_is_cached(self):
        calls = []
        def request(url, payload, timeout=20):
            calls.append(url)
            return {"error": {"message": "method not found"}}
        config.http_json = request
        with self.assertRaises(rpc.MethodUnavailable):
            rpc.call("bsc", "trace_block", [], self.urls)
        self.assertEqual(len(calls), 2)
        with self.assertRaises(rpc.MethodUnavailable):
            rpc.call("bsc", "trace_block", [], self.urls)
        self.assertEqual(len(calls), 2)
    def test_quota_cooldown_is_shared_by_http_and_websocket_url(self):
        websocket_url = self.urls[0].replace("https://", "wss://")
        rpc.failed(self.urls[0], "quota", 30, method="eth_getLogs")
        self.assertEqual(rpc.ready_urls([websocket_url], "wss"), [])

    def test_request_limit_message_is_quota(self):
        self.assertEqual(
            rpc._error_category({"message": "request limit reached"}), "quota"
        )
        self.assertEqual(
            rpc._error_category(
                {"message": "Your app has exceeded its compute units per second capacity"}
            ),
            "quota",
        )
        self.assertEqual(
            rpc._error_category(
                {"message": "Archive requests require a personal token"}
            ),
            "permission",
        )

    def test_transport_exception_quota_markers_are_categorized(self):
        calls = []
        def request(url, payload, timeout=20):
            calls.append(url)
            raise OSError("HTTP 429: quota exceeded")
        config.http_json = request
        with self.assertRaises(rpc.RpcUnavailable) as caught:
            rpc.call("base", "eth_blockNumber", [], [self.urls[0]], tries=3)
        self.assertEqual(caught.exception.category, "quota")
        self.assertIn("capacity/rate limit", str(caught.exception))
        self.assertEqual(caught.exception.retry_after, 60.0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_blockNumber"), [])
    def test_retry_after_numeric_and_url_secrecy(self):
        headers = Message()
        headers["Retry-After"] = "45"
        def request(url, payload, timeout=20):
            raise HTTPError(url, 429, "quota", headers, None)
        config.http_json = request
        with self.assertRaises(rpc.RpcUnavailable) as caught:
            rpc.call("bsc", "eth_call", [], self.urls, tries=1)
        self.assertEqual(caught.exception.retry_after, 45.0)
        self.assertNotIn("secret", str(caught.exception))
        self.assertNotIn("abc", str(caught.exception))
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_call"), [])
        self.assertEqual(len(rpc.endpoint_key(self.urls[0])), 64)


    def test_retry_after_http_date_and_recovery(self):
        headers = Message()
        headers["Retry-After"] = "Thu, 01 Jan 1970 00:17:00 GMT"
        def request(url, payload, timeout=20):
            raise HTTPError(url, 429, "quota", headers, None)
        config.http_json = request
        with self.assertRaises(rpc.RpcUnavailable) as caught:
            rpc.call("robinhood", "eth_getLogs", [], [self.urls[0]], tries=1)
        self.assertEqual(caught.exception.retry_after, 20.0)
        self.now[0] += 20
        self.assertEqual(rpc.ready_urls([self.urls[0]], "eth_getLogs"), [self.urls[0]])


    def test_http_calls_are_spaced_by_configured_endpoint_interval(self):
        now = [1000.0]
        starts = []
        rpc._rate_clock = lambda: now[0]
        rpc._rate_sleep = lambda delay: now.__setitem__(0, now[0] + delay)
        config.http_json = lambda *args, **kwargs: (
            starts.append(now[0]) or {"result": "ok"}
        )
        with patch.dict(
            "os.environ", {"EVM_RPC_MIN_INTERVAL_SECONDS": "0.5"}
        ):
            for _ in range(3):
                self.assertEqual(
                    rpc.call("base", "eth_blockNumber", [], [self.urls[0]]),
                    "ok",
                )
        self.assertEqual(starts, [1000.0, 1000.5, 1001.0])

    def test_fomo_zero_interval_disables_additional_rpc_pacing(self):
        starts = []
        rpc._rate_clock = lambda: 1000.0
        rpc._rate_sleep = lambda delay: self.fail(f"unexpected sleep: {delay}")
        config.http_json = lambda *args, **kwargs: (
            starts.append(args[0]) or {"result": "ok"}
        )
        with patch.dict(
            "os.environ", {"EVM_RPC_MIN_INTERVAL_SECONDS": "0"}
        ):
            for _ in range(2):
                rpc.call("base", "eth_blockNumber", [], [self.urls[0]])
        self.assertEqual(len(starts), 2)

    def test_queued_request_rechecks_cooldown_after_429(self):
        first_started = threading.Event()
        second_waiting = threading.Event()
        second_sent = threading.Event()
        release_first = threading.Event()
        cooldown_published = threading.Event()
        release_failure = threading.Event()
        calls = []
        original_request = rpc._request
        original_failed = rpc.failed
        headers = Message()
        headers["Retry-After"] = "30"

        def request(url, payload, timeout=20):
            marker = payload["params"][0]
            calls.append(marker)
            if marker == "first":
                first_started.set()
                self.assertTrue(release_first.wait(2))
                raise HTTPError(url, 429, "quota", headers, None)
            second_sent.set()
            return {"result": "ok"}

        def observed_request(url, method, params, timeout=20):
            if params[0] == "second":
                second_waiting.set()
            return original_request(url, method, params, timeout)

        def publish_and_pause(url, category, retry_after=None, method="wss"):
            original_failed(url, category, retry_after, method)
            if category == "quota" and method == "eth_call":
                cooldown_published.set()
                self.assertTrue(release_failure.wait(2))

        def invoke(marker):
            try:
                return rpc.call("base", "eth_call", [marker], [self.urls[0]])
            except rpc.RpcUnavailable as exc:
                return exc

        config.http_json = request
        rpc._request = observed_request
        rpc.failed = publish_and_pause
        try:
            with patch.dict(
                "os.environ", {"EVM_RPC_MIN_INTERVAL_SECONDS": "0.01"}
            ):
                with ThreadPoolExecutor(max_workers=2) as workers:
                    first = workers.submit(invoke, "first")
                    self.assertTrue(first_started.wait(1))
                    second = workers.submit(invoke, "second")
                    self.assertTrue(second_waiting.wait(1))
                    release_first.set()
                    self.assertTrue(cooldown_published.wait(1))
                    sent_before_release = second_sent.wait(0.25)
                    release_failure.set()
                    first_result = first.result(timeout=2)
                    second_result = second.result(timeout=2)
        finally:
            release_first.set()
            release_failure.set()
            rpc._request = original_request
            rpc.failed = original_failed

        self.assertFalse(sent_before_release)
        self.assertEqual(calls, ["first"])
        self.assertIsInstance(first_result, rpc.RpcUnavailable)
        self.assertIsInstance(second_result, rpc.RpcUnavailable)
        self.assertEqual(second_result.category, "cooldown")


if __name__ == "__main__":
    unittest.main()
