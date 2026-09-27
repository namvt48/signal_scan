#!/usr/bin/env python3
"""T8 — gate parity 29/29 row GMGN, OFFLINE + hermetic (plan §T8, §2.2-§2.5, §5.6).

Chạy (từ repo root):
    python3 scripts/test_gmgn_api_parity.py           # gate + malformed probes + 4 mutation Red→Green
    TRACE=1 python3 scripts/test_gmgn_api_parity.py   # thêm bảng PAIR/REJECT/RANK/STEP (T2-style)

Stdout KHÔNG chứa timestamp/wall-clock (wall time đi stderr) ⇒ chạy 2 lần cho
stdout byte-for-byte giống nhau; determinism chứng minh bằng diff thật.

Stdlib only — không pytest, không dependency mới (§5.2). Mọi mint/address/symbol/
wallet build TỪ fixture (§5.7 — cấm gõ literal). Sig prefix 8 ký tự chỉ là nhãn
row trong §2.3, không phải address; G_ROWS chỉ chứa symbol + số oracle.

HERMETIC: seed `ww._info` từ fixture ⇒ entry không có marker `_info_miss` ⇒
`token_info()` hit vĩnh viễn (docstring wallet_watch.py L184); thêm `ww.http_json`
/`ww.rpc` = raise và `socket.socket` = raise ⇒ network bị chặn bằng HÀNH VI chứ
không chỉ bằng grep (§5.1/§5.3).

MUTATION 1-4 đổi RULE của detector NGAY TRONG PROCESS (không ghi `wallet_watch.py`
— sha256+mtime được so trước/sau, không sửa expectation của test) ⇒ gate phải FAIL;
revert bằng `load_module()` fresh từ file (không revert bán phần) ⇒ PASS.

PASS line (nguyên văn, §1 DoD#1):
    PASS steps 29/29 · identity 29/29 · side 29/29 · amounts exact 23/29 + 6 gross (amount_basis=gross_leg)
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import inspect
import json
import os
import socket
import sys
import textwrap
import time
from collections import Counter
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH = os.path.join(HERE, "wallet_watch.py")
FIX = os.path.join(HERE, "fixtures")
ROWS_FILE = os.path.join(FIX, "gmgn_rows_fixture.json")
SKIP_FIX = {
    "gmgn_rows_fixture.json",
    "block_sample.json",
    "gm_activity_FhsbQ_50rows.json",
}

REL_TOL = 1e-6  # pin cứng §5.6 — so uiAmount, KHÔNG int-equal trên raw (artifact §2.2)
GROSS_CAP = 0.08  # 6 row LP-fee: rel_overstate ≤ 8%, mẫu = EMITTED (§T8, D14)
N_ROW, N_EXACT, N_GROSS = 29, 23, 6
PASS_LINE = (
    "PASS steps 29/29 · identity 29/29 · side 29/29 · "
    "amounts exact 23/29 + 6 gross (amount_basis=gross_leg)"
)

# 6 row LP-fee (§2.3 cột `amt`) — expected-value data CHỈ dùng trong test, detector
# KHÔNG được suy ra (§3 Bước 5, MB1). Khoá đọc TỪ ORACLE ROW (sig, side, base_sym,
# quote_sym + số oracle trên leg gross) — không đọc từ event, để mutation đổi side
# không "né" được tolerance gross. Bắt buộc kèm quote_sym + số oracle vì
# (sig, side, base) KHÔNG phân biệt được: `33hqSn4Q` có 2 row SELL XBT (1 exact
# 1 gross), `3BbWVS3K`/`3nzGD2WV` mỗi sig 3 row BUY CARDS←USDC, `58pWphuG` 2 row
# SELL CARDS←USDC. Cấm re-type mint address — ở đây chỉ có symbol + số oracle.
G_ROWS = [
    ("33hqSn4Q", "SELL", "XBT", "WSOL", "base", 97779.906425),
    ("3BbWVS3K", "BUY", "CARDS", "USDC", "quote", 150.96474),
    ("3nzGD2WV", "BUY", "CARDS", "USDC", "quote", 449.888419),
    ("58pWphuG", "SELL", "CARDS", "USDC", "base", 6394.913585),
    ("58pWphuG", "SELL", "OS", "WSOL", "base", 1796185.193240272),
    ("5XLTG1WX", "SELL", "ORE", "USDC", "base", 9.46722534902),
]
# rel_overstate % đã đo/pin ở §2.2 — in ra ĐỐI CHỨNG, không dùng làm ngưỡng pass.
G_PINNED = {
    ("58pWphuG", "SELL", "CARDS"): 0.2025,
    ("58pWphuG", "SELL", "OS"): 7.75,
    ("5XLTG1WX", "SELL", "ORE"): 0.8259,
    ("33hqSn4Q", "SELL", "XBT"): 4.8524,
    ("3nzGD2WV", "BUY", "CARDS"): 0.2018,
    ("3BbWVS3K", "BUY", "CARDS"): 0.2401,
}
EXPECT_COUNT = {  # §2.3 — số event mỗi sig, HARD FAIL nếu lệch
    "2k3KYp18": 2,
    "33hqSn4Q": 4,
    "3BbWVS3K": 4,
    "3fec2kXP": 2,
    "3nzGD2WV": 4,
    "3pkGZDK1": 4,
    "4zmaV87B": 3,
    "58pWphuG": 4,
    "5XLTG1WX": 2,
}
BTC_PEG = ("WBTC", "cbBTC", "XBT")  # §2.4 — cấm BTC-peg lọt vào TIER_A
# offset cột STEP mà detect_swaps phát qua `trace=` callable:
# STEP sig | frame | pool | sym | quote_sym | rs | rd | side | qty | quote_qty | basis
ST_FRAME, ST_POOL = 1, 2
ST_RS, ST_RD, ST_SIDE, ST_BASIS = 5, 6, 7, 10


# ---------------------------------------------------------------- module + network


def sha_of(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def load_module():
    """Fresh module MỖI lần — không reuse module đã mutate (stale_state)."""
    spec = importlib.util.spec_from_file_location("wallet_watch", WATCH)
    assert spec and spec.loader
    ww = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ww)
    return ww


def block_network(ww) -> None:
    """Chặn cứng network: http_json/rpc raise nếu được gọi, socket.socket raise."""

    def no_http(*a, **k):
        raise AssertionError(
            f"NETWORK CALL from parity gate (hermetic violated): {a!r}"
        )

    def no_socket(*a, **k):
        raise AssertionError("NETWORK SOCKET from parity gate (hermetic violated)")

    ww.http_json, ww.rpc = no_http, no_http
    socket.socket = no_socket


def load_fixtures():
    """(rows_root, txs{sig: tx} dedupe theo transaction.signatures[0], tên file)."""
    data = json.load(open(ROWS_FILE, encoding="utf-8"))
    txs, names = {}, []
    for name in sorted(os.listdir(FIX)):
        if not name.endswith(".json") or name in SKIP_FIX:
            continue
        tx = json.load(open(os.path.join(FIX, name), encoding="utf-8"))
        if not (isinstance(tx, dict) and "transaction" in tx):
            continue
        sig = tx["transaction"]["signatures"][
            0
        ]  # root KHÔNG có wrapper `result` (§2.5)
        names.append(name)
        txs.setdefault(sig, tx)  # 12 file → 9 sig; 3 cặp byte-identical (§2.5)
    return data, txs, names


def mint_map(rows):
    """mint → (symbol, price) build TỪ fixture: token.address / quote_token.token_address."""
    out = {}
    for r in rows:
        out[r["token"]["address"]] = (
            r["token"]["symbol"],
            float(r.get("price_usd") or 1.0),
        )
        qt = r["quote_token"]
        out.setdefault(qt["token_address"], (qt["symbol"], 1.0))
    return out


def seed(ww, rows):
    """Hermetic seed. Entry seed thẳng vào `_info` không có marker `_info_miss`
    ⇒ `token_info()` hit vĩnh viễn, không bao giờ gọi mạng (docstring L184)."""
    mm = mint_map(rows)
    ww._info.clear()
    ww._info_miss.clear()
    ww._info.update(mm)
    ww._sol_px["v"] = 100.0
    ww.min_usd = 0.0
    return mm


def seed_probe(ww, rows) -> int:
    """stale_state: seed idempotent, re-apply mỗi run, không leak state cũ."""
    a = seed(ww, rows)
    assert a == seed(ww, rows) and ww._info == a, "seed không idempotent"
    assert not ww._info_miss, "seed để lại _info_miss ⇒ token_info sẽ fetch mạng"
    assert ww._sol_px["v"] == 100.0 and ww.min_usd == 0.0, "seed _sol_px/min_usd sai"
    assert not ww._supply, "_supply phải rỗng — detect_swaps không cần supply"
    assert len(a) == len({m for m, (s, _p) in a.items() if s}), (
        "mint map có entry rỗng symbol"
    )
    return len(a)


def preflight(rows) -> int:
    """Fixture intact TRƯỚC khi chạy — để fixture hỏng không hoá thân thành FAIL giả."""
    assert len(rows) == N_ROW, f"oracle rows={len(rows)} exp={N_ROW}"
    for name, cnt in sorted(EXPECT_COUNT.items()):
        got = len([r for r in rows if r["tx_hash"][:8] == name])
        assert got == cnt, f"fixture rows {name}: {got} exp {cnt}"
    sigs = {r["tx_hash"] for r in rows}
    assert len(sigs) == len(EXPECT_COUNT), (
        f"distinct tx_hash trong oracle={len(sigs)} exp=9"
    )
    assert not [r for r in rows if not r.get("wallet")], "row thiếu wallet"
    return len(sigs)


def group_rows(rows):
    """sig → [(vị_trí_trong_fixture, row)] giữ NGUYÊN thứ tự file (§2.5 root.rows)."""
    grouped: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for i, r in enumerate(rows, 1):
        grouped.setdefault(r["tx_hash"], []).append((i, r))
    return grouped


# ---------------------------------------------------------------- so sánh


def rel_diff(got: float, exp: float) -> float:
    if exp == 0:
        return 0.0 if got == 0 else float("inf")
    return abs(got - exp) / abs(exp)


def gross_leg_of(sig: str, row: dict[str, Any]) -> str | None:
    """Leg gross ('base'/'quote') của ORACLE ROW này, hoặc None nếu row PHẢI exact.
    Quyết định từ dữ liệu oracle + G_ROWS (expected-value), KHÔNG từ event."""
    exp_b, exp_q = float(row["token_amount"]), float(row["quote_amount"])
    for sp, side, bs, qs, leg, val in G_ROWS:
        if sp != sig[:8] or side != row["event_type"].upper():
            continue
        if bs != row["token"]["symbol"] or qs != row["quote_token"]["symbol"]:
            continue
        if rel_diff(val, exp_b if leg == "base" else exp_q) <= REL_TOL:
            return leg
    return None


def check_amounts(ev: dict[str, Any], row: dict[str, Any], leg: str | None):
    """`qty`(base)/`quote_qty`(quote) — tên field theo `_swap_event` L565-596 (§3 Bước 5).
    Leg gross: emitted ≥ oracle VÀ (emitted−oracle)/EMITTED ≤ 8% — mẫu pin = gross
    theo §T8 (lấy mẫu bằng oracle thì row OS thành 8.4011% ⇒ fail giả trên code đúng).
    Leg không gross: rel ≤ 1e-6, KHÔNG nới (§5.6)."""
    why: list[str] = []
    ov: dict[str, float | None] = {"base": None, "quote": None}
    for field in ("base", "quote"):
        exp = float(row["token_amount"] if field == "base" else row["quote_amount"])
        got = ev["qty"] if field == "base" else ev["quote_qty"]
        if field != leg:
            rd = rel_diff(got, exp)
            if rd > REL_TOL:
                why.append(
                    f"{field}_amt exp={exp!r} got={got!r} rel={rd:.3e} > {REL_TOL:g}"
                )
            continue
        if got < exp:
            why.append(f"{field}_gross BELOW oracle emitted={got!r} < oracle={exp!r}")
            continue
        val = ((got - exp) / got) if got else float("inf")
        ov[field] = val
        if val > GROSS_CAP:
            why.append(f"{field}_gross rel_overstate {val:.6%} > {GROSS_CAP:.0%}")
    return why, ov


def check_symbols(ev: dict[str, Any], row: dict[str, Any]) -> list[str]:
    """identity (base/quote symbol) + side — đo TỪ CẶP theo vị trí, không tautology."""
    why = []
    for field, got, exp in (
        ("base_sym", ev["sym"], row["token"]["symbol"]),
        ("quote_sym", ev["quote_sym"], row["quote_token"]["symbol"]),
    ):
        if got != exp:
            why.append(f"{field} exp={exp} got={got}")
    if ev["side"] != row["event_type"].upper():
        why.append(f"side exp={row['event_type'].upper()} got={ev['side']}")
    return why


def key_of(
    ev: dict[str, Any] | None, row: dict[str, Any] | None
) -> tuple[str, str, str]:
    """Khoá §2.3 = (side, base_symbol, quote_symbol) — dùng cho multiset độc lập thứ tự."""
    if ev is not None:
        return (ev["side"], ev["sym"], ev["quote_sym"])
    assert row is not None
    return (
        row["event_type"].upper(),
        row["token"]["symbol"],
        row["quote_token"]["symbol"],
    )


def row_line(
    tag: str,
    orow: int | None,
    row: dict[str, Any] | None,
    ev: dict[str, Any] | None,
    leg: str | None,
    why: list[str],
    ov: dict[str, Any],
) -> str:
    """1 dòng của bảng 29 row: oracle(expected) | event(got) | rel | leg gross | OK/FAIL."""
    exp = (
        "<oracle khong co row>"
        if row is None
        else f"{row['event_type'].upper():<4} {row['token']['symbol']:<9}"
        f"\u2190{row['quote_token']['symbol']:<6} "
        f"{float(row['token_amount']):>17.9g} / {float(row['quote_amount']):>15.9g}"
    )
    got = (
        "<KHONG CO EVENT>"
        if ev is None
        else f"{ev['side']:<4} {ev['sym']:<9}\u2190{ev['quote_sym']:<6} "
        f"{ev['qty']:>17.9g} / {ev['quote_qty']:>15.9g}"
    )
    rel = (
        ""
        if (row is None or ev is None)
        else (
            f"rel-base {rel_diff(ev['qty'], float(row['token_amount'])):.2e} "
            f"rel-quote {rel_diff(ev['quote_qty'], float(row['quote_amount'])):.2e}"
        )
    )
    ovs = " ".join(f"{k}_overstate={v:.4%}" for k, v in ov.items() if v is not None)
    st = "FAIL" if why else "OK  "
    return (
        f"{tag:<16} {st} {('G:' + leg) if leg else '\u00b7':<10} orow#{orow or '-':>2}  "
        f"exp {exp}  |  got {got}  |  {rel} {ovs}"
    )


def diff_line(
    ev: dict[str, Any] | None, step: str | None, row: dict[str, Any] | None
) -> str:
    """Bảng diff khi FAIL: expected | got | role endpoints | frame_key | pool/pair reason."""
    ex = (
        "-"
        if row is None
        else (
            f"{row['event_type'].upper()} {row['token']['symbol']}"
            f"\u2190{row['quote_token']['symbol']}"
        )
    )
    got = "-" if ev is None else f"{ev['side']} {ev['sym']}\u2190{ev['quote_sym']}"
    roles = frame = pool = prog = "-"
    if step is not None:
        p = [x.strip() for x in step.split("|")]
        frame, pool = p[ST_FRAME], p[ST_POOL]
        roles = f"{p[ST_RS]}->{p[ST_RD]}"
    if ev is not None:
        prog = str(ev.get("program") or "-")[:10]
    return (
        f"      DIFF exp={ex:<26} got={got:<26} roles={roles:<16} "
        f"frame_key={frame:<34} pool={pool[:12] if pool != '-' else pool} prog={prog} "
        f"pair/reject=xem trace PAIR/REJECT của sig này"
    )


def align(evs: list[dict[str, Any]], oracle: list[tuple[int, dict[str, Any]]]):
    """Ghép event theo thứ tự thực thi với oracle row trên BẢN ĐẢO NGƯỢC.

    ĐO ĐƯỢC (9/9 sig): GMGN list step theo thứ tự ĐẢO NGƯỢC thực thi, còn
    `detect_swaps` sort theo `min(seq)` = thứ tự thực thi (§3 Bước 1) ⇒ cặp vị trí
    phải đảo. §2.3 bắt khớp bằng KEY (sig, side, base, quote) chứ không bằng vị trí,
    nên identity/side được kiểm THÊM bằng key-multiset (độc lập thứ tự) ở
    `multiset_fails` — bảng vị trí chỉ là phép ĐO không tautology."""
    rev = list(reversed(oracle))
    for i in range(max(len(evs), len(rev))):
        fidx, row = rev[i] if i < len(rev) else (None, None)
        yield i + 1, evs[i] if i < len(evs) else None, fidx, row


def multiset_fails(
    sig: str, evs: list[dict[str, Any]], oracle: list[tuple[int, dict[str, Any]]]
) -> list[str]:
    """§2.3: khớp bằng (sig, side, base_symbol, quote_symbol) — KHÔNG phụ thuộc thứ tự."""
    ce, cr = (
        Counter(key_of(e, None) for e in evs),
        Counter(key_of(None, r) for _i, r in oracle),
    )
    if ce == cr:
        return []
    return [
        f"{sig[:8]} key-multiset (side,base,quote) lệch §2.3: oracle thiếu "
        f"{dict(cr - ce) or '{}'} · event thừa {dict(ce - cr) or '{}'}"
    ]


def order_probe(
    evs: list[dict[str, Any]], oracle: list[tuple[int, dict[str, Any]]]
) -> tuple[int, int, int]:
    """(số cặp khớp symbol theo thứ tự ĐẢO, theo thứ tự THUẬN, tổng) — evidence thứ tự."""

    def hit(lst):
        return sum(
            1 for e, (_i, r) in zip(evs, lst) if key_of(e, None) == key_of(None, r)
        )

    return hit(list(reversed(oracle))), hit(oracle), len(evs)


# ---------------------------------------------------------------- gate


def new_state(wallet: str) -> dict[str, Any]:
    return {
        "wallet": wallet,
        "n_ev": 0,
        "paired": 0,
        "ident": 0,
        "side": 0,
        "qi": 0,
        "basis": 0,
        "exact": 0,
        "gross": 0,
        "n_step": 0,
        "n_pool": 0,
        "pairs": [],
        "gross_rows": [],
        "order": {},
        "per_sig": {},
    }


def gate(ww, txs: dict[str, dict[str, Any]], rows: list[dict[str, Any]]):
    """Chạy detect_swaps trên 9 tx, so 29 oracle row. Trả (report, fails, traces, st)."""
    wallet = rows[0]["wallet"]  # §5.7 — qua ["rows"], cấm gõ literal
    grouped = group_rows(rows)
    order = {
        h: i for i, h in enumerate(dict[str, Any].fromkeys(r["tx_hash"] for r in rows))
    }
    report, fails, traces, steps_of = [], [], {}, {}
    st = new_state(wallet)
    for sig in sorted(txs, key=lambda s: order.get(s, 1 << 30)):
        tr: list[str] = []
        traces[sig] = tr
        evs = ww.detect_swaps(txs[sig], wallet, tr.append)
        steps_of[sig] = [ln for ln in tr if ln.startswith("STEP ")]
        oracle = grouped.get(sig, [])
        report += sig_report(sig, evs, oracle, st, fails)
        for i, ev, fidx, row in align(evs, oracle):
            step = steps_of[sig][i - 1] if len(steps_of[sig]) >= i else None
            _score(sig, i, fidx, row, ev, step, st, fails, report)
    fails += invariants(st, txs, steps_of) + tier_fails(ww, rows)
    return report, fails, traces, st


def sig_report(sig: str, evs, oracle, st, fails) -> list[str]:
    """Dòng per-sig expected-vs-got + kiểm count pin §2.3 + key-multiset + thứ tự."""
    want = EXPECT_COUNT.get(sig[:8])
    rev, fwd, n = order_probe(evs, oracle)
    st["order"][sig[:8]] = (rev, fwd, n)
    st["per_sig"][sig[:8]] = (want, len(oracle), len(evs))
    st["n_ev"] += len(evs)
    if not oracle:
        fails.append(
            f"{sig[:8]} tx không nằm trong 29 oracle rows (thừa tx, không có row đối chiếu)"
        )
    if len(evs) != len(oracle):
        fails.append(
            f"{sig[:8]} SỐ STEP lệch: oracle_rows={len(oracle)} emitted_events={len(evs)}"
        )
    if want is not None and len(evs) != want:
        fails.append(f"{sig[:8]} per-sig count pin §2.3 exp={want} got={len(evs)}")
    fails += multiset_fails(sig, evs, oracle)
    verdict = "match" if want == len(evs) == len(oracle) else "MISMATCH"
    return [
        f"sig {sig[:8]}  expected_rows={len(oracle):>2} emitted_events={len(evs):>2} "
        f"pinned_count={want} {verdict}  order(reverse_sym_ok={rev}/{n}, "
        f"forward_sym_ok={fwd}/{n})  full_sig={sig}"
    ]


def _score(sig, i, fidx, row, ev, step, st, fails, report) -> None:
    """Chấm 1 cặp (oracle row ↔ event): identity/side/amount, ghi bảng, ghi diff khi FAIL."""
    tag = f"{sig[:8]}#{i}"
    if row is not None and ev is not None:
        st["paired"] += 1
    if ev is None or row is None:
        report.append(row_line(tag, fidx, row, ev, None, ["count-mismatch"], {}))
        if row is None and ev is not None:
            fails.append(
                f"{tag} EXTRA event {ev['side']} {ev['sym']}\u2190{ev['quote_sym']} "
                f"(oracle không có row tương ứng)"
            )
        elif row is not None:
            fails.append(
                f"{tag} MISSING event cho oracle row {row['event_type']} "
                f"{row['token']['symbol']}\u2190{row['quote_token']['symbol']}"
            )
        else:
            fails.append(f"{tag} cặp (row, event) đều None — không chấm được")
        report.append(diff_line(ev, step, row))
        return
    leg = gross_leg_of(sig, row)
    why = check_symbols(ev, row)
    why_a, ov = check_amounts(ev, row, leg)
    why += why_a
    st["side"] += ev["side"] == row["event_type"].upper()
    st["ident"] += not [w for w in why if "_sym" in w]
    st["qi"] += bool(ev.get("quote_inferred"))
    st["basis"] += ev.get("amount_basis") == "gross_leg"
    st["pairs"].append((ev["sym"], ev["quote_sym"]))
    if not why:
        st["gross" if leg else "exact"] += 1
    if leg:
        st["gross_rows"].append(
            (
                sig[:8],
                row["event_type"].upper(),
                row["token"]["symbol"],
                row["quote_token"]["symbol"],
                leg,
                float(row["token_amount"] if leg == "base" else row["quote_amount"]),
                ev["qty"] if leg == "base" else ev["quote_qty"],
                ov[leg],
            )
        )
    report.append(row_line(tag, fidx, row, ev, leg, why, ov))
    if why:
        fails.append(
            f"{tag} expected {row['event_type']} {row['token']['symbol']} \u2190 "
            f"{row['quote_token']['symbol']} | got {ev['side']} {ev['sym']} \u2190 "
            f"{ev['quote_sym']}: " + "; ".join(why)
        )
        report.append(diff_line(ev, step, row))


def invariants(st, txs, steps_of) -> list[str]:
    """Assert KHÔNG theo row: mỗi step đúng 1 endpoint POOL, amount_basis hằng số,
    không side NEUTRAL, 3 row OS↔CARDS base==OS, quote_inferred==1, 9 sig, order."""
    fails = []
    for sig, stp in steps_of.items():
        for ln in stp:
            p = [x.strip() for x in ln.split("|")]
            st["n_step"] += 1
            if (p[ST_RS] == "POOL") != (p[ST_RD] == "POOL"):
                st["n_pool"] += 1
            else:
                fails.append(
                    f"{sig[:8]} step KHÔNG có đúng 1 endpoint POOL: "
                    f"roles={p[ST_RS]}->{p[ST_RD]} frame={p[ST_FRAME]} (Bước 3)"
                )
            if p[ST_SIDE] == "NEUTRAL":
                fails.append(
                    f"{sig[:8]} side NEUTRAL (§3: type luôn SWAP, không bao giờ NEUTRAL)"
                )
            if p[ST_BASIS] != "gross_leg":
                fails.append(
                    f"{sig[:8]} amount_basis={p[ST_BASIS]} != 'gross_leg' (§3 Bước 5)"
                )
    osc = [p for p in st["pairs"] if {p[0], p[1]} == {"OS", "CARDS"}]
    bad = [p for p in osc if p[0] != "OS"]
    if len(osc) != 3 or bad:
        fails.append(
            f"OS<->CARDS: {len(osc)} row (exp 3), base != 'OS' ở {len(bad)} row (Bước 4)"
        )
    if st["qi"] != 1:
        fails.append(
            f"quote_inferred==True count={st['qi']} exp=1 (Bước 4: chỉ tie 58pWphuG "
            f"OS<->CARDS; 3nzGD2WV/3BbWVS3K giải bằng rank OS 2.0 > CARDS 1.0)"
        )
    if st["n_ev"] != N_ROW or st["paired"] != N_ROW:
        fails.append(
            f"steps: emitted={st['n_ev']} paired={st['paired']} exp={N_ROW}/{N_ROW}"
        )
    if len(txs) != len(EXPECT_COUNT):
        fails.append(
            f"distinct sigs={len(txs)} exp={len(EXPECT_COUNT)} (dedupe theo signatures[0])"
        )
    if st["basis"] != st["n_step"] or st["n_step"] != N_ROW:
        fails.append(
            f"amount_basis hằng số: {st['basis']}/{st['n_step']} step (exp {N_ROW}/{N_ROW})"
        )
    for s8, (rev, _fwd, n) in sorted(st["order"].items()):
        if rev != n:
            fails.append(
                f"{s8} thứ tự step lệch invariant ĐO ĐƯỢC: reverse_sym_ok={rev}/{n} "
                f"(detector phải giữ thứ tự thực thi sort theo min(seq))"
            )
    return fails


def tier_fails(ww, rows) -> list[str]:
    """§2.4: mint WBTC (mọi BTC-peg) KHÔNG được nằm trong TIER_A; WSOL/USDC phải có."""
    fails, mm = [], mint_map(rows)
    for sym, mint in sorted((v[0], m) for m, v in mm.items()):
        if sym in BTC_PEG and mint in ww.TIER_A:
            fails.append(
                f"§2.4 VIOLATION: {sym} {mint} nằm trong TIER_A (mint đọc từ fixture)"
            )
    for sym in ("WSOL", "USDC"):
        m = [k for k, v in mm.items() if v[0] == sym]
        if not m:
            fails.append(f"fixture thiếu {sym} ⇒ không verify được TIER_A seed")
        elif m[0] not in ww.TIER_A:
            fails.append(
                f"{sym} {m[0][:10]}… KHÔNG có trong TIER_A ⇒ seed BFS rank gãy"
            )
    return fails


def summary(st, n_fail: int) -> str:
    """expected-vs-got cho MỌI run (baseline PASS lẫn 4 mutation FAIL) — không boolean."""
    return (
        f"SUMMARY steps {st['n_ev']}/{N_ROW} (paired {st['paired']}/{N_ROW}) · "
        f"identity {st['ident']}/{N_ROW} · side {st['side']}/{N_ROW} · "
        f"amounts exact {st['exact']}/{N_EXACT} + {st['gross']}/{N_GROSS} gross · "
        f"quote_inferred {st['qi']}/1 · amount_basis {st['basis']}/{st['n_step']} · "
        f"1-POOL-endpoint {st['n_pool']}/{st['n_step']} · FAIL-lines {n_fail}"
    )


def gross_block(st) -> str:
    """6 row G: oracle vs emitted vs rel_overstate đo ở run này vs số pin §2.2."""
    out = [
        "gross-leg rel_overstate   công thức PIN: (emitted − oracle) / EMITTED   cap "
        f"{GROSS_CAP:.0%}   (§T8: mẫu=EMITTED, mẫu=oracle thì row OS thành 8.4011% = fail giả)"
    ]
    got = {
        (s, sd, b): (leg, orc, em, ov)
        for s, sd, b, _q, leg, orc, em, ov in st["gross_rows"]
    }
    for sp, side, bs, qs, leg, val in G_ROWS:
        key, pin = (sp, side, bs), G_PINNED.get((sp, side, bs))
        if key not in got:
            out.append(
                f"  {sp} {side:<4} {bs:<9}\u2190{qs:<6} leg={leg:<5} "
                f"<KHONG CO EVENT KHOP — pin §2.2 = {pin}%>"
            )
            continue
        _lg, orc, em, ov = got[key]
        flag = "ok" if ov is not None and ov <= GROSS_CAP else "OVER-CAP"
        out.append(
            f"  {sp} {side:<4} {bs:<9}\u2190{qs:<6} leg={leg:<5} oracle={orc:<18.9g} "
            f"emitted={em:<18.9g} overstate={(ov or 0) * 100:>7.4f}%  "
            f"pin §2.2={pin:>7.4f}%  {flag}"
        )
    ovs = sorted(g[7] for g in st["gross_rows"] if g[7] is not None)
    out.append(
        f"  n_gross_row={len(st['gross_rows'])} (exp {N_GROSS}) · "
        f"max overstate={max(ovs):.4%}"
        if ovs
        else f"  n_gross_row={len(st['gross_rows'])} (exp {N_GROSS}) · max overstate=-"
    )
    return "\n".join(out)


def order_block(st) -> str:
    """Evidence thứ tự: GMGN list step ĐẢO NGƯỢC thứ tự thực thi (đo 9/9 sig)."""
    out = ["oracle row order vs detector step order (đo trên fixture, không suy đoán):"]
    for s8, (rev, fwd, n) in sorted(st["order"].items()):
        out.append(f"  {s8}  n={n}  reverse_sym_ok={rev}/{n}  forward_sym_ok={fwd}/{n}")
    out.append(
        "  ⇒ GMGN xếp row NGƯỢC thứ tự thực thi; detect_swaps sort theo min(seq) = thứ tự "
        "thực thi (§3 Bước 1). Gate cặp theo bản đảo + kiểm key-multiset §2.3 độc lập thứ tự."
    )
    return "\n".join(out)


# ---------------------------------------------------------------- malformed probes


def malformed_probes(ww, txs, rows) -> str:
    """malformed_input — đo HÀNH VI thật của detector, không suy đoán, không sửa gate."""
    wallet = rows[0]["wallet"]
    any_sig = sorted(txs, key=len)[0]
    out = [
        f"malformed probes (tx nền {any_sig[:8]}, {len(txs)} sig distinct, offline):"
    ]

    def n(tx: dict[str, Any]) -> str:
        try:
            return f"{len(ww.detect_swaps(tx, wallet))} event"
        except (
            Exception
        ) as e:  # probe phải in lỗi NGUYÊN VĂN, không nuốt (§5 fail-loud)
            return f"{type(e).__name__}: {e}"

    t = copy.deepcopy(txs[any_sig])
    t["meta"]["err"] = {"InstructionError": [0, "Custom"]}
    out.append(
        f"  meta.err set                        -> {n(t)}   (detect_swaps: err != None => [])"
    )
    out.append(
        f"  block-level {{'transactions': []}}     -> "
        f"list(ww._block_txs(...)) = {list(ww._block_txs({'transactions': []}, 1))}"
    )
    t = copy.deepcopy(txs[any_sig])
    t.pop("meta")
    out.append(f"  meta key absent                     -> {n(t)}")
    t = copy.deepcopy(txs[any_sig])
    t["meta"]["innerInstructions"] = []
    out.append(f"  meta.innerInstructions = []         -> {n(t)}")
    out.append(
        f"  balances mất hết decimals+amount    -> {n(_strip(copy.deepcopy(txs[any_sig])))}"
    )
    # ponytail: `dbase()` (wallet_watch.py L127) fallback 9 (WSOL) / 6 khi mint vắng khỏi
    # dec_of ⇒ detector CÓ đoán decimals âm thầm trong nhánh đó. Không thêm guard (YAGNI):
    # RPC thật luôn trả uiTokenAmount.decimals cho mọi token account trong
    # pre/postTokenBalances ⇒ nhánh không fire trên chain. HÀNH VI đã đo ở dòng trên,
    # không phải ẩn số. Nâng cấp thành hard-fail nếu một nguồn feed nào bỏ field decimals.
    out.append(
        f"  detect_swaps({{}})                    -> {n({})}   "
        f"(caller production guard `if tx:` trước khi gọi — T2.log M4)"
    )
    return "\n".join(out)


def _strip(tx: dict[str, Any]) -> dict[str, Any]:
    for side in ("preTokenBalances", "postTokenBalances"):
        for t in tx["meta"].get(side) or []:
            for k in ("decimals", "amount"):
                (t.get("uiTokenAmount") or {}).pop(k, None)
    return tx


# ---------------------------------------------------------------- mutation harness


def reprogram(ww, fname: str, old: str, new: str) -> str:
    """Đổi RULE của detector TRONG PROCESS: exec lại source của `fname` với đúng 1
    substitution. KHÔNG ghi file (sha256+mtime wallet_watch.py được so trước/sau),
    KHÔNG đụng expectation của test. `exec(..., ww.__dict__)` ⇒ globals vẫn là module."""
    src = textwrap.dedent(inspect.getsource(getattr(ww, fname)))
    cnt = src.count(old)
    assert cnt == 1, f"mutation anchor không unique trong {fname}: {old!r} x{cnt}"
    exec(compile(src.replace(old, new), f"<mutated:{fname}>", "exec"), ww.__dict__)
    return f"{fname}: {old.strip()[:58]!r} -> {new.strip()[:58]!r}"


def mut1(ww, rows) -> str:
    """WBTC mint vào TIER_A (mint đọc từ fixture map, KHÔNG gõ tay) ⇒ identity FAIL."""
    wb = [m for m, v in mint_map(rows).items() if v[0] == "WBTC"]
    assert len(wb) == 1, f"fixture phải có đúng 1 mint WBTC, có {len(wb)}"
    ww.TIER_A.add(wb[0])
    return f"ww.TIER_A.add({wb[0]})   # mint đọc từ fixture, không gõ tay (§5.7)"


def mut2(ww, rows) -> str:
    """Bỏ điều kiện 'đúng 1 endpoint POOL' ⇒ leg RELAY→RELAY cũng được nhận."""
    return reprogram(
        ww,
        "_legs_with_roles",
        'if (rs == "POOL") == (rd == "POOL"):',
        "if False:  # MUT2 khong yeu cau dung 1 endpoint POOL",
    )


def mut3(ww, rows) -> str:
    """Side = 'base chảy vào ví ⇒ BUY' thay vì rule POOL-là-src của `_swap_event`."""
    return reprogram(
        ww,
        "_swap_event",
        '"side": "BUY" if bl["rs"] == "POOL" else "SELL",',
        '"side": "BUY" if bl["rd"] == "WALLET" else "SELL",',
    )


def mut4(ww, rows) -> str:
    """Amount từ DELTA BALANCE của endpoint POOL thay vì parsed instruction (§2.2)."""
    return reprogram(
        ww,
        "_legs_with_roles",
        "        legs.append(",
        '        _ep = src if rs == "POOL" else dst\n'
        "        raw = abs(post_a.get(_ep, 0) - pre_a.get(_ep, 0))\n"
        "        legs.append(",
    )


MUTATIONS = [
    ("1", "1_TIER_A_WBTC", mut1, "identity FAIL ở các row WBTC"),
    ("2", "2_no_single_POOL", mut2, "thừa event và/hoặc side FAIL ở 33hqSn4Q"),
    ("3", "3_wallet_flow_side", mut3, "FAIL ≥ 11 row (rule ví-only đo được 18/29)"),
    (
        "4",
        "4_delta_balance_amount",
        mut4,
        "FAIL ở 33hqSn4Q sell XBT \u2190 WBTC 638160.364952 "
        "(delta vault 99683.5682570003 / 619015.5540030003)",
    ),
]


def fresh_gate(rows, txs):
    """Module fresh + network block + seed_probe + gate. Không reuse state cũ."""
    ww = load_module()
    block_network(ww)
    seed_probe(ww, rows)
    return gate(ww, txs, rows)


def run_rows(rows, txs, apply=None):
    """1 vòng Red/Green: module fresh, seed, (apply mutation nếu có), gate."""
    ww = load_module()
    block_network(ww)
    seed_probe(ww, rows)
    note = apply(ww, rows) if apply else "khong co (baseline)"
    rep, fails, tr, st = gate(ww, txs, rows)
    return note, rep, fails, tr, st


def run_mutations(rows, txs):
    """Red→Green: mỗi mutation phải FAIL; revert (module fresh) phải PASS."""
    log, bad = [], []
    for num, tag, apply, expect in MUTATIONS:
        t0 = time.time()
        note, _rep, fails, _tr, st = run_rows(rows, txs, apply)
        sys.stderr.write(f"timing: mutation {num} wall {time.time() - t0:.2f}s\n")
        log.append(f"\n{'=' * 118}\nMUTATION {num} — {tag}\n{'=' * 118}")
        log.append(f"  kỳ vọng (§T8)    : gate FAIL — {expect}")
        log.append(f"  patch in-process : {note}")
        log.append(
            f"  kết quả          : {len(fails)} FAIL line ⇒ "
            + ("RED ok (test có răng)" if fails else "NO FAIL — mutation KHÔNG bị bắt!")
        )
        log.append("  " + summary(st, len(fails)))
        log += [f"    FAIL {f}" for f in fails[:8]]
        if len(fails) > 8:
            log.append(f"    ... ({len(fails) - 8} FAIL line nữa)")
        if not fails:
            bad.append(f"mutation {num}_{tag} KHÔNG FAIL")
    return log, bad


# ---------------------------------------------------------------- main


def header(names, txs, rows, n_sig, ww, n_mint, sha0, mt0) -> list[str]:
    w = rows[0]["wallet"]
    return [
        "== T8 GMGN row-parity gate — OFFLINE, hermetic "
        "(.omo/plans/gmgn-parity-fixes.md §T8) ==",
        f"  fixtures : {len(names)} file tx \u2192 {len(txs)} sig distinct (dedupe theo "
        f"transaction.signatures[0]) · oracle rows={len(rows)} · sig trong oracle={n_sig}",
        f"  fixture files : {', '.join(names)}",
        f"  module   : {WATCH}",
        f"  sha256 trước : {sha0}",
        f"  mtime  trước : {mt0:.0f}",
        f"  wallet   : {w[:5]}…{w[-4:]} len={len(w)}  "
        f"(đọc DATA['rows'][0]['wallet'] — không gõ literal, §5.7)",
        f"  seed     : _info={n_mint} mint TỪ fixture (token.symbol/quote_token.symbol), "
        f"_info_miss=0, _sol_px['v']=100.0, min_usd=0.0 — idempotent, re-apply mỗi run",
        "  hermetic : ww.http_json / ww.rpc / socket.socket = raise; seed _info không có "
        "marker _info_miss ⇒ token_info() không fetch (wallet_watch.py L184)",
        f"  tolerance: non-gross rel \u2264 {REL_TOL:g} trên uiAmount (pin §5.6, không nới) · "
        f"gross rel_overstate \u2264 {GROSS_CAP:.0%} mẫu=EMITTED · G_ROWS={len(G_ROWS)}",
        "  decimals : detector lấy từ pre/postTokenBalances[].uiTokenAmount.decimals "
        "(§2.2 — row GMGN `token` KHÔNG có field decimals, chỉ quote_token có)",
    ]


def tail(bad, sha0, mt0, sha1, mt1, t_start) -> list[str]:
    same = sha1 == sha0 and mt1 == mt0
    out = [
        f"\nsha256 sau   : {sha1}",
        f"mtime  sau   : {mt1:.0f}",
        f"wallet_watch.py byte-identical sau 4 mutation in-process: {same}",
        f"MUTATION GATE: {len(MUTATIONS) - len([b for b in bad if 'KHÔNG FAIL' in b])}"
        f"/{len(MUTATIONS)} RED(FAIL)\u2192GREEN(PASS)"
        + (" · ALL OK" if not bad else " · PROBLEM: " + "; ".join(bad)),
    ]
    if not same:
        bad.append("wallet_watch.py BỊ SỬA — mutation phải in-process only")
    sys.stderr.write(f"timing: total wall {time.time() - t_start:.2f}s\n")
    out.append(PASS_LINE if not bad else "gate FAILED")
    return out


def main() -> int:
    t_start = time.time()
    data, txs, names = load_fixtures()
    rows = data["rows"]
    n_sig = preflight(rows)
    sha0, mt0 = sha_of(WATCH), os.path.getmtime(WATCH)
    ww = load_module()
    block_network(ww)
    n_mint = seed_probe(ww, rows)
    out = header(names, txs, rows, n_sig, ww, n_mint, sha0, mt0) + [""]
    report, fails, traces, st = gate(ww, txs, rows)
    out.append("---- per-sig expected-vs-got (guard misleading_success_output) ----")
    out += [ln for ln in report if ln.startswith("sig ")]
    out += [
        "",
        order_block(st),
        "",
        "---- bảng so 29 row: oracle(expected) | event(got) | rel | leg gross | OK/FAIL ----",
    ]
    out += [ln for ln in report if not ln.startswith("sig ")]
    out += [
        "",
        gross_block(st),
        "",
        malformed_probes(ww, txs, rows),
        "",
        summary(st, len(fails)),
    ]
    if os.environ.get("TRACE"):
        out += [
            "",
            "---- bảng step T2-style (PAIR/REJECT/RANK/STEP qua trace= callable) ----",
        ]
        grouped = group_rows(rows)
        for sig in sorted(
            traces, key=lambda s: min((i for i, _r in grouped.get(s, [])), default=0)
        ):
            out.append(f"## sig {sig[:8]}  ({len(traces[sig])} trace line)")
            out += traces[sig]
    if fails:
        out += ["", "---- FAIL detail ----"] + [f"FAIL {f}" for f in fails]
        out.append("gate FAILED — KHÔNG in PASS line")
        print("\n".join(out))
        return 1
    out += ["", PASS_LINE]
    print("\n".join(out))
    sys.stderr.write(f"timing: baseline gate wall {time.time() - t_start:.2f}s\n")
    mut_log, bad = run_mutations(rows, txs)
    print("\n".join(mut_log))
    t0 = time.time()
    _rep2, fails2, _tr2, st2 = fresh_gate(rows, txs)
    sys.stderr.write(f"timing: revert gate wall {time.time() - t0:.2f}s\n")
    print(f"\n{'=' * 118}")
    print(
        "REVERT — module fresh load lại từ scripts/wallet_watch.py (không revert bán phần)"
    )
    print("=" * 118)
    print("  " + summary(st2, len(fails2)))
    if fails2:
        bad.append(f"gate vẫn FAIL sau revert ({len(fails2)} line)")
        for f in fails2[:12]:
            print(f"    FAIL {f}")
    else:
        print("  " + PASS_LINE)
    print(
        "\n".join(tail(bad, sha0, mt0, sha_of(WATCH), os.path.getmtime(WATCH), t_start))
    )
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
