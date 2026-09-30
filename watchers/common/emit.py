"""Emit sự kiện ra ngoài: JSONL (--jsonl), POST /api/tracked-cas, POST
/api/wallet-watch/trades (`post_trade` — seam chain-aware cho T8), và dòng
log console (`fmt`).

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import gzip
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from watchers.common import config

_jsonl = ""  # --jsonl PATH: ghi thêm mỗi sự kiện 1 dòng JSON (log machine-readable)


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
    """--track: POST CA của MỌI sự kiện trade — duyệt TỪNG TX, KHÔNG cache theo
    mint. Fail-soft — 201/409 = ok (409 = đã tracked), 400/lỗi mạng chỉ log
    stderr; không bao giờ raise để loop watch không chết. Server tự chống trùng
    (UNIQUE address,chain) và tự gate min-usd, nên client KHÔNG được nuốt TX:
    cache mint cũ (kể cả khi server trả 200 `skipped` below-min-usd) làm CA nhỏ
    "đầu độc" ⇒ buy lớn sau đó không bao giờ được track (bug 2026-09-30, CA
    4WPn…xhUU: 10 buy tx bị bỏ khỏi queue/dashboard)."""
    if not config._track:
        return
    body = track_post_body(e)
    if not body:
        return
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/tracked-cas",
            data=json.dumps(body).encode(),
            headers=config.api_headers(),
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


def post_trade(trade: dict[str, Any]) -> None:
    """POST 1 trade lên {api_url}/api/wallet-watch/trades — seam dùng chung cho MỌI
    chain (T8 EVM gọi lại y nguyên). Body do caller dựng; `chain` là field
    first-class (server tra wallet theo (address, chain)), thiếu ⇒ mặc định 'sol'
    (T4: tương thích daemon Sol cũ trong lúc rollout). Fail-soft: 2xx = ok
    (repost = 200 inserted 0 nhờ UNIQUE), lỗi mạng/HTTP chỉ log stderr, không bao
    giờ raise để loop watch không chết."""
    trade = {"chain": "sol", **trade}
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/wallet-watch/trades",
            data=json.dumps(trade).encode(),
            headers=config.api_headers(),
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception as ex:
        print(
            f"  ! watch-trade {trade['ca'][:8]}…: {type(ex).__name__}: {str(ex)[:60]}",
            file=sys.stderr,
        )


def watch_trade_event(e, block_time=None) -> None:
    """--track: POST 1 trade BUY cho cột `Tracked by`. Fail-soft y track_event —
    2xx = ok (repost = 200 inserted 0 nhờ UNIQUE(wallet, ca, tx, side)), lỗi
    mạng/HTTP chỉ log stderr, không bao giờ raise để loop watch không chết."""
    if not config._track:
        return
    body = watch_trade_body(e, block_time)
    if not body:
        return
    post_trade(body)


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
