#!/usr/bin/env python3
"""Set the Fresh Wallet Browserless endpoints without exposing other env values."""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from urllib.parse import urlsplit

KEY = "CRAWL_FRESH_WALLET_WS_ENDPOINTS"


def normalize_endpoints(value: str) -> str:
    endpoints = list(dict.fromkeys(endpoint.strip() for endpoint in value.split(",") if endpoint.strip()))
    if not endpoints:
        raise ValueError("at least one Browserless endpoint is required")
    for endpoint in endpoints:
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme not in {"ws", "wss"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("endpoints must be credential-free ws:// or wss:// URLs")
    return ",".join(endpoints)


def update_env_file(path: Path, endpoints: str) -> bool:
    """Atomically update the private gateway env file; return whether it changed."""
    value = normalize_endpoints(endpoints)
    if path.is_symlink() or not path.is_file():
        raise ValueError("gateway env must be a regular file, not a symlink")
    file_stat = path.stat(follow_symlinks=False)
    if file_stat.st_uid != os.geteuid() or file_stat.st_mode & 0o077:
        raise ValueError("gateway env must be owned by the updater and mode 600 or stricter")

    lines = path.read_text(encoding="utf-8").splitlines()
    matches = [index for index, line in enumerate(lines) if re.match(rf"^{KEY}=", line)]
    if len(matches) > 1:
        raise ValueError(f"gateway env contains duplicate {KEY} entries")
    new_line = f"{KEY}={value}"
    if matches:
        if lines[matches[0]] == new_line:
            return False
        lines[matches[0]] = new_line
    else:
        lines.append(new_line)

    descriptor, temporary = tempfile.mkstemp(prefix=".gateway.env.", dir=path.parent)
    try:
        os.fchmod(descriptor, stat.S_IMODE(file_stat.st_mode))
        os.fchown(descriptor, file_stat.st_uid, file_stat.st_gid)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
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
    if len(sys.argv) != 3:
        raise SystemExit("usage: set_gateway_env.py <gateway.env> <ws-endpoints>")
    try:
        changed = update_env_file(Path(sys.argv[1]), sys.argv[2])
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc
    print(f"{KEY} {'updated' if changed else 'already current'}; values kept private")


if __name__ == "__main__":
    main()
