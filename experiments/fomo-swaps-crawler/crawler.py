#!/usr/bin/env python3
"""Standalone FOMO swaps crawler.

One request per user per cycle:
  GET {FOMO_API_BASE}/v2/users/{userId}/swaps?limit={FOMO_LIMIT}

Stores first-page swaps, per-user token inflow aggregates, cycle/rate-limit
telemetry in SQLite, and a flat CA/inflow CSV snapshot. Independent of the
signal_scan application.

Auth:
  Paid host: FOMO_API_KEY or FOMO_AUTH_TOKEN -> Authorization: Bearer <token>.
  Free host: FOMO_AUTH_TOKEN_FILE (Privy access token) or FOMO_AUTH_TOKEN.
  Free host requires curl_cffi impersonate=chrome (Cloudflare TLS fingerprint).

Default base is https://api.fomoapi.io (paid credits). Set
FOMO_API_BASE=https://prod-api.fomo.family for the free browser API; it returns
a {success,responseObject} envelope and uses first page only (25 items).
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import csv
import hashlib
import json
import logging
import os
import random
import signal
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from curl_cffi import requests as curl_requests
except ImportError:  # paid endpoint still works with urllib; free endpoint requires it
    curl_requests = None

LOG = logging.getLogger("fomo-swaps-crawler")

CHAIN_NAMES = {
    "solana": "sol",
    "ethereum": "eth",
    "base": "base",
    "bsc": "bsc",
    "robinhood": "robinhood",
}

CHAIN_BY_NETWORK = {
    1399811149: "sol",
    1: "eth",
    8453: "base",
    56: "bsc",
    42161: "arbitrum",
    137: "polygon",
    10: "optimism",
    43114: "avalanche",
}

# Known quote assets. A swap whose tokenOut is one of these is a sell into a
# quote asset, not a buy/inflow into a token CA. Unknown chains are not filtered.
QUOTE_ASSETS: dict[str, set[str]] = {
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
    "eth": {
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "0xdac17f958d2ee523a2206206994597c13d831ec7",
    },
}


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from exc


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be a number, got {raw!r}") from exc


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_at_ms(value: Any) -> int:
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            return int(number)
        return int(number * 1000)
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return parse_at_ms(int(text))
        try:
            return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def parse_retry_after(headers: dict[str, str], default: int = 30) -> int:
    raw = headers.get("retry-after") or headers.get("Retry-After")
    if raw is None:
        return default
    text = str(raw).strip()
    if text.isdigit():
        return max(1, int(text))
    try:
        when = datetime.strptime(text, "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=timezone.utc)
        return max(1, int(when.timestamp() - time.time()))
    except ValueError:
        return default


def as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number and number not in (float("inf"), float("-inf")) else None
    if isinstance(value, str):
        try:
            number = float(value)
            return number if number == number and number not in (float("inf"), float("-inf")) else None
        except ValueError:
            return None
    return None


def canonical_quote_key(chain: str, address: str) -> str:
    return address.lower() if chain in {"base", "bsc", "eth", "robinhood"} else address


ALL_QUOTE_ASSETS = {asset for assets in QUOTE_ASSETS.values() for asset in assets}
ALL_QUOTE_ASSETS_LOWER = {asset.lower() for asset in ALL_QUOTE_ASSETS}


def is_quote_asset(address: str) -> bool:
    """Quote assets can appear on a chain label that does not match their
    native chain (observed: Solana USDC returned under robinhood/eth/bsc).
    Filter known quote addresses globally, not per chain label."""
    return address in ALL_QUOTE_ASSETS or address.lower() in ALL_QUOTE_ASSETS_LOWER


@dataclass
class Config:
    base: str
    auth_token: str
    auth_token_file: str
    refresh_token_file: str
    privy_app_id: str
    privy_token_url: str
    privy_origin: str
    token_refresh_skew: int
    free_api: bool
    impersonate: str
    auth_retry_seconds: int
    users_file: Path
    data_dir: Path
    interval: int
    max_interval: int
    concurrency: int
    delay_ms: int
    batch_size: int
    batch_pause: int
    cycle_users: int
    timeout: int
    limit: int
    max_users: int
    credit_reserve: float
    credit_cost: float
    max_503: int
    clean_cycles_to_decay: int
    start_delay: int
    once: bool

    @classmethod
    def from_env(cls, args: argparse.Namespace) -> "Config":
        base = os.environ.get("FOMO_API_BASE", "https://api.fomoapi.io").rstrip("/")
        free_api = "prod-api.fomo.family" in base
        token = os.environ.get("FOMO_API_KEY", "") or os.environ.get("FOMO_AUTH_TOKEN", "")
        token_file = os.environ.get("FOMO_AUTH_TOKEN_FILE", "").strip()
        refresh_token_file = os.environ.get("FOMO_REFRESH_TOKEN_FILE", "").strip()
        if free_api and not refresh_token_file and token_file:
            refresh_token_file = f"{token_file}.refresh"
        if not token and not token_file:
            raise SystemExit("FOMO_API_KEY, FOMO_AUTH_TOKEN, or FOMO_AUTH_TOKEN_FILE is required")
        if free_api and curl_requests is None:
            raise SystemExit(
                "free endpoint requires curl_cffi; install it in the service venv "
                "(python3 -m venv venv && venv/bin/pip install curl_cffi)"
            )
        data_dir = Path(os.environ.get("FOMO_DATA_DIR", "data"))
        return cls(
            base=base,
            auth_token=token,
            auth_token_file=token_file,
            refresh_token_file=refresh_token_file,
            privy_app_id=os.environ.get("FOMO_PRIVY_APP_ID", "").strip(),
            privy_token_url=os.environ.get(
                "FOMO_PRIVY_TOKEN_URL", "https://auth.privy.io/api/v1/sessions",
            ).strip(),
            privy_origin=os.environ.get("FOMO_PRIVY_ORIGIN", "https://fomo.family").strip(),
            token_refresh_skew=max(0, env_int("FOMO_TOKEN_REFRESH_SKEW_SECONDS", 300)),
            free_api=free_api,
            impersonate=os.environ.get("FOMO_IMPERSONATE", "chrome"),
            auth_retry_seconds=max(1, env_int("FOMO_AUTH_RETRY_SECONDS", 300)),
            users_file=Path(os.environ.get("FOMO_USERS_FILE", "users.csv")),
            data_dir=data_dir,
            interval=args.interval or env_int("FOMO_INTERVAL_SECONDS", 900),
            max_interval=env_int("FOMO_MAX_INTERVAL_SECONDS", 6 * 3600),
            concurrency=max(1, env_int("FOMO_CONCURRENCY", 1)),
            delay_ms=max(0, env_int("FOMO_REQUEST_DELAY_MS", 300)),
            batch_size=max(0, env_int("FOMO_BATCH_SIZE", 20)),
            batch_pause=max(0, env_int("FOMO_BATCH_PAUSE_SECONDS", 10)),
            cycle_users=max(0, env_int("FOMO_CYCLE_USERS", 0)),
            timeout=max(1, env_int("FOMO_TIMEOUT_SECONDS", 30)),
            limit=max(1, env_int("FOMO_LIMIT", 100)),
            max_users=max(0, args.max_users if args.max_users is not None else env_int("FOMO_MAX_USERS", 0)),
            credit_reserve=max(0.0, env_float("FOMO_CREDIT_RESERVE", 0.0 if free_api else 50_000)),
            credit_cost=max(0.0, env_float("FOMO_CREDIT_COST", 0.0 if free_api else 250)),
            max_503=max(0, env_int("FOMO_MAX_503", 40)),
            clean_cycles_to_decay=max(1, env_int("FOMO_CLEAN_CYCLES_TO_DECAY", 8)),
            start_delay=max(0, env_int("FOMO_START_DELAY_SECONDS", 0)),
            once=args.once,
        )


def load_users(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise SystemExit(f"users file not found: {path}")
    users: list[dict[str, str]] = []
    seen_handles: set[str] = set()
    seen_ids: set[str] = set()
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None or "handle" not in reader.fieldnames or "user_id" not in reader.fieldnames:
            raise SystemExit(f"{path} must have handle,user_id columns")
        for row in reader:
            user_handle = (row.get("handle") or "").strip()
            user_id = (row.get("user_id") or "").strip()
            if not user_handle or not user_id:
                continue
            if user_handle in seen_handles or user_id in seen_ids:
                continue
            seen_handles.add(user_handle)
            seen_ids.add(user_id)
            users.append({"handle": user_handle, "user_id": user_id})
    if not users:
        raise SystemExit(f"no users found in {path}")
    users.sort(key=lambda item: item["handle"].lower())
    return users


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  users_total INTEGER NOT NULL,
  users_available INTEGER NOT NULL DEFAULT 0,
  users_ok INTEGER NOT NULL DEFAULT 0,
  users_no_data INTEGER NOT NULL DEFAULT 0,
  users_404 INTEGER NOT NULL DEFAULT 0,
  http_429 INTEGER NOT NULL DEFAULT 0,
  http_503 INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  credits_cost INTEGER NOT NULL DEFAULT 0,
  credits_remaining_before REAL,
  credits_remaining_after REAL,
  interval_seconds INTEGER NOT NULL,
  duration_ms INTEGER,
  stop_reason TEXT
);
CREATE TABLE IF NOT EXISTS swap_events (
  event_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  chain TEXT,
  chain_id INTEGER,
  swap_id TEXT,
  trade_id_out TEXT,
  at_ms INTEGER NOT NULL DEFAULT 0,
  at_iso TEXT,
  token_in TEXT,
  usd_in REAL,
  token_out TEXT,
  usd_out REAL,
  first_seen_cycle INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swap_events_user_at ON swap_events(user_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_swap_events_token_out ON swap_events(token_out);
CREATE TABLE IF NOT EXISTS ca_inflow (
  user_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  chain TEXT NOT NULL,
  ca TEXT NOT NULL,
  inflow_usd REAL NOT NULL DEFAULT 0,
  buy_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_cycle INTEGER NOT NULL,
  PRIMARY KEY (user_id, chain, ca)
);
CREATE INDEX IF NOT EXISTS idx_ca_inflow_ca ON ca_inflow(ca, chain);
CREATE TABLE IF NOT EXISTS rate_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  interval_seconds INTEGER NOT NULL,
  consecutive_limited INTEGER NOT NULL DEFAULT 0,
  clean_cycles INTEGER NOT NULL DEFAULT 0,
  user_cursor INTEGER NOT NULL DEFAULT 0,
  last_limited_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_errors (
  cycle_id INTEGER NOT NULL,
  handle TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  at TEXT NOT NULL
);
"""


def cleanup_quote_inflow(db: sqlite3.Connection) -> int:
    rows = db.execute("SELECT DISTINCT ca FROM ca_inflow").fetchall()
    bad = [row[0] for row in rows if is_quote_asset(row[0])]
    if bad:
        db.executemany("DELETE FROM ca_inflow WHERE ca = ?", [(ca,) for ca in bad])
        db.commit()
    return len(bad)


def open_db(config: Config) -> sqlite3.Connection:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(config.data_dir / "fomo_swaps.db", timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(SCHEMA)
    cycle_columns = {row[1] for row in db.execute("PRAGMA table_info(cycles)")}
    if "users_available" not in cycle_columns:
        db.execute("ALTER TABLE cycles ADD COLUMN users_available INTEGER NOT NULL DEFAULT 0")
    rate_columns = {row[1] for row in db.execute("PRAGMA table_info(rate_state)")}
    if "user_cursor" not in rate_columns:
        db.execute("ALTER TABLE rate_state ADD COLUMN user_cursor INTEGER NOT NULL DEFAULT 0")
    cleanup_quote_inflow(db)
    db.execute(
        "INSERT OR IGNORE INTO rate_state (id, interval_seconds, updated_at) VALUES (1, ?, ?)",
        (config.interval, utc_now_iso()),
    )
    db.execute(
        "UPDATE rate_state SET interval_seconds = ? WHERE id = 1 AND interval_seconds < ?",
        (config.interval, config.interval),
    )
    db.commit()
    return db


def sync_users(db: sqlite3.Connection, users: list[dict[str, str]]) -> None:
    db.executemany(
        "INSERT INTO users (handle, user_id) VALUES (?, ?) "
        "ON CONFLICT(handle) DO UPDATE SET user_id = excluded.user_id",
        [(item["handle"], item["user_id"]) for item in users],
    )
    db.commit()


def read_rate_state(db: sqlite3.Connection, default_interval: int) -> dict[str, Any]:
    row = db.execute(
        "SELECT interval_seconds, consecutive_limited, clean_cycles, user_cursor FROM rate_state WHERE id = 1"
    ).fetchone()
    if row is None:
        return {
            "interval_seconds": default_interval,
            "consecutive_limited": 0,
            "clean_cycles": 0,
            "user_cursor": 0,
        }
    return {
        "interval_seconds": int(row[0]),
        "consecutive_limited": int(row[1]),
        "clean_cycles": int(row[2]),
        "user_cursor": int(row[3]),
    }


def write_rate_state(
    db: sqlite3.Connection,
    interval: int,
    consecutive_limited: int,
    clean_cycles: int,
    limited: bool,
    user_cursor: int,
) -> None:
    db.execute(
        "UPDATE rate_state SET interval_seconds = ?, consecutive_limited = ?, clean_cycles = ?, "
        "user_cursor = ?, last_limited_at = CASE WHEN ? THEN ? ELSE last_limited_at END, updated_at = ? WHERE id = 1",
        (
            interval, consecutive_limited, clean_cycles, user_cursor,
            1 if limited else 0, utc_now_iso(), utc_now_iso(),
        ),
    )
    db.commit()


_REFRESH_LOCK = threading.Lock()
_last_refresh_warning = 0.0


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


def _read_credentials(config: Config) -> tuple[str, str]:
    """Return (access_token, refresh_token). The token file may be a raw JWT
    or a JSON object with access_token/refresh_token; the separate refresh
    file takes precedence for the refresh token."""
    access = config.auth_token
    refresh = ""
    if config.auth_token_file:
        raw = _read_private_text(config.auth_token_file)
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
                access = str(obj.get("access_token") or obj.get("accessToken") or access)
                refresh = str(obj.get("refresh_token") or obj.get("refreshToken") or "")
            except (json.JSONDecodeError, AttributeError):
                access = raw
        elif raw:
            access = raw
    if config.refresh_token_file:
        file_refresh = _read_private_text(config.refresh_token_file)
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


def _warn_refresh(message: str, *args: Any) -> None:
    global _last_refresh_warning
    now = time.monotonic()
    if now - _last_refresh_warning < 300:
        return
    _last_refresh_warning = now
    LOG.warning(message, *args)


def _request_privy_refresh(config: Config, app_id: str, refresh_token: str) -> tuple[str, str] | None:
    if curl_requests is None:
        _warn_refresh("Privy refresh skipped: curl_cffi is not installed")
        return None
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "privy-app-id": app_id,
    }
    if config.privy_origin:
        headers["Origin"] = config.privy_origin
    try:
        response = curl_requests.post(
            config.privy_token_url,
            headers=headers,
            json={"refresh_token": refresh_token},
            impersonate=config.impersonate,
            timeout=config.timeout,
        )
    except Exception as exc:
        _warn_refresh("Privy refresh request failed: %s", type(exc).__name__)
        return None
    if response.status_code != 200:
        error = "unknown"
        try:
            body = response.json()
            if isinstance(body, dict):
                error = str(body.get("code") or body.get("error") or error)
        except Exception:
            pass
        _warn_refresh("Privy refresh failed status=%s error=%s", response.status_code, error)
        return None
    try:
        body = response.json()
    except Exception:
        _warn_refresh("Privy refresh returned invalid JSON")
        return None
    if not isinstance(body, dict):
        _warn_refresh("Privy refresh returned invalid JSON")
        return None
    if body.get("session_update_action") == "clear":
        _warn_refresh("Privy refresh cleared the session; re-authentication required")
        return None
    access = body.get("token") or body.get("access_token")
    rotated = body.get("refresh_token")
    if not isinstance(access, str) or not access.strip():
        _warn_refresh("Privy refresh returned no token")
        return None
    # `set` may return the literal legacy sentinel `deprecated` instead of a
    # new refresh token. Prefer the real HttpOnly `privy-refresh-token` cookie
    # when present; otherwise keep the existing token for the sentinel.
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
    return access.strip(), rotated_value


def maybe_refresh_access_token(config: Config, token: str) -> str:
    if not config.free_api or not token:
        return token
    expiry = _jwt_expiry(token)
    if expiry is None or expiry - int(time.time()) > config.token_refresh_skew:
        return token
    with _REFRESH_LOCK:
        # Re-read after acquiring the lock: another request may have refreshed it.
        token, refresh = _read_credentials(config)
        expiry = _jwt_expiry(token)
        if expiry is None or expiry - int(time.time()) > config.token_refresh_skew:
            return token
        if not refresh:
            _warn_refresh(
                "Privy token expires in %ss but no refresh token is configured (%s)",
                max(0, expiry - int(time.time())),
                config.refresh_token_file or "FOMO_REFRESH_TOKEN_FILE",
            )
            return token
        app_id = config.privy_app_id or _jwt_audience(token)
        if not app_id:
            _warn_refresh("Privy refresh skipped: cannot determine privy-app-id")
            return token
        refreshed = _request_privy_refresh(config, app_id, refresh)
        if refreshed is None:
            return token
        access, rotated = refreshed
        try:
            if config.auth_token_file:
                _write_private(config.auth_token_file, access)
            if config.refresh_token_file:
                _write_private(config.refresh_token_file, rotated or refresh)
        except OSError as exc:
            _warn_refresh("Privy token persisted failed: %s", type(exc).__name__)
        LOG.info(
            "Privy access token refreshed expires_at=%s",
            datetime.fromtimestamp(_jwt_expiry(access) or 0, timezone.utc).isoformat(timespec="seconds"),
        )
        return access


def current_auth_token(config: Config) -> str:
    access, _refresh = _read_credentials(config)
    return maybe_refresh_access_token(config, access)


def http_json(url: str, config: Config) -> tuple[int, dict[str, str], Any, str | None]:
    token = current_auth_token(config)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if config.free_api:
        if curl_requests is None:
            return 0, {}, None, "curl_cffi is not installed"
        headers.update({"Origin": "https://fomo.family", "Referer": "https://fomo.family/"})
        try:
            response = curl_requests.get(
                url,
                headers=headers,
                impersonate=config.impersonate,
                timeout=config.timeout,
            )
            raw_headers = {key.lower(): value for key, value in response.headers.items()}
            try:
                return response.status_code, raw_headers, json.loads(response.content), None
            except json.JSONDecodeError as exc:
                return response.status_code, raw_headers, None, f"invalid json: {exc}"
        except Exception as exc:
            return 0, {}, None, f"{type(exc).__name__}: {exc}"

    request = urllib.request.Request(
        url,
        headers=headers | {"User-Agent": "fomo-swaps-crawler/0.1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout) as response:
            raw = response.read()
            raw_headers = {key.lower(): value for key, value in response.headers.items()}
            try:
                return response.status, raw_headers, json.loads(raw), None
            except json.JSONDecodeError as exc:
                return response.status, raw_headers, None, f"invalid json: {exc}"
    except urllib.error.HTTPError as exc:
        raw_headers = {key.lower(): value for key, value in exc.headers.items()}
        raw = exc.read()
        body = raw[:300].decode("utf-8", errors="replace")
        return exc.code, raw_headers, None, body
    except (urllib.error.URLError, socket.timeout, TimeoutError) as exc:
        return 0, {}, None, f"{type(exc).__name__}: {exc}"


def fetch_credits(config: Config) -> float | None:
    if config.credit_cost <= 0 or config.free_api:
        return None
    status, _headers, payload, _error = http_json(f"{config.base}/v2/me", config)
    if status != 200 or not isinstance(payload, dict):
        return None
    credits = payload.get("credits")
    if not isinstance(credits, dict):
        return None
    remaining = as_float(credits.get("remaining"))
    return remaining


class RequestPacer:
    """Enforce a minimum delay between HTTP request starts.

    ThreadPoolExecutor with max_workers=1 still picks the next queued task
    immediately when the previous task returns. Putting the delay before the
    request (not in the result consumer) guarantees actual request pacing,
    including retries and concurrent workers.
    """

    def __init__(self, delay_seconds: float) -> None:
        self.delay = max(0.0, delay_seconds)
        self.lock = threading.Lock()
        self.next_start = 0.0

    def wait(self, shutdown_event: threading.Event, cycle_stop: threading.Event) -> bool:
        if shutdown_event.is_set() or cycle_stop.is_set():
            return False
        if self.delay <= 0:
            return True
        with self.lock:
            target = max(time.monotonic(), self.next_start)
            while True:
                remaining = target - time.monotonic()
                if remaining <= 0:
                    break
                if shutdown_event.is_set() or cycle_stop.is_set():
                    return False
                time.sleep(min(0.05, remaining))
            self.next_start = time.monotonic() + self.delay
            return True


@dataclass
class FetchResult:
    handle: str
    user_id: str
    status: int = 0
    outcome: str = "error"
    error: str | None = None
    retry_after: int | None = None
    credits_cost: int = 0
    swaps: list[dict[str, Any]] | None = None
    partial: bool = False
    request_started_at: str = ""


def normalize_free_swap(swap: dict[str, Any]) -> dict[str, Any]:
    """Map prod-api.fomo.family's flat swap into the paid endpoint shape."""
    network_id = swap.get("outNetworkId") or swap.get("networkId")
    if isinstance(network_id, int):
        chain = CHAIN_BY_NETWORK.get(network_id, f"network:{network_id}")
    else:
        network_id = None
        chain = "unknown"
    return {
        "swapId": swap.get("id"),
        "chain": chain,
        "chainId": network_id,
        "tokenIn": {
            "address": swap.get("inTokenAddress"),
            "usd": swap.get("humanUsdAmountIn"),
        },
        "tokenOut": {
            "address": swap.get("outTokenAddress"),
            "usd": swap.get("humanUsdAmountOut"),
        },
        "tradeIdOut": swap.get("outTradeId") or swap.get("inTradeId"),
        "at": swap.get("createdAt"),
    }


def fetch_user(
    config: Config,
    user: dict[str, str],
    shutdown_event: threading.Event,
    cycle_stop: threading.Event,
    pacer: RequestPacer,
) -> FetchResult:
    if shutdown_event.is_set() or cycle_stop.is_set():
        return FetchResult(handle=user["handle"], user_id=user["user_id"], outcome="skipped")
    identity = urllib.parse.quote(user["user_id"], safe="")
    url = f"{config.base}/v2/users/{identity}/swaps?limit={config.limit}"
    result = FetchResult(handle=user["handle"], user_id=user["user_id"])
    for attempt in range(2):
        if not pacer.wait(shutdown_event, cycle_stop):
            result.outcome = "skipped"
            return result
        result.request_started_at = utc_now_iso()
        LOG.debug(
            "request start user=%s at=%s attempt=%s",
            user["handle"], result.request_started_at, attempt + 1,
        )
        status, headers, payload, error = http_json(url, config)
        result.status = status
        try:
            result.credits_cost = int(headers.get("x-credits-cost", "0") or 0)
        except ValueError:
            result.credits_cost = 0
        if status == 200:
            if not isinstance(payload, dict):
                result.outcome = "error"
                result.error = error or "invalid payload"
                return result
            if config.free_api:
                if payload.get("success") is not True:
                    result.outcome = "error"
                    result.error = str(payload.get("message") or "free API success=false")[:300]
                    return result
                response_object = payload.get("responseObject")
                if not isinstance(response_object, dict):
                    result.outcome = "error"
                    result.error = "responseObject is not an object"
                    return result
                raw_swaps = response_object.get("swaps")
                if not isinstance(raw_swaps, list):
                    result.outcome = "error"
                    result.error = "swaps is not a list"
                    return result
                if not raw_swaps:
                    result.outcome = "no_data"
                    result.swaps = []
                    return result
                swaps = [normalize_free_swap(item) for item in raw_swaps if isinstance(item, dict)]
                if not swaps:
                    result.outcome = "error"
                    result.error = "no valid free swap objects"
                    return result
                result.outcome = "ok"
                result.swaps = swaps
                result.partial = bool(response_object.get("hasNextPage"))
                return result

            swaps = payload.get("swaps")
            if payload.get("available") is False:
                result.outcome = "no_data"
                result.swaps = []
                return result
            if not isinstance(swaps, list):
                result.outcome = "error"
                result.error = "swaps is not a list"
                return result
            result.outcome = "ok"
            result.swaps = swaps
            result.partial = bool(payload.get("partial") or payload.get("truncated"))
            return result
        if status == 304:
            result.outcome = "no_data"
            return result
        if status == 404:
            result.outcome = "not_found"
            return result
        if status in (401, 403):
            result.outcome = "auth_error"
            result.error = f"HTTP {status}: {(error or '')[:200]}"
            return result
        if status == 430:
            result.outcome = "auth_error"
            result.error = "HTTP 430 Cloudflare fingerprint/challenge"
            return result
        if status in (429, 503):
            result.retry_after = parse_retry_after(headers)
            result.outcome = "rate_limited" if status == 429 else "upstream_busy"
            if status == 429 and attempt == 0:
                time.sleep(min(result.retry_after, 60))
                continue
            return result
        if 500 <= status < 600 and attempt == 0:
            time.sleep(2 + random.random())
            continue
        result.outcome = "error"
        result.error = f"HTTP {status}: {error or ''}"[:300]
        return result
    return result


def event_key(user_id: str, chain: str, swap: dict[str, Any]) -> str:
    trade_id = swap.get("tradeIdOut")
    if isinstance(trade_id, str) and trade_id:
        return f"{user_id}:{chain}:trade:{trade_id}"
    swap_id = swap.get("swapId")
    if isinstance(swap_id, str) and swap_id:
        return f"{user_id}:{chain}:swap:{swap_id}"
    digest = hashlib.sha1(
        json.dumps(swap, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return f"{user_id}:{chain}:hash:{digest}"


def parse_swap(user: dict[str, str], swap: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(swap, dict):
        return None
    raw_chain = swap.get("chain") if isinstance(swap.get("chain"), str) else ""
    chain = CHAIN_NAMES.get(raw_chain, raw_chain or "unknown")
    chain_id = swap.get("chainId") if isinstance(swap.get("chainId"), int) else None
    token_in = swap.get("tokenIn") if isinstance(swap.get("tokenIn"), dict) else {}
    token_out = swap.get("tokenOut") if isinstance(swap.get("tokenOut"), dict) else {}
    token_in_address = token_in.get("address") if isinstance(token_in.get("address"), str) else None
    token_out_address = token_out.get("address") if isinstance(token_out.get("address"), str) else None
    usd_in = as_float(token_in.get("usd"))
    usd_out = as_float(token_out.get("usd"))
    at_ms = parse_at_ms(swap.get("at"))
    at_iso = swap.get("at") if isinstance(swap.get("at"), str) else (
        datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        if at_ms
        else None
    )
    return {
        "event_key": event_key(user["user_id"], chain, swap),
        "user_id": user["user_id"],
        "handle": user["handle"],
        "chain": chain,
        "chain_id": chain_id,
        "swap_id": swap.get("swapId") if isinstance(swap.get("swapId"), str) else None,
        "trade_id_out": swap.get("tradeIdOut") if isinstance(swap.get("tradeIdOut"), str) else None,
        "at_ms": at_ms,
        "at_iso": at_iso,
        "token_in": token_in_address,
        "usd_in": usd_in,
        "token_out": token_out_address,
        "usd_out": usd_out,
    }


def store_events(db: sqlite3.Connection, cycle_id: int, event: dict[str, Any], now_iso: str) -> None:
    cursor = db.execute(
        "INSERT OR IGNORE INTO swap_events (event_key, user_id, handle, chain, chain_id, swap_id, "
        "trade_id_out, at_ms, at_iso, token_in, usd_in, token_out, usd_out, first_seen_cycle, first_seen_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            event["event_key"], event["user_id"], event["handle"], event["chain"], event["chain_id"],
            event["swap_id"], event["trade_id_out"], event["at_ms"], event["at_iso"],
            event["token_in"], event["usd_in"], event["token_out"], event["usd_out"],
            cycle_id, now_iso,
        ),
    )
    if cursor.rowcount != 1:
        return
    ca = event["token_out"]
    inflow = event["usd_in"]
    if not ca or inflow is None or inflow <= 0:
        return
    if is_quote_asset(ca):
        return
    db.execute(
        "INSERT INTO ca_inflow (user_id, handle, chain, ca, inflow_usd, buy_count, first_seen_at, last_seen_at, last_cycle) "
        "VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?) "
        "ON CONFLICT(user_id, chain, ca) DO UPDATE SET "
        "handle = excluded.handle, inflow_usd = ca_inflow.inflow_usd + excluded.inflow_usd, "
        "buy_count = ca_inflow.buy_count + 1, last_seen_at = excluded.last_seen_at, last_cycle = excluded.last_cycle",
        (
            event["user_id"], event["handle"], event["chain"], ca, inflow,
            now_iso, event["at_iso"] or now_iso, cycle_id,
        ),
    )


def export_ca_inflow(db: sqlite3.Connection, data_dir: Path) -> int:
    target = data_dir / "ca_inflow.csv"
    temp = data_dir / "ca_inflow.csv.tmp"
    rows = db.execute(
        "SELECT user_id, handle, chain, ca, inflow_usd, buy_count, first_seen_at, last_seen_at, last_cycle "
        "FROM ca_inflow ORDER BY inflow_usd DESC, handle, chain, ca"
    ).fetchall()
    with temp.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "user_id", "handle", "chain", "ca", "inflow_usd", "buy_count",
            "first_seen_at", "last_seen_at", "last_cycle",
        ])
        writer.writerows(rows)
    os.replace(temp, target)
    return len(rows)


def write_latest_summary(data_dir: Path, summary: dict[str, Any]) -> None:
    target = data_dir / "latest_cycle.json"
    temp = data_dir / "latest_cycle.json.tmp"
    temp.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, target)


def select_cycle_users(
    users: list[dict[str, str]],
    cycle_users: int,
    cursor: int,
) -> tuple[list[dict[str, str]], int]:
    if cycle_users <= 0 or cycle_users >= len(users):
        return users, 0
    start = cursor % len(users)
    selected = [users[(start + offset) % len(users)] for offset in range(cycle_users)]
    return selected, (start + cycle_users) % len(users)


def iter_batches(items: list[dict[str, str]], size: int):
    if size <= 0 or size >= len(items):
        yield items
        return
    for offset in range(0, len(items), size):
        yield items[offset : offset + size]


def run_cycle(
    config: Config,
    db: sqlite3.Connection,
    users: list[dict[str, str]],
    shutdown_event: threading.Event,
) -> dict[str, Any]:
    cycle_stop = threading.Event()
    pacer = RequestPacer(config.delay_ms / 1000.0)
    state = read_rate_state(db, config.interval)
    interval = state["interval_seconds"]
    selected_users, next_cursor = select_cycle_users(users, config.cycle_users, state["user_cursor"])
    started_at = utc_now_iso()
    started = time.time()
    cycle_cursor = db.execute(
        "INSERT INTO cycles (started_at, users_total, users_available, interval_seconds) VALUES (?, ?, ?, ?)",
        (started_at, len(selected_users), len(users), interval),
    )
    cycle_id = int(cycle_cursor.lastrowid)
    db.commit()

    credits_before = fetch_credits(config)
    estimated_cost = len(selected_users) * config.credit_cost
    if (
        credits_before is not None
        and config.credit_cost > 0
        and credits_before < estimated_cost + config.credit_reserve
    ):
        interval = min(config.max_interval, max(config.interval, interval * 2))
        write_rate_state(
            db, interval, state["consecutive_limited"], 0, False, state["user_cursor"]
        )
        summary = {
            "cycle_id": cycle_id,
            "started_at": started_at,
            "finished_at": utc_now_iso(),
            "users_total": len(selected_users),
            "users_available": len(users),
            "users_ok": 0,
            "http_429": 0,
            "http_503": 0,
            "errors": 0,
            "credits_cost": 0,
            "credits_remaining_before": credits_before,
            "credits_remaining_after": credits_before,
            "interval_seconds": interval,
            "duration_ms": int((time.time() - started) * 1000),
            "stop_reason": "credit_guard",
            "estimated_cost": estimated_cost,
        }
        db.execute(
            "UPDATE cycles SET finished_at = ?, credits_remaining_before = ?, credits_remaining_after = ?, "
            "interval_seconds = ?, duration_ms = ?, stop_reason = ? WHERE id = ?",
            (
                summary["finished_at"], credits_before, credits_before, interval,
                summary["duration_ms"], "credit_guard", cycle_id,
            ),
        )
        db.commit()
        write_latest_summary(config.data_dir, summary)
        LOG.warning(
            "cycle %s skipped: credits %.0f < estimated %.0f + reserve %.0f; interval=%ss",
            cycle_id, credits_before, estimated_cost, config.credit_reserve, interval,
        )
        return summary

    LOG.info(
        "cycle %s start users=%s/%s interval=%ss concurrency=%s batch=%s pause=%ss credits_before=%s",
        cycle_id, len(selected_users), len(users), interval, config.concurrency,
        config.batch_size or "all", config.batch_pause,
        f"{credits_before:.0f}" if credits_before is not None else "unknown",
    )

    counters = {
        "users_ok": 0,
        "users_no_data": 0,
        "users_404": 0,
        "http_429": 0,
        "http_503": 0,
        "errors": 0,
        "credits_cost": 0,
    }
    stop_reason: str | None = None
    retry_users: list[dict[str, str]] = []
    retry_wait = 0

    def handle_result(result: FetchResult, user: dict[str, str], allow_retry: bool = True) -> None:
        nonlocal stop_reason, retry_wait
        counters["credits_cost"] += result.credits_cost
        if result.outcome == "ok":
            counters["users_ok"] += 1
            now_iso = utc_now_iso()
            for swap in result.swaps or []:
                event = parse_swap({"handle": result.handle, "user_id": result.user_id}, swap)
                if event is not None:
                    store_events(db, cycle_id, event, now_iso)
            db.commit()
            if result.partial:
                LOG.warning("user %s: partial/truncated first page", result.handle)
            return
        if result.outcome == "no_data":
            counters["users_no_data"] += 1
            return
        if result.outcome == "not_found":
            counters["users_404"] += 1
            error = "HTTP 404"
        elif result.outcome == "rate_limited":
            counters["http_429"] += 1
            error = f"HTTP 429 retry_after={result.retry_after}"
            if stop_reason is None:
                stop_reason = "rate_limited"
            cycle_stop.set()
        elif result.outcome == "upstream_busy":
            counters["http_503"] += 1
            error = f"HTTP 503 retry_after={result.retry_after}"
            if allow_retry:
                retry_users.append(user)
                retry_wait = max(retry_wait, result.retry_after or 30)
            if config.max_503 > 0 and counters["http_503"] >= config.max_503 and stop_reason is None:
                stop_reason = "upstream_busy"
                cycle_stop.set()
        elif result.outcome == "auth_error":
            counters["errors"] += 1
            error = result.error or "auth error"
            if stop_reason is None:
                stop_reason = "auth_error"
            cycle_stop.set()
        elif result.outcome == "skipped":
            return
        else:
            counters["errors"] += 1
            error = result.error or result.outcome
        db.execute(
            "INSERT INTO user_errors (cycle_id, handle, user_id, status, error, at) VALUES (?, ?, ?, ?, ?, ?)",
            (cycle_id, result.handle, result.user_id, result.status, error, utc_now_iso()),
        )
        db.commit()
        LOG.warning("user %s: %s", result.handle, error)

    def run_batch(
        batch: list[dict[str, str]],
        max_workers: int,
        allow_retry: bool,
    ) -> None:
        if max_workers == 1:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                for user in batch:
                    if cycle_stop.is_set() or shutdown_event.is_set():
                        return
                    try:
                        result = executor.submit(
                            fetch_user, config, user, shutdown_event, cycle_stop, pacer
                        ).result()
                    except concurrent.futures.CancelledError:
                        continue
                    handle_result(result, user, allow_retry=allow_retry)
            return

        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    fetch_user, config, user, shutdown_event, cycle_stop, pacer
                ): user
                for user in batch
            }
            for future in concurrent.futures.as_completed(futures):
                try:
                    result = future.result()
                except concurrent.futures.CancelledError:
                    continue
                handle_result(result, futures[future], allow_retry=allow_retry)
                if cycle_stop.is_set() or shutdown_event.is_set():
                    for pending in futures:
                        pending.cancel()
                    return

    failure: BaseException | None = None
    try:
        for batch_index, batch in enumerate(iter_batches(selected_users, config.batch_size)):
            if cycle_stop.is_set() or shutdown_event.is_set():
                break
            if batch_index > 0 and config.batch_pause:
                LOG.info(
                    "cycle %s batch pause %ss before batch %s",
                    cycle_id, config.batch_pause, batch_index + 1,
                )
                if not sleep_interruptible(config.batch_pause, shutdown_event):
                    break
            LOG.info(
                "cycle %s batch %s users=%s",
                cycle_id, batch_index + 1, len(batch),
            )
            run_batch(batch, config.concurrency, True)

        if retry_users and not cycle_stop.is_set() and not shutdown_event.is_set():
            wait = min(max(retry_wait, 1), 120)
            LOG.info("retrying %s users with HTTP 503 after %ss", len(retry_users), wait)
            if sleep_interruptible(wait, shutdown_event):
                for retry_index, batch in enumerate(iter_batches(retry_users, config.batch_size)):
                    if cycle_stop.is_set() or shutdown_event.is_set():
                        break
                    if retry_index > 0 and config.batch_pause:
                        LOG.info(
                            "cycle %s retry batch pause %ss before batch %s",
                            cycle_id, config.batch_pause, retry_index + 1,
                        )
                        if not sleep_interruptible(config.batch_pause, shutdown_event):
                            break
                    LOG.info(
                        "cycle %s retry batch %s users=%s",
                        cycle_id, retry_index + 1, len(batch),
                    )
                    run_batch(batch, 1, False)
    except KeyboardInterrupt as exc:
        stop_reason = "interrupted"
        shutdown_event.set()
        cycle_stop.set()
        failure = exc
    except BaseException as exc:
        stop_reason = "error"
        cycle_stop.set()
        failure = exc
        LOG.exception("cycle %s failed", cycle_id)
    finally:
        if stop_reason is None and shutdown_event.is_set():
            stop_reason = "interrupted"
        final_stop = stop_reason or "completed"
        if shutdown_event.is_set() and final_stop == "completed":
            final_stop = "interrupted"

        if final_stop == "rate_limited":
            interval = min(config.max_interval, max(config.interval, interval * 2))
            consecutive_limited = state["consecutive_limited"] + 1
            clean_cycles = 0
            delayed = True
        elif final_stop == "upstream_busy":
            interval = min(config.max_interval, max(config.interval, interval * 2))
            consecutive_limited = state["consecutive_limited"] + 1
            clean_cycles = 0
            delayed = True
        elif final_stop == "auth_error":
            # Keep the adaptive interval intact; only the next sleep is short.
            interval = max(config.interval, interval)
            consecutive_limited = state["consecutive_limited"]
            clean_cycles = state["clean_cycles"]
            delayed = False
        elif final_stop in {"interrupted", "error"}:
            consecutive_limited = state["consecutive_limited"]
            clean_cycles = state["clean_cycles"]
            delayed = False
        elif counters["http_503"] > 0:
            # Upstream capacity errors are not clean cycles; keep the interval
            # where it is instead of decaying toward the base.
            consecutive_limited = state["consecutive_limited"]
            clean_cycles = 0
            delayed = False
        else:
            if interval < config.interval:
                interval = config.interval
            consecutive_limited = 0
            clean_cycles = state["clean_cycles"] + 1
            if clean_cycles >= config.clean_cycles_to_decay and interval > config.interval:
                interval = max(config.interval, interval // 2)
                clean_cycles = 0
            delayed = False
        cursor_to_write = next_cursor if final_stop == "completed" else state["user_cursor"]
        sleep_seconds = config.auth_retry_seconds if final_stop == "auth_error" else interval
        write_rate_state(db, interval, consecutive_limited, clean_cycles, delayed, cursor_to_write)

        try:
            credits_after = fetch_credits(config)
        except Exception:
            LOG.exception("cycle %s: could not read credits after cycle", cycle_id)
            credits_after = None
        finished_at = utc_now_iso()
        duration_ms = int((time.time() - started) * 1000)
        db.execute(
            "UPDATE cycles SET finished_at = ?, users_ok = ?, users_no_data = ?, users_404 = ?, "
            "http_429 = ?, http_503 = ?, errors = ?, credits_cost = ?, credits_remaining_before = ?, "
            "credits_remaining_after = ?, interval_seconds = ?, duration_ms = ?, stop_reason = ? WHERE id = ?",
            (
                finished_at, counters["users_ok"], counters["users_no_data"], counters["users_404"],
                counters["http_429"], counters["http_503"], counters["errors"], counters["credits_cost"],
                credits_before, credits_after, interval, duration_ms, final_stop, cycle_id,
            ),
        )
        db.commit()
        ca_rows = export_ca_inflow(db, config.data_dir)
        summary = {
            "cycle_id": cycle_id,
            "started_at": started_at,
            "finished_at": finished_at,
            "users_total": len(selected_users),
            "users_available": len(users),
            **counters,
            "credits_remaining_before": credits_before,
            "credits_remaining_after": credits_after,
            "interval_seconds": interval,
            "sleep_seconds": sleep_seconds,
            "next_user_cursor": cursor_to_write,
            "duration_ms": duration_ms,
            "stop_reason": final_stop,
            "ca_inflow_rows": ca_rows,
        }
        write_latest_summary(config.data_dir, summary)
        LOG.info(
            "cycle %s done ok=%s no_data=%s 404=%s 429=%s 503=%s errors=%s credits=%s interval=%ss "
            "duration=%ss stop=%s ca_rows=%s",
            cycle_id, counters["users_ok"], counters["users_no_data"], counters["users_404"],
            counters["http_429"], counters["http_503"], counters["errors"], counters["credits_cost"],
            interval, round(duration_ms / 1000, 1), final_stop, ca_rows,
        )

    if failure is not None:
        raise failure
    if final_stop == "auth_error":
        if config.once:
            LOG.error("FOMO auth failed; check the token/credentials. Exiting.")
            raise SystemExit(2)
        LOG.error(
            "FOMO auth failed; update FOMO_AUTH_TOKEN_FILE/FOMO_REFRESH_TOKEN_FILE. Retrying in %ss.",
            config.auth_retry_seconds,
        )
    return summary


def sleep_interruptible(seconds: int, stop_event: threading.Event) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if stop_event.is_set():
            return False
        time.sleep(min(5, max(0.1, deadline - time.monotonic())))
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Standalone FOMO swaps crawler")
    parser.add_argument("--once", action="store_true", help="run one cycle and exit")
    parser.add_argument("--max-users", type=int, default=None, help="limit users for a smoke test")
    parser.add_argument("--interval", type=int, default=None, help="override base interval seconds")
    parser.add_argument("--log-level", default=os.environ.get("FOMO_LOG_LEVEL", "INFO"))
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)sZ %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    # logging uses local time by default; force UTC for predictable journals.
    logging.Formatter.converter = time.gmtime

    config = Config.from_env(args)
    users = load_users(config.users_file)
    if config.max_users > 0:
        users = users[: config.max_users]
    if not users:
        raise SystemExit("no users selected")
    db = open_db(config)
    sync_users(db, users)
    stop_event = threading.Event()

    def on_signal(signum: int, _frame: Any) -> None:
        LOG.info("signal %s received; stopping", signum)
        stop_event.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    if config.start_delay > 0 and not config.once:
        LOG.info("start delay %ss", config.start_delay)
        if not sleep_interruptible(config.start_delay, stop_event):
            return 0

    if config.once:
        summary = run_cycle(config, db, users, stop_event)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    while not stop_event.is_set():
        summary = run_cycle(config, db, users, stop_event)
        if stop_event.is_set():
            break
        sleep_seconds = int(summary.get("sleep_seconds", summary.get("interval_seconds", config.interval)))
        LOG.info("next cycle in %ss", sleep_seconds)
        if not sleep_interruptible(sleep_seconds, stop_event):
            break
    LOG.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
