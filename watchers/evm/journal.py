"""Durable, single-writer journal for EVM ingestion."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager


CHAINS = ("base", "bsc", "robinhood")


class DeepReorgError(RuntimeError):
    """A reorg invalidated an event which was already delivered."""


class Journal:
    def __init__(self, path):
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("PRAGMA busy_timeout=30000")
            self._schema()

    def _schema(self):
        self._db.executescript("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cursors (chain TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS halts (chain TEXT PRIMARY KEY, reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox (
          id INTEGER PRIMARY KEY, chain TEXT NOT NULL, block_key TEXT NOT NULL,
          block INTEGER NOT NULL, tx TEXT NOT NULL, log_index TEXT NOT NULL,
          payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          UNIQUE(chain, block_key, tx, log_index));
        CREATE TABLE IF NOT EXISTS processed (
          chain TEXT NOT NULL, tx TEXT NOT NULL, block INTEGER NOT NULL,
          block_hash TEXT NOT NULL, PRIMARY KEY(chain,tx,block_hash));
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY, chain TEXT NOT NULL, wallet TEXT NOT NULL,
          ca TEXT NOT NULL, tx TEXT NOT NULL, side TEXT NOT NULL,
          block INTEGER NOT NULL, block_hash TEXT NOT NULL, payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '', blocked INTEGER NOT NULL DEFAULT 0,
          delivered INTEGER NOT NULL DEFAULT 0,
          UNIQUE(chain,wallet,ca,tx,side,block_hash));
        CREATE TABLE IF NOT EXISTS cache (
          chain TEXT NOT NULL, tx TEXT NOT NULL, kind TEXT NOT NULL,
          value TEXT NOT NULL, block INTEGER NOT NULL,
          PRIMARY KEY(chain,tx,kind));
        CREATE TABLE IF NOT EXISTS headers (
          chain TEXT NOT NULL, height INTEGER NOT NULL, hash TEXT NOT NULL,
          parent_hash TEXT NOT NULL, PRIMARY KEY(chain,height));
        CREATE TABLE IF NOT EXISTS candidates (
          id INTEGER PRIMARY KEY, chain TEXT NOT NULL, tx TEXT NOT NULL,
          block INTEGER NOT NULL, block_hash TEXT NOT NULL, transaction_json TEXT,
          trace_wallets TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0,
          UNIQUE(chain,tx,block_hash));
        """)
        columns = {
            row[1] for row in self._db.execute("PRAGMA table_info(candidates)")
        }
        for name, definition in (
            ("attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("next_at", "REAL NOT NULL DEFAULT 0"),
        ):
            if name not in columns:
                self._db.execute(f"ALTER TABLE candidates ADD COLUMN {name} {definition}")

    def close(self):
        with self._lock:
            self._db.close()

    @contextmanager
    def _transaction(self):
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield self._db
                self._db.commit()
            except DeepReorgError:
                self._db.commit()
                raise
            except BaseException:
                self._db.rollback()
                raise

    @staticmethod
    def _json(value):
        return json.dumps(value, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _number(value):
        try:
            return int(value, 16) if isinstance(value, str) and value.startswith("0x") else int(value or 0)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _safe_state(state):
        result = json.loads(json.dumps(state))
        evm = result.setdefault("evm", {})
        for chain, cursor in evm.items():
            if isinstance(cursor, dict):
                cursor.pop("chunk_rpc", None)
        return result

    def load_state(self, legacy):
        with self._transaction() as db:
            row = db.execute("SELECT value FROM meta WHERE key='migrated'").fetchone()
            if row is None:
                state = self._safe_state(legacy if isinstance(legacy, dict) else {})
                evm = state.setdefault("evm", {})
                for chain in CHAINS:
                    evm.setdefault(chain, {})
                for chain, cursor in evm.items():
                    if isinstance(cursor, dict):
                        db.execute("INSERT OR REPLACE INTO cursors VALUES (?,?)", (chain, self._json(cursor)))
                db.execute("INSERT INTO meta VALUES ('migrated','1')")
                db.execute("INSERT INTO meta VALUES ('state',?)", (self._json(state),))
                return state
            row = db.execute("SELECT value FROM meta WHERE key='state'").fetchone()
            state = json.loads(row[0]) if row else {"evm": {}}
            state = self._safe_state(state)
            for cursor in db.execute("SELECT chain,value FROM cursors"):
                state.setdefault("evm", {})[cursor[0]] = json.loads(cursor[1])
            return state

    def save_state(self, state):
        safe = self._safe_state(state)
        with self._transaction() as db:
            for chain, cursor in safe.get("evm", {}).items():
                if not isinstance(cursor, dict):
                    continue
                row = db.execute(
                    "SELECT value FROM cursors WHERE chain=?", (chain,)
                ).fetchone()
                existing = json.loads(row[0]) if row else {}
                merged = {**existing, **cursor}
                for field in ("last_block", "last_tx_block"):
                    if field in existing:
                        merged[field] = max(
                            self._number(existing[field]),
                            self._number(cursor.get(field, existing[field])),
                        )
                if existing.get("recovery"):
                    merged["recovery"] = True
                merged.pop("chunk_rpc", None)
                safe["evm"][chain] = merged
                db.execute(
                    "INSERT OR REPLACE INTO cursors VALUES (?,?)",
                    (chain, self._json(merged)),
                )
            db.execute("INSERT OR REPLACE INTO meta VALUES ('state',?)", (self._json(safe),))
    @staticmethod
    def _block_identity(log):
        block = Journal._number(log.get("blockNumber", log.get("block", 0)))
        block_hash = str(log.get("blockHash") or "")
        return block, block_hash or str(block)

    def _halt(self, db, chain, reason):
        db.execute("INSERT OR REPLACE INTO halts VALUES (?,?)", (chain, reason))

    def record_log(self, chain, log):
        block, block_key = self._block_identity(log)
        tx = str(log.get("transactionHash", log.get("tx", "")))
        index = str(log.get("logIndex", "0"))
        with self._transaction() as db:
            if log.get("removed"):
                delivered = db.execute("SELECT id FROM outbox WHERE chain=? AND tx=? AND block=? AND delivered=1", (chain, tx, block)).fetchone()
                if delivered:
                    self._halt(db, chain, "removed delivered event")
                    raise DeepReorgError(f"delivered event removed on {chain}")
                db.execute("DELETE FROM candidates WHERE chain=? AND tx=? AND block=? AND status='pending'", (chain, tx, block))
                db.execute("DELETE FROM inbox WHERE chain=? AND tx=? AND block=? AND status='pending'", (chain, tx, block))
                db.execute("DELETE FROM outbox WHERE chain=? AND tx=? AND block=? AND delivered=0", (chain, tx, block))
                return
            db.execute("""INSERT INTO inbox(chain,block_key,block,tx,log_index,payload)
                VALUES(?,?,?,?,?,?) ON CONFLICT(chain,block_key,tx,log_index)
                DO UPDATE SET payload=excluded.payload,status='pending'""",
                (chain, block_key, block, tx, index, self._json(log)))

    def pending_logs(self, chain, limit=500):
        with self._lock:
            rows = self._db.execute("SELECT payload FROM inbox WHERE chain=? AND status='pending' ORDER BY block,id LIMIT ?", (chain, max(0, limit))).fetchall()
            return [json.loads(row[0]) for row in rows]

    def complete_log(self, chain, log):
        block, block_key = self._block_identity(log)
        tx = str(log.get("transactionHash", log.get("tx", "")))
        index = str(log.get("logIndex", "0"))
        with self._transaction() as db:
            db.execute("UPDATE inbox SET status='done' WHERE chain=? AND block_key=? AND tx=? AND log_index=?", (chain, block_key, tx, index))

    def seen(self, chain, tx, block_hash=""):
        with self._lock:
            return self._db.execute("SELECT 1 FROM processed WHERE chain=? AND tx=? AND block_hash=?", (chain, tx, block_hash or "")).fetchone() is not None

    def mark_tx(self, chain, tx, block, block_hash=""):
        with self._transaction() as db:
            db.execute("INSERT OR IGNORE INTO processed VALUES (?,?,?,?)", (chain, tx, self._number(block), block_hash or ""))
    def enqueue_candidate(self, chain, tx_hash, block, block_hash="", transaction=None, trace_wallets=()):
        block_num = self._number(block)
        tx_json = self._json(transaction) if transaction is not None else None
        with self._transaction() as db:
            row = db.execute("SELECT trace_wallets,transaction_json FROM candidates WHERE chain=? AND tx=? AND block_hash=?", (chain, tx_hash, block_hash or "")).fetchone()
            wallets = set(json.loads(row[0])) if row else set()
            wallets.update(str(wallet) for wallet in trace_wallets)
            stored_tx = tx_json or (row[1] if row else None)
            db.execute("""INSERT INTO candidates(chain,tx,block,block_hash,transaction_json,trace_wallets)
                VALUES(?,?,?,?,?,?) ON CONFLICT(chain,tx,block_hash) DO UPDATE SET
                trace_wallets=excluded.trace_wallets,transaction_json=COALESCE(excluded.transaction_json,candidates.transaction_json)""",
                (chain, tx_hash, block_num, block_hash or "", stored_tx, self._json(sorted(wallets))))

    def pending_candidates(self, chain, limit=500, now=None):
        current = time.time() if now is None else now
        with self._lock:
            rows = self._db.execute(
                """SELECT tx,block,block_hash,transaction_json,trace_wallets,attempts
                   FROM candidates WHERE chain=? AND status='pending' AND next_at<=?
                   ORDER BY block,id LIMIT ?""",
                (chain, current, max(0, limit)),
            ).fetchall()
        return [
            {
                "tx": row[0],
                "block": row[1],
                "blockHash": row[2],
                "transaction": json.loads(row[3]) if row[3] else None,
                "trace_wallets": json.loads(row[4]),
                "attempts": row[5],
            }
            for row in rows
        ]

    def defer_candidate(self, chain, tx_hash, block, block_hash, next_at):
        with self._transaction() as db:
            db.execute(
                """UPDATE candidates SET attempts=attempts+1,next_at=?
                   WHERE chain=? AND tx=? AND block=? AND block_hash=? AND status='pending'""",
                (float(next_at), chain, tx_hash, self._number(block), block_hash or ""),
            )

    def complete_candidate(self, chain, tx_hash, block, block_hash=""):
        with self._transaction() as db:
            db.execute("UPDATE candidates SET status='done' WHERE chain=? AND tx=? AND block=? AND block_hash=?", (chain, tx_hash, self._number(block), block_hash or ""))

    def advance_candidate_block(self, chain, candidates, block, field="last_tx_block"):
        """Atomically persist block candidates and advance its cursor."""
        if field not in ("last_block", "last_tx_block"):
            raise ValueError("unsupported cursor field")
        with self._transaction() as db:
            for candidate in candidates:
                tx_hash = str(candidate["tx"])
                block_hash = str(candidate.get("blockHash") or "")
                block_num = self._number(candidate.get("block", block))
                tx_json = self._json(candidate["transaction"]) if candidate.get("transaction") is not None else None
                row = db.execute("SELECT trace_wallets,transaction_json FROM candidates WHERE chain=? AND tx=? AND block_hash=?", (chain, tx_hash, block_hash)).fetchone()
                wallets = set(json.loads(row[0])) if row else set()
                wallets.update(str(wallet) for wallet in candidate.get("trace_wallets", ()))
                stored_tx = tx_json or (row[1] if row else None)
                db.execute("""INSERT INTO candidates(chain,tx,block,block_hash,transaction_json,trace_wallets)
                    VALUES(?,?,?,?,?,?) ON CONFLICT(chain,tx,block_hash) DO UPDATE SET
                    trace_wallets=excluded.trace_wallets,transaction_json=COALESCE(excluded.transaction_json,candidates.transaction_json)""",
                    (chain, tx_hash, block_num, block_hash, stored_tx, self._json(sorted(wallets))))
            row = db.execute("SELECT value FROM cursors WHERE chain=?", (chain,)).fetchone()
            cursor = json.loads(row[0]) if row else {}
            cursor[field] = max(self._number(cursor.get(field, 0)), self._number(block))
            db.execute("INSERT OR REPLACE INTO cursors VALUES (?,?)", (chain, self._json(cursor)))
            state_row = db.execute("SELECT value FROM meta WHERE key='state'").fetchone()
            state = json.loads(state_row[0]) if state_row else {"evm": {}}
            state.setdefault("evm", {})[chain] = cursor
            db.execute("INSERT OR REPLACE INTO meta VALUES ('state',?)", (self._json(state),))
    def record_candidates_and_advance(self, chain, candidates, field, block):
        return self.advance_candidate_block(chain, candidates, block, field)

    def advance_cursor(self, chain, field, block):
        if field not in ("last_block", "last_tx_block"):
            raise ValueError("unsupported cursor field")
        target = self._number(block)
        with self._transaction() as db:
            row = db.execute("SELECT value FROM cursors WHERE chain=?", (chain,)).fetchone()
            cursor = json.loads(row[0]) if row else {}
            cursor[field] = max(self._number(cursor.get(field, 0)), target)
            if field == "last_block":
                cursor.pop("recovery", None)
            db.execute("INSERT OR REPLACE INTO cursors VALUES (?,?)", (chain, self._json(cursor)))
            state_row = db.execute("SELECT value FROM meta WHERE key='state'").fetchone()
            state = json.loads(state_row[0]) if state_row else {"evm": {}}
            state.setdefault("evm", {})[chain] = cursor
            db.execute("INSERT OR REPLACE INTO meta VALUES ('state',?)", (self._json(state),))

    def state(self, chain):
        with self._lock:
            row = self._db.execute("SELECT value FROM cursors WHERE chain=?", (chain,)).fetchone()
            return json.loads(row[0]) if row else {}



    def headers(self, chain, limit=256):
        with self._lock:
            rows = self._db.execute(
                "SELECT height,hash,parent_hash FROM headers WHERE chain=? ORDER BY height DESC LIMIT ?",
                (chain, max(0, limit)),
            ).fetchall()
        return [
            {"height": row[0], "hash": row[1], "parentHash": row[2]}
            for row in reversed(rows)
        ]

    def record_header(self, chain, header, limit=256):
        height = self._number(header.get("number"))
        block_hash = str(header.get("hash") or "")
        parent_hash = str(header.get("parentHash") or "")
        if not block_hash or height < 0:
            return
        with self._transaction() as db:
            db.execute(
                "INSERT OR REPLACE INTO headers VALUES (?,?,?,?)",
                (chain, height, block_hash, parent_hash),
            )
            db.execute(
                "DELETE FROM headers WHERE chain=? AND height<?",
                (chain, max(0, height - max(1, limit) + 1)),
            )
    def rewind(self, chain, block):
        ancestor = self._number(block)
        with self._transaction() as db:
            delivered = db.execute("SELECT id FROM outbox WHERE chain=? AND block>? AND delivered=1 LIMIT 1", (chain, ancestor)).fetchone()
            if delivered:
                self._halt(db, chain, "delivered event invalidated by reorg")
                row = db.execute("SELECT value FROM cursors WHERE chain=?", (chain,)).fetchone()
                if row:
                    cursor = json.loads(row[0])
                    for key in ("last_block", "last_tx_block"):
                        if key in cursor:
                            cursor[key] = min(self._number(cursor[key]), ancestor)
                    db.execute("UPDATE cursors SET value=? WHERE chain=?", (self._json(cursor), chain))
                raise DeepReorgError(f"reorg crossed delivered event on {chain}")
            db.execute("DELETE FROM candidates WHERE chain=? AND block>? AND status='pending'", (chain, ancestor))
            db.execute("DELETE FROM inbox WHERE chain=? AND block>?", (chain, ancestor))
            db.execute("DELETE FROM outbox WHERE chain=? AND block>? AND delivered=0", (chain, ancestor))
            db.execute("DELETE FROM cache WHERE chain=? AND block>?", (chain, ancestor))
            db.execute("DELETE FROM processed WHERE chain=? AND block>?", (chain, ancestor))
            db.execute("DELETE FROM headers WHERE chain=? AND height>?", (chain, ancestor))
            row = db.execute("SELECT value FROM cursors WHERE chain=?", (chain,)).fetchone()
            if row:
                cursor = json.loads(row[0])
                for key in ("last_block", "last_tx_block"):
                    if key in cursor:
                        cursor[key] = min(self._number(cursor[key]), ancestor)
                if ancestor == 0:
                    cursor["recovery"] = True
                db.execute("UPDATE cursors SET value=? WHERE chain=?", (self._json(cursor), chain))
                state = db.execute("SELECT value FROM meta WHERE key='state'").fetchone()
                if state:
                    value = json.loads(state[0]); value.setdefault("evm", {})[chain] = cursor
                    db.execute("UPDATE meta SET value=? WHERE key='state'", (self._json(value),))

    def halted(self, chain):
        with self._lock:
            return self._db.execute("SELECT 1 FROM halts WHERE chain=?", (chain,)).fetchone() is not None

    def enqueue(self, trade, block, block_hash=""):
        payload = json.loads(self._json(trade))
        chain = str(payload.get("chain", ""))
        values = (chain, str(payload.get("wallet", "")), str(payload.get("ca", "")), str(payload.get("tx", "")), str(payload.get("side", "")), self._number(block), block_hash or str(payload.get("blockHash", "")), self._json(payload))
        with self._transaction() as db:
            db.execute("""INSERT OR IGNORE INTO outbox(chain,wallet,ca,tx,side,block,block_hash,payload)
                         VALUES(?,?,?,?,?,?,?,?)""", values)

    def due(self, now=None, limit=100):
        now = time.time() if now is None else now
        with self._lock:
            rows = self._db.execute("""SELECT o.id,o.payload,o.attempts FROM outbox o
                WHERE o.delivered=0 AND o.blocked=0 AND o.next_at<=?
                AND NOT EXISTS (SELECT 1 FROM halts h WHERE h.chain=o.chain)
                ORDER BY o.id LIMIT ?""", (now, max(0, limit))).fetchall()
            return [{"id": row[0], "payload": json.loads(row[1]), "attempts": row[2]} for row in rows]

    def ack(self, item_id):
        with self._transaction() as db:
            db.execute("UPDATE outbox SET delivered=1,error='' WHERE id=?", (item_id,))

    def defer(self, item_id, next_at, error, blocked=False):
        safe_error = str(error).replace("\n", " ")[:500]
        with self._transaction() as db:
            db.execute("UPDATE outbox SET attempts=attempts+1,next_at=?,error=?,blocked=? WHERE id=? AND delivered=0", (next_at, safe_error, int(blocked), item_id))

    def stats(self):
        with self._lock:
            counts = {row[0]: row[1] for row in self._db.execute("SELECT CASE WHEN delivered=1 THEN 'delivered' WHEN blocked=1 THEN 'blocked' ELSE 'pending' END,count(*) FROM outbox GROUP BY 1")}
            return {key: counts.get(key, 0) for key in ("pending", "blocked", "delivered")}

    def get_cache(self, chain, tx, kind):
        with self._lock:
            row = self._db.execute("SELECT value FROM cache WHERE chain=? AND tx=? AND kind=?", (chain, tx, kind)).fetchone()
            return json.loads(row[0]) if row else None

    def put_cache(self, chain, tx, kind, value, block):
        with self._transaction() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?,?,?)", (chain, tx, kind, self._json(value), self._number(block)))
