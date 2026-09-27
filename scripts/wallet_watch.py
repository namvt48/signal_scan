#!/usr/bin/env python3
"""Theo dõi realtime ví Solana — phát hiện từng BƯỚC SWAP (BUY/SELL) của ví.

Cách chạy:
  python3 scripts/wallet_watch.py                 # feed=block: getBlock mỗi slot confirmed, quét mọi tx
  python3 scripts/wallet_watch.py --once          # 1 slot rồi thoát (test)
  python3 scripts/wallet_watch.py --wallets khac.txt
  python3 scripts/wallet_watch.py --track                 # POST CA của tx BUY/SELL sang API
  python3 scripts/wallet_watch.py --track --api-url http://127.0.0.1:8124

Config:
  scripts/wallets.txt — SEED ví (`#` = comment). Nguồn THẬT của list ví là tab
                        Wallet qua `GET {api}/api/wallets` (đồng bộ mỗi ~5 phút);
                        file chỉ còn là fallback khi API chết lúc bootstrap.
  scripts/quotes.txt  — bổ sung mint coi như TIỀN (dạng `MINT=TICKER`), ngoài set mặc định

Detector (`detect_swaps`, spec §3 plan gmgn-parity-fixes, đã verify 29/29 row GMGN):
  1 tx → 1 event cho MỖI bước swap qua 1 pool (parity row GMGN), không phải net
  theo ví. Side theo hướng endpoint POOL của leg base (pool gửi base ra = BUY).
  Base/quote theo rank-BFS trên tier quote (TIER_A/TIER_B) của đồ thị cặp-mint
  trong tx; major↔major = route conversion, không emit. Amount = gross leg từ
  parsed SPL transfer (LP fee không tồn tại trong payload RPC) ⇒
  amount_basis="gross_leg" là HẰNG SỐ trên mọi event. type luôn "SWAP" — model
  route-level cũ (nhãn transfer-in/out, neutral theo net-delta) đã bị loại bỏ.
  Detector không network — chỉ đọc cache _info/_sol_px.

HTTP dùng stdlib, KHÔNG cần websockets. Feed block `getBlock` từng slot confirmed
rồi quét mọi tx trong block để tìm tx của ví — forward-only, không query lịch sử per-ví.
"""

import argparse
import gzip
import http.client
import json
import math
import os
import shutil
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

HERE = os.path.dirname(os.path.abspath(__file__))
ICT = timezone(timedelta(hours=7))
# Liveness beacon cho watchdog.sh: block feed touch mỗi block kể cả khi không có
# trade (feed chết ⇒ mtime đứng ⇒ watchdog restart sau 300s).
HEARTBEAT = os.path.join(HERE, "heartbeat")


def _beat() -> None:
    """Touch beacon cho watchdog.sh."""
    try:
        open(HEARTBEAT, "w").close()
    except OSError:
        pass


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
_jsonl = ""  # --jsonl PATH: ghi thêm mỗi sự kiện 1 dòng JSON (log machine-readable)
_api_url = "http://127.0.0.1:8124"  # --api-url: base URL của alpha-engine API
_track = False  # --track: auto-POST CA của tx BUY/SELL vào API (mặc định OFF)
_posted_mints: set[str] = set()  # CA đã POST trong run này (dedup phía client)
# (sig, wallet, mint, side, step) đã emit — cùng tx có thể tới 2 lần (ws + poll,
# hoặc 2 run khi watermark lùi); ponytail: set không cap trong 1 run, LRU nếu chật.
_emitted: set[tuple[str, str, str | None, str | None, int | None]] = set()
_cfg_cli_min_usd: float = (
    min_usd  # giá trị --min-usd: fallback khi API settings chết/lỗi
)
_cfg_next = 0.0  # time.time() tới hạn refresh config từ API kế tiếp (0 = chưa nạp)
_CFG_REFRESH_S = 300.0  # ~5 phút: đổi config trên UI có hiệu lực không cần restart


def jl_write(e) -> None:
    if not _jsonl:
        return
    jl_rotate()
    with open(_jsonl, "a") as f:
        f.write(json.dumps(e, ensure_ascii=False, default=str) + "\n")


def jl_rotate() -> None:
    """Rotate `--jsonl` theo NGÀY UTC: file cũ → `<path>-YYYYMMDD.jsonl.gz` rồi truncate.

    Tên file live giữ nguyên `events.jsonl` (ruleA_real_regress.py đọc thẳng path đó).
    Ngày suy từ mtime ⇒ sống qua restart, không cần state. ponytail: nén inline lúc ghi
    dòng ĐẦU TIÊN của ngày mới — 1 lần/ngày, chặn vài trăm ms với file ~50MB; nếu file
    lớn hơn nhiều thì chuyển sang nén ở thread riêng.
    """
    try:
        if os.path.getsize(_jsonl) == 0:
            return
        fday = time.strftime("%Y%m%d", time.gmtime(os.path.getmtime(_jsonl)))
    except OSError:
        return  # chưa có file ⇒ không có gì để rotate
    if fday >= time.strftime("%Y%m%d", time.gmtime()):
        return
    arch = f"{os.path.splitext(_jsonl)[0]}-{fday}.jsonl.gz"
    tmp = arch + ".tmp"
    with open(_jsonl, "rb") as src, gzip.open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst)
    os.replace(tmp, arch)  # nén xong mới chạm file gốc ⇒ crash giữa chừng không mất row
    open(_jsonl, "w").close()


def track_post_body(e) -> dict[str, Any] | None:
    """Body POST {api_url}/api/tracked-cas cho sự kiện trade, None nếu không đáng
    post: type KHÔNG phải SWAP (RECEIVE/airdrop/claim chỉ log), side KHÔNG phải
    BUY (sell chỉ log), hoặc mint rỗng.
    `usd` CHỈ có khi biết giá; thiếu giá ⇒ bỏ hẳn key (server lưu entry_usd
    NULL và tự quyết theo ngưỡng $50 của nó — fail-open khi NULL: chốt Q1
    2026-09-21, detector KHÔNG được tự bỏ trade thật vì không định giá được).
    Pure — chỉ đọc event, không chạm mạng -> unit-test được offline."""
    side, mint = e.get("side"), e.get("mint")
    if e.get("type") != "SWAP" or side != "BUY" or not (isinstance(mint, str) and mint):
        return None
    body: dict[str, Any] = {
        "address": mint,
        "chain": "sol",
        "note": f"auto:{side} by {e.get('wallet', '')} {e.get('sig', '')}",
    }
    usd = e.get("quote_usd")
    if (
        isinstance(usd, (int, float))
        and not isinstance(usd, bool)
        and math.isfinite(usd)
        and usd > 0
    ):
        body["usd"] = float(usd)
    return body


def track_event(e) -> None:
    """--track: POST CA của sự kiện trade vào API. Fail-soft — 200/201/409 = ok
    (409 = đã tracked), 400/lỗi mạng chỉ log stderr; không bao giờ raise để loop
    watch không chết. Dedup theo mint trong run để đỡ tải server."""
    if not _track:
        return
    body = track_post_body(e)
    if not body or body["address"] in _posted_mints:
        return
    try:
        req = urllib.request.Request(
            f"{_api_url}/api/tracked-cas",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except urllib.error.HTTPError as ex:
        if ex.code not in (201, 409):
            print(f"  ! track {body['address'][:8]}…: HTTP {ex.code}", file=sys.stderr)
            return
    except Exception as ex:
        print(
            f"  ! track {body['address'][:8]}…: {type(ex).__name__}: {str(ex)[:60]}",
            file=sys.stderr,
        )
        return
    _posted_mints.add(body["address"])


def watch_trade_body(e, block_time=None) -> dict[str, Any] | None:
    """Body POST {api_url}/api/wallet-watch/trades — nguồn của cột `Tracked by`
    (user 2026-09-21), tách khỏi track_post_body (chỉ xếp CA vào queue).
    Nhận CẢ buy thiếu giá (khác track_post_body): tx on-chain là đủ chứng minh ví
    đã mua, `Tracked by` không đọc amount_usd. None khi thiếu khoá định danh
    (wallet/mint/sig) hoặc side không phải BUY/SELL. SELL cũng được POST
    (user 2026-09-23): server dùng nó để đọc lại balance ⇒ trackedHolding tươi
    ngay, còn cột Tracked Inflow vẫn chỉ tính buy.
    block_time = tx['blockTime'] (giây, UTC) ⇒ ts epoch ms; None ⇒ time.time().
    Pure — không chạm mạng, unit-test offline."""
    if e.get("side") not in ("BUY", "SELL"):
        return None
    mint, wallet, sig = e.get("mint"), e.get("wallet"), e.get("sig")
    if not (
        isinstance(mint, str)
        and mint
        and isinstance(wallet, str)
        and wallet
        and isinstance(sig, str)
        and sig
    ):
        return None

    def num(v) -> float:
        return (
            float(v)
            if isinstance(v, (int, float))
            and not isinstance(v, bool)
            and math.isfinite(v)
            else 0.0
        )

    usd, qty = num(e.get("quote_usd")), num(e.get("qty"))
    return {
        "wallet": wallet,
        "chain": "sol",
        "ca": mint,
        "tx": sig,
        "ts": int((block_time if block_time is not None else time.time()) * 1000),
        "amountUsd": usd,
        "price": usd / qty if usd > 0 and qty > 0 else 0.0,
        "side": "sell" if e.get("side") == "SELL" else "buy",
    }


def watch_trade_event(e, block_time=None) -> None:
    """--track: POST 1 trade BUY cho cột `Tracked by`. Fail-soft y track_event —
    2xx = ok (repost = 200 inserted 0 nhờ UNIQUE(wallet, ca, tx, side)), lỗi
    mạng/HTTP chỉ log stderr, không bao giờ raise để loop watch không chết."""
    if not _track:
        return
    body = watch_trade_body(e, block_time)
    if not body:
        return
    try:
        req = urllib.request.Request(
            f"{_api_url}/api/wallet-watch/trades",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception as ex:
        print(
            f"  ! watch-trade {body['ca'][:8]}…: {type(ex).__name__}: {str(ex)[:60]}",
            file=sys.stderr,
        )


def dbase(mint, decimals):
    return decimals.get(mint, 9 if mint == WSOL else 6)


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


# ---------- metadata cache ----------

_info: dict[str, tuple[str, float]] = {}  # mint -> (symbol, price_usd)
_supply: dict[str, float | None] = {}
_sol_px = {"v": 0.0}


def sol_price() -> float:
    if not _sol_px["v"]:
        _sol_px["v"] = token_info(WSOL)[1] or 100.0
    return _sol_px["v"]


GMGN_TOKEN_INFO = "https://openapi.gmgn.ai/v1/token/info"
# GMGN ban theo CỤM call trên IP, không theo giây: 5 call cách nhau <2s từ chính VPS
# này ⇒ RATE_LIMIT_BANNED (draft gmgn-parity-fixes F17). Nên giãn ≥5s/call và lỗi
# nào cũng nghỉ hẳn BAN_S trước khi thử lại; trong lúc nghỉ DexScreener gánh.
_GMGN_GAP_S = 5.0
_GMGN_BAN_S = 300.0
_gmgn_next_ok = 0.0


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


def gmgn_info(mint):
    """Giá USD của `mint` qua GMGN OpenAPI (header X-APIKEY, timestamp + client_id).
    None/0.0 khi thiếu key, đang nghỉ sau lỗi, hoặc đã gọi trong `_GMGN_GAP_S` vừa
    qua — caller rơi về DexScreener (không bao giờ raise)."""
    global _gmgn_next_ok
    key = os.environ.get("GMGN_API_KEY") or ""
    now = time.time()
    if not key or now < _gmgn_next_ok:
        return None, 0.0
    _gmgn_next_ok = now + _GMGN_GAP_S
    url = (
        f"{GMGN_TOKEN_INFO}?chain=sol&address={mint}"
        f"&timestamp={int(now)}&client_id={uuid.uuid4()}"
    )
    try:
        sym, px = _gmgn_of(http_json(url, timeout=10, headers={"X-APIKEY": key}))
    except Exception as ex:  # noqa: BLE001 — mọi lỗi GMGN đều phải rơi về DexScreener
        _gmgn_next_ok = time.time() + _GMGN_BAN_S
        print(
            f"  ! gmgn: {type(ex).__name__}: {str(ex)[:60]} (nghỉ {int(_GMGN_BAN_S)}s)",
            file=sys.stderr,
        )
        return None, 0.0
    if not px:
        _gmgn_next_ok = time.time() + _GMGN_BAN_S
    return sym, px


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
    for p in pairs or []:
        b = p.get("baseToken") or {}
        q = p.get("quoteToken") or {}
        try:
            pu = float(p.get("priceUsd") or 0.0)
            pn = float(p.get("priceNative") or 0.0)
        except (TypeError, ValueError):
            continue
        if b.get("address") == mint:
            px, s = pu, b.get("symbol")
        elif q.get("address") == mint:
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


def token_info(mint):
    """(symbol, price_usd) qua DexScreener (mặc định, như trước); GMGN chỉ khi bật
    QUOTE_SOURCE=gmgn. Cache trong process. Lookup THẤT BẠI
    chỉ cache 60s rồi retry; lookup THÀNH CÔNG hết hạn sau _INFO_TTL_S để một giá
    rác không sống tới hết process. Entry seed thẳng vào _info (test) không có mốc
    thời gian ⇒ hit vĩnh viễn, không bao giờ gọi mạng."""
    now = time.time()
    if mint in _info:
        if mint not in _info_at:
            return _info[mint]  # seed (test/fixture) — hit vĩnh viễn
        retry_fail = mint in _info_miss and now - _info_miss[mint] >= _INFO_RETRY_S
        if not retry_fail and now - _info_at[mint] < _INFO_TTL_S:
            return _info[mint]
    sym, px = None, 0.0
    if _use_gmgn():
        sym, px = gmgn_info(mint)
    if not px:
        try:
            d = http_json(
                f"https://api.dexscreener.com/latest/dex/tokens/{mint}", timeout=15
            )
            sym, px = _price_from_pairs(d.get("pairs") or [], mint)
        except Exception:
            pass
    if sym:
        _info[mint] = (sym, px)
        _info_at[mint] = now
        _info_miss.pop(mint, None)
    else:
        _info[mint] = (mint[:6] + "…", px)
        _info_miss[mint] = now
    time.sleep(0.1)
    return _info[mint]


def _amt(t):
    """Amount thô + decimals của một balance entry (jsonParsed); chịu cả schema
    chỉ có uiTokenAmount (publicnode) lẫn tokenAmount chuẩn."""
    a = t.get("tokenAmount") or t.get("uiTokenAmount") or {}
    s = str(a.get("amount") or a.get("uiAmountString") or "0")
    dec = a.get("decimals", 0)
    if "." not in s:
        return int(s), dec
    ip, fp = s.split(".")
    return int(ip + (fp + "0" * dec)[:dec]), dec


# ---------- swap/DEX program registry (detect_swaps — plan §3 Bước 2) ----------
#
# detect_swaps lọc enclosing-program theo DENYLIST (_PLUMBING ∪ _TOKEN_PROGS ∪
# _AGGREGATORS) nên DEX lạ tự lọt — registry dưới đây không phải điều kiện chạy,
# giữ làm tài liệu program-id → tên người đọc và là nguồn của _AGGREGATORS.
# Tại sao đọc leg transfer thay vì decode instruction DEX: getTransaction
# jsonParsed trả payload base58 thô cho mọi program DEX (pump.fun, Jupiter v6,
# Raydium, Orca, Meteora, DFlow là anchor/BPF, RPC không ship IDL) ⇒ tín hiệu
# schema-stable duy nhất là các instruction spl-token transfer đã parse mà
# chúng phát ra. Registry/decimals/quyết định đều ở module-level nên stream
# live không phải suy lại per event; detect_swaps không gọi network (chỉ đọc
# cache _info/_sol_px).

# program id -> human name (tài liệu; xem denylist mới là điều kiện lọc).
_SWAP_PROGRAMS = {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "pump.fun AMM",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CPMM",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
    "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH": "DFlow Aggregator v4",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM (v2)",
}
# §4.1 phantom: pump.fun router dùng luôn ATA của user làm trạm trung chuyển nên
# leg base khớp ra pool dù ví KHÔNG nhúc nhích mint đó (EVIDENCE §3). Scope pump là
# fit n=2 trên oracle — rule ngữ nghĩa đầy đủ chỉ là `wflat`, mở scope khi có oracle.
_PUMP_ROUTE = frozenset(
    {
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    }
)
# base/quote rank seeds for the mint-graph BFS (plan §2.4).  rank 0.0 = TIER_A
# (global quote currencies), rank 0.5 = TIER_B (WBTC).  A BTC-peg mint
# (WBTC/cbBTC/XBT) must NEVER appear in TIER_A.  Addresses are derived from
# scripts/fixtures/gmgn_rows_fixture.json (quote_token.token_address) — the two
# mainnet-only entries are marked, everything else comes from the 29 rows.
TIER_A = {
    WSOL,  # So11111111111111111111111111111111111111112 — fixture row 9 quote_token.token_address
    USDC,  # EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v — fixture row 1 quote_token.token_address
    USDT,  # Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB — mainnet constant, NOT in the 29-row fixture
    "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o",  # DAI — mainnet constant, NOT in the 29-row fixture
}
TIER_B = {
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",  # WBTC — fixture row 22 quote_token.token_address
    # add wETH-Wormhole 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs when a route uses it
}
# router aggregators — the named Jupiter/DFlow entries in _SWAP_PROGRAMS above.
# Excluded from the enclosing-program denylist so the real DEX underneath wins.
_AGGREGATORS = {
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  # _SWAP_PROGRAMS: Jupiter v6
    "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",  # _SWAP_PROGRAMS: DFlow Aggregator v4
}
# instruction plumbing — never a swap program
_PLUMBING = {
    "11111111111111111111111111111111",
    "ComputeBudget111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
}
# token program ids — chương trình DUY NHẤT có parsed transfer được nhận làm leg
_TOKEN_PROGS = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}
# parsed spl-token transfer types được nhận làm swap leg
_XFER_TYPES = (
    "transfer",
    "transferChecked",
    "transferCheckedWithFee",
    "transferWithFee",
)


def _keys(msg, meta) -> list[str]:
    ks = [ak["pubkey"] for ak in msg.get("accountKeys") or []]
    la = (meta or {}).get("loadedAddresses") or {}  # v0/ALT
    ks += (la.get("writable") or []) + (la.get("readonly") or [])
    return ks


def _sym(mint) -> str:
    """Cache-only ticker (no network): quotes_map -> _info -> short mint."""
    if not mint:
        return ""
    ti = _info.get(mint)
    return quotes_map.get(mint) or (ti[0] if ti else None) or (mint[:6] + "…")


# ---------- per-step swap detector (GMGN row parity — plan §3 Bước 1-5) ----------
#
# detect_swaps(): 1 event = 1 bước swap qua 1 pool (đúng semantics 1 row GMGN,
# §2.1). Nguồn sự thật DUY NHẤT: parsed SPL transfer legs + pre/postTokenBalances.
# Đã thử và LOẠI (đừng thử lại): Jupiter logMessages/SwapEvent (chỉ 2/9 tx;
# 58pWphuG có 5 SwapEvent vs 4 row oracle) và `Program data:` base64 (không chứa
# net/fee). Amount = GROSS leg: LP fee KHÔNG tồn tại trong payload getTransaction
# (§2.2) ⇒ amount_basis="gross_leg" là HẰNG SỐ trên mọi event, cấm suy per-row từ
# delta balance hay field GMGN (MB1). Không network — chỉ đọc cache _info/_sol_px.


def _frames(msg, meta):
    """Yield (top_ix, seq, height, ix, stack) cho MỌI instruction instance theo
    thứ tự thực thi. stack = [(programId, invocation_seq)] của các frame bao
    ngoài, RESET ở mỗi top-level ix (bug cũ: không reset ⇒ leg của ix này bị gán
    frame của ix trước). seq = ordinal lời gọi toàn tx (tie-break |seq_base −
    seq_quote| Bước 3). Frame cha = stack[-2]; thiếu stackHeight ⇒ giả định con
    kế tiếp (fixture/RPC thật luôn có stackHeight)."""
    groups = {}
    for g in meta.get("innerInstructions") or []:
        groups.setdefault(g.get("index"), []).extend(g.get("instructions") or [])
    seq = 0
    for ti, top in enumerate(msg.get("instructions") or []):
        stack = []
        for cur in [top, *(groups.get(ti) or [])]:
            h = cur.get("stackHeight") or len(stack) + 1
            del stack[h - 1 :]
            stack.append((cur.get("programId"), seq))
            yield ti, seq, h, cur, stack[:]
            seq += 1


def _bal_tables(meta, keys):
    """owner/pre/post per token-account + decimals, mint per token-account,
    decimals per-mint từ pre/postTokenBalances — pair theo accountIndex, KHÔNG
    zip vị trí (hai list lệch nhau khi account mở/đóng giữa tx, F32)."""
    own, pre_a, post_a, dec_of, mint_of = {}, {}, {}, {}, {}
    for store, which in ((pre_a, "preTokenBalances"), (post_a, "postTokenBalances")):
        for t in meta.get(which) or []:
            i = t.get("accountIndex")
            if isinstance(i, int) and 0 <= i < len(keys):
                a = keys[i]
                own[a] = t.get("owner") or own.get(a)
                store[a] = _amt(t)[0]
                mint_of[a] = t.get("mint")
            if t.get("mint") is not None:
                dec_of.setdefault(t["mint"], _amt(t)[1])
    return own, pre_a, post_a, dec_of, mint_of


_FEE_REJECT_REASONS = frozenset({"aggregator_frame", "plumbing", "no_pool_endpoint"})


def _fee_candidate(
    src, dst, mint, raw, dec, frame, seq, reason, rs, rd, stack, parent, ix, own
):
    """Snapshot leg đã bị reject để `detect_swaps` xét fee-leg Option A SAU KHI có
    paired steps. Đây là side-channel, không đổi quyết định reject. `program` lấy
    aggregator gần nhất khi bị aggregator_frame, ngược lại program cha — không dùng
    `encl` vì leg reject có thể không có enclosing DEX hợp lệ."""
    if reason == "aggregator_frame":
        program = next((q for q, _s in reversed(stack) if q in _AGGREGATORS), None)
    else:
        program = parent[0] or ix.get("programId")
    return {
        "mint": mint,
        "src": src,
        "dst": dst,
        "dst_owner": own.get(dst),
        "raw": raw,
        "dec": dec,
        "frame": frame,
        "seq": seq,
        "reason": reason,
        "rs": rs,
        "rd": rd,
        "program": program,
        "prog_stack": [q for q, _s in stack],
    }


def _legs_with_roles(tx, wallet, trace=None, rejected=None, anchored=None):
    """Bước 1+2 + roles Bước 3. Leg = parsed SPL transfer dưới token program,
    frame_id = instance-path (top_i, height, parent_program, invocation_seq) —
    KHÔNG phải program-id trần (3BbWVS3K gọi cùng program 3× cho 3 pool ⇒ gộp
    theo id sẽ merge 3 step thành 1, bug F9). enclosing_program = program gần
    nhất trên stack ∉ _PLUMBING ∪ token ∪ _AGGREGATORS (reject-by-denylist: DEX
    lạ tự lọt; fee leg do aggregator CPI ⇒ encl=aggregator ⇒ loại). Role endpoint
    thuần bằng balance: WALLET > RELAY (vắng hoặc Δ=0) > POOL. Mỗi leg/instruction
    bị loại ⇒ trace `REJECT <frame> <mint> <reason>`."""
    meta = tx.get("meta") or {}
    msg = tx["transaction"]["message"]
    keys = _keys(msg, meta)  # giữ ALT merge cho tx v0 thật; fixture: 0 ALT
    own, pre_a, post_a, dec_of, mint_of = _bal_tables(meta, keys)

    def role(a):
        if a is not None and own.get(a) == wallet:
            return "WALLET"
        if a not in pre_a and a not in post_a:
            return "RELAY"
        return "POOL" if post_a.get(a, 0) - pre_a.get(a, 0) != 0 else "RELAY"

    def wflat(a):
        """Tài khoản ví đang GIỮ mint này suốt tx: có row cả pre lẫn post, giá trị
        bằng nhau và ≠ 0. pre==post==0 hoặc vắng row = trạm trung chuyển rỗng —
        GMGN vẫn list hop đó (5/29 nhãn thật), nên chỉ ≠ 0 mới là phantom §4.1."""
        p = pre_a.get(a)
        return p is not None and p == post_a.get(a) != 0

    def rej(frame, mint, why):
        if trace:
            trace(f"REJECT {frame} {mint or '-'} {why}")

    def cap_fee(src, dst, mint, raw, dec, frame, seq, reason, stack, parent, ix):
        """Điều kiện (a) lọc ngay tại reject site; (b)(c) cần paired steps nên lọc
        ở `detect_swaps`."""
        if rejected is None or reason not in _FEE_REJECT_REASONS:
            return
        rs, rd = role(src), role(dst)
        if rs != "WALLET":
            return
        rejected.append(
            _fee_candidate(
                src,
                dst,
                mint,
                raw,
                dec,
                frame,
                seq,
                reason,
                rs,
                rd,
                stack,
                parent,
                ix,
                own,
            )
        )

    deny = _PLUMBING | _TOKEN_PROGS | _AGGREGATORS
    legs = []
    for ti, seq, h, ix, stack in _frames(msg, meta):
        parent = stack[-2] if len(stack) >= 2 else (None, None)
        frame = (ti, h, parent[0], parent[1])
        p = ix.get("parsed")
        if not (
            isinstance(p, dict)
            and p.get("type") in _XFER_TYPES
            and ix.get("programId") in _TOKEN_PROGS
        ):
            rej(frame, None, "not_spl")
            continue
        info = p.get("info") or {}
        src, dst = info.get("source"), info.get("destination")
        mint = info.get("mint") or mint_of.get(src) or mint_of.get(dst)
        ta = info.get("tokenAmount") or {}
        try:
            raw = int(str(info.get("amount") or ta.get("amount") or ""))
        except (TypeError, ValueError):
            rej(frame, mint, "not_spl")
            continue
        dec = info.get("decimals") or ta.get("decimals") or dbase(mint or "", dec_of)
        # "swap-anchored": leg ví chạm tới nằm trong frame program ∈ _SWAP_PROGRAMS
        # (phủ cả leg reject + cả 2 chiều ví; JUP stake ∉ registry ⇒ withdraw không tính)
        if (
            anchored is not None
            and mint
            and (own.get(src) == wallet or own.get(dst) == wallet)
            and any(q in _SWAP_PROGRAMS for q, _s in stack)
        ):
            anchored.add(mint)
        encl = next((q for q, _s in reversed(stack[:-1]) if q not in deny), None)
        if encl is None:
            why = (
                "aggregator_frame"
                if any(q in _AGGREGATORS for q, _s in stack)
                else "plumbing"
            )
            cap_fee(src, dst, mint, raw, dec, frame, seq, why, stack, parent, ix)
            rej(frame, mint, why)
            continue
        rs, rd = role(src), role(dst)
        if (rs == "POOL") == (rd == "POOL"):
            cap_fee(
                src,
                dst,
                mint,
                raw,
                dec,
                frame,
                seq,
                "no_pool_endpoint",
                stack,
                parent,
                ix,
            )
            rej(frame, mint, "no_pool_endpoint")  # 0 POOL (junk) hoặc 2 POOL (AMBIG)
            continue
        legs.append(
            {
                "mint": mint,
                "src": src,
                "dst": dst,
                "raw": raw,
                "dec": dec,
                "frame": frame,
                "encl": encl,
                "seq": seq,
                "rs": rs,
                "rd": rd,
                "wflat": (rs == "WALLET" and wflat(src))
                or (rd == "WALLET" and wflat(dst)),
                "pool": own.get(src if rs == "POOL" else dst),
            }
        )
    return legs


def _match_pairs(cands):
    """Ghép greedy các cặp distinct-mint chưa used theo min |Δseq| (tie-break
    seq ⇒ deterministic). Trả (pairs, n_candidate) — n_candidate > 1 ⇒ nhãn
    by=seq_gap."""
    free = [lg for lg in cands if not lg.get("used")]
    pairs = sorted(
        (abs(a["seq"] - b["seq"]), a["seq"], b["seq"], a, b)
        for i, a in enumerate(free)
        for b in free[i + 1 :]
        if a["mint"] != b["mint"]
    )
    out = []
    for _gap, _sa, _sb, a, b in pairs:
        if not a.get("used") and not b.get("used"):
            a["used"] = b["used"] = True
            out.append((a, b))
    return out, len(pairs)


def _pair_steps(legs, trace=None):
    """Bước 3 pairing: primary = CÙNG frame_id + 2 mint phân biệt (plan §3:
    'pair 2 leg thành 1 step khi chúng ở cùng frame_id'); fallback khi frame
    không tách được = cùng pool_key + 2 mint phân biệt; nhiều ứng viên ⇒ greedy
    min |Δseq|. KHÔNG đòi cùng pool_key ở primary — đã đo: escrow-DEX
    (ZERo/ALPHA/MNFST) có vault owner KHÁC NHAU giữa 2 leg của cùng 1 swap
    (FyhWbqUr vs 2Xfc8WFf, 5e7YKt vs GJrFmC), pool-shared chỉ đúng với
    AMM vault (pAMM/CPMMoo/CAMM/LBUZ/BiSoNH/QuaNt). Leg thừa ⇒ REJECT
    same_mint / unpaired."""
    steps, by_pool, by_frame = [], defaultdict(list), defaultdict(list)
    for lg in legs:
        by_pool[lg["pool"]].append(lg)
        by_frame[lg["frame"]].append(lg)
    for frame, fg in by_frame.items():
        if len(fg) < 2:
            continue
        got, nc = _match_pairs(fg)
        steps += [
            (a, b, frame, a["pool"], "frame" if nc == 1 else "seq_gap") for a, b in got
        ]
    for pool, group in by_pool.items():
        left = [lg for lg in group if not lg.get("used")]
        if len(left) < 2:
            continue
        got, nc = _match_pairs(left)
        for a, b in got:
            f = a["frame"] if a["seq"] <= b["seq"] else b["frame"]
            steps.append((a, b, f, pool, "pool_key" if nc == 1 else "seq_gap"))
    for group in by_pool.values():
        for lg in group:
            if lg.get("used"):
                continue
            alt = any(o is not lg and o["mint"] != lg["mint"] for o in group)
            if trace:
                why = "unpaired" if alt else "same_mint"
                trace(f"REJECT {lg['frame']} {lg['mint']} {why}")
    return steps


def _rank_mints(pairs):
    """Bước 4: rank mint = BFS trên đồ thị cặp-mint của RIÊNG tx. Seed TIER_A
    = 0.0 (FIFO trước) rồi TIER_B = 0.5; rank[y] = rank[x] + 1; không reach ⇒
    mặc định 99 ở _base_quote. sorted() ở seed lẫn neighbor ⇒ deterministic."""
    adj = defaultdict(set)
    for a, b in pairs:
        if a and b and a != b:
            adj[a].add(b)
            adj[b].add(a)
    rank, queue = {}, []
    for tier, r0 in ((TIER_A, 0.0), (TIER_B, 0.5)):
        for m in sorted(adj):
            if m in tier and m not in rank:
                rank[m] = r0
                queue.append(m)
    while queue:
        x = queue.pop(0)
        for y in sorted(adj[x]):
            if y not in rank:
                rank[y] = rank[x] + 1.0
                queue.append(y)
    return rank


def _base_quote(m1, m2, rank):
    """Bước 4 rule 3-5: rank thấp = quote, cao = base; bằng nhau (kể cả cùng
    không reach = 99) ⇒ lex-nhỏ-hơn = base + quote_inferred. Đã đo: mint OS
    8LstZp… < CARDS CARDScc… ⇒ base = OS đúng oracle cả 3 row OS↔CARDS. Row tie
    fail ⇒ detector sai, KHÔNG đảo rule."""
    r1, r2 = rank.get(m1, 99.0), rank.get(m2, 99.0)
    if r1 != r2:
        return (m1, m2, False) if r1 > r2 else (m2, m1, False)
    return (m1, m2, True) if m1 < m2 else (m2, m1, True)


def _dsym(mint) -> str:
    """Symbol cache-first: _info (fixture/DexScreener) rồi mới quotes_map qua
    _sym — oracle cần quote WSOL hiện 'WSOL', không phải 'SOL'."""
    ti = _info.get(mint)
    return (ti[0] if ti else None) or _sym(mint)


def _quote_px(qm):
    """Giá quote theo đúng cache của `_swap_event`; fee leg kế thừa path này."""
    return (
        _sol_px["v"]
        if qm == WSOL
        else 1.0
        if qm in (USDC, USDT)
        else (_info.get(qm) or (None, 0.0))[1]
    )


def _symbol_pending(m):
    return m not in quotes_map and (m not in _info or m in _info_miss)


# Ngưỡng lệch cho guard quote-token ở `_swap_event`: quote là token thường ⇒ giá
# cache có thể sai; tx có neo USD thật (net USDC/USDT/SOL của ví) thì leg lệch quá
# ngưỡng này so với neo bị coi là rác và trả về usd_pending thay vì ghi số ảo
# (sự cố 2026-09-24: leg $500 ghi thành $2.5M). Rộng rãi để không cắt oan route
# chia phần (Jupiter split), vẫn chặn mọi lệch ≥ 50×.
QUOTE_USD_GUARD = 50.0
QUOTE_USD_GUARD_MIN = 1.0  # neo nhỏ hơn $1 không đủ tin để làm mốc


def _swap_event(tx, wallet, sig, ts, sa, sb, pool, rank, net_map=None, tot_map=None):
    """Bước 5 — `qty` = amount GROSS của leg base (parsed instruction, decimals từ
    balances; nhãn per-step đã soát tay khớp GMGN — xem test_wallet_watch.py).
    `qty_net` = phần NET của ví cho mint đó, chia tỉ lệ theo gross từng hop ⇒
    nhiều hop cùng mint (SOLCAT 3 hop) vẫn cộng ra đúng net ví, không đếm trùng.
    quote_usd = quote_qty × price cache (WSOL ⇒ _sol_px, USDC/USDT ⇒ 1.0);
    CHƯA BIẾT GIÁ ⇒ None + usd_pending (§5.2: không bịa 0) và KHÔNG drop
    (§5.3/§9.2: ngưỡng detect = 0 hằng số; gate $50 nằm ở server
    POST /api/tracked-cas — detector không được tự bỏ trade thật).
    Trả (event, base_leg, base_mint, quote_mint)."""
    bm, qm, inferred = _base_quote(sa["mint"], sb["mint"], rank)
    bl, ql = (sa, sb) if sa["mint"] == bm else (sb, sa)
    qty = bl["raw"] / 10 ** bl["dec"]
    qq = ql["raw"] / 10 ** ql["dec"]
    # USDC/USDT neo $1 — _info không cache stablecoin ⇒ hardcode, không network
    px = _quote_px(qm)
    qusd = qq * px if px else None  # None = chưa biết giá, KHÔNG phải giá 0
    if qusd and qm not in (WSOL, USDC, USDT) and net_map:
        anchor = (
            abs(net_map.get(USDC, 0.0))
            + abs(net_map.get(USDT, 0.0))
            + abs(net_map.get(WSOL, 0.0)) * _sol_px["v"]
        )
        if anchor >= QUOTE_USD_GUARD_MIN and not (
            anchor / QUOTE_USD_GUARD <= qusd <= anchor * QUOTE_USD_GUARD
        ):
            qusd = None
    pend = _symbol_pending

    # net ví cho mint này (chain truth) — None khi ví không đổi số dư mint đó
    n_mint = net_map.get(bm, 0.0) if net_map else 0.0
    g_mint = tot_map.get(bm, 0.0) if tot_map else 0.0
    qty_net = qty * n_mint / g_mint if (n_mint and g_mint > 0) else None
    ev = {
        "ts": ts,
        "slot": tx.get("slot"),
        "sig": sig,
        "wallet": wallet,
        "side": "BUY" if bl["rs"] == "POOL" else "SELL",  # POOL là src ⇒ BUY (§B3)
        "mint": bm,
        "sym": _dsym(bm),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": _dsym(qm),
        "quote_qty": qq,
        "quote_usd": qusd,
        "qty_net": qty_net,
        "unit_price": qq / qty if qty else 0.0,
        "pool": pool,
        "program": bl["encl"],
        "amount_basis": "gross_leg",
        "quote_inferred": inferred,
        "symbol_pending": bool(pend(bm) or pend(qm)),
        "usd_pending": not qusd,
        "type": "SWAP",
    }
    return ev, bl, bm, qm


def _fee_event(tx, wallet, sig, ts, cand, buy_ev):
    """Fee-leg Option A: leg phí bị reject nhưng là SELL thật của ví, gắn với BUY
    step cùng base mint gần nhất. Không suy quote/unit_price riêng — kế thừa BUY
    event để giữ parity Nansen. `qty_net` luôn bằng gross fee vì `net_adj` đã cộng
    phần phí này trở lại net owner trước khi chia cho các step thường."""
    qty = cand["raw"] / 10 ** cand["dec"]
    qm = buy_ev["quote_mint"]
    up = buy_ev["unit_price"]
    qq = qty * up
    px = _quote_px(qm)
    qusd = qq * px if px else None
    return {
        "ts": ts,
        "slot": tx.get("slot"),
        "sig": sig,
        "wallet": wallet,
        "side": "SELL",
        "mint": cand["mint"],
        "sym": _dsym(cand["mint"]),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": buy_ev["quote_sym"],
        "quote_qty": qq,
        "quote_usd": qusd,
        "qty_net": qty,
        "unit_price": up,
        "pool": "",
        "program": cand["program"],
        "amount_basis": "gross_leg",
        "quote_inferred": buy_ev["quote_inferred"],
        "symbol_pending": buy_ev["symbol_pending"],
        "usd_pending": not qusd,
        "type": "SWAP",
        "fee_leg": True,
    }


def _promote_fee_candidates(rejected, steps, rank):
    """B1 + (c): candidate chỉ promote khi dst/dst_owner không phải pool account/pool
    owner của bất kỳ paired step nào trong chính tx, và có BUY step cùng base mint.
    Chọn BUY base leg gần nhất theo |Δseq|, tie-break seq (giống `_match_pairs`)."""
    pool_refs: set[str] = set()
    buy_base_legs: dict[str, list[dict[str, Any]]] = {}
    for sa, sb, _frame, pool, _by in steps:
        if pool is not None:
            pool_refs.add(pool)
        for lg in (sa, sb):
            if lg["rs"] == "POOL" and lg["src"] is not None:
                pool_refs.add(lg["src"])
            if lg["rd"] == "POOL" and lg["dst"] is not None:
                pool_refs.add(lg["dst"])
        bm, _qm, _inf = _base_quote(sa["mint"], sb["mint"], rank)
        bl = sa if sa["mint"] == bm else sb
        if bl["rs"] == "POOL":
            buy_base_legs.setdefault(bm, []).append(bl)

    promoted: list[tuple[dict[str, Any], dict[str, Any]]] = []
    fee_out: dict[str, float] = {}
    for cand in sorted(rejected, key=lambda c: c["seq"]):
        dst_owner = cand.get("dst_owner")
        if cand["dst"] in pool_refs or (
            dst_owner is not None and dst_owner in pool_refs
        ):
            continue
        buys = buy_base_legs.get(cand["mint"])
        if not buys:
            continue
        bl = min(buys, key=lambda b: (abs(cand["seq"] - b["seq"]), b["seq"]))
        promoted.append((cand, bl))
        qty = cand["raw"] / 10 ** cand["dec"]
        fee_out[cand["mint"]] = fee_out.get(cand["mint"], 0.0) + qty
    return promoted, fee_out


def _reprice_route_legs(evs, majors) -> None:
    """Route trung gian (USDC→MEME→TOKEN): priceUsd của MEME ở pool mỏng lệch
    nhiều lần so với giá trị thật của khối MEME đó. Leg nối tiếp của cùng một route
    dùng CHUNG một khối MEME (qty == quote_qty) nên USD phải bằng nhau — lấy theo
    leg có quote tin được (SOL/USDC/USDT) thay vì tin DexScreener của MEME.

    Khối MEME có thể bị CHIA qua nhiều leg (Jupiter split): cộng dồn các leg anh em
    theo `qty` rồi so với `quote_qty` — sự cố 2026-09-25 (id=4289 GOCAT→GO): parcel
    GO 347.075 chia 2 leg SOL ($213,21 + $71,37 = $284,58) nhưng leg quote-GO vẫn
    giữ giá DexScreener $1.778,07 (6,25×). Lặp tối đa 3 chặng để route dài
    (A→MEME1→MEME2→SOL) truyền giá trị dần về leg gốc."""
    done: set[int] = set()  # leg đã lấy giá từ chain (được dùng làm mốc chặng sau)
    for _ in range(3):
        changed = False
        for e in evs:
            qm = e.get("quote_mint")
            if qm in majors or not e.get("quote_usd") or not e.get("quote_qty"):
                continue
            tot_q = tot_usd = 0.0
            for b in evs:
                if b is e or b.get("mint") != qm or not b.get("quote_usd"):
                    continue
                if b.get("quote_mint") in majors or id(b) in done:
                    tot_q += b.get("qty") or 0.0
                    tot_usd += b["quote_usd"]
            if not tot_usd or abs(tot_q - e["quote_qty"]) > (
                1e-6 * max(1.0, abs(e["quote_qty"]))
            ):
                continue
            if tot_usd != e["quote_usd"]:
                e["quote_usd"] = tot_usd
                done.add(id(e))
                changed = True
        if not changed:
            break


def _opp_quote(net_map, m, majors):
    """Leg đối ứng của mint m: major trái dấu |net| lớn nhất, else non-major."""
    v = net_map.get(m, 0.0)
    opp = [
        (abs(w), q) for q, w in net_map.items() if q != m and w and (w > 0) != (v > 0)
    ]
    if not opp:
        return None
    return max([x for x in opp if x[1] in majors] or opp)[1]


def _net_swap_event(tx, wallet, sig, ts, m, v, qm, net_map):
    """Swap suy từ net ví khi leg-pairing bỏ sót: qty = đúng net ví, quote = leg
    đối ứng. amount_basis="net_delta" để phân biệt với gross_leg đã soát tay."""
    qty, qq = abs(v), abs(net_map.get(qm, 0.0))
    px = _quote_px(qm)
    qusd = qq * px if px else None
    return {
        "ts": ts,
        "slot": tx.get("slot"),
        "sig": sig,
        "wallet": wallet,
        "side": "BUY" if v > 0 else "SELL",
        "mint": m,
        "sym": _dsym(m),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": _dsym(qm),
        "quote_qty": qq,
        "quote_usd": qusd,
        "qty_net": v,
        "unit_price": qq / qty if qty else 0.0,
        "pool": "",
        "program": "",
        "amount_basis": "net_delta",
        "quote_inferred": True,
        "symbol_pending": bool(_symbol_pending(m) or _symbol_pending(qm)),
        "usd_pending": not qusd,
        "type": "SWAP",
    }


def detect_swaps(tx, wallet, trace=None, with_transfers=False) -> list[dict[str, Any]]:
    """1 tx của ví → 1 event cho MỖI bước swap qua 1 pool (parity row GMGN —
    spec §3 Bước 1-5). Không network, không state ngoài cache _info/_sol_px.
    trace=callable nhận dòng quyết định REJECT/RANK/PAIR/STEP (bảng evidence T2).
    type luôn là SWAP — không bao giờ là nhãn route-level cũ (transfer-in/out, neutral)."""
    meta = tx.get("meta") or {}
    if meta.get("err") is not None:
        return []
    sig = tx["transaction"]["signatures"][0]
    ts = datetime.fromtimestamp(tx.get("blockTime") or time.time(), ICT).strftime(
        "%m-%d %H:%M:%S"
    )
    rejected: list[dict[str, Any]] = []
    anchored: set[str] = set()
    legs = _legs_with_roles(tx, wallet, trace, rejected, anchored)
    steps, majors = [], TIER_A | TIER_B
    for sa, sb, frame, pool, by in _pair_steps(legs, trace):
        # major↔major = route conversion (USDC↔WSOL…), không phải token trade:
        # GMGN không list — đã đo trên 9 tx fixture, chỉ 1 pair rơi vào
        # (QuaNt USDC↔WSOL ở 58pWphuG); bỏ nó khớp đúng role distribution 29,
        # steps 29/29 và quote_inferred==1 của plan. 0/29 row oracle major-major.
        if sa["mint"] in majors and sb["mint"] in majors:
            if trace:
                trace(f"REJECT {frame} {sa['mint']} major_pair")
                trace(f"REJECT {frame} {sb['mint']} major_pair")
            continue
        steps.append((sa, sb, frame, pool, by))
    steps.sort(key=lambda s: min(s[0]["seq"], s[1]["seq"]))
    rank = _rank_mints([(s[0]["mint"], s[1]["mint"]) for s in steps])
    if trace and rank:
        order = sorted(rank, key=lambda m: (rank[m], m))
        trace("RANK " + " ".join(f"{_dsym(m)}={rank[m]}" for m in order))
    # §4.1: bỏ hop base mà tài khoản ví giữ mint đó không nhúc nhích, trong route
    # pump.fun. Lọc TRƯỚC vòng gross để mẫu số chia qty_net không bị leg phantom
    # làm nhiễu. Chỉ xét leg BASE: leg quote wflat là chuyện bình thường (ví dụ
    # "H74 nhận vào rồi trả ra" ở SELL 9CmbYf — leg đó là quote, không phải base).
    if steps:
        keep = []
        for st in steps:
            bm0, _qm0, _inf0 = _base_quote(st[0]["mint"], st[1]["mint"], rank)
            bl0 = st[0] if st[0]["mint"] == bm0 else st[1]
            if bl0["wflat"] and bl0["encl"] in _PUMP_ROUTE:
                if trace:
                    trace(f"REJECT {st[2]} {bm0} phantom_flat_wallet_acct")
                continue
            keep.append(st)
        steps = keep
    # gross leg base theo từng mint = mẫu số chia qty_net (tỉ lệ) cho mỗi hop
    gross: dict[str, float] = {}
    for sa, sb, *_ in steps:
        bm, _qm, _inf = _base_quote(sa["mint"], sb["mint"], rank)
        bl = sa if sa["mint"] == bm else sb
        gross[bm] = gross.get(bm, 0.0) + bl["raw"] / 10 ** bl["dec"]
    net = _net_owner(tx, wallet)
    promoted, fee_out = _promote_fee_candidates(rejected, steps, rank)
    net_adj = dict(net)
    for m, extra in fee_out.items():
        net_adj[m] = net_adj.get(m, 0.0) + extra

    buy_event_by_base_leg: dict[int, dict[str, Any]] = {}
    built = []
    for sa, sb, frame, pool, by in steps:
        ev, bl, bm, qm = _swap_event(
            tx, wallet, sig, ts, sa, sb, pool, rank, net_adj, gross
        )
        if trace:
            trace(f"PAIR {frame} {_dsym(bm)}←{_dsym(qm)} by={by}")
        if ev is not None:
            built.append((ev, frame, bl, min(sa["seq"], sb["seq"]), None))
            if ev["side"] == "BUY":
                buy_event_by_base_leg[id(bl)] = ev
    for cand, bl in promoted:
        buy_ev = buy_event_by_base_leg.get(id(bl))
        if buy_ev is None:
            continue
        built.append(
            (
                _fee_event(tx, wallet, sig, ts, cand, buy_ev),
                cand["frame"],
                None,
                cand["seq"],
                cand,
            )
        )
    # Fallback: mint ví đổi số dư mà leg-pairing bỏ sót. `anchored` (leg trong
    # frame program ∈ _SWAP_PROGRAMS) giết withdraw/unstake; không anchored ⇒ TRANSFER.
    seen = {ev["mint"] for ev, *_ in built}
    for m, v in net_adj.items():
        if not v or m in majors or m in seen:
            continue
        qm = _opp_quote(net_adj, m, majors) if m in anchored else None
        if qm is not None:
            ev = _net_swap_event(tx, wallet, sig, ts, m, v, qm, net_adj)
        elif with_transfers:
            ev = _recv_event(tx, wallet, m, abs(v))
            ev.update(
                side="transfer",
                type="TRANSFER",
                transfer_dir="in" if v > 0 else "out",
                qty_net=v,
                amount_basis="net_delta",
            )
        else:
            continue
        seen.add(m)
        built.append(
            (ev, None, {"rs": "RELAY", "rd": "RELAY", "seq": 10**9}, 10**9, None)
        )
    built.sort(key=lambda item: item[3])
    evs = []
    n = len(built)
    for i, (ev, frame, bl, _seq_key, cand) in enumerate(built, 1):
        ev["step"], ev["n_steps"] = i, n  # 2 key phụ cho fmt() ` step i/n` (§B5)
        if trace:
            if cand is None:
                trace(
                    f"STEP {sig[:8]} | {frame} | {ev['pool']} | {ev['sym']}"
                    f" | {ev['quote_sym']} | {bl['rs']} | {bl['rd']} | {ev['side']}"
                    f" | {ev['qty']:.12g} | {ev['quote_qty']:.12g}"
                    f" | {ev['amount_basis']}"
                )
            else:
                trace(
                    f"FEE {sig[:8]} | {frame} | {cand['reason']} | {ev['sym']}"
                    f" | {ev['quote_sym']} | {cand['rs']} | {cand['rd']} | {ev['side']}"
                    f" | {ev['qty']:.12g} | {ev['quote_qty']:.12g}"
                    f" | {ev['amount_basis']} | fee_leg"
                )
        evs.append(ev)
    _reprice_route_legs(evs, majors)
    return evs


def detect_events(tx, wallet, trace=None) -> list[dict[str, Any]]:
    """detect_swaps + TRANSFER (mint ví đổi số dư nhưng không qua swap venue).
    Production (_handle_tx) dùng hàm này; oracle per-step vẫn gọi detect_swaps."""
    return detect_swaps(tx, wallet, trace, with_transfers=True)


def _fq(v) -> str:
    return f"{v:,.6f}".rstrip("0").rstrip(".")


def fmt(e) -> str:
    w = e["wallet"][:5] + "…" + e["wallet"][-4:]
    q = _fq(e["qty"])
    side = str(e["side"] or "")
    col = {
        "BUY": "\033[32m",
        "SELL": "\033[31m",
        "NEUTRAL": "\033[90m",
    }.get(side, "")
    tk = e.get("ticker") or e.get("sym") or ""
    leg = f" ← {e['quote_sym']} {_fq(e['quote_qty'])}" if e.get("quote_sym") else ""
    money = f" ≈ ${abs(e['quote_usd']):,.2f}" if e.get("quote_usd") else ""
    px = (
        f" @{e['unit_price']:.10f}".rstrip("0").rstrip(".") + "/tk"
        if e.get("unit_price")
        else ""
    )
    gross = " (gross)" if e.get("amount_basis") == "gross_leg" else ""
    step = f" step {e['step']}/{e['n_steps']}" if e.get("n_steps") else ""
    mint = f"  {e['mint'][:8]}…" if e.get("mint") else ""
    vs = "  [" + ",".join(e["vs"]) + "]" if e.get("vs") else ""
    return (
        f"{e['ts']} {col}{side:<12}\033[0m {w}  {q} {tk}{leg}{money}{px}{gross}"
        f"{step}{mint}{vs}  https://solscan.io/tx/{e['sig']}"
    )


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


# ---------- rule A (chốt 2026-09-18): CA = token ĐÍCH của TRADER ----------
# Token coi như TIỀN/route ⇒ không bao giờ là CA: stablecoin + tier quote
# (WSOL/USDC/USDT/DAI/WBTC). LINK không cần hardcode: nó tự bị loại vì trader chỉ
# TRUNG CHUYỂN (nhận rồi trả hết trong cùng tx ⇒ net = 0) — tx 4VPQRwNB.
_ROUTE_MINTS = TIER_A | TIER_B


def _signer_keys(tx) -> list[str]:
    """Pubkey các account ĐÃ KÝ (accountKeys[].signer)."""
    return [
        ak["pubkey"]
        for ak in tx["transaction"]["message"].get("accountKeys") or []
        if ak.get("signer")
    ]


def _net_owner(tx, owner) -> dict[str, float]:
    """net uiAmount theo mint cho ĐÚNG 1 owner (pre/postTokenBalances)."""
    net: dict[str, float] = {}
    for sign, key in ((-1.0, "preTokenBalances"), (1.0, "postTokenBalances")):
        for r in (tx.get("meta") or {}).get(key) or []:
            if r.get("owner") != owner:
                continue
            amt = r.get("uiTokenAmount") or {}
            v = amt.get("uiAmountString") or amt.get("uiAmount") or 0
            net[r["mint"]] = net.get(r["mint"], 0.0) + sign * float(v)
    return net


def _fill_dest(tx, wallet, me):
    """OTC fill (rule A): memecoin ví track BÁN (net < 0, không-route) mà một
    SIGNER khác MUA (net > 0 CÙNG mint). Ví track không ký nhưng vẫn là một bên
    của giao dịch — 4VPQRwNB: GpMZbSM2 bán MARINE cho 5k3ZdP3vqN; 3Vdkaok:
    HLnpSz9h bán ZINC cho 6UvTH39q9i. Trả (buyer, mint) | None."""
    sold = {m: -v for m, v in me.items() if v < 0 and m not in _ROUTE_MINTS}
    if not sold:
        return None
    best = None
    for a in _signer_keys(tx):
        if a == wallet:
            continue
        for m, v in _net_owner(tx, a).items():
            if v > 0 and m in sold and m not in _ROUTE_MINTS:
                if best is None or v > best[0]:
                    best = (v, a, m)
    return (best[1], best[2]) if best else None


def _fill_event(tx, wallet, dest, buyer, evs):
    """Event CA cho OTC fill: qty = net(dest) của buyer; quote = token buyer TRẢ
    (net < 0 lớn nhất). USD ưu tiên giá quote; quote là memecoin chưa có giá ⇒
    lấy giá trị settlement (max quote_usd của event ví) để CA vẫn post được."""
    net = _net_owner(tx, buyer)
    qty = net.get(dest, 0.0)
    paid = {m: -v for m, v in net.items() if v < 0}
    qm = max(paid, key=lambda m: paid[m]) if paid else None
    qq = paid[qm] if qm else 0.0
    px = (
        _sol_px["v"]
        if qm == WSOL
        else 1.0
        if qm in (USDC, USDT)
        else (_info.get(qm or "") or (None, 0.0))[1]
    )
    qusd, basis = qq * px, "quote"
    if not qusd:
        oth = max((e.get("quote_usd") or 0.0 for e in evs), default=0.0)
        qusd, basis = (oth, "counterparty") if oth > 0 else (None, "none")
    return {
        "ts": datetime.fromtimestamp(tx.get("blockTime") or time.time(), ICT).strftime(
            "%m-%d %H:%M:%S"
        ),
        "slot": tx.get("slot"),
        "sig": tx["transaction"]["signatures"][0],
        "wallet": wallet,
        "side": "BUY",
        "mint": dest,
        "sym": _dsym(dest),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": _dsym(qm) if qm else "",
        "quote_qty": qq,
        "quote_usd": qusd,
        "unit_price": qq / qty if qty else 0.0,
        "pool": "",
        "program": "",
        "amount_basis": "net_delta",
        "quote_inferred": False,
        "usd_basis": basis,
        "via": buyer,
        "symbol_pending": False,
        "usd_pending": not qusd,
        "type": "SWAP",
        "step": 1,
        "n_steps": 1,
    }


def _recv_event(tx, wallet, mint, qty):
    """Ví KHÔNG ký, KHÔNG bán gì mà VẪN nhận memecoin (deposit/airdrop/claim) —
    69LjZU +20.060.836 (4F5JCkWy), airdrop +990 (2oJtynk92s): trước đây các tx
    này không sinh event nào (ví coi như không liên quan). Quote chưa biết ⇒
    quote_usd=0 + usd_pending=True ⇒ track_post_body bỏ qua (chỉ log/events.jsonl)
    — KHÔNG tự đẩy token rác vào queue CA."""
    return {
        "ts": datetime.fromtimestamp(tx.get("blockTime") or time.time(), ICT).strftime(
            "%m-%d %H:%M:%S"
        ),
        "slot": tx.get("slot"),
        "sig": tx["transaction"]["signatures"][0],
        "wallet": wallet,
        "side": "RECEIVE",
        "mint": mint,
        "sym": _dsym(mint),
        "qty": qty,
        "quote_mint": None,
        "quote_sym": "",
        "quote_qty": 0.0,
        "quote_usd": None,
        "unit_price": 0.0,
        "pool": "",
        "program": "",
        "amount_basis": "net_delta",
        "quote_inferred": False,
        "usd_basis": "none",
        "via": None,
        "symbol_pending": False,
        "usd_pending": True,
        "type": "RECEIVE",
        "step": 1,
        "n_steps": 1,
    }


def _target_event(tx, wallet, evs):
    """1 tx → 1 CA: chọn TOKEN ĐÍCH duy nhất (rule A, chốt 2026-09-18).

    Đích = token TRADER thực nhận (net > 0), KHÔNG phải token ví track nhận.
    (1) Ví track là trader (ký) ⇒ như cũ: lấy BUY có net > 0, bước CUỐI; mint
        routing (vừa mua vừa tiêu hết, net ≈ 0) tự bị loại.
    (2) Ví track KHÔNG ký tx (đối ứng bị động) ⇒ CA = memecoin hai bên trao đổi
        (ví bán, signer mua): 4VPQRwNB ⇒ MARINE, 3Vdkaok ⇒ ZINC. Ví có event BUY
        khớp đích thì dùng luôn (leg đã đúng); chưa có (mint lạ) ⇒ _fill_event.
        Ví CÓ ký ⇒ tx là hành vi của chính ví ⇒ không áp (2): giao kèo 2 signer
        (3GkmwgW2vE) không được biến thành tín hiệu mua.
    (3) Ví không nhận memecoin nào (bán thật, không ai mua lại) ⇒ None.
    ponytail: tx mua 2 token độc lập chỉ giữ token ở bước cuối — cần giữ cả thì
    trả về list thay vì max-step."""
    net = _net_owner(tx, wallet)
    if wallet not in _signer_keys(tx):
        fill = _fill_dest(tx, wallet, net)
        if fill:
            buyer, dest = fill
            hit = next(
                (e for e in evs if e.get("mint") == dest and e.get("side") == "BUY"),
                None,
            )
            return hit if hit is not None else _fill_event(tx, wallet, dest, buyer, evs)
        # (2b) ví KHÔNG ký và KHÔNG bán gì: chỉ NHẬN token (deposit/airdrop/claim)
        # và không có BUY event nào ⇒ trước đây return None ⇒ tx vô hình. Bắn
        # event nhận (usd_pending ⇒ log-only, không post CA rác).
        if not any(e.get("side") == "BUY" for e in evs):
            recv = {m: v for m, v in net.items() if v > 0 and m not in _ROUTE_MINTS}
            if recv:
                m = max(recv, key=lambda x: recv[x])
                return _recv_event(tx, wallet, m, recv[m])
    buys = [e for e in evs if e.get("side") == "BUY" and e.get("mint")]
    if not buys:
        return None
    dests = [e for e in buys if net.get(e.get("mint") or "", 0.0) > 0]
    return max(dests or buys, key=lambda e: int(e.get("step") or 0))


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


def _handle_tx(tx, sig, wallets, st) -> None:
    """Emit path DUY NHẤT — chỉ block feed gọi: tx lấy TRỰC TIẾP từ getBlock của
    slot đang quét (KHÔNG crawl sig lịch sử của ví). Mỗi ví tracked có mặt trong
    accountKeys → detect_swaps → print + jl_write + track_event, rồi cập nhật
    head. KHÔNG save_state — caller tự quyết nhịp lưu.

    `_warm_prices` chạy TRƯỚC detect_swaps (giá quote phải có sẵn trong cache);
    `_target_event` gộp cả tx về ĐÚNG 1 token đích để `track_event` — log/
    `events.jsonl` vẫn giữ đủ MỌI step để soi route."""
    if _cfg_next and time.time() >= _cfg_next:  # ~5 phút/lần, chỉ khi tới hạn
        load_config_from_api(wallets)
    # FIX discovery: accountKeys (dù đã merge ALT qua _keys) vẫn bỏ sót ví chỉ
    # xuất hiện qua ATA của nó — 3jjAdrCK: EC2f5Dn nhận 15.000 USDC mà KHÔNG nằm
    # trong accountKeys ⇒ tx vô hình, không event, không CA. Owner trong
    # pre/postTokenBalances là nguồn "ví có liên quan" đầy đủ, sẵn có trong
    # payload (0 RPC thêm).
    _meta = tx.get("meta") or {}
    keys = set(_keys(tx["transaction"]["message"], _meta))
    keys |= {
        b["owner"]
        for b in (_meta.get("preTokenBalances") or [])
        + (_meta.get("postTokenBalances") or [])
        if b.get("owner")
    }
    hits = [w for w in wallets if w in keys]
    if (
        not hits
    ):  # tx không dính ví nào ⇒ KHÔNG warm giá (bottleneck cũ: 0.1s/mint × mọi tx)
        return
    _warm_prices(tx)
    for w in hits:
        st["wallets"].setdefault(w, {})["head"] = sig
        evs = detect_events(tx, w)
        ms = int((tx.get("blockTime") or time.time()) * 1000)  # §5.4 mốc epoch-ms
        fresh = []
        for ev in evs:
            ev["ts_epoch_ms"] = ms
            key = (sig, w, ev.get("mint"), ev.get("side"), ev.get("step"))
            if key in _emitted:  # §5.5 dedupe tường minh theo hop
                continue
            _emitted.add(key)
            fresh.append(ev)
            print(fmt(ev), flush=True)
            jl_write(ev)
        # POST theo TỪNG hop net>0 (Q5): trước đây 1 CA/tx ⇒ hop 2..n mất khỏi
        # queue/Tracked by. _target_event giữ làm fallback cho rule A (OTC fill:
        # ví bán, không có BUY event nào của chính ví). `fresh` rỗng = tx đã xử lý
        # (ws+poll trùng, hoặc watermark lùi) ⇒ không post lại.
        hops = [
            e
            for e in fresh
            if e.get("type") == "SWAP"
            and (
                (e.get("side") == "BUY" and (e.get("qty_net") or 0) > 0)
                or e.get("side") == "SELL"
            )
        ]
        for ev in hops:
            track_event(ev)
            watch_trade_event(ev, tx.get("blockTime"))
        if fresh and not hops:
            ev = _target_event(tx, w, evs)
            if ev is not None:
                track_event(ev)
                watch_trade_event(ev, tx.get("blockTime"))


# T7 §5.8: tham số getBlock cố định của block feed (hoist ra module để
# run_block_feed < 50 dòng). maxSupportedTransactionVersion: đo 2026-09-15 trên
# publicnode — ver 0 ⇒ 20/20 slot chết -32015 "Transaction version (1) is not
# supported" (mainnet đã có tx version-1); ver 1 ⇒ block thật ~10-14MB/slot.
_BLOCK_PARAMS = {
    "encoding": "jsonParsed",
    "transactionDetails": "full",
    "maxSupportedTransactionVersion": 1,
    "rewards": False,
    "commitment": "confirmed",
}

# --once: trần số slot không dùng được (skip/None/malformed) liên tiếp trước khi
# save + return — --once KHÔNG được thành vòng quét vô hạn.
_ONCE_MAX_SLOTS = 5

# lossless: lỗi getBlock được PHÂN LOẠI. Chỉ slot 'skipped' THẬT mới bỏ; lỗi tạm
# thời ⇒ retry ĐÚNG slot đó (skip-mọi-lỗi là nguồn mất data cũ); hết
# _BLOCK_RETRY_MAX lần vẫn lỗi ⇒ log rõ + tiến 1 slot (mất ≤1 slot, không âm thầm).
_BLOCK_RETRY_MAX = 30
_RETRY_BASE_S = 1.0
_RETRY_CAP_S = 30.0
_LAG_WARN = 50  # chỉ để in cảnh báo; KHÔNG bao giờ nhảy slot vì lag


def _block_err_kind(msg: str) -> str:
    """Phân loại message lỗi getBlock: 'skip' = slot thật sự bị bỏ (result null
    hoặc -32004 'skipped'/'missing due to ledger jump'); còn lại = 'retry' (tạm
    thời, hoặc block chưa lan tới node). rpc() chỉ giữ text, không giữ code."""
    m = msg.lower()
    if "skipped" in m or "missing due to" in m or "missing from ledger" in m:
        return "skip"
    return "retry"


def _block_txs(blk, slot) -> Iterator[dict[str, Any]]:
    """Block entry → tx dict dạng getTransaction (không fetch lần 2, §T7)."""
    for en in blk.get("transactions") or []:
        yield {
            "slot": slot,
            "blockTime": blk.get("blockTime"),
            "transaction": en["transaction"],
            "meta": en.get("meta"),
            "version": en.get("version"),
        }


def run_block_feed(wallets, st, opts) -> None:
    """Block-scan TUẦN TỰ, không mất data.

    - Đi liên tục slot+1; lag chỉ là CẢNH BÁO (catch-up tuần tự), KHÔNG nhảy.
    - Lỗi tạm thời ⇒ retry ĐÚNG slot (backoff); chỉ slot 'skipped' thật mới bỏ.
    - block_slot = slot cuối đã xong ⇒ restart chỉ reprocess (downstream
      idempotent), không mất block.
    - Tx chỉ lấy từ getBlock của slot hiện tại — KHÔNG crawl sig lịch sử của ví.
    --once: xử lý 1 block rồi thoát (test)."""
    cur = int(rpc("getSlot", [{"commitment": "confirmed"}]))
    b = st.get("block_slot")
    slot = b + 1 if b is not None else cur
    prev_slot = st.get("prev_block_slot")
    print(
        f"# feed=block: resume slot {slot} | head {cur} | gap {max(0, cur - slot)}",
        flush=True,
    )
    attempts = 0
    unused = 0
    last_warn = 0.0
    _beat()
    while True:
        cur = int(rpc("getSlot", [{"commitment": "confirmed"}]))
        if cur - slot > _LAG_WARN and time.monotonic() - last_warn > 30:
            print(
                f"# lag {cur - slot} slot (đang ở {slot} < head {cur}) — catch-up tuần tự",
                flush=True,
            )
            last_warn = time.monotonic()
        if slot > cur:
            if opts["once"]:
                save_state(st)
                return
            time.sleep(opts["sleep"])
            _beat()
            continue
        blk = None
        try:
            r = rpc("getBlock", [slot, _BLOCK_PARAMS])
        except RuntimeError as err:
            kind = _block_err_kind(str(err))
            if kind != "skip":
                print(f"# retry slot {slot} (lần {attempts + 1}): {err}", flush=True)
        else:
            if isinstance(r, dict) and isinstance(r.get("transactions"), list):
                blk = r
                kind = "ok"
            elif isinstance(r, dict):
                kind = "retry"  # malformed ⇒ thử lại
            else:
                kind = "skip"  # result null ⇒ slot thật sự bị bỏ
        if isinstance(blk, dict):
            for tx in _block_txs(blk, slot):
                _handle_tx(tx, tx["transaction"]["signatures"][0], wallets, st)
            ps = blk.get("parentSlot")
            if prev_slot is not None and isinstance(ps, int) and ps < prev_slot:
                print(
                    f"# WARN slot {slot}: parentSlot {ps} < prev {prev_slot} (reorg?)",
                    flush=True,
                )
            st["block_slot"] = slot
            st["prev_block_slot"] = prev_slot = slot
            save_state(st)  # lưu MỖI block ⇒ restart resume chính xác
            _beat()
            slot += 1
            attempts = 0
            if opts["once"]:
                return
            continue
        if kind == "skip":  # slot thật sự bị bỏ — bình thường
            st["block_slot"] = slot
            slot += 1
            attempts = 0
            unused += 1
        else:  # retry — thử lại đúng slot
            attempts += 1
            if attempts >= _BLOCK_RETRY_MAX:
                print(
                    f"# GIVEUP slot {slot} sau {attempts} lần thử — tiến 1 slot",
                    flush=True,
                )
                st["block_slot"] = slot
                slot += 1
                attempts = 0
                unused += 1
            else:
                time.sleep(min(_RETRY_CAP_S, _RETRY_BASE_S * 2 ** (attempts - 1)))
                _beat()
                continue
        # --once KHÔNG được quét vô hạn trên chuỗi slot chết; thoát có save_state
        # để block_slot persist cho resume.
        if opts["once"] and unused >= _ONCE_MAX_SLOTS:
            save_state(st)
            return


def _wss(url: str) -> str:
    """Endpoint websocket suy từ endpoint HTTP tương ứng."""
    return url.replace("https://", "wss://").replace("http://", "ws://")


# Helius free cap số subscription MỖI KEY: dồn 198 sub (1 logsSubscribe/ví) vào 1
# connection/1 key ⇒ `1013 Rate limit reached: Too many subscriptions`, mỗi
# reconnect lại đẩy đủ 198 sub ⇒ hố không nhận event (đo 09-24: mất 3 tx). Chia
# mỗi key 1 connection ⇒ ~33 sub/key, dưới cap.
def _ws_shards(items, n):
    """Chia vòng tròn `items` ra n shard rời nhau, phủ hết, lệch ≤1 phần tử."""
    n = max(1, min(n, len(items) or 1))
    return [items[i::n] for i in range(n)]


def process_sig(sig, wallets, st, err=None) -> None:
    """Fetch 1 tx rồi emit qua _handle_tx (dedupe theo hop nằm TRONG _handle_tx).
    err!=None = tx fail ⇒ không fetch."""
    if err is not None:
        return
    try:
        tx = rpc(
            "getTransaction",
            [
                sig,
                {
                    "encoding": "jsonParsed",
                    # mainnet có tx version-1; ver=0 ⇒ -32015 "Transaction version
                    # (1) is not supported" ⇒ MẤT MỌI tx v1 (cùng defect của
                    # _BLOCK_PARAMS — đo 2026-09-15).
                    "maxSupportedTransactionVersion": 1,
                    "commitment": "confirmed",
                },
            ],
        )
    except Exception as e:
        print(f"  ! {sig[:12]}… getTransaction: {e}", file=sys.stderr)
        return
    if not tx:
        return
    _handle_tx(tx, sig, wallets, st)
    save_state(st)


def run_ws_feed(wallets, st) -> None:
    """Feed chính: ws `logsSubscribe` (1 sub/ví) — node push ngay sig của tx có
    nhắc ví. Chia ví ra `len(RPCS)` connection, MỖI KEY 1 connection — rớt thì
    shard đó đổi key kế. FORWARD-ONLY: KHÔNG crawl getSignaturesForAddress (nguồn
    CA cũ). Ví ký giao dịch của chính nó ⇒ có trong accountKeys ⇒ `mentions` luôn
    khớp, không miss CA (tx bên thứ 3 chỉ chạm ATA là log-only, không sinh CA)."""
    import asyncio

    try:
        import websockets
    except ImportError:
        sys.exit("feed=ws cần:  pip install websockets   (hoặc --feed block)")

    async def _beat_loop():
        while True:  # watchdog coi heartbeat là sống; ví im lặng vẫn phải đập nhịp
            _beat()
            await asyncio.sleep(30)

    async def _shard(sid, sliced, eps, nshard):
        k = sid  # shard khởi động ở key riêng ⇒ các connection không trùng key
        while True:
            try:
                async with websockets.connect(
                    _wss(eps[k % len(eps)]),
                    open_timeout=10,
                    ping_interval=20,
                    max_size=None,
                ) as ws:
                    for i, w in enumerate(
                        sliced, 1
                    ):  # public chỉ nhận 1 address/mentions/sub ⇒ 1 sub mỗi ví
                        await ws.send(
                            json.dumps(
                                {
                                    "jsonrpc": "2.0",
                                    "id": i,
                                    "method": "logsSubscribe",
                                    "params": [{"mentions": [w]}],
                                }
                            )
                        )
                    print(
                        f"# feed=ws shard {sid + 1}/{nshard} key#{k % len(eps)}"
                        f" logsSubscribe {len(sliced)} ví (tổng {len(wallets)})",
                        flush=True,
                    )
                    _beat()
                    while True:
                        m = json.loads(await ws.recv())
                        _beat()
                        if m.get("id") is not None and "params" not in m:
                            if "error" in m:
                                raise RuntimeError(m["error"]["message"])
                            continue
                        p = m.get("params") or {}
                        if "error" in p:  # lỗi trên kênh subscribe ⇒ reconnect
                            raise RuntimeError(str(p["error"])[:60])
                        v = p.get("result", {}).get("value", {})
                        if v.get("signature"):
                            # ponytail: process_sig đồng bộ trong event loop (chặn
                            # recv ~0.1–1s/tx) — đủ vì lượng tx/ví thấp; nghẽn thì
                            # đẩy sang to_thread + lock quanh st.
                            process_sig(v["signature"], wallets, st, v.get("err"))
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                k += 1
                print(
                    f"  ! ws đứt shard {sid + 1} ({type(e).__name__}: {str(e)[:70]})"
                    " -> key kế, reconnect sau 2s",
                    file=sys.stderr,
                )
                await asyncio.sleep(2)

    async def _run():
        # chỉ shard trên endpoint CHÍNH: default (publicnode/mainnet-beta) không
        # nhận logsSubscribe ⇒ shard thừa chỉ reconnect-loop (log cũ "ws đứt shard 7").
        eps = [u for u in RPCS if u not in RPC_DEFAULTS] or list(RPCS)
        slices = _ws_shards(wallets, len(eps))
        tasks = [asyncio.create_task(_beat_loop())]
        for sid, sliced in enumerate(slices):
            tasks.append(asyncio.create_task(_shard(sid, sliced, eps, len(slices))))
        await asyncio.gather(*tasks)

    asyncio.run(_run())


def main() -> None:
    global _cfg_cli_min_usd, _jsonl, _api_url, _track
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
        RPCS[:] = [u.strip() for u in rpc_url.split(",") if u.strip()] + list(
            RPC_DEFAULTS
        )

    wallets = load_lines(args.wallets)  # seed = nguồn file/CLI (fallback khi API chết)
    for line in load_lines(args.quotes):
        mn, _, sym = line.partition("=")
        if mn.strip():
            quotes_map[mn.strip()] = sym.strip() or mn.strip()[:6]
    _jsonl = args.jsonl
    _api_url = args.api_url.rstrip("/")
    _track = args.track
    _cfg_cli_min_usd = args.min_usd
    load_config_from_api(wallets)  # API hợp lệ override min_usd + wallets; fail-soft
    if not wallets:
        sys.exit(f"không có ví nào trong {args.wallets} hay {_api_url}/api/wallets")

    st = load_state()
    print(
        f"# watch {len(wallets)} ví | feed={args.feed} | {len(quotes_map)} quote-mints | min ${min_usd}"
    )
    print(f"# rpc {_mask(RPCS[0])}")
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


if __name__ == "__main__":
    main()
