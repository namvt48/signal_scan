"""Replay tx THẬT trên prod qua detector CŨ (`wallet_watch.py`) vs MỚI
(`wallet_watch_ruleA.py`). READ-ONLY: chỉ getTransaction + sqlite select.

Chạy: cd /opt/wallet-watch && venv/bin/python ruleA_real_regress.py [N_window]
"""

import importlib.util
import json
import re
import sqlite3
import sys
import time
import urllib.request

DB = "/root/signal_scan/data/signal_scan.db"
API = "http://127.0.0.1:8124"
N_WIN = int(sys.argv[1]) if len(sys.argv) > 1 else 15
MAX_SIGS = int(sys.argv[2]) if len(sys.argv) > 2 else 400


def load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    assert s and s.loader
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


old = load("ww_old", "/opt/wallet-watch/wallet_watch.py")
new = load("ww_new", "/opt/wallet-watch/wallet_watch_ruleA.py")
# publicnode đã prune tx cũ (result:null) và rpc() KHÔNG xoay endpoint khi null ⇒
# ép endpoint còn đủ history, nếu không mọi tx >2 ngày đọc thành "not found".
for m in (old, new):
    m._sol_px["v"] = 0.0
    setattr(m, "min_usd", 0.0)
    setattr(m, "RPCS", ["https://api.mainnet-beta.solana.com"])


def fetch(sig, tries=6):
    """RPC công cộng hay trả rỗng/403 — thử lại + xoay endpoint."""
    for i in range(tries):
        try:
            tx = new.rpc(
                "getTransaction",
                [
                    sig,
                    {
                        "encoding": "jsonParsed",
                        "maxSupportedTransactionVersion": 0,
                        "commitment": "confirmed",
                    },
                ],
            )
            if tx:
                return tx
        except Exception:
            pass
        time.sleep(0.4 * (i + 1))
    return None


def target(mod, tx, w):
    evs = mod.detect_swaps(tx, w)
    return mod._target_event(tx, w, evs), evs


NOTE = re.compile(r"auto:(BUY|SELL) by (\S+) (\S+)$")

print("=== A. tracked_cas auto rows (CA đã post thật) ===")
c = sqlite3.connect(DB)
rows = c.execute(
    "select address,note from tracked_cas where note like 'auto:%' order by id"
).fetchall()
print(f"rows={len(rows)}")
A = {"same": 0, "ruleA_fix": 0, "other_change": 0, "fetch_fail": 0, "no_target": 0}
for addr, note in rows:
    m = NOTE.search(note.strip())
    if not m:
        print("  SKIP unparsed:", note[:80])
        continue
    side, wallet, sig = m.groups()
    try:
        tx = fetch(sig)
    except Exception as exc:
        A["fetch_fail"] += 1
        print(f"  FETCH FAIL {sig[:10]} {exc}")
        continue
    if not tx:
        A["fetch_fail"] += 1
        print(f"  FETCH EMPTY {sig[:10]}")
        continue
    evs = new.detect_swaps(tx, wallet)
    t_old, _ = target(old, tx, wallet)
    t_new, _ = target(new, tx, wallet)
    o = (t_old or {}).get("mint")
    n = (t_new or {}).get("mint")
    sg = wallet in new._signer_keys(tx)
    same_as_ca = n == addr
    if n is None:
        A["no_target"] += 1
    elif n == o:
        A["same"] += 1
    elif same_as_ca:
        A["ruleA_fix"] += 1
    else:
        A["other_change"] += 1
    flag = "OK " if same_as_ca else "CHG"
    print(
        f"  {flag} {sig[:10]} {wallet[:8]} signs={sg} evs={len(evs)} "
        f"ca={addr[:8]}({side}) old={str(o)[:8]} new={str(n)[:8]} same_as_ca={same_as_ca}"
    )
    time.sleep(0.12)

print("\n=== B. events.jsonl — ví đang track, N sig mới nhất/ví ===")
wallets = {
    w["address"]: w.get("name", "")
    for w in json.load(urllib.request.urlopen(f"{API}/api/wallets", timeout=10))
}
per = {}
for ln in open("/opt/wallet-watch/events.jsonl"):
    try:
        e = json.loads(ln)
    except Exception:
        continue
    w = e.get("wallet")
    if w in wallets:
        per.setdefault(w, []).append(e["sig"])
sigs = []
for w, ss in per.items():
    seen, uniq = set(), []
    for s in reversed(ss):
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    sigs += uniq[:N_WIN]
sigs = sigs[:MAX_SIGS]
print(f"wallets={len(wallets)} candidate_sigs={len(sigs)} (cap {MAX_SIGS})")

B = {"pairs": 0, "diff": 0, "fetch_fail": 0, "evs_zero": 0}
for sig in sigs:
    try:
        tx = fetch(sig)
    except Exception as exc:
        B["fetch_fail"] += 1
        print(f"  FETCH FAIL {sig[:10]} {exc}")
        continue
    if not tx:
        B["fetch_fail"] += 1
        continue
    keys = {ak["pubkey"] for ak in tx["transaction"]["message"]["accountKeys"]}
    for w in [a for a in wallets if a in keys]:
        evs = new.detect_swaps(tx, w)
        if not evs:
            B["evs_zero"] += 1
            continue
        B["pairs"] += 1
        o = (old._target_event(tx, w, evs) or {}).get("mint")
        n = (new._target_event(tx, w, evs) or {}).get("mint")
        if o != n:
            B["diff"] += 1
            net = new._net_owner(tx, w)
            print(
                f"  DIFF {sig[:10]} {wallets[w][:10]} signs={w in new._signer_keys(tx)} "
                f"old={str(o)[:8]} new={str(n)[:8]} "
                f"sold={[k[:6] for k, v in net.items() if v < 0]}"
            )
    time.sleep(0.12)

print("\n=== SUMMARY ===")
print("A tracked_cas :", json.dumps(A, ensure_ascii=False))
print("B window      :", json.dumps(B, ensure_ascii=False))
