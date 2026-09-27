"""CLI của daemon Solana: `python3 -m watchers.sol` (hoặc shim
`python3 scripts/wallet_watch.py`).

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import argparse
import os
import sys

from watchers.common import config, emit
from watchers.common.config import (
    HERE,
    RPC_DEFAULTS,
    _mask,
    load_config_from_api,
    quotes_map,
)
from watchers.common.price import sol_price
from watchers.common.state import load_state, save_state
from watchers.sol.feed import run_block_feed, run_ws_feed

# ---------- loop ----------


def load_lines(path):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path):
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Solana wallet swap-step watcher (GMGN row parity)"
    )
    ap.add_argument("--wallets", default=os.path.join(HERE, "wallets.txt"))
    ap.add_argument("--quotes", default=os.path.join(HERE, "quotes.txt"))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--min-usd", type=float, default=0.5)
    ap.add_argument(
        "--jsonl",
        default="",
        help="ghi thêm mỗi sự kiện 1 dòng JSON vào file này (log machine-readable)",
    )
    ap.add_argument(
        "--api-url",
        default="http://127.0.0.1:8124",
        help="base URL của alpha-engine API (dùng cho --track)",
    )
    ap.add_argument(
        "--track",
        action="store_true",
        help="tự POST CA của mọi tx BUY/SELL vào API để auto-add tracking (mặc định tắt)",
    )
    ap.add_argument(
        "--block-sleep",
        type=float,
        default=0.4,
        help="feed block: nghỉ giữa các slot khi đã ở tip (giây)",
    )
    ap.add_argument(
        "--feed",
        choices=["ws", "block"],
        default="ws",
        help="ws = logsSubscribe/ví (mặc định); block = quét getBlock tuần tự",
    )
    ap.add_argument(
        "--rpc-url",
        default="",
        help="endpoint RPC HTTP; mặc định đọc env SOLANA_RPC_URL → RPC_HTTP → list có sẵn",
    )
    args = ap.parse_args()

    rpc_url = (
        args.rpc_url
        or os.environ.get("SOLANA_RPC_URL")
        or os.environ.get("RPC_HTTP")
        or ""
    )
    # override đứng đầu (env có thể là LIST endpoint phẩy phân cách), defaults làm fallback
    if rpc_url:
        config.RPCS[:] = [u.strip() for u in rpc_url.split(",") if u.strip()] + list(
            RPC_DEFAULTS
        )

    wallets = load_lines(args.wallets)  # seed = nguồn file/CLI (fallback khi API chết)
    for line in load_lines(args.quotes):
        mn, _, sym = line.partition("=")
        if mn.strip():
            quotes_map[mn.strip()] = sym.strip() or mn.strip()[:6]
    emit._jsonl = args.jsonl
    config._api_url = args.api_url.rstrip("/")
    config._track = args.track
    config._cfg_cli_min_usd = args.min_usd
    load_config_from_api(wallets)  # API hợp lệ override min_usd + wallets; fail-soft
    if not wallets:
        sys.exit(f"không có ví nào trong {args.wallets} hay {config._api_url}/api/wallets")

    st = load_state()
    print(
        f"# watch {len(wallets)} ví | feed={args.feed} | {len(quotes_map)} quote-mints | min ${config.min_usd}"
    )
    print(f"# rpc {_mask(config.RPCS[0])}")
    # T7: warm _sol_px đúng 1 lần lúc khởi động (classify(), caller cũ, đã bị
    # T4 xoá) — price-provider fail không được abort startup.
    try:
        sol_price()
    except Exception:
        pass
    try:
        if args.feed == "ws":
            run_ws_feed(wallets, st)
        else:
            run_block_feed(wallets, st, {"sleep": args.block_sleep, "once": args.once})
    except KeyboardInterrupt:
        save_state(st)
        print("\n# stopped")
