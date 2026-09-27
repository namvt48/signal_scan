#!/usr/bin/env python3
"""Lịch sử trade 1 ví từ wallet_watch.detect_swaps -> bảng lệnh đã gộp.

3 tầng:
  1. scan   : getSignaturesForAddress + getTransaction  -> cache tx JSONL (cần mạng)
  2. detect : wallet_watch.detect_swaps                 -> cache event JSON (cần DexScreener để có symbol/USD)
  3. report : tách chain (lệnh route qua token trung gian) + gộp lệnh cùng tx cùng symbol -> bảng (offline)

Dùng:
  python3 scripts/wallet_hist.py --wallet <ADDR>              # có cache thì chỉ chạy tầng 3
  python3 scripts/wallet_hist.py --wallet <ADDR> --days 5 --scan   # quét lại từ chain

ponytail: gộp theo (tx, side, symbol) — 1 tx bán cùng 1 token bằng nhiều route = 1 dòng.
          Nhiều quote khác nhau (SOL + USDC) thì liệt kê từng phần ở cột TRẢ/NHẬN.
"""

import argparse
import collections
import csv
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wallet_watch as ww  # noqa: E402

ICT = datetime.timezone(datetime.timedelta(hours=7))
BASE_MINTS = {ww.WSOL: "SOL", ww.USDC: "USDC"}
if getattr(ww, "USDT", None):
    BASE_MINTS[ww.USDT] = "USDT"
EVENTS = "/tmp/ww_events.json"
TXS = "/tmp/ww_txs.jsonl"
RPC_OK = (
    "https://api.mainnet-beta.solana.com"  # publicnode trả history cụt, không báo lỗi
)


def scan(wallet, days, rpc=None):
    """Tầng 1+2: kéo tx trong `days` ngày rồi chạy detect_swaps."""
    if rpc:
        ww.RPCS = [rpc]
    ww.sol_price()
    cut = time.time() - days * 86400
    before, sigs = None, []
    while True:
        p = {"limit": 1000}
        if before:
            p["before"] = before
        batch = ww.rpc("getSignaturesForAddress", [wallet, p]) or []
        if not batch:
            break
        sigs.extend(batch)
        before = batch[-1]["signature"]
        if (batch[-1].get("blockTime") or 0) < cut:
            break
        time.sleep(0.2)
    win = [s for s in sigs if (s.get("blockTime") or 0) >= cut and s.get("err") is None]
    print(f"# {len(sigs)} sig -> {len(win)} tx trong {days} ngày", file=sys.stderr)

    events = []
    with open(TXS, "a") as cache:
        for i, s in enumerate(win, 1):
            tx = ww.rpc(
                "getTransaction",
                [
                    s["signature"],
                    {
                        "encoding": "jsonParsed",
                        "maxSupportedTransactionVersion": 1,
                        "commitment": "confirmed",
                    },
                ],
            )
            if not tx:
                continue
            cache.write(json.dumps({"sig": s["signature"], "tx": tx}) + "\n")
            for e in ww.detect_swaps(tx, wallet):
                e["_bt"] = tx.get("blockTime") or 0
                events.append(e)
            if i % 50 == 0:
                print(f"  .. {i}/{len(win)}", file=sys.stderr)
    json.dump(events, open(EVENTS, "w"), indent=1)
    return events


def chain(evs):
    """Gom theo từng tx: token vừa mua vừa bán trong cùng tx là chặng trung gian -> gộp vào
    lệnh terminal. USD = tổng dòng token gốc của cả tx, nên chặng hop không bị đếm hai lần."""
    out = []
    by_sig = collections.defaultdict(list)
    for e in evs:
        by_sig[e["sig"]].append(e)
    for sig, g in by_sig.items():
        g.sort(key=lambda e: e["step"])
        inter = {e["mint"] for e in g} & {e["quote_mint"] for e in g}
        term = [e for e in g if e["mint"] not in inter]
        if not term:
            continue
        parts, base = collections.Counter(), 0.0
        for e in g:
            sym = BASE_MINTS.get(e["quote_mint"])
            if sym:
                parts[sym] += e["quote_qty"]
                base += e["quote_usd"]
        grp = collections.OrderedDict()
        for e in term:
            grp.setdefault((e["side"], e["mint"]), []).append(e)
        for (side, _mint), es in grp.items():
            own_parts, own_usd = collections.Counter(), 0.0
            all_parts, all_usd = collections.Counter(), 0.0
            for x in es:
                all_parts[x.get("quote_sym") or x["quote_mint"][:6]] += x["quote_qty"]
                all_usd += x["quote_usd"]
                sym = BASE_MINTS.get(x["quote_mint"])
                if sym:
                    own_parts[sym] += x["quote_qty"]
                    own_usd += x["quote_usd"]
            if len(grp) == 1 and base:
                p, usd = collections.Counter(parts), base
            elif own_usd:
                p, usd = own_parts, own_usd
            else:  # tx không có chặng token gốc (vd quote bằng WBTC) -> dùng quote cuối
                p, usd = all_parts, all_usd
            out.append(
                dict(
                    bt=g[0]["_bt"],
                    sig=sig,
                    side=side,
                    sym=es[-1]["sym"],
                    qty=sum(x["qty"] for x in es),
                    parts=p,
                    usd=usd,
                    legs=len(g),
                )
            )
    return out


def merge(trades):
    """Gộp lệnh cùng tx, cùng side, cùng symbol (nhiều route trong 1 tx)."""
    agg = collections.OrderedDict()
    for t in sorted(trades, key=lambda r: r["bt"]):
        k = (t["sig"], t["side"], t["sym"])
        if k in agg:
            a = agg[k]
            a["qty"] += t["qty"]
            a["parts"] += t["parts"]
            a["usd"] += t["usd"]
            a["legs"] += t["legs"]
        else:
            agg[k] = dict(t)
    return list(agg.values())


def report(rows, wallet, days, out_md, out_csv):
    rows = sorted(rows, key=lambda r: r["bt"])
    for i, r in enumerate(rows, 1):
        r["i"] = i
    head = [
        f"# Ví {wallet} — lệnh {days} ngày (giờ ICT)",
        f"# nguồn: scripts/wallet_watch.py detect_swaps | {len(rows)} lệnh",
        "",
        "| # | TIME (UTC+7) | TYPE | TICKER | AMOUNT | TRẢ/NHẬN | USD | chặng | TX |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        paid = " + ".join(f"{s} {q:,.6f}" for s, q in sorted(r["parts"].items()))
        head.append(
            f"| {r['i']} | {datetime.datetime.fromtimestamp(r['bt'], ICT).strftime('%Y-%m-%d %H:%M:%S')}"
            f" | {r['side']} | {r['sym']} | {r['qty']:,.6f} | {paid} | ${r['usd']:,.2f}"
            f" | {r['legs']} | [{r['sig'][:6]}](https://solscan.io/tx/{r['sig']}) |"
        )
    buys = [r for r in rows if r["side"] == "BUY"]
    sells = [r for r in rows if r["side"] == "SELL"]
    vol = collections.Counter()
    for r in rows:
        vol[r["sym"]] += r["usd"]
    head += [
        "",
        f"**{len(rows)} lệnh** — {len(buys)} BUY (${sum(r['usd'] for r in buys):,.0f})"
        f" / {len(sells)} SELL (${sum(r['usd'] for r in sells):,.0f}) | {len(vol)} token",
        "",
        "Volume theo token: "
        + ", ".join(f"{k} ${v:,.0f}" for k, v in vol.most_common(8)),
    ]
    open(out_md, "w").write("\n".join(head) + "\n")
    with open(out_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "time_ict",
                "type",
                "ticker",
                "amount",
                "quote",
                "quote_amount",
                "usd",
                "legs",
                "tx",
            ]
        )
        for r in rows:
            for sym, q in sorted(r["parts"].items()):
                w.writerow(
                    [
                        datetime.datetime.fromtimestamp(r["bt"], ICT).strftime(
                            "%Y-%m-%d %H:%M:%S"
                        ),
                        r["side"],
                        r["sym"],
                        r["qty"],
                        sym,
                        q,
                        round(r["usd"], 2),
                        r["legs"],
                        r["sig"],
                    ]
                )
    return head


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--wallet", required=True)
    ap.add_argument("--days", type=int, default=5)
    ap.add_argument(
        "--scan", action="store_true", help="quét lại từ chain (mặc định: dùng cache)"
    )
    ap.add_argument("--rpc", default=RPC_OK)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    if a.scan or not os.path.exists(EVENTS):
        evs = scan(a.wallet, a.days, a.rpc)
    else:
        evs = json.load(open(EVENTS))
        print(f"# cache {EVENTS}: {len(evs)} swap-event", file=sys.stderr)
    rows = merge(chain(evs))
    out = a.out or f"evidence/wallet_hist_{a.wallet[:6]}_{a.days}d"
    print("\n".join(report(rows, a.wallet, a.days, out + ".md", out + "_trades.csv")))
