#!/usr/bin/env python3
"""Collect finalized Solana transactions for a finite signature list."""

import argparse
import concurrent.futures
import json
import os
import random
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_ENDPOINTS = (
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
)
SIGNATURE_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{80,90}$")


class StartLimiter:
    """Coordinate minimum spacing between every request start."""

    def __init__(self, rps: float) -> None:
        self.interval = 1.0 / rps
        self.lock = threading.Lock()
        self.next_start = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            delay = max(0.0, self.next_start - now)
            self.next_start = max(now, self.next_start) + self.interval
        if delay:
            time.sleep(delay)


def endpoints_from_env() -> list[str]:
    raw = os.environ.get("SOL_RPC_URLS")
    if not raw:
        return list(DEFAULT_ENDPOINTS)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = [part.strip() for part in raw.split(",")]
    endpoints = parsed if isinstance(parsed, list) else [parsed]
    if not endpoints or any(not isinstance(url, str) or not url.strip() for url in endpoints):
        raise ValueError("SOL_RPC_URLS must be a JSON array or comma-separated URLs")
    return [url.strip() for url in endpoints]


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def cached_result(path: Path) -> bool:
    try:
        with path.open(encoding="utf-8") as stream:
            value = json.load(stream)
        return isinstance(value, dict) and value.get("result") is not None
    except (OSError, json.JSONDecodeError):
        return False


def fetch_transaction(signature: str, endpoints: list[str], limiter: StartLimiter) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "getTransaction",
        "params": [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 1,
                                "commitment": "finalized"}],
    }).encode()
    last_error: dict[str, Any] = {"category": "unknown"}
    for attempt in range(3):
        endpoint = endpoints[attempt % len(endpoints)]
        limiter.wait()
        request = urllib.request.Request(endpoint, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = json.loads(response.read())
            if not isinstance(body, dict):
                last_error = {"category": "invalid_response"}
            elif body.get("error"):
                rpc_error = body["error"]
                code = rpc_error.get("code") if isinstance(rpc_error, dict) else None
                last_error = {"category": "rpc_error"}
                if isinstance(code, int):
                    last_error["code"] = code
            elif not isinstance(body.get("result"), dict):
                last_error = {"category": "transaction_not_found"}
            else:
                return body["result"], None
        except urllib.error.HTTPError as exc:
            last_error = {"category": "http_error", "http": exc.code}
            try:
                exc.close()
            except Exception:
                pass
        except (urllib.error.URLError, TimeoutError, OSError):
            last_error = {"category": "network_error"}
        except (json.JSONDecodeError, UnicodeDecodeError):
            last_error = {"category": "invalid_json"}
        if attempt < 2:
            time.sleep((0.5 * (2**attempt)) + random.uniform(0, 0.25))
    return None, last_error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="JSON file containing a list of signatures")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--rps", type=float, default=2)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.workers < 1 or args.rps <= 0 or (args.limit is not None and args.limit < 0):
        parser.error("workers and rps must be positive; limit must be nonnegative")
    try:
        with args.input.open(encoding="utf-8") as stream:
            signatures = json.load(stream)
        if not isinstance(signatures, list) or any(not isinstance(sig, str) for sig in signatures):
            raise ValueError("input must contain a JSON list of signature strings")
        invalid = [sig for sig in signatures if not SIGNATURE_RE.fullmatch(sig)]
        if invalid:
            raise ValueError(f"invalid Solana signature at input index {signatures.index(invalid[0])}")
        endpoints = endpoints_from_env()
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        parser.error(str(exc))
    if args.limit is not None:
        signatures = signatures[:args.limit]
    signatures = list(dict.fromkeys(signatures))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    todo = [sig for sig in signatures if not cached_result(args.output_dir / f"{sig}.json")]
    cached = len(signatures) - len(todo)
    limiter = StartLimiter(args.rps)
    failures: dict[str, dict[str, Any]] = {}
    fetched = 0
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_transaction, sig, endpoints, limiter): sig for sig in todo}
        for future in concurrent.futures.as_completed(futures):
            sig = futures[future]
            result, error = future.result()
            if result is None:
                failures[sig] = error or {"category": "unknown"}
            else:
                atomic_json(args.output_dir / f"{sig}.json", result)
                fetched += 1
    atomic_json(args.output_dir / "failures.json", failures)
    print(json.dumps({"fetched": fetched, "cached": cached, "failed": len(failures),
                      "elapsed": round(time.monotonic() - started, 3)}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
