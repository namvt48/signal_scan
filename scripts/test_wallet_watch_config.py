#!/usr/bin/env python3
"""Config-from-API của wallet_watch: load_config_from_api + track_post_body usd.

Chạy: python3 scripts/test_wallet_watch_config.py   (offline — http_json bị stub,
không gọi mạng). Cover:
  (a) API settings trả minUsd=50 → min_usd hiệu dụng = 50 (override CLI);
      giá trị rác (0/âm/thiếu key/str/NaN/inf/bool) → giữ CLI.
  (b) API raise (mạng chết) → giữ CLI, KHÔNG raise ra ngoài startup.
  (c) API wallets trả list → address từng item thành wallet list (override file).
  (d) API wallets trả list (kể cả []) → tab Wallet là NGUỒN DUY NHẤT, [] xoá hết ví;
      lỗi mạng/sai shape → giữ list seed từ file/CLI.
  (e) track_post_body: có giá ⇒ "usd" đúng bằng quote_usd; THIẾU giá ⇒ body KHÔNG
      có key "usd" nhưng VẪN post (server lưu entry_usd NULL rồi tự gate $50 —
      fail-open, Q1 2026-09-21). _swap_event KHÔNG còn drop theo min_usd (§9.2:
      ngưỡng detect = 0 hằng số) — min_usd chỉ còn để log.

Monkeypatch qua setattr(...) — pyright cấm gán attribute lạ trên ModuleType
nhưng cho phép đọc; pattern tương đương _seed(ww) của test_wallet_watch.
"""

import importlib.util
import os
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "wallet_watch", os.path.join(HERE, "wallet_watch.py")
)
assert spec and spec.loader
ww = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ww)

DEAD = urllib.error.URLError("connection refused")


def _stub(settings=None, wallets=None, settings_err=None, wallets_err=None):
    def fake(url, payload=None, timeout=20):
        if url.endswith("/api/settings"):
            if settings_err:
                raise settings_err
            return settings
        if url.endswith("/api/wallets"):
            if wallets_err:
                raise wallets_err
            return wallets
        raise AssertionError(f"stub nhận URL lạ: {url}")

    return fake


def _load(stub, seed, cli):
    """Mô phỏng startup: seed wallets từ file/CLI, nạp config qua API stub.
    Trả (wallets hiệu dụng, min_usd hiệu dụng)."""
    setattr(ww, "http_json", stub)
    setattr(ww, "_api_url", "http://api.test")
    setattr(ww, "_cfg_next", 0.0)  # first-load: luôn log + luôn nạp
    setattr(ww, "_cfg_cli_min_usd", cli)
    setattr(ww, "min_usd", cli)
    ws = list(seed)
    ww.load_config_from_api(ws)
    return ws, ww.min_usd


FILE_SEED = ["FileWallet11111111111111111111111111111111111"]

# ---------- (a) settings: minUsd hợp lệ override, rác → CLI ----------

_, m = _load(_stub({"values": {"minUsd": 50, "freshMinPct": 10}}, []), FILE_SEED, 0.5)
assert m == 50.0 and isinstance(m, float), f"minUsd=50 phải thắng CLI, got {m}"
for bad in (
    {"values": {"minUsd": 0}},
    {"values": {"minUsd": -3}},
    {"values": {}},
    {"values": {"minUsd": "50"}},
    {"values": {"minUsd": float("nan")}},
    {"values": {"minUsd": float("inf")}},
    {"values": {"minUsd": True}},
    {},
):
    _, m = _load(_stub(bad, []), FILE_SEED, 0.5)
    assert m == 0.5, f"settings rác {bad} phải giữ CLI 0.5, got {m}"
_, m = _load(_stub(None, []), FILE_SEED, 2.5)
assert m == 2.5, "CLI --min-usd != default vẫn phải được giữ, got %r" % m
print("OK (a): API minUsd=50 override CLI; rác/thiếu → giữ cli/default")

# ---------- (b) settings raise → giữ CLI, không lọt exception ----------

_, m = _load(_stub(settings_err=DEAD, wallets=[]), FILE_SEED, 0.5)
assert m == 0.5
print("OK (b): API settings chết → giữ cli/default, load không raise")

# ---------- (c) wallets API list → override file ----------

api_w = [{"address": "ApiWalletAAA", "name": "ct01"}, {"address": "ApiWalletBBB"}]
ws, _ = _load(_stub({"values": {"minUsd": 1}}, api_w), FILE_SEED, 0.5)
assert ws == ["ApiWalletAAA", "ApiWalletBBB"], f"phải dùng address từ API, got {ws}"
print("OK (c): API wallets non-empty override file/CLI")

# ---------- (d) tab Wallet là nguồn duy nhất; chỉ lỗi thật mới giữ list cũ ----------

# API trả [] (tab rỗng) = giá trị HỢP LỆ ⇒ xoá hết ví, KHÔNG giữ file
ws, _ = _load(_stub({"values": {"minUsd": 1}}, []), FILE_SEED, 0.5)
assert ws == [], "list rỗng từ API = tab rỗng ⇒ phải xoá hết ví, got %r" % ws
ws, _ = _load(_stub({"values": {}}, [{"nope": 1}, {"address": ""}]), FILE_SEED, 0.5)
assert ws == [], "item không address bị bỏ → [] hợp lệ → xoá hết ví, got %r" % ws
# lỗi mạng / sai shape ⇒ GIỮ list hiện tại (một lần timeout không được xoá ví)
ws, _ = _load(_stub({"values": {}}, None, wallets_err=DEAD), FILE_SEED, 0.5)
assert ws == FILE_SEED, "API chết phải giữ file, got %r" % ws
ws, _ = _load(_stub({"values": {}}, {"address": "notAList"}), FILE_SEED, 0.5)
assert ws == FILE_SEED, "sai shape phải giữ file, got %r" % ws
# list API thắng nhưng mutate IN-PLACE: caller giữ cùng reference phải thấy list mới
same_ref = list(FILE_SEED)
setattr(ww, "http_json", _stub({"values": {}}, api_w))
ww.load_config_from_api(same_ref)
assert same_ref == ["ApiWalletAAA", "ApiWalletBBB"], (
    "phải mutate in-place, got %r" % same_ref
)
# refresh: tab còn ví → tab rỗng ⇒ xoá ví (tab là nguồn, không phải file)
setattr(ww, "http_json", _stub({"values": {}}, []))
ww.load_config_from_api(same_ref)
assert same_ref == [], "refresh thấy tab rỗng ⇒ phải xoá hết ví, got %r" % same_ref
print("OK (d): tab Wallet là nguồn duy nhất; [] xoá hết ví; lỗi/sai shape giữ list cũ")

# ---------- refresh định kỳ: _cfg_next set, load lại nhận giá trị API mới ----------

ws, _ = _load(_stub({"values": {"minUsd": 7}}, []), FILE_SEED, 0.5)
assert ww.min_usd == 7.0 and ww._cfg_next > ww.time.time(), "chưa tới hạn refresh"
setattr(ww, "http_json", _stub({"values": {"minUsd": 8}}, []))
setattr(ww, "_cfg_next", 0.0)  # giả lập tới hạn
setattr(ww, "_cfg_cli_min_usd", 0.5)
ww.load_config_from_api(ws)
assert ww.min_usd == 8.0, "refresh phải lấy giá trị API mới, got %r" % ww.min_usd
print("OK: refresh — _cfg_next gate + load lại nhận giá trị API mới")

# ---------- (e) usd trong POST body = đúng qusd của gate min_usd ----------

TOK = "TokTest11111111111111111111111111111111111"
W = "WalletAddr111111111111111111111111111111111"
SIG = "SigTest123"
ww._info[TOK] = ("TOK", 1.0)
ww._sol_px["v"] = 200.0  # WSOL price ⇒ qusd = 0.25 WSOL × 200 = 50.0
sa = {
    "mint": TOK,
    "raw": 1_000_000_000,
    "dec": 6,
    "rs": "POOL",
    "rd": "out",
    "encl": "ray",
}
sb = {
    "mint": ww.WSOL,
    "raw": 250_000_000,
    "dec": 9,
    "rs": "WALLET",
    "rd": "in",
    "encl": "ray",
}
rank = ww._rank_mints([(TOK, ww.WSOL)])
args = ({"slot": 1}, W, SIG, "09-16 10:00:00", sa, sb, "PoolAddr", rank)

setattr(ww, "min_usd", 10.0)  # 50 vượt ngưỡng ⇒ emit
ev, _, bm, qm = ww._swap_event(*args)
assert ev is not None, "qusd=50 > min_usd=10 ⇒ event phải được emit"
assert bm == TOK and qm == ww.WSOL, "base/quote sai ⇒ fixture test hỏng"
assert ev["quote_usd"] == 50.0, "fixture: quote_usd phải đúng 50.0"
body = ww.track_post_body(ev)
assert body is not None and body["usd"] == 50.0 == ev["quote_usd"], body
assert isinstance(body["usd"], float)
assert body["address"] == TOK and body["chain"] == "sol", "field cũ không được đổi"

# §9.2: ngưỡng DETECT = 0 hằng số. min_usd=60 chỉ là con số server dùng ở bước
# add-CA ⇒ detector KHÔNG được drop theo nó (đo thật: buys $4.88–49.19 bị mất —
# 2BqRLrAGxh CA +2064.9502 / −0.045501 SOL, không có event nào).
setattr(ww, "min_usd", 60.0)
ev2, _, _, _ = ww._swap_event(*args)
assert ev2 is not None and ev2["quote_usd"] == 50.0, (
    "0 < 50 < 60 nhưng min_usd KHÔNG còn gate emit — gate $50 nằm ở server"
)

setattr(ww, "min_usd", 0.0)
ww._sol_px["v"] = 0.0  # thiếu price ⇒ quote_usd None (không bịa 0) ⇒ usd_pending
ev3, _, _, _ = ww._swap_event(*args)
assert ev3 is not None and ev3["usd_pending"] and ev3["quote_usd"] is None, ev3
body3 = ww.track_post_body(ev3)
assert body3 is not None and "usd" not in body3, (
    f"thiếu giá vẫn phải post (fail-open server) nhưng KHÔNG bịa usd: {body3}"
)
print(
    "OK (e): quote_usd=50 → body.usd=50; min_usd KHÔNG gate emit; thiếu giá ⇒ None + no usd"
)

# ---------- event shape cũ (thiếu type) → None, không post mù ----------

legacy = {"side": "BUY", "mint": "M1", "wallet": W, "sig": SIG}
assert ww.track_post_body(legacy) is None, "type != SWAP ⇒ không vào queue CA"
print("OK: event không phải SWAP → None (chỉ SWAP mới vào queue CA)")

# ---------- (f) watch_trade_body: trade cho cột `Tracked by` ----------

b = ww.watch_trade_body(ev, 1_758_000_000)
assert b is not None, "BUY hợp lệ phải tạo body"
assert b["wallet"] == W and b["ca"] == TOK and b["tx"] == SIG and b["chain"] == "sol", b
assert b["ts"] == 1_758_000_000_000, f"blockTime giây ⇒ epoch ms, got {b['ts']}"
assert b["amountUsd"] == 50.0 == ev["quote_usd"]
assert abs(b["price"] - 0.05) < 1e-12, f"price = usd/qty = 50/1000, got {b['price']}"

before_ms = int(ww.time.time() * 1000)
assert before_ms <= ww.watch_trade_body(ev)["ts"] <= int(ww.time.time() * 1000) + 1, (
    "thiếu blockTime ⇒ phải lấy time.time()"
)

# SELL cũng POST (user 2026-09-23) — server đọc balance lại từ nó; thiếu khoá
# định danh ⇒ None.
sell_body = ww.watch_trade_body({**ev, "side": "SELL"})
assert sell_body is not None and sell_body["side"] == "sell", sell_body
assert ww.watch_trade_body({**ev, "sig": None}) is None, "thiếu sig ⇒ None"
assert ww.watch_trade_body({**ev, "wallet": ""}) is None, "thiếu wallet ⇒ None"
assert ww.watch_trade_body({**ev, "mint": ""}) is None, "thiếu mint ⇒ None"

# CẢ 2 đường đều post buy thiếu giá (fail-open, Q1 2026-09-21): CA path bỏ hẳn key
# "usd" (server lưu entry_usd NULL rồi tự gate $50), Tracked by path ghi 0.
b3 = ww.watch_trade_body(ev3, 1_758_000_000)
assert b3 is not None and b3["amountUsd"] == 0.0 and b3["price"] == 0.0, b3
ca_body3 = ww.track_post_body(ev3)
assert ca_body3 is not None and ca_body3["address"] == TOK and "usd" not in ca_body3, (
    f"CA path fail-open khi thiếu giá, KHÔNG bịa usd: {ca_body3}"
)
assert (
    ww.watch_trade_body({**ev, "quote_usd": "rác", "qty": float("inf")})["amountUsd"]
    == 0.0
)
print("OK (f): watch_trade_body — buy có/không giá, sell có side, thiếu khoá → None")

print("PASS: toàn bộ test config-from-API")
