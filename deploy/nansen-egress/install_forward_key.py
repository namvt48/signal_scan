#!/usr/bin/env python3
"""Install one narrowly restricted VPS-250 forwarding key idempotently."""

from __future__ import annotations

import base64
import datetime as dt
import ipaddress
import os
from pathlib import Path
import shutil
import tempfile

AUTHORIZED_KEYS = Path("/root/.ssh/authorized_keys")


def restricted_key_options(source_ip: str, tunnel_port: int) -> str:
    """Return SSH restrictions for one approved local-only tunnel port."""
    if tunnel_port not in {31134, 31135}:
        raise ValueError("tunnel port must be 31134 or 31135")
    source_ip = str(ipaddress.IPv4Address(source_ip))
    return (
        'command="/bin/false",restrict,port-forwarding,'
        f'from="{source_ip}",permitopen="127.0.0.1:{tunnel_port}"'
    )


def main() -> None:
    public_key = input().strip()
    fields = public_key.split()
    if len(fields) != 3 or fields[0] != "ssh-ed25519":
        raise SystemExit("expected one ssh-ed25519 public key")
    try:
        base64.b64decode(fields[1], validate=True)
    except ValueError as exc:
        raise SystemExit("invalid public key encoding") from exc

    source_ip = str(ipaddress.IPv4Address(os.environ["TUNNEL_SOURCE_IP"]))
    try:
        tunnel_port = int(os.environ.get("TUNNEL_PORT", "31134"))
    except ValueError as exc:
        raise SystemExit("TUNNEL_PORT must be 31134 or 31135") from exc
    try:
        key_options = restricted_key_options(source_ip, tunnel_port)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    directory = AUTHORIZED_KEYS.parent
    if directory.is_symlink() or not directory.is_dir():
        raise SystemExit("root SSH directory is missing or unsafe")
    directory_stat = directory.stat()
    if directory_stat.st_uid != 0 or directory_stat.st_mode & 0o077:
        raise SystemExit("root SSH directory ownership or permissions are unsafe")

    path = AUTHORIZED_KEYS
    if path.is_symlink():
        raise SystemExit("authorized_keys must not be a symlink")
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    line = f"{key_options} {public_key}"
    for existing in old.splitlines():
        parts = existing.split()
        for index, part in enumerate(parts[:-1]):
            if part.startswith("ssh-") and parts[index + 1] == fields[1]:
                if existing == line:
                    print("Restricted tunnel key already installed")
                    return
                raise SystemExit("same public key exists with different restrictions; refusing to proceed")

    if path.exists():
        if path.stat().st_uid != 0 or not path.is_file():
            raise SystemExit("authorized_keys ownership or file type is unsafe")
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shutil.copy2(path, path.with_name(f"authorized_keys.backup.{stamp}"))
    content = old + ("" if not old or old.endswith("\n") else "\n") + line + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=".authorized_keys.", dir=directory)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Installed restricted VPS-250 forwarding key")


if __name__ == "__main__":
    main()
