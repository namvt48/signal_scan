"""CLI của daemon FOMO: `python3 -m watchers.fomo`.

Đọc swaps qua bridge prod (`server/fomo-prod`) rồi POST vào API instance b.
Không còn WebSocket/API key; watch list vẫn lấy DUY NHẤT từ GET /api/fomo-users.
"""

import argparse
import os

from watchers.common import config
from watchers.fomo import feed


def main() -> None:
    ap = argparse.ArgumentParser(
        description="FOMO swaps poller (bridge prod, watch list từ API)"
    )
    ap.add_argument(
        "--api-url",
        default="http://127.0.0.1:8125",
        help="base URL API instance b (GET /api/fomo-users, POST /api/fomo-watch/trades)",
    )
    ap.add_argument(
        "--prod-url",
        default=os.environ.get("FOMO_PROD_URL", feed.FOMO_PROD_URL),
        help="base URL của FOMO prod bridge (mặc định FOMO_PROD_URL/127.0.0.1:8131)",
    )
    ap.add_argument(
        "--once",
        action="store_true",
        help="self-check: chạy đúng một vòng watch list rồi thoát",
    )
    args = ap.parse_args()

    prod_url = (args.prod_url or "").strip().rstrip("/")
    if not prod_url:
        raise SystemExit("FOMO_PROD_URL chưa set (hoặc --prod-url rỗng) — không poll được")

    config._api_url = args.api_url.rstrip("/")
    feed.FOMO_PROD_URL = prod_url
    feed.run_feed(once=args.once)
