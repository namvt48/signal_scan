#!/usr/bin/env python3
"""Regression per-step trên 3 tx route nhiều pool (fixtures/route_txs.pkl).

Chạy: python3 scripts/test_route_detect.py   (offline — giá được seed, không gọi mạng)
Fixture: scripts/fixtures/route_txs.pkl — 3 tx mainnet, ví Be24…RR6.
Ground-truth side đối chiếu Nansen: 32miPz Sell CATE, 3s6s8i Buy CATE, N3DHJV Sell MSFTx.

T9 (plan gmgn-parity-fixes): classify() route-level đã bị xoá ở T4; detector giờ
là detect_swaps — 1 event = 1 BƯỚC swap qua 1 pool, qty = GROSS leg LUÔN DƯƠNG.
Map nhãn cũ → step mới (mọi số soát TAY theo leg raw/dec trên chain):
  32miPz route SELL CATE -9733.622581  → step 2/2 SELL CATE 9733.622581 (gross +)
  32miPz netΔ  SELL ETAC -11562737.38  → step 1/2 SELL ETAC (leg raw=11562737379190 dec6)
  3s6s8i route BUY  CATE 19770.901779  → step 1/4 BUY CATE (raw=19770901779 dec6)
  3s6s8i netΔ  BUY  ETAC 46147370.817  → step 4/4 BUY ETAC (raw=46147370817002 dec6)
  N3DHJV netΔ  SELL NINJACAT           → step 1/3 (raw=9385021844639 dec6)
  N3DHJV route SELL MSFTx -1.65170136  → TỔNG step 2/3 + 3/3:
    0.56554254 (raw=56554254 dec8, whirl J1D1y41Y) +
    1.08615882 (raw=108615882 dec8, CAMM D6bRhQUc) = 1.65170136 ✓ khớp net cũ
Check bị XOÁ (không map được, không invented số thay thế):
  - "route NOT set" trên event netΔ: key 'route' không còn trong model —
    step/n_steps thay thế; assertion trên key đã biến mất là vô nghĩa.
  - Nhãn route-level gộp net: model per-step không còn event gộp; tổng MSFTx
    ở trên chứng minh per-step ⇒ đúng net cũ, không cần row riêng.
Check GIỮ (adapt):
  - N3DHJV không có event mint==USDC: USDC chỉ là QUOTE (pair MSFTx/USDC);
    leg USDC/SOL của goonuddt bị REJECT major-major (cả 2 ∈ TIER_A).
  - no_etac: nhánh `if not targets:` của classify đã biến mất, nhưng claim
    tương đương còn nguyên giá trị — detect_swaps đọc leg instruction-level,
    KHÔNG cần pre/postTokenBalances diff; strip row ETAC của ví ⇒ steps
    3s6s8i phải Y HỆT bản gốc (đã verify: 4/4 step trùng khớp).
Chỉ detect ví WALLET (có mặt trong tx — đúng path production _handle_tx).
Leg table đầy đủ + trace reject: .omo/evidence/gmgn-parity-fixes/T9.log
"""

import copy
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

WALLET = "Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6"
ETAC = "DhM9xy8gQzZmjoCyyCNPn57nMPPBGgXxj6rXtJnpump"
CATE = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump"
NINJACAT = "Du12R6ZESJrfC6VDcqVwQjLyw6AbA39VW9NZhjTzSTNK"
MSFTX = "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
WSOL = ww.WSOL


def _seed(ww):
    """Seed cache hermetic (không DexScreener/getTokenSupply); min_usd=0.0 —
    filter giá không được làm rơi step của regression."""
    ww._sol_px["v"] = 100.0
    ww.min_usd = 0.0
    mints = {
        ETAC: ("ETAC", 1e-4),
        CATE: ("CATE", 0.05),
        NINJACAT: ("NINJACAT", 1e-6),
        MSFTX: ("MSFTx", 4.0),  # decimals=8 on-chain (getTokenSupply)
    }
    for m, ts in mints.items():
        ww._info[m] = ts
        ww._supply[m] = 1e9  # không phải NFT supply=1


_seed(ww)

txs = pickle.load(open(os.path.join(HERE, "fixtures", "route_txs.pkl"), "rb"))
assert sorted(txs) == ["32miPz", "3s6s8i", "N3DHJV"], f"fixture lạ: {sorted(txs)}"
EVENTS = {lbl: ww.detect_swaps(tx, WALLET) for lbl, tx in txs.items()}

# (step, n_steps, side, mint, qty_gross, quote_mint, quote_qty) — soát tay theo leg
EXPECTED = {
    "32miPz": [
        (1, 2, "SELL", ETAC, 11562737.37919, CATE, 9733.622581),
        (2, 2, "SELL", CATE, 9733.622581, WSOL, 7.431563015),
    ],
    "3s6s8i": [
        (1, 4, "BUY", CATE, 19770.901779, WSOL, 14.97005982),
        (2, 4, "SELL", CATE, 90.343227, WSOL, 0.003735045),
        (3, 4, "SELL", CATE, 90.343226, WSOL, 0.003735045),
        (4, 4, "BUY", ETAC, 46147370.817002, CATE, 570.588796),
    ],
    "N3DHJV": [
        (1, 3, "SELL", NINJACAT, 9385021.844639, MSFTX, 1.65170136),
        (2, 3, "SELL", MSFTX, 0.56554254, USDC, 280.365138),
        (3, 3, "SELL", MSFTX, 1.08615882, USDC, 538.668938),
    ],
}

fail = 0
total = 0


def check(cond, msg):
    global fail, total
    total += 1
    print(("PASS" if cond else "FAIL"), msg)
    fail += not cond


def qty_ok(got, want):
    return abs(got - want) <= max(1e-4, abs(want) * 1e-6)


def tuples_of(events):
    return sorted(
        (
            e["step"],
            e["n_steps"],
            e["side"],
            e["mint"],
            round(e["qty"], 6),
            e["quote_mint"],
            round(e["quote_qty"], 6),
        )
        for e in events
    )


for label, want in EXPECTED.items():
    got = tuples_of(EVENTS[label])
    for i, w in enumerate(sorted(want, key=lambda t: (t[1], t[0]))):
        g = got[i] if i < len(got) else None
        ok = (
            g is not None
            and g[:4] == w[:4]
            and g[5] == w[5]
            and qty_ok(g[4], w[4])
            and qty_ok(g[6], w[6])
        )
        name = {ETAC: "ETAC", CATE: "CATE", NINJACAT: "NINJACAT", MSFTX: "MSFTx"}[w[3]]
        check(
            ok,
            f"{label} step {w[0]}/{w[1]} {w[2]:<4} {name:<8} qty≈{w[4]:,.6f}"
            f" ← quote {w[6]:,.6f}",
        )
    check(len(got) == len(want), f"{label} đủ {len(want)}/{len(got)} step, không thừa")

# tổng 2 step MSFTx SELL == net route-level cũ (1.65170136) — chứng minh
# per-step không mất token so với nhãn gộp của classify.
msft_sells = [e for e in EVENTS["N3DHJV"] if e["mint"] == MSFTX and e["side"] == "SELL"]
check(
    qty_ok(sum(e["qty"] for e in msft_sells), 1.65170136),
    "N3DHJV Σ MSFTx SELL steps = 1.65170136 (= net route cũ)",
)
check(
    not any(e["mint"] == USDC for e in EVENTS["N3DHJV"]),
    "N3DHJV không có event mint==USDC (USDC chỉ là quote; USDC/SOL reject major-major)",
)

# no_etac: detect_swaps không đọc pre/postTokenBalances diff — strip row ETAC
# của ví ⇒ steps phải y hệt bản gốc (thay cho check `if not targets:` cũ).
no_etac = copy.deepcopy(txs["3s6s8i"])
for which in ("preTokenBalances", "postTokenBalances"):
    no_etac["meta"][which] = [
        t
        for t in no_etac["meta"].get(which) or []
        if not (t.get("owner") == WALLET and t.get("mint") == ETAC)
    ]
check(
    tuples_of(ww.detect_swaps(no_etac, WALLET)) == tuples_of(EVENTS["3s6s8i"]),
    "3s6s8i* strip balance-row ETAC: steps y hệt (per-leg, không cần balance diff)",
)

route = [
    {
        "mint": "GOm",
        "quote_mint": USDC,
        "qty": 1075596.9,
        "quote_qty": 1540.05,
        "quote_usd": 1540.05,
    },
    {
        "mint": "TOKm",
        "quote_mint": "GOm",
        "qty": 12802199.0,
        "quote_qty": 1075596.9,
        "quote_usd": 7765.81,
    },
]
ww._reprice_route_legs(route, ww.TIER_A | ww.TIER_B)
check(
    route[1]["quote_usd"] == 1540.05,
    "leg TOKm quote GOm lấy USD theo leg GOm/USDC cùng khối (id 3618)",
)
route[1]["quote_qty"], route[1]["quote_usd"] = 999.0, 7765.81
ww._reprice_route_legs(route, ww.TIER_A | ww.TIER_B)
check(route[1]["quote_usd"] == 7765.81, "khối GOm lệch qty ⇒ KHÔNG lấy giá leg khác")

# Parcel bị CHIA qua nhiều leg (prod id=4289 GOCAT→GO): 347.075 GO bán ra SOL bằng
# 2 leg (260306.397518 + 86768.799173 = 347075.196691) = $213,21 + $71,37, nhưng
# leg quote-GO giữ giá DexScreener $1.778,07 (lệch 6,25×) — phải cộng dồn theo chain.
split = [
    {
        "mint": "GOCATm",
        "quote_mint": "GOm",
        "qty": 9352670.8096,
        "quote_qty": 347075.196691,
        "quote_usd": 1778.0662,
    },
    {
        "mint": "GOm",
        "quote_mint": ww.WSOL,
        "qty": 260306.397518,
        "quote_qty": 1.835996149,
        "quote_usd": 213.2142,
    },
    {
        "mint": "GOm",
        "quote_mint": ww.WSOL,
        "qty": 86768.799173,
        "quote_qty": 0.614606758,
        "quote_usd": 71.3743,
    },
]
ww._reprice_route_legs(split, ww.TIER_A | ww.TIER_B)
check(
    abs(float(split[0]["quote_usd"]) - (213.2142 + 71.3743)) < 1e-6,
    "parcel GOm chia 2 leg SOL ⇒ cộng dồn USD (id 4289, hết lệch 6,25×)",
)

assert fail == 0, f"{fail} check sai"
print(f"OK: per-step route detection {total - fail}/{total}")
