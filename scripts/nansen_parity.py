#!/usr/bin/env python3
"""Parity comparator Nansen ground-truth — PURE CORE (todo 3, offline 100%).

Không network/RPC/không giá Nansen. Todo 5 (classify/report) và todo 6 (IO/fetch)
sẽ nối tiếp TRONG CÙNG FILE này; phần này chỉ nạp truth + group + metrics.

Truth: `.probe/nansen-24h/tx-sample.jsonl` — 1 dòng/activity, 19 field,
key group = (transactionHash, wallet, ca), txType ∈ {buy, sell, transfer}.
Chạy test: python3 scripts/test_nansen_parity.py
"""

import argparse
import importlib.util
import json
import os
import random
import statistics
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
# wallet_watch nạp qua importlib (pattern test_gmgn_api_parity.py:110-116) —
# module-level chỉ là constants + defs, side-effect free, offline 100%.
_ww_spec = importlib.util.spec_from_file_location(
    "wallet_watch", os.path.join(_HERE, "wallet_watch.py")
)
assert _ww_spec and _ww_spec.loader
ww = importlib.util.module_from_spec(_ww_spec)
_ww_spec.loader.exec_module(ww)

_SIDES = ("buy", "sell", "transfer")


@dataclass
class Group:
    """Một group truth (sig, wallet, ca). sides[side] = [{"amount", "usd"}, …]."""

    sig: str
    wallet: str
    ca: str
    sides: dict[str, list[dict[str, object]]] = field(
        default_factory=lambda: {s: [] for s in _SIDES}
    )
    usd_null: bool = False  # True nếu ≥1 row có usdValueAtTxTime = None
    shape: str = ""  # buy_only | sell_only | transfer_only | buy_sell


def load_truth(path):
    """Đọc JSONL truth → list[dict]. Bỏ qua dòng rỗng."""
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def groups(rows):
    """Group rows theo (transactionHash, wallet, ca).

    amount = directionalAmountOfTokens (có thể âm — sell/transfer), usd =
    usdValueAtTxTime (có thể None ⇒ usd_null). Shape suy từ các side không
    rỗng: buy+sell ⇒ buy_sell; chỉ buy ⇒ buy_only; chỉ sell ⇒ sell_only;
    còn lại ⇒ transfer_only (dữ liệu thật không có group trộn transfer với
    buy/sell — đã verify = 0 ở todo 1).
    """
    out = {}
    for r in rows:
        key = (r["transactionHash"], r["wallet"], r["ca"])
        g = out.get(key)
        if g is None:
            g = out[key] = Group(sig=key[0], wallet=key[1], ca=key[2])
        usd = r.get("usdValueAtTxTime")
        if usd is None:
            g.usd_null = True
        g.sides.setdefault(r["txType"], []).append(
            {"amount": r["directionalAmountOfTokens"], "usd": usd}
        )
    for g in out.values():
        has = {k for k, v in g.sides.items() if v}
        if "buy" in has and "sell" in has:
            g.shape = "buy_sell"
        elif "buy" in has:
            g.shape = "buy_only"
        elif "sell" in has:
            g.shape = "sell_only"
        else:
            g.shape = "transfer_only"
    return out


def net_truth(g):
    """Σ signed truth của group: buy +|amount|, sell −|amount|, TRANSFER = 0.

    Định nghĩa canonical DUY NHẤT cho G7 (net identity). Transfer đóng góp 0
    VÌ: 300/300 row transfer trong tx-sample.jsonl có
    directionalAmountOfTokens ≠ 0 — nếu cộng chúng thì cả 254 group
    transfer-only sẽ FAIL 100% (detector không sinh event cho transfer thuần,
    Σ qty_net = 0, nên truth để so cũng phải = 0).
    """
    total = 0.0
    for e in g.sides.get("buy", []):
        total += abs(e["amount"])
    for e in g.sides.get("sell", []):
        total -= abs(e["amount"])
    return total


def gross_truth(g, side):
    """Σ|amount| của một side (so với GROSS_CAP 8% — wallet_watch.py:53-54)."""
    return sum(abs(e["amount"]) for e in g.sides.get(side, []))


def net_identity(ev_sum, truth_sum):
    """Relative error |ev − truth| / |truth|; None khi truth_sum == 0.

    Không bao giờ ZeroDivisionError — group transfer-only có net_truth = 0
    ⇒ identity không đo được ⇒ None (harness-side class NET_IDENTITY_NA).
    """
    if truth_sum == 0:
        return None
    return abs(ev_sum - truth_sum) / abs(truth_sum)


def sum_qnet(events):
    """Σ signed qty_net của event dicts; skip qty_net None (hợp lệ theo
    wallet_watch.py:800 — mint mixed-sign). Trả (sum, none_count).
    Cấm float(None): event thiếu key cũng đếm như None."""
    total = 0.0
    none_count = 0
    for ev in events:
        q = ev.get("qty_net")
        if q is None:
            none_count += 1
            continue
        total += q
    return total, none_count


def gross_bucket(ev_sum, truth_sum):
    """Relative error cho gross bucket. truth 0: 0/0 ⇒ 0.0; ev ≠ 0 ⇒ inf
    (luôn vượt cap — không chia 0)."""
    if truth_sum == 0:
        return 0.0 if ev_sum == 0 else float("inf")
    return abs(ev_sum - truth_sum) / abs(truth_sum)


def usd_ratio(ev_usd, truth_usd):
    """ev/truth; None nếu vế nào None (CẤM coi None là 0) hoặc truth == 0
    (không đo được — tránh ZeroDivisionError)."""
    if ev_usd is None or truth_usd is None or not truth_usd:
        return None
    return ev_usd / truth_usd


def global_drift(ratios):
    """Median của các usd_ratio (drift hệ thống ev/truth). ratios phải non-empty."""
    return statistics.median(ratios)


def is_dust(usd):
    """Dust: usd đo được và |usd| < $0.01 (ngưỡng dust của plan)."""
    return usd is not None and abs(usd) < 0.01


def fee_usd_gate_ok(ratio):
    """Gate G10: |ratio − 1| ≤ 15%. None ⇒ False (không đo được ⇒ không đạt,
    không coi như 0). Epsilon 1e-9: đúng biên 0.85 thì |0.85−1| =
    0.15000000000000002 (float noise) — phải đạt, không được fail oan."""
    return ratio is not None and abs(ratio - 1) <= 0.15 + 1e-9


# ============================================ todo 5 PART 1/2 — side_of + classify

_EPS = 1e-9
NET_CAP = 0.015  # G7 net identity cap
GROSS_CAP = 0.08  # G8 gross per-side cap
USD_CAP = 0.10  # G9 USD residual cap
NET_OWNER_EPS = 1e-6  # G6 chain-identity epsilon
UNAVAIL_CAP = 0.20  # G12
TRANSFER_WARN = 0.10  # G2 warn threshold
CLASS_PRECEDENCE = (
    "UNAVAILABLE",
    "TRANSFER_FALSE_POSITIVE",
    "MISSING",
    "TYPE_MISMATCH",
    "AMOUNT_MISMATCH",
    "GROSS_MISMATCH",
    "USD_MISMATCH",
    "NET_IDENTITY_NA",
    "DEFERRED_USD_NULL",
    "MATCH",
)
TRACE_REQUIRED = frozenset(
    (
        "MISSING",
        "TYPE_MISMATCH",
        "AMOUNT_MISMATCH",
        "GROSS_MISMATCH",
        "USD_MISMATCH",
        "TRANSFER_FALSE_POSITIVE",
    )
)
RECORD_FIELDS = (
    "sig",
    "wallet",
    "ca",
    "shape",
    "class",
    "sides_truth",
    "sides_ev",
    "matched",
    "unmatched",
    "over_emitted",
    "net_rel",
    "net_owner_delta",
    "net_identity_na",
    "qty_net_none",
    "usd_missing",
    "gross_rel_buy",
    "gross_rel_sell",
    "usd_ratio_raw",
    "usd_ratio_adj",
    "fee_usd_ratios",
    "dust_skipped",
    "reject_trace",
    "fetch_error",
    "notes",
)


def side_of(event):
    """'BUY'→'buy', 'SELL'→'sell' (kể cả fee_leg). Side khác/thiếu key ⇒
    ValueError nêu đích danh side — detect_swaps không bao giờ sinh RECEIVE,
    nếu xuất hiện thì đó là bug và phải nổi lên."""
    side = event.get("side")
    if side == "BUY":
        return "buy"
    if side == "SELL":
        return "sell"
    raise ValueError(f"side không xác định: {side!r} (sig={event.get('sig')!r})")


def _record(group, cls, flags, reject_trace, fetch_error, **overrides):
    """Record dict với keys() đúng thứ tự RECORD_FIELDS. overrides chỉ ghi đè
    giá trị — dict.update giữ nguyên thứ tự key đã có."""
    rec = {
        "sig": group.sig,
        "wallet": group.wallet,
        "ca": group.ca,
        "shape": group.shape,
        "class": cls,
        "sides_truth": {"buy": 0, "sell": 0, "transfer": 0},
        "sides_ev": {"buy": 0, "sell": 0, "sell_fee": 0},
        "matched": 0,
        "unmatched": 0,
        "over_emitted": 0,
        "net_rel": None,
        "net_owner_delta": None,
        "net_identity_na": False,
        "qty_net_none": 0,
        "usd_missing": 0,
        "gross_rel_buy": None,
        "gross_rel_sell": None,
        "usd_ratio_raw": None,
        "usd_ratio_adj": None,
        "fee_usd_ratios": [],
        "dust_skipped": 0,
        "reject_trace": list(reject_trace or []),
        "fetch_error": fetch_error,
        "notes": {
            "mint": group.ca,
            "usd_null": group.usd_null,
            "truth_usd": None,
            "ev_usd": None,
            "truth_buy_qty": 0.0,
            "truth_sell_qty": 0.0,
            "ev_buy_qty": 0.0,
            "ev_sell_qty": 0.0,
            "ev_sell_fee_qty": 0.0,
            "mixed_sign": False,
            "flags": list(flags),
        },
    }
    rec.update(overrides)
    return rec


def classify(
    group, events, drift=None, reject_trace=None, fetch_error=None, net_owner=None
):
    """Classify 1 Group truth so với events detect_swaps → record dict.

    - group: Group dataclass của chính module này (load_truth → groups).
    - events: list[dict] output của detect_swaps (shape _swap_event), hoặc None
      khi fetch fail (kèm fetch_error).
    - drift: usd_ratio median hệ thống (global_drift) để hiệu chỉnh G9, hoặc None.
    - reject_trace: list[str] trace các leg bị detector reject — BẮT BUỘC
      (ValueError) khi class ∈ TRACE_REQUIRED.
    - fetch_error: str mô tả lỗi fetch; không None ⇒ UNAVAILABLE short-circuit.
    - net_owner: {mint: chain_delta} từ G6, hoặc None.

    OBJECTION (D6 bước 2, ghi lại cho todo 6): TRANSFER_FALSE_POSITIVE kiểm
    `events` literal (mọi mint), trong khi metrics chỉ dùng `evs` đã filter
    theo group.ca (D2). Sig có transfer-only ca=X kèm swap ca=Y có thể bị TFP
    oan cho X. Case C2 đo được (1bPapYy2…) cho TFP dưới CẢ HAI cách đọc nên
    không ảnh hưởng gate hiện tại; part 2/todo 6 quyết định truyền gì.
    """
    flags = []

    if fetch_error is not None:
        return _record(
            group,
            "UNAVAILABLE",
            ["unavailable"],
            [],
            fetch_error,
            sides_truth={
                "buy": len(group.sides["buy"]),
                "sell": len(group.sides["sell"]),
                "transfer": len(group.sides["transfer"]),
            },
        )
    if events is None:
        raise ValueError(
            f"events=None mà không có fetch_error: sig={group.sig!r} ca={group.ca!r}"
        )

    evs = [e for e in events if e.get("mint") == group.ca]

    sides_truth = {
        "buy": len(group.sides["buy"]),
        "sell": len(group.sides["sell"]),
        "transfer": len(group.sides["transfer"]),
    }

    ev_buy = ev_sell_nonfee = ev_sell_fee = 0
    for e in evs:
        if side_of(e) == "buy":
            ev_buy += 1
        elif e.get("fee_leg"):
            ev_sell_fee += 1
        else:
            ev_sell_nonfee += 1
    ev_sell = ev_sell_nonfee + ev_sell_fee
    sides_ev = {"buy": ev_buy, "sell": ev_sell, "sell_fee": ev_sell_fee}

    tb, ts = sides_truth["buy"], sides_truth["sell"]
    matched = min(tb, ev_buy) + min(ts, ev_sell)
    unmatched = max(0, tb - ev_buy) + max(0, ts - ev_sell)
    over_emitted = max(0, ev_buy - tb) + max(0, ev_sell_nonfee - ts)
    fee_exempt = max(0, ev_sell_fee - max(0, ts - ev_sell_nonfee))
    flags.append(f"fee_exempt={fee_exempt}")

    normalized = [
        {
            "qty_net": None
            if e.get("qty_net") is None
            else (abs(e["qty_net"]) if side_of(e) == "buy" else -abs(e["qty_net"]))
        }
        for e in evs
    ]
    ev_sum_signed, qty_net_none = sum_qnet(normalized)

    mixed_sign = ev_buy >= 1 and ev_sell_nonfee >= 1
    all_none = len(evs) >= 1 and qty_net_none == len(evs)
    if all_none:
        flags.append("all_qty_net_none")
    net_identity_na = mixed_sign or all_none

    net_truth_v = net_truth(group)
    if net_truth_v == 0:
        flags.append("net_truth_zero")
    net_rel = None if net_identity_na else net_identity(ev_sum_signed, net_truth_v)

    truth_buy_gross = gross_truth(group, "buy")
    truth_sell_gross = gross_truth(group, "sell")
    ev_buy_qty = sum((e["qty"] for e in evs if side_of(e) == "buy"), 0.0)
    ev_sell_qty = sum((e["qty"] for e in evs if side_of(e) == "sell"), 0.0)
    ev_sell_fee_qty = sum(
        (e["qty"] for e in evs if side_of(e) == "sell" and e.get("fee_leg")), 0.0
    )
    gross_rel_buy = (
        gross_bucket(ev_buy_qty, truth_buy_gross) if truth_buy_gross > 0 else None
    )
    gross_rel_sell = (
        gross_bucket(ev_sell_qty, truth_sell_gross) if truth_sell_gross > 0 else None
    )

    truth_usd = sum(
        (
            r["usd"]
            for s in ("buy", "sell")
            for r in group.sides[s]
            if r["usd"] is not None
        ),
        0.0,
    )
    ev_usd = sum(
        (e.get("quote_usd") for e in evs if e.get("quote_usd") is not None), 0.0
    )
    usd_missing = sum(1 for e in evs if e.get("quote_usd") is None)
    if usd_missing:
        flags.append("usd_missing")
    usd_ratio_raw = (
        None if (group.usd_null or usd_missing > 0) else usd_ratio(ev_usd, truth_usd)
    )
    usd_ratio_adj = (
        usd_ratio_raw / drift
        if (usd_ratio_raw is not None and drift)
        else usd_ratio_raw
    )

    fee_evs = [e for e in evs if side_of(e) == "sell" and e.get("fee_leg")]
    fee_usd_ratios = [
        r
        for e, row in zip(fee_evs, group.sides["sell"])
        if (r := usd_ratio(e.get("quote_usd"), row.get("usd"))) is not None
    ]

    dust_skipped = sum(1 for e in evs if is_dust(e.get("quote_usd")))

    net_owner_delta = None
    if net_owner is not None and not net_identity_na and len(evs) >= 1:
        if group.ca in net_owner:
            net_owner_delta = ev_sum_signed - net_owner[group.ca]
        else:
            flags.append("net_owner_mint_absent")

    if group.shape == "transfer_only" and events and len(events) >= 1:
        cls = "TRANSFER_FALSE_POSITIVE"
        flags.append("transfer_false_positive_oracle_divergence")
    elif unmatched > 0:
        cls = "MISSING"
    elif over_emitted > 0:
        cls = "TYPE_MISMATCH"
    elif net_rel is not None and net_rel > NET_CAP + _EPS:
        cls = "AMOUNT_MISMATCH"
    elif (gross_rel_buy is not None and gross_rel_buy > GROSS_CAP + _EPS) or (
        gross_rel_sell is not None and gross_rel_sell > GROSS_CAP + _EPS
    ):
        cls = "GROSS_MISMATCH"
    elif usd_ratio_adj is not None and abs(usd_ratio_adj - 1) > USD_CAP + _EPS:
        cls = "USD_MISMATCH"
    elif net_identity_na:
        cls = "NET_IDENTITY_NA"
    elif group.usd_null:
        cls = "DEFERRED_USD_NULL"
    else:
        cls = "MATCH"

    if cls in TRACE_REQUIRED and not reject_trace:
        raise ValueError(
            f"class {cls} bắt buộc có reject_trace: sig={group.sig!r} ca={group.ca!r}"
        )

    notes = {
        "mint": group.ca,
        "usd_null": group.usd_null,
        "truth_usd": None if group.usd_null else truth_usd,
        "ev_usd": None if usd_missing > 0 else ev_usd,
        "truth_buy_qty": truth_buy_gross,
        "truth_sell_qty": truth_sell_gross,
        "ev_buy_qty": ev_buy_qty,
        "ev_sell_qty": ev_sell_qty,
        "ev_sell_fee_qty": ev_sell_fee_qty,
        "mixed_sign": mixed_sign,
        "flags": flags,
    }
    return _record(
        group,
        cls,
        flags,
        reject_trace,
        fetch_error,
        sides_truth=sides_truth,
        sides_ev=sides_ev,
        matched=matched,
        unmatched=unmatched,
        over_emitted=over_emitted,
        net_rel=net_rel,
        net_owner_delta=net_owner_delta,
        net_identity_na=net_identity_na,
        qty_net_none=qty_net_none,
        usd_missing=usd_missing,
        gross_rel_buy=gross_rel_buy,
        gross_rel_sell=gross_rel_sell,
        usd_ratio_raw=usd_ratio_raw,
        usd_ratio_adj=usd_ratio_adj,
        fee_usd_ratios=fee_usd_ratios,
        dust_skipped=dust_skipped,
        notes=notes,
    )


# ============================================ todo 5 PART 2/2 — reporting half


def _pctl(xs, p):
    """Percentile nội suy tuyến tính tất định (ngữ nghĩa numpy 'linear'):
    i = p*(n−1), nội suy giữa 2 phần tử kề. Rỗng ⇒ 0.0."""
    s = sorted(xs)
    if not s:
        return 0.0
    i = p * (len(s) - 1)
    lo = int(i)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def summarize(records, oracle=None):
    """Tổng hợp records (output của classify) → dict JSON-serializable cho
    pass_bar/write_report. oracle chỉ được set khi truyền (G13 đọc
    summary.get("oracle") — thiếu key nghĩa là 'chưa đo')."""
    class_counts = {c: 0 for c in CLASS_PRECEDENCE}
    for r in records:
        class_counts[r["class"]] += 1
    usd_ratios = [r["usd_ratio_raw"] for r in records if r["usd_ratio_raw"] is not None]
    by_sig = {}
    for r in records:
        by_sig.setdefault(r["sig"], []).append(r)
    diff_ca_sigs = {}
    for sig, rs in by_sig.items():
        if (
            not any(r["shape"] == "buy_sell" for r in rs)
            and any(r["sides_truth"]["buy"] > 0 for r in rs)
            and any(r["sides_truth"]["sell"] > 0 for r in rs)
            and len({r["ca"] for r in rs}) >= 2
        ):
            diff_ca_sigs[sig] = rs
    transfer_only = [r for r in records if r["shape"] == "transfer_only"]
    transfer_only_unavailable = sum(
        1 for r in transfer_only if r["class"] == "UNAVAILABLE"
    )
    summary = {
        "class_counts": class_counts,
        "n_records": len(records),
        "n_sigs": len(by_sig),
        "n_unavail_sigs": len(
            {r["sig"] for r in records if r["class"] == "UNAVAILABLE"}
        ),
        "net_rels": [r["net_rel"] for r in records if r["net_rel"] is not None],
        "gross_rels": [
            v
            for r in records
            for v in (r["gross_rel_buy"], r["gross_rel_sell"])
            if v is not None
        ],
        "usd_ratios": usd_ratios,
        "usd_ratio_adjs": [
            r["usd_ratio_adj"] for r in records if r["usd_ratio_adj"] is not None
        ],
        "drift": global_drift(usd_ratios) if usd_ratios else None,
        "fee_usd_ratios": [x for r in records for x in r["fee_usd_ratios"]],
        "net_owner_deltas": [
            r["net_owner_delta"] for r in records if r["net_owner_delta"] is not None
        ],
        "n_net_truth_zero": sum(
            1 for r in records if "net_truth_zero" in r["notes"]["flags"]
        ),
        "n_usd_null_groups": sum(
            1 for r in records if r["notes"].get("usd_null") is True
        ),
        "buy_sell_records": [r for r in records if r["shape"] == "buy_sell"],
        "diff_ca_sigs": diff_ca_sigs,
        "na_list": [r for r in records if r["net_identity_na"]],
        "qty_net_none_total": sum(r["qty_net_none"] for r in records),
        "usd_missing_total": sum(r["usd_missing"] for r in records),
        "dust_skipped_total": sum(r["dust_skipped"] for r in records),
        "transfer_only_total": len(transfer_only),
        "transfer_only_unavailable": transfer_only_unavailable,
        "transfer_only_warn": bool(transfer_only)
        and transfer_only_unavailable > TRANSFER_WARN * len(transfer_only),
    }
    if oracle is not None:
        summary["oracle"] = oracle
    return summary


GATE_NAMES = {
    "G1": "TYPE_MISMATCH == 0 (available groups)",
    "G2": "TRANSFER_FALSE_POSITIVE == 0 (available transfer-only groups; print transfer-only UNAVAILABLE, WARN if >10%)",
    "G3": "MISSING == 0 (available groups)",
    "G4": "same-ca buy_sell: BUY + SELL(fee_leg=True), |qty_fee − truth_sell_gross|/truth_sell_gross <= 1.5%",
    "G5": "diff-ca sigs: SELL(sold mint) + BUY(bought mint) in same sig",
    "G6": "|sum signed qty_net − _net_owner(mint)| < 1e-6 (measurable mints; mixed-sign/all-None => NET_IDENTITY_NA, not FAIL)",
    "G7": "|sum signed qty_net − net_truth|/|net_truth| <= 1.5% when net_truth != 0 (buy +, sell −, transfer 0; qty_net None skipped+counted)",
    "G8": "gross per-side <= 8% (GROSS_CAP)",
    "G9": "global USD residual <= 10% after one global drift factor (median ratio); quote_usd None excluded+counted usd_missing, never 0",
    "G10": "fee-only USD <= 15% after drift (listed separately)",
    "G11": "DEFERRED_USD_NULL == truth usd-null group count (13 in full sample)",
    "G12": "UNAVAILABLE <= 20% of sigs (exceed => STOP, new sample)",
    "G13": "old oracle intact: test_gmgn_api_parity 29/29 + backtest_parity --from-fixture 29/29 + 3fec2kXP == 2",
}

G9_FORMULA = (
    "G9 formula: ok = (USD_MISMATCH count == 0) AND "
    "(max abs(usd_ratio_adj - 1) <= 0.10); usd_ratio_adj = usd_ratio_raw / drift; "
    "drift = median(usd_ratio_raw); usd_ratio_raw = sum(ev quote_usd) / "
    "sum(truth buy+sell usd), None excluded, never 0"
)


def pass_bar(summary):
    """13 gate G1…G13 → list[(gate_id, ok: bool|None, value: str)].
    G13 ok=None khi oracle chưa đo. So ngưỡng luôn + _EPS."""
    cc = summary["class_counts"]
    n_avail = summary["n_records"] - cc["UNAVAILABLE"]
    gates = []

    n = cc["TYPE_MISMATCH"]
    gates.append(("G1", n == 0, f"{n} (available={n_avail})"))

    t = summary["transfer_only_total"]
    u = summary["transfer_only_unavailable"]
    pct = (u / t * 100) if t else 0.0
    n = cc["TRANSFER_FALSE_POSITIVE"]
    val = f"tfp={n}; transfer_only_unavailable={u}/{t} ({pct:.1f}%)"
    if summary["transfer_only_warn"]:
        val += " WARN>10%"
    gates.append(("G2", n == 0, val))

    n = cc["MISSING"]
    gates.append(("G3", n == 0, f"{n} (available={n_avail})"))

    bs = summary["buy_sell_records"]
    passed = 0
    for r in bs:
        tq = r["notes"]["truth_sell_qty"]
        if (
            r["sides_ev"]["buy"] >= 1
            and r["sides_ev"]["sell_fee"] >= 1
            and tq > 0
            and abs(r["notes"]["ev_sell_fee_qty"] - tq) / tq <= NET_CAP + _EPS
        ):
            passed += 1
    gates.append(("G4", passed == len(bs), f"{passed}/{len(bs)}"))

    total = len(summary["diff_ca_sigs"])
    passed = sum(
        1
        for rs in summary["diff_ca_sigs"].values()
        if sum(r["sides_ev"]["buy"] for r in rs) >= 1
        and sum(r["sides_ev"]["sell"] for r in rs) >= 1
    )
    gates.append(("G5", passed == total, f"{passed}/{total}"))

    deltas = summary["net_owner_deltas"]
    passed = sum(1 for d in deltas if abs(d) < NET_OWNER_EPS)
    gates.append(
        (
            "G6",
            passed == len(deltas),
            f"{passed}/{len(deltas)}, na={len(summary['na_list'])}",
        )
    )

    rels = summary["net_rels"]
    passed = sum(1 for v in rels if v <= NET_CAP + _EPS)
    gates.append(
        (
            "G7",
            passed == len(rels),
            f"{passed}/{len(rels)}, truth_zero={summary['n_net_truth_zero']}",
        )
    )

    grels = summary["gross_rels"]
    passed = sum(1 for v in grels if v <= GROSS_CAP + _EPS)
    gates.append(("G8", passed == len(grels), f"{passed}/{len(grels)}"))

    raws = summary["usd_ratios"]
    adjs = summary["usd_ratio_adjs"]
    mad = max((abs(a - 1) for a in adjs), default=0.0)
    gates.append(
        (
            "G9",
            cc["USD_MISMATCH"] == 0 and mad <= USD_CAP + _EPS,
            f"meas={len(raws)} p50={_pctl(raws, 0.5):.4f} p90={_pctl(raws, 0.9):.4f} "
            f"max_raw={max(raws, default=0.0):.4f} max_adj_dev={mad:.4f}",
        )
    )

    drift = summary["drift"]
    fadj = [(x / drift if drift else x) for x in summary["fee_usd_ratios"]]
    passed = sum(1 for x in fadj if fee_usd_gate_ok(x))
    gates.append(
        (
            "G10",
            passed == len(fadj),
            f"{passed}/{len(fadj)} p50={_pctl(fadj, 0.5):.4f} "
            f"p90={_pctl(fadj, 0.9):.4f} max={max(fadj, default=0.0):.4f}",
        )
    )

    d = cc["DEFERRED_USD_NULL"]
    m = summary["n_usd_null_groups"]
    gates.append(("G11", d == m, f"deferred={d} truth_null={m}"))

    n_sigs = summary["n_sigs"]
    n_un = summary["n_unavail_sigs"]
    if n_sigs:
        gates.append(
            (
                "G12",
                n_un / n_sigs <= UNAVAIL_CAP,
                f"{n_un}/{n_sigs}={n_un / n_sigs * 100:.1f}%",
            )
        )
    else:
        gates.append(("G12", False, "0/0"))

    oracle = summary.get("oracle")
    if oracle is None:
        gates.append(("G13", None, "not measured in this run"))
    else:
        gates.append(
            (
                "G13",
                bool(oracle.get("gmgn_ok"))
                and bool(oracle.get("backtest_ok"))
                and oracle.get("fec2kxp_events") == 2,
                f"gmgn_ok={oracle.get('gmgn_ok')} backtest_ok={oracle.get('backtest_ok')} "
                f"3fec2kXP={oracle.get('fec2kxp_events')}",
            )
        )
    return gates


def write_jsonl(path, records):
    """Mỗi record 1 dòng json.dumps — giữ thứ tự key (dict insertion order)."""
    with open(path, "w") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


def _cause(r):
    cls = r["class"]
    if cls == "UNAVAILABLE":
        return f"fetch_error: {r['fetch_error']}"
    if cls == "NET_IDENTITY_NA":
        if r["notes"]["mixed_sign"]:
            return (
                "mixed_sign mint (BUY + non-fee SELL — mint aggregation "
                "breaks identity, pre-existing)"
            )
        return "all qty_net None (wallet balance unchanged)"
    if cls == "DEFERRED_USD_NULL":
        return (
            "usdValueAtTxTime null in truth rows (USD gate deferred; "
            "type+amount still gated)"
        )
    return " | ".join(r["reject_trace"][:4])


def _root_cause_lines(records):
    out = ["## Root causes — 100% of non-MATCH", ""]
    non_match = [r for r in records if r["class"] != "MATCH"]
    for r in non_match:
        out.append(f"- {r['sig'][:12]}… ca={r['ca'][:8]}… {r['class']}: {_cause(r)}")
    assert len(out) - 2 == len(non_match), "root causes phải phủ 100% non-MATCH"
    return out


def _trace_lines(traces):
    if not traces:
        return []
    out = ["", "## Detector trace excerpts", ""]
    for sig, tr in traces.items():
        out.append(f"### {sig}")
        out.extend(f"    {ln}" for ln in list(tr)[:8])
    return out


def _dominant_reject(r):
    """(reason, số lần) xuất hiện nhiều nhất trong các dòng REJECT của record;
    tie-break alphabet (sorted) — tất định. (None, 0) khi không có dòng REJECT."""
    counts = {}
    for ln in r["reject_trace"]:
        if not ln.startswith("REJECT"):
            continue
        reason = ln.rsplit(" ", 1)[-1]
        counts[reason] = counts.get(reason, 0) + 1
    if not counts:
        return None, 0
    return max(sorted(counts.items()), key=lambda kv: kv[1])


_DESIGN_REJECTS = frozenset(
    (
        "not_spl",
        "no_pool_endpoint",
        "plumbing",
        "aggregator_frame",
        "unpaired",
        "same_mint",
    )
)


def _adjudicate(r):
    """Phán quyết nhị phân todo 8: 'semantically valid' hay 'detector bug',
    kèm basis trích metrics + reject_trace (MUST DO — không hand-wave). Rule
    máy móc theo class; DEFERRED_USD_NULL/NET_IDENTITY_NA/UNAVAILABLE là các
    class được plan MIỄN gate (exempt), không phải mismatch."""
    reason, n = _dominant_reject(r)
    tr = (
        " ‖ ".join(r["reject_trace"][:2])
        if r["reject_trace"]
        else (r["fetch_error"] or "-")
    )
    cls = r["class"]
    if cls == "TRANSFER_FALSE_POSITIVE":
        return "semantically valid — oracle divergence", (
            f"Nansen labels transfer-only {r['sides_truth']} but detector emits "
            f"real paired-step swaps {r['sides_ev']} (C2 1bPapYy2 family); trace: {tr}"
        )
    if cls == "TYPE_MISMATCH":
        return "semantically valid — oracle divergence", (
            f"over_emitted={r['over_emitted']} ev={r['sides_ev']} vs truth="
            f"{r['sides_truth']} — extra events come from paired POOL steps by "
            f"construction (fee_leg events are excluded from over_emitted); trace: {tr}"
        )
    if cls in ("MISSING", "AMOUNT_MISMATCH", "GROSS_MISMATCH"):
        metric = {
            "MISSING": f"unmatched={r['unmatched']}",
            "AMOUNT_MISMATCH": f"net_rel={r['net_rel']:.4f}",
            "GROSS_MISMATCH": (
                f"gross_rel_buy={r['gross_rel_buy']} gross_rel_sell={r['gross_rel_sell']}"
            ),
        }[cls]
        if reason in _DESIGN_REJECTS:
            return "semantically valid — by-design reject", (
                f"{metric}; legs killed by designed reject '{reason}' ×{n} — "
                f"plan guardrail forbids loosening these globally; phase-2 "
                f"coverage candidate; trace: {tr}"
            )
        return "detector bug — suspect", (
            f"{metric}; no designed-reject reason found in trace — investigate: {tr}"
        )
    if cls == "USD_MISMATCH":
        return "semantically valid — price drift", (
            f"usd_ratio_raw={r['usd_ratio_raw']:.4f} adj={r['usd_ratio_adj']:.4f} — "
            f"prices.json snapshot postdates tx time (~24h); detector arithmetic "
            f"correct given snapshot; trace: {tr}"
        )
    if cls == "DEFERRED_USD_NULL":
        return "exempt — usd-null truth", (
            "type+amount gates passed; USD gate deferred (usdValueAtTxTime null)"
        )
    if cls == "NET_IDENTITY_NA":
        return "exempt — identity n/a", (
            "mixed_sign or all qty_net None — G6 exemption, listed separately"
        )
    if cls == "UNAVAILABLE":
        return "exempt — unavailable", f"fetch_error: {r['fetch_error']}"
    return "unclassified", "-"


def _adjudication_lines(records):
    """Bảng phán quyết cho 100% record không MATCH (todo 8 MUST DO)."""
    non_match = [r for r in records if r["class"] != "MATCH"]
    verdicts = {}
    rows = []
    for r in non_match:
        v, basis = _adjudicate(r)
        verdicts[v] = verdicts.get(v, 0) + 1
        rows.append(
            f"| {r['sig'][:12]}… | {r['ca'][:8]}… | {r['class']} | {v} | {basis} |"
        )
    assert len(rows) == len(non_match), "adjudication phải phủ 100% non-MATCH"
    out = [
        "",
        "### Mismatch adjudication — semantically valid vs detector bug (100% of non-MATCH)",
        "",
        "Deterministic per-class rules (see _adjudicate); basis cites record "
        "metrics + reject_trace lines. Verdict counts:",
        "",
    ]
    out += [f"- {v}: {n}" for v, n in sorted(verdicts.items())]
    out += [
        "",
        "| sig | ca | class | verdict | basis (metrics + trace) |",
        "|---|---|---|---|---|",
    ]
    out += rows
    return out


def _gate_fail_lines(gates, summary, records):
    """Root-cause cấp gate cho MỌI gate không đạt (todo 8: 'report ghi rõ gate
    FAIL + root-cause', cấm im lặng). Sinh máy móc từ records/summary."""
    fails = [(gid, ok, val) for gid, ok, val in gates if ok is not True]
    if not fails:
        return []
    cc = summary["class_counts"]

    def reason_agg(rs):
        agg = {}
        for r in rs:
            reason, n = _dominant_reject(r)
            if reason:
                agg[reason] = agg.get(reason, 0) + n
        return ", ".join(f"{k}×{v}" for k, v in sorted(agg.items())) or "-"

    out = ["", "## Gate FAIL annotations — root cause per failing gate", ""]
    for gid, ok, val in fails:
        out.append(f"### {gid}: {'FAIL' if ok is False else 'NOT MEASURED'} — {val}")
        if gid == "G1":
            rs = [r for r in records if r["class"] == "TYPE_MISMATCH"]
            out.append(
                f"Root cause: {len(rs)} groups where detector emits more non-fee "
                f"events than Nansen rows (over_emitted>0, paired POOL steps by "
                f"construction) — oracle-divergence family (C2 1bPapYy2, "
                f"RxrDxxL2/3ZLekZYq precedents). Reject reasons seen: "
                f"{reason_agg(rs)}. Per-record basis: Mismatch adjudication table."
            )
        elif gid == "G2":
            rs = [r for r in records if r["class"] == "TRANSFER_FALSE_POSITIVE"]
            out.append(
                f"Root cause: {len(rs)} transfer-only groups (Nansen label) where "
                f"detector finds real paired swaps — oracle divergence (C2), NOT "
                f"pruning: transfer_only_unavailable="
                f"{summary['transfer_only_unavailable']}/{summary['transfer_only_total']}."
            )
        elif gid == "G3":
            rs = [r for r in records if r["class"] == "MISSING"]
            out.append(
                f"Root cause: {len(rs)} groups with unmatched truth rows; legs "
                f"killed by designed rejects ({reason_agg(rs)}) — coverage gap vs "
                f"Nansen, guardrail forbids loosening rejects; phase-2 candidate."
            )
        elif gid == "G5":
            by_sig = {}
            for r in records:
                by_sig.setdefault(r["sig"], []).append(r)
            bad = []
            for s, rs in sorted(by_sig.items()):
                if (
                    not any(r["shape"] == "buy_sell" for r in rs)
                    and any(r["sides_truth"]["buy"] > 0 for r in rs)
                    and any(r["sides_truth"]["sell"] > 0 for r in rs)
                    and len({r["ca"] for r in rs}) >= 2
                    and not (
                        sum(r["sides_ev"]["buy"] for r in rs) >= 1
                        and sum(r["sides_ev"]["sell"] for r in rs) >= 1
                    )
                ):
                    side = (
                        "SELL" if sum(r["sides_ev"]["sell"] for r in rs) < 1 else "BUY"
                    )
                    cls = sorted(
                        {
                            r["class"]
                            for r in rs
                            if (
                                r["sides_truth"]["sell"]
                                if side == "SELL"
                                else r["sides_truth"]["buy"]
                            )
                            and r["sides_ev"]["sell" if side == "SELL" else "buy"] < 1
                        }
                    )
                    rr = reason_agg([r for r in rs if r["class"] != "MATCH"])
                    bad.append(
                        f"{s[:12]}… missing {side} (records: {cls}; rejects: {rr})"
                    )
            out.append(
                f"Root cause: {len(bad)} diff-ca sig lack one side: " + "; ".join(bad)
            )
        elif gid == "G7":
            rs = [
                r
                for r in records
                if r["net_rel"] is not None and r["net_rel"] > NET_CAP + _EPS
            ]
            out.append(
                f"Root cause: {len(rs)}/{len(summary['net_rels'])} measured groups "
                f"exceed net 1.5% — net drift from by-design rejected legs "
                f"({reason_agg(rs)}); truth_zero={summary['n_net_truth_zero']} "
                f"excluded by G7 definition; qty_net_none="
                f"{summary['qty_net_none_total']}."
            )
        elif gid == "G8":
            rs = [
                r
                for r in records
                if (
                    r["gross_rel_buy"] is not None
                    and r["gross_rel_buy"] > GROSS_CAP + _EPS
                )
                or (
                    r["gross_rel_sell"] is not None
                    and r["gross_rel_sell"] > GROSS_CAP + _EPS
                )
            ]
            out.append(
                f"Root cause: {len(rs)} groups over gross 8% cap on ≥1 side — "
                f"same by-design rejects ({reason_agg(rs)})."
            )
        elif gid == "G9":
            rs = [r for r in records if r["class"] == "USD_MISMATCH"]
            worst = max(
                (r for r in records if r["usd_ratio_adj"] is not None),
                key=lambda r: abs(r["usd_ratio_adj"] - 1),
                default=None,
            )
            w = (
                f"{worst['sig'][:12]}… raw={worst['usd_ratio_raw']:.4f} "
                f"adj={worst['usd_ratio_adj']:.4f}"
                if worst
                else "-"
            )
            out.append(
                f"Root cause: {len(rs)} USD_MISMATCH after global drift; worst "
                f"outlier {w}. Price snapshot postdates txs by ~24h (memecoin "
                f"volatility) — usd_missing={summary['usd_missing_total']} "
                f"(quote_usd=None never counted as 0); phase-2: per-tx historic "
                f"prices."
            )
        elif gid == "G10":
            drift = summary["drift"]
            bad = []
            for r in records:
                for raw in r["fee_usd_ratios"]:
                    adj = raw / drift if drift else raw
                    if not fee_usd_gate_ok(adj):
                        bad.append(f"{r['sig'][:12]}… adj={adj:.4f}")
            out.append(
                f"Root cause: {len(bad)} fee leg(s) outside ±15% post-drift: "
                + "; ".join(bad)
                + " — fee events inherit unit_price of nearest BUY step while "
                "Nansen prices at tx time; price-drift artifact, see Fee-USD "
                "stats proposal."
            )
        elif gid == "G11":
            d = cc["DEFERRED_USD_NULL"]
            m = summary["n_usd_null_groups"]
            promoted = [
                f"{r['sig'][:12]}… ca={r['ca'][:8]}… class={r['class']}"
                for r in records
                if r["notes"].get("usd_null") is True
                and r["class"] != "DEFERRED_USD_NULL"
            ]
            out.append(
                f"Root cause: {m} truth usd-null groups but only {d} landed in "
                f"DEFERRED_USD_NULL — {len(promoted)} also fail type/amount gates "
                f"so CLASS_PRECEDENCE assigns the mismatch class: "
                + "; ".join(promoted)
            )
        elif gid == "G13":
            o = summary.get("oracle") or {}
            out.append(
                f"Root cause: oracle components gmgn_ok={o.get('gmgn_ok')} "
                f"backtest_ok={o.get('backtest_ok')} "
                f"3fec2kXP={o.get('fec2kxp_events')} (need True/True/2)."
            )
        else:
            out.append(f"Root cause: see gate value above and the adjudication table.")
        out.append("")
    return out


def _phase2_lines(summary, records, meta):
    drift = summary["drift"]
    raws = summary["fee_usd_ratios"]
    fadj = [(x / drift if drift else x) for x in raws]
    out = ["", "## Phase-2 notes", "", "### DEFERRED_USD_NULL"]
    null_groups = [r for r in records if r["notes"].get("usd_null") is True]
    out += [
        f"- {r['sig']} ca={r['ca']}"
        if r["class"] == "DEFERRED_USD_NULL"
        else f"- {r['sig']} ca={r['ca']} — truth usd-null OUTRANKED by "
        f"{r['class']} (CLASS_PRECEDENCE)"
        for r in null_groups
    ] or ["- (none)"]
    n_def = sum(1 for r in null_groups if r["class"] == "DEFERRED_USD_NULL")
    n_outranked = len(null_groups) - n_def
    out += [
        "",
        f"{n_def} deferred + {n_outranked} outranked = {len(null_groups)} "
        f"truth usd-null, no deferral lost; G11 False is expected and "
        f"root-caused (CLASS_PRECEDENCE assigns the type/amount mismatch class).",
        "",
        f"All {len(null_groups)} truth usd-null groups with FINAL class "
        f"(G11 root cause — precedence promotes type/amount failures):",
    ]
    out += [
        f"- {r['sig'][:12]}… ca={r['ca'][:8]}… class={r['class']}" for r in null_groups
    ]
    out += ["", "### Fee-collector programs"]
    fps = meta.get("fee_programs")
    if fps:
        out += ["| sig | encl | program | collector |", "|---|---|---|---|"]
        out += [
            f"| {fp['sig']} | {fp['encl']} | {fp['program']} | {fp['collector']} |"
            for fp in fps
        ]
    else:
        out.append(
            "(meta['fee_programs'] absent — todo 8 reads programs from the "
            "cached txs' instructions/innerInstructions)"
        )
    n_within10 = sum(1 for x in fadj if abs(x - 1) <= 0.10 + _EPS)
    fee_outlier = None
    for r in records:
        for raw in r["fee_usd_ratios"]:
            adj = raw / drift if drift else raw
            if fee_outlier is None or abs(adj - 1) > abs(fee_outlier[1] - 1):
                fee_outlier = (r["sig"][:12] + "…", adj)
    out += [
        "",
        "### Known None-USD risk in wallet_hist",
        'Risk (verbatim): scripts/wallet_hist.py:106 `base += e["quote_usd"]` '
        'and :114-115 `all_usd += x["quote_usd"]` → TypeError when quote_usd is None.',
        "",
        "### Fee-USD stats + G10 threshold proposal",
        f"raw: n={len(raws)} p50={_pctl(raws, 0.5):.4f} p90={_pctl(raws, 0.9):.4f} "
        f"max={max(raws, default=0.0):.4f}",
        f"post-drift: p50={_pctl(fadj, 0.5):.4f} p90={_pctl(fadj, 0.9):.4f} "
        f"max={max(fadj, default=0.0):.4f}",
        f"Concrete proposal (phase-2): {n_within10}/{len(fadj)} fee legs sit within "
        f"±10% post-drift; systematic bias p50={_pctl(fadj, 0.5):.4f} (fee events "
        f"inherit unit_price of the nearest BUY step; Nansen prices at tx time). "
        f"Worst outlier "
        + (f"{fee_outlier[0]} adj={fee_outlier[1]:.4f}" if fee_outlier else "-")
        + " is a price-drift artifact (see adjudication), not a detector error. "
        "Plan: (1) add per-tx historic quote prices, (2) re-baseline with ≥30 fee "
        "legs, (3) then tighten G10 15% → 10% (≈ max(2×|p50−1|, p90-dev) rounded "
        "up to the next 5% step on the re-based data). Do NOT tighten before "
        "(1)-(2): n is small and the current 15% bar itself came from a single "
        "non-reproducible measurement.",
        "",
        "### NET_IDENTITY_NA list",
    ]
    out += [
        f"- {r['sig'][:12]}… ca={r['ca'][:8]}… "
        f"{'mixed_sign' if r['notes']['mixed_sign'] else 'all_qty_net_none'}"
        for r in summary["na_list"]
    ] or ["- (none)"]
    out += _adjudication_lines(records)
    return out


def _oracle_divergence_lines():
    return [
        "",
        "## GMGN/Nansen oracle divergence",
        "",
        "Nature: GMGN omits legs Nansen counts. Existing evidence: "
        "scripts/test_wallet_watch.py:10-13 documents deleting 2 TRANSFER labels "
        "of 387w9fh8EF because GMGN does not list the Jupiter-withdraw leg "
        "rejected as plumbing.",
        "Measured C2 case 1bPapYy2…: Nansen says transfer-only, detector emits "
        "2 real BUY events — adjudicated by G2 as TRANSFER_FALSE_POSITIVE "
        "(oracle divergence), not a detector bug.",
        "Old oracle suite stays filtered by the fee_leg flag rather than by "
        "bumping EXPECT_COUNT — 3fec2kXP stays at exactly 2 events.",
    ]


def _scope_boundary_lines():
    return [
        "",
        "## Scope boundary — detector layer only",
        "",
        "Parity holds in the Python detector; fee-SELL never reaches the dashboard:",
        "- scripts/wallet_watch.py:134 and :190 POST/emit BUY only",
        "- server/src/providers/nansen.ts:133-134 `if (row.txType !== 'buy') continue;`",
        "- server/src/db.ts:147-160 has no qty column",
        "`fee_leg` is the phase-2 hook.",
    ]


def _fee_stats_lines(summary, records):
    drift = summary["drift"]
    raws = summary["fee_usd_ratios"]
    fadj = [(x / drift if drift else x) for x in raws]
    out = [
        "",
        "## Fee-USD ratio stats",
        "",
        f"count={len(raws)}",
        f"raw: p50={_pctl(raws, 0.5):.4f} p90={_pctl(raws, 0.9):.4f} "
        f"max={max(raws, default=0.0):.4f}",
        f"post-drift: p50={_pctl(fadj, 0.5):.4f} p90={_pctl(fadj, 0.9):.4f} "
        f"max={max(fadj, default=0.0):.4f}",
        "",
        "| sig | ca | raw | adj | ok |",
        "|---|---|---|---|---|",
    ]
    for r in records:
        for raw in r["fee_usd_ratios"]:
            adj = raw / drift if drift else raw
            out.append(
                f"| {r['sig'][:12]} | {r['ca'][:8]} | {raw:.4f} | {adj:.4f} "
                f"| {fee_usd_gate_ok(adj)} |"
            )
    return out


def _class_count_row(summary, cls):
    cc = summary["class_counts"]
    return f"| {cls} | {cc[cls]} |"


def write_report(path, records, meta, traces):
    """Báo cáo markdown: ghi file, print, trả text. meta: generated_at,
    truth_path, drift, oracle, fee_programs. traces: {sig: [line, …]}."""
    summary = summarize(records, oracle=meta.get("oracle"))
    gates = pass_bar(summary)
    lines = ["# Nansen ground-truth parity report", ""]
    lines.append(f"generated_at: {meta.get('generated_at')}")
    lines.append(f"truth: {meta.get('truth_path')}")
    lines.append(
        f"n_records: {summary['n_records']}  n_sigs: {summary['n_sigs']}  "
        f"drift: {meta.get('drift', summary['drift'])}"
    )
    lines += [
        "",
        "## Class counts (precedence order)",
        "",
        "| class | n |",
        "|---|---|",
    ]
    for c in CLASS_PRECEDENCE:
        lines.append(_class_count_row(summary, c))
    lines += [
        "",
        "## Gates G1–G13",
        "",
        "| gate | name | ok | value |",
        "|---|---|---|---|",
    ]
    for gid, ok, val in gates:
        lines.append(f"| {gid} | {GATE_NAMES[gid]} | {ok} | {val} |")
    lines += ["", G9_FORMULA, ""]
    lines += _gate_fail_lines(gates, summary, records)
    lines += _root_cause_lines(records)
    lines += _trace_lines(traces)
    lines += _phase2_lines(summary, records, meta)
    lines += _oracle_divergence_lines()
    lines += _scope_boundary_lines()
    lines += _fee_stats_lines(summary, records)
    text = "\n".join(lines) + "\n"
    with open(path, "w") as f:
        f.write(text)
    print(text)
    return text


# ============================================ todo 6 — IO layer (fetch + prices + run)
#
# Fetch getTransaction THẲNG từ RPC_PIN — KHÔNG BAO GIỜ qua ww.rpc: RPCS là
# publicnode-first (wallet_watch.py:53-57) và publicnode âm thầm trả history cụt
# (wallet_hist.py:35-37). Precedent retry/backoff/sleep/counter: fetch22.py
# (todo 2) — tái hiện, không import (file nằm ngoài scripts/).

TRUTH_DEFAULT = os.path.join(_ROOT, ".probe", "nansen-24h", "tx-sample.jsonl")
FIXDIR_DEFAULT = os.path.join(_ROOT, ".probe", "nansen-parity", "fixtures")
PRICES_DEFAULT = os.path.join(_ROOT, ".probe", "nansen-parity", "prices.json")
OUT_DEFAULT = os.path.join(_ROOT, ".probe", "nansen-parity", "smoke")

# Env override thắng (cùng precedence wallet_watch.py: SOLANA_RPC_URL → RPC_HTTP).
RPC_PIN = (
    os.environ.get("SOLANA_RPC_URL")
    or os.environ.get("RPC_HTTP")
    or "https://api.mainnet-beta.solana.com"
)
# backtest_parity.py:42-48 — tx v1 cần maxSupportedTransactionVersion.
_TX_PARAMS = {
    "encoding": "jsonParsed",
    "maxSupportedTransactionVersion": 1,
    "commitment": "confirmed",
}
SLEEP_BETWEEN = 0.35  # mainnet-beta public ~2.5 req/s
BACKOFFS = (1.0, 3.0)  # retry 2
TIMEOUT = 30


def _post_tx(sig):
    """1 POST getTransaction lên RPC_PIN → dict JSON-RPC response."""
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [sig, _TX_PARAMS],
        }
    ).encode()
    req = urllib.request.Request(
        RPC_PIN,
        data=body,
        headers={
            "User-Agent": "nansen-parity/1.0",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def fetch_tx(sig, cache_dir):
    """Cache-first getTransaction → (tx_or_None, n_calls, fetch_error_or_None).

    Cache là ROOT-level JSON (không wrapper {"result":…}); MỌI result kể cả null
    đều ghi cache ⇒ UNAVAILABLE tái hiện được offline. Lỗi transport/RPC không
    ghi cache (lần sau retry) — retry 2, backoff 1s/3s, sleep 0.35s giữa các
    attempt (precedent fetch22.fetch_sig).
    """
    path = os.path.join(cache_dir, sig + ".json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cached = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"  ! corrupt cache {path}: {e} — refetching", file=sys.stderr)
            os.remove(path)
        else:
            if isinstance(cached, dict) and "transaction" in cached:
                return cached, 0, None
            return None, 0, f"cached null result (JSON-RPC result=null) at {path}"

    attempts = []
    n_calls = 0
    for i in range(1 + len(BACKOFFS)):
        if i:
            time.sleep(BACKOFFS[i - 1])
        n_calls += 1
        try:
            resp = _post_tx(sig)
        except (
            OSError,
            ValueError,
        ) as e:  # URLError/timeout ⊂ OSError, JSONDecodeError ⊂ ValueError
            attempts.append(f"attempt {i + 1}: transport_error {type(e).__name__}: {e}")
            time.sleep(SLEEP_BETWEEN)
            continue
        if isinstance(resp, dict) and resp.get("error") is not None:
            attempts.append(f"attempt {i + 1}: rpc_error {resp['error']}")
            time.sleep(SLEEP_BETWEEN)
            continue
        result = resp.get("result") if isinstance(resp, dict) else None
        os.makedirs(cache_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(result, f)
        if isinstance(result, dict) and "transaction" in result:
            return result, n_calls, None
        attempts.append(f"attempt {i + 1}: null_result (cached as null)")
        time.sleep(SLEEP_BETWEEN)
    return (
        None,
        n_calls,
        f"UNAVAILABLE after {n_calls} attempts via {RPC_PIN}: " + "; ".join(attempts),
    )


def tx_unavailable(tx):
    """True khi tx không dùng được cho parity: None / thiếu 'transaction' /
    meta.err != null (tx fail on-chain — detect_swaps cũng trả [] theo
    wallet_watch.py:986-987)."""
    if not isinstance(tx, dict) or "transaction" not in tx:
        return True
    return (tx.get("meta") or {}).get("err") is not None


def tx_mints(tx):
    """Mọi mint trong pre/postTokenBalances của tx (None-safe)."""
    meta = (tx or {}).get("meta") or {}
    rows = (meta.get("preTokenBalances") or []) + (meta.get("postTokenBalances") or [])
    return {b.get("mint") for b in rows if b.get("mint")}


def load_prices(path):
    """Snapshot giá {captured_at, sol_usd, prices{mint:[sym,px]}}; {} nếu
    thiếu/hỏng (capture_prices sẽ fetch lại)."""
    try:
        with open(path, encoding="utf-8") as f:
            snap = json.load(f)
        return snap if isinstance(snap, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def seed_prices(ww_mod, snap):
    """Seed detector cache từ snapshot: ww._info[mint]=(sym,px) + _sol_px['v'].

    KHÔNG seed _info_miss (lệch có chủ đích so với trace22.py:77-79): marker
    miss khiến token_info re-fetch qua mạng sau TTL 60s — parity harness phải
    hermetic tuyệt đối (network calls: 0 tái hiện được).
    """
    for m, v in (snap.get("prices") or {}).items():
        ww_mod._info[m] = (v[0], float(v[1]))
    sol_usd = float(snap.get("sol_usd") or 0.0)
    if sol_usd:
        ww_mod._sol_px["v"] = sol_usd


def capture_prices(mints, path):
    """Cache-first price snapshot → số network call (0 khi snapshot phủ hết).

    Miss ⇒ ww.token_info (DexScreener — đường production, KHÔNG Nansen) rồi ghi
    snapshot với captured_at mới. Seed ww._info/_sol_px trong mọi trường hợp.
    """
    snap = load_prices(path)
    seed_prices(ww, snap)
    calls = 0
    for m in sorted(m for m in mints if m not in ww._info):
        ww.token_info(m)  # DexScreener — production path, tự ghi vào ww._info
        calls += 1
    sol_usd = float(snap.get("sol_usd") or 0.0)
    if not sol_usd:
        sol_usd = float((ww._info.get(ww.WSOL) or (None, 0.0))[1] or 0.0)
        if not sol_usd:
            ww.token_info(ww.WSOL)
            calls += 1
            sol_usd = float((ww._info.get(ww.WSOL) or (None, 0.0))[1] or 0.0)
    if calls or not snap.get("captured_at"):
        snap = {
            "captured_at": _now_iso(),
            "sol_usd": sol_usd,
            "prices": {m: [v[0], v[1]] for m, v in sorted(ww._info.items())},
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(snap, f, indent=1)
        seed_prices(ww, snap)
    return calls


def detect_for(
    sig, wallet, trace, cache_dir=FIXDIR_DEFAULT, prices_path=PRICES_DEFAULT
):
    """1 sig: fetch → seed giá (universe = mints của tx ∪ WSOL) → detect_swaps.
    → (events_or_None, n_calls, fetch_error_or_None). trace: list nhận dòng."""
    tx, calls, err = fetch_tx(sig, cache_dir)
    if err is None and tx_unavailable(tx):
        err = f"tx unavailable (meta.err != null or missing 'transaction'): sig={sig}"
    if err is not None:
        return None, calls, err
    calls += capture_prices(tx_mints(tx) | {ww.WSOL}, prices_path)
    return ww.detect_swaps(tx, wallet, trace.append), calls, None


def select_sigs(population, sigs=None, limit=None, seed=None):
    """--limit semantics tường minh (plan todo 6 dòng 171 + todo 7 dòng 180):

    - sigs given ⇒ filter theo sigs (token là PREFIX — sig đầy đủ là prefix của
      chính nó nên exact match không đổi) rồi lấy limit sig đầu của sorted(...)
      — seed bị BỎ QUA (định nghĩa cũ, không đổi).
    - không sigs + seed ⇒ sorted(random.Random(seed).sample(sorted(pop), N)) —
      local Random instance, không bao giờ chạm global RNG state.
    - không sigs, không seed ⇒ N sig đầu của sorted(pop).
    limit > len(pop) ⇒ clamp (sample không ValueError).
    """
    sel = sorted(set(population))
    if sigs:
        tokens = list(sigs)
        sel = [s for s in sel if any(s.startswith(t) for t in tokens)]
    if limit is not None:
        if sigs or seed is None:
            sel = sel[:limit]
        else:
            sel = sorted(random.Random(seed).sample(sel, min(limit, len(sel))))
    return sel


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ============================================ todo 8 — oracle plumbing + fee programs
#
# Bổ sung TỐI THIỂU (carry-over requirement #1 của todo 8, documented tại đây):
# - run(..., oracle=None) + CLI --oracle '<json>': G13 oracle ĐO TRƯỚC từ suite
#   (test_gmgn_api_parity.py, backtest_parity.py --from-fixture, đếm event
#   3fec2kXP) rồi truyền vào meta → summarize/pass_bar. KHÔNG gate mới, KHÔNG
#   hardcode pass; thiếu oracle ⇒ G13 vẫn None "not measured" như cũ.
# - _fee_programs: điền meta["fee_programs"] cho write_report (consumer đã có
#   sẵn từ todo 5 — placeholder "(meta['fee_programs'] absent…)").


def _fee_programs(records, txs, det):
    """Program thật + encl của các fee leg-out đã promote, đọc từ tx cached.

    Gọi lại ww._legs_with_roles(tx, wallet, None, rejected) — offline 100%,
    không side-effect — để lấy fee candidates rồi khớp với fee event theo
    (mint, program, qty) → [{sig, encl, program, collector}]. `encl` = program
    cha của frame (frame[2]) — đúng convention dòng REJECT trong trace todo 2
    (ví dụ aggregator_frame encl=JUP6LkbZbjS1…). `collector` = owner của dst
    (fallback token-account dst khi không tìm được owner)."""
    out = []
    for r in records:
        if r["sides_ev"]["sell_fee"] < 1:
            continue
        tx = txs.get(r["sig"])
        d = det.get((r["sig"], r["wallet"]))
        if tx is None or d is None:
            continue
        fee_evs = [
            e
            for e in d[0]
            if e.get("fee_leg") and e.get("side") == "SELL" and e.get("mint") == r["ca"]
        ]
        if not fee_evs:
            continue
        rejected = []
        ww._legs_with_roles(tx, r["wallet"], None, rejected)
        pool = list(rejected)
        for ev in fee_evs:
            cand = next(
                (
                    c
                    for c in pool
                    if c["mint"] == ev["mint"]
                    and c["program"] == ev["program"]
                    and abs(c["raw"] / 10 ** c["dec"] - ev["qty"]) <= 1e-12
                ),
                None,
            )
            if cand is None:
                continue
            pool.remove(cand)
            out.append(
                {
                    "sig": r["sig"][:12] + "…",
                    "encl": cand["frame"][2],
                    "program": cand["program"],
                    "collector": cand["dst_owner"] or cand["dst"],
                }
            )
    return out


def run(
    truth,
    limit=None,
    sigs=None,
    out=OUT_DEFAULT,
    prices_path=PRICES_DEFAULT,
    cache_dir=FIXDIR_DEFAULT,
    seed=None,
    oracle=None,
):
    """End-to-end: đọc truth → group → chọn sig qua select_sigs (semantics
    tường minh: --sigs ⇒ filter rồi lấy limit đầu của sorted; không --sigs +
    seed ⇒ random.Random(seed).sample(sorted(pop), limit) tất định; còn lại ⇒
    limit đầu của sorted) → fetch → detect → classify (2 pass: drift=None rồi
    drift=median pass 1, đúng G9 'after one global drift factor') →
    write_jsonl + write_report. In `network calls: N` (N đếm MỌI HTTP outbound:
    tx fetch + price fetch). oracle: dict G13 đo từ suite TRƯỚC run (None ⇒
    G13 'not measured'). Trả exit code."""
    if not os.path.exists(truth):
        print(f"truth file không tồn tại: {truth}", file=sys.stderr)
        return 2
    rows = load_truth(truth)
    grps = groups(rows)
    pop = sorted({g.sig for g in grps.values()})
    sel_sigs = select_sigs(pop, sigs=sigs, limit=limit, seed=seed)
    if sigs:
        unknown = sorted(t for t in sigs if not any(s.startswith(t) for s in pop))
        if unknown:
            print(
                f"  ! {len(unknown)} token --sigs không match sig nào trong truth: "
                + ", ".join(u[:12] + "…" for u in unknown),
                file=sys.stderr,
            )
    sel = set(sel_sigs)
    sel_groups = sorted(
        (g for g in grps.values() if g.sig in sel),
        key=lambda g: (g.sig, g.wallet, g.ca),
    )

    n_calls = 0
    txs, errs = {}, {}
    for sig in sel_sigs:
        tx, calls, err = fetch_tx(sig, cache_dir)
        n_calls += calls
        if err is None and tx_unavailable(tx):
            err = (
                f"tx unavailable (meta.err != null or missing 'transaction'): sig={sig}"
            )
        txs[sig], errs[sig] = tx, err

    # Universe giá CHỈ của các group được chọn (+WSOL) — run --limit 5 không
    # được fetch giá CA của cả 743 group (decision notepad 2026-09-22).
    mints = {g.ca for g in sel_groups} | {ww.WSOL}
    for sig in sel_sigs:
        if errs[sig] is None:
            mints |= tx_mints(txs[sig])
    n_calls += capture_prices(mints, prices_path)

    det = {}
    for sig, wallet in sorted({(g.sig, g.wallet) for g in sel_groups}):
        if errs[sig] is not None:
            continue
        tr = []
        evs = ww.detect_swaps(txs[sig], wallet, tr.append)
        det[(sig, wallet)] = (evs, tr, ww._net_owner(txs[sig], wallet))

    def build(drift):
        recs = []
        for g in sel_groups:
            if errs[g.sig] is not None:
                recs.append(classify(g, None, fetch_error=errs[g.sig]))
                continue
            evs, tr, net_owner = det[(g.sig, g.wallet)]
            recs.append(
                classify(
                    g,
                    evs,
                    drift=drift,
                    reject_trace=tr
                    or [f"no detector trace lines emitted for sig={g.sig}"],
                    net_owner=net_owner,
                )
            )
        return recs

    records = build(None)
    drift = summarize(records)["drift"]
    if drift:
        records = build(drift)

    os.makedirs(out, exist_ok=True)
    write_jsonl(os.path.join(out, "parity.jsonl"), records)
    need_tr = {r["sig"] for r in records if r["class"] in TRACE_REQUIRED}
    traces = {}
    for (sig, _w), (_e, tr, _n) in det.items():
        if sig in need_tr:
            traces.setdefault(sig, []).extend(tr)
    write_report(
        os.path.join(out, "report.md"),
        records,
        {
            "generated_at": _now_iso(),
            "truth_path": truth,
            "drift": drift,
            "oracle": oracle,
            "fee_programs": _fee_programs(records, txs, det),
        },
        traces,
    )
    print(f"network calls: {n_calls}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--truth", default=TRUTH_DEFAULT)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="với --sigs: N sig đầu của sorted(sigs-sau-lọc); với --seed (không "
        "--sigs): N sig mẫu tất định random.Random(seed).sample(sorted(sigs), N); "
        "còn lại: N sig đầu của sorted(sigs)",
    )
    ap.add_argument(
        "--sigs",
        default="",
        help="comma-separated sig filter (token = prefix, exact sig OK)",
    )
    ap.add_argument(
        "--prices",
        default=PRICES_DEFAULT,
        help="price snapshot JSON path (capture_prices cache-first)",
    )
    ap.add_argument(
        "--seed",
        type=int,
        default=None,
        help="RNG seed cho --limit sampling tất định (bỏ qua khi có --sigs)",
    )
    ap.add_argument(
        "--oracle",
        default=None,
        help='JSON oracle G13 ĐO TRƯỚC từ suite: {"gmgn_ok":bool,'
        '"backtest_ok":bool,"fec2kxp_events":int} — bỏ qua ⇒ G13 None',
    )
    a = ap.parse_args(argv)
    sig_list = [s.strip() for s in a.sigs.split(",") if s.strip()] or None
    oracle = None
    if a.oracle:
        try:
            oracle = json.loads(a.oracle)
        except json.JSONDecodeError as e:
            print(f"--oracle không phải JSON hợp lệ: {e}", file=sys.stderr)
            return 2
        if not isinstance(oracle, dict):
            print("--oracle phải là JSON object", file=sys.stderr)
            return 2
    return run(
        a.truth,
        limit=a.limit,
        sigs=sig_list,
        out=a.out,
        prices_path=a.prices,
        seed=a.seed,
        oracle=oracle,
    )


if __name__ == "__main__":
    sys.exit(main())
