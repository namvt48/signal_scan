#!/usr/bin/env python3
"""Offline regression cho daemon FOMO (`watchers/fomo/feed.py`) — plan fomo-user-watch todo 10.

Chạy: python3 scripts/test_fomo_watch.py   (offline — urlopen + websockets bị stub,
không gọi mạng thật). Cũng chạy được dưới pytest (code mức module thực thi khi
import; `assert fail == 0` cuối file là gate).

Fixtures dựng từ capture THẬT `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl`
(102 alert, schema đã pin trong plan). Cover đúng danh sách todo 10:
  1. welcome/heartbeat/ping → không emit, không raise.
  2. perp (tokenAddress null) + thesis → drop.
  3. chain 'ethereum' → drop; solana/base/bsc/robinhood → map tương ứng.
  4. trader không được watch → drop, không emit.
  5. trader khớp handle (row KHÔNG có userId) → CÓ emit (handle matching works).
  6. cùng eventId 2 lần → emit 1 lần (dedupe).
  7. payload malformed → skip, không raise, loop đi tiếp.
  8. seen-set sống qua vòng save/load.
  9. state/heartbeat ghi vào path FOMO-specific, KHÔNG đụng path wallet chung.
 10. key không xuất hiện trong state persist lẫn log bắt được.
"""

import contextlib
import email.message
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import types
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from watchers.common import config  # noqa: E402
from watchers.fomo import feed  # noqa: E402

SAMPLE = os.path.join(
    ROOT, ".omo", "evidence", "fomo-user-watch", "task-0-alert-sample.jsonl"
)

fail = 0
total = 0


def check(cond, msg):
    global fail, total
    total += 1
    print(("PASS" if cond else "FAIL"), msg)
    fail += not cond


# ---------- fixtures: alerts THẬT từ capture ----------


def _load_alerts():
    rows = [json.loads(l) for l in open(SAMPLE, encoding="utf-8") if l.strip()]
    return [r for r in rows if isinstance(r, dict) and r.get("type") == "alert"]


def _first(alerts, **kw):
    for a in alerts:
        if all(a.get(k) == v for k, v in kw.items()):
            return dict(a)
    raise AssertionError(f"capture thiếu fixture {kw}")


_ALERTS = _load_alerts()
check(len(_ALERTS) == 102, f"fixture: capture có 102 alert (got {len(_ALERTS)})")

WELCOME = json.dumps({"type": "welcome", "stream": "alerts", "buffered": 1016})
HEARTBEAT = json.dumps({"type": "heartbeat", "ts": 1790655995000})
PING = "ping"
PONG = "pong"
PERP = _first(_ALERTS, alertType="perp")  # tokenAddress null, chain hyperliquid/1337
THESIS = _first(_ALERTS, alertType="thesis")
ETH = _first(_ALERTS, chain="ethereum", alertType="buy")
SOL_BUY = _first(_ALERTS, chain="solana", alertType="buy")
# USD THẬT đã giao dịch (~17/102 alert có field này). steph_2441 là ca điển hình:
# usdValue 61,206.56 (position SAU fill) trong khi chỉ mua 126.06 USD.
SOL_BUY_TRADE = next(
    dict(a)
    for a in _ALERTS
    if a.get("trader") == "steph_2441"
    and a.get("chain") == "solana"
    and a.get("alertType") == "buy"
    and a.get("tradeUsd") is not None
)
BASE_SELL = _first(_ALERTS, chain="base", alertType="sell")
BSC_SELL = _first(_ALERTS, chain="bsc", alertType="sell")
ROBINHOOD_BUY = _first(_ALERTS, chain="robinhood", alertType="buy")
check(PERP.get("tokenAddress") is None, "fixture: perp có tokenAddress null")

# ---------- harness: stub urlopen + path temp ----------


class _Resp:
    def __init__(self, data: bytes):
        self._d = data

    def read(self):
        return self._d

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeHTTP:
    """urlopen giả: GET /api/fomo-users → users; POST /api/fomo-watch/trades →
    bắt body (hoặc raise 404 nếu post_status=404). URL lạ ⇒ AssertionError."""

    def __init__(self, users=None, post_status=200):
        self.users = users if users is not None else []
        self.posted = []
        self.post_status = post_status
        self.get_calls = 0

    def __call__(self, req, timeout=None):
        url = req.full_url
        if url.endswith("/api/fomo-users"):
            self.get_calls += 1
            return _Resp(json.dumps(self.users).encode())
        if url.endswith("/api/fomo-watch/trades"):
            if self.post_status == 404:
                raise urllib.error.HTTPError(
                    url,
                    404,
                    "fomo user not tracked",
                    email.message.Message(),
                    None,
                )
            self.posted.append(json.loads(req.data))
            return _Resp(json.dumps({"inserted": 1}).encode())
        raise AssertionError(f"FakeHTTP: url lạ {url}")


TMP = tempfile.mkdtemp(prefix="fomo_test_")
_real_urlopen = urllib.request.urlopen
config._api_url = "http://127.0.0.1:8125"
feed.STATE_PATH = os.path.join(TMP, "fomo_state.json")
feed.HEARTBEAT = os.path.join(TMP, "fomo_heartbeat")

REAL_WALLET_STATE = os.path.join(HERE, "wallet_watch_state.json")
REAL_HEARTBEAT = os.path.join(HERE, "heartbeat")


def _sha(p):
    return (
        hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None
    )


BEFORE_WALLET_STATE = _sha(REAL_WALLET_STATE)
BEFORE_HEARTBEAT = _sha(REAL_HEARTBEAT)


def reset(users=None, post_status=200):
    """Watch list + seen về trắng; trả FakeHTTP đã patch vào urlopen."""
    feed._seen.clear()
    feed._wl.update({"ids": set(), "handles": set(), "next": 0.0})
    for p in (feed.STATE_PATH, feed.HEARTBEAT):
        if os.path.exists(p):
            os.remove(p)
    fh = FakeHTTP(users, post_status)
    urllib.request.urlopen = fh
    # force-refresh để _wl khớp production path (GET /api/fomo-users) — test alert_body trực tiếp
    _b = io.StringIO()
    with contextlib.redirect_stdout(_b), contextlib.redirect_stderr(_b):
        feed.refresh_watch_list(force=True)
    return fh


def restore():
    urllib.request.urlopen = _real_urlopen


def captured(fn, *a, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        rv = fn(*a, **kw)
    return rv, buf.getvalue()


# ---------- (1) envelope frames: không emit, không raise ----------

fh = reset()
try:
    st = {}
    for frame in (WELCOME, HEARTBEAT, PING, PONG):
        rv, _ = captured(feed.handle_frame, frame, st)  # không raise là đạt
        check(rv is None, f"(1) handle_frame({frame[:12]!r}…) không trả gì")
    check(fh.posted == [], "(1) welcome/heartbeat/ping/pong ⇒ 0 POST")
    check(feed.alert_body(json.loads(WELCOME)) is None, "(1) alert_body(welcome)=None")
    check(
        feed.alert_body(json.loads(HEARTBEAT)) is None, "(1) alert_body(heartbeat)=None"
    )
finally:
    restore()

# ---------- (2) perp + thesis → drop ----------

fh = reset(
    users=[
        {"handle": PERP["trader"], "source": "csv"},
        {"handle": THESIS["trader"], "source": "csv"},
    ]
)
try:
    check(feed.alert_body(PERP) is None, "(2) perp (tokenAddress null) ⇒ drop")
    check(feed.alert_body(THESIS) is None, "(2) thesis ⇒ drop (dù trader được watch)")
    st = {}
    captured(feed.handle_frame, json.dumps(PERP), st)
    captured(feed.handle_frame, json.dumps(THESIS), st)
    check(fh.posted == [], "(2) perp/thesis ⇒ 0 POST")
finally:
    restore()

# ---------- (3) chain map: ethereum drop; solana/base/bsc/robinhood → map ----------

fh = reset(
    users=[
        {"handle": ETH["trader"], "source": "csv"},
        {"handle": SOL_BUY["trader"], "source": "csv"},
        {"handle": BASE_SELL["trader"], "source": "csv"},
        {"handle": BSC_SELL["trader"], "source": "csv"},
        {"handle": ROBINHOOD_BUY["trader"], "source": "csv"},
    ]
)
try:
    check(feed.alert_body(ETH) is None, "(3) chain 'ethereum' ⇒ drop")
    for al, want in (
        (SOL_BUY, "sol"),
        (BASE_SELL, "base"),
        (BSC_SELL, "bsc"),
        (ROBINHOOD_BUY, "robinhood"),
    ):
        b = feed.alert_body(al)
        check(
            b is not None and b["chain"] == want,
            f"(3) chain '{al['chain']}' → '{want}'",
        )
        check(
            b is not None and b["tokenAddress"] == al["tokenAddress"],
            f"(3) {want}: tokenAddress giữ nguyên",
        )
finally:
    restore()

# ---------- (4) trader không watch ⇒ drop, 0 emit ----------

fh = reset(users=[{"handle": "somebody_else", "source": "csv"}])
try:
    check(feed.alert_body(SOL_BUY) is None, "(4) trader lạ ⇒ alert_body None")
    st = {}
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)
    check(fh.posted == [], "(4) trader lạ ⇒ 0 POST")
    check(st.get("emitted") in (None, 0), "(4) trader lạ ⇒ emitted không tăng")
finally:
    restore()

# ---------- (5) handle matching: row KHÔNG userId vẫn emit ----------

fh = reset(
    users=[{"handle": SOL_BUY["trader"], "name": "steph", "source": "csv"}]
)  # KHÔNG userId
try:
    feed.refresh_watch_list(force=True)
    check(
        feed._wl["handles"] == {SOL_BUY["trader"]},
        "(5) watch list nạp handle (không userId)",
    )
    check(feed._wl["ids"] == set(), "(5) row không userId ⇒ ids rỗng")
    st = {}
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)
    check(
        len(fh.posted) == 1, f"(5) trader khớp handle ⇒ emit 1 (got {len(fh.posted)})"
    )
    if fh.posted:
        p = fh.posted[0]
        check(p["eventId"] == SOL_BUY["eventId"], "(5) POST đúng eventId")
        check(p["type"] == "buy" and p["chain"] == "sol", "(5) POST type/chain đúng")
        check(
            p["trader"] == SOL_BUY["trader"] and p["userId"] == SOL_BUY["userId"],
            "(5) POST kèm trader+userId của alert",
        )
        check(
            p["usdValue"] == float(SOL_BUY["usdValue"])
            and p["ts"] == float(SOL_BUY["ts"]),
            "(5) POST usdValue/ts đúng",
        )
finally:
    restore()

# ---------- (5b) userId exact ưu tiên TRƯỚC handle ----------

fh = reset(
    users=[{"handle": "wrong_handle", "userId": SOL_BUY["userId"], "source": "csv"}]
)
try:
    b = feed.alert_body(SOL_BUY)
    check(b is not None, "(5b) userId exact khớp ⇒ emit dù handle row khác")
finally:
    restore()

# ---------- (5c) tradeUsd (USD THẬT) được forward; vắng mặt thì KHÔNG thêm key ----------

fh = reset(users=[{"handle": SOL_BUY_TRADE["trader"], "source": "csv"}])
try:
    b = feed.alert_body(SOL_BUY_TRADE) or {}
    check(bool(b), "(5c) alert có tradeUsd vẫn emit")
    check(
        b.get("tradeUsd") == float(SOL_BUY_TRADE["tradeUsd"]),
        "(5c) POST kèm tradeUsd = USD thật đã giao dịch",
    )
    check(
        b.get("usdValue") == float(SOL_BUY_TRADE["usdValue"]),
        "(5c) usdValue giữ nguyên (position size, KHÔNG bị thay bằng tradeUsd)",
    )
    no_trade = {k: v for k, v in SOL_BUY_TRADE.items() if k != "tradeUsd"}
    b2 = feed.alert_body(no_trade) or {}
    check(
        bool(b2) and "tradeUsd" not in b2,
        "(5c) vắng tradeUsd ⇒ KHÔNG thêm key (không gửi None)",
    )
finally:
    restore()

# ---------- (6) cùng eventId 2 lần ⇒ emit 1 ----------

fh = reset(users=[{"handle": SOL_BUY["trader"], "source": "csv"}])
try:
    st = {}
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)
    check(len(fh.posted) == 1, f"(6) eventId lặp ⇒ 1 POST (got {len(fh.posted)})")
    check(
        st.get("emitted") == 1,
        f"(6) emitted=1 sau 2 frame trùng (got {st.get('emitted')})",
    )
finally:
    restore()

# ---------- (7) malformed payload: skip, không raise, loop đi tiếp ----------

fh = reset(users=[{"handle": SOL_BUY["trader"], "source": "csv"}])
try:
    st = {}
    junk = [
        "",
        "not json",
        "{broken",
        "[]",
        "null",
        "123",
        b"\x00\xff\xfe",
        '{"type":"alert"}',
        json.dumps([1, 2, 3]),
    ]
    for j in junk:
        rv, _ = captured(feed.handle_frame, j, st)  # không raise là đạt
        check(rv is None, f"(7) malformed {j!r:.30} skip êm")
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)  # loop vẫn chạy tiếp
    check(len(fh.posted) == 1, "(7) sau rác, alert thật vẫn emit")
finally:
    restore()

# ---------- (8) seen-set sống qua save/load round-trip ----------

fh = reset(users=[{"handle": SOL_BUY["trader"], "source": "csv"}])
try:
    st = {"emitted": 0}
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)
    check(os.path.exists(feed.STATE_PATH), "(8) state file được ghi")
    disk = json.load(open(feed.STATE_PATH, encoding="utf-8"))
    check(SOL_BUY["eventId"] in disk.get("seen", []), "(8) seen chứa eventId trên disk")
    check(disk.get("last_ts") == float(SOL_BUY["ts"]), "(8) watermark last_ts persist")
    feed._seen.clear()  # giả restart
    st2 = feed.load_state()
    check(SOL_BUY["eventId"] in feed._seen, "(8) load_state khôi phục seen")
    fh.posted.clear()
    captured(feed.handle_frame, json.dumps(SOL_BUY), st2)  # replay sau restart
    check(fh.posted == [], "(8) restart xong replay eventId cũ ⇒ KHÔNG re-POST")
finally:
    restore()

# ---------- (9) path FOMO-specific, KHÔNG đụng path wallet chung ----------

check(
    os.path.basename(feed.STATE_PATH) == "fomo_state.json",
    "(9) STATE_PATH=fomo_state.json (tên riêng)",
)
check(
    os.path.basename(feed.HEARTBEAT) == "fomo_heartbeat",
    "(9) HEARTBEAT=fomo_heartbeat (tên riêng)",
)
from watchers.common import state as common_state  # noqa: E402

check(
    os.path.basename(common_state.STATE_PATH) == "wallet_watch_state.json",
    "(9) path chung vẫn là wallet_watch_state.json",
)
check(
    os.path.basename(common_state.HEARTBEAT) == "heartbeat",
    "(9) heartbeat chung vẫn là 'heartbeat'",
)
check(
    feed.STATE_PATH != common_state.STATE_PATH
    and feed.HEARTBEAT != common_state.HEARTBEAT,
    "(9) fomo path ≠ path chung",
)
fh = reset(users=[{"handle": SOL_BUY["trader"], "source": "csv"}])
try:
    st = {}
    captured(feed.handle_frame, json.dumps(SOL_BUY), st)
    feed._beat()
    check(
        os.path.exists(feed.STATE_PATH) and os.path.exists(feed.HEARTBEAT),
        "(9) fomo state+heartbeat tồn tại sau emit",
    )
    check(
        not os.path.exists(os.path.join(TMP, "wallet_watch_state.json")),
        "(9) không sinh wallet_watch_state.json cạnh fomo file",
    )
    check(
        not os.path.exists(os.path.join(TMP, "heartbeat")),
        "(9) không sinh 'heartbeat' chung cạnh fomo file",
    )
    check(
        _sha(REAL_WALLET_STATE) == BEFORE_WALLET_STATE,
        "(9) wallet_watch_state.json THẬT không đổi (sha guard)",
    )
    check(
        _sha(REAL_HEARTBEAT) == BEFORE_HEARTBEAT,
        "(9) heartbeat THẬT không đổi (sha guard)",
    )
finally:
    restore()

# ---------- (10) key không lộ trong state + log ----------

KEY = "sk-SECRET-do-not-log-9931"


class _FakeConn:
    def __init__(self, frames):
        self._frames = list(frames)

    async def recv(self):
        if not self._frames:
            raise ConnectionError("mock closed")
        return self._frames.pop(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


fh = reset(users=[{"handle": SOL_BUY["trader"], "source": "csv"}])
_fake_ws = types.ModuleType("websockets")
_fake_ws.__dict__["connect"] = lambda url, **kw: _FakeConn(
    [WELCOME, json.dumps(SOL_BUY)]
)
_old_ws = sys.modules.get("websockets")
sys.modules["websockets"] = _fake_ws
try:
    _, out = captured(
        feed.run_feed, KEY, ws_url="ws://127.0.0.1:9/ws/alerts", once=True
    )
    check(KEY not in out, "(10) key không xuất hiện trong log (banner/err đã mask)")
    check("?key=***" in out, "(10) banner in ?key=*** (không log full URL)")
    check(
        len(fh.posted) == 1,
        f"(10) run_feed once: emit 1 qua socket giả (got {len(fh.posted)})",
    )
    raw_state = open(feed.STATE_PATH, encoding="utf-8").read()
    check(KEY not in raw_state, "(10) key không nằm trong state persist")
    check(SOL_BUY["eventId"] in raw_state, "(10) state chứa eventId đã emit")
    check(
        os.path.exists(feed.HEARTBEAT), "(10) heartbeat fomo được touch trong run_feed"
    )
    check("socket connected" in out, "(10) có log line socket connected")
finally:
    if _old_ws is None:
        sys.modules.pop("websockets", None)
    else:
        sys.modules["websockets"] = _old_ws
    restore()

check(
    "SECRET" not in feed._safe("SECRET", Exception("rejected wss://x?key=SECRET")),
    "(10) _safe() mask key trong message lỗi",
)

# ---------- (11) ingest 404 ⇒ refresh watch list ngay (không retry body) ----------

fh = reset(users=[{"handle": SOL_BUY["trader"], "source": "csv"}], post_status=404)
try:
    feed.refresh_watch_list(force=True)
    g0 = fh.get_calls
    _b = feed.alert_body(SOL_BUY)
    assert _b is not None, "SOL_BUY phải khớp watch list"
    feed.post_fomo_trade(_b)
    check(fh.get_calls == g0 + 1, "(11) 404 ⇒ GET /api/fomo-users refresh đúng 1 lần")
    check(fh.posted == [], "(11) 404 ⇒ không retry POST body cũ")
finally:
    restore()

# ---------- (12) refresh cadence: chưa tới hạn ⇒ không fetch ----------

fh = reset(users=[{"handle": "x", "source": "csv"}])
try:
    feed.refresh_watch_list(force=True)
    n = fh.get_calls
    feed.refresh_watch_list()  # next đã set +300s
    check(fh.get_calls == n, "(12) trong cadence ~300s ⇒ 0 fetch thêm")
    feed._wl["next"] = 0.0  # giả hết hạn
    feed.refresh_watch_list()
    check(fh.get_calls == n + 1, "(12) hết hạn ⇒ fetch lại")
    check(
        abs(feed._wl["next"] - time.time() - 300.0) < 2,
        "(12) next ≈ now+300s (_CFG_REFRESH_S)",
    )
finally:
    restore()

assert fail == 0, f"{fail} check sai"
print(f"PASS: fomo-watch {total - fail}/{total} (offline, deterministic)")


def test_fomo_watch():
    """pytest gate — module-level harness đã chạy khi import; tái khẳng định gate."""
    assert fail == 0, f"{fail} check sai"
