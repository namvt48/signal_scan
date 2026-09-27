#!/usr/bin/env python3
"""Regression RPC transport (prod crash T11): body đứt quãng/HTML KHÔNG giết daemon.

Prod thật: publicnode (Cloudflare) cụt body getBlock lớn ⇒ http_json raise
http.client.IncompleteRead — KHÔNG phải OSError/URLError nên lọt lưới except của
rpc(), lọt luôn except RuntimeError của run_block_feed ⇒ daemon chết 31s sau
start, systemd Restart=always thành restart-loop, mỗi lần rơi 1 slot (có thể hụt
SWAP của ví). Lỗ tương tự với json.JSONDecodeError khi proxy trả trang HTML lỗi.

Chạy: python3 scripts/test_rpc_resilience.py  (KHÔNG mạng thật — urllib.request.
urlopen bị monkeypatch theo method; time.sleep tắt; STATE_PATH/_jsonl trỏ temp,
wallet_watch_state.json thật có sha256 guard. Reuse helper T8 gate như
test_block_feed.py: load_module/sha_of.)

Kịch bản:
  (1) rpc() + IncompleteRead ⇒ thử HẾT endpoint fallback rồi RuntimeError
      "RPC fail getBlock: ..." (trước fix: IncompleteRead thoát ngay endpoint 1).
  (2) rpc() + body HTML (proxy lỗi) ⇒ JSONDecodeError cũng là transport-error
      retryable, kết cục RuntimeError như (1).
  (3) rpc() + JSON-RPC error -32004 "was skipped" ⇒ RuntimeError chứa "skipped"
      — contract string-match của run_block_feed NGUYÊN VẸN.
  (4) run_block_feed() + getBlock đứt quãng (transport) ⇒ KHÔNG raise, RETRY ĐÚNG
      slot (warn "# retry slot N"), hết _BLOCK_RETRY_MAX lần ⇒ tiến 1 slot; thoát
      --once/_ONCE_MAX_SLOTS có save_state (trước fix: IncompleteRead bay ra giết
      feed; và skip-mọi-lỗi làm rơi slot = mất data).
  (5) run_block_feed() + getBlock 'skipped' THẬT (-32004) ⇒ tiến slot IM LẶNG
      (KHÔNG có dòng cảnh báo) — semantics skip không đổi.
"""

import contextlib
import http.client
import importlib.util
import io
import json
import os
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_pspec = importlib.util.spec_from_file_location(
    "t8gate", os.path.join(HERE, "test_gmgn_api_parity.py")
)
assert _pspec and _pspec.loader
pg = importlib.util.module_from_spec(_pspec)
_pspec.loader.exec_module(pg)

REAL_STATE = os.path.join(HERE, "wallet_watch_state.json")
BEFORE_SHA = pg.sha_of(REAL_STATE) if os.path.exists(REAL_STATE) else None
TMP = tempfile.mkdtemp(prefix="t11_rpc_resilience_")
SLOT = 361146001  # slot dạng prod lúc crash — chỉ làm nhãn, không truy vấn
W_DUMMY = "11111111111111111111111111111112"  # không tx nào được xử lý trong test
OPTS = {"once": True, "sleep": 0}
SKIPPED_BODY = json.dumps(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "error": {"code": -32004, "message": f"Slot {SLOT} was skipped"},
    }
).encode()
HTML_BODY = b"<html><head><title>502 Bad Gateway</title></head></html>"
TRUNCATED = lambda: http.client.IncompleteRead(b"a" * 496520, 4096)  # noqa: E731

fail = 0
total = 0


def check(cond, msg):
    global fail, total
    total += 1
    print(("PASS" if cond else "FAIL"), msg)
    fail += not cond


class FakeResp:
    """Response giả giống urlopen (context manager): read() trả bytes hoặc raise
    Exception theo script — tái hiện đúng lỗi transport thấy trên prod."""

    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        if isinstance(self._body, BaseException):
            raise self._body
        return self._body


def run_patched(ww, fn, block_body, *args, rpc_slot=SLOT + 10):
    """Chạy fn(*args) với urlopen/sleep/state hermetic. Trả (kết quả hoặc
    exception, stdout, danh sách method đã gọi). Exception hứng theo tuple CHÍNH
    XÁC (không blanket) — lỗi lạ khác phải làm nổ test."""
    calls = []

    def fake_urlopen(req, timeout=None):
        method = json.loads(req.data)["method"]
        calls.append(method)
        if method == "getSlot":
            ok = {"jsonrpc": "2.0", "id": 1, "result": rpc_slot}
            return FakeResp(json.dumps(ok).encode())
        body = block_body() if callable(block_body) else block_body
        return FakeResp(body)

    orig_u, orig_s = urllib.request.urlopen, time.sleep
    urllib.request.urlopen = fake_urlopen
    time.sleep = lambda *_: None  # bỏ chờ 0.7s x N endpoint — test phải nhanh
    ww.STATE_PATH = os.path.join(TMP, "state.json")
    ww._jsonl = os.path.join(TMP, "out.jsonl")
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            return fn(*args), buf.getvalue(), calls
    except (http.client.HTTPException, ValueError, RuntimeError) as e:
        return e, buf.getvalue(), calls
    finally:
        urllib.request.urlopen, time.sleep = orig_u, orig_s


# ---------- (1) rpc(): IncompleteRead ⇒ fallback hết endpoint ⇒ RuntimeError ----------
ww = pg.load_module()
res, _out, calls = run_patched(
    ww, ww.rpc, TRUNCATED, "getBlock", [SLOT, ww._BLOCK_PARAMS]
)
check(
    isinstance(res, RuntimeError) and "RPC fail getBlock" in str(res),
    f"(1) IncompleteRead => RuntimeError sau khi can endpoint (pre-fix: thoat raw): "
    f"{type(res).__name__}: {res}",
)
check(
    calls.count("getBlock") == len(ww.RPCS),
    f"(1) fallback thu du {len(ww.RPCS)} endpoint: {calls}",
)

# ---------- (2) rpc(): body HTML ⇒ JSONDecodeError cũng retryable ----------
ww = pg.load_module()
res, _out, calls = run_patched(ww, ww.rpc, HTML_BODY, "getBlock", [SLOT, {}])
check(
    isinstance(res, RuntimeError) and "RPC fail getBlock" in str(res),
    f"(2) body HTML => JSONDecodeError bi coi la transport, ket cuc RuntimeError: "
    f"{type(res).__name__}: {res}",
)
check(calls.count("getBlock") == 2, f"(2) fallback thu du 2 endpoint: {calls}")

# ---------- (3) rpc(): -32004 skipped ⇒ RuntimeError chứa "skipped" (contract) ----------
ww = pg.load_module()
res, _out, _calls = run_patched(ww, ww.rpc, SKIPPED_BODY, "getBlock", [SLOT, {}])
check(
    isinstance(res, RuntimeError) and "skipped" in str(res).lower(),
    f"(3) JSON-RPC -32004 => RuntimeError giu chu 'skipped' cho run_block_feed: {res}",
)

# ---------- (4) run_block_feed(): getBlock đứt quãng ⇒ KHÔNG chết, warn, tiến slot --
ww = pg.load_module()
st = {"wallets": {}, "block_slot": SLOT - 1}
res, out, _calls = run_patched(
    ww, ww.run_block_feed, TRUNCATED, [W_DUMMY], st, dict(OPTS)
)
saved = None
if os.path.exists(os.path.join(TMP, "state.json")):
    saved = json.load(open(os.path.join(TMP, "state.json"), encoding="utf-8"))
check(res is None, f"(4) feed KHONG raise tren IncompleteRead (pre-fix: chet): {res!r}")
check(
    f"# retry slot {SLOT} (lần 1)" in out and "# rpc skip slot" not in out,
    "(4) transport error => RETRY dung slot (warn '# retry slot N'), KHONG skip im lang",
)
check(
    _calls.count("getBlock") >= ww._BLOCK_RETRY_MAX,
    f"(4) retry CUNG slot >= _BLOCK_RETRY_MAX lan truoc khi bo: "
    f"{_calls.count('getBlock')}",
)
check(
    st["block_slot"] == SLOT + ww._ONCE_MAX_SLOTS - 1,
    f"(4) block_slot tien het {ww._ONCE_MAX_SLOTS} slot unusable: {st['block_slot']}",
)
check(
    saved is not None and saved.get("block_slot") == SLOT + ww._ONCE_MAX_SLOTS - 1,
    f"(4) --once thoat co save_state de resume: {saved and saved.get('block_slot')}",
)

# ---------- (5) run_block_feed(): skipped ⇒ im lặng như cũ, KHÔNG dòng rpc skip ----
ww = pg.load_module()
st = {"wallets": {}, "block_slot": SLOT - 1}
res, out, _calls = run_patched(
    ww, ww.run_block_feed, SKIPPED_BODY, [W_DUMMY], st, dict(OPTS)
)
check(res is None, f"(5) feed KHONG raise tren -32004 skipped: {res!r}")
check(
    "# rpc skip slot" not in out,
    "(5) slot skipped van di nhanh blk=None IM LANG - khong lan sang canh bao moi",
)
check(
    st["block_slot"] == SLOT + ww._ONCE_MAX_SLOTS - 1,
    f"(5) block_slot tien nhu cu: {st['block_slot']}",
)

# ---------- guard: state thật không bị chạm ----------
after = pg.sha_of(REAL_STATE) if os.path.exists(REAL_STATE) else None
check(BEFORE_SHA == after, "wallet_watch_state.json that KHONG doi (sha256 guard)")

assert fail == 0, f"{fail} check sai"
print(f"OK: rpc-resilience {total - fail}/{total} (offline, deterministic)")
