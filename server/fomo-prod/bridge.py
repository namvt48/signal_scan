#!/usr/bin/env python3
"""Read-only bridge to FOMO's free browser API.

The browser API (prod-api.fomo.family) rejects ordinary Node/Python TLS
fingerprints with HTTP 430 even when the Privy access token is valid. This
process is the one place that talks to it: curl_cffi impersonates Chrome, owns
the Privy access/refresh tokens, and exposes only the read-only routes the
signal_scan process needs.

The API process and the FOMO watcher call this bridge over the compose network
(or host loopback); neither one handles FOMO credentials or Cloudflare.

Routes:
  GET /health
  GET /v2/users/{userId}/balances
  GET /v2/users/{userId}/swaps?limit=100[&lastSwapIdV2=<swap id>]

Everything else is rejected. Write/trade endpoints are never proxied.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

try:
    from curl_cffi import requests as curl_requests
except ImportError as exc:  # pragma: no cover - container always installs it
    raise SystemExit("fomo-prod bridge requires curl_cffi") from exc

LOG = logging.getLogger("fomo-prod-bridge")
LOG.setLevel(os.environ.get("FOMO_LOG_LEVEL", "INFO").upper())

BASE = os.environ.get("FOMO_API_BASE", "https://prod-api.fomo.family").rstrip("/")
TOKEN_FILE = os.environ.get("FOMO_AUTH_TOKEN_FILE", "/credentials/access_token")
REFRESH_FILE = os.environ.get("FOMO_REFRESH_TOKEN_FILE", "/credentials/refresh_token")
PRIVY_TOKEN_URL = os.environ.get("FOMO_PRIVY_TOKEN_URL", "https://auth.privy.io/api/v1/sessions")
PRIVY_ORIGIN = os.environ.get("FOMO_PRIVY_ORIGIN", "https://fomo.family").strip()
PRIVY_APP_ID = os.environ.get("FOMO_PRIVY_APP_ID", "").strip()
IMPERSONATE = os.environ.get("FOMO_IMPERSONATE", "chrome")
REFRESH_SKEW_S = max(0, int(os.environ.get("FOMO_TOKEN_REFRESH_SKEW_SECONDS", "300")))
REQUEST_DELAY_MS = max(0, int(os.environ.get("FOMO_REQUEST_DELAY_MS", "62")))
MAX_CONCURRENCY = max(1, int(os.environ.get("FOMO_CONCURRENCY", "4")))
TIMEOUT_S = max(1, int(os.environ.get("FOMO_TIMEOUT_SECONDS", "30")))
PORT = int(os.environ.get("PORT", os.environ.get("FOMO_PROD_PORT", "8080")))
ALLOWED = re.compile(r"^/v2/users/([^/]+)/(balances|swaps)$")


def _read_private_text(path: str) -> str:
    try:
        raw = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        try:
            value = json.loads(raw)
            if isinstance(value, str):
                return value.strip()
        except json.JSONDecodeError:
            pass
    return raw


def _read_credentials() -> tuple[str, str]:
    """Return (access, refresh) from files or env; never log either value."""
    access = os.environ.get("FOMO_AUTH_TOKEN", "").strip()
    refresh = os.environ.get("FOMO_REFRESH_TOKEN", "").strip()
    if TOKEN_FILE:
        raw = _read_private_text(TOKEN_FILE)
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
                access = str(obj.get("access_token") or obj.get("accessToken") or access)
                refresh = str(obj.get("refresh_token") or obj.get("refreshToken") or refresh)
            except (json.JSONDecodeError, AttributeError):
                access = raw
        elif raw:
            access = raw
    if REFRESH_FILE:
        file_refresh = _read_private_text(REFRESH_FILE)
        if file_refresh:
            refresh = file_refresh
    return access.strip(), refresh.strip()


def _jwt_claims(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims if isinstance(claims, dict) else {}
    except (ValueError, json.JSONDecodeError):
        return {}


def _jwt_expiry(token: str) -> int | None:
    exp = _jwt_claims(token).get("exp")
    return int(exp) if isinstance(exp, (int, float)) else None


def _jwt_audience(token: str) -> str:
    aud = _jwt_claims(token).get("aud")
    if isinstance(aud, list):
        aud = aud[0] if aud else ""
    return str(aud or "")


def _write_private(path: str, value: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)


class TokenStore:
    """Thread-safe Privy access-token reader with proactive refresh."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_warning = 0.0

    def _warn(self, message: str, *args: Any) -> None:
        now = time.monotonic()
        if now - self._last_warning < 300:
            return
        self._last_warning = now
        LOG.warning(message, *args)

    def _refresh(self, refresh_token: str) -> tuple[str, str] | None:
        access, _ = _read_credentials()
        app_id = PRIVY_APP_ID or _jwt_audience(access)
        if not app_id:
            self._warn("Privy refresh skipped: cannot determine privy-app-id")
            return None
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "privy-app-id": app_id,
        }
        if PRIVY_ORIGIN:
            headers["Origin"] = PRIVY_ORIGIN
        try:
            response = curl_requests.post(
                PRIVY_TOKEN_URL,
                headers=headers,
                json={"refresh_token": refresh_token},
                impersonate=IMPERSONATE,
                timeout=TIMEOUT_S,
            )
        except Exception as exc:
            self._warn("Privy refresh request failed: %s", type(exc).__name__)
            return None
        if response.status_code != 200:
            error = "unknown"
            try:
                body = response.json()
                if isinstance(body, dict):
                    error = str(body.get("code") or body.get("error") or error)
            except Exception:
                pass
            self._warn("Privy refresh failed status=%s error=%s", response.status_code, error)
            return None
        try:
            body = response.json()
        except Exception:
            self._warn("Privy refresh returned invalid JSON")
            return None
        if not isinstance(body, dict):
            self._warn("Privy refresh returned invalid JSON")
            return None
        if body.get("session_update_action") == "clear":
            self._warn("Privy refresh cleared the session; re-authentication required")
            return None
        access = body.get("token") or body.get("access_token")
        rotated = body.get("refresh_token")
        if not isinstance(access, str) or not access.strip():
            self._warn("Privy refresh returned no token")
            return None
        cookie_token = ""
        try:
            for header in response.headers.get_list("set-cookie"):
                name, _, value = header.split(";", 1)[0].partition("=")
                if name.strip() == "privy-refresh-token":
                    cookie_token = value.strip()
                    break
        except Exception:
            pass
        candidate = cookie_token or (rotated.strip() if isinstance(rotated, str) else "")
        rotated_value = "" if candidate == "deprecated" else candidate
        try:
            if TOKEN_FILE:
                _write_private(TOKEN_FILE, access.strip())
            if REFRESH_FILE:
                _write_private(REFRESH_FILE, rotated_value or refresh_token)
        except OSError as exc:
            self._warn("Privy token persist failed: %s", type(exc).__name__)
        LOG.info(
            "Privy access token refreshed expires_at=%s",
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_jwt_expiry(access) or 0)),
        )
        return access.strip(), rotated_value or refresh_token

    def access_token(self, *, force_refresh: bool = False) -> str:
        with self._lock:
            access, refresh = _read_credentials()
            if not access:
                return ""
            expiry = _jwt_expiry(access)
            if not force_refresh and (expiry is None or expiry - int(time.time()) > REFRESH_SKEW_S):
                return access
            if not refresh:
                self._warn("Privy access token is expiring but no refresh token is configured")
                return access
            refreshed = self._refresh(refresh)
            return refreshed[0] if refreshed is not None else access

    def expires_at(self) -> int | None:
        access, _ = _read_credentials()
        return _jwt_expiry(access)


class Pacer:
    """Serialize upstream request starts; callers wait outside the lock."""

    def __init__(self, delay_ms: int) -> None:
        self._delay = delay_ms / 1000
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        if self._delay <= 0:
            return
        with self._lock:
            start = max(time.monotonic(), self._next)
            self._next = start + self._delay
        delay = start - time.monotonic()
        if delay > 0:
            time.sleep(delay)


TOKENS = TokenStore()
PACER = Pacer(REQUEST_DELAY_MS)
SLOTS = threading.BoundedSemaphore(MAX_CONCURRENCY)


def _request_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Origin": "https://fomo.family",
        "Referer": "https://fomo.family/",
    }


def _retry_after(value: str | None) -> float:
    try:
        return max(0.0, min(float(value or ""), 5.0))
    except (TypeError, ValueError):
        return 0.5


def upstream_get(path: str, query: dict[str, str]) -> tuple[int, bytes, str]:
    """GET one read-only upstream route; returns (status, body, content-type)."""
    token = TOKENS.access_token()
    if not token:
        return 503, b'{"error":"fomo prod token not configured"}', "application/json"
    last_status, last_body, last_type = 502, b'{"error":"fomo prod upstream failed"}', "application/json"
    for attempt in range(1, 4):
        PACER.wait()
        try:
            with SLOTS:
                response = curl_requests.get(
                    f"{BASE}{path}",
                    params=query or None,
                    headers=_request_headers(token),
                    impersonate=IMPERSONATE,
                    timeout=TIMEOUT_S,
                )
        except Exception as exc:
            last_status, last_body, last_type = 502, json.dumps(
                {"error": f"fomo prod transport: {type(exc).__name__}"}
            ).encode(), "application/json"
            time.sleep(min(0.5 * 2 ** (attempt - 1), 2.0))
            continue
        content_type = response.headers.get("content-type", "application/json")
        if response.status_code == 401 and attempt == 1:
            token = TOKENS.access_token(force_refresh=True) or token
            continue
        if response.status_code in (429, 503) and attempt < 3:
            time.sleep(_retry_after(response.headers.get("retry-after")))
            continue
        return response.status_code, response.content, content_type
    return last_status, last_body, last_type


class Handler(BaseHTTPRequestHandler):
    server_version = "fomo-prod-bridge/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log query-string credentials; this bridge has none, but keep the
        # access log to method/path/status only.
        LOG.debug("%s %s", self.command, self.path.split("?", 1)[0])

    def _send(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        if parsed.path == "/health":
            access, _ = _read_credentials()
            expires = _jwt_expiry(access)
            now = int(time.time())
            body = {
                "ok": bool(access) and (expires is None or expires - now > 0),
                "base": BASE,
                "tokenExpiresAt": expires,
                "tokenExpiresInSeconds": None if expires is None else max(0, expires - now),
                "checkedAt": now,
            }
            self._send(200 if body["ok"] else 503, json.dumps(body).encode())
            return
        if parsed.path == "/feed/token":
            qs = parse_qs(parsed.query)
            token = qs.get("tokenAddress", [""])[0].strip()
            if not token or len(token) > 128:
                self._send(400, b'{"error":"tokenAddress is required"}')
                return
            try:
                network_id = int(qs.get("networkId", [""])[0])
            except ValueError:
                self._send(400, b'{"error":"networkId must be an integer"}')
                return
            query = {"tokenAddress": token, "networkId": str(network_id)}
            raw_limit = qs.get("limit", [""])[0]
            if raw_limit:
                try:
                    query["limit"] = str(max(1, min(100, int(raw_limit))))
                except ValueError:
                    pass
            self._send(*upstream_get("/feed/token", query))
            return
        if parsed.path.startswith("/trades/"):
            trade_id = unquote(parsed.path[len("/trades/"):])
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", trade_id):
                self._send(400, b'{"error":"invalid trade id"}')
                return
            self._send(*upstream_get(f"/trades/{quote(trade_id, safe='')}", {}))
            return
        match = ALLOWED.match(parsed.path)
        if match is None:
            self._send(404, b'{"error":"not found"}')
            return
        identity = unquote(match.group(1))
        endpoint = match.group(2)
        if not identity:
            self._send(400, b'{"error":"missing user id"}')
            return
        query: dict[str, str] = {}
        if endpoint == "swaps":
            qs = parse_qs(parsed.query)
            raw_limit = qs.get("limit", ["100"])[0]
            try:
                limit = max(1, min(100, int(raw_limit)))
            except ValueError:
                limit = 100
            query["limit"] = str(limit)
            # FOMO pages /swaps newest-first with lastSwapIdV2. Forward it so the
            # watcher can walk back to its stored cursor instead of dropping
            # everything beyond the first 100 fills.
            after = qs.get("lastSwapIdV2", [""])[0].strip()
            if after:
                if len(after) > 128:
                    self._send(400, b'{"error":"lastSwapIdV2 is too long"}')
                    return
                query["lastSwapIdV2"] = after
        status, body, content_type = upstream_get(
            f"/v2/users/{quote(identity, safe='')}/{endpoint}", query,
        )
        self._send(status, body, content_type)


def main() -> None:
    logging.basicConfig(level=LOG.level, format="%(asctime)s %(levelname)s %(message)s")
    LOG.info("fomo prod bridge listening on :%s upstream=%s", PORT, BASE)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
