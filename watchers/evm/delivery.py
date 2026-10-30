"""Durable delivery of EVM wallet trades to the wallet-watch API."""

import email.utils
import json
import time
import urllib.error

from watchers.common import config

_journal = None
_MAX_BACKOFF = 3600
_BASE_BACKOFF = 2
_TRADE_FIELDS = ("wallet", "ca", "tx", "ts", "side", "chain", "amountUsd", "price", "provenance")


def configure(journal):
    """Set the durable outbox used by the delivery worker."""
    global _journal
    _journal = journal


def _require_journal():
    if _journal is None:
        raise RuntimeError("EVM delivery journal is not configured")
    return _journal


def post_trade(body):
    """Queue a candidate trade; block metadata stays local to the journal."""
    if body.get("provenance") not in ("live", "cursor", "historical"):
        raise ValueError("trade provenance is required")
    journal = _require_journal()
    trade = {key: body[key] for key in _TRADE_FIELDS if key in body}
    journal.enqueue(trade, block=body.get("block", 0), block_hash=body.get("blockHash", ""))


def _retry_after(error, now):
    headers = getattr(error, "headers", None)
    value = headers.get("Retry-After") if headers else None
    if value is None:
        return None
    try:
        return max(0, min(_MAX_BACKOFF, int(float(value))))
    except (ValueError, TypeError):
        try:
            parsed = email.utils.parsedate_to_datetime(value).timestamp()
            return max(0, min(_MAX_BACKOFF, int(parsed - now)))
        except (TypeError, ValueError, OverflowError):
            return None


def _retry_delay(attempts, error, now):
    retry = _retry_after(error, now)
    if retry is not None:
        return retry
    exponent = min(max(int(attempts) - 1, 0), 20)
    return min(_MAX_BACKOFF, _BASE_BACKOFF * (2 ** exponent))


def _valid_response(result):
    if not isinstance(result, dict):
        return False
    if result.get("skipped") == "pass-tier":
        return True
    inserted = result.get("inserted")
    return isinstance(inserted, int) and not isinstance(inserted, bool) and inserted >= 0


def _payload(item):
    import json

    payload = item.get("payload")
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        decoded = json.loads(payload)
        if isinstance(decoded, dict):
            return decoded
    raise ValueError("journal outbox payload is not an object")


def _delivery_chain(item):
    try:
        return _payload(item).get("chain")
    except (KeyError, TypeError, ValueError):
        return None

def _send(journal, item, now):
    payload = _payload(item)
    try:
        result = config.http_json(
            f"{config._api_url}/api/wallet-watch/trades", payload,
            timeout=5, headers=config.api_headers(),
        )
    except urllib.error.HTTPError as exc:
        status = exc.code
        if status == 429 or status >= 500:
            delay = _retry_delay(item.get("attempts", 0) + 1, exc, now)
            journal.defer(item["id"], now + delay, f"HTTP {status}")
        elif 400 <= status < 500:
            journal.defer(item["id"], now + _MAX_BACKOFF, f"HTTP {status}", blocked=True)
        else:
            journal.defer(item["id"], now + _MAX_BACKOFF, f"HTTP {status}", blocked=True)
        return False
    except Exception as exc:
        delay = _retry_delay(item.get("attempts", 0) + 1, exc, now)
        journal.defer(item["id"], now + delay, type(exc).__name__)
        return False
    if _valid_response(result):
        journal.ack(item["id"])
        return True
    journal.defer(item["id"], now + _MAX_BACKOFF, "invalid success response", blocked=True)
    return False


def drain_once(limit=100, now=None, stop=None):
    """Deliver due outbox entries; return number acknowledged."""
    journal = _require_journal()
    current = time.time() if now is None else now
    delivered = 0
    for item in journal.due(now=current, limit=limit):
        if stop is not None and stop.is_set():
            break
        chain = _delivery_chain(item)
        if chain is not None and journal.halted(chain):
            continue
        delivered += _send(journal, item, current)
    return delivered


def run(stop):
    """Run one bounded delivery worker until its stop event is signalled."""
    while not stop.is_set():
        drain_once(stop=stop)
        stop.wait(1)


