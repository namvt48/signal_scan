"""Config + transport chung cho mọi watcher (env, RPC endpoints, HTTP JSON-RPC,
quote-mints, ngưỡng min_usd, config refresh từ API).

Tách từ scripts/wallet_watch.py (T7, plan evm-base-bsc) — code dời nguyên văn,
không đổi logic. `HERE` = thư mục dữ liệu (wallets.txt / state / heartbeat):
repo ⇒ <repo>/scripts (như cũ), deploy ⇒ thư mục chứa package `watchers/`.
"""

import http.client
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import timedelta, timezone

# Thư mục DỮ LIỆU (wallets.txt / quotes.txt / wallet_watch_state.json / heartbeat).
# Trước T7 = dirname(scripts/wallet_watch.py); file này giờ nằm trong package ⇒ đi
# ngược tới thư mục CHỨA `watchers/`, rồi ưu tiên <gốc>/scripts (layout repo — đúng
# giá trị cũ), fallback <gốc> (deploy phẳng /opt/wallet-watch — cũng đúng giá trị cũ).
# WATCH_HOME override. Sai HERE ⇒ daemon đọc/ghi state sai chỗ, KHÔNG crash.
_root = os.path.dirname(os.path.abspath(__file__))
while not os.path.isdir(os.path.join(_root, "watchers")) and _root != os.path.dirname(
    _root
):
    _root = os.path.dirname(_root)
HERE = os.environ.get("WATCH_HOME") or (
    os.path.join(_root, "scripts")
    if os.path.isdir(os.path.join(_root, "scripts"))
    else _root
)
ICT = timezone(timedelta(hours=7))


RPC_DEFAULTS = [
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
]
RPCS = list(RPC_DEFAULTS)  # effective list: override first, defaults as fallback
_rpc_rr = 0  # round-robin index: trải traffic qua MỌI key thay vì dồn vào RPCS[0]


def _mask(url: str) -> str:
    """Che api-key khỏi log — banner khởi động không được in secret ra journal."""
    return f"{url.split('api-key=')[0]}api-key=***" if "api-key=" in url else url


WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
DEFAULT_QUOTES = {  # R1 — Solana hardcode
    WSOL: "SOL",
    USDC: "USDC",
    USDT: "USDT",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
    "9gP2kCy3wA1ctvYWQk75guqXuHfrEomqydHLtcTCqiLa": "WBNB",
}

quotes_map = dict(DEFAULT_QUOTES)  # main() nạp thêm từ quotes.txt
min_usd = 0.5  # --min-usd: sự kiện có |P| và |value| đều dưới ngưỡng → bỏ
_api_url = "http://127.0.0.1:8124"  # --api-url: base URL của alpha-engine API
_track = False  # --track: auto-POST CA của tx BUY/SELL vào API (mặc định OFF)
_cfg_cli_min_usd: float = (
    min_usd  # giá trị --min-usd: fallback khi API settings chết/lỗi
)
_cfg_next = 0.0  # time.time() tới hạn refresh config từ API kế tiếp (0 = chưa nạp)
_CFG_REFRESH_S = 300.0  # ~5 phút: đổi config trên UI có hiệu lực không cần restart


# ---------- http/rpc ----------


def http_json(url, payload=None, timeout=20, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    hdrs = {"User-Agent": "wallet-watch/1.0", "Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ---------- config từ API (fail-soft: API chết ⇒ giữ nguồn CLI/file) ----------


def _api_min_usd():
    """GET {api}/api/settings → values.minUsd dạng float hữu hạn > 0; None nếu
    lỗi bất kỳ (mạng/HTTP non-2xx/thiếu key/sai kiểu/không hữu hạn) — caller giữ
    giá trị CLI/default. Không bao giờ raise."""
    try:
        data = http_json(f"{_api_url}/api/settings", timeout=5)
        v = (data.get("values") or {}).get("minUsd")
        if (
            isinstance(v, (int, float))
            and not isinstance(v, bool)
            and math.isfinite(v)
            and v > 0
        ):
            return float(v)
    except Exception as ex:  # URLError/HTTPError/AttributeError (response sai shape)…
        print(f"  ! api settings: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
    return None


def _api_wallets():
    """GET {api}/api/wallets → list địa chỉ `address` (str không rỗng) của từng
    item. TAB WALLET LÀ NGUỒN DUY NHẤT nên [] là câu trả lời HỢP LỆ (tab rỗng =
    không ví nào để watch) — None CHỈ khi lỗi mạng/body sai shape, để caller giữ
    list hiện tại thay vì xoá ví vì một lần timeout. Không bao giờ raise."""
    try:
        data = http_json(f"{_api_url}/api/wallets", timeout=5)
        if isinstance(data, list):
            return [
                w["address"]
                for w in data
                if isinstance(w, dict)
                and isinstance(w.get("address"), str)
                and w["address"]
            ]
    except Exception as ex:
        print(f"  ! api wallets: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
    return None


def load_config_from_api(wallets):
    """Nạp min_usd + wallets từ API: tab Wallet là NGUỒN DUY NHẤT của list ví —
    list rỗng là giá trị HỢP LỆ (tab rỗng ⇒ bỏ hết ví), chỉ lỗi/sai shape mới
    giữ list hiện tại (fail-soft, không bao giờ raise — API chết
    không được chặn scanner). `wallets` mutate IN-PLACE (slice) để cả 3 feed
    block/ws/poll (đều giữ reference của list này) thấy list mới không cần rewire.
    main() gọi 1 lần lúc startup; _handle_tx gọi lại mỗi ~_CFG_REFRESH_S.
    Log đúng 1 dòng/nguồn khi startup hoặc khi giá trị đổi."""
    global min_usd, _cfg_next
    first = _cfg_next == 0.0

    v = _api_min_usd()
    new_min = v if v is not None else _cfg_cli_min_usd
    if first or new_min != min_usd:
        src = "api" if v is not None else "cli/default"
        print(f"# min_usd=${new_min:g} source={src}", flush=True)
    min_usd = new_min

    aw = _api_wallets()
    if aw is None:  # API lỗi/sai shape ⇒ giữ list hiện tại (timeout không xoá ví)
        if first:
            print(f"# wallets={len(wallets)} source=file/CLI", flush=True)
    else:  # tab wallet là nguồn duy nhất — [] nghĩa là tab rỗng ⇒ bỏ hết ví
        if first or aw != wallets:
            print(f"# wallets={len(aw)} source=api", flush=True)
        wallets[:] = aw
    _cfg_next = time.time() + _CFG_REFRESH_S


_rpc_calls: Counter[str] = Counter()
_rpc_errs: Counter[str] = Counter()
_rpc_prev: Counter[str] = Counter()
_rpc_errs_prev: Counter[str] = Counter()
_rpc_next_log = 0.0


def _rpc_meter(method: str, err: bool = False) -> None:
    """Đếm call RPC theo method, log số/60s (đo mức giảm call trước/sau tối ưu)."""
    global _rpc_next_log
    _rpc_calls[method] += 1
    if err:
        _rpc_errs[method] += 1
    now = time.time()
    if now < _rpc_next_log:
        return
    _rpc_next_log = now + 60.0
    delta = _rpc_calls - _rpc_prev
    edelta = _rpc_errs - _rpc_errs_prev
    parts = " ".join(f"{m}={n}" for m, n in delta.most_common())
    errs = f" err={dict(edelta)}" if edelta else ""
    print(f"# rpc/60s total={sum(delta.values())} {parts}{errs}", flush=True)
    _rpc_prev.clear()
    _rpc_prev.update(_rpc_calls)
    _rpc_errs_prev.clear()
    _rpc_errs_prev.update(_rpc_errs)


def rpc(method, params):
    global _rpc_rr
    # Round-robin trên các endpoint CHÍNH (bỏ defaults) rồi mới tới defaults làm
    # fallback cuối — trước đây luôn thử RPCS[0] trước nên 5/6 key Helius nằm không.
    prim = [u for u in RPCS if u not in RPC_DEFAULTS] or RPCS
    start = _rpc_rr % len(prim)
    _rpc_rr += 1
    order = prim[start:] + prim[:start] + [d for d in RPC_DEFAULTS if d not in prim]
    last = RuntimeError("no endpoint tried")
    for ep in order:
        try:
            out = http_json(
                ep, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
            )
            if "error" in out:
                raise RuntimeError(str(out["error"].get("message")))
            _rpc_meter(method)
            return out["result"]
        except (
            urllib.error.URLError,
            urllib.error.HTTPError,
            RuntimeError,
            TimeoutError,
            OSError,
            # body đứt quãng (publicnode/Cloudflare cụt getBlock lớn) và body dị
            # dạng (proxy trả HTML) là lỗi TRANSPORT — thử endpoint kế, không bay
            # thẳng ra giết daemon.
            http.client.HTTPException,
            json.JSONDecodeError,
        ) as e:
            last = e
            _rpc_meter(method, err=True)
            time.sleep(0.7)
    raise RuntimeError(f"RPC fail {method}: {last}")
