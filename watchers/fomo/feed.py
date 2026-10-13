"""Feed FOMO: MỘT socket firehose `wss://api.fomoapi.io/ws/alerts` — match watch-list
CỤC BỘ (không mở socket per-user), dedupe theo `eventId`, POST TỪNG survivor lên
`/api/fomo-watch/trades`. Không backfill gap sau reconnect (cột display-only).

Alert field → fomo_trades contract (server `parseFomoWatchTradeBody`, đo trên
102/102 alert thật tại `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl`):
  alertType buy|sell → `type` (perp/thesis/listing DROP; perp còn null tokenAddress)
  trader (handle, 102/102) → `trader`;  userId (102/102) → `userId`
  eventId (unique 102/102) → `eventId` = khoá idempotency (dedupe + UNIQUE server)
  tokenAddress → `tokenAddress` (server canonical thành `ca`); thiếu → DROP
  chain: solana→sol, base→base, bsc→bsc, robinhood→robinhood; chain khác
    (ethereum/hyperliquid/perp-1337) → DROP (Chain union của repo:
    sol|base|bsc|robinhood)
  ts (epoch ms) → `ts`;  token (ticker) → `token`
  usdValue → `usdValue` — TYPE-DEPENDENT: buy = position size SAU fill
    (= positionValueUsd), sell = realized PnL CÓ DẤU (= realizedPnlUsd). Hai
    hướng KHÔNG cùng đơn vị tiền ⇒ không bao giờ cộng/trừ chéo (plan cấm).
    Là STOCK, không phải flow: cộng nó thành `Buy $` nhân sai số theo số lệnh
    (user 2026-10-01 — iruletrenches bị đọc 285K trong khi GMGN ghi 59.8K).
  tradeUsd → `tradeUsd` (optional, ~17/102 alert) — USD THẬT đã giao dịch, cả buy
    lẫn sell. Đây mới là cơ sở của `Buy $`; vắng mặt ⇒ server fallback.
  price → `price` (optional; không xuất hiện trong capture — pass-through nếu có)
  txHash → `txHash` (optional, chỉ có ở ~17/102 alert) — server dùng để resolve ví
    trader on-chain (opportunistic; thiếu ⇒ bỏ qua, không tạo row).
 Envelope KHÔNG phải trade: type='welcome'/'heartbeat', frame trần 'ping'/'pong'
 (non-JSON) — bỏ qua, không raise. `text` chỉ để log, KHÔNG parse.

State/heartbeat dùng file FOMO-SPECIFIC (`fomo_state.json` / `fomo_heartbeat`) —
KHÔNG dùng path cố định của `watchers/common/state.py`: daemon thứ 2 ghi chung
file sẽ che mất liveness của sol watcher.
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
import time
import urllib.error
import urllib.request
import tempfile
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from watchers.common import config
from watchers.common.config import _CFG_REFRESH_S, HERE, api_headers


FOMO_ME_URL = "https://api.fomoapi.io/v2/me"
FOMO_USAGE_PATH = Path("/root/signal-scan-monitor/usage/fomo-usage.json")
FOMO_CREDIT_FIELDS = ("monthly", "usedThisMonth", "prepaid", "remaining")
FOMO_CREDIT_POLL_S = 15 * 60
FOMO_MONITOR_HEARTBEAT = Path("/root/signal-scan-monitor/heartbeats/fomo")


def _parse_fomo_credits(payload: Any) -> tuple[str | None, dict[str, float]]:
    """Validate and return sanitized plan and account credit values."""
    if not isinstance(payload, dict) or not isinstance(payload.get("credits"), dict):
        raise ValueError("invalid FOMO account response")
    raw = payload["credits"]
    values: dict[str, float] = {}
    for field in FOMO_CREDIT_FIELDS:
        value = raw.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("invalid FOMO credit values")
        number = float(value)
        if not math.isfinite(number) or number < 0:
            raise ValueError("invalid FOMO credit values")
        values[field] = number
    plan = payload.get("plan")
    return (plan if isinstance(plan, str) else None), values


def _fomo_me_request(key: str) -> tuple[str | None, dict[str, float]]:
    """Fetch FOMO's zero-credit account endpoint with a bounded request."""
    request = urllib.request.Request(
        FOMO_ME_URL,
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return _parse_fomo_credits(json.loads(response.read()))


def _safe_fomo_error(error: Exception) -> str:
    """Persist only the exception class so transport text cannot expose credentials."""
    return type(error).__name__


def _write_fomo_usage(
    key: str,
    state: dict[str, Any],
    now_ms: int,
    fetch: Any = _fomo_me_request,
    path: Path = FOMO_USAGE_PATH,
) -> dict[str, Any]:
    """Poll account credits and atomically persist only the sanitized snapshot."""
    previous = state.get("snapshot")
    try:
        plan, credits = fetch(key)
        snapshot = {
            "fetchedAtMs": now_ms,
            "attemptedAtMs": now_ms,
            "plan": plan,
            "credits": credits,
            "source": "fomo-v2-me",
            "error": None,
        }
    except Exception as error:
        snapshot = dict(previous) if isinstance(previous, dict) else {
            "fetchedAtMs": None,
            "plan": None,
            "credits": {field: None for field in FOMO_CREDIT_FIELDS},
            "source": "fomo-v2-me",
        }
        snapshot["attemptedAtMs"] = now_ms
        snapshot["error"] = _safe_fomo_error(error)
    state["snapshot"] = snapshot
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as temporary:
            json.dump(snapshot, temporary, separators=(",", ":"))
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = temporary.name
        os.replace(temporary_path, path)
    except OSError as error:
        print(f"  ! fomo usage status unavailable: {type(error).__name__}", file=sys.stderr)
        try:
            if "temporary_path" in locals():
                os.unlink(temporary_path)
        except OSError:
            pass
    return snapshot


def _fomo_credit_loop(key: str) -> Any:
    """Run account poll immediately and then at the fixed 15-minute cadence."""
    async def poll() -> None:
        state: dict[str, Any] = {}
        while True:
            await asyncio.to_thread(_write_fomo_usage, key, state, int(time.time() * 1000))
            await asyncio.sleep(FOMO_CREDIT_POLL_S)

    return poll()



WS_URL = "wss://api.fomoapi.io/ws/alerts"  # key ride query-string — KHÔNG log full URL
_CHAIN = {
    "solana": "sol",
    "base": "base",
    "bsc": "bsc",
    "robinhood": "robinhood",
}  # ngoài map ⇒ DROP
_SEEN_MAX = 4096  # bound như evm/feed.py _SEEN_MAX

_HTTP_MAX_ATTEMPTS = 3
_HTTP_TIMEOUT_S = 5
_RETRYABLE_HTTP = {429, 500, 502, 503, 504}

DIAGNOSTIC_LOG_PATH = Path(HERE) / "logs" / "fomo-ws.jsonl"
_DIAGNOSTIC_MAX_BYTES = 16 * 1024 * 1024
_DIAGNOSTIC_BACKUPS = 10
_DIAGNOSTIC_FRAME_SEQUENCE = itertools.count(1)
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
    """Emit one bounded warning without exposing exception text or frame data."""
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
    """Detach broken diagnostic handlers while preserving feed processing."""
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
    """Close file handlers without allowing cleanup errors to stop shutdown."""
    global _DIAGNOSTIC_SECRETS
    for handler in _DIAGNOSTIC_LOGGER.handlers[:]:
        _DIAGNOSTIC_LOGGER.removeHandler(handler)
        try:
            handler.close()
        except Exception as error:
            _warn_diagnostics_unavailable(type(error).__name__)
    _DIAGNOSTIC_SECRETS = ()


def _diagnostic(
    event: str,
    *,
    frame_id: str | None = None,
    timestamp: str | None = None,
    **fields: Any,
) -> None:
    """Append one machine-readable row with an explicit UTC millisecond timestamp."""
    if not _DIAGNOSTIC_LOGGER.handlers:
        return
    try:
        row = {
            "timestamp": timestamp
            or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "event": event,
        }
        if frame_id is not None:
            row["frame_id"] = frame_id
        row.update(fields)
        _DIAGNOSTIC_LOGGER.info(
            json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        )
    except Exception as error:
        _disable_diagnostics(type(error).__name__)



def _diagnostic_payload(raw: Any) -> dict[str, str]:
    """Preserve text or binary frames while masking credential-like values."""
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


def _new_frame_id() -> str:
    return f"{time.time_ns()}-{next(_DIAGNOSTIC_FRAME_SEQUENCE)}"




def _request_bytes_with_retry(
    req: urllib.request.Request,
    on_attempt: Any = None,
) -> bytes:
    """Read a complete response inside each bounded HTTP/transport attempt."""
    for attempt in range(1, _HTTP_MAX_ATTEMPTS + 1):
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as response:
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

# eventId đã emit — replay/reconnect có thể đẩy lại; ponytail: clear-all khi đầy.
_seen: set[str] = set()

# Watch list nạp từ GET /api/fomo-users, refresh mỗi ~_CFG_REFRESH_S (300s) —
# KHÔNG nạp một lần lúc startup (UI đổi list phải có hiệu lực không cần restart).
_wl: dict[str, Any] = {"ids": set(), "handles": set(), "next": 0.0}


# ---------- state FOMO-specific ----------


def _beat() -> None:
    """Touch watchdog beacon and its private monitor mirror."""
    for path in (HEARTBEAT, FOMO_MONITOR_HEARTBEAT):
        try:
            open(path, "w").close()
        except OSError:
            pass


def load_state() -> dict[str, Any]:
    """{last_ts, emitted, seen[]} — file hỏng/chưa có ⇒ state trắng, không raise."""
    global _seen
    try:
        st = json.load(open(STATE_PATH))
        if not isinstance(st, dict):
            st = {}
    except Exception:
        st = {}
    _seen = {e for e in (st.get("seen") or []) if isinstance(e, str)}
    return st


def save_state(st: dict[str, Any]) -> None:
    """Atomic (tmp + replace) như common/state.save_state; seen bị bound _SEEN_MAX."""
    st = {**st, "seen": list(_seen)[-_SEEN_MAX:]}
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATE_PATH)


# ---------- watch list ----------


def refresh_watch_list(force: bool = False) -> None:
    """GET {api}/api/fomo-users → 2 set (userId, handle). Tới hạn ~300s mới fetch
    (force=True bỏ qua đồng hồ — dùng sau 404 'list stale'). Fail-soft: lỗi mạng/
    shape ⇒ GIỮ list cũ (một lần timeout không được xoá watch list). Không raise."""
    if not force and time.time() < _wl["next"]:
        return
    _wl["next"] = time.time() + _CFG_REFRESH_S
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/fomo-users", headers=api_headers()
        )
        data = json.loads(_request_bytes_with_retry(req))
        ids, handles = set(), set()
        for u in data if isinstance(data, list) else []:
            if not isinstance(u, dict):
                continue
            if isinstance(u.get("userId"), str) and u["userId"]:
                ids.add(u["userId"])
            if isinstance(u.get("handle"), str) and u["handle"]:
                handles.add(u["handle"])
        if (ids, handles) != (_wl["ids"], _wl["handles"]):
            print(
                f"# fomo watch list: {len(handles)} handle, {len(ids)} userId",
                flush=True,
            )
        _wl["ids"], _wl["handles"] = ids, handles
    except Exception as ex:
        print(f"  ! fomo-users: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)


def _match(alert_uid: str | None, trader: str | None) -> bool:
    """userId exact TRƯỚC, handle trader SAU (đúng thứ tự server resolve).
    Không bao giờ HỌC user mới từ firehose — chỉ membership test."""
    if alert_uid and alert_uid in _wl["ids"]:
        return True
    return bool(trader and trader in _wl["handles"])


# ---------- frame → body ----------


def _str(m: dict[str, Any], k: str) -> str | None:
    v = m.get(k)
    return v if isinstance(v, str) and v else None


def _num(m: dict[str, Any], k: str) -> float | None:
    v = m.get(k)
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return None


def _alert_body_result(
    msg: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    """Return the ingest body or the exact validation reason for diagnostics."""
    if not isinstance(msg, dict):
        return None, "not_json_object"
    if msg.get("type") != "alert":
        return None, "not_alert_message"
    if msg.get("alertType") not in ("buy", "sell"):
        return None, "unsupported_alert_type"
    ca, chain = _str(msg, "tokenAddress"), _CHAIN.get(msg.get("chain") or "")
    if not ca:
        return None, "missing_token_address"
    if chain is None:
        return None, "unsupported_chain"
    uid, trader = _str(msg, "userId"), _str(msg, "trader")
    if not _match(uid, trader):
        return None, "unwatched_trader"
    ev = _str(msg, "eventId")
    if not ev:
        return None, "missing_event_id"
    ts = _num(msg, "ts")
    if ts is None or ts <= 0:
        return None, "invalid_timestamp"

    body: dict[str, Any] = {
        "eventId": ev,
        "type": msg["alertType"],
        "tokenAddress": ca,
        "chain": chain,
        "ts": ts,
    }
    if uid:
        body["userId"] = uid
    if trader:
        body["trader"] = trader
    tok = _str(msg, "token")
    if tok:
        body["token"] = tok
    usd, px = _num(msg, "usdValue"), _num(msg, "price")
    if usd is not None:
        body["usdValue"] = usd
    if px is not None:
        body["price"] = px
    # The USD actually traded only appears in some upstream alert payloads.
    trade_usd = _num(msg, "tradeUsd")
    if trade_usd is not None:
        body["tradeUsd"] = trade_usd
    tx_hash = _str(msg, "txHash")
    if tx_hash:
        body["txHash"] = tx_hash
    return body, None


def alert_body(msg: Any) -> dict[str, Any] | None:
    """Parse a frame into the ingest contract, dropping unsupported alerts."""
    return _alert_body_result(msg)[0]


def _dedupe(ev: str) -> bool:
    """True = lần đầu thấy eventId. Bound như evm _seen_tx: đầy ⇒ clear-all."""
    if ev in _seen:
        return False
    if len(_seen) > _SEEN_MAX:
        _seen.clear()  # ponytail: clear-all; LRU nếu cần chặt
    _seen.add(ev)
    return True


# ---------- emit ----------


def post_fomo_trade(
    body: dict[str, Any],
    *,
    frame_id: str | None = None,
) -> bool:
    """POST one idempotent event and log each request attempt without auth headers."""
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/fomo-watch/trades",
            data=json.dumps(body).encode(),
            headers=api_headers(),
        )

        def log_attempt(**details: Any) -> None:
            _diagnostic(
                "ingest_attempt",
                frame_id=frame_id,
                event_id=body["eventId"],
                **details,
            )

        _request_bytes_with_retry(req, on_attempt=log_attempt)
        return True
    except urllib.error.HTTPError as ex:
        _diagnostic(
            "ingest_failure",
            frame_id=frame_id,
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
            frame_id=frame_id,
            event_id=body["eventId"],
            error_type=type(ex).__name__,
        )
        print(f"  ! fomo-trade: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
        return False


def handle_frame(raw: Any, st: dict[str, Any]) -> None:
    """Persist every received frame before parsing, then log its processing decision."""
    frame_id = _new_frame_id()
    _diagnostic(
        "frame_received",
        frame_id=frame_id,
        payload=_diagnostic_payload(raw),
    )
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError) as ex:
        reason = (
            "control_text"
            if isinstance(raw, str) and raw.strip() in ("ping", "pong")
            else "invalid_json"
        )
        _diagnostic(
            "frame_decision",
            frame_id=frame_id,
            decision="ignored",
            reason=reason,
            error_type=type(ex).__name__,
        )
        if reason != "control_text":
            print(f"  ! frame non-JSON bỏ qua: {raw[:40]!r}", file=sys.stderr)
        return
    if not isinstance(msg, dict):
        body, reason = None, "not_json_object"
    elif msg.get("type") in ("welcome", "heartbeat"):
        body, reason = None, "control_message"
    else:
        body, reason = _alert_body_result(msg)
    if body is None:
        _diagnostic(
            "frame_decision",
            frame_id=frame_id,
            decision="ignored",
            reason=reason,
        )
        return
    event_id = body["eventId"]
    if event_id in _seen:
        _diagnostic(
            "frame_decision",
            frame_id=frame_id,
            decision="ignored",
            reason="duplicate",
            event_id=event_id,
        )
        return
    if not post_fomo_trade(body, frame_id=frame_id):
        _diagnostic(
            "frame_decision",
            frame_id=frame_id,
            decision="not_persisted",
            reason="ingest_failed",
            event_id=event_id,
        )
        return
    _diagnostic(
        "frame_decision",
        frame_id=frame_id,
        decision="ingest_acknowledged",
        reason="ingested",
        event_id=event_id,
    )
    _dedupe(event_id)
    st["last_ts"] = max(st.get("last_ts") or 0, body["ts"])
    st["emitted"] = int(st.get("emitted") or 0) + 1
    print(
        f"# fomo {body['type']} {body.get('trader') or body.get('userId')}"
        f" ${body.get('token') or '?'} {body['chain']}"
        f" ≈ ${body.get('usdValue', 0):,.0f}  evt {event_id[:8]}…",
        flush=True,
    )
    save_state(st)
    _diagnostic(
        "frame_state",
        frame_id=frame_id,
        state_saved=True,
        event_id=event_id,
        emitted=st["emitted"],
    )


# ---------- socket ----------

_BACKOFF_BASE_S = 1.0
_BACKOFF_CAP_S = 60.0
_ONCE_WINDOW_S = 90.0  # --once: đủ dài cho buffered replay (tier delay ~60s)
_RECV_POLL_S = 5.0  # wait_for(recv) — tới hạn để xét điều kiện thoát --once


def _safe(key: str, e: Exception) -> str:
    """Sanitize credentials from websocket exception text."""
    message = f"{type(e).__name__}: {str(e)}"
    for secret in _DIAGNOSTIC_SECRETS:
        message = message.replace(secret.decode("utf-8", "ignore"), "***")
    if key:
        message = message.replace(key, "***")
    return message[:100]

def _safe_endpoint(url: str) -> str:
    """Remove query credentials from the endpoint before logging it."""
    return url.split("?", 1)[0]



def run_feed(key: str, ws_url: str = WS_URL, once: bool = False) -> None:
    """Loop chính: connect (lazy import websockets như sol/feed.py), recv →
    handle_frame, đứt ⇒ backoff mũ có trần rồi reconnect (CHẤP NHẬN gap — không
    gọi /v2/alerts backfill). --once: thoát sau emit đầu tiên hoặc hết window."""
    try:
        import websockets
    except ImportError:
        sys.exit("fomo watcher cần:  pip install websockets")
    configure_diagnostics(
        secret_values=(key, getattr(config, "_service_token", ""))
    )


    st = load_state()
    refresh_watch_list(force=True)
    _diagnostic(
        "watcher_started",
        endpoint=_safe_endpoint(ws_url),
        watchlist_handles=len(_wl["handles"]),
        watchlist_user_ids=len(_wl["ids"]),
    )

    # KHÔNG log full URL — key nằm trong query string.
    print(
        f"# fomo feed: {_safe_endpoint(ws_url)}?key=***",
        flush=True,
    )

    async def _beat_loop():
        while True:  # feed im lặng vẫn phải đập nhịp cho watchdog
            _beat()
            await asyncio.sleep(30)

    async def _sock() -> None:
        backoff = _BACKOFF_BASE_S
        deadline = time.monotonic() + _ONCE_WINDOW_S
        while True:
            try:
                async with websockets.connect(
                    f"{ws_url}?key={key}",
                    open_timeout=10,
                    ping_interval=20,
                    max_size=None,
                ) as ws:
                    print("# fomo socket connected", flush=True)
                    _diagnostic("ws_connected", endpoint=_safe_endpoint(ws_url))
                    backoff, n0 = _BACKOFF_BASE_S, int(st.get("emitted") or 0)
                    _beat()
                    while True:
                        if once and (
                            int(st.get("emitted") or 0) > n0
                            or time.monotonic() >= deadline
                        ):
                            return
                        try:
                            raw = await asyncio.wait_for(
                                ws.recv(), timeout=_RECV_POLL_S
                            )
                        except (TimeoutError, asyncio.TimeoutError):
                            continue  # không frame — lặp lại để xét thoát --once
                        handle_frame(raw, st)
                        refresh_watch_list()  # tới hạn ~300s mới fetch thật
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                _diagnostic(
                    "ws_disconnected",
                    endpoint=_safe_endpoint(ws_url),
                    error=_safe(key, e),
                    reconnect_after_seconds=backoff,
                    reconnect_scheduled=not once,
                )
                if once:
                    raise SystemExit(f"fomo socket lỗi: {_safe(key, e)}") from None
                print(
                    f"  ! fomo ws đứt ({_safe(key, e)}) -> reconnect sau"
                    f" {backoff:.0f}s (chấp nhận gap, không backfill)",
                    file=sys.stderr,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _BACKOFF_CAP_S)

    async def _run():
        beat = asyncio.create_task(_beat_loop())
        credits = asyncio.create_task(_fomo_credit_loop(key))
        try:
            await _sock()
        finally:
            beat.cancel()
            credits.cancel()

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
            f" last_ts={st.get('last_ts')}"
            + ("" if st.get("emitted") else " — no alerts in window"),
            flush=True,
        )
