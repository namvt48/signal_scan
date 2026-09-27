#!/usr/bin/env python3
"""Offline regression cho WS feed T12 (`_ws_shards` + `process_sig`).

KHÔNG mạng: KHÔNG mở websocket thật (connect/reconnect cần mạng, không unit-test
ở đây). Khóa 2 đơn vị logic thuần — thứ dễ vỡ khi đụng vào feed:

  (1) _ws_shards: phủ HẾT ví, các shard RỜI nhau, lệch ≤1; 198 ví/6 key ⇒ 33/key
      (dưới cap subscription của Helius free — vượt cap ⇒ mất event hàng loạt).
  (2) process_sig: err!=None (tx fail) ⇒ KHÔNG fetch; tx OK ⇒ emit đúng
      EXPECT_COUNT của T8 gate; getTransaction lỗi ⇒ không raise, không emit;
      tx None ⇒ không emit.

Hermetic: ww.STATE_PATH/_jsonl trỏ temp; wallet_watch_state.json thật có sha256
guard. Reuse harness T8 (load_module/block_network/load_fixtures/seed/EXPECT_COUNT/
sha_of).
"""

import contextlib
import importlib.util
import io
import os
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
BEFORE_SHA = pg.sha_of(REAL_STATE) if os.path.exists(REAL_STATE) else None
TMP = tempfile.mkdtemp(prefix="t12_wsfeed_")

WW = pg.load_module()
pg.block_network(WW)  # http_json/rpc/socket.socket raise nếu lọt lưới
DATA, TXS, NAMES = pg.load_fixtures()
pg.seed(WW, DATA["rows"])
WALLETS = sorted({r["wallet"] for r in DATA["rows"]})
WW.STATE_PATH = os.path.join(TMP, "state.json")
WW._jsonl = os.path.join(TMP, "ws.jsonl")

fail = 0
total = 0


def check(cond, msg):
    global fail, total
    total += 1
    print(("PASS" if cond else "FAIL"), msg)
    fail += not cond


# ---------- (1) _ws_shards: phủ hết, rời nhau, lệch ≤1, ≤33/key ----------
for n in (1, 2, 5, 6, 8):
    sh = WW._ws_shards(WALLETS, n)
    flat = [x for s in sh for x in s]
    check(sorted(flat) == sorted(WALLETS), f"(1) n={n}: shard phủ HẾT ví")
    check(len(flat) == len(set(flat)), f"(1) n={n}: các shard RỜI nhau")
    check(
        max(map(len, sh)) - min(map(len, sh)) <= 1,
        f"(1) n={n}: lệch số ví/shard ≤1",
    )
BIG = [f"W{i}" for i in range(198)]
check(
    max(map(len, WW._ws_shards(BIG, 6))) == 33,
    "(1) 198 ví / 6 key = 33 sub/key (dưới cap Helius free)",
)


class Fake:
    """getTransaction giả: trả TXS[sig], hoặc raise nếu raise_on set. Đếm call."""

    def __init__(self, txs):
        self.txs = txs
        self.calls = Counter()
        self.raise_on: str | None = None

    def __call__(self, method, params):
        self.calls[method] += 1
        if method == "getTransaction":
            if self.raise_on:
                raise RuntimeError(self.raise_on)
            return self.txs.get(params[0])
        raise AssertionError(f"Fake: method lạ {method}")


def n_events():
    if not os.path.exists(WW._jsonl):
        return 0
    return sum(1 for _ in open(WW._jsonl, encoding="utf-8"))


def run_sig(sig, fake, err=None):
    WW.rpc = fake  # process_sig gọi rpc() theo tên module ⇒ swap được như T9
    WW._emitted.clear()
    if os.path.exists(WW._jsonl):
        os.remove(WW._jsonl)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        WW.process_sig(sig, WALLETS, {"wallets": {}}, err)
    return buf.getvalue()


SIG = max(TXS, key=lambda s: pg.EXPECT_COUNT.get(s[:8], 0))
EXP = pg.EXPECT_COUNT[SIG[:8]]
assert EXP > 0, f"fixture sig {SIG[:8]} phải có event"

# ---------- (2a) tx fail (err!=None) ⇒ KHÔNG fetch, 0 event ----------
f = Fake(TXS)
run_sig(SIG, f, err={"InstructionError": [3, "Custom"]})
check(
    f.calls["getTransaction"] == 0,
    f"(2a) tx fail ⇒ KHÔNG fetch: getTransaction={f.calls['getTransaction']}",
)
check(n_events() == 0, "(2a) tx fail ⇒ 0 event")

# ---------- (2b) tx OK ⇒ fetch 1 lần, emit đúng EXPECT_COUNT ----------
f = Fake(TXS)
run_sig(SIG, f)
check(
    f.calls["getTransaction"] == 1,
    f"(2b) fetch đúng 1 lần: {f.calls['getTransaction']}",
)
check(n_events() == EXP, f"(2b) emit đúng {EXP} event: got {n_events()}")

# ---------- (2c) getTransaction lỗi ⇒ không raise, 0 event, có log ----------
f = Fake(TXS)
f.raise_on = "connection reset"
out = run_sig(SIG, f)
check(n_events() == 0, "(2c) getTransaction lỗi ⇒ 0 event (không raise)")
check("getTransaction" in out, "(2c) có log lỗi getTransaction ra stderr")

# ---------- (2d) tx None ⇒ không emit, không raise ----------
f = Fake({})
run_sig(SIG, f)
check(n_events() == 0, "(2d) tx None ⇒ 0 event")

# ---------- guard: state thật không bị chạm ----------
after = pg.sha_of(REAL_STATE) if os.path.exists(REAL_STATE) else None
check(BEFORE_SHA == after, "wallet_watch_state.json thật KHÔNG đổi (sha256 guard)")

assert fail == 0, f"{fail} check sai"
print(f"OK: ws-feed {total - fail}/{total} (offline, deterministic)")
