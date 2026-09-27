#!/usr/bin/env python3
"""Regression nhãn PER-STEP trên 6 tx mainnet đã gắn nhãn (scripts/fixtures/soltxs*.pkl).

Chạy: python3 scripts/test_wallet_watch.py   (offline — giá được seed, không gọi mạng)

T9 (plan gmgn-parity-fixes): classify() route-level đã bị xoá ở T4; detector giờ
là detect_swaps — 1 event = 1 BƯỚC swap qua 1 pool, qty = GROSS leg LUÔN DƯƠNG
(amount_basis="gross_leg"), side BUY/SELL theo hướng endpoint POOL của leg base.
Nhãn cũ viết lại per-step, lý do từng thay đổi:
  - 2 row TRANSFER_OUT/TRANSFER_IN của 387w9fh8EF: XOÁ — tx đó là Jupiter
    withdraw: mọi JUP chuyển bằng spl-transfer TOP-LEVEL (không DEX CPI) ⇒ mọi
    leg REJECT "plumbing" ⇒ 0 step (trace nguyên văn trong T9.log). Hai nhãn cũ
    không map được sang step nào — không invented số thay thế.
  - SELL đổi dấu: -312930.0 → 312930.0 (gross leg luôn dương, hướng nằm ở side).
  - net-delta → gross-leg (fee trong pool không bị trừ nữa):
      2mneSLq2D3 BUY FLCW 30445119.4639 (net) → 31386721.0969 (gross,
        leg raw=31386721096855 dec=6).
      4arviYxdWk BUY JUPCAT 315504.6238 (net) → 325262.4987 (gross,
        leg raw=325262498731 dec=6).
  - route nhiều pool giờ emit TỪNG bước trung gian (trước net theo ví):
      2mneSLq2D3 + BUY WBNB (mid leg raw=34804351 dec=8).
      5ddSkkUi1B + 2× SELL JUP (raw=1729782450 + raw=453531662; tổng =
        2183314112 = đúng leg JUP nhận ở step 1 ✓).
      4arviYxdWk + BUY JUP (raw=1064300462 dec=6).
      UPNTbDWxn3 + SELL mid 98sMhv… (raw=6346289517 dec=9).
Mỗi tuple = (sig_prefix, wallet_role, side, mint_prefix, qty_gross). Mọi giá trị
suy từ detector chạy trên fixture rồi đối chiếu TAY với leg raw/dec trên đây
(leg table đầy đủ: .omo/evidence/gmgn-parity-fixes/T9.log).
Chỉ detect ví CÓ MẶT trong accountKeys — đúng path emit production (_handle_tx);
detect_swaps trên ví vắng mặt không phải ground-truth của hệ thống.
"""

import importlib.util
import os
import pickle

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "wallet_watch", os.path.join(HERE, "wallet_watch.py")
)
assert spec and spec.loader
ww = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ww)


def _seed(ww):
    """Seed cache hermetic (pattern seed() của test_gmgn_api_parity — không
    DexScreener/getTokenSupply). min_usd=0.0: filter giá không được làm rơi
    step của regression (quote thiếu giá ⇒ usd_pending=True, vẫn emit)."""
    ww._sol_px["v"] = 100.0
    ww.min_usd = 0.0
    mints = {
        "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": ("JUP", 0.23),
        "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh": ("NVDAx", 220.0),
        "FLcwGtnhY2rw2J9jC6P9nPpBUycEVZLz4qbFXaVp1Y8o": ("FLCW", 8e-6),
        "AaEhFTX4naHSWSXz9TVe5QgLbtSLT8ZqYJGZzDDcoroh": ("JUPCAT", 8e-4),
        "HYm6BfpDQkfUtnCWVnj6YAGzJvnpzuCWDZKrpbAVkBFh": ("WUFF", 1e-9),
    }
    for m, ts in mints.items():
        ww._info[m] = ts
        ww._supply[m] = 1e6  # không phải NFT supply=1


_seed(ww)

ACK = "AcKpsk3AKJR8YiTrHr2XCFZ2WV8gcM3zjgcr4P1MjHD1"
SPLIT = "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD"
RFQ = "9BB7Tt5uE5VdRsxA5XRqrjwNaq8XtgAUQW8czA6ymUPG"
ROLES = {ACK: "ACK", SPLIT: "SPLIT", RFQ: "RFQ"}

# (sig10, role, side, mint10, qty_gross) — nhãn per-step đã soát tay theo leg:
EXPECTED = {
    # 387w9fh8EF: 0 step (Jupiter withdraw — xem docstring, 2 row cũ đã xoá)
    # 3GkmwgW2vE — RFQ OTC NVDAx↔USDC qua 61DFfeTK: 1 leg NVDAx raw=4846270
    # dec=8 ⇒ 0.0484627; ACK là phía bán, RFQ phía mua (cùng 1 step, 2 ví)
    ("3GkmwgW2vE", "ACK", "SELL", "Xsc9qvGR1e", 0.0485),
    ("3GkmwgW2vE", "RFQ", "BUY", "Xsc9qvGR1e", 0.0485),
    # 2mneSLq2D3 — route SOL→WBNB→FLCW, 2 step:
    # step1 WBNB raw=34804351 dec=8 (whirLbMi CmyuZJEn, quote SOL 2.5)
    # step2 FLCW raw=31386721096855 dec=6 (LanMV9sA WLHv2UAZ, quote WBNB)
    ("2mneSLq2D3", "ACK", "BUY", "9gP2kCy3wA", 0.348),
    ("2mneSLq2D3", "ACK", "BUY", "FLcwGtnhY2", 31386721.0969),
    # 5ddSkkUi1B — SELL JUPCAT raw=312930000000 dec=6 ← JUP (CPMM GpMZbSM2);
    # JUP nhận 2183.314112 bán tiếp 2 pool: 1729.78245 (whirLbMi C1MgLojN) +
    # 453.531662 (Meteora Eio6hAie) — cả 2 quote SOL
    ("5ddSkkUi1B", "ACK", "SELL", "AaEhFTX4na", 312930.0),
    ("5ddSkkUi1B", "ACK", "SELL", "JUPyiwrYJF", 1729.7824),
    ("5ddSkkUi1B", "ACK", "SELL", "JUPyiwrYJF", 453.5317),
    # 4arviYxdWk — BUY SOL→JUP raw=1064300462 dec=6 (whirLbMi C1MgLojN)
    # →JUPCAT raw=325262498731 dec=6 (CPMM GpMZbSM2)
    ("4arviYxdWk", "ACK", "BUY", "JUPyiwrYJF", 1064.3005),
    ("4arviYxdWk", "ACK", "BUY", "AaEhFTX4na", 325262.4987),
    # UPNTbDWxn3 — SELL WUFF raw=1488274000000 dec=6 (CPMM GpMZbSM2) → mid
    # 98sMhv raw=6346289517 dec=9 → USDC (goonuddt 8TDBxPXy)
    ("UPNTbDWxn3", "ACK", "SELL", "HYm6BfpDQk", 1488274.0),
    ("UPNTbDWxn3", "ACK", "SELL", "98sMhvDwXj", 6.3463),
}

got = set()
for f in ("fixtures/soltxs.pkl", "fixtures/soltxs2.pkl"):
    d = pickle.load(open(os.path.join(HERE, f), "rb"))
    for tx in d.values() if isinstance(d, dict) else d:
        keys = {ak["pubkey"] for ak in tx["transaction"]["message"]["accountKeys"]}
        for w, role in ROLES.items():
            if w not in keys:  # production (_handle_tx) chỉ detect ví có mặt
                continue
            for e in ww.detect_swaps(tx, w):
                got.add(
                    (
                        e["sig"][:10],
                        role,
                        e["side"],
                        e["mint"][:10],
                        round(e["qty"], 4),
                    )
                )

fail = 0
for sig, role, side, mint, qty in sorted(EXPECTED):
    hit = next(
        (
            g
            for g in got
            if g[0] == sig
            and g[1] == role
            and g[2] == side
            and g[3] == mint
            and abs(g[4] - qty) <= max(1e-4, abs(qty) * 1e-6)
        ),
        None,
    )
    print(("PASS" if hit else "FAIL"), f"{sig} {role:<5} {side:<4} {mint} {qty:,.4f}")
    fail += not hit
# đủ 2 chiều: mọi event emit ra phải nằm trong nhãn (bản cũ chỉ in extra, không
# fail — T9 siết lại: got == EXPECTED chính xác theo set)
assert got == EXPECTED, (
    f"got != EXPECTED — thiếu {sorted(EXPECTED - got)} thừa {sorted(got - EXPECTED)}"
)
assert fail == 0, f"{fail}/{len(EXPECTED)} nhãn sai"
print(
    f"OK: {len(EXPECTED)}/{len(EXPECTED)} nhãn per-step khớp ground-truth (gross leg)"
)

# ---------- track_post_body (--track POST body, pure/không mạng) ----------

TR_W = "AcKpsk3AKJR8YiTrHr2XCFZ2WV8gcM3zjgcr4P1MjHD1"
TR_SIG = "387w9fh8EF"


def _ev(side, mint, quote_usd: float | None = 123.45, type_: str = "SWAP"):
    ev = {"side": side, "mint": mint, "wallet": TR_W, "sig": TR_SIG, "type": type_}
    if quote_usd is not None:
        ev["quote_usd"] = quote_usd
    return ev


assert ww.track_post_body(_ev("BUY", "MintBuy111")) == {
    "address": "MintBuy111",
    "chain": "sol",
    "note": f"auto:BUY by {TR_W} {TR_SIG}",
    "usd": 123.45,
}
assert (
    ww.track_post_body(_ev("SELL", "MintSell22")) is None
)  # sell chỉ log, không vào CA tracking
for side in ("SELL", "TRANSFER_IN", "TRANSFER_OUT", "NEUTRAL"):
    assert ww.track_post_body(_ev(side, "MintBuy111")) is None, side
assert ww.track_post_body(_ev("BUY", "")) is None
assert ww.track_post_body(_ev("SELL", "")) is None
# type=RECEIVE (airdrop/claim/_recv_event) KHÔNG bao giờ vào queue CA
assert ww.track_post_body(_ev("BUY", "MintRecv333", type_="RECEIVE")) is None
print(
    "OK: track_post_body CHỈ SWAP+BUY → body; SELL/TRANSFER/RECEIVE/empty-mint → None"
)

# Thiếu giá ⇒ VẪN post nhưng KHÔNG có key 'usd': server lưu entry_usd NULL rồi tự
# gate $50 của nó (fail-open — Q1 2026-09-21). Detector không được tự bỏ trade thật
# (§9.2 ngưỡng detect = 0 hằng số; đo $4.88–49.19 buys từng bị gate bỏ: 2BqRLrAGxh).
unp = ww.track_post_body(_ev("BUY", "MintBuy111", quote_usd=None))
assert unp == {
    "address": "MintBuy111",
    "chain": "sol",
    "note": f"auto:BUY by {TR_W} {TR_SIG}",
}, unp
assert (
    ww.track_post_body(_ev("BUY", "MintBuy111", quote_usd=0)) == unp
)  # 0 = chưa biết giá
priced = ww.track_post_body(_ev("BUY", "MintBuy111", quote_usd=42.0))
assert priced is not None and priced["usd"] == 42.0, priced
print(
    "OK: track_post_body thiếu giá → body KHÔNG có 'usd' (fail-open); priced → usd đúng"
)

# ---------- quote USDC: quote_usd > 0 không cần network (px=1.0 hardcode) ----------

usdc_evs = []
for f in ("fixtures/soltxs.pkl", "fixtures/soltxs2.pkl"):
    d = pickle.load(open(os.path.join(HERE, f), "rb"))
    for tx in d.values() if isinstance(d, dict) else d:
        keys = {ak["pubkey"] for ak in tx["transaction"]["message"]["accountKeys"]}
        for w in ROLES:
            if w not in keys:
                continue
            for e in ww.detect_swaps(tx, w):
                if e["quote_mint"] == ww.USDC:
                    usdc_evs.append(e)
assert usdc_evs, "fixture không có event quote USDC nào — tiền đề test sai"
for e in usdc_evs:
    assert e["quote_usd"] > 0.0, f"{e['sig'][:10]} quote_usd={e['quote_usd']}"
    assert abs(e["quote_usd"] - e["quote_qty"]) < 1e-9, f"{e['sig'][:10]} px≠1.0"
    assert not e["usd_pending"], f"{e['sig'][:10]} usd_pending vẫn True"
print(f"OK: {len(usdc_evs)} event quote USDC — quote_usd == quote_qty (px=1.0)")

# ---------- _target_event: gộp 1 tx → ĐÚNG 1 CA (token đích) ----------

target_by_sig = {}
for f in ("fixtures/soltxs.pkl", "fixtures/soltxs2.pkl"):
    d = pickle.load(open(os.path.join(HERE, f), "rb"))
    for tx in d.values() if isinstance(d, dict) else d:
        keys = {ak["pubkey"] for ak in tx["transaction"]["message"]["accountKeys"]}
        if ACK not in keys:
            continue
        evs = ww.detect_swaps(tx, ACK)
        if not evs:
            continue
        t = ww._target_event(tx, ACK, evs)
        target_by_sig[evs[0]["sig"][:10]] = t["mint"][:10] if t else None
        if t is not None:
            assert t.get("side") == "BUY", t.get("side")

# route SOL→WBNB→FLCW: WBNB là quote bước 2 ⇒ leg, tx gộp về đúng FLCW
assert target_by_sig["2mneSLq2D3"] == "FLcwGtnhY2", target_by_sig["2mneSLq2D3"]
# route SOL→JUP→JUPCAT: JUP là leg, đích là JUPCAT
assert target_by_sig["4arviYxdWk"] == "AaEhFTX4na", target_by_sig["4arviYxdWk"]
# tx không có BUY (toàn SELL) ⇒ không có token đích ⇒ KHÔNG post gì
assert target_by_sig["3GkmwgW2vE"] is None, target_by_sig["3GkmwgW2vE"]
assert target_by_sig["5ddSkkUi1B"] is None, target_by_sig["5ddSkkUi1B"]
assert target_by_sig["UPNTbDWxn3"] is None, target_by_sig["UPNTbDWxn3"]
print("OK: _target_event gộp 1 tx → 1 CA (FLCW, JUPCAT); tx toàn SELL → None")

# ---------- rule A (chốt 2026-09-18): CA = token ĐÍCH của TRADER ----------
# Tx OTC: ví track KHÔNG ký, chỉ là ĐỐI ỨNG (bán memecoin cho một signer).
# CA phải là memecoin hai bên trao đổi — không phải token ví track nhận — side
# BUY, note ví track. Hai shape dưới đây chép từ tx mainnet thật, chỉ giữ các
# dòng balance cần thiết (không dùng fixtures: soltxs*.pkl không có 2 tx này).


def _otc_tx(wallet, signers, rows, sig="SIGotc"):
    """rows = (owner, mint, pre, post) → tx getTransaction tối thiểu."""
    pre, post = [], []
    for i, (owner, mint, a, b) in enumerate(rows):
        for lst, amt in ((pre, a), (post, b)):
            lst.append(
                {
                    "accountIndex": i,
                    "owner": owner,
                    "mint": mint,
                    "uiTokenAmount": {
                        "uiAmount": amt,
                        "uiAmountString": str(amt),
                        "decimals": 6,
                    },
                }
            )
    return {
        "slot": 1,
        "blockTime": 0,
        "transaction": {
            "signatures": [sig],
            "message": {
                "accountKeys": [{"pubkey": p, "signer": True} for p in signers]
            },
        },
        "meta": {"preTokenBalances": pre, "postTokenBalances": post},
    }


MARINE = "F8Sc8HoZmarineTESTmint111111111111111111"
KNOTS = "8RVBk8vxKNOTStestMINT1111111111111111111"
LINK = "LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L"
ZINC = "ZINCtestmint11111111111111111111111111111"
GPMZ = "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL"
HLNP = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
BOT = "5k3ZdP3vqNzwbgqKqFurWkEAdvSKbsKcjhoEvRDXMhgj"
BOT2 = "6UvTH39q9iGt7zqK21FQc6jQdnsU2xciL5Zcw2drc5Ej"
COSIGN = "sighWH8KaiT7QhtV4w29ReVF8kG6D5yG3EQP1KYyGVF"

# 4VPQRwNB: KNOTS→WSOL→LINK→MARINE. Ví track BÁN MARINE (không ký); đích MARINE.
tx1 = _otc_tx(
    GPMZ,
    [BOT, COSIGN],
    [
        (GPMZ, MARINE, 82577616.107, 80922290.529),
        (GPMZ, LINK, 1823.547, 1861.3216),
        (BOT, KNOTS, 38304.8739, 0.0),
        (BOT, MARINE, 0.0, 1605665.8104),
        (COSIGN, KNOTS, 1.0, 1.0),
    ],
)
assert ww._fill_dest(tx1, GPMZ, ww._net_owner(tx1, GPMZ)) == (BOT, MARINE)
t1 = ww._target_event(tx1, GPMZ, [])
assert t1["side"] == "BUY" and t1["mint"] == MARINE and t1["wallet"] == GPMZ
assert t1["quote_mint"] == KNOTS and abs(t1["qty"] - 1605665.8104) < 1e-6
assert t1["amount_basis"] == "net_delta" and t1["via"] == BOT
# quote là memecoin chưa có giá ⇒ mượn settlement của event ví, KHÔNG drop CA
t1b = ww._target_event(tx1, GPMZ, [{"mint": LINK, "side": "BUY", "quote_usd": 415.86}])
assert t1b["usd_basis"] == "counterparty" and t1b["quote_usd"] == 415.86

# 3Vdkaok: USDC→USD1→WSOL→ZINC. Ví track BÁN ZINC; quote = USDC ⇒ px = 1.0.
tx2 = _otc_tx(
    HLNP,
    [BOT2, COSIGN],
    [
        (HLNP, ZINC, 264.305358, 0.0),
        (HLNP, ww.WSOL, 0.0, 1.028097446),
        (BOT2, ww.USDC, 100.0, 0.0),
        (BOT2, ZINC, 0.0, 264.305358),
    ],
)
assert ww._fill_dest(tx2, HLNP, ww._net_owner(tx2, HLNP)) == (BOT2, ZINC)
t2 = ww._target_event(tx2, HLNP, [])
assert t2["mint"] == ZINC and t2["quote_mint"] == ww.USDC and t2["side"] == "BUY"
assert abs(t2["quote_usd"] - 100.0) < 1e-9, t2["quote_usd"]

# ví track KÝ và mua (đường cũ) ⇒ _fill_dest không được bắn
tx3 = _otc_tx(
    BOT,
    [BOT],
    [(BOT, KNOTS, 1.0, 0.0), (BOT, MARINE, 0.0, 5.0), (GPMZ, MARINE, 5.0, 0.0)],
)
assert ww._fill_dest(tx3, BOT, ww._net_owner(tx3, BOT)) is None
# ví track CÓ ký tx 2 signer (giao kèo, không phải OTC) ⇒ rule A không áp ⇒ None
tx6 = _otc_tx(GPMZ, [GPMZ, BOT], [(GPMZ, MARINE, 5.0, 0.0), (BOT, MARINE, 0.0, 5.0)])
assert ww._fill_dest(tx6, GPMZ, ww._net_owner(tx6, GPMZ)) == (BOT, MARINE)
assert ww._target_event(tx6, GPMZ, []) is None
# bán thật, không ai mua lại ⇒ None (không post gì)
tx4 = _otc_tx(GPMZ, [BOT], [(GPMZ, MARINE, 5.0, 0.0), (BOT, KNOTS, 0.0, 1.0)])
assert ww._fill_dest(tx4, GPMZ, ww._net_owner(tx4, GPMZ)) is None
assert ww._target_event(tx4, GPMZ, []) is None
# token TIỀN/route (WSOL) không bao giờ là đích dù signer "mua"
tx5 = _otc_tx(GPMZ, [BOT], [(GPMZ, ww.WSOL, 5.0, 0.0), (BOT, ww.WSOL, 0.0, 5.0)])
assert ww._fill_dest(tx5, GPMZ, ww._net_owner(tx5, GPMZ)) is None
print("OK: rule A — OTC fill ⇒ BUY MARINE / BUY ZINC, tiền-route loại, bán thật ⇒ None")

# ---------- FIX 2026-09-20: 3 defect emit-path (discovery / watermark / receive-only) ----------
# (a) discovery: ví KHÔNG nằm trong accountKeys nhưng CÓ ATA trong token balances
#     — 3jjAdrCK thật: EC2f5Dn nhận 15.000 USDC, trước fix tx vô hình (bị skip).
import json  # noqa: E402

EC2 = "EC2f5DnHzuNRit1ExqghSifDbp1wgrzktsRRZCtU92MJ"
tx_dep = json.load(open(os.path.join(HERE, "fixtures", "regress", "3jjAdrCK.json")))
keys_dep = {a["pubkey"] for a in tx_dep["transaction"]["message"]["accountKeys"]}
assert EC2 not in keys_dep, "fixture 3jjAdrCK: EC2 phải VẮNG accountKeys (tiền đề test)"
_ow, _ot = ww._warm_prices, ww.track_event
setattr(ww, "_warm_prices", lambda tx: None)
setattr(ww, "track_event", lambda ev: None)
st = {"wallets": {}}
ww._handle_tx(tx_dep, "SIGdep", [EC2], st)
setattr(ww, "_warm_prices", _ow)
setattr(ww, "track_event", _ot)
assert st["wallets"].get(EC2, {}).get("head") == "SIGdep", (
    f"(a) discovery: ví có ATA trong balances bị skip ⇒ st={st}"
)
print("OK (a): _handle_tx nhận ví qua owner(pre/postTokenBalances) dù vắng accountKeys")

# (d) receive-only: ví không ký, không bán gì, chỉ NHẬN memecoin ⇒ phải có event
#     (trước fix: None ⇒ hoàn toàn vô hình). Chưa có quote ⇒ usd_pending, log-only.
txr = _otc_tx(GPMZ, [BOT], [(GPMZ, MARINE, 0.0, 5.0)])
assert ww._fill_dest(txr, GPMZ, ww._net_owner(txr, GPMZ)) is None
tr = ww._target_event(txr, GPMZ, [])
assert tr and tr["mint"] == MARINE and tr["amount_basis"] == "net_delta", tr
assert tr["type"] == "RECEIVE" and tr["side"] == "RECEIVE", tr
assert tr["usd_pending"] and tr["quote_usd"] is None, tr
assert ww.track_post_body(tr) is None, "type=RECEIVE KHÔNG vào queue CA"
print("OK (d): ví chỉ NHẬN token mà không ký ⇒ event RECEIVE (log-only)")

# ---------- §5.1/§5.4/§5.5 + §4.1 (2026-09-21): qty_net / per-hop POST / phantom ----------

CT_W = "5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij"  # ví cặp CTRL (thật)
CT_MINT_PHANTOM = "H74CYmXgMkYHYuSRsZt6RJb4NYp2u72Vw8BS5huApump"  # LMAO!

# (i) §4.1 phantom (đã fix): hop base mà tài khoản ví GIỮ mint đó suốt tx (row
#     pre==post ≠ 0) trong route pump.fun ⇒ BỎ. Đo trên 2 tx CTRL thật: row
#     H74CYmXg (= delta vault pool AFaYrF) biến mất, row thật 9CmbYf nguyên vẹn.
#     Rule đầy đủ = `wflat`; scope pump là fit oracle n=2 — xem `_PUMP_ROUTE`.
for _name, _exp_net in (
    ("ctr_645G7xUur.json", 147833200.482079),
    ("ctr_ARqeiAANqgXf.json", -78916600.241039),
):
    _tx = json.load(open(os.path.join(HERE, "fixtures/ctr", _name)))["result"]
    _tr: list[str] = []
    _evs = ww.detect_swaps(_tx, CT_W, _tr.append)
    assert not [e for e in _evs if e["mint"] == CT_MINT_PHANTOM], (_name, _evs)
    assert any("phantom_flat_wallet_acct" in m for m in _tr), (_name, _tr)
    assert len(_evs) == 1 and _evs[0]["mint"].startswith("9CmbYf"), (_name, _evs)
    assert abs(_evs[0]["qty_net"] - _exp_net) < 0.01, (
        _name,
        _evs[0]["qty_net"],
        _exp_net,
    )
    assert _evs[0]["side"] == ("BUY" if _exp_net > 0 else "SELL"), (_name, _evs[0])
print("OK (i): phantom H74 bị bỏ, row thật 9CmbYf nguyên vẹn (fix §4.1)")

# (ii) qty_net = net ví cho mint đó (fixture thật): tổng qty_net theo mint == net,
#      kể cả mint xuất hiện nhiều hop (chia tỉ lệ ⇒ không đếm trùng).
# (iii) FLCW fee 3% (đo tay 2026-09-21): gross 31,386,721.0969 → net 30,445,119.4639
#       ⇒ qty_net/qty == 0.97 chính xác (trước fix: 3.09% cao hơn chain).
mint_seen, fee_seen = 0, 0
for f in ("fixtures/soltxs.pkl", "fixtures/soltxs2.pkl"):
    d = pickle.load(open(os.path.join(HERE, f), "rb"))
    for tx in d.values() if isinstance(d, dict) else d:
        keys = {ak["pubkey"] for ak in tx["transaction"]["message"]["accountKeys"]}
        for w in ROLES:
            if w not in keys:
                continue
            evs = ww.detect_swaps(tx, w)
            net = ww._net_owner(tx, w)
            per_mint: dict[str, float] = {}
            for e in evs:
                assert "ts_epoch_ms" not in e, (
                    "ts_epoch_ms do _handle_tx gắn, không do detector"
                )
                if e["qty_net"] is not None:
                    per_mint[e["mint"]] = per_mint.get(e["mint"], 0.0) + e["qty_net"]
                if e["sig"].startswith("2mneSLq2D3") and e["qty"] > 1e6:
                    r = e["qty_net"] / e["qty"]
                    assert abs(r - 0.97) < 1e-9, (e["qty"], e["qty_net"], r)
                    fee_seen += 1
            for m, tot in per_mint.items():
                n = net.get(m, 0.0)
                assert abs(tot - n) <= max(1e-6, abs(n) * 1e-9), (w[:6], m[:8], tot, n)
                mint_seen += 1
assert mint_seen and fee_seen, (
    f"fixture thiếu case (qty_net={mint_seen}, fee={fee_seen})"
)
print(
    f"OK (ii): {mint_seen} mint qty_net == net ví; OK (iii): FLCW fee 3% → qty_net/qty=0.97"
)

# (iv) _handle_tx: POST theo TỪNG hop net>0 (Q5) + KHÔNG fallback khi có hop +
#      dedupe theo (sig,wallet,mint,side,step) + ts_epoch_ms từ blockTime.
_posts: list[dict] = []
_wrote: list[dict] = []
_tgt: list[int] = []
_o_warm, _o_track, _o_watch, _o_jl, _o_tgt, _o_det = (
    ww._warm_prices,
    ww.track_event,
    ww.watch_trade_event,
    ww.jl_write,
    ww._target_event,
    ww.detect_swaps,
)
setattr(ww, "_warm_prices", lambda tx: None)
setattr(ww, "track_event", _posts.append)
setattr(ww, "watch_trade_event", lambda ev, bt=None: None)
setattr(ww, "jl_write", _wrote.append)
setattr(ww, "_target_event", lambda *a, **k: (_tgt.append(1), None)[1])
try:
    hi = None
    for f in ("fixtures/soltxs.pkl", "fixtures/soltxs2.pkl"):
        d = pickle.load(open(os.path.join(HERE, f), "rb"))
        for tx, w in (
            (t, w)
            for t in (d.values() if hasattr(d, "values") else d)
            for w in ROLES
            if w in {ak["pubkey"] for ak in t["transaction"]["message"]["accountKeys"]}
        ):
            hops = [
                e
                for e in ww.detect_swaps(tx, w)
                if e["type"] == "SWAP"
                and e["side"] == "BUY"
                and (e.get("qty_net") or 0) > 0
            ]
            if hops:
                hi = (tx, w, len(hops))
                break
        if hi:
            break
    assert hi, "fixture không có tx nào có hop BUY net>0 — tiền đề test sai"
    tx_m, w_m, n_hop = hi
    st_m: dict = {"wallets": {}}
    ww._handle_tx(tx_m, "SIGmulti", [w_m], st_m)
    assert len(_posts) == n_hop, f"post phải ĐỦ {n_hop} hop, got {len(_posts)}"
    assert not _tgt, "có hop net>0 ⇒ KHÔNG được dùng fallback _target_event"
    assert all("ts_epoch_ms" in e and e["ts_epoch_ms"] > 0 for e in _wrote), _wrote
    assert all(
        e["ts_epoch_ms"] == int((tx_m.get("blockTime") or 0) * 1000) for e in _wrote
    ), "ts_epoch_ms phải từ blockTime"
    _posts.clear()
    ww._handle_tx(tx_m, "SIGmulti", [w_m], st_m)  # cùng sig ⇒ dedupe
    assert not _posts, f"dedupe hỏng: post lại {len(_posts)} hop"

    # §4.1 phantom CHƯA fix (xem (i)): hiện row phantom vẫn được post như mọi row khác.

    # Nhiều hop: fixture không có ca này (SOLCAT 2P13YN7yqr là tx live, 3 hop) ⇒ stub
    # detector để chứng minh KHÔNG gộp 1 CA/tx và lọc đúng SWAP + (BUY net>0 | SELL).
    _base = {
        "ts": "09-21 10:00:00",
        "slot": 1,
        "sig": "SIGstub",
        "wallet": w_m,
        "sym": "TOK",
        "quote_mint": ww.WSOL,
        "quote_sym": "WSOL",
        "quote_qty": 1.0,
        "quote_usd": 100.0,
        "unit_price": 1.0,
        "pool": "",
        "program": "",
        "amount_basis": "gross_leg",
        "quote_inferred": False,
        "symbol_pending": False,
        "usd_pending": False,
        "type": "SWAP",
        "n_steps": 4,
    }
    stub = [
        {
            **_base,
            "side": "BUY",
            "mint": "Mint1",
            "qty": 10.0,
            "qty_net": 10.0,
            "step": 1,
        },
        {
            **_base,
            "side": "BUY",
            "mint": "Mint2",
            "qty": 20.0,
            "qty_net": 20.0,
            "step": 2,
        },
        {
            **_base,
            "side": "BUY",
            "mint": "Mint3",
            "qty": 30.0,
            "qty_net": 30.0,
            "step": 3,
        },
        {
            **_base,
            "side": "BUY",
            "mint": "Mint4",
            "qty": 40.0,
            "qty_net": 0.0,
            "step": 4,
        },
        {
            **_base,
            "side": "SELL",
            "mint": "Mint5",
            "qty": 50.0,
            "qty_net": -50.0,
            "step": 4,
        },
        {
            **_base,
            "type": "RECEIVE",
            "side": "RECEIVE",
            "mint": "Mint6",
            "qty": 60.0,
            "qty_net": None,
            "step": 1,
        },
    ]
    setattr(
        ww,
        "detect_swaps",
        lambda tx, wallet, trace=None, with_transfers=False: list(stub),
    )
    _posts.clear(), _wrote.clear()
    ww._handle_tx(tx_m, "SIGstub", [w_m], st_m)
    assert [p["mint"] for p in _posts] == ["Mint1", "Mint2", "Mint3", "Mint5"], (
        f"post = SWAP + (BUY net>0 hoặc SELL), không gộp 1 CA/tx: {_posts}"
    )
    assert len(_wrote) == 6, (
        f"cả 6 event phải vào jsonl (kể cả SELL/RECEIVE): {len(_wrote)}"
    )
    assert not _tgt, "có hop ⇒ không fallback"
finally:
    setattr(ww, "_warm_prices", _o_warm)
    setattr(ww, "track_event", _o_track)
    setattr(ww, "watch_trade_event", _o_watch)
    setattr(ww, "jl_write", _o_jl)
    setattr(ww, "_target_event", _o_tgt)
    setattr(ww, "detect_swaps", _o_det)
print(
    f"OK (iv): post đúng hop net>0 ({n_hop} real + 3/6 stub) + dedupe + ts_epoch_ms + không fallback"
)
# (v) §7.3 rotate + gzip theo NGÀY UTC: file live `events.jsonl` GIỮ NGUYÊN TÊN
#     (ruleA_real_regress.py đọc thẳng path đó) — bản cũ chỉ được nén sang
#     `events-YYYYMMDD.jsonl.gz`. Ngày suy từ mtime ⇒ sống qua restart.
import gzip as _gz  # noqa: E402
import glob  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

with tempfile.TemporaryDirectory() as _td:
    _live = os.path.join(_td, "events.jsonl")
    _o_jsonl = ww._jsonl
    setattr(ww, "_jsonl", _live)
    try:
        ww.jl_write({"sig": "A"})
        ww.jl_write({"sig": "B"})
        assert not glob.glob(_td + "/*.gz"), "trong cùng ngày KHÔNG được rotate"
        _yday = time.time() - 86400
        os.utime(_live, (_yday, _yday))
        ww.jl_write({"sig": "C"})
        _arch = glob.glob(_td + "/*.jsonl.gz")
        assert len(_arch) == 1, _arch
        _ymd = time.strftime("%Y%m%d", time.gmtime(_yday))
        assert _arch[0].endswith(f"events-{_ymd}.jsonl.gz"), _arch
        with _gz.open(_arch[0], "rt") as f:
            assert [json.loads(ln)["sig"] for ln in f if ln.strip()] == ["A", "B"], (
                _arch
            )
        with open(_live) as f:
            assert [json.loads(ln)["sig"] for ln in f if ln.strip()] == ["C"], _live
        assert not glob.glob(_td + "/*.tmp"), "còn rác .tmp"
        os.remove(_live)
        ww.jl_write({"sig": "D"})
        assert len(glob.glob(_td + "/*.jsonl.gz")) == 1, "không được tạo thêm archive"
    finally:
        setattr(ww, "_jsonl", _o_jsonl)
print(
    "OK (v): rotate theo ngày UTC → events-YYYYMMDD.jsonl.gz, file live giữ nguyên tên"
)

# --------------------------------------------------------------- token_info §
# Sự cố 2026-09-24: token_info đọc thẳng `pair.priceUsd` (giá BASE) của pool
# max-liquidity kể cả khi mint nằm phía QUOTE ⇒ _info[MET] = $1731.82 thay vì
# $0.3311 ⇒ mọi leg quote-MET phồng ~5230×. Lock: giá phải là giá CỦA CHÍNH mint,
# và median qua các pool để một pool thao túng không kéo được giá.
_MET = "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL"
_X = "XxxxXxxxXxxxXxxxXxxxXxxxXxxxXxxxXxxxXxxx"


def _pair(base, quote, price_usd, price_native):
    return {
        "baseToken": {"address": base, "symbol": "BASE"},
        "quoteToken": {"address": quote, "symbol": "QUOTE"},
        "priceUsd": price_usd,
        "priceNative": price_native,
    }


assert (
    abs(ww._price_from_pairs([_pair(_MET, _X, 0.3311, 5230.5)], _MET)[1] - 0.3311)
    < 1e-9
)
_px = ww._price_from_pairs([_pair(_X, _MET, 1731.82, 5230.5)], _MET)[1]
assert abs(_px - 0.3311) < 1e-3, f"quote-side phải chia priceNative, được {_px}"
_px = ww._price_from_pairs(
    [_pair(_X, _MET, 1731.82, 5230.5), _pair(_MET, _X, 0.3311, 1.0)], _MET
)[1]
assert 0.3 < _px < 0.35, f"median phải bỏ qua pool thao túng, được {_px}"
assert ww._price_from_pairs([_pair(_X, _X, 5.0, 1.0)], _MET)[1] == 0.0
assert ww._price_from_pairs([], _MET)[0] is None
print("OK (w): _price_from_pairs — giá của CHÍNH mint + median qua pool")

assert ww._gmgn_of(
    {"code": 0, "data": {"symbol": "BTCX", "price": {"price": "0.00097206308"}}}
) == ("BTCX", 0.00097206308)
assert ww._gmgn_of({"code": 429, "error": "RATE_LIMIT_BANNED"}) == (None, 0.0)
assert ww._gmgn_of({"code": 0, "data": {"symbol": "X", "price": {}}}) == ("X", 0.0)
assert ww._gmgn_of({"code": 0, "data": {"symbol": "X", "price": {"price": "abc"}}}) == (
    "X",
    0.0,
)
print("OK (w): _gmgn_of — parse envelope token/info + code≠0/giá rác ⇒ 0.0")

os.environ.pop("QUOTE_SOURCE", None)
assert ww._use_gmgn() is False, "mặc định quote USD phải là DexScreener"
os.environ["QUOTE_SOURCE"] = "gmgn"
assert ww._use_gmgn() is True
os.environ["QUOTE_SOURCE"] = "dexscreener"
assert ww._use_gmgn() is False
os.environ.pop("QUOTE_SOURCE", None)
print("OK (w): _use_gmgn — mặc định DexScreener, GMGN chỉ khi bật tường minh")

print("PASS: wallet_watch — qty_net / per-hop POST / rotate jsonl / phantom §4.1")
