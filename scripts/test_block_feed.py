#!/usr/bin/env python3
"""Offline regression cho block feed T7 (run_block_feed).

Chạy: python3 scripts/test_block_feed.py   (KHÔNG mạng — FakeRPC phục vụ toàn bộ
getSlot/getBlock/getTransaction từ scripts/fixtures/block_sample.json; socket.socket
bị chặn cứng qua block_network() của T8 gate).

4 kịch bản (spec T9):
  (i)   1 block 9 tx ⇒ ĐÚNG 29 event, per-sig == EXPECT_COUNT của T8 gate;
        params getBlock == _BLOCK_PARAMS (maxSupportedTransactionVersion=1), getSlot
        params == [{"commitment": "confirmed"}] — pin plumbing T7; state persist
        block_slot + banner resume in block number (check block number).
  (ii)  block không chứa ví tracked nào ⇒ 0 event, feed không chết.
  (iii) lossless: lỗi tạm thời ("connection reset") ⇒ RETRY ĐÚNG slot (KHÔNG bỏ —
        đây là nguồn mất data cũ); slot 'skipped' THẬT ⇒ tiến slot kế.
  (iv)  lag lớn KHÔNG nhảy: đi TUẦN TỰ tới slot đích, không có dòng gap-jump.

Hermetic: ww.STATE_PATH/_jsonl trỏ vào temp dir — scripts/wallet_watch_state.json
thật KHÔNG bị chạm (sha256 guard cuối file). Reuse helpers của
test_gmgn_api_parity.py (load_module/block_network/load_fixtures/seed/EXPECT_COUNT/
sha_of/FIX) — không reinvent.
"""

import contextlib
import importlib.util
import io
import json
import os
import socket
import tempfile
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
_pspec = importlib.util.spec_from_file_location(
    "t8gate", os.path.join(HERE, "test_gmgn_api_parity.py")
)
assert _pspec and _pspec.loader
pg = importlib.util.module_from_spec(_pspec)
_pspec.loader.exec_module(pg)

REAL_STATE = os.path.join(HERE, "wallet_watch_state.json")
ORIG_SOCKET = socket.socket
# sha guard: chụp TRƯỚC mọi kịch bản — cuối file so lại, state thật phải nguyên vẹn
BEFORE_SHA = pg.sha_of(REAL_STATE) if os.path.exists(REAL_STATE) else None


class FakeRPC:
    """rpc() giả: script theo method/slot/sig từ fixture. Đếm số call để assert
    dedup (v). Giá trị dict có thể là Exception (raise) hoặc list (script dãy
    response — pop dần, cạn thì giữ phần tử cuối)."""

    def __init__(self, slot, blocks=None, txs=None):
        self.slot = slot
        self.blocks = blocks or {}
        self.txs = txs or {}
        self.calls = Counter()
        self.slot_params = None
        self.block_params = None

    def __call__(self, method, params):
        self.calls[method] += 1
        if method == "getSlot":
            self.slot_params = params
            return self.slot
        if method == "getBlock":
            self.block_params = params[1]
            v = self.blocks.get(params[0])
        elif method == "getTransaction":
            v = self.txs.get(params[0])
        else:
            raise AssertionError(f"FakeRPC: method lạ {method}")
        if isinstance(v, list):  # script dãy response: pop dần, cạn thì giữ cuối
            v = v.pop(0) if len(v) > 1 else v[0]
        if isinstance(v, Exception):
            raise v
        return v


def make_ww():
    """Fresh wallet_watch + seed hermetic từ T8 gate (min_usd=0, _sol_px=100,
    _info từ oracle rows ⇒ detect_swaps không bao giờ chạm mạng)."""
    ww = pg.load_module()
    pg.block_network(ww)  # http_json/rpc/socket.socket raise nếu lọt lưới
    data, txs, names = pg.load_fixtures()
    pg.seed(ww, data["rows"])
    assert len(names) == 12 and len(txs) == 9, (len(names), len(txs))
    return ww, data["rows"], txs


WW, ROWS, TXS = make_ww()
WALLETS = sorted({r["wallet"] for r in ROWS})
BLOCK = json.load(open(os.path.join(pg.FIX, "block_sample.json"), encoding="utf-8"))
assert set(BLOCK) == {"blockTime", "blockHeight", "transactions"}, sorted(BLOCK)
assert BLOCK["blockTime"] == 1789440154 and len(BLOCK["transactions"]) == 9
TMP = tempfile.mkdtemp(prefix="t9_blockfeed_")
OPTS = {"once": True, "sleep": 0}
WW._RETRY_BASE_S = 0.0  # retry tức thì trong test (backoff thật 1s ⇒ chậm)

fail = 0
total = 0


def check(cond, msg):
    global fail, total
    total += 1
    print(("PASS" if cond else "FAIL"), msg)
    fail += not cond


def install(ww, fake, jsonl_name):
    """Trỏ state/jsonl vào temp, gắn FakeRPC — trả hàm restore (MUST-DO)."""
    orig_rpc = ww.rpc
    ww.rpc = fake
    ww.STATE_PATH = os.path.join(TMP, "state.json")
    ww._jsonl = os.path.join(TMP, jsonl_name)
    if os.path.exists(ww._jsonl):
        os.remove(ww._jsonl)
    ww._emitted.clear()  # dedupe emit là state của 1 run — test coi mỗi scenario là run mới

    def restore():
        ww.rpc = orig_rpc

    return restore


def n_events(ww):
    if not os.path.exists(ww._jsonl):
        return Counter(), 0
    lines = [json.loads(x) for x in open(ww._jsonl, encoding="utf-8")]
    return Counter(e["sig"][:8] for e in lines), len(lines)


def run_feed(ww, wallets, st):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ww.run_block_feed(wallets, st, dict(OPTS))
    return buf.getvalue()


def quiet(fn, *args):
    """fmt() của event có timestamp datetime.now ⇒ KHÔNG được lọt ra stdout test
    (run 2 lần phải identical); stderr cũng giữ lại."""
    with (
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(io.StringIO()),
    ):
        return fn(*args)


# ---------- (i) block 9 tx ⇒ đúng 29 event, per-sig pin, params T7 ----------
fake = FakeRPC(slot=1000, blocks={1000: BLOCK})
restore = install(WW, fake, "i.jsonl")
try:
    st = {"wallets": {}}  # không có block_slot ⇒ cold start = head
    out = run_feed(WW, WALLETS, st)
finally:
    restore()
got, n = n_events(WW)
check(n == 29, f"(i) 29 event từ 9 tx: got {n}")
check(got == pg.EXPECT_COUNT, f"(i) per-sig == EXPECT_COUNT: {dict(got)}")
check(
    fake.block_params == WW._BLOCK_PARAMS
    and WW._BLOCK_PARAMS["maxSupportedTransactionVersion"] == 1,
    "(i) getBlock params == _BLOCK_PARAMS (maxSupportedTransactionVersion=1)",
)
check(
    fake.slot_params == [{"commitment": "confirmed"}],
    '(i) getSlot params == [{"commitment": "confirmed"}]',
)
check(
    "# feed=block: resume slot 1000 | head 1000 | gap 0" in out,
    "(i) banner resume in block number (check block number)",
)
saved = json.load(open(os.path.join(TMP, "state.json"), encoding="utf-8"))
check(
    saved.get("block_slot") == 1000,
    f"(i) state persist block_slot=1000: {saved.get('block_slot')}",
)
check(
    set(saved.get("wallets", {})) == set(WALLETS),
    "(i) head set cho mọi ví tracked",
)

# ---------- (ii) block không chứa ví tracked ⇒ 0 event ----------
# ví "ngoài": lật ký tự cuối ví tracked — KHÔNG hardcode all-1s vì
# "111…1" (32×1) là System Program, có mặt trong accountKeys MỌI tx.
ABSENT = WALLETS[0][:-1] + ("H" if WALLETS[0][-1] != "H" else "G")
assert not any(
    ABSENT in {ak["pubkey"] for ak in en["transaction"]["message"]["accountKeys"]}
    for en in BLOCK["transactions"]
), f"{ABSENT} có trong accountKeys fixture"
fake = FakeRPC(slot=1000, blocks={1000: BLOCK})
restore = install(WW, fake, "ii.jsonl")
try:
    st = {"wallets": {}, "block_slot": 999}
    run_feed(WW, [ABSENT], st)
finally:
    restore()
_, n = n_events(WW)
check(n == 0, f"(ii) ví ngoài accountKeys ⇒ 0 event: got {n}")

# ---------- (iii) lossless: skip thật ⇒ tiến; lỗi tạm thời ⇒ retry CÙNG slot ----------
fake = FakeRPC(
    slot=1003, blocks={1000: RuntimeError("Slot 1000 was skipped"), 1001: BLOCK}
)
restore = install(WW, fake, "iii.jsonl")
try:
    st = {"wallets": {}, "block_slot": 999}
    run_feed(WW, WALLETS, st)
    _, n = n_events(WW)
    check(n == 29, f"(iii) slot 1000 skip THẬT ⇒ xử lý 1001, đủ 29 event: got {n}")
    check(st["block_slot"] == 1001, f"(iii) block_slot tiến 1001: {st['block_slot']}")
finally:
    restore()

fake2 = FakeRPC(slot=1000, blocks={1000: [RuntimeError("connection reset"), BLOCK]})
restore2 = install(WW, fake2, "iii2.jsonl")
try:
    st2 = {"wallets": {}, "block_slot": 999}
    out2 = run_feed(WW, WALLETS, st2)  # KHÔNG được raise — feed phải sống sót
    _, n2 = n_events(WW)
    check(
        n2 == 29 and st2["block_slot"] == 1000,
        f"(iii) lỗi tạm thời ⇒ RETRY cùng slot 1000, đủ 29 event: "
        f"n={n2} slot={st2['block_slot']}",
    )
    check(
        fake2.calls["getBlock"] == 2 and "# retry slot 1000" in out2,
        f"(iii) getBlock(1000) gọi 2 lần (retry, KHÔNG skip): {fake2.calls['getBlock']}",
    )
finally:
    restore2()

# ---------- (iv) lag lớn KHÔNG nhảy: đi tuần tự tới slot đích ----------
fake = FakeRPC(slot=700, blocks={690: BLOCK})
restore = install(WW, fake, "iv.jsonl")
WW._ONCE_MAX_SLOTS = 1000  # cho phép bỏ qua nhiều slot None trước khi tới 690
try:
    st = {"wallets": {}, "block_slot": 500}  # slot=501, cur=700, lag=199
    out = run_feed(WW, WALLETS, st)
finally:
    restore()
    WW._ONCE_MAX_SLOTS = 5
_, n = n_events(WW)
check("# gap: skip slot" not in out, "(iv) KHÔNG còn gap-jump line")
check(
    n == 29 and st["block_slot"] == 690,
    f"(iv) đi tuần tự tới 690, 29 event: n={n} slot={st['block_slot']}",
)
check(
    fake.calls["getBlock"] == 190,
    f"(iv) getBlock gọi 190 lần (501..690, không nhảy): {fake.calls['getBlock']}",
)

# ---------- guard: state thật không bị chạm ----------
after = pg.sha_of(REAL_STATE) if os.path.exists(REAL_STATE) else None
check(BEFORE_SHA == after, "wallet_watch_state.json thật KHÔNG đổi (sha256 guard)")

assert fail == 0, f"{fail} check sai"
print(f"OK: block-feed {total - fail}/{total} (offline, deterministic)")
