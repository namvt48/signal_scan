"""CLI của daemon EVM: `python3 -m watchers.evm` — mirror CLI của
`watchers/sol/main.py` (--wallets/--once/--feed/--min-usd/--jsonl/--api-url/
--track) + cờ riêng EVM (--confirmations/--chunk/--poll-sleep). T8/D7.

Wallets: tab Wallet trên UI là nguồn sự thật (T4: server lưu `chain`) — lọc
chain base/bsc; file wallets.txt chỉ là fallback khi API chết (dòng 0x42hex).
State/heartbeat: file RIÊNG (evm_watch_state.json / heartbeat_evm) — patch
module constants CHỈ trong main() để chạy song song daemon Sol không giẫm
nhau; import module này không được đổi path của Sol (test khoá).
"""

import argparse
import os
import sys

from watchers.common import config, emit
from watchers.common import state as st_mod
from watchers.common.config import HERE, _mask
from watchers.evm import classify as cl
from watchers.evm import feed

_wallets_path = ""  # set trong main() — refresh_cfg dùng lại


def load_wallets(path, chains=None):
    """Load API rows for selected chains; legacy file fallback spans selected chains."""
    chains = tuple(chains or cl.DEFAULT_EVM_CHAINS)
    per: dict[str, list[str]] = {c: [] for c in chains}
    try:
        data = config.http_json(f"{config._api_url}/api/wallets", timeout=5)
        if isinstance(data, list):
            for w in data:
                if not isinstance(w, dict):
                    continue
                tags = w.get("tags")
                if isinstance(tags, list) and any(
                    isinstance(tag, str) and tag.strip().casefold() == "status:exclude" for tag in tags
                ):
                    continue
                c, a = w.get("chain"), w.get("address")
                if c in per and isinstance(a, str) and a and a.lower() not in per[c]:
                    per[c].append(a.lower())
            return per, "api"
    except Exception as ex:
        print(f"  ! api wallets: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
    if os.path.exists(path):
        for line in open(path):
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.lower().startswith("0x") and len(s) == 42:
                for c in per:
                    if s.lower() not in per[c]:
                        per[c].append(s.lower())
    return per, "file"


def refresh_cfg(per):
    """Refresh wallet lists/minimum from API without changing selected chains."""
    if not getattr(config, "_evm_ignore_api_min_usd", False):
        v = config._api_min_usd()
        if v is not None:
            config.min_usd = v
    new, src = load_wallets(_wallets_path, per.keys())
    if src == "api":
        for c in per:
            per[c][:] = new[c]


def main() -> None:
    ap = argparse.ArgumentParser(
        description="EVM wallet swap watcher — Base, BSC and Robinhood"
    )
    ap.add_argument("--wallets", default=os.path.join(HERE, "wallets.txt"))
    ap.add_argument(
        "--once",
        action="store_true",
        help="quét 1 vòng backfill rồi ra (ép --feed poll)",
    )
    ap.add_argument(
        "--feed",
        choices=["ws", "poll"],
        default="ws",
        help="ws = eth_subscribe logs/ví (mặc định); poll = eth_getLogs chunked",
    )
    ap.add_argument(
        "--chains",
        default=",".join(cl.DEFAULT_EVM_CHAINS),
        help="comma-separated chain list (default: base,bsc; FOMO: base,bsc,robinhood)",
    )
    ap.add_argument("--min-usd", type=float, default=0.5)
    ap.add_argument(
        "--no-min-usd-gate",
        action="store_true",
        help="FOMO: emit every classified trade regardless of USD size or API setting",
    )
    ap.add_argument(
        "--jsonl",
        default="",
        help="ghi thêm mỗi sự kiện 1 dòng JSON vào file này (log machine-readable)",
    )
    ap.add_argument(
        "--api-url",
        default="http://127.0.0.1:8124",
        help="base URL của alpha-engine API (wallets/settings/trades/tracked-cas)",
    )
    ap.add_argument(
        "--track",
        action="store_true",
        help="tự POST CA của mọi tx BUY vào API để auto-add tracking (mặc định tắt)",
    )
    ap.add_argument(
        "--confirmations",
        type=int,
        default=feed.DEFAULT_CONFIRMATIONS,
        help="số block xác nhận trước khi emit (Base ~2s, BSC ~3s/block)",
    )
    ap.add_argument(
        "--chunk",
        type=int,
        default=feed.DEFAULT_CHUNK,
        help="bề rộng block-range mỗi eth_getLogs (tự halve khi provider chê)",
    )
    ap.add_argument(
        "--poll-sleep",
        type=float,
        default=3.0,
        help="feed poll: nghỉ giữa các vòng quét (giây)",
    )
    args = ap.parse_args()
    chains = tuple(c.strip().lower() for c in args.chains.split(",") if c.strip())
    if not chains or any(c not in cl.EVM_CHAINS for c in chains):
        ap.error(f"--chains must contain supported chains: {', '.join(cl.EVM_CHAINS)}")

    # State/heartbeat file RIÊNG — patch chỉ tại đây (xem docstring module).
    st_mod.STATE_PATH = os.path.join(HERE, "evm_watch_state.json")
    st_mod.HEARTBEAT = os.path.join(HERE, "heartbeat_evm")
    emit._jsonl = args.jsonl
    config._api_url = args.api_url.rstrip("/")
    config._track = args.track
    config._cfg_cli_min_usd = args.min_usd
    config._evm_ignore_api_min_usd = args.no_min_usd_gate
    config.min_usd = 0.0 if args.no_min_usd_gate else args.min_usd
    if not args.no_min_usd_gate:
        v = config._api_min_usd()
        if v is not None:
            config.min_usd = v
            print(f"# min_usd=${v:g} source=api", flush=True)

    _wallets_path = args.wallets
    per, src = load_wallets(args.wallets, chains)
    n = sum(len(v) for v in per.values())
    if not n:
        sys.exit(
            f"không có ví EVM nào (source={src}): {args.wallets} hay {config._api_url}/api/wallets"
        )

    st = st_mod.load_state()
    counts = " ".join(f"{c}={len(per[c])}" for c in chains)
    print(
        f"# evm watch {counts} ví (source={src})"
        f" | feed={args.feed} | conf={args.confirmations} | min ${config.min_usd}",
        flush=True,
    )
    endpoints = " ".join(f"rpc_{c}={_mask(feed.rpc_url(c))}" for c in chains)
    print(f"# {endpoints}", flush=True)
    opts = {
        "conf": args.confirmations,
        "span": args.chunk,
        "once": args.once,
        "sleep": args.poll_sleep,
        "refresh": refresh_cfg,
    }
    try:
        if args.feed == "ws" and not args.once:
            feed.run_ws_feed(per, st, opts)
        else:
            feed.run_poll_feed(per, st, opts)
    except KeyboardInterrupt:
        st_mod.save_state(st)
        print("\n# stopped")


if __name__ == "__main__":
    main()
