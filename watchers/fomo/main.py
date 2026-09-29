"""CLI của daemon FOMO: `python3 -m watchers.fomo`.

Mirror shape của `watchers/sol/main.py` (argparse → set config._api_url → run feed).
KHÔNG reuse state/heartbeat path của sol (fomo có file riêng trong feed.py) và
KHÔNG nạp watch list từ file/CLI — nguồn DUY NHẤT là GET /api/fomo-users (feed tự
refresh ~300s). Key đọc từ --key/FOMO_API_KEY; thiếu ⇒ exit non-zero, không traceback.
"""

import argparse
import os

from watchers.common import config
from watchers.fomo import feed


def main() -> None:
    ap = argparse.ArgumentParser(
        description="FOMO firehose watcher (1 socket, match watch-list cục bộ)"
    )
    ap.add_argument(
        "--api-url",
        default="http://127.0.0.1:8125",
        help="base URL API instance b (GET /api/fomo-users, POST /api/fomo-watch/trades)",
    )
    ap.add_argument(
        "--key",
        default=os.environ.get("FOMO_API_KEY", ""),
        help="FOMO API key (mặc định đọc env FOMO_API_KEY); key ride query-string socket",
    )
    ap.add_argument(
        "--once",
        action="store_true",
        help="self-check: nối socket, thoát sau alert match đầu hoặc hết ~90s window",
    )
    # Seam test (SUPPRESS — không phải CLI chính thức): trỏ socket vào mock local.
    # Default vẫn là wss production (feed.WS_URL) hoặc env FOMO_WS_URL.
    ap.add_argument(
        "--ws-url",
        default=os.environ.get("FOMO_WS_URL", feed.WS_URL),
        help=argparse.SUPPRESS,
    )
    args = ap.parse_args()

    key = (args.key or "").strip()
    if not key:
        # SystemExit(str) → exit code 1, in message ra stderr, KHÔNG traceback, KHÔNG
        # echo key (đang rỗng). Fail-closed: không key thì không socket.
        raise SystemExit(
            "FOMO_API_KEY chưa set (hoặc --key rỗng) — không nối được socket"
        )

    config._api_url = args.api_url.rstrip("/")
    feed.run_feed(key, ws_url=args.ws_url, once=args.once)
