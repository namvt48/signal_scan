"""Deterministic tests for bounded EVM candidate recovery and durable retries."""
import sqlite3

from watchers.evm.journal import Journal


def test_legacy_candidate_schema_migrates_and_preserves_pending_rows(tmp_path):
    path = tmp_path / "legacy.sqlite"
    db = sqlite3.connect(path)
    db.execute("""CREATE TABLE candidates (
        id INTEGER PRIMARY KEY, chain TEXT NOT NULL, tx TEXT NOT NULL,
        block INTEGER NOT NULL, block_hash TEXT NOT NULL, transaction_json TEXT,
        trace_wallets TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0,
        UNIQUE(chain,tx,block_hash))""")
    db.execute("INSERT INTO candidates(chain,tx,block,block_hash,trace_wallets) VALUES ('base','old',10,'h','[]')")
    db.commit()
    db.close()

    journal = Journal(str(path))
    pending = journal.pending_candidates("base", now=1)
    assert len(pending) == 1
    assert pending[0]["tx"] == "old"
    assert pending[0]["reason"] == ""
    journal.defer_candidate("base", "old", 10, "h", 100, reason="trace_disabled")
    journal.close()

    journal = Journal(str(path))
    assert journal.pending_candidates("base", now=99) == []
    replay = journal.pending_candidates("base", now=100)
    assert replay[0]["reason"] == "trace_disabled"
    journal.rewind("base", 9)
    assert journal.pending_candidates("base", now=100) == []
    journal.close()


def test_recent_valid_candidate_is_not_starved_by_old_deferred_candidates(tmp_path):
    journal = Journal(str(tmp_path / "candidates.sqlite"))
    for number in range(30):
        journal.enqueue_candidate("base", f"old-{number}", number + 1, f"h{number}")
        journal.defer_candidate(
            "base", f"old-{number}", number + 1, f"h{number}",
            10_000, increment_attempts=False, reason="trace_disabled"
        )
    journal.enqueue_candidate("base", "fresh", 100, "fresh-h")

    due = journal.pending_candidates("base", limit=8, now=1_000)
    assert [item["tx"] for item in due] == ["fresh"]
    journal.close()


def test_retry_schedule_is_deadline_bounded_and_reasoned(tmp_path):
    journal = Journal(str(tmp_path / "retry.sqlite"))
    journal.enqueue_candidate("base", "tx", 100, "hash")
    journal.defer_candidate(
        "base", "tx", 100, "hash", 180, reason="transient"
    )
    assert journal.pending_candidates("base", now=179) == []
    due = journal.pending_candidates("base", now=180)
    assert due[0]["reason"] == "transient"
    assert due[0]["attempts"] == 1
    journal.close()
