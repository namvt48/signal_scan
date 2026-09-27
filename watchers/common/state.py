"""State bền: cursor/watermark của feed + heartbeat beacon cho watchdog.

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import json
import os

from watchers.common.config import HERE

# Liveness beacon cho watchdog.sh: block feed touch mỗi block kể cả khi không có
# trade (feed chết ⇒ mtime đứng ⇒ watchdog restart sau 300s).
HEARTBEAT = os.path.join(HERE, "heartbeat")


def _beat() -> None:
    """Touch beacon cho watchdog.sh."""
    try:
        open(HEARTBEAT, "w").close()
    except OSError:
        pass


STATE_PATH = os.path.join(HERE, "wallet_watch_state.json")


def load_state():
    try:
        return json.load(open(STATE_PATH))
    except Exception:
        return {"wallets": {}}


def save_state(st) -> None:
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATE_PATH)
