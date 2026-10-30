#!/usr/bin/env python3
"""Copy only the running API's SOL RPC endpoints into a private watcher env file."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit

KEY = "SOLANA_RPC_URL"
EXPECTED_ENDPOINTS = 6


def normalize_endpoints(value: str) -> str:
    if any(character in value for character in "\r\n\0"):
        raise ValueError("RPC endpoints must not contain environment line breaks")
    endpoints = list(dict.fromkeys(item for item in re.split(r"[,\s]+", value.strip()) if item))
    if len(endpoints) != EXPECTED_ENDPOINTS:
        raise ValueError(f"expected {EXPECTED_ENDPOINTS} Solana RPC endpoints")
    for endpoint in endpoints:
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("RPC endpoints must be HTTPS URLs without userinfo or fragments")
    return ",".join(endpoints)


def container_endpoints(container: str) -> str:
    result = subprocess.run(
        ["docker", "inspect", container], check=True, capture_output=True, text=True, timeout=10,
    )
    details = json.loads(result.stdout)[0]
    if not details["State"]["Running"]:
        raise ValueError("the source API container must be running")
    environment = dict(entry.split("=", 1) for entry in details["Config"].get("Env", []) if "=" in entry)
    if environment.get("AUTH_DISABLED") == "1" or environment.get("VITE_AUTH_DISABLED") == "1":
        raise ValueError("local authentication bypass must be absent from production")
    return normalize_endpoints(environment.get(KEY) or environment.get("RPC_HTTP") or "")


def validate_target(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("watcher RPC env must not be a symlink")
    if path.exists():
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            raise ValueError("watcher RPC env must be a private regular file owned by the updater")
        if any(line and not line.startswith(f"{KEY}=") for line in path.read_text().splitlines()):
            raise ValueError("dedicated watcher RPC env contains unrelated settings")


def update_env_file(path: Path, endpoints: str) -> bool:
    value = normalize_endpoints(endpoints)
    validate_target(path)
    quoted = value.replace("\\", "\\\\").replace('"', '\\"')
    content = f'{KEY}="{quoted}"\n'
    if path.exists() and path.read_text() == content and stat.S_IMODE(path.stat().st_mode) == 0o600:
        return False
    descriptor, temporary = tempfile.mkstemp(prefix=".rpc.env.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--env-file", type=Path, default=Path("/opt/wallet-watch/rpc.env"))
    parser.add_argument("--check", action="store_true", help="validate without writing the env file")
    args = parser.parse_args()
    try:
        endpoints = container_endpoints(args.container)
        validate_target(args.env_file)
        if args.check:
            outcome = "validated"
        else:
            outcome = "updated" if update_env_file(args.env_file, endpoints) else "already current"
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    except (OSError, subprocess.SubprocessError, KeyError, IndexError, TypeError) as exc:
        raise SystemExit(f"RPC env update failed: {type(exc).__name__}; values kept private") from None
    print(f"{KEY} {outcome}: {len(endpoints.split(','))} endpoints; values kept private")


if __name__ == "__main__":
    main()
