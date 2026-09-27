#!/usr/bin/env python3
"""TDD gate cho fee-leg SELL (Option A) của `wallet_watch.detect_swaps`.

Chạy: python3 scripts/test_nansen_fee_leg.py   (offline 100%, không pytest)

Ground truth: `.probe/nansen-parity/trace-22.md` + `.omo/plans/nansen-groundtruth-parity.md`
(todo 4).  Điểm sửa discriminator: điều kiện (b) nguyên văn `role(dst) != "POOL"`
đã bị C0 bác (9/9 fee collector thật có rd=POOL vì token account của chúng tăng số
dư).  Test này khoá phương án B1: dst/dst_owner không được là pool account/pool
owner của bất kỳ paired step nào trong chính tx đó.

Ghi chú scope: plan viết C3 là "SELL A + BUY B + leg phí của A ⇒ 3 event", nhưng
điều đó mâu thuẫn với điều kiện bắt buộc (c) "có step BUY cùng base mint" và với
Must NOT "không promote khi step cùng mint chỉ SELL".  C3 ở đây dựng đúng họ
diff-ca: SELL A + BUY B + leg phí của **B** ⇒ 3 event; case `C3-conflict` khoá
thêm rằng leg phí của A (chỉ có SELL A, BUY là mint B) KHÔNG được promote.
"""

import importlib.util
import json
import os
import socket

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH = os.path.join(HERE, "wallet_watch.py")
FIX = os.path.join(HERE, "fixtures")
NANSEN_FIX = os.path.join(FIX, "nansen")

TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
PAMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
XFER_TYPES = (
    "transfer",
    "transferChecked",
    "transferCheckedWithFee",
    "transferWithFee",
)

WALLET = "Wallet111111111111111111111111111111111111"
POOL1 = "PoolOwner1111111111111111111111111111111111"
POOL2 = "PoolOwner2222222222222222222222222222222222"
FEECOL = "FeeCollector1111111111111111111111111111111"
OTHER = "OtherOwner111111111111111111111111111111111"
DEX1 = "DEX111111111111111111111111111111111111"
FEEPROG = "FeeRouter111111111111111111111111111111111"

MINTX = "MintX111111111111111111111111111111111111"
MINTY = "MintY111111111111111111111111111111111111"
MINTA = "MintA111111111111111111111111111111111111"
MINTB = "MintB111111111111111111111111111111111111"

WALLET_48Y3 = "2h7Ns9w2grSeQ9mE9WggJZvxMKKLNADJrKTSLucrbmzB"
MINT_48Y3 = "3z2tRjNuQjoq6UDcw4zyEPD1Eb5KXMPYb4GWFzVT1DPg"
MINT_RXR_NO_PROMOTE = "3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG"
WALLET_5FG = "5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij"
WALLET_3FEC = "FhsbQzAJWVDNwaH61cTo6XkkfEsmSYMZKs9VJHH32bVG"


def load_module():
    spec = importlib.util.spec_from_file_location("wallet_watch", WATCH)
    assert spec and spec.loader
    ww = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ww)
    return ww


def block_network(ww):
    def no_network(*a, **k):
        raise AssertionError(
            f"NETWORK CALL from fee-leg gate (hermetic violated): {a!r}"
        )

    ww.http_json = no_network
    ww.rpc = no_network
    socket.socket = no_network


WW = load_module()
block_network(WW)
USDC = WW.USDC

SYMBOLS = {
    MINTX: ("X", 1.0),
    MINTY: ("Y", 1.0),
    MINTA: ("A", 1.0),
    MINTB: ("B", 1.0),
}
for mint, sym_px in SYMBOLS.items():
    WW._info[mint] = sym_px
    WW._supply[mint] = 1_000_000.0
WW._sol_px["v"] = 100.0
setattr(WW, "min_usd", 0.0)


def _ui_str(raw: int, dec: int) -> str:
    sign = "-" if raw < 0 else ""
    raw = abs(raw)
    s = str(raw).rjust(dec + 1, "0")
    return sign + (f"{s[:-dec]}.{s[-dec:]}" if dec else s)


def _instr_tx(wallet, instructions, balances, sig):
    """Tx getTransaction tối thiểu đúng contract của `_frames`/`_bal_tables`.

    `instructions`: [{"programId":..., "transfers":[transfer_dict]}]
    `balances`: [(account, owner, mint, pre_raw, post_raw, decimals)]
    """
    accounts = [{"pubkey": wallet, "signer": True, "writable": True}]
    index = {}

    def add_account(pubkey):
        if pubkey not in index:
            index[pubkey] = len(accounts)
            accounts.append({"pubkey": pubkey, "signer": False, "writable": True})
        return index[pubkey]

    pre, post = [], []
    for acct, owner, mint, pre_raw, post_raw, dec in balances:
        i = add_account(acct)
        for store, raw in ((pre, pre_raw), (post, post_raw)):
            ui = _ui_str(raw, dec)
            store.append(
                {
                    "accountIndex": i,
                    "owner": owner,
                    "mint": mint,
                    "programId": TOKEN,
                    "uiTokenAmount": {
                        "amount": str(raw),
                        "decimals": dec,
                        "uiAmount": float(ui),
                        "uiAmountString": ui,
                    },
                }
            )

    msg_ix, inner = [], []
    for top_i, group in enumerate(instructions):
        msg_ix.append({"programId": group["programId"], "stackHeight": 1})
        children = []
        for tr in group.get("transfers") or []:
            add_account(tr["source"])
            add_account(tr["destination"])
            children.append(
                {
                    "programId": tr.get("program", TOKEN),
                    "stackHeight": 2,
                    "parsed": {
                        "type": tr.get("type", "transfer"),
                        "info": {
                            "source": tr["source"],
                            "destination": tr["destination"],
                            "mint": tr["mint"],
                            "amount": str(tr["raw"]),
                            "decimals": tr["dec"],
                        },
                    },
                }
            )
        if children:
            inner.append({"index": top_i, "instructions": children})

    return {
        "slot": 1,
        "blockTime": 0,
        "transaction": {
            "signatures": [sig],
            "message": {"accountKeys": accounts, "instructions": msg_ix},
        },
        "meta": {
            "err": None,
            "innerInstructions": inner,
            "preTokenBalances": pre,
            "postTokenBalances": post,
        },
    }


class _TxBuilder:
    """Dựng instruction-level tx synthetic; tự suy pre/postTokenBalances từ delta."""

    def __init__(self, wallet, sig):
        self.wallet = wallet
        self.sig = sig
        self.accounts = []
        self.instructions = []

    def token_account(self, owner, mint, dec, initial_raw):
        name = f"TA{len(self.accounts)}"
        self.accounts.append((name, owner, mint, dec, initial_raw))
        return name

    def transfer(
        self,
        source,
        destination,
        mint,
        raw,
        dec,
        type_="transfer",
        program=TOKEN,
        move_balance=True,
    ):
        return {
            "source": source,
            "destination": destination,
            "mint": mint,
            "raw": raw,
            "dec": dec,
            "type": type_,
            "program": program,
            "move_balance": move_balance,
        }

    def frame(self, program, transfers):
        self.instructions.append({"programId": program, "transfers": transfers})

    def build(self):
        deltas = {}
        for group in self.instructions:
            for tr in group.get("transfers") or []:
                if not tr.get("move_balance", True) or tr.get("type") not in XFER_TYPES:
                    continue
                deltas[tr["source"]] = deltas.get(tr["source"], 0) - tr["raw"]
                deltas[tr["destination"]] = deltas.get(tr["destination"], 0) + tr["raw"]
        balances = []
        for name, owner, mint, dec, initial in self.accounts:
            post = initial + deltas.get(name, 0)
            assert post >= 0, f"negative post balance for {name}: {post}"
            balances.append((name, owner, mint, initial, post, dec))
        return _instr_tx(self.wallet, self.instructions, balances, self.sig)


def _fees(evs):
    return [e for e in evs if e.get("fee_leg") is True]


def _regular(evs):
    return [e for e in evs if not e.get("fee_leg")]


def _one(items, what):
    assert len(items) == 1, f"expected exactly 1 {what}, got {len(items)}: {items}"
    return items[0]


def _signed_net(evs, mint):
    out = 0.0
    for e in evs:
        if e["mint"] != mint or e.get("qty_net") is None:
            continue
        out += e["qty_net"] if e["side"] == "BUY" else -e["qty_net"]
    return out


def _identity_class(evs, mint):
    sides = {e["side"] for e in _regular(evs) if e["mint"] == mint}
    if "BUY" in sides and "SELL" in sides:
        return "NET_IDENTITY_NA"
    return "OK"


def _assert_fee_shape(ev, cand_program):
    assert ev["side"] == "SELL", ev
    assert ev["type"] == "SWAP", ev
    assert ev["fee_leg"] is True, ev
    assert ev["pool"] == "", ev
    assert ev["amount_basis"] == "gross_leg", ev
    assert ev["program"] == cand_program, ev
    assert ev["program"] is not None, ev
    assert isinstance(ev["step"], int) and isinstance(ev["n_steps"], int), ev


def _load_fixture(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn

    return deco


@case("C1")
def c1():
    b = _TxBuilder(WALLET, "C1SIG")
    wX = b.token_account(WALLET, MINTX, 6, 0)
    pX = b.token_account(POOL1, MINTX, 6, 1_000_000_000)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    pU = b.token_account(POOL1, USDC, 6, 0)
    cX = b.token_account(FEECOL, MINTX, 6, 0)
    b.frame(
        DEX1,
        [
            b.transfer(pX, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, pU, USDC, 100_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(wX, cX, MINTX, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)

    assert len(evs) == 2, evs
    buy, fee = evs
    assert buy["side"] == "BUY" and buy["mint"] == MINTX, buy
    assert abs(buy["qty"] - 1000.0) < 1e-9, buy
    assert abs(buy["qty_net"] - 1000.0) < 1e-6, buy
    assert buy["quote_mint"] == USDC, buy
    assert abs(buy["unit_price"] - 0.1) < 1e-12, buy
    assert not buy.get("fee_leg"), buy

    _assert_fee_shape(fee, JUP)
    assert fee["mint"] == MINTX, fee
    assert abs(fee["qty"] - 10.0) < 1e-9, fee
    assert abs(fee["qty_net"] - 10.0) < 1e-9, fee
    assert fee["quote_mint"] == buy["quote_mint"], fee
    assert fee["quote_sym"] == buy["quote_sym"], fee
    assert abs(fee["unit_price"] - buy["unit_price"]) < 1e-12, fee
    assert abs(fee["quote_qty"] - 1.0) < 1e-9, fee
    assert fee["quote_usd"] is not None and abs(fee["quote_usd"] - 1.0) < 1e-9, fee
    assert fee["usd_pending"] is False, fee
    assert (fee["step"], fee["n_steps"]) == (2, 2), fee

    net_owner = WW._net_owner(tx, WALLET)[MINTX]
    assert abs(net_owner - 990.0) < 1e-9, net_owner
    assert abs(_signed_net(evs, MINTX) - net_owner) < 1e-6, _signed_net(evs, MINTX)


@case("C2")
def c2():
    b = _TxBuilder(WALLET, "C2SIG")
    wY = b.token_account(WALLET, MINTY, 6, 5_000_000)
    cY = b.token_account(FEECOL, MINTY, 6, 0)
    b.frame(JUP, [b.transfer(wY, cY, MINTY, 5_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert evs == [], evs
    assert _fees(evs) == [], evs


@case("C3")
def c3():
    b = _TxBuilder(WALLET, "C3SIG")
    wA = b.token_account(WALLET, MINTA, 6, 500_000_000)
    p1A = b.token_account(POOL1, MINTA, 6, 0)
    wU = b.token_account(WALLET, USDC, 6, 150_000_000)
    p1U = b.token_account(POOL1, USDC, 6, 50_000_000)
    wB = b.token_account(WALLET, MINTB, 6, 0)
    p2B = b.token_account(POOL2, MINTB, 6, 1_000_000_000)
    p2U = b.token_account(POOL2, USDC, 6, 0)
    relayB = "RelayB111111111111111111111111111111111111"

    b.frame(
        DEX1,
        [
            b.transfer(wA, p1A, MINTA, 500_000_000, 6),
            b.transfer(p1U, wU, USDC, 50_000_000, 6),
        ],
    )
    b.frame(
        FEEPROG,
        [
            b.transfer(p2B, wB, MINTB, 1_000_000_000, 6),
            b.transfer(wU, p2U, USDC, 100_000_000, 6),
        ],
    )
    b.frame(FEEPROG, [b.transfer(wB, relayB, MINTB, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)

    assert len(evs) == 3, evs
    sell_a, buy_b, fee = evs
    assert sell_a["side"] == "SELL" and sell_a["mint"] == MINTA, sell_a
    assert buy_b["side"] == "BUY" and buy_b["mint"] == MINTB, buy_b
    _assert_fee_shape(fee, FEEPROG)
    assert fee["mint"] == MINTB, fee
    assert abs(fee["qty"] - 10.0) < 1e-9, fee
    assert fee["quote_mint"] == buy_b["quote_mint"] == USDC, fee
    assert abs(fee["unit_price"] - buy_b["unit_price"]) < 1e-12, fee
    assert abs(fee["quote_qty"] - 1.0) < 1e-9, fee
    assert fee["quote_usd"] is not None, fee

    net_b = WW._net_owner(tx, WALLET)[MINTB]
    assert abs(net_b - 990.0) < 1e-9, net_b
    assert abs(_signed_net(evs, MINTB) - net_b) < 1e-6, _signed_net(evs, MINTB)


@case("C3-conflict")
def c3_conflict():
    """Plan text nói fee của A trong SELL A + BUY B, nhưng (c) cấm promote."""
    b = _TxBuilder(WALLET, "C3CONFLICT")
    wA = b.token_account(WALLET, MINTA, 6, 510_000_000)
    p1A = b.token_account(POOL1, MINTA, 6, 0)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    p1U = b.token_account(POOL1, USDC, 6, 50_000_000)
    wB = b.token_account(WALLET, MINTB, 6, 0)
    p2B = b.token_account(POOL2, MINTB, 6, 1_000_000_000)
    p2U = b.token_account(POOL2, USDC, 6, 0)
    cA = b.token_account(FEECOL, MINTA, 6, 0)

    b.frame(
        DEX1,
        [
            b.transfer(wA, p1A, MINTA, 500_000_000, 6),
            b.transfer(p1U, wU, USDC, 50_000_000, 6),
        ],
    )
    b.frame(
        DEX1,
        [
            b.transfer(p2B, wB, MINTB, 1_000_000_000, 6),
            b.transfer(wU, p2U, USDC, 100_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(wA, cA, MINTA, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert len(evs) == 2, evs
    assert _fees(evs) == [], evs


@case("C4")
def c4():
    b = _TxBuilder(WALLET, "C4SIG")
    wA = b.token_account(WALLET, MINTA, 6, 510_000_000)
    pA = b.token_account(POOL1, MINTA, 6, 0)
    wU = b.token_account(WALLET, USDC, 6, 0)
    pU = b.token_account(POOL1, USDC, 6, 50_000_000)
    cA = b.token_account(FEECOL, MINTA, 6, 0)
    b.frame(
        DEX1,
        [
            b.transfer(wA, pA, MINTA, 500_000_000, 6),
            b.transfer(pU, wU, USDC, 50_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(wA, cA, MINTA, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert len(evs) == 1, evs
    assert evs[0]["side"] == "SELL" and evs[0]["mint"] == MINTA, evs
    assert _fees(evs) == [], evs


@case("C5")
def c5():
    b = _TxBuilder(WALLET, "C5SIG")
    wX = b.token_account(WALLET, MINTX, 6, 0)
    pX = b.token_account(POOL1, MINTX, 6, 1_010_000_000)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    pU = b.token_account(POOL1, USDC, 6, 0)
    b.frame(
        DEX1,
        [
            b.transfer(pX, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, pU, USDC, 100_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(pX, wX, MINTX, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert len(evs) == 1, evs
    assert evs[0]["side"] == "BUY" and evs[0]["mint"] == MINTX, evs
    assert _fees(evs) == [], evs


@case("C6")
def c6():
    b = _TxBuilder(WALLET, "C6SIG")
    wX = b.token_account(WALLET, MINTX, 6, 0)
    pX = b.token_account(POOL1, MINTX, 6, 1_000_000_000)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    pU = b.token_account(POOL1, USDC, 6, 0)
    cX = b.token_account(FEECOL, MINTX, 6, 0)
    b.frame(
        DEX1,
        [
            b.transfer(pX, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, pU, USDC, 100_000_000, 6),
        ],
    )
    b.frame(
        JUP,
        [
            b.transfer(
                wX,
                cX,
                MINTX,
                10_000_000,
                6,
                type_="mintTo",
                move_balance=False,
            )
        ],
    )
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert len(evs) == 1, evs
    assert _fees(evs) == [], evs


@case("C7")
def c7():
    b = _TxBuilder(WALLET, "C7SIG")
    wX = b.token_account(WALLET, MINTX, 6, 0)
    pX = b.token_account(POOL1, MINTX, 6, 1_000_000_000)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    pU = b.token_account(POOL1, USDC, 6, 0)
    b.frame(
        DEX1,
        [
            b.transfer(pX, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, pU, USDC, 100_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(wX, pX, MINTX, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert len(evs) == 1, evs
    assert _fees(evs) == [], evs


@case("C7b")
def c7b():
    b = _TxBuilder(WALLET, "C7BSIG")
    wX = b.token_account(WALLET, MINTX, 6, 0)
    p1X = b.token_account(POOL1, MINTX, 6, 1_000_000_000)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    p1U = b.token_account(POOL1, USDC, 6, 0)
    p2X = b.token_account(POOL2, MINTX, 6, 0)
    b.frame(
        DEX1,
        [
            b.transfer(p1X, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, p1U, USDC, 100_000_000, 6),
        ],
    )
    b.frame(PAMM, [b.transfer(wX, p2X, MINTX, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)
    assert len(evs) == 1, evs
    assert _fees(evs) == [], evs


@case("C7-real")
def c7_real():
    """Amendment C0: collector thật bị role() gắn rd=POOL nhưng KHÔNG phải step pool.

    Dùng lại shape C1 vì đó chính là diff-case cần khoá: điều kiện (b) cũ
    `role(dst) != "POOL"` sẽ reject; B1 `dst/dst_owner ∉ pool_refs` phải promote.
    """
    c1()


@case("C8")
def c8():
    tx = _load_fixture(os.path.join(FIX, "3fec2kXP.json"))
    evs = WW.detect_swaps(tx, WALLET_3FEC)
    assert len(evs) == 2, evs
    assert _fees(evs) == [], evs
    assert all(e["amount_basis"] == "gross_leg" for e in evs), evs


@case("C9")
def c9():
    b = _TxBuilder(WALLET, "C9SIG")
    wX = b.token_account(WALLET, MINTX, 6, 0)
    p1X = b.token_account(POOL1, MINTX, 6, 1_000_000_000)
    p2X = b.token_account(POOL2, MINTX, 6, 1_000_000_000)
    cX = b.token_account(FEECOL, MINTX, 6, 0)
    wU = b.token_account(WALLET, USDC, 6, 300_000_000)
    p1U = b.token_account(POOL1, USDC, 6, 0)
    p2U = b.token_account(POOL2, USDC, 6, 0)

    b.frame(
        DEX1,
        [
            b.transfer(p1X, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, p1U, USDC, 100_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(wX, cX, MINTX, 10_000_000, 6)])
    b.frame(
        FEEPROG,
        [
            b.transfer(p2X, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, p2U, USDC, 200_000_000, 6),
        ],
    )
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)

    assert len(evs) == 3, evs
    buy1, fee, buy2 = evs
    assert buy1["side"] == "BUY" and buy1["mint"] == MINTX, buy1
    assert buy2["side"] == "BUY" and buy2["mint"] == MINTX, buy2
    assert abs(buy1["unit_price"] - 0.1) < 1e-12, buy1
    assert abs(buy2["unit_price"] - 0.2) < 1e-12, buy2
    _assert_fee_shape(fee, JUP)
    assert abs(fee["unit_price"] - 0.2) < 1e-12, fee
    assert (fee["step"], fee["n_steps"]) == (2, 3), fee
    net_owner = WW._net_owner(tx, WALLET)[MINTX]
    assert abs(_signed_net(evs, MINTX) - net_owner) < 1e-6, _signed_net(evs, MINTX)


@case("C10")
def c10():
    b = _TxBuilder(WALLET, "C10SIG")
    wX = b.token_account(WALLET, MINTX, 6, 10_000_000)
    p1X = b.token_account(POOL1, MINTX, 6, 1_000_000_000)
    p2X = b.token_account(POOL2, MINTX, 6, 0)
    cX = b.token_account(FEECOL, MINTX, 6, 0)
    wU = b.token_account(WALLET, USDC, 6, 100_000_000)
    p1U = b.token_account(POOL1, USDC, 6, 0)
    p2U = b.token_account(POOL2, USDC, 6, 90_000_000)

    b.frame(
        DEX1,
        [
            b.transfer(p1X, wX, MINTX, 1_000_000_000, 6),
            b.transfer(wU, p1U, USDC, 100_000_000, 6),
        ],
    )
    b.frame(
        FEEPROG,
        [
            b.transfer(wX, p2X, MINTX, 1_000_000_000, 6),
            b.transfer(p2U, wU, USDC, 90_000_000, 6),
        ],
    )
    b.frame(JUP, [b.transfer(wX, cX, MINTX, 10_000_000, 6)])
    tx = b.build()
    evs = WW.detect_swaps(tx, WALLET)

    assert len(evs) == 3, evs
    buy, sell, fee = evs
    assert buy["side"] == "BUY" and buy["mint"] == MINTX, buy
    assert (
        sell["side"] == "SELL" and sell["mint"] == MINTX and not sell.get("fee_leg")
    ), sell
    assert buy["qty_net"] is None, buy
    assert sell["qty_net"] is None, sell
    _assert_fee_shape(fee, JUP)
    assert abs(fee["qty_net"] - 10.0) < 1e-9, fee
    assert _identity_class(evs, MINTX) == "NET_IDENTITY_NA"
    net_owner = WW._net_owner(tx, WALLET)[MINTX]
    assert abs(net_owner + 10.0) < 1e-9, net_owner
    assert abs(_signed_net(evs, MINTX) - net_owner) < 1e-6, _signed_net(evs, MINTX)


@case("integration-48Y3e48T")
def integration_48y3():
    tx = _load_fixture(os.path.join(NANSEN_FIX, "48Y3e48T.json"))
    evs = WW.detect_swaps(tx, WALLET_48Y3)
    fees = _fees(evs)
    assert len(evs) == 3, evs
    fee = _one(fees, "fee event")
    buys = [e for e in _regular(evs) if e["mint"] == MINT_48Y3 and e["side"] == "BUY"]
    buy = _one(buys, "BUY 3z2tRjNu")

    assert abs(buy["qty"] - 48930.786206) < 1e-6, buy
    assert abs(buy["qty_net"] - 48930.786206) < 1e-6, buy
    _assert_fee_shape(fee, JUP)
    assert fee["mint"] == MINT_48Y3, fee
    assert abs(fee["qty"] - 48.9307862) < 1e-6, fee
    assert abs(fee["qty_net"] - 48.9307862) < 1e-6, fee
    assert fee["quote_mint"] == buy["quote_mint"], fee
    assert abs(fee["unit_price"] - buy["unit_price"]) < 1e-12, fee
    assert fee["quote_usd"] is not None, fee
    assert not fee["usd_pending"], fee
    assert sorted(e["step"] for e in evs) == [1, 2, 3], evs
    assert all(e["n_steps"] == 3 for e in evs), evs

    expected_net = 48881.855420
    measured_net = WW._net_owner(tx, WALLET_48Y3)[MINT_48Y3]
    signed = _signed_net(evs, MINT_48Y3)
    assert abs(measured_net - expected_net) < 1e-6, measured_net
    assert abs(signed - expected_net) < 1e-6, signed


@case("integration-RxrDxxL2")
def integration_rxr():
    tx = _load_fixture(os.path.join(NANSEN_FIX, "RxrDxxL2.json"))
    evs = WW.detect_swaps(tx, WALLET_48Y3)
    assert len(evs) == 4, evs
    assert _fees(evs) == [], evs
    assert [e["side"] for e in evs] == ["SELL", "SELL", "BUY", "BUY"], evs
    assert not any(
        e.get("fee_leg") and e["mint"] == MINT_RXR_NO_PROMOTE for e in evs
    ), evs


@case("integration-5fgRuKgt")
def integration_5fg():
    tx = _load_fixture(os.path.join(NANSEN_FIX, "5fgRuKgt.json"))
    evs = WW.detect_swaps(tx, WALLET_5FG)
    assert evs == [], evs


def main():
    failures = []
    for name, fn in CASES:
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"FAIL {name}: {exc}")
        except Exception as exc:
            failures.append(name)
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
    if failures:
        raise SystemExit(f"{len(failures)}/{len(CASES)} cases failed: {failures}")
    print(f"OK: {len(CASES)}/{len(CASES)} fee-leg cases passed")


if __name__ == "__main__":
    main()
