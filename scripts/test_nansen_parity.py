#!/usr/bin/env python3
"""Test pure-core comparator Nansen parity (todo 3 — .omo/plans/nansen-groundtruth-parity.md).

Chạy: python3 scripts/test_nansen_parity.py   (offline 100% — không network, không RPC,
không gọi detect_swaps; events là dict dựng tay theo shape wallet_watch.py:798-820).

TDD: file này viết TRƯỚC scripts/nansen_parity.py (RED → GREEN).
Mandated cases (acceptance todo 3):
  - net_identity(x, 0) is None (cấm ZeroDivisionError)
  - sum_qnet với qty_net=None không crash + đếm qty_net_none
  - usd_ratio(None, 5) is None (cấm coi None là 0)
  - global_drift([0.9, 1.0, 1.1]) == 1.0
  - net_truth group transfer-only == 0 DÙ row transfer có amount != 0
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import traceback
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "nansen_parity", os.path.join(HERE, "nansen_parity.py")
)
assert _spec and _spec.loader
np_ = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(np_)

SIG = "48Y3e48T4z" * 5
WALLET = "FhsbQzAJWVDNwaH61cTo6XkkfEsmYMZKs9VJHH32bVG"
CA = "3z2tRjNu4mScxS5Z6YkxFcCQeWvzRz7Kh4Qmx1E5UqJn"


def mkrow(
    sig=SIG, wallet=WALLET, ca=CA, txType="buy", amount=0.0, usd: "float | None" = 0.0
):
    """Row truth đúng 19 field của tx-sample.jsonl (chỉ field comparator dùng là có nghĩa)."""
    return {
        "blockTimestamp": "2026-09-20T06:00:00Z",
        "ca": ca,
        "counterpartyAddress": "OTHER" + sig[:8],
        "counterpartyAddressName": None,
        "currentPosition": 0.0,
        "directionalAmountOfTokens": amount,
        "fromAddress": wallet,
        "fromName": None,
        "isNft": False,
        "toAddress": "POOL" + sig[:8],
        "toName": None,
        "transactionHash": sig,
        "txSignerAddress": wallet,
        "txSignerName": None,
        "txType": txType,
        "usdValueAtTxTime": usd,
        "usdValueCurrent": usd,
        "usdValuePctChangeToDate": 0.0,
        "wallet": wallet,
    }


def close(a, b, eps=1e-9):
    return a is not None and b is not None and abs(a - b) <= eps


# ---------------------------------------------------------------- load_truth


def test_load_truth():
    rows = [
        mkrow(amount=1000.0, usd=12.5),
        mkrow(txType="sell", amount=-300.0, usd=3.0),
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
        f.write("\n")  # dòng rỗng phải được bỏ qua
        path = f.name
    try:
        got = np_.load_truth(path)
    finally:
        os.unlink(path)
    assert isinstance(got, list) and len(got) == 2, (
        f"load_truth phải trả 2 row, got {len(got)}"
    )
    assert got[0]["txType"] == "buy" and got[1]["txType"] == "sell"
    assert got[0]["directionalAmountOfTokens"] == 1000.0
    assert len(got[0].keys()) == 19, "row phải giữ đủ 19 field"


# -------------------------------------------------------------------- groups


def test_groups_key_and_shape_buy_only():
    g = np_.groups([mkrow(amount=1000.0, usd=12.5)])
    key = (SIG, WALLET, CA)
    assert set(g.keys()) == {key}, (
        f"key phải là (sig, wallet, ca), got {list(g.keys())}"
    )
    grp = g[key]
    assert grp.shape == "buy_only", grp.shape
    assert grp.usd_null is False
    assert grp.sides["buy"] == [{"amount": 1000.0, "usd": 12.5}]
    assert grp.sides["sell"] == [] and grp.sides["transfer"] == []


def test_groups_shapes():
    rows = [
        mkrow(sig="s1", txType="sell", amount=-300.0, usd=3.0),
        mkrow(sig="s2", txType="transfer", amount=-50.0, usd=1.0),
        mkrow(sig="s3", amount=100.0, usd=1.0),
        mkrow(sig="s3", txType="sell", amount=-40.0, usd=0.4),
    ]
    g = np_.groups(rows)
    assert g[("s1", WALLET, CA)].shape == "sell_only"
    assert g[("s2", WALLET, CA)].shape == "transfer_only"
    assert g[("s3", WALLET, CA)].shape == "buy_sell"


def test_groups_usd_null_and_multirow():
    rows = [
        mkrow(sig="s4", amount=100.0, usd=None),
        mkrow(sig="s4", amount=50.0, usd=2.0),
        mkrow(sig="s5", amount=10.0, usd=1.0),
    ]
    g = np_.groups(rows)
    grp4 = g[("s4", WALLET, CA)]
    assert grp4.usd_null is True, "chỉ cần 1 row usd None ⇒ usd_null True"
    assert len(grp4.sides["buy"]) == 2
    assert g[("s5", WALLET, CA)].usd_null is False


# ----------------------------------------------------------------- net_truth


def test_net_truth_signed():
    g = np_.groups(
        [
            mkrow(sig="n1", amount=1000.0),
            mkrow(sig="n1", txType="sell", amount=-300.0),
        ]
    )
    # buy +, sell −: 1000 − 300 (sell lấy −|amount|, không phải amount thô −300 ⇒ +300)
    assert close(np_.net_truth(g[("n1", WALLET, CA)]), 700.0), np_.net_truth(
        g[("n1", WALLET, CA)]
    )


def test_net_truth_transfer_only_zero():
    """MANDATED: row transfer có amount = −50 (≠ 0) nhưng net_truth PHẢI == 0.

    300/300 row transfer trong tx-sample có amount ≠ 0; nếu cộng raw thì
    254 group transfer-only FAIL 100% ⇒ transfer đóng góp 0.
    """
    g = np_.groups([mkrow(sig="t1", txType="transfer", amount=-50.0, usd=1.0)])
    assert np_.net_truth(g[("t1", WALLET, CA)]) == 0, (
        "transfer-only net_truth phải == 0 dù amount ≠ 0"
    )


# --------------------------------------------------------------- gross_truth


def test_gross_truth_abs():
    g = np_.groups(
        [
            mkrow(sig="g1", amount=1000.0),
            mkrow(sig="g1", amount=500.0),
            mkrow(sig="g1", txType="sell", amount=-300.0),
        ]
    )
    grp = g[("g1", WALLET, CA)]
    assert close(np_.gross_truth(grp, "buy"), 1500.0)
    assert close(np_.gross_truth(grp, "sell"), 300.0), "sell −300 ⇒ gross 300 (abs)"
    assert np_.gross_truth(grp, "transfer") == 0


# -------------------------------------------------------------- net_identity


def test_net_identity():
    assert close(np_.net_identity(101.5, 100.0), 0.015)
    assert close(np_.net_identity(90.0, 100.0), 0.1)
    assert np_.net_identity(100.0, 100.0) == 0.0


def test_net_identity_zero_truth_none():
    """MANDATED: truth_sum == 0 ⇒ None, không ZeroDivisionError."""
    assert np_.net_identity(5.0, 0.0) is None
    assert np_.net_identity(0.0, 0.0) is None


# ------------------------------------------------------------------ sum_qnet


def test_sum_qnet_signed():
    events = [
        {"side": "BUY", "qty_net": 48930.786206},
        {"side": "SELL", "qty_net": -100.0, "fee_leg": False},
    ]
    s, none_count = np_.sum_qnet(events)
    assert close(s, 48830.786206), s
    assert none_count == 0


def test_sum_qnet_none_skip():
    """MANDATED: qty_net=None (hợp lệ — wallet_watch.py:800) không crash, đếm none."""
    events = [
        {"side": "BUY", "qty_net": 5.0},
        {"side": "SELL", "qty_net": None},  # mint mixed-sign ⇒ qty_net None
        {"side": "BUY"},  # thiếu key ⇒ coi như None
    ]
    s, none_count = np_.sum_qnet(events)
    assert close(s, 5.0), s
    assert none_count == 2, none_count
    s2, n2 = np_.sum_qnet([])
    assert s2 == 0.0 and n2 == 0


# --------------------------------------------------------------- gross_bucket


def test_gross_bucket():
    assert close(np_.gross_bucket(108.0, 100.0), 0.08), np_.gross_bucket(108.0, 100.0)
    assert np_.gross_bucket(100.0, 100.0) == 0.0
    # truth 0: không ZeroDivisionError — 0/0 ⇒ 0.0, ev>0 ⇒ inf (luôn vượt GROSS_CAP 8%)
    assert np_.gross_bucket(0.0, 0.0) == 0.0
    assert np_.gross_bucket(5.0, 0.0) == float("inf")


# ----------------------------------------------------------------- usd_ratio


def test_usd_ratio():
    assert close(np_.usd_ratio(12.4, 12.5), 0.992, eps=1e-6), np_.usd_ratio(12.4, 12.5)
    assert close(np_.usd_ratio(12.5, 12.5), 1.0)


def test_usd_ratio_none():
    """MANDATED: None vế nào ⇒ None; CẤM coi None là 0."""
    assert np_.usd_ratio(None, 5.0) is None
    assert np_.usd_ratio(5.0, None) is None
    assert np_.usd_ratio(None, None) is None


# ---------------------------------------------------------------- global_drift


def test_global_drift():
    """MANDATED: median — [0.9, 1.0, 1.1] ⇒ 1.0."""
    assert np_.global_drift([0.9, 1.0, 1.1]) == 1.0
    assert np_.global_drift([0.8, 0.9, 1.0, 1.1]) == 0.95  # median chẵn
    assert np_.global_drift([0.7]) == 0.7


# -------------------------------------------------------------------- is_dust


def test_is_dust():
    assert np_.is_dust(0.005) is True
    assert np_.is_dust(-0.005) is True
    assert np_.is_dust(0.0) is True
    assert np_.is_dust(0.01) is False, "ngưỡng $0.01: < 0.01 mới là dust"
    assert np_.is_dust(1.0) is False
    assert np_.is_dust(None) is False, "None không phải dust (không đo được)"


# ------------------------------------------------------------ fee_usd_gate_ok


def test_fee_usd_gate_ok():
    assert np_.fee_usd_gate_ok(1.0) is True
    assert np_.fee_usd_gate_ok(0.85) is True  # biên −15% đạt
    assert np_.fee_usd_gate_ok(1.15) is True  # biên +15% đạt
    assert np_.fee_usd_gate_ok(0.84) is False
    assert np_.fee_usd_gate_ok(1.16) is False
    assert np_.fee_usd_gate_ok(None) is False, (
        "None ⇒ gate không đạt (không phải coi như 0)"
    )


# ============================================== todo 5 PART 1/2 — side_of + classify


def mkev(
    side="BUY", mint=CA, qty=0.0, qty_net=None, quote_usd=None, fee_leg=False, **kw
):
    """Event dict đúng shape _swap_event của detect_swaps (wallet_watch.py:798-820)."""
    ev = {
        "side": side,
        "mint": mint,
        "qty": qty,
        "qty_net": qty_net,
        "quote_usd": quote_usd,
        "type": "SWAP",
        "amount_basis": "gross_leg",
        "sig": SIG,
        "wallet": WALLET,
    }
    if fee_leg:
        ev["fee_leg"] = True
    ev.update(kw)
    return ev


def _raises_valueerror(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


def _grp(rows):
    """Groups từ rows → group DUY NHẤT (assert 1 group)."""
    g = np_.groups(rows)
    assert len(g) == 1, f"fixture phải là 1 group, got {len(g)}"
    return next(iter(g.values()))


# ------------------------------------------------------------------ side_of


def test_side_of():
    assert np_.side_of({"side": "BUY"}) == "buy"
    assert np_.side_of({"side": "SELL"}) == "sell"
    assert np_.side_of({"side": "SELL", "fee_leg": True}) == "sell", (
        "fee_leg vẫn là SELL — vẫn map 'sell'"
    )
    try:
        np_.side_of({"side": "RECEIVE"})
        assert False, "RECEIVE phải raise ValueError"
    except ValueError as e:
        assert "RECEIVE" in str(e), f"message phải nêu đích danh side: {e}"
    assert _raises_valueerror(lambda: np_.side_of({})), "thiếu key side ⇒ ValueError"
    try:
        np_.side_of({"side": "FROB"})
        assert False, "side lạ phải raise ValueError"
    except ValueError as e:
        assert "FROB" in str(e), f"message phải nêu đích danh side: {e}"


# ---------------------------------------------------------------- constants


def test_constants_precedence_and_trace_required():
    assert np_.CLASS_PRECEDENCE == (
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
    ), np_.CLASS_PRECEDENCE
    assert len(np_.TRACE_REQUIRED) == 6
    assert np_.TRACE_REQUIRED == frozenset(
        (
            "MISSING",
            "TYPE_MISMATCH",
            "AMOUNT_MISMATCH",
            "GROSS_MISMATCH",
            "USD_MISMATCH",
            "TRANSFER_FALSE_POSITIVE",
        )
    ), np_.TRACE_REQUIRED
    assert len(np_.RECORD_FIELDS) == 24, len(np_.RECORD_FIELDS)


# ----------------------------------------------------------------- classify


def test_classify_record_fields_exact():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(grp, [mkev(qty=1000.0, qty_net=1000.0, quote_usd=12.5)])
    assert list(rec.keys()) == list(np_.RECORD_FIELDS), list(rec.keys())
    assert rec["class"] == "MATCH"


def test_classify_buy_only_with_fee_match():
    """Buy-only truth + [BUY, SELL(fee_leg)] ⇒ MATCH — fee SELL không bao giờ
    là over_emitted (GMGN/Nansen oracle divergence, C0: 9/9 fee là sell row)."""
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(
        grp,
        [
            mkev(qty=1000.0, qty_net=1000.0, quote_usd=12.4),
            mkev("SELL", qty=0.5, qty_net=0.5, quote_usd=0.006, fee_leg=True),
        ],
        drift=1.0,
    )
    assert rec["class"] == "MATCH", rec["class"]
    assert rec["matched"] == 1 and rec["unmatched"] == 0 and rec["over_emitted"] == 0
    assert rec["sides_ev"] == {"buy": 1, "sell": 1, "sell_fee": 1}, rec["sides_ev"]
    assert close(rec["net_rel"], 0.0005, eps=1e-9), rec["net_rel"]
    assert rec["gross_rel_sell"] is None, "truth sell gross 0 ⇒ không đo"
    assert rec["fee_usd_ratios"] == []
    assert rec["dust_skipped"] == 1, "fee $0.006 là dust"
    assert rec["net_identity_na"] is False, (
        "BUY + SELL(fee) KHÔNG phải mixed-sign ⇒ identity đo được"
    )


def test_classify_transfer_only_zero_events_match():
    grp = _grp([mkrow(txType="transfer", amount=-50.0, usd=1.0)])
    assert grp.shape == "transfer_only"
    rec = np_.classify(grp, [])
    assert rec["class"] == "MATCH", rec["class"]
    assert rec["net_rel"] is None, "net_truth 0 ⇒ không đo"
    assert "net_truth_zero" in rec["notes"]["flags"], rec["notes"]["flags"]
    assert rec["usd_ratio_raw"] is None


def test_classify_transfer_only_with_buy_tfp():
    """C2: Nansen transfer-only nhưng detector sinh BUY thật ⇒
    TRANSFER_FALSE_POSITIVE (oracle divergence, không phải detector bug)."""
    tfca = "1NJMqVM4x"
    grp = np_.groups([mkrow(ca=tfca, txType="transfer", amount=-50.0, usd=1.0)])[
        (SIG, WALLET, tfca)
    ]
    trace = ["REJECT (2,2,'pAMM…',3) 1NJ… same_mint"]
    rec = np_.classify(
        grp,
        [mkev(mint=CA, qty_net=None, quote_usd=None), mkev(mint="OTHERMINT1")],
        reject_trace=trace,
    )
    assert rec["class"] == "TRANSFER_FALSE_POSITIVE", rec["class"]
    assert rec["reject_trace"] == trace, "trace phải được giữ nguyên"


def test_classify_tfp_without_trace_raises():
    tfca = "1NJMqVM4x"
    grp = np_.groups([mkrow(ca=tfca, txType="transfer", amount=-50.0, usd=1.0)])[
        (SIG, WALLET, tfca)
    ]
    assert _raises_valueerror(
        lambda: np_.classify(grp, [mkev(mint=CA), mkev(mint="OTHERMINT1")])
    ), "TFP ∈ TRACE_REQUIRED mà không trace ⇒ ValueError"


def test_classify_same_ca_fee_match():
    """C0 shape buy_sell same-ca: buy 48930.78620605 + fee-sell 48.9307862."""
    grp = _grp(
        [
            mkrow(amount=48930.78620605, usd=12.34),
            mkrow(txType="sell", amount=-48.9307862, usd=0.1404884),
        ]
    )
    assert grp.shape == "buy_sell"
    rec = np_.classify(
        grp,
        [
            mkev(qty=48930.786206, qty_net=48930.786206, quote_usd=12.30),
            mkev(
                "SELL", qty=48.930786, qty_net=48.930786, quote_usd=0.127, fee_leg=True
            ),
        ],
        net_owner={CA: 48881.855420},
    )
    assert rec["class"] == "MATCH", rec["class"]
    assert rec["net_identity_na"] is False
    # spec nói < 1e-12 nhưng số liệu binding cho net_rel = 3.07e-12
    # (fee qty 48.930786 vs truth 48.9307862 ⇒ diff 1.5e-7) — xem evidence.
    assert rec["net_rel"] < 1e-11, rec["net_rel"]
    assert abs(rec["net_owner_delta"]) < 1e-6, rec["net_owner_delta"]
    assert len(rec["fee_usd_ratios"]) == 1
    assert close(rec["fee_usd_ratios"][0], 0.904, eps=0.01), rec["fee_usd_ratios"]
    assert close(rec["gross_rel_sell"], 4e-9, eps=1e-9), rec["gross_rel_sell"]


def test_classify_missing_and_raise():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(grp, [], reject_trace=["REJECT (1,1,'pAMM…',2) no_event"])
    assert rec["class"] == "MISSING", rec["class"]
    assert rec["matched"] == 0 and rec["unmatched"] == 1
    assert _raises_valueerror(lambda: np_.classify(grp, [])), (
        "MISSING ∈ TRACE_REQUIRED mà không trace ⇒ ValueError"
    )


def test_classify_type_mismatch():
    """1 truth buy nhưng 2 event BUY (Σ khớp số) ⇒ over_emitted thắng."""
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(
        grp,
        [
            mkev(qty=500.0, qty_net=500.0, quote_usd=6.25),
            mkev(qty=500.0, qty_net=500.0, quote_usd=6.25),
        ],
        reject_trace=["REJECT (1,2,'pAMM…',3) split_step"],
    )
    assert rec["class"] == "TYPE_MISMATCH", rec["class"]
    assert rec["over_emitted"] == 1, rec["over_emitted"]


def test_classify_amount_mismatch():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(
        grp,
        [mkev(qty=1000.0, qty_net=900.0, quote_usd=12.4)],
        reject_trace=["REJECT (1,1,'pAMM…',2) qty_net drift"],
    )
    assert rec["class"] == "AMOUNT_MISMATCH", rec["class"]
    assert close(rec["net_rel"], 0.1, eps=1e-9), rec["net_rel"]


def test_classify_gross_mismatch():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(
        grp,
        [mkev(qty=1200.0, qty_net=1000.0, quote_usd=12.4)],
        reject_trace=["REJECT (1,1,'pAMM…',2) gross drift"],
    )
    assert rec["class"] == "GROSS_MISMATCH", rec["class"]
    assert close(rec["gross_rel_buy"], 0.2, eps=1e-9), rec["gross_rel_buy"]
    assert rec["net_rel"] == 0.0, "qty_net khớp ⇒ net 0, gross mới lệch"


def test_classify_usd_mismatch():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(
        grp,
        [mkev(qty=1000.0, qty_net=1000.0, quote_usd=25.0)],
        reject_trace=["REJECT (1,1,'pAMM…',2) usd x2"],
    )
    assert rec["class"] == "USD_MISMATCH", rec["class"]
    assert close(rec["usd_ratio_adj"], 2.0, eps=1e-9), rec["usd_ratio_adj"]


def test_classify_net_identity_na_mixed_sign():
    grp = _grp(
        [
            mkrow(amount=100.0, usd=10.0),
            mkrow(txType="sell", amount=-40.0, usd=4.0),
        ]
    )
    rec = np_.classify(
        grp,
        [
            mkev(qty=100.0, qty_net=100.0, quote_usd=10.0),
            mkev("SELL", qty=40.0, qty_net=-40.0, quote_usd=4.0),
        ],
        net_owner={CA: 60.0},
    )
    assert rec["class"] == "NET_IDENTITY_NA", rec["class"]
    assert rec["net_rel"] is None
    assert rec["net_identity_na"] is True
    assert rec["net_owner_delta"] is None, "NA ⇒ không so chain identity"


def test_classify_net_identity_na_all_none():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(grp, [mkev(qty=1000.0, qty_net=None, quote_usd=12.5)])
    assert rec["class"] == "NET_IDENTITY_NA", rec["class"]
    assert rec["net_rel"] is None, "all-none ⇒ không được thành AMOUNT_MISMATCH"
    assert rec["qty_net_none"] == 1
    assert "all_qty_net_none" in rec["notes"]["flags"], rec["notes"]["flags"]


def test_classify_deferred_usd_null():
    grp = _grp([mkrow(amount=1000.0, usd=None)])
    assert grp.usd_null is True
    rec = np_.classify(grp, [mkev(qty=1000.0, qty_net=1000.0, quote_usd=12.4)])
    assert rec["class"] == "DEFERRED_USD_NULL", rec["class"]
    assert rec["usd_ratio_raw"] is None
    # type+amount vẫn gate dù usd_null:
    rec2 = np_.classify(
        grp,
        [mkev(qty=1000.0, qty_net=900.0, quote_usd=12.4)],
        reject_trace=["REJECT (1,1,'pAMM…',2) qty_net drift"],
    )
    assert rec2["class"] == "AMOUNT_MISMATCH", rec2["class"]


def test_classify_unavailable_no_raise_and_none_events_raises():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    err = "POST ... → null (3 tries)"
    rec = np_.classify(grp, None, fetch_error=err)
    assert rec["class"] == "UNAVAILABLE", rec["class"]
    assert rec["reject_trace"] == []
    assert rec["fetch_error"] == err
    assert "unavailable" in rec["notes"]["flags"], rec["notes"]["flags"]
    assert _raises_valueerror(lambda: np_.classify(grp, None)), (
        "events=None không fetch_error ⇒ ValueError"
    )


def test_classify_usd_missing_not_false_fail():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    rec = np_.classify(grp, [mkev(qty=1000.0, qty_net=1000.0, quote_usd=None)])
    assert rec["usd_missing"] == 1
    assert rec["usd_ratio_raw"] is None
    assert rec["class"] == "MATCH", "quote_usd None ⇒ không được FAIL oan"
    assert "usd_missing" in rec["notes"]["flags"], rec["notes"]["flags"]


def test_classify_receive_raises():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    assert _raises_valueerror(
        lambda: np_.classify(grp, [mkev(side="RECEIVE", qty=1000.0)])
    ), "detect_swaps không sinh RECEIVE — nếu có thì là bug, phải nổi lên"


def test_classify_diff_ca_filter():
    """Event khác ca phải bị filter (D2) — BUY(B) không làm over_emitted."""
    grp = _grp([mkrow(txType="sell", amount=-100.0, usd=5.0)])
    rec = np_.classify(
        grp,
        [
            mkev("SELL", mint=CA, qty=100.0, qty_net=-100.0, quote_usd=5.0),
            mkev("BUY", mint="BMINT2", qty=50.0, qty_net=50.0, quote_usd=2.0),
        ],
    )
    assert rec["class"] == "MATCH", rec["class"]
    assert rec["sides_ev"]["buy"] == 0, "BUY mint khác phải bị filter"


def test_classify_full_event_shape():
    grp = _grp([mkrow(amount=1000.0, usd=12.5)])
    ev = {
        "ts": "09-22 15:56:34",
        "slot": 1,
        "sig": SIG,
        "wallet": WALLET,
        "side": "BUY",
        "mint": CA,
        "sym": "X",
        "qty": 1000.0,
        "quote_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "quote_sym": "USDC",
        "quote_qty": 12.5,
        "quote_usd": 12.5,
        "qty_net": 1000.0,
        "unit_price": 0.0125,
        "pool": "Pool1",
        "program": "DEX1",
        "amount_basis": "gross_leg",
        "quote_inferred": False,
        "symbol_pending": False,
        "usd_pending": False,
        "type": "SWAP",
        "step": 1,
        "n_steps": 1,
    }
    rec = np_.classify(grp, [ev])
    assert rec["class"] == "MATCH", rec["class"]


# ============================================== todo 5 PART 2/2 — reporting half


def _six_records(with_net_owner=False):
    """6 record thật qua classify: 2 MATCH (buy-only + same-ca buy_sell C0),
    UNAVAILABLE (chung sig với buy-only ⇒ n_sigs < n_records),
    DEFERRED_USD_NULL, NET_IDENTITY_NA (mixed-sign), TRANSFER_FALSE_POSITIVE."""
    recs = []
    g1 = _grp([mkrow(amount=1000.0, usd=12.5)])
    recs.append(np_.classify(g1, [mkev(qty=1000.0, qty_net=1000.0, quote_usd=12.5)]))
    g2 = _grp(
        [
            mkrow(sig="sFee1", amount=48930.78620605, usd=12.34),
            mkrow(sig="sFee1", txType="sell", amount=-48.9307862, usd=0.1404884),
        ]
    )
    recs.append(
        np_.classify(
            g2,
            [
                mkev(
                    sig="sFee1", qty=48930.786206, qty_net=48930.786206, quote_usd=12.30
                ),
                mkev(
                    "SELL",
                    sig="sFee1",
                    qty=48.930786,
                    qty_net=48.930786,
                    quote_usd=0.127,
                    fee_leg=True,
                ),
            ],
            net_owner={CA: 48881.855420} if with_net_owner else None,
        )
    )
    g3 = _grp([mkrow(ca="CAUNAVAIL1", amount=500.0, usd=5.0)])
    recs.append(np_.classify(g3, None, fetch_error="POST ... → null (3 tries)"))
    g4 = _grp([mkrow(sig="sNull1", amount=1000.0, usd=None)])
    recs.append(
        np_.classify(
            g4, [mkev(sig="sNull1", qty=1000.0, qty_net=1000.0, quote_usd=12.4)]
        )
    )
    g5 = _grp(
        [
            mkrow(sig="sNa1", amount=100.0, usd=10.0),
            mkrow(sig="sNa1", txType="sell", amount=-40.0, usd=4.0),
        ]
    )
    recs.append(
        np_.classify(
            g5,
            [
                mkev(sig="sNa1", qty=100.0, qty_net=100.0, quote_usd=10.0),
                mkev("SELL", sig="sNa1", qty=40.0, qty_net=-40.0, quote_usd=4.0),
            ],
        )
    )
    g6 = np_.groups(
        [mkrow(sig="sTfp1", ca="1NJMqVM4x", txType="transfer", amount=-50.0, usd=1.0)]
    )[("sTfp1", WALLET, "1NJMqVM4x")]
    recs.append(
        np_.classify(
            g6,
            [mkev(sig="sTfp1", mint=CA)],
            reject_trace=["REJECT (2,2,'pAMM…',3) 1NJ… same_mint"],
        )
    )
    return recs


def test_pctl_interpolation():
    assert np_._pctl([0.9, 1.0, 1.1], 0.5) == 1.0
    assert close(np_._pctl([1.0, 2.0], 0.9), 1.9, eps=1e-9), np_._pctl([1.0, 2.0], 0.9)
    assert np_._pctl([], 0.5) == 0.0
    assert np_._pctl([5.0], 0.9) == 5.0


def test_gate_names_and_g9_formula():
    assert len(np_.GATE_NAMES) == 13
    assert list(np_.GATE_NAMES) == [f"G{i}" for i in range(1, 14)], list(np_.GATE_NAMES)
    assert all(isinstance(v, str) and v for v in np_.GATE_NAMES.values())
    assert "usd_ratio_adj" in np_.G9_FORMULA
    assert "<= 0.10" in np_.G9_FORMULA


def test_summarize_shape():
    recs = _six_records()
    s = np_.summarize(recs)
    assert set(s["class_counts"]) == set(np_.CLASS_PRECEDENCE)
    assert len(s["class_counts"]) == 10, "zero-fill đủ 10 class"
    cc = s["class_counts"]
    assert cc["MATCH"] == 2 and cc["UNAVAILABLE"] == 1
    assert cc["DEFERRED_USD_NULL"] == 1 and cc["NET_IDENTITY_NA"] == 1
    assert cc["TRANSFER_FALSE_POSITIVE"] == 1
    assert cc["MISSING"] == 0 and cc["AMOUNT_MISMATCH"] == 0
    assert sum(cc.values()) == s["n_records"] == 6
    assert s["n_sigs"] == 5 and s["n_sigs"] < s["n_records"]
    assert s["n_unavail_sigs"] == 1
    assert len(s["usd_ratios"]) == 3
    assert close(s["drift"], np_.global_drift(s["usd_ratios"]))
    assert close(s["drift"], 1.0), s["drift"]
    assert len(s["na_list"]) == 1
    assert s["transfer_only_total"] == 1 and s["transfer_only_unavailable"] == 0
    assert s["transfer_only_warn"] is False
    assert s["n_net_truth_zero"] == 1
    assert s["n_usd_null_groups"] == 1
    assert "oracle" not in s, "oracle chỉ xuất hiện khi được truyền"
    s2 = np_.summarize(recs, oracle={"gmgn_ok": True})
    assert s2["oracle"] == {"gmgn_ok": True}


def test_pass_bar_13_gates():
    recs = _six_records()
    gates = np_.pass_bar(np_.summarize(recs))
    assert len(gates) == 13, len(gates)
    assert [g[0] for g in gates] == [f"G{i}" for i in range(1, 14)]
    for g in gates:
        assert len(g) == 3, g
        assert g[1] is None or isinstance(g[1], bool), g
        assert isinstance(g[2], str), g
    assert gates[12][1] is None
    assert gates[12][2] == "not measured in this run", gates[12]
    assert gates[1][1] is False, "TFP present ⇒ G2 phải FAIL"
    gates2 = np_.pass_bar(
        np_.summarize(
            recs, oracle={"gmgn_ok": True, "backtest_ok": True, "fec2kxp_events": 2}
        )
    )
    assert gates2[12][1] is True, gates2[12]


def test_pass_bar_g4_g5_boundaries():
    good = _grp(
        [
            mkrow(sig="sG4", amount=48930.78620605, usd=12.34),
            mkrow(sig="sG4", txType="sell", amount=-48.9307862, usd=0.1404884),
        ]
    )
    rec_good = np_.classify(
        good,
        [
            mkev(sig="sG4", qty=48930.786206, qty_net=48930.786206, quote_usd=12.30),
            mkev(
                "SELL",
                sig="sG4",
                qty=48.930786,
                qty_net=48.930786,
                quote_usd=0.127,
                fee_leg=True,
            ),
        ],
    )
    assert rec_good["class"] == "MATCH"
    g4 = np_.pass_bar(np_.summarize([rec_good]))[3]
    assert g4[1] is True and g4[2] == "1/1", g4

    bad = _grp(
        [
            mkrow(sig="sG4b", amount=100.0, usd=10.0),
            mkrow(sig="sG4b", txType="sell", amount=-40.0, usd=4.0),
        ]
    )
    rec_bad = np_.classify(
        bad,
        [mkev(sig="sG4b", qty=100.0, qty_net=100.0, quote_usd=10.0)],
        reject_trace=["REJECT (1,1,'pAMM…',2) sell leg missing"],
    )
    assert rec_bad["class"] == "MISSING" and rec_bad["shape"] == "buy_sell"
    g4b = np_.pass_bar(np_.summarize([rec_good, rec_bad]))[3]
    assert g4b[1] is False and g4b[2] == "1/2", g4b

    ra = np_.classify(
        _grp([mkrow(sig="sD1", txType="sell", amount=-100.0, usd=5.0)]),
        [mkev("SELL", sig="sD1", qty=100.0, qty_net=-100.0, quote_usd=5.0)],
    )
    rb = np_.classify(
        _grp([mkrow(sig="sD1", ca="BMINT2", amount=50.0, usd=2.0)]),
        [mkev(sig="sD1", mint="BMINT2", qty=50.0, qty_net=50.0, quote_usd=2.0)],
    )
    assert ra["class"] == "MATCH" and rb["class"] == "MATCH"
    s3 = np_.summarize([ra, rb])
    assert len(s3["diff_ca_sigs"]) == 1, s3["diff_ca_sigs"]
    g5 = np_.pass_bar(s3)[4]
    assert g5[1] is True and g5[2] == "1/1", g5


def test_pass_bar_g6_g7_g9_g10_g11_g12():
    recs = _six_records(with_net_owner=True)
    s = np_.summarize(recs)
    gates = np_.pass_bar(s)
    assert len(s["net_owner_deltas"]) == 1
    assert abs(s["net_owner_deltas"][0]) < np_.NET_OWNER_EPS
    g6 = gates[5]
    assert g6[1] is True and g6[2].startswith("1/1"), g6
    g7 = gates[6]
    assert g7[1] is True and "truth_zero=1" in g7[2], g7
    g9 = gates[8]
    assert g9[1] is True and "max_adj_dev=" in g9[2], g9
    g10 = gates[9]
    assert g10[1] is True, g10  # fee ratio 0.904, drift 1.0 ⇒ trong gate 15%
    g11 = gates[10]
    assert g11[1] is True and g11[2] == "deferred=1 truth_null=1", g11
    g12 = gates[11]
    assert g12[1] is True and g12[2].startswith("1/5="), g12
    a, _, b = g12[2].split("=")[0].partition("/")
    assert a.isdigit() and b.isdigit(), g12[2]

    g8 = _grp(
        [
            mkrow(sig="sF8", amount=48930.78620605, usd=12.34),
            mkrow(sig="sF8", txType="sell", amount=-48.9307862, usd=0.1404884),
        ]
    )
    rec8 = np_.classify(
        g8,
        [
            mkev(sig="sF8", qty=48930.786206, qty_net=48930.786206, quote_usd=12.30),
            mkev(
                "SELL",
                sig="sF8",
                qty=48.930786,
                qty_net=48.930786,
                quote_usd=0.1404884 * 0.8,
                fee_leg=True,
            ),
        ],
    )
    assert rec8["class"] == "MATCH"
    g10b = np_.pass_bar(np_.summarize([rec8]))[9]
    assert g10b[1] is False, f"fee ratio 0.80 phải trượt gate 15%: {g10b}"


def test_write_jsonl_roundtrip():
    recs = _six_records()
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
        path = f.name
    try:
        np_.write_jsonl(path, recs)
        with open(path) as f:
            lines = [ln for ln in f if ln.strip()]
        assert len(lines) == len(recs)
        for ln, rec in zip(lines, recs):
            loaded = json.loads(ln)
            assert list(loaded.keys()) == list(np_.RECORD_FIELDS), list(loaded.keys())
            assert loaded == rec
    finally:
        os.unlink(path)


def test_write_report_sections():
    recs = _six_records()
    recs.append(
        np_.classify(
            _grp([mkrow(sig="sMiss", amount=1000.0, usd=12.5)]),
            [],
            reject_trace=["REJECT (1,1,'pAMM…',2) no_event"],
        )
    )
    meta = {
        "generated_at": "2026-09-22T12:00:00+07:00",
        "truth_path": ".probe/nansen-24h/tx-sample.jsonl",
        "fee_programs": [
            {
                "sig": "48Y3e48T4z…",
                "encl": "e#1",
                "program": "pAMMBay6…",
                "collector": "3CgvbiM3…",
            }
        ],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        path = f.name
    try:
        text = np_.write_report(path, recs, meta, {})
        with open(path) as f:
            assert f.read() == text, "file trên disk phải đúng text trả về"
        for want in (
            "## Class counts",
            "## Root causes",
            "## Phase-2",
            "wallet_hist.py:106",
            "GMGN/Nansen oracle divergence",
            "## Scope boundary",
            "wallet_watch.py:134",
            "nansen.ts:133",
            "db.ts:147",
            "## Fee-USD ratio",
            np_.G9_FORMULA,
            "pAMMBay6",
            "3CgvbiM3",
        ):
            assert want in text, want
        for i in range(1, 14):
            assert f"G{i}" in text, f"G{i}"
        for r in recs:
            if r["class"] != "MATCH":
                assert r["sig"][:12] in text, f"thiếu root cause {r['sig'][:12]}"
    finally:
        os.unlink(path)


# ============================================ todo 6 — IO layer tests (offline 100%)
#
# Không network: fetch_tx/detect_for/capture_prices chỉ chạy trên cache đã có
# (.probe/nansen-parity/fixtures + prices.json); mọi đường mạng bị block cứng
# (pattern test_gmgn_api_parity.py:119-131). Đường MISS của fetch_tx test bằng
# _post_tx monkeypatch trong tmp dir.

ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(HERE, "nansen_parity.py")
FIXTURES = os.path.join(ROOT, ".probe", "nansen-parity", "fixtures")
PRICES = os.path.join(ROOT, ".probe", "nansen-parity", "prices.json")
TRUTH = os.path.join(ROOT, ".probe", "nansen-24h", "tx-sample.jsonl")
VALID_SIG = "1bPapYy2WrpxGNNLHZhGvDHcu5rTuJgaJp6MsaWLJNAtUYYGUXxvfivV7mUhK5VbGfccKziPyz7EQmHycoFx6Fi"
NULL_SIG = "1" * 64  # QA null fixture (todo 2)


def _block_net():
    """Chặn mọi đường ra mạng của np_ (urlopen + ww.http_json/rpc/token_info)."""
    saved = {"urlopen": urllib.request.urlopen}
    urlopen_raiser = _net_raiser
    urllib.request.urlopen = urlopen_raiser
    for name in ("http_json", "rpc", "token_info"):
        saved[name] = getattr(np_.ww, name)
        setattr(np_.ww, name, urlopen_raiser)
    return saved


def _net_raiser(*a, **k):
    raise AssertionError(f"NETWORK CALL from test (hermetic violated): {a!r}")


def _restore_net(saved):
    urllib.request.urlopen = saved["urlopen"]
    for name in ("http_json", "rpc", "token_info"):
        setattr(np_.ww, name, saved[name])


class _StubWW:
    """Stub đủ shape cho seed_prices: _info + _sol_px."""

    def __init__(self):
        self._info = {}
        self._sol_px = {"v": 0.0}


def test_t6_tx_params_and_rpc_pin():
    """_TX_PARAMS đúng backtest_parity.py:42-48; RPC_PIN mainnet-beta khi env unset."""
    assert np_._TX_PARAMS == {
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 1,
        "commitment": "confirmed",
    }
    if not (os.environ.get("SOLANA_RPC_URL") or os.environ.get("RPC_HTTP")):
        assert np_.RPC_PIN == "https://api.mainnet-beta.solana.com"


def test_t6_tx_unavailable_matrix():
    """None / thiếu 'transaction' / meta.err != null ⇒ True; happy dict ⇒ False."""
    assert np_.tx_unavailable(None) is True
    assert np_.tx_unavailable({}) is True
    assert np_.tx_unavailable("junk") is True
    assert np_.tx_unavailable({"meta": {"err": None}}) is True  # thiếu transaction
    assert np_.tx_unavailable({"transaction": {}, "meta": {"err": {"x": 1}}}) is True
    assert np_.tx_unavailable({"transaction": {}, "meta": {"err": None}}) is False
    assert np_.tx_unavailable({"transaction": {}}) is False  # không meta ⇒ err None


def test_t6_fixtures_are_root_level_cache():
    """Mọi file cache trên disk là root-level: 'transaction' in d, KHÔNG 'result'."""
    names = sorted(n for n in os.listdir(FIXTURES) if n.endswith(".json"))
    assert len(names) >= 24
    n_valid = n_null = 0
    for n in names:
        d = json.load(open(os.path.join(FIXTURES, n), encoding="utf-8"))
        if d is None:  # QA null sig — null cũng được cache (reproducible offline)
            n_null += 1
            continue
        assert "transaction" in d and "result" not in d, f"cache không root-level: {n}"
        n_valid += 1
    assert n_valid >= 23 and n_null >= 1


def test_t6_fetch_tx_cache_first_zero_network():
    """Cache hit (kể cả cached-null) ⇒ 0 call, không chạm mạng."""
    saved = _block_net()
    try:
        tx, calls, err = np_.fetch_tx(VALID_SIG, FIXTURES)
        assert calls == 0 and err is None
        assert isinstance(tx, dict) and "transaction" in tx
        tx2, calls2, err2 = np_.fetch_tx(NULL_SIG, FIXTURES)
        assert tx2 is None and calls2 == 0 and err2  # cached null ⇒ UNAVAILABLE path
    finally:
        _restore_net(saved)


def test_t6_fetch_tx_miss_retries_and_caches_every_response():
    """Miss ⇒ retry 2 (3 attempt), sleep tắt; MỌI result kể cả null ghi cache
    root-level; lỗi transport không ghi cache; lần 2 cache-first 0 POST."""
    tmp = tempfile.mkdtemp()
    saved = (getattr(np_, "_post_tx"), getattr(np_, "SLEEP_BETWEEN"),
             getattr(np_, "BACKOFFS"))
    setattr(np_, "SLEEP_BETWEEN", 0)
    setattr(np_, "BACKOFFS", (0, 0))
    try:
        n_post = [0]

        def fake_null(sig):
            n_post[0] += 1
            return {"jsonrpc": "2.0", "id": 1, "result": None}

        setattr(np_, "_post_tx", fake_null)
        tx, calls, err = np_.fetch_tx("A" * 64, tmp)
        assert tx is None and calls == 3 and n_post[0] == 3 and err
        p = os.path.join(tmp, "A" * 64 + ".json")
        assert os.path.exists(p) and json.load(open(p)) is None  # null vẫn ghi cache

        def boom(sig):
            raise AssertionError("cache hit phải KHÔNG POST")

        setattr(np_, "_post_tx", boom)
        tx, calls, err = np_.fetch_tx("A" * 64, tmp)
        assert tx is None and calls == 0 and err

        res = {"transaction": {"signatures": ["B" * 64]}, "meta": {"err": None}}
        setattr(np_, "_post_tx", lambda sig: {"result": res})
        tx, calls, err = np_.fetch_tx("B" * 64, tmp)
        assert tx == res and calls == 1 and err is None
        d = json.load(open(os.path.join(tmp, "B" * 64 + ".json")))
        assert "transaction" in d and "result" not in d  # root-level, không wrapper

        attempts = [0]

        def fail(sig):
            attempts[0] += 1
            raise OSError("net down")

        setattr(np_, "_post_tx", fail)
        tx, calls, err = np_.fetch_tx("C" * 64, tmp)
        assert tx is None and calls == 3 and attempts[0] == 3 and err
        assert not os.path.exists(os.path.join(tmp, "C" * 64 + ".json"))
    finally:
        setattr(np_, "_post_tx", saved[0])
        setattr(np_, "SLEEP_BETWEEN", saved[1])
        setattr(np_, "BACKOFFS", saved[2])


def test_t6_load_seed_prices_roundtrip():
    """load_prices đọc snapshot (missing ⇒ {}); seed_prices đổ _info + _sol_px."""
    snap = {
        "captured_at": "2026-09-22T00:00:00+00:00",
        "sol_usd": 116.62,
        "prices": {"MintAAA": ["AAA", 1.5], np_.ww.WSOL: ["SOL", 116.62]},
    }
    tmp = tempfile.mkdtemp()
    p = os.path.join(tmp, "prices.json")
    json.dump(snap, open(p, "w"))
    assert np_.load_prices(p) == snap
    assert np_.load_prices(os.path.join(tmp, "nope.json")) == {}
    s = _StubWW()
    np_.seed_prices(s, snap)
    assert s._info["MintAAA"] == ("AAA", 1.5)
    assert s._info[np_.ww.WSOL] == ("SOL", 116.62)
    assert s._sol_px["v"] == 116.62


def test_t6_seed_covers_every_fixture_balance_mint():
    """CRITICAL gotcha: snapshot phải phủ WSOL + MỌI mint trong
    pre/postTokenBalances của tx đã cache — thiếu 1 mint ⇒ detect_swaps rò mạng."""
    snap = np_.load_prices(PRICES)
    assert snap.get("captured_at"), "prices.json phải có captured_at"
    universe = {np_.ww.WSOL}
    for n in os.listdir(FIXTURES):
        if n.endswith(".json"):
            d = json.load(open(os.path.join(FIXTURES, n), encoding="utf-8"))
            universe |= np_.tx_mints(d)
    s = _StubWW()
    np_.seed_prices(s, snap)
    missing = sorted(universe - set(s._info))
    assert not missing, f"mint chưa seed (sẽ rò network call): {missing}"
    assert s._sol_px["v"] > 0
    assert float(snap["prices"][np_.ww.WSOL][1]) > 0


def test_t6_capture_prices_cache_hit_zero_calls():
    """capture_prices trên snapshot đủ phủ ⇒ 0 network call, ww được seed."""
    tmp = tempfile.mkdtemp()
    p = os.path.join(tmp, "prices.json")
    snap = np_.load_prices(PRICES)
    json.dump(snap, open(p, "w"))
    mints = {np_.ww.WSOL} | set(list(snap["prices"])[:5])
    saved = _block_net()
    try:
        calls = np_.capture_prices(mints, p)
        assert calls == 0
        assert np_.ww._info[np_.ww.WSOL][1] > 0
        assert np_.ww._sol_px["v"] > 0
    finally:
        _restore_net(saved)


def test_t6_detect_for_cached_zero_network():
    """detect_for end-to-end trên cache: 0 network call, events list, err None;
    QA null sig ⇒ (None, 0, err) — đường UNAVAILABLE."""
    grps = np_.groups(np_.load_truth(TRUTH))
    wallet = next(g.wallet for g in grps.values() if g.sig == VALID_SIG)
    saved = _block_net()
    try:
        tr = []
        events, calls, err = np_.detect_for(
            VALID_SIG, wallet, tr, cache_dir=FIXTURES, prices_path=PRICES
        )
        assert calls == 0 and err is None and isinstance(events, list)
        ev2, calls2, err2 = np_.detect_for(
            NULL_SIG, wallet, [], cache_dir=FIXTURES, prices_path=PRICES
        )
        assert ev2 is None and calls2 == 0 and err2
    finally:
        _restore_net(saved)


def test_t6_cli_missing_truth_exits_nonzero_no_output():
    """--truth file không tồn tại ⇒ exit != 0, message rõ, KHÔNG để lại parity.jsonl."""
    tmp = tempfile.mkdtemp()
    out = os.path.join(tmp, "out")
    r = subprocess.run(
        [
            sys.executable,
            SCRIPT,
            "--truth",
            os.path.join(tmp, "nope.jsonl"),
            "--out",
            out,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert r.returncode != 0, f"phải exit != 0, got 0; stdout={r.stdout[:200]}"
    assert "truth" in (r.stderr + r.stdout).lower()
    assert not os.path.exists(os.path.join(out, "parity.jsonl"))


# ============================================ todo 6 FIX — --seed int RNG + --prices path


def test_t6fix_select_sigs_semantics():
    """--limit tường minh: --sigs ⇒ filter+first N sorted; seed ⇒ Random(seed).sample
    tất định trên sorted(pop); không cả hai ⇒ first N sorted. Local Random, không
    chạm global RNG state."""
    import random as _random

    pop = [f"sig{i:03d}" for i in range(50)]
    global_before = _random.getstate()
    assert np_.select_sigs(pop, limit=3) == sorted(pop)[:3]
    sub = ["sig010", "sig002", "sig030", "sig001"]
    assert np_.select_sigs(pop, sigs=sub, limit=2) == ["sig001", "sig002"]
    assert np_.select_sigs(pop, sigs=sub) == ["sig001", "sig002", "sig010", "sig030"]
    a = np_.select_sigs(pop, limit=5, seed=42)
    b = np_.select_sigs(pop, limit=5, seed=42)
    assert a == b == sorted(_random.Random(42).sample(sorted(pop), 5))
    assert np_.select_sigs(pop, limit=5, seed=7) != a
    assert len(np_.select_sigs(pop, limit=999, seed=42)) == 50  # clamp, không crash
    assert _random.getstate() == global_before  # global RNG untouched
    # prefix tokens: superset của exact match (sig đầy đủ là prefix của chính nó)
    assert np_.select_sigs(pop, sigs=["sig001", "sig010"]) == ["sig001", "sig010"]
    assert np_.select_sigs(pop, sigs=["sig01"], limit=3) == ["sig010", "sig011", "sig012"]


def test_t6fix_main_parses_seed_as_int_and_prices_flag():
    """main(): --seed 42 là int RNG seed (KHÔNG phải path '42'); --prices là path
    snapshot với default PRICES; behaviour --seed-as-path cũ đã chết."""
    captured = {}
    saved_run = getattr(np_, "run")

    def fake_run(truth, **kw):
        captured.clear()
        captured["truth"] = truth
        captured.update(kw)
        return 0

    setattr(np_, "run", fake_run)
    try:
        rc = np_.main(["--limit", "2", "--seed", "42", "--truth", TRUTH])
        assert rc == 0
        assert captured["seed"] == 42 and isinstance(captured["seed"], int)
        assert captured["limit"] == 2
        assert captured["prices_path"] == np_.PRICES_DEFAULT
        rc = np_.main(["--limit", "1", "--prices", "/tmp/x.json", "--truth", TRUTH])
        assert rc == 0
        assert captured["prices_path"] == "/tmp/x.json"
        assert captured["seed"] is None
    finally:
        setattr(np_, "run", saved_run)


def test_t6fix_run_seeded_selection_reproducible_offline():
    """run(seed=42, limit=2) end-to-end offline: 2 lần ⇒ cùng tập sig, khớp
    random.Random(42).sample(sorted(pop), 2); fetch fail (network blocked) ⇒
    UNAVAILABLE records, KHÔNG network thật."""
    import random as _random

    tmp = tempfile.mkdtemp()
    prices_tmp = os.path.join(tmp, "prices.json")
    with open(prices_tmp, "w") as f:
        json.dump(np_.load_prices(PRICES), f)
    rows = np_.load_truth(TRUTH)
    pop = sorted({r["transactionHash"] for r in rows})
    expected = set(_random.Random(42).sample(pop, 2))

    saved = _block_net()
    saved_post = getattr(np_, "_post_tx")
    saved_sleep = (getattr(np_, "SLEEP_BETWEEN"), getattr(np_, "BACKOFFS"))
    setattr(np_, "SLEEP_BETWEEN", 0)
    setattr(np_, "BACKOFFS", (0, 0))

    def blocked_post(sig):
        raise OSError("network blocked in test")

    setattr(np_, "_post_tx", blocked_post)
    try:
        got = []
        for i in range(2):
            out = os.path.join(tmp, f"out{i}")
            rc = np_.run(TRUTH, limit=2, seed=42, out=out, prices_path=prices_tmp)
            assert rc == 0
            recs = [
                json.loads(line)
                for line in open(os.path.join(out, "parity.jsonl"), encoding="utf-8")
            ]
            assert recs and all(r["class"] for r in recs)
            got.append({r["sig"] for r in recs})
        assert got[0] == got[1] == expected
    finally:
        setattr(np_, "_post_tx", saved_post)
        setattr(np_, "SLEEP_BETWEEN", saved_sleep[0])
        setattr(np_, "BACKOFFS", saved_sleep[1])
        _restore_net(saved)


# -------------------------------------------------------------------- runner


def main():
    tests = [
        (n, f)
        for n, f in sorted(globals().items())
        if n.startswith("test_") and callable(f)
    ]
    fail = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except BaseException:
            fail += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    total = len(tests)
    if fail:
        print(f"RED: {total - fail}/{total} pass, {fail} fail")
        return 1
    print(f"OK: nansen_parity pure core {total}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
