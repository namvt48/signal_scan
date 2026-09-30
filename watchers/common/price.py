"""Nguồn GIÁ duy nhất cho mọi watcher: DexScreener (mặc định) + GMGN (opt-in
QUOTE_SOURCE=gmgn), cache trong process. `get_price_usd(ca, chain)` là seam
chain-aware mà watcher EVM (T8) dùng lại.

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import math
import os
import statistics
import sys
import time

from watchers.common import config
from watchers.common.config import WSOL, quotes_map

# ---------- metadata cache ----------

_info: dict[str, tuple[str, float]] = {}  # mint -> (symbol, price_usd)
_supply: dict[str, float | None] = {}
_sol_px = {"v": 0.0}


def sol_price() -> float:
    if not _sol_px["v"]:
        _sol_px["v"] = token_info(WSOL)[1] or 100.0
    return _sol_px["v"]


# GMGN token/info giờ đi QUA gateway (T16): gateway là single writer — nó giữ
# X-APIKEY và tự thêm timestamp + client_id tươi mỗi call (gateway/gmgn.ts).
# Gate giãn call phía client (từng có ở đây) đã bỏ: rate-limit là việc của
# limiter `gmgn` trong gateway, giữ thêm gate nữa chỉ nhân đôi việc chặn.
GMGN_TOKEN_INFO_PATH = "/v1/gmgn/token-info"


def _use_gmgn() -> bool:
    """Quote USD mặc định là DexScreener (như trước); GMGN chỉ khi env QUOTE_SOURCE=gmgn.
    Nguồn token/info GMGN vẫn dùng cho data chart bên server — không liên quan chỗ này."""
    return (os.environ.get("QUOTE_SOURCE") or "").strip().lower() == "gmgn"


def _gmgn_of(env):
    """(symbol, giá USD) từ envelope `token/info`; (None, 0.0) khi code≠0/thiếu field.
    Pure — unit-test offline được (schema xem server/src/providers/gmgn.ts)."""
    if not isinstance(env, dict) or env.get("code") != 0:
        return None, 0.0
    tok = env.get("data") or {}
    tok = tok.get("token") or tok
    try:
        px = float((tok.get("price") or {}).get("price") or 0.0)
    except (TypeError, ValueError):
        px = 0.0
    sym = tok.get("symbol")
    return (sym if isinstance(sym, str) and sym else None), (px if px > 0 else 0.0)


def gmgn_info(mint, chain="sol"):
    """Giá USD của `mint` qua GATEWAY (route GMGN token/info). Gateway là single
    writer: giữ X-APIKEY + thêm timestamp/client_id tươi mỗi call. None/0.0 khi
    lỗi bất kỳ (transport/401/body sai/code≠0) — caller rơi về DexScreener, không
    bao giờ raise. Rate-limit do limiter `gmgn` của gateway lo, không gate client."""
    try:
        env = config.gateway_json(
            GMGN_TOKEN_INFO_PATH, {"ca": mint, "chain": chain}, timeout=10
        )
    except Exception as ex:  # noqa: BLE001 — mọi lỗi GMGN đều phải rơi về DexScreener
        print(f"  ! gmgn: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)
        return None, 0.0
    return _gmgn_of(env)


_INFO_RETRY_S = 60.0  # TTL retry cho lookup THẤT BẠI (plan §5.3, T2)
_INFO_TTL_S = 3600.0  # giá THÀNH CÔNG cũng hết hạn sau 1h (trước: vĩnh viễn)
_info_miss: dict[str, float] = {}  # mint -> time.time() lần fetch fail cuối
_info_at: dict[str, float] = {}  # mint -> time.time() lần fetch THÀNH CÔNG cuối


def _price_from_pairs(pairs, mint):
    """(symbol, price_usd) của ĐÚNG `mint`, suy từ DexScreener pairs.

    Mỗi pair được quy về giá CỦA CHÍNH `mint`: mint là baseToken ⇒ priceUsd; mint
    là quoteToken ⇒ priceUsd / priceNative. Bản cũ đọc thẳng `pair.priceUsd` kể cả
    khi mint nằm phía QUOTE — mà priceUsd là giá BASE, nên nó cache giá của một
    token KHÁC dưới khoá của mint. Sự cố 2026-09-24: _info[MET] = $1731.82 (giá
    token base của pool, đúng ra MET = $0.3311) ⇒ mọi leg quote-MET phồng ~5230×
    ⇒ dashboard hiện "-$16.298M" cho ví thật lỗ ~$3K.

    Lấy MEDIAN qua các pool (bỏ pool giá 0) thay vì một pool max-liquidity: một
    pool bị thao túng / mis-index không kéo được giá, và kết quả không phụ thuộc
    thứ hạng pool của DexScreener. Pure — unit-test offline được."""
    pxs: list[float] = []
    sym = None
    # EVM CA từ log là lowercase, DexScreener trả checksummed ⇒ phải lower() 2 vế;
    # bỏ đi là mọi giá EVM về 0.0 (Sol base58 nguyên văn nên không đổi hành vi).
    m = mint.lower()
    for p in pairs or []:
        b = p.get("baseToken") or {}
        q = p.get("quoteToken") or {}
        try:
            pu = float(p.get("priceUsd") or 0.0)
            pn = float(p.get("priceNative") or 0.0)
        except (TypeError, ValueError):
            continue
        if (b.get("address") or "").lower() == m:
            px, s = pu, b.get("symbol")
        elif (q.get("address") or "").lower() == m:
            px, s = (pu / pn if (pu > 0 and pn > 0) else 0.0), q.get("symbol")
        else:
            continue
        if px > 0 and math.isfinite(px):
            pxs.append(px)
            if not sym and s:
                sym = s
    if not pxs:
        return sym, 0.0
    return sym, statistics.median(pxs)


def token_info(mint, chain="sol"):
    """(symbol, price_usd) qua DexScreener (mặc định, như trước); GMGN chỉ khi bật
    QUOTE_SOURCE=gmgn. Cache trong process. Lookup THẤT BẠI
    chỉ cache 60s rồi retry; lookup THÀNH CÔNG hết hạn sau _INFO_TTL_S để một giá
    rác không sống tới hết process. Entry seed thẳng vào _info (test) không có mốc
    thời gian ⇒ hit vĩnh viễn, không bao giờ gọi mạng."""
    # Khoá cache chain-aware: cùng một 0x address trên base và bsc là 2 token khác
    # nhau (plan evm-base-bsc §1.3) ⇒ CA EVM khoá "<chain>:<ca>". Sol giữ khoá TRẦN
    # = mint ⇒ hành vi cũ (và seed _info[mint] của test) y nguyên.
    key = mint if chain == "sol" else f"{chain}:{mint}"
    now = time.time()
    if key in _info:
        if key not in _info_at:
            return _info[key]  # seed (test/fixture) — hit vĩnh viễn
        retry_fail = key in _info_miss and now - _info_miss[key] >= _INFO_RETRY_S
        if not retry_fail and now - _info_at[key] < _INFO_TTL_S:
            return _info[key]
    sym, px = None, 0.0
    if _use_gmgn():
        sym, px = gmgn_info(mint, chain)
    if not px:
        try:
            d = config.gateway_json(
                "/v1/dexscreener",
                {"endpoint": "tokens", "params": {"addresses": mint}},
                timeout=15,
            )
            sym, px = _price_from_pairs(d.get("pairs") or [], mint)
        except Exception:
            pass
    if sym:
        _info[key] = (sym, px)
        _info_at[key] = now
        _info_miss.pop(key, None)
    else:
        _info[key] = (mint[:6] + "…", px)
        _info_miss[key] = now
    time.sleep(0.1)
    return _info[key]


def get_price_usd(ca: str, chain: str = "sol") -> float | None:
    """Seam GIÁ chain-aware — nguồn giá DUY NHẤT cho mọi watcher (T8 EVM gọi lại y
    nguyên). DexScreener primary (endpoint chain-blind, nhận CA trần), GMGN khi
    QUOTE_SOURCE=gmgn. None = KHÔNG định giá được (caller hiểu là "chưa biết", không
    phải 0)."""
    return token_info(ca, chain)[1] or None


def _warm_prices(tx) -> None:
    """Warm `_info` cho mọi mint trong tx TRƯỚC detect_swaps.

    `_swap_event` cố ý KHÔNG network — chỉ đọc cache `_info`; mint chưa warm ⇒
    px=0 ⇒ quote_usd=0 ⇒ usd_pending ⇒ `track_post_body` trả None ⇒ CA của token
    ví thật sự mua KHÔNG BAO GIỜ được post. Việc warm này trước 2026-09-16 do
    một tiện ích giá cũ đảm nhiệm; bản detector rewrite per-step làm mất call site.
    WSOL/stablecoin nằm trong `quotes_map` nên vòng lặp dưới BỎ QUA ⇒ riêng giá
    SOL phải warm đường `_sol_px` (nhánh quote WSOL đọc biến này, không đọc
    `_info`). Fail-soft: mint không lấy được giá không được chặn tx."""
    meta = tx.get("meta") or {}
    rows = (meta.get("preTokenBalances") or []) + (meta.get("postTokenBalances") or [])
    for b in rows:
        m = b.get("mint")
        if not m or m in quotes_map or m in _info:
            continue
        try:
            token_info(m)
        except Exception:
            pass
    if not _sol_px["v"]:
        try:
            px = token_info(WSOL)[1]
            if px:
                _sol_px["v"] = px
        except Exception:
            pass
