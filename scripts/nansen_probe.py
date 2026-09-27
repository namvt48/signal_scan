#!/usr/bin/env python3
"""Nansen app-question probe — tính 3 chỉ số dashboard signal_scan từ cửa free
(0 credit), kèm chi tiết từng thành phần.

  Fresh 14.370%          <- tgm-holders-gini-stats  data[0].freshWalletBalancePercent (0-1) x 100
  T100 down 46.609% x1.873
                         <- tgm-holders-hourly-stats, label=top_100_holders,
                            excludeExchanges=false, window = deployed_at-3d -> NOW
                            (đúng poller genesisT100). A = row anchor (rule v6
                            — plateau carry h=0 phu ngay dep; pick_anchor),
                            B = min(total) từ anchor,
                            pct=(A-B)/A*100, multiple=A/B.
  LF 222.483M            <- rule v5 (user 09/10): gia tri series label='exchange'
                            TAI DUNG DATE cua row anchor T100 (khong phai row dau,
                            khong phai top-100). Ref hover tab=exchanges: KIWI
                            222.448M @ 09-04, CONK 208.428M @ 08-21. Probe match
                            ts phu (exact), fallback cung UTC date (userspec
                            'cung date'). chartEx window = CUNG window chart
                            (dep-back..now) — hai series degrade giong het nhau.
                            Luu y: replay token gia drift vai % (re-select cohort
                            as-of NOW); poller live capture = dung 100%.

CF 403: app.nansen.ai chắn Cloudflare. Duong LOCAL (khong can cookie/UA thu cong):
  docker run -d --name nansen-chrome -p 3000:3000 browserless/chrome:1.61-chrome-stable
  python3 scripts/nansen_probe.py --file scripts/ca_list.txt --local --q cards

Local direct không flag (urllib) cần cookie + UA của browser đang mở app.nansen.ai
trên máy này (cf_clearance binds UA+IP): F12 -> Network -> POST /api/questions/* ->
copy 2 header, rồi NANSEN_APP_COOKIE='...' NANSEN_UA='...' python3 ...

usage: nansen_probe.py (<CA> | --file ca_list.txt) [--chain sol|bsc|eth|base]
       [--dep ms|ISO] [--back 3] [--rows 40]
        [--q all|cards|chart,chartex,gini,essential,volume,change,balances]
       [--local] [--raw]
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE = "https://app.nansen.ai/api/questions"
KEY_OF = {
    "tgm-essential-data": "essential",
    "tgm-holders-hourly-stats": "chart",
    "tgm-holders-gini-stats": "gini",
    "tgm-volume-details": "volume",
    "tgm-holders-change": "change",
    "tgm-holders-balances": "balances",
}
UA = os.environ.get(
    "NANSEN_UA",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
)
CHAIN = {
    "bsc": "bsc",
    "sol": "solana",
    "eth": "ethereum",
    "base": "base",
    "solana": "solana",
    "ethereum": "ethereum",
}

_pre = {}
_local = False


def post(name, parameters, pagination=True, bundle_key=None):
    key = bundle_key or KEY_OF[name]
    if _local:
        r = _pre.get(key) or {}
        return r.get("status"), r.get("json")
    body = {"parameters": parameters, "filters": {}, "order": {"order": "desc"}}
    if pagination:
        body["pagination"] = {"page": 1, "recordsPerPage": 100}
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": UA,
    }
    if os.environ.get("NANSEN_APP_COOKIE"):
        headers["Cookie"] = os.environ["NANSEN_APP_COOKIE"]
    req = urllib.request.Request(
        f"{BASE}/{name}", data=json.dumps(body).encode(), headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None


SIDECAR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "server",
    "scripts",
    "nansen-sidecar.mjs",
)


def local_bundles(rows, chain, back, want):
    """Moi CA trong MOT lan goi node sidecar: 1 process, 1 trang Chrome da
    clear CF dung chung. Tra {ca: bundle} (essential/chart/gini/... + dep)."""
    stdin = "".join(f"{ca} {dep_ms(dep) or 0}\n" for ca, dep in rows)
    # stderr=None -> log tien do cua sidecar chay thang ra terminal (truyen ca
    # qua 2>&1). Chi stdout la JSON pipe ve python.
    p = subprocess.run(
        ["node", SIDECAR, chain, str(back), ",".join(sorted(want))],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        timeout=30 * len(rows) + 120,
    )
    if p.returncode != 0:
        raise RuntimeError(
            f"sidecar fail (exit {p.returncode}): {p.stdout[:300]} "
            "| docker run -d --name nansen-chrome -p 3000:3000 "
            "browserless/chrome:1.61-chrome-stable"
        )
    out = {}
    for ln in p.stdout.splitlines():
        ln = ln.strip()
        if ln.startswith("{"):
            j = json.loads(ln)
            out[j.pop("ca")] = j
    return out


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def dep_ms(s):
    if s is None:
        return None
    s = str(s)
    return (
        int(s)
        if s.isdigit()
        else int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    )


def compact(v):
    for u, s in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(v) >= u:
            return f"{v / u:.3f}{s}"
    return f"{v:.3f}"


def lf_pick(ex, day_s):
    """Mirror exchangeAnchorLf (server/src/snapshot.ts): som earliest total>0
    row CUNG NGAY anchor; thieu -> total>0 gan nhat theo ngay (tie: som hon);
    tat ca 0/empty -> None (caller keep top-100 A)."""
    if not day_s:
        return None
    same = [x for x in ex if x[1][:10] == day_s and x[2] > 0]
    if same:
        return min(same, key=lambda x: x[0])
    pos = [x for x in ex if x[2] > 0]
    if not pos:
        return None
    a0 = date.fromisoformat(day_s)
    return min(pos, key=lambda x: (abs((date.fromisoformat(x[1][:10]) - a0).days), x[0]))


def pick_anchor(pts, dep, head_carry_ok=False):
    """v6 mirror t100Genesis (server/src/snapshot.ts): a FLAT h=0 carry covering
    the deploy day anchors A — price=0 stall hides pre-listing leak so the first
    LIVE row may already be post-leak (APP 352.854M h=0 08-11 vs live 123.831M;
    MVC/7XGq 165.299M 09-02 vs live 357.052M). A lone carry at the SERIES HEAD
    may be a plateau cut by the query window -> need_wide (caller refetches 1Y).
    Returns (anchor_idx, why, need_wide)."""
    live = next((i for i, p in enumerate(pts) if (p["holders"] or 0) > 0), None)
    dd = next((i for i, p in enumerate(pts) if p["at"] >= dep), None)
    has_h = any(p["holders"] is not None for p in pts)
    need_wide = False
    if has_h and dep:
        dep_day = datetime.fromtimestamp(dep / 1000, timezone.utc).strftime("%Y-%m-%d")
        ci = -1
        for i in range(len(pts) - 1, -1, -1):
            d = str(pts[i]["t"])[:10]
            if d > dep_day:
                continue
            if d < dep_day:
                break
            if (pts[i]["holders"] or 0) == 0 and pts[i]["total"] > 0:
                ci = i
                break
        if (ci < 0 and pts and pts[0]["holders"] == 0 and pts[0]["total"] > 0
                and str(pts[0]["t"])[:10] == (datetime.fromtimestamp(dep / 1000, timezone.utc)
                    + timedelta(days=1)).strftime("%Y-%m-%d")):
            ci = 0
        # v7: WALK BACK from ci while rows still carry the same h=0 value —
        # the OLDEST flat row is true genesis (GOY plateau 11-19 < dep 11-21).
        if ci >= 0 and pts[ci]["total"] > 0 and (pts[ci]["holders"] or 0) == 0:
            st_i = ci
            while (st_i > 0 and (pts[st_i - 1]["holders"] or 0) == 0
                   and pts[st_i - 1]["total"] == pts[ci]["total"]):
                st_i -= 1
            if st_i > 0:
                return st_i, "v7 plateau (hanh h=0, di ve dau plateau)", False
            if head_carry_ok:
                return 0, "v7 head-carry (wide window chap nhan)", False
            need_wide = True  # plateau cat ngay dau window -> fetch 1Y
    if live is not None:
        if dd is not None and dd < live and pts[dd]["total"] < pts[live]["total"]:
            return dd, "dd-carry (deploy-day row trước & nhỏ hơn first-live)", need_wide
        return live, "first-live (row đầu totalHolders>0)", need_wide
    if has_h:
        return max(dd or 0, 0), "all h=0 (degraded daily) -> deploy-day row", need_wide
    return 0, "legacy no-holders -> row đầu", need_wide


def run_one(a, ch, want):
    cards, dep = {}, dep_ms(a.dep)
    _a_ms = _a_t = None  # T100 anchor (ts, str) — LF v5 doc exchange cung date
    if _local and not dep:
        dep = _pre.get("dep")

    if "essential" in want or dep is None:
        st, j = post("tgm-essential-data", {"chain": ch, "tokenAddress": a.ca})
        r = ((j or {}).get("data") or [{}])[0]
        print(
            f"[essential] HTTP {st}  symbol={r.get('symbol')}  price={r.get('priceUsd5Min') or r.get('priceUsd')}  "
            f"mcap={r.get('marketCap')}  liq={r.get('totalLiquidityUsd')}  circ={r.get('circulatingSupply')}"
        )
        if r.get("deployedTimestamp"):
            print(f"  deployed_at = {r['deployedTimestamp']}")
            dep = dep or dep_ms(r["deployedTimestamp"])
        else:
            print("  deployed_at = MISSING (cần --dep)")

    if "chart" in want and not dep:
        sys.exit(
            "không có --dep và essential không trả deployedTimestamp -> không tính được T100/LF"
        )

    if "chart" in want:
        def chart_pts(back):
            if _local and back != a.back:  # window khac -> sidecar goi rieng
                b = (local_bundles([(a.ca, str(dep))], a.chain, back, {"chart"}).get(a.ca) or {}).get("chart") or {}
                st_b, j_b, win = b.get("status"), b.get("json"), f"dep-{back:g}d .. now"
            else:
                now_ms = datetime.now(timezone.utc).timestamp() * 1000
                fr, to = iso(max(dep - back * 864e5, now_ms - 364 * 864e5)), iso(now_ms)
                st_b, j_b = post(
                    "tgm-holders-hourly-stats",
                    {
                        "tokenAddress": a.ca,
                        "chain": ch,
                        "date": {"from": fr, "to": to},
                        "label": "top_100_holders",
                        "excludeExchanges": False,
                    },
                    pagination=False,
                )
                win = f"{fr} .. {to}"
            pts = []
            for r in (j_b or {}).get("data") or []:
                t, bal, hol = r.get("blockDate"), r.get("totalBalance"), r.get("totalHolders")
                if t and isinstance(bal, (int, float)):
                    pts.append(
                        {
                            "at": dep_ms(t),
                            "t": t,
                            "total": bal,
                            "holders": hol if isinstance(hol, (int, float)) else None,
                        }
                    )
            pts.sort(key=lambda p: p["at"])
            return st_b, pts, win

        st, pts, win = chart_pts(a.back)
        print(f"\n[t100] HTTP {st}  window [{win}]  rows={len(pts)}")
        if not pts:
            print("  series r\u1ed7ng (403? c\u1ea7n cookie/UA).")
            return cards
        live = next((i for i, p in enumerate(pts) if (p["holders"] or 0) > 0), None)
        anchor, why, need_wide = pick_anchor(pts, dep)
        if need_wide:  # v7: plateau cat dau window -> fetch rong (dep-30d, clamp 1Y)
            print(f"   needWide: fetch wide dep-30d phan tich dau plateau ({a.back:g}d window)")
            st2, pts2, win2 = chart_pts(30)
            if pts2:
                st, pts, win = st2, pts2, win2
                print(f"   wide rows={len(pts2)} st={st2} head={pts2[0]['t']} tail={pts2[-1]['t']}")
                live = next((i for i, p in enumerate(pts) if (p["holders"] or 0) > 0), None)
                anchor, why, _ = pick_anchor(pts, dep, head_carry_ok=True)
            else:
                print("   wide EMPTY (HTTP?/403) -> dung narrow, anchor co the bi cat")
        A = pts[anchor]["total"]
        _a_ms, _a_t = pts[anchor]["at"], str(pts[anchor]["t"])
        B = min((p["total"] for p in pts[anchor:]), default=A)
        bi = next(i for i, p in enumerate(pts[anchor:], anchor) if p["total"] == B)
        pct, mult = (A - B) / A * 100, A / B
        for i, p in enumerate(pts[: a.rows]):
            mark = (
                " <-ANCHOR(A)"
                if i == anchor
                else (
                    " <-TROUGH(B)"
                    if i == bi
                    else (" <-FIRST-LIVE" if i == live else "")
                )
            )
            print(f"   {p['t']}  bal={p['total']:,.3f}  h={p['holders']}{mark}")
        print(f"   anchor={why} @ {pts[anchor]['t']}")
        print(
            f"   A={A:,.3f}   B={B:,.3f} @ {pts[bi]['t']}   pct=(A-B)/A*100   multiple=A/B"
        )
        cards["T100"] = f"down {pct:.3f}%  x{mult:.3f}"

    if "chartex" in want and dep:
        fr, to = (
            iso(dep - a.back * 864e5),
            iso(datetime.now(timezone.utc).timestamp() * 1000),
        )
        st, j = post(
            "tgm-holders-hourly-stats",
            {
                "tokenAddress": a.ca,
                "chain": ch,
                "date": {"from": fr, "to": to},
                "label": "exchange",
                "excludeExchanges": False,
            },
            pagination=False,
            bundle_key="chartEx",
        )
        ex = sorted(
            (
                (
                    dep_ms(r["blockDate"]) or 0,
                    str(r["blockDate"]),
                    float(r["totalBalance"]),
                )
                for r in (j or {}).get("data") or []
                if r.get("blockDate")
                and isinstance(r.get("totalBalance"), (int, float))
            )
        )
        # LF v5+v7 (mirror exchangeAnchorLf): row exchange CUNG DATE anchor;
        # thieu -> row >0 GAN NHAT theo ngay (GOY: exchange = 0 toi 09-03);
        # tat ca = 0 -> keep top-100 A. Ref: KIWI 222.483M, CONK 168.363M.
        day = str(_a_t)[:10] if _a_t else None
        lf = lf_pick(ex, day)
        print(f"\n[LF/exchange] HTTP {st}  window [{fr} .. {to}]  rows={len(ex)}  anchorT={_a_t}")
        for p in ex[:3]:
            print(f"   {p[1]}  bal={p[2]:,.3f}{' <-LF' if p is lf else ''}")
        if lf:
            cards["LF"] = (
                compact(lf[2])
                + f"  (label=exchange @ {day or lf[1]} cung date anchor, genesis_bal)"
            )
        else:
            cards["LF"] = f"n/a (HTTP {st}, rows={len(ex)}, khong co row >0)"

    if "gini" in want:
        st, j = post("tgm-holders-gini-stats", {"tokenAddress": a.ca, "chain": ch})
        r = ((j or {}).get("data") or [{}])[0]
        f = r.get("freshWalletBalancePercent")
        print(
            f"\n[gini] HTTP {st}  freshWalletBalancePercent={f} (fraction x100 -> Fresh%)  "
            f"t100Pct={r.get('top100HoldersBalancePercent')}  holders={r.get('totalHolders')}  medianUsd={r.get('medianBalanceUsd')}"
        )
        if isinstance(f, (int, float)):
            cards["Fresh"] = f"{f * 100:.3f}%"

    for name, key, params in [
        (
            "tgm-volume-details",
            "volume",
            {"chain": ch, "tokenAddress": a.ca, "intervalSec": 86400},
        ),
        (
            "tgm-holders-change",
            "change",
            {"tokenAddress": a.ca, "chain": ch, "intervalSec": 86400},
        ),
        (
            "tgm-holders-balances",
            "balances",
            {
                "tokenAddress": a.ca,
                "chain": ch,
                "date": "week",
                "label": "top_100_holders",
                "excludeExchanges": False,
                "isStablecoin": False,
            },
        ),
    ]:
        if key not in want:
            continue
        st, j = post(name, params)
        data = (j or {}).get("data") or []
        print(f"\n[{key}] HTTP {st} rows={len(data)}")
        if a.raw:
            print(json.dumps(data[:5], indent=1)[:2000])
        elif key == "volume" and data:
            print(
                f"  buy={data[0].get('buyVolumeUsdRecent')} sell={data[0].get('sellVolumeUsdRecent')}"
            )
        elif key == "change" and data:
            print(f"  nofHoldersRecent(delta 24h)={data[0].get('nofHoldersRecent')}")
        elif key == "balances":
            for r in data[:8]:
                print(
                    f"  {(r.get('name') or r.get('entity') or str(r.get('address', ''))[:10]):<14} "
                    f"balUsd={r.get('balanceUsd')} pct={(r.get('percentOwnership') or 0) * 100:.2f}% chg24h={r.get('changeShortTimeframe')}"
                )

    print("\n=== CARDS " + a.ca[:8] + " (như dashboard /api/signals) ===")
    for k in ("Fresh", "T100", "LF"):
        if k in cards:
            print(f"  {k}: {cards[k]}")
    return cards


def main():
    global _pre, _local
    ap = argparse.ArgumentParser()
    ap.add_argument("ca", nargs="?", help="1 CA (bỏ trống khi dùng --file)")
    ap.add_argument(
        "--file", help="txt nhiều CA, mỗi dòng 1 CA (# = comment) — chạy lần lượt"
    )
    ap.add_argument("--chain", default="sol")
    ap.add_argument("--dep", help="listing time ms|ISO (mac dinh tu essential-data)")
    ap.add_argument(
        "--back", type=float, default=3, help="ngày series trước dep (poller dùng 3)"
    )
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--q", default="all")
    ap.add_argument(
        "--local",
        action="store_true",
        help="query qua Chrome sidecar local (ws://localhost:3000) — không ssh, không cookie",
    )
    ap.add_argument("--raw", action="store_true")
    a = ap.parse_args()
    ch = CHAIN.get(a.chain) or sys.exit(f"chain {a.chain}? {list(CHAIN)}")
    if bool(a.ca) == bool(a.file):
        sys.exit("chọn 1: <CA> hoặc --file ca_list.txt")
    rows = (
        [
            (t[0], t[1] if len(t) > 1 else None)
            for t in (ln.split("#")[0].split() for ln in open(a.file))
            if t
        ]
        if a.file
        else [(a.ca, a.dep)]
    )
    want = (
        {"chart", "chartex", "gini"}
        if a.q == "cards"
        else set(a.q.split(","))
        if a.q != "all"
        else {"essential", "chart", "chartex", "gini", "volume", "change", "balances"}
    )
    _local = bool(a.local)
    bundles = local_bundles(rows, a.chain, a.back, want) if _local else {}

    for i, (ca, row_dep) in enumerate(rows):
        a.ca = ca
        a.dep = row_dep
        _pre = {}
        if _local:
            _pre = bundles.get(ca) or {}
            if _pre.get("error"):
                print(
                    f"\n########## [{i + 1}/{len(rows)}] {ca} {_pre.get('symbol') or ''} — SIDECAR FAIL: {_pre['error']}"
                )
                continue
            print(
                f"\n########## [{i + 1}/{len(rows)}] {ca} {_pre.get('symbol') or ''} (local chrome, dep={_pre.get('dep') and iso(_pre['dep']) or a.dep and iso(dep_ms(a.dep))}) ##########"
            )
        else:
            print(f"\n########## [{i + 1}/{len(rows)}] {ca} ##########")
        run_one(a, ch, want)


if __name__ == "__main__":
    main()
