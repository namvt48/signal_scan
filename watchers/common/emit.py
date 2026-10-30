"""Emit events to JSONL, the wallet-watch trades API, and console."""

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



def watch_trade_body(e, block_time=None) -> dict[str, Any] | None:
    """Build the single wallet trade ingest request used for attribution and CA admission.
    Unpriced BUYs remain eligible; only the server decides admission after deduplication.
    Return None when wallet, mint, signature or side is invalid.
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
    body = {
        "wallet": wallet,
        "chain": "sol",
        "ca": mint,
        "tx": sig,
        "ts": int((block_time if block_time is not None else time.time()) * 1000),
        "side": "sell" if e.get("side") == "SELL" else "buy",
        "provenance": e["provenance"],
    }
    if usd > 0:
        body["amountUsd"] = usd
        if qty > 0:
            body["price"] = usd / qty
    return body


def post_trade(trade: dict[str, Any]) -> bool:
    """POST one chain-aware trade; return False if the caller must retry."""
    trade = {"chain": "sol", **trade}
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/wallet-watch/trades",
            data=json.dumps(trade).encode(),
            headers=config.api_headers(),
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
        return True
    except urllib.error.HTTPError as ex:
        if ex.code == 409:
            return True
        print(
            f"  ! watch-trade {trade['ca'][:8]}…: HTTP {ex.code}",
            file=sys.stderr,
        )
        return False
    except Exception as ex:
        print(
            f"  ! watch-trade {trade['ca'][:8]}…: {type(ex).__name__}: {str(ex)[:60]}",
            file=sys.stderr,
        )
        return False


def watch_trade_event(e, block_time=None) -> bool:
    """POST a tracked-wallet trade; return delivery status for the source cursor."""
    if not config._track:
        return True
    body = watch_trade_body(e, block_time)
    if not body:
        return True
    return post_trade(body)


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
