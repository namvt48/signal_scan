import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from watchers.fomo import feed


class FomoCreditSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            "plan": "pro",
            "credits": {
                "monthly": 1000,
                "usedThisMonth": 12.5,
                "prepaid": 4,
                "remaining": 991.5,
            },
        }

    def test_parse_valid_account_credits(self):
        plan, credits = feed._parse_fomo_credits(self.payload)
        self.assertEqual(plan, "pro")
        self.assertEqual(credits["monthly"], 1000.0)
        self.assertEqual(set(credits), set(feed.FOMO_CREDIT_FIELDS))

    def test_reject_malformed_missing_negative_and_nonfinite_credits(self):
        for payload in (None, {}, {"credits": None}, {"credits": {}}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                feed._parse_fomo_credits(payload)
        for bad in (-1, float("nan"), float("inf"), True, "1"):
            with self.subTest(value=bad):
                payload = json.loads(json.dumps(self.payload))
                payload["credits"]["monthly"] = bad
                with self.assertRaises(ValueError):
                    feed._parse_fomo_credits(payload)

    def test_write_is_sanitized_and_atomic_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fomo-usage.json"
            state = {}
            snapshot = feed._write_fomo_usage(
                "private-token", state, 1234, lambda _key: feed._parse_fomo_credits(self.payload), path
            )
            decoded = json.loads(path.read_text())
            self.assertEqual(decoded, snapshot)
            self.assertEqual(snapshot["source"], "fomo-v2-me")
            self.assertEqual(snapshot["fetchedAtMs"], 1234)
            self.assertNotIn("private-token", path.read_text())
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_failure_retains_last_valid_credits_and_masks_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fomo-usage.json"
            state = {}
            good = lambda _key: feed._parse_fomo_credits(self.payload)
            feed._write_fomo_usage("secret", state, 100, good, path)
            previous = dict(state["snapshot"])
            def fail(_key):
                raise RuntimeError("request included secret")
            snapshot = feed._write_fomo_usage("secret", state, 200, fail, path)
            self.assertEqual(snapshot["credits"], previous["credits"])
            self.assertEqual(snapshot["fetchedAtMs"], previous["fetchedAtMs"])
            self.assertEqual(snapshot["attemptedAtMs"], 200)
            self.assertNotIn("secret", json.dumps(snapshot))
            self.assertEqual(json.loads(path.read_text()), snapshot)

    def test_request_uses_bearer_header_and_timeout(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return None
            def read(self):
                return json.dumps(self.payload).encode()

        response = Response()
        response.payload = self.payload
        with patch.object(feed.urllib.request, "urlopen", return_value=response) as open_url:
            feed._fomo_me_request("secret")
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, feed.FOMO_ME_URL)
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertEqual(open_url.call_args.kwargs["timeout"], 5)


if __name__ == "__main__":
    unittest.main()
