"""Reliability-aware EVM JSON-RPC endpoint selection."""

from __future__ import annotations

from collections import Counter
from contextlib import nullcontext
import hashlib
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit

from watchers.common import config


class MethodUnavailable(RuntimeError):
    """Every eligible endpoint reports that an RPC method is unsupported."""


class RpcUnavailable(RuntimeError):
    """No endpoint could complete an RPC request."""

    def __init__(self, message: str, category: str, retry_after: float):
        super().__init__(message)
        self.category = category
        self.retry_after = retry_after


class _ProviderFailure(RuntimeError):
    def __init__(self, category: str, retry_after: float):
        self.category = category
        self.retry_after = retry_after
_lock = threading.RLock()
_clock = time.time
_rate_clock = time.monotonic
_rate_sleep = time.sleep
_cooldowns: dict[tuple[str, str], float] = {}
_unavailable: set[tuple[str, str]] = set()
_rate_locks: dict[str, threading.RLock] = {}
_next_request: dict[str, float] = {}
_rpc_counts: Counter[tuple[str, str, str]] = Counter()
_rpc_errors: Counter[tuple[str, str, str]] = Counter()
_rpc_counts_prev: Counter[tuple[str, str, str]] = Counter()
_rpc_errors_prev: Counter[tuple[str, str, str]] = Counter()
_rpc_meter_next = 0.0
_rpc_meter_clock = time.monotonic


def _meter(chain: str, method: str, url: str, error: bool = False) -> None:
    """Count attempts per chain/method/host; log rolling 60s totals."""
    global _rpc_meter_next
    host = urlsplit(url).hostname or "?"
    key = (str(chain), str(method), host)
    with _lock:
        _rpc_counts[key] += 1
        if error:
            _rpc_errors[key] += 1
        now = _rpc_meter_clock()
        if now < _rpc_meter_next:
            return
        _rpc_meter_next = now + 60.0
        delta = _rpc_counts - _rpc_counts_prev
        err_delta = _rpc_errors - _rpc_errors_prev
        _rpc_counts_prev.clear()
        _rpc_counts_prev.update(_rpc_counts)
        _rpc_errors_prev.clear()
        _rpc_errors_prev.update(_rpc_errors)
    if not delta:
        return
    parts = " ".join(
        f"{chain}:{method}:{host}={count}"
        for (chain, method, host), count in delta.most_common()
    )
    errs = ""
    if err_delta:
        errs = " err=" + ",".join(
            f"{chain}:{method}:{host}={count}"
            for (chain, method, host), count in err_delta.most_common()
        )
    print(f"# rpc/60s total={sum(delta.values())} {parts}{errs}", flush=True)


def endpoint_key(url: str) -> str:
    """Return stable transport identity without exposing URL credentials."""
    parts = urlsplit(url)
    scheme = {"wss": "https", "ws": "http"}.get(parts.scheme, parts.scheme)
    normalized = urlunsplit((scheme, parts.netloc, parts.path, parts.query, ""))
    return hashlib.sha256(normalized.encode()).hexdigest()


def _unique(urls):
    seen = set()
    result = []
    for url in urls:
        key = endpoint_key(url)
        if key not in seen:
            seen.add(key)
            result.append(url)
    return result


def _min_interval() -> float:
    """Configured minimum time between starts to the same RPC endpoint."""
    try:
        interval = float(os.environ.get("EVM_RPC_MIN_INTERVAL_SECONDS", "0"))
    except ValueError as exc:
        raise ValueError("EVM_RPC_MIN_INTERVAL_SECONDS must be numeric") from exc
    if interval < 0 or not math.isfinite(interval):
        raise ValueError("EVM_RPC_MIN_INTERVAL_SECONDS must be finite and non-negative")
    return interval


def _endpoint_lock(url):
    key = endpoint_key(url)
    with _lock:
        return _rate_locks.setdefault(key, threading.RLock())


def _publish_failure(url, method, category, retry_after=None):
    failed(url, category, retry_after, method)
    fallback = {
        "quota": 60.0,
        "permission": 300.0,
        "transport": 5.0,
    }.get(category, 60.0)
    return _ProviderFailure(
        category, retry_after if retry_after is not None else fallback
    )


def _mark_method_unavailable(key, method):
    with _lock:
        _unavailable.add((key, method))


def _http_error_payload(exc):
    """Return the JSON-RPC error object carried by a non-2xx response."""
    try:
        raw = exc.read()
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        payload = json.loads(raw)
        error = payload.get("error") if isinstance(payload, dict) else None
        return error if isinstance(error, dict) else None
    except Exception:
        return None


def _handle_http_error(url, method, exc):
    now = _clock()
    status = exc.code
    error = _http_error_payload(exc)
    if error is not None:
        category = _error_category(error)
        if category == "range":
            raise _PermanentRpcError(
                str(error.get("message") or "provider range/results limit exceeded"),
                endpoint_key(url),
            ) from None
        if category == "method":
            _mark_method_unavailable(endpoint_key(url), method)
            raise MethodUnavailable(f"RPC method unavailable: {method}") from None
        if category in ("quota", "permission"):
            raise _publish_failure(
                url, method, category, _retry_after(exc, now)
            ) from None
    category = (
        "quota" if status == 429 else
        "permission" if status in (401, 403) else
        "transport"
    )
    raise _publish_failure(
        url, method, category, _retry_after(exc, now)
    ) from None


def _handle_transport_error(url, method, key, exc):
    category = _error_category(exc)
    if category == "method":
        _mark_method_unavailable(key, method)
        raise MethodUnavailable(f"RPC method unavailable: {method}") from None
    if category == "range":
        raise _PermanentRpcError(
            "provider range/results limit exceeded", key
        ) from None
    if category not in ("quota", "permission"):
        category = "transport"
    raise _publish_failure(url, method, category) from None


def _handle_rpc_error(url, method, key, error):
    category = _error_category(error)
    if category == "method":
        _mark_method_unavailable(key, method)
        raise MethodUnavailable(f"RPC method unavailable: {method}")
    if category == "range":
        raise _PermanentRpcError(
            str(error.get("message") or "provider range/results limit exceeded"), key
        )
    if category == "rpc":
        raise _PermanentRpcError("RPC response error", key)
    raise _publish_failure(url, method, category)


def _request(url, method, params, timeout):
    interval = _min_interval()
    key = endpoint_key(url)
    # With pacing disabled, preserve parallel independent `eth_getLogs` requests.
    boundary = _endpoint_lock(url) if interval else nullcontext()
    with boundary:
        if not ready_urls([url], method):
            with _lock:
                unsupported = (key, method) in _unavailable
            if unsupported:
                raise MethodUnavailable(f"RPC method unavailable: {method}")
            raise _ProviderFailure(
                "cooldown", _next_retry([url], method, _clock())
            )

        if interval:
            delay = max(0.0, _next_request.get(key, 0.0) - _rate_clock())
            if delay:
                _rate_sleep(delay)
            _next_request[key] = _rate_clock() + interval

        try:
            result = config.http_json(
                url,
                {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                timeout=timeout,
            )
        except HTTPError as exc:
            _handle_http_error(url, method, exc)
        except Exception as exc:
            _handle_transport_error(url, method, key, exc)

        if isinstance(result, dict) and result.get("error"):
            _handle_rpc_error(url, method, key, result["error"])

        succeeded(url, method)
        return result.get("result") if isinstance(result, dict) else result

def ready_urls(urls, method="wss"):
    now = _clock()
    ready = []
    with _lock:
        for url in _unique(urls):
            key = endpoint_key(url)
            if (key, method) not in _unavailable and _cooldowns.get((key, "*"), 0) <= now and _cooldowns.get((key, method), 0) <= now:
                ready.append(url)
    return ready

def _next_retry(urls, method, now):
    with _lock:
        delays = [
            max(
                0.0,
                max(
                    _cooldowns.get((endpoint_key(url), "*"), 0),
                    _cooldowns.get((endpoint_key(url), method), 0),
                ) - now,
            )
            for url in urls
            if (endpoint_key(url), method) not in _unavailable
        ]
    return min(delays, default=0.0)


def failed(url, category, retry_after=None, method="wss"):
    delay = retry_after
    if delay is None:
        delay = 300.0 if category == "permission" else 5.0 if category == "transport" else 60.0
    with _lock:
        _cooldowns[
            (endpoint_key(url), "*" if category == "quota" else method)
        ] = _clock() + max(0.0, float(delay))


def succeeded(url, method="wss"):
    with _endpoint_lock(url):
        with _lock:
            _cooldowns.pop((endpoint_key(url), method), None)

def reset():
    global _rpc_meter_next
    with _lock:
        _cooldowns.clear()
        _unavailable.clear()
        _next_request.clear()
        _rpc_counts.clear()
        _rpc_errors.clear()
        _rpc_counts_prev.clear()
        _rpc_errors_prev.clear()
        _rpc_meter_next = 0.0


def _retry_after(error, now):
    response = getattr(error, "response", None)
    headers = getattr(error, "headers", None) or getattr(response, "headers", None)
    value = headers.get("Retry-After") if headers else None
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            return max(0.0, date.timestamp() - now)
        except (TypeError, ValueError, OverflowError):
            return None


def _safe_url(url):
    parts = urlsplit(url)
    host = parts.hostname or "endpoint"
    return f"{parts.scheme}://{host}{parts.path}"


def _error_category(error):
    message = str(error.get("message") or "").lower() if isinstance(error, dict) else str(error).lower()
    code = error.get("code") if isinstance(error, dict) else None
    if code == -32601 or any(term in message for term in ("method not found", "not available", "does not exist")):
        return "method"
    if any(term in message for term in ("429", "capacity", "quota", "rate limit", "too many requests", "request limit")):
        return "quota"
    if any(term in message for term in ("401", "403", "unauthorized", "forbidden", "permission", "specify an address", "archive requests require")):
        return "permission"
    if any(term in message for term in ("exceed", "range", "too many", "results", "limit")):
        return "range"
    return "rpc"
class _PermanentRpcError(RuntimeError):
    def __init__(self, message: str, endpoint: str | None = None):
        super().__init__(message)
        self.endpoint_key = endpoint
def call(chain, method, params, endpoints, tries=3, timeout=20):
    """Call eligible providers once each, rechecking cooldown under endpoint lock."""
    urls = _unique(endpoints)
    candidates = ready_urls(urls, method)
    if not candidates:
        with _lock:
            all_unavailable = bool(urls) and all(
                (endpoint_key(url), method) in _unavailable for url in urls
            )
        if all_unavailable:
            raise MethodUnavailable(f"RPC method unavailable: {method}")
        retry = _next_retry(urls, method, _clock())
        raise RpcUnavailable(f"RPC unavailable for {method}", "cooldown", retry)

    failures = []
    permanent = None
    missing = 0
    for url in candidates[:max(0, tries)]:
        try:
            result = _request(url, method, params, timeout)
            _meter(chain, method, url)
            return result
        except MethodUnavailable:
            _meter(chain, method, url, error=True)
            missing += 1
        except _PermanentRpcError as exc:
            _meter(chain, method, url, error=True)
            permanent = permanent or exc
        except _ProviderFailure as exc:
            _meter(chain, method, url, error=True)
            failures.append((exc.category, exc.retry_after))

    if missing == len(candidates):
        raise MethodUnavailable(f"RPC method unavailable: {method}")
    if permanent is not None:
        raise permanent
    category, delay = min(failures, key=lambda failure: failure[1]) if failures else ("cooldown", 0.0)
    labels = {
        "quota": "provider capacity/rate limit",
        "permission": "provider authorization/permission",
        "transport": "transport",
    }
    label = labels.get(category, category)
    raise RpcUnavailable(f"RPC unavailable for {method} ({label})", category, delay)
