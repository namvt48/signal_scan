import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from watchers.evm import delivery
from watchers.evm.journal import Journal


class EvmDeliveryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "journal.sqlite")
        self.journal = Journal(self.path)

    def tearDown(self):
        delivery.configure(None)
        self.journal.close()
        self.temp.cleanup()

    def test_configure_migrates_legacy_pending_payload_once_and_delivers_provenance(self):
        body = {
            "chain": "base", "wallet": "wallet", "ca": "token", "tx": "tx",
            "side": "buy", "block": 42, "blockHash": "hash",
        }
        self.journal.save_state({"evm": {"base": {"last_block": 77, "last_tx_block": 70}}})
        self.journal.enqueue(body, block=42, block_hash="hash")
        row = self.journal._db.execute("SELECT id FROM outbox").fetchone()
        self.journal._db.execute(
            "UPDATE outbox SET payload=?, attempts=3, next_at=0, blocked=0 WHERE id=?",
            (json.dumps({key: value for key, value in body.items() if key in delivery._TRADE_FIELDS}), row[0]),
        )
        self.journal._db.commit()
        self.journal._db.execute("DELETE FROM meta WHERE key=?", ("outbox_provenance_cursor_migration",))
        self.journal._db.commit()
        self.journal.close()

        self.journal = Journal(self.path)
        delivery.configure(self.journal)
        migrated = self.journal._db.execute(
            "SELECT payload, attempts, next_at, blocked, delivered, block, block_hash FROM outbox WHERE id=?",
            (row[0],),
        ).fetchone()
        self.assertEqual(json.loads(migrated["payload"])["provenance"], "cursor")
        self.assertEqual(
            (migrated["attempts"], migrated["next_at"], migrated["blocked"], migrated["delivered"],
             migrated["block"], migrated["block_hash"]),
            (3, 0, 0, 0, 42, "hash"),
        )
        self.assertEqual(self.journal.stats(), {"pending": 1, "blocked": 0, "delivered": 0})
        delivery.post_trade({**body, "provenance": "cursor"})
        self.assertEqual(self.journal._db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)
        self.assertIsNotNone(self.journal._db.execute(
            "SELECT value FROM meta WHERE key='outbox_provenance_cursor_migration'"
        ).fetchone())

        delivery.configure(None)
        self.journal.close()
        self.journal = Journal(self.path)
        delivery.configure(self.journal)
        self.assertEqual(len(self.journal.due(now=0)), 1)
        with patch.object(delivery.config, "http_json", return_value={"inserted": 1}) as send:
            self.assertEqual(delivery.drain_once(now=1), 1)
        self.assertEqual(send.call_args.args[1]["provenance"], "cursor")
        self.assertEqual(self.journal.stats(), {"pending": 0, "blocked": 0, "delivered": 1})
        self.assertEqual(self.journal._db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
