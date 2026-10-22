"""Feed FOMO: poll prod-api.fomo.family swaps through the local bridge.

The public browser API is the free source of truth. This watcher no longer opens
the paid firehose; it asks `server/fomo-prod/bridge.py` for each watched user's
recent swaps, detects swaps that moved USD into or out of a token, and POSTs the
same idempotent `/api/fomo-watch/trades` body the old socket watcher used.

Polling trades freshness for latency (-~1 minute) but keeps the alert contract:
  swap id -> eventId = "fomo-swap:<id>"
  buy  = outTokenAddress is the token and inTokenAddress is a quote asset
  sell = inTokenAddress is the token and outTokenAddress is a quote asset
  ts -> createdAt (epoch ms)
  tradeUsd -> USD spent/received on the quote leg when the API reports it
  userId/trader -> from the watch list; token/price are optional

The first poll for a user only records a cursor, so deploying this watcher does
not replay the last 100 swaps as alerts. The cursor advances only after a
successful ingest, so a failed POST is retried on the next cycle. If more than
one page of swaps arrives between cycles, the oldest are dropped: this feed has
never backfilled gaps and does not start now.

State/heartbeat use FOMO-specific files (`fomo_state.json` / `fomo_heartbeat`)
so a second daemon cannot mask this watcher's liveness.
"""

import asyncio
import base64
import http.client
import itertools
import json
import logging
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from watchers.common import config
from watchers.common.config import _CFG_REFRESH_S, HERE, api_headers

FOMO_PROD_URL = os.environ.get("FOMO_PROD_URL", "http://127.0.0.1:8131").rstrip("/")
FOMO_POLL_INTERVAL_S = max(10, int(os.environ.get("FOMO_POLL_INTERVAL_S", "60")))
FOMO_SWAPS_LIMIT = min(100, max(1, int(os.environ.get("FOMO_SWAPS_LIMIT", "100"))))
FOMO_EVM_FEED = os.environ.get("FOMO_EVM_FEED", "on").strip().lower() not in ("0", "off", "false", "no")
FOMO_EVM_FEED_LIMIT = min(100, max(1, int(os.environ.get("FOMO_EVM_FEED_LIMIT", "100"))))
FOMO_EVM_BOOTSTRAP_LOOKBACK_S = max(0, int(os.environ.get("FOMO_EVM_BOOTSTRAP_LOOKBACK_S", "900")))
FOMO_TRACKED_CAS_REFRESH_S = max(30, int(os.environ.get("FOMO_TRACKED_CAS_REFRESH_S", "300")))
FOMO_MONITOR_HEARTBEAT = Path("/root/signal-scan-monitor/heartbeats/fomo")

# Network ids used by prod-api.fomo.family.
_CHAIN_BY_NETWORK = {
    1399811149: "sol",
    8453: "base",
    56: "bsc",
    4663: "robinhood",
}
_NETWORK_BY_CHAIN = {chain: nid for nid, chain in _CHAIN_BY_NETWORK.items() if chain != "sol"}

# A swap into one of these assets is a sell, not a buy. EVM addresses are
# compared case-insensitively. Robinhood includes both USDG deployments the
# chain explorer reports plus wrapped ETH.
_QUOTE_ASSETS: dict[str, set[str]] = {
    "sol": {
        "So11111111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
    "base": {
        "0x4200000000000000000000000000000000000006",
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    },
    "bsc": {
        "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        "0x55d398326f99059ff775485246999027b3197955",
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    },
    "robinhood": {
        "0x4200000000000000000000000000000000000006",
        "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        "0xdb81a12de6c0aebeddf2d85d531dd50cac7366ef",
    },
}
_SEEN_MAX = 4096

_HTTP_MAX_ATTEMPTS = 3
_PROD_TIMEOUT_S = max(5, int(os.environ.get("FOMO_PROD_TIMEOUT_S", "40")))
_INGEST_TIMEOUT_S = 5
_RETRYABLE_HTTP = {429, 500, 502, 503, 504}

DIAGNOSTIC_LOG_PATH = Path(HERE) / "logs" / "fomo-poll.jsonl"
_DIAGNOSTIC_MAX_BYTES = 16 * 1024 * 1024
_DIAGNOSTIC_BACKUPS = 10
_DIAGNOSTIC_SEQUENCE = itertools.count(1)
_DIAGNOSTIC_LOGGER = logging.getLogger("watchers.fomo.diagnostics")
_DIAGNOSTIC_SECRETS: tuple[bytes, ...] = ()
_SENSITIVE_JSON_FIELD = re.compile(
    r'(?i)("(?:api[_-]?key|key|access[_-]?token|service[_-]?token|'
    r'authorization|secret|password|credential)"\s*:\s*)"(?:\\.|[^"\\])*"'
)
_SENSITIVE_QUERY_VALUE = re.compile(
    r'(?i)([?&](?:api[_-]?key|key|access[_-]?token|service[_-]?token|token)=)'
    r'[^&\s"\\]+'
)


class _StrictRotatingFileHandler(RotatingFileHandler):
    """Disable diagnostics without interrupting alert processing on I/O failure."""

    def handleError(self, record: logging.LogRecord) -> None:
        error = sys.exc_info()[1]
        _disable_diagnostics(type(error).__name__ if error else "LogWriteError")

    def doRollover(self) -> None:
        super().doRollover()
        for index in range(self.backupCount + 1):
            path = self.baseFilename if index == 0 else f"{self.baseFilename}.{index}"
            if os.path.exists(path):
                os.chmod(path, 0o600)


_DIAGNOSTIC_WARNING_EMITTED = False


def _warn_diagnostics_unavailable(error_type: str) -> None:
    global _DIAGNOSTIC_WARNING_EMITTED
    if _DIAGNOSTIC_WARNING_EMITTED:
        return
    _DIAGNOSTIC_WARNING_EMITTED = True
    try:
        print(
            f"! fomo diagnostics disabled ({error_type}); trade processing continues",
            file=sys.stderr,
            flush=True,
        )
    except Exception:
        pass


def _disable_diagnostics(error_type: str) -> None:
    for handler in _DIAGNOSTIC_LOGGER.handlers[:]:
        _DIAGNOSTIC_LOGGER.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass
    _warn_diagnostics_unavailable(error_type)


def configure_diagnostics(
    path: str | os.PathLike[str] | None = None,
    *,
    secret_values: tuple[str, ...] | list[str] = (),
) -> None:
    """Write timestamped JSONL diagnostics; disable them if setup fails."""
    global _DIAGNOSTIC_SECRETS, _DIAGNOSTIC_WARNING_EMITTED
    _DIAGNOSTIC_SECRETS = tuple(
        secret.encode("utf-8") for secret in secret_values if secret
    )
    _DIAGNOSTIC_WARNING_EMITTED = False
    target = Path(path) if path is not None else Path(DIAGNOSTIC_LOG_PATH)
    handler: _StrictRotatingFileHandler | None = None
    for old_handler in _DIAGNOSTIC_LOGGER.handlers[:]:
        _DIAGNOSTIC_LOGGER.removeHandler(old_handler)
        try:
            old_handler.close()
        except Exception as error:
            _warn_diagnostics_unavailable(type(error).__name__)
    try:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(target.parent, 0o700)
        handler = _StrictRotatingFileHandler(
            target,
            maxBytes=_DIAGNOSTIC_MAX_BYTES,
            backupCount=_DIAGNOSTIC_BACKUPS,
            encoding="utf-8",
        )
        os.chmod(target, 0o600)
        handler.setFormatter(logging.Formatter("%(message)s"))
        _DIAGNOSTIC_LOGGER.setLevel(logging.INFO)
        _DIAGNOSTIC_LOGGER.propagate = False
        _DIAGNOSTIC_LOGGER.addHandler(handler)
    except Exception as error:
        if handler is not None:
            try:
                handler.close()
            except Exception:
                pass
        _disable_diagnostics(type(error).__name__)


def close_diagnostics() -> None:
    global _DIAGNOSTIC_SECRETS
    for handler in _DIAGNOSTIC_LOGGER.handlers[:]:
        _DIAGNOSTIC_LOGGER.removeHandler(handler)
        try:
            handler.close()
        except Exception as error:
            _warn_diagnostics_unavailable(type(error).__name__)
    _DIAGNOSTIC_SECRETS = ()


def _diagnostic(event: str, *, cycle_id: str | None = None, **fields: Any) -> None:
    if not _DIAGNOSTIC_LOGGER.handlers:
        return
    try:
        row = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "event": event,
        }
        if cycle_id is not None:
            row["cycle_id"] = cycle_id
        row.update(fields)
        _DIAGNOSTIC_LOGGER.info(
            json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        )
    except Exception as error:
        _disable_diagnostics(type(error).__name__)


def _diagnostic_payload(raw: Any) -> dict[str, str]:
    """Preserve text or binary responses while masking credential-like values."""
    if isinstance(raw, bytes):
        payload = raw
        for secret in _DIAGNOSTIC_SECRETS:
            payload = payload.replace(secret, b"***")
        payload = re.sub(
            rb'(?i)("(?:api[_-]?key|key|access[_-]?token|service[_-]?token|'
            rb'authorization|secret|password|credential)"\s*:\s*)"(?:\\.|[^"\\])*"',
            rb'\1"***"',
            payload,
        )
        payload = re.sub(
            rb"(?i)([?&](?:api[_-]?key|key|access[_-]?token|service[_-]?token|token)=)"
            rb'[^&\s"\\]+',
            rb"\1***",
            payload,
        )
        return {"encoding": "base64", "data": base64.b64encode(payload).decode("ascii")}
    if isinstance(raw, str):
        payload = raw
        for secret in _DIAGNOSTIC_SECRETS:
            payload = payload.replace(secret.decode("utf-8", "ignore"), "***")
        payload = _SENSITIVE_JSON_FIELD.sub(r'\1"***"', payload)
        payload = _SENSITIVE_QUERY_VALUE.sub(r"\1***", payload)
        return {"encoding": "text", "data": payload}
    return {"encoding": "repr", "data": repr(raw)}


def _new_cycle_id() -> str:
    return f"{time.time_ns()}-{next(_DIAGNOSTIC_SEQUENCE)}"


def _request_bytes_with_retry(
    req: urllib.request.Request,
    on_attempt: Any = None,
    *,
    timeout: float = _INGEST_TIMEOUT_S,
) -> bytes:
    """Read a complete response inside each bounded HTTP/transport attempt."""
    for attempt in range(1, _HTTP_MAX_ATTEMPTS + 1):
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                data = response.read()
                if on_attempt is not None:
                    on_attempt(
                        attempt=attempt,
                        outcome="acknowledged",
                        status_code=getattr(response, "status", 200),
                        duration_ms=round((time.monotonic() - started) * 1000, 3),
                        response=_diagnostic_payload(data),
                    )
                return data
        except urllib.error.HTTPError as ex:
            if on_attempt is not None:
                on_attempt(
                    attempt=attempt,
                    outcome="http_error",
                    status_code=ex.code,
                    duration_ms=round((time.monotonic() - started) * 1000, 3),
                )
            if ex.code not in _RETRYABLE_HTTP or attempt == _HTTP_MAX_ATTEMPTS:
                raise
            delay = min(0.5 * (2 ** (attempt - 1)), 2.0)
            try:
                retry_after = float(ex.headers.get("Retry-After", ""))
                delay = min(max(delay, retry_after), 2.0)
            except (TypeError, ValueError):
                pass
        except (
            urllib.error.URLError,
            TimeoutError,
            http.client.IncompleteRead,
        ) as ex:
            if on_attempt is not None:
                on_attempt(
                    attempt=attempt,
                    outcome="transport_error",
                    error_type=type(ex).__name__,
                    duration_ms=round((time.monotonic() - started) * 1000, 3),
                )
            if attempt == _HTTP_MAX_ATTEMPTS:
                raise
            delay = min(0.5 * (2 ** (attempt - 1)), 2.0)
        time.sleep(delay)
    raise RuntimeError("unreachable retry state")


STATE_PATH = os.path.join(HERE, "fomo_state.json")
HEARTBEAT = os.path.join(HERE, "fomo_heartbeat")

# eventId emitted — replay/restart can show the same swap again; clear-all at cap.
_seen: set[str] = set()
# Watch list loaded from GET /api/fomo-users; refreshed every ~300s so UI changes
# take effect without a restart.
_wl: dict[str, Any] = {"users": [], "next": 0.0, "skipped": 0}
# Attached EVM chains have no per-user swap route on the free API; their
# activity is only exposed by the token-scoped feed. Refresh the tracked
# EVM CAs from the API so the feed pass follows the dashboard state.
_evm: dict[str, Any] = {"cas": [], "next": 0.0}


def _beat() -> None:
    for path in (HEARTBEAT, FOMO_MONITOR_HEARTBEAT):
        try:
            open(path, "w").close()
        except OSError:
            pass


def load_state() -> dict[str, Any]:
    """{emitted, last_ts, seen[], cursors{}} — corrupt/missing file => empty state."""
    global _seen
    try:
        st = json.load(open(STATE_PATH))
        if not isinstance(st, dict):
            st = {}
    except Exception:
        st = {}
    _seen = {e for e in (st.get("seen") or []) if isinstance(e, str)}
    if not isinstance(st.get("cursors"), dict):
        st["cursors"] = {}
    return st


def save_state(st: dict[str, Any]) -> None:
    """Atomic state write, bounded dedupe set, private mode."""
    st = {**st, "seen": list(_seen)[-_SEEN_MAX:]}
    directory = os.path.dirname(STATE_PATH) or "."
    os.makedirs(directory, exist_ok=True)
    temporary_path = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=directory, delete=False
        ) as temporary:
            json.dump(st, temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = temporary.name
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, STATE_PATH)
    except OSError as error:
        print(f"  ! fomo state: {type(error).__name__}", file=sys.stderr)
        try:
            if temporary_path:
                os.unlink(temporary_path)
        except OSError:
            pass


def refresh_watch_list(force: bool = False) -> None:
    """GET {api}/api/fomo-users → identities. Fail-soft: keep the previous list."""
    if not force and time.time() < _wl["next"]:
        return
    _wl["next"] = time.time() + _CFG_REFRESH_S
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/fomo-users", headers=api_headers()
        )
        data = json.loads(_request_bytes_with_retry(req))
        users: list[dict[str, str]] = []
        seen: set[str] = set()
        skipped = 0
        for entry in data if isinstance(data, list) else []:
            if not isinstance(entry, dict):
                continue
            uid = entry.get("userId") if isinstance(entry.get("userId"), str) else ""
            handle = entry.get("handle") if isinstance(entry.get("handle"), str) else ""
            # prod /swaps and /balances reject handles with HTTP 400; polling a
            # handle-only row every cycle would only log noise.
            if not uid:
                skipped += 1
                continue
            if uid in seen:
                continue
            seen.add(uid)
            users.append({"identity": uid, "userId": uid, "handle": handle})
        if users != _wl["users"] or skipped != _wl.get("skipped"):
            suffix = f", skipped {skipped} without userId" if skipped else ""
            print(f"# fomo watch list: {len(users)} user(s){suffix}", flush=True)
        _wl["users"] = users
        _wl["skipped"] = skipped
    except Exception as ex:
        print(f"  ! fomo-users: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)


def refresh_evm_cas(force: bool = False) -> None:
    """GET {api}/api/tracked-cas → active EVM CAs. Fail-soft: keep the old list."""
    if not FOMO_EVM_FEED:
        return
    if not force and time.time() < _evm["next"]:
        return
    _evm["next"] = time.time() + FOMO_TRACKED_CAS_REFRESH_S
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/tracked-cas", headers=api_headers()
        )
        data = json.loads(_request_bytes_with_retry(req))
        rows: list[dict[str, str]] = []
        seen: set[str] = set()
        for entry in data if isinstance(data, list) else []:
            if not isinstance(entry, dict):
                continue
            chain = entry.get("chain")
            address = entry.get("address")
            if chain not in _NETWORK_BY_CHAIN or not isinstance(address, str) or not address:
                continue
            if entry.get("status") == "inactive":
                continue
            key = f"{chain}:{address}"
            if key in seen:
                continue
            seen.add(key)
            rows.append({"chain": chain, "address": address})
        if rows != _evm["cas"]:
            print(f"# fomo EVM feed: {len(rows)} tracked CA(s)", flush=True)
        _evm["cas"] = rows
    except Exception as ex:
        print(f"  ! fomo tracked-cas: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _num(value: Any) -> float | None:
    if isinstance(value, str) and value.strip():
        try:
            value = float(value)
        except ValueError:
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def _ms(value: Any) -> int | None:
    number = _num(value)
    if number is not None:
        milliseconds = number * 1000 if number < 10_000_000_000 else number
        return int(milliseconds) if milliseconds > 0 else None
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        milliseconds = int(parsed.timestamp() * 1000)
        return milliseconds if milliseconds > 0 else None
    return None


def _chain(network_id: Any) -> str | None:
    number = _num(network_id)
    return _CHAIN_BY_NETWORK.get(int(number)) if number is not None else None


def _is_quote_asset(chain: str, address: str) -> bool:
    assets = _QUOTE_ASSETS.get(chain)
    if not assets:
        return False
    return address in assets or (chain != "sol" and address.lower() in assets)


def _swap_body(
    swap: dict[str, Any],
    user: dict[str, str],
) -> tuple[dict[str, Any] | None, str | None]:
    """Map one prod swap to the fomo-watch body, or the exact skip reason."""
    swap_id = _str(swap.get("id"))
    if swap_id is None:
        return None, "missing_swap_id"
    at = _ms(swap.get("createdAt"))
    if at is None:
        return None, "invalid_timestamp"
    token_in = _str(swap.get("inTokenAddress"))
    token_out = _str(swap.get("outTokenAddress"))
    if token_in is None or token_out is None:
        return None, "missing_token_address"

    fallback_network = swap.get("networkId")
    in_network = swap.get("inNetworkId") or fallback_network
    out_network = swap.get("outNetworkId") or fallback_network
    in_chain = _chain(in_network)
    out_chain = _chain(out_network)
    if in_chain is None or out_chain is None:
        return None, "unsupported_chain"

    in_quote = _is_quote_asset(in_chain, token_in)
    out_quote = _is_quote_asset(out_chain, token_out)
    if in_quote == out_quote:
        return None, "unclassified_pair"

    if in_quote:
        kind, chain, ca = "buy", out_chain, token_out
        usd = _num(swap.get("humanUsdAmountIn"))
        amount = _num(swap.get("outHumanAmount"))
    else:
        kind, chain, ca = "sell", in_chain, token_in
        usd = _num(swap.get("humanUsdAmountOut"))
        amount = _num(swap.get("inHumanAmount"))

    body: dict[str, Any] = {
        "eventId": f"fomo-swap:{swap_id}",
        "type": kind,
        "tokenAddress": ca,
        "chain": chain,
        "ts": at,
    }
    if user.get("userId"):
        body["userId"] = user["userId"]
    if user.get("handle"):
        body["trader"] = user["handle"]
    if usd is not None and usd > 0:
        body["tradeUsd"] = usd
        if amount is not None and amount > 0:
            price = usd / amount
            if math.isfinite(price) and price > 0:
                body["price"] = price
    return body, None


def _feed_body(
    item: dict[str, Any],
    chain: str,
    ca: str,
) -> tuple[dict[str, Any] | None, str | None]:
    """Map one /feed/token item to the fomo-watch body, or the skip reason."""
    kind = item.get("type")
    if kind not in ("swap_buy", "swap_sell"):
        return None, "not_swap"
    feed_id = _str(item.get("id"))
    if feed_id is None:
        return None, "missing_feed_id"
    at = _ms(item.get("createdAt"))
    if at is None:
        return None, "invalid_timestamp"
    user_id = _str(item.get("userId"))
    if user_id is None:
        return None, "missing_user_id"
    usd = _num(item.get("usdAmount"))
    price = _num(item.get("price"))
    body: dict[str, Any] = {
        "eventId": f"fomo-feed:{feed_id}",
        "type": "buy" if kind == "swap_buy" else "sell",
        "tokenAddress": ca,
        "chain": chain,
        "ts": at,
        "userId": user_id,
    }
    handle = _str(item.get("userHandle"))
    if handle:
        body["trader"] = handle
    if usd is not None and usd > 0:
        body["tradeUsd"] = usd
        # A buy's size is also its entry size for the tracked-CA gate.
        if kind == "swap_buy":
            body["usdValue"] = usd
    if price is not None and price > 0:
        body["price"] = price
    return body, None


def _fetch_token_feed(
    chain: str,
    ca: str,
    cycle_id: str,
) -> list[dict[str, Any]] | None:
    network_id = _NETWORK_BY_CHAIN.get(chain)
    if network_id is None:
        return None
    url = (
        f"{FOMO_PROD_URL}/feed/token?tokenAddress={urllib.parse.quote(ca, safe='')}"
        f"&networkId={network_id}&limit={FOMO_EVM_FEED_LIMIT}"
    )
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        data = _request_bytes_with_retry(req, timeout=_PROD_TIMEOUT_S)
        payload = json.loads(data)
    except Exception as ex:
        _diagnostic(
            "evm_feed_failure",
            cycle_id=cycle_id,
            chain=chain,
            ca=ca,
            error_type=type(ex).__name__,
            status_code=getattr(ex, "code", None),
        )
        return None
    if not isinstance(payload, dict) or payload.get("success") is not True:
        _diagnostic("evm_feed_failure", cycle_id=cycle_id, chain=chain, ca=ca, error_type="invalid_envelope")
        return None
    response = payload.get("responseObject")
    items = response.get("items") if isinstance(response, dict) else None
    if not isinstance(items, list):
        _diagnostic("evm_feed_failure", cycle_id=cycle_id, chain=chain, ca=ca, error_type="invalid_payload")
        return None
    return [item for item in items if isinstance(item, dict)]


def _poll_evm_ca(
    row: dict[str, str],
    watched: set[str],
    st: dict[str, Any],
    cycle_id: str,
) -> tuple[int, int, bool]:
    """Poll one tracked EVM CA's token feed. Returns (emitted, page size, ok)."""
    chain, ca = row["chain"], row["address"]
    items = _fetch_token_feed(chain, ca, cycle_id)
    if items is None:
        return 0, 0, False
    page: list[tuple[int, dict[str, Any]]] = []
    for item in items:
        at = _ms(item.get("createdAt"))
        if at is not None:
            page.append((at, item))
    page.sort(key=lambda pair: (pair[0], str(pair[1].get("id") or "")))

    key = f"{chain}:{ca}"
    cursors = st.setdefault("evm_cursors", {})
    cursor = _num(cursors.get(key))
    if cursor is None:
        # Bootstrap skips old history, but keeps a short grace window: when a
        # watched buy pulls a new CA into tracking, the feed poll must still
        # ingest that buy instead of dropping the page wholesale.
        if page and FOMO_EVM_BOOTSTRAP_LOOKBACK_S > 0:
            cursor = float(max(0, page[-1][0] - FOMO_EVM_BOOTSTRAP_LOOKBACK_S * 1000))
        else:
            cursor = float(page[-1][0] + 1) if page else float(int(time.time() * 1000))
        cursors[key] = cursor
        save_state(st)
        _diagnostic("evm_bootstrap", cycle_id=cycle_id, chain=chain, ca=ca, cursor=int(cursor))

    emitted = 0
    changed = False
    for at, item in page:
        if at < cursor:
            continue
        body, reason = _feed_body(item, chain, ca)
        if body is None:
            cursor = float(at)
            changed = True
            _diagnostic(
                "evm_feed_decision",
                cycle_id=cycle_id,
                chain=chain,
                ca=ca,
                decision="ignored",
                reason=reason,
                feed_id=item.get("id"),
            )
            continue
        # The token feed is not user-scoped: keep only watched traders.
        if body.get("userId") not in watched:
            cursor = float(at)
            changed = True
            continue
        event_id = body["eventId"]
        if event_id in _seen:
            cursor = float(at)
            changed = True
            continue
        if not post_fomo_trade(body, cycle_id=cycle_id):
            _diagnostic(
                "evm_feed_decision",
                cycle_id=cycle_id,
                chain=chain,
                ca=ca,
                decision="not_persisted",
                reason="ingest_failed",
                event_id=event_id,
            )
            break  # keep the cursor so this event retries next cycle
        _dedupe(event_id)
        cursor = float(at)
        changed = True
        emitted += 1
        st["last_ts"] = max(st.get("last_ts") or 0, at)
        st["emitted"] = int(st.get("emitted") or 0) + 1
        save_state(st)
        _diagnostic(
            "evm_feed_decision",
            cycle_id=cycle_id,
            chain=chain,
            ca=ca,
            decision="ingest_acknowledged",
            reason="ingested",
            event_id=event_id,
        )
        print(
            f"# fomo {body['type']} {body.get('trader') or body['userId'][:8]}"
            f" {chain} {ca[:10]}… ${body.get('tradeUsd', 0):,.0f}"
            f"  evt {event_id[:18]}…",
            flush=True,
        )

    if changed:
        cursors[key] = cursor
        save_state(st)
    return emitted, len(page), True


def _poll_evm_feed(st: dict[str, Any], cycle_id: str) -> int:
    """Poll token feeds for tracked EVM CAs and keep watched-user swaps."""
    if not FOMO_EVM_FEED:
        return 0
    cas = list(_evm["cas"])
    watched = {str(u.get("userId")) for u in _wl["users"] if u.get("userId")}
    posted = 0
    errors = 0
    events = 0
    for row in cas:
        try:
            emitted, page_size, ok = _poll_evm_ca(row, watched, st, cycle_id)
        except Exception as ex:
            errors += 1
            _diagnostic(
                "evm_feed_failure",
                cycle_id=cycle_id,
                chain=row.get("chain"),
                ca=row.get("address"),
                error_type=type(ex).__name__,
            )
            continue
        if not ok:
            errors += 1
            continue
        posted += emitted
        events += page_size
    if errors:
        print(
            f"  ! fomo EVM feed: {errors}/{len(cas)} CA(s) failed",
            file=sys.stderr,
        )
    _diagnostic(
        "evm_feed_cycle",
        cycle_id=cycle_id,
        cas=len(cas),
        watched_users=len(watched),
        page_items=events,
        posted=posted,
        errors=errors,
    )
    return posted


def _dedupe(event_id: str) -> bool:
    """True = first sighting. Bounded like the other watchers: clear-all at cap."""
    if event_id in _seen:
        return False
    if len(_seen) > _SEEN_MAX:
        _seen.clear()
    _seen.add(event_id)
    return True


def post_fomo_trade(
    body: dict[str, Any],
    *,
    cycle_id: str | None = None,
) -> bool:
    """POST one idempotent event and log each attempt without auth headers."""
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/fomo-watch/trades",
            data=json.dumps(body).encode(),
            headers=api_headers(),
        )

        def log_attempt(**details: Any) -> None:
            _diagnostic(
                "ingest_attempt",
                cycle_id=cycle_id,
                event_id=body["eventId"],
                **details,
            )

        _request_bytes_with_retry(req, on_attempt=log_attempt)
        return True
    except urllib.error.HTTPError as ex:
        _diagnostic(
            "ingest_failure",
            cycle_id=cycle_id,
            event_id=body["eventId"],
            error_type=type(ex).__name__,
            status_code=ex.code,
        )
        if ex.code == 404:
            print(
                f"  ! ingest 404 ({body.get('trader') or body.get('userId')})"
                " — watch list stale, refresh",
                file=sys.stderr,
            )
            refresh_watch_list(force=True)
        else:
            print(f"  ! fomo-trade HTTP {ex.code}", file=sys.stderr)
        return False
    except Exception as ex:
        _diagnostic(
            "ingest_failure",
            cycle_id=cycle_id,
            event_id=body["eventId"],
            error_type=type(ex).__name__,
        )
        print(f"  ! fomo-trade: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
        return False


def _fetch_swaps(identity: str, cycle_id: str) -> list[dict[str, Any]] | None:
    url = f"{FOMO_PROD_URL}/v2/users/{urllib.parse.quote(identity, safe='')}/swaps?limit={FOMO_SWAPS_LIMIT}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        data = _request_bytes_with_retry(req, timeout=_PROD_TIMEOUT_S)
        payload = json.loads(data)
    except Exception as ex:
        _diagnostic(
            "swaps_fetch_failure",
            cycle_id=cycle_id,
            identity=identity,
            error_type=type(ex).__name__,
            status_code=getattr(ex, "code", None),
        )
        print(f"  ! fomo swaps {identity[:8]}…: {type(ex).__name__}", file=sys.stderr)
        return None
    if not isinstance(payload, dict) or payload.get("success") is not True:
        _diagnostic("swaps_fetch_failure", cycle_id=cycle_id, identity=identity, error_type="invalid_envelope")
        return None
    response = payload.get("responseObject")
    swaps = response.get("swaps") if isinstance(response, dict) else None
    if not isinstance(swaps, list):
        _diagnostic("swaps_fetch_failure", cycle_id=cycle_id, identity=identity, error_type="invalid_payload")
        return None
    return [swap for swap in swaps if isinstance(swap, dict)]


def _poll_user(user: dict[str, str], st: dict[str, Any], cycle_id: str) -> int:
    """Poll one user's newest swaps. Returns number of successfully ingested events."""
    identity = user["identity"]
    swaps = _fetch_swaps(identity, cycle_id)
    if swaps is None:
        return 0
    page: list[tuple[int, dict[str, Any]]] = []
    for swap in swaps:
        at = _ms(swap.get("createdAt"))
        if at is not None:
            page.append((at, swap))
    page.sort(key=lambda item: item[0])

    cursors = st.setdefault("cursors", {})
    cursor = _num(cursors.get(identity))
    if cursor is None:
        # Bootstrap: record the newest swap and emit nothing. This prevents a
        # deploy or a newly watched user from replaying the last page.
        # One millisecond past the newest existing swap, so every fill already
        # on the first page (including same-millisecond fills) stays historical.
        cursor = float(page[-1][0] + 1) if page else float(int(time.time() * 1000))
        cursors[identity] = cursor
        save_state(st)
        _diagnostic("poll_bootstrap", cycle_id=cycle_id, identity=identity, cursor=int(cursor))
        return 0

    emitted = 0
    changed = False
    for at, swap in page:
        # Revisit the boundary timestamp: several fills can share one
        # millisecond. `_seen` skips acknowledged ones, while a failed POST at
        # the cursor is retried instead of being stranded behind it.
        if at < cursor:
            continue
        body, reason = _swap_body(swap, user)
        if body is None:
            cursor = float(at)
            changed = True
            _diagnostic(
                "swap_decision",
                cycle_id=cycle_id,
                identity=identity,
                decision="ignored",
                reason=reason,
                swap_id=swap.get("id"),
            )
            continue
        event_id = body["eventId"]
        if event_id in _seen:
            cursor = float(at)
            changed = True
            continue
        if not post_fomo_trade(body, cycle_id=cycle_id):
            _diagnostic(
                "swap_decision",
                cycle_id=cycle_id,
                identity=identity,
                decision="not_persisted",
                reason="ingest_failed",
                event_id=event_id,
            )
            break  # keep the cursor so this swap and later ones retry next cycle
        _dedupe(event_id)
        cursor = float(at)
        changed = True
        emitted += 1
        st["last_ts"] = max(st.get("last_ts") or 0, at)
        st["emitted"] = int(st.get("emitted") or 0) + 1
        save_state(st)
        _diagnostic(
            "swap_decision",
            cycle_id=cycle_id,
            identity=identity,
            decision="ingest_acknowledged",
            reason="ingested",
            event_id=event_id,
        )
        print(
            f"# fomo {body['type']} {body.get('trader') or body.get('userId') or identity[:8]}"
            f" {body['chain']} {body['tokenAddress'][:10]}…"
            f" ${body.get('tradeUsd', 0):,.0f}  evt {event_id[:18]}…",
            flush=True,
        )

    if changed:
        cursors[identity] = cursor
        save_state(st)
    return emitted


async def _beat_loop() -> None:
    while True:
        _beat()
        await asyncio.sleep(30)


async def _poll_loop(st: dict[str, Any], once: bool) -> None:
    first = True
    while True:
        try:
            refresh_watch_list(force=first)
            users = list(_wl["users"])
            cycle_id = _new_cycle_id()
            _diagnostic(
                "poll_cycle_started",
                cycle_id=cycle_id,
                watchlist_users=len(users),
                endpoint=FOMO_PROD_URL,
            )
            for user in users:
                try:
                    _poll_user(user, st, cycle_id)
                except Exception as ex:
                    print(
                        f"  ! fomo poll {user['identity'][:8]}…: {type(ex).__name__}",
                        file=sys.stderr,
                    )
                    _diagnostic(
                        "poll_user_failure",
                        cycle_id=cycle_id,
                        identity=user["identity"],
                        error_type=type(ex).__name__,
                    )
            if FOMO_EVM_FEED:
                refresh_evm_cas(force=first)
                _poll_evm_feed(st, cycle_id)
            _beat()
            _diagnostic(
                "poll_cycle_finished",
                cycle_id=cycle_id,
                emitted=st.get("emitted", 0),
            )
        except Exception as ex:
            print(f"  ! fomo poll cycle: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
        first = False
        if once:
            return
        await asyncio.sleep(FOMO_POLL_INTERVAL_S)


def run_feed(once: bool = False) -> None:
    """Run the polling loop. `once` runs exactly one watch-list cycle."""
    configure_diagnostics(secret_values=(getattr(config, "_service_token", ""),))
    st = load_state()
    _beat()
    _diagnostic(
        "watcher_started",
        endpoint=FOMO_PROD_URL,
        interval_seconds=FOMO_POLL_INTERVAL_S,
        dedupe_entries=len(_seen),
    )
    print(
        f"# fomo poll: {FOMO_PROD_URL} every {FOMO_POLL_INTERVAL_S}s"
        f" (swaps limit {FOMO_SWAPS_LIMIT}"
        f"{', EVM token feed' if FOMO_EVM_FEED else ', EVM feed off'})",
        flush=True,
    )

    async def _run() -> None:
        beat = asyncio.create_task(_beat_loop())
        try:
            await _poll_loop(st, once)
        finally:
            beat.cancel()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
    finally:
        try:
            save_state(st)
        finally:
            _beat()
            _diagnostic("watcher_stopped", once=once)
            close_diagnostics()
    if once:
        print(
            f"# fomo --once xong: emitted={st.get('emitted', 0)}"
            f" last_ts={st.get('last_ts')}",
            flush=True,
        )
