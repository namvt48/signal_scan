"""Offline contract tests for durable EVM trade delivery."""

import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from watchers.evm import delivery


class Journal:
    def __init__(self, path):
        self.path = path
        if pathlib.Path(path).exists():
            self.item = json.loads(pathlib.Path(path).read_text())
        else:
            self.item = None

    def enqueue(self, trade, block=0, block_hash=""):
        self.item = {"id": "one", "payload": trade, "attempts": 0, "next": 0}
        self._save()

    def due(self, now, limit):
        if self.item and not self.item.get("blocked") and self.item["next"] <= now:
            return [dict(self.item)]
        return []
    def defer(self, key, next_at, error, blocked=False):
        self.item["attempts"] += 1
        self.item.update(next=next_at, error=error, blocked=blocked)
        self._save()

    def ack(self, key):
        self.item = None
        pathlib.Path(self.path).unlink(missing_ok=True)

    def halted(self, chain):
        return False

    def _save(self):
        pathlib.Path(self.path).write_text(json.dumps(self.item))


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(pathlib.Path(self.tmp.name) / "outbox.json")
        self.journal = Journal(self.path)
        delivery.configure(self.journal)
        self.body = {"wallet": "w", "ca": "c", "tx": "t", "ts": 1,
                     "side": "buy", "chain": "base", "block": 12,
                     "blockHash": "secret-local", "amountUsd": 3}

    def tearDown(self):
        delivery.configure(None)
        self.tmp.cleanup()

    def test_retry_and_backoff_survive_reopen(self):
        delivery.post_trade(self.body)
        def throttled(*args, **kwargs):
            raise urllib.error.HTTPError("url", 429, "limited", {"Retry-After": "9"}, None)
        old = delivery.config.http_json
        delivery.config.http_json = throttled
        try:
            self.assertEqual(delivery.drain_once(now=100), 0)
        finally:
            delivery.config.http_json = old
        reopened = Journal(self.path)
        delivery.configure(reopened)
        self.assertEqual(reopened.item["next"], 109)
        self.assertEqual(reopened.item["attempts"], 1)

    def test_network_retry_persists(self):
        delivery.post_trade(self.body)
        old = delivery.config.http_json
        delivery.config.http_json = lambda *a, **k: (_ for _ in ()).throw(OSError("offline"))
        try:
            self.assertEqual(delivery.drain_once(now=5), 0)
        finally:
            delivery.config.http_json = old
        self.assertEqual(Journal(self.path).item["attempts"], 1)

    def test_inserted_zero_and_pass_tier_ack_and_wire_excludes_metadata(self):
        for response in ({"inserted": 0}, {"inserted": 1}, {"skipped": "pass-tier"}):
            delivery.post_trade(self.body)
            captured = {}
            old = delivery.config.http_json
            def send(url, payload, **kwargs):
                captured.update(payload)
                return response
            delivery.config.http_json = send
            try:
                self.assertEqual(delivery.drain_once(now=100), 1)
            finally:
                delivery.config.http_json = old
            self.assertNotIn("block", captured)
            self.assertNotIn("blockHash", captured)
            self.assertIsNone(self.journal.item)

    def test_400_is_blocked_and_retained(self):
        delivery.post_trade(self.body)
        old = delivery.config.http_json
        delivery.config.http_json = lambda *a, **k: (_ for _ in ()).throw(
            urllib.error.HTTPError("url", 400, "bad request", {}, None))
        try:
            self.assertEqual(delivery.drain_once(now=10), 0)
        finally:
            delivery.config.http_json = old
        self.assertTrue(self.journal.item["blocked"])
        self.assertEqual(self.journal.item["error"], "HTTP 400")
        self.assertEqual(self.journal.item["attempts"], 1)


if __name__ == "__main__":
    unittest.main()
