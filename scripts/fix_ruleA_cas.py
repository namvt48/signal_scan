"""Sửa `tracked_cas` theo rule A: CA = token ĐÍCH của trader.

- 4VPQRwNB → MARINE, 3Vdkaok → ZINC, 3TMJokHcv2 → KNOTS  (UPDATE address)
- 2XesETyv4k, BQ9F3CpgFZ → không có đích ⇒ DELETE
Dry-run mặc định; `--apply` mới ghi. Luôn backup DB trước khi ghi.
"""

import importlib.util
import re
import shutil
import sqlite3
import sys
import time

DB = "/root/signal_scan/data/signal_scan.db"
APPLY = "--apply" in sys.argv

s = importlib.util.spec_from_file_location("ww", "/opt/wallet-watch/wallet_watch.py")
assert s and s.loader
ww = importlib.util.module_from_spec(s)
s.loader.exec_module(ww)
setattr(ww, "RPCS", ["https://api.mainnet-beta.solana.com"])
setattr(ww, "min_usd", 0.0)

NOTE = re.compile(r"auto:(BUY|SELL) by (\S+) (\S+)$")
PLAN = {
    "2XesETyv4k": "delete",
    "3TMJokHcv2": "replace",
    "4VPQRwNBKU": "replace",
    "3Vdkaok7kF": "replace",
    "BQ9F3CpgFZ": "delete",
}


def fetch(sig):
    for i in range(5):
        tx = ww.rpc(
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
        time.sleep(0.5 * (i + 1))
    return None


c = sqlite3.connect(DB)
rows = c.execute(
    "select id,address,note,entry_usd from tracked_cas where note like 'auto:%'"
).fetchall()
todo = []
for rid, addr, note, entry in rows:
    m = NOTE.search(note.strip())
    if not m:
        continue
    side, wallet, sig = m.groups()
    act = PLAN.get(sig[:10])
    if not act:
        continue
    tx = fetch(sig)
    if not tx:
        print(f"SKIP {sig[:10]} fetch fail")
        continue
    ww._warm_prices(tx)
    evs = ww.detect_swaps(tx, wallet)
    tgt = ww._target_event(tx, wallet, evs)
    body = ww.track_post_body(tgt) if tgt else None
    todo.append((act, rid, addr, note, sig, wallet, body))

print(f"rows auto={len(rows)} todo={len(todo)}\n")
for act, rid, addr, note, sig, wallet, body in todo:
    new = (body or {}).get("address")
    usd = (body or {}).get("usd")
    cl = (
        c.execute(
            "select id from tracked_cas where address=? and chain='sol'", (new,)
        ).fetchone()
        if new
        else None
    )
    print(
        f"{act:8} {sig[:10]} {addr[:10]} -> {str(new)[:12]} usd={usd} "
        f"collision={cl[0][:8] if cl else None}"
    )
    if body:
        print(f"         note: {body['note']}")

if not APPLY:
    print("\nDRY-RUN — thêm --apply để ghi")
    raise SystemExit(0)

bak = f"{DB}.bak.preRuleA.{time.strftime('%Y%m%dT%H%M%S')}"
shutil.copy2(DB, bak)
print(f"\nBACKUP {bak}")
res = {"updated": 0, "deleted": 0, "skipped": 0}
for act, rid, addr, note, sig, wallet, body in todo:
    new = (body or {}).get("address")
    usd = (body or {}).get("usd")
    new_note = (body or {}).get("note")
    if act == "replace" and body:
        if c.execute(
            "select 1 from tracked_cas where address=? and chain='sol'", (new,)
        ).fetchone():
            c.execute("delete from tracked_cas where id=?", (rid,))
            res["deleted"] += 1
            print(f"  del (collision) {addr[:10]}")
            continue
        c.execute(
            "update tracked_cas set address=?, note=?, entry_usd=? where id=?",
            (new, new_note, usd, rid),
        )
        res["updated"] += 1
        print(f"  upd {addr[:10]} -> {str(new)[:12]}")
    else:
        c.execute("delete from tracked_cas where id=?", (rid,))
        res["deleted"] += 1
        print(f"  del {addr[:10]} ({sig[:10]})")
c.commit()
print("RESULT", res)
print(
    "auto rows còn lại:",
    c.execute("select count(*) from tracked_cas where note like 'auto:%'").fetchone()[
        0
    ],
)
for r in c.execute(
    "select address,substr(note,1,44) from tracked_cas where note like 'auto:%' order by id"
):
    print("   ", r[0][:12], r[1])
