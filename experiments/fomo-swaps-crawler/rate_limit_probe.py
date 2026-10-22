#!/usr/bin/env python3
"""Bounded read-only probe for the FOMO prod API.

Measures latency and rate-limit behavior at a fixed aggregate request rate.
It stops immediately on 401/403/429/430/503 so it never ramps through errors.

Usage:
    FOMO_AUTH_TOKEN_FILE=data/credentials/access_token \
      python3 rate_limit_probe.py --rates 1,2,4 --requests 30

The token is never printed. Output is JSONL plus a per-step summary.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import statistics
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import crawler
from curl_cffi import requests

DEFAULT_BASE = "https://prod-api.fomo.family"
STOP_STATUSES = {401, 403, 429, 430, 503}
CAPTURE_HEADERS = (
    "cf-ray",
    "cf-cache-status",
    "server",
    "etag",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
)


@dataclass
class Sample:
    ts: str
    status: int
    latency_ms: float
    wait_ms: float
    user_id: str
    bytes: int
    error: str | None
    headers: dict[str, str] = field(default_factory=dict)


class Pacer:
    """Reserve request start slots at a fixed aggregate rate."""

    def __init__(self, rate: float) -> None:
        self.interval = 1.0 / rate if rate > 0 else 0.0
        self.lock = threading.Lock()
        self.next_start = 0.0

    def wait(self, stop: threading.Event) -> float:
        if self.interval <= 0:
            return 0.0
        entered = time.monotonic()
        with self.lock:
            target = max(time.monotonic(), self.next_start)
            while True:
                remaining = target - time.monotonic()
                if remaining <= 0:
                    break
                if stop.is_set():
                    return (time.monotonic() - entered) * 1000.0
                time.sleep(min(0.02, remaining))
            self.next_start = time.monotonic() + self.interval
        return max(0.0, (time.monotonic() - entered) * 1000.0)


def load_users(path: Path, count: int) -> list[str]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    ids = [str(row.get("user_id") or "").strip() for row in rows]
    ids = [user_id for user_id in ids if user_id]
    if not ids:
        raise SystemExit(f"no user_id values in {path}")
    random.Random(0).shuffle(ids)
    return ids[: max(1, min(count, len(ids)))]


def read_token(path: str | None) -> str:
    if path:
        token = crawler._read_private_text(path)
    else:
        token = os.environ.get("FOMO_AUTH_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "missing access token: set FOMO_AUTH_TOKEN_FILE or FOMO_AUTH_TOKEN"
        )
    return token


def token_expiry(token: str) -> int | None:
    return crawler._jwt_expiry(token)


def request_once(
    base: str,
    token: str,
    user_id: str,
    timeout: int,
    pacer: Pacer,
    stop: threading.Event,
) -> Sample | None:
    wait_ms = pacer.wait(stop)
    if stop.is_set():
        return None
    url = f"{base}/v2/users/{user_id}/swaps?limit=100"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Origin": "https://fomo.family",
        "Referer": "https://fomo.family/",
    }
    started = time.perf_counter()
    try:
        response = requests.get(
            url,
            headers=headers,
            impersonate="chrome",
            timeout=timeout,
        )
        latency_ms = (time.perf_counter() - started) * 1000.0
        raw_headers = {key.lower(): value for key, value in response.headers.items()}
        status = response.status_code
        size = len(response.content or b"")
        error = None
        if status in STOP_STATUSES:
            error = f"HTTP {status}"
    except Exception as exc:
        latency_ms = (time.perf_counter() - started) * 1000.0
        raw_headers = {}
        status = 0
        size = 0
        error = f"{type(exc).__name__}: {exc}"
    sample = Sample(
        ts=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        status=status,
        latency_ms=round(latency_ms, 1),
        wait_ms=round(wait_ms, 1),
        user_id=user_id,
        bytes=size,
        error=error,
        headers={key: raw_headers[key] for key in CAPTURE_HEADERS if key in raw_headers},
    )
    if status in STOP_STATUSES:
        stop.set()
    return sample


def summarize(rate: float, concurrency: int, samples: list[Sample]) -> dict[str, Any]:
    latencies = sorted(sample.latency_ms for sample in samples)
    statuses: dict[str, int] = {}
    for sample in samples:
        key = str(sample.status)
        statuses[key] = statuses.get(key, 0) + 1
    def percentile(p: float) -> float:
        if not latencies:
            return 0.0
        index = min(len(latencies) - 1, max(0, int(round((len(latencies) - 1) * p))))
        return latencies[index]
    return {
        "rate": rate,
        "concurrency": concurrency,
        "requests": len(samples),
        "statuses": statuses,
        "errors": sum(1 for sample in samples if sample.error),
        "latency_ms": {
            "min": latencies[0] if latencies else 0.0,
            "p50": percentile(0.50),
            "p95": percentile(0.95),
            "p99": percentile(0.99),
            "max": latencies[-1] if latencies else 0.0,
            "mean": round(statistics.fmean(latencies), 1) if latencies else 0.0,
        },
        "rate_limit_headers": sorted(
            {
                key
                for sample in samples
                for key in sample.headers
                if "rate" in key or key == "retry-after"
            }
        ),
    }


def run_step(
    base: str,
    token: str,
    users: list[str],
    rate: float,
    concurrency: int,
    requests_count: int,
    timeout: int,
) -> tuple[list[Sample], dict[str, Any], bool]:
    pacer = Pacer(rate)
    stop = threading.Event()
    samples: list[Sample] = []
    lock = threading.Lock()
    issued = 0
    issued_lock = threading.Lock()

    def worker() -> None:
        nonlocal issued
        while not stop.is_set():
            with issued_lock:
                if issued >= requests_count:
                    return
                index = issued
                issued += 1
            sample = request_once(
                base,
                token,
                users[index % len(users)],
                timeout,
                pacer,
                stop,
            )
            if sample is not None:
                with lock:
                    samples.append(sample)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(concurrency)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    summary = summarize(rate, concurrency, samples)
    return samples, summary, stop.is_set()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("FOMO_API_BASE", DEFAULT_BASE))
    parser.add_argument("--token-file", default=os.environ.get("FOMO_AUTH_TOKEN_FILE"))
    parser.add_argument("--users-file", default=os.environ.get("FOMO_USERS_FILE", "users.csv"))
    parser.add_argument("--user-count", type=int, default=20)
    parser.add_argument("--rates", default="1,2,4", help="comma-separated aggregate req/s")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--requests", type=int, default=30, help="requests per rate step")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--output", default="data/rate-limit-probe.jsonl")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = read_token(args.token_file)
    expiry = token_expiry(token)
    if expiry is None:
        raise SystemExit("token is not a JWT with exp; refusing to probe")
    remaining = expiry - int(time.time())
    print(f"token_expires_at={datetime.fromtimestamp(expiry, timezone.utc).isoformat()}")
    print(f"token_remaining_seconds={remaining}")
    if remaining <= 0:
        raise SystemExit("access token is expired; refresh it before probing")
    if remaining < 120:
        print("warning: token expires in <120s; results may be cut short")

    users = load_users(Path(args.users_file), args.user_count)
    rates = [float(value) for value in args.rates.split(",") if value.strip()]
    if any(rate <= 0 for rate in rates):
        raise SystemExit("rates must be > 0")
    print(f"base={args.base} users={len(users)} rates={rates} concurrency={args.concurrency}")
    if args.dry_run:
        print("dry-run: no requests sent")
        return

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    all_samples: list[Sample] = []
    with output.open("w", encoding="utf-8") as handle:
        for rate in rates:
            samples, summary, stopped = run_step(
                args.base.rstrip("/"),
                token,
                users,
                rate,
                args.concurrency,
                args.requests,
                args.timeout,
            )
            all_samples.extend(samples)
            for sample in samples:
                handle.write(json.dumps(asdict(sample), ensure_ascii=False) + "\n")
            handle.flush()
            print(json.dumps({"step": summary, "stopped_on_error": stopped}, ensure_ascii=False))
            if stopped:
                print("stopped: received a stop status; not increasing rate further")
                break
    print(f"wrote {len(all_samples)} samples to {output}")


if __name__ == "__main__":
    main()
