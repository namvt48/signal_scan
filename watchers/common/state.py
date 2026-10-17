"""State bền: cursor/watermark của feed + heartbeat beacon cho watchdog.

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import json
import os
import tempfile

from watchers.common.config import HERE

# Liveness beacon cho watchdog.sh: block feed touch mỗi block kể cả khi không có
# trade (feed chết ⇒ mtime đứng ⇒ watchdog restart sau 300s).
HEARTBEAT = os.path.join(HERE, "heartbeat")
MONITOR_HEARTBEAT = os.environ.get(
    "MONITOR_HEARTBEAT_PATH", "/root/signal-scan-monitor/heartbeats/wallet"
)


def _beat() -> None:
    """Touch watchdog beacon and its private monitor mirror."""
    for path in (HEARTBEAT, MONITOR_HEARTBEAT):
        if not path:
            continue
        try:
            open(path, "w").close()
        except OSError:
            pass


STATE_PATH = os.path.join(HERE, "wallet_watch_state.json")


def load_state():
    try:
        return json.load(open(STATE_PATH))
    except Exception:
        return {"wallets": {}}


def save_state(st) -> None:
    directory = os.path.dirname(os.path.abspath(STATE_PATH))
    fd, tmp = tempfile.mkstemp(
        prefix=os.path.basename(STATE_PATH) + ".",
        suffix=".tmp",
        dir=directory,
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(st, f)
        os.replace(tmp, STATE_PATH)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
