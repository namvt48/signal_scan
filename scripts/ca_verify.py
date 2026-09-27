#!/usr/bin/env python3
"""ca_verify.py — scan mọi CA trong DB signal_scan, phân loại VALID SPL mint / INVALID.

Dry-run mặc định (mở DB read-only). `--apply` backup WAL-safe (.bak.preCaVerify.<ts>,
sqlite online backup API) rồi xoá row INVALID khỏi tracked_cas + token_state trong
MỘT transaction. UNCERTAIN luôn được GIỮ, không bao giờ xoá. nansen_series không bị
xoá (chỉ báo cáo số row tham chiếu). Stdlib-only.

INVALID reasons: malformed | not_found | not_token_program | not_mint
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

DEFAULT_DB = "/root/signal_scan/data/signal_scan.db"
DEFAULT_RPC = "https://api.mainnet-beta.solana.com"
TOKEN_PROGRAMS = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # spl-token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  # token-2022
}
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BATCH = 100  # max pubkeys per getMultipleAccounts call


def b58_fits32(s):
    """Plausible solana pubkey: base58 alphabet, decoded value fits 32 bytes.
    Bỏ qua luật padding leading-'1'/zero-byte theo spec."""
    if not s or any(c not in B58 for c in s):
        return False
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    return 0 < n and n.bit_length() <= 256


def classify(addr, value):
    """value = account từ getMultipleAccounts jsonParsed (hoặc None).
    -> (status, reason), status: valid | invalid | uncertain (uncertain = KEEP)."""
    if not b58_fits32(addr):
        return "invalid", "malformed"
    if value is None:
        return "invalid", "not_found"
    if value.get("owner") not in TOKEN_PROGRAMS:
        return "invalid", "not_token_program"
    data = value.get("data")
    parsed = data.get("parsed") if isinstance(data, dict) else None
    ptype = parsed.get("type") if isinstance(parsed, dict) else None
    if ptype == "mint":
        return "valid", ""
    if ptype == "account":
        return "invalid", "not_mint"
    return (
        "uncertain",
        "unparseable_data",
    )  # owner là token program nhưng data lạ -> giữ


def _backoff(attempt):
    return min(2.0**attempt, 30)


def _rate_limited(msg):
    m = msg.lower()
    return "-32005" in m or "429" in m or "rate" in m or "too many requests" in m


def rpc_accounts(rpc, addrs, timeout=60):
    """getMultipleAccounts jsonParsed cho <=100 addr; retry exponential backoff
    khi HTTP 429 / JSON-RPC rate error (public RPC throttle ~1 call/sec)."""
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getMultipleAccounts",
            "params": [addrs, {"encoding": "jsonParsed"}],
        }
    ).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(
                rpc, data=payload, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                resp = json.loads(r.read())
            if "error" in resp:
                err = resp["error"]
                msg = f"{err.get('code')} {err.get('message', '')}"
                if _rate_limited(msg):
                    time.sleep(_backoff(attempt))
                    continue
                raise RuntimeError(f"rpc error: {msg}")
            return resp["result"]["value"]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(_backoff(attempt))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < 5:
                time.sleep(_backoff(attempt))
                continue
            raise
    raise RuntimeError("rpc rate-limited after 6 attempts")


def discover_state_table(conn):
    """Prefers token_state.ca, then token_state.mint, rồi bảng *token*state* khác
    (trừ wallet_*) có ca/mint. Không bịa bảng."""
    tables = [
        r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    ]
    ordered = [t for t in tables if t == "token_state"]
    ordered += [
        t
        for t in tables
        if "token" in t and "state" in t and not t.startswith("wallet")
    ]
    for t in ordered:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({t})")}
        for c in ("ca", "mint"):
            if c in cols:
                return t, c
    return None, None


def _addr_rows(conn, tbl, col):
    """[(addr, chain)] — chain default 'sol' nếu bảng không có cột chain."""
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({tbl})")}
    if "chain" in cols:
        return conn.execute(f"SELECT {col}, chain FROM {tbl}").fetchall()
    return [(a, "sol") for (a,) in conn.execute(f"SELECT {col} FROM {tbl}")]


def collect(conn, tbl, col):
    """addr -> {'tracked': bool, 'state': bool}. Chỉ chain='sol' (fail-safe:
    không verify chain khác qua solana RPC); đếm số row bỏ qua."""
    info, skipped = {}, 0
    for src_tbl, src_col, key in (
        ("tracked_cas", "address", "tracked"),
        (tbl, col, "state"),
    ):
        if not src_tbl:
            continue
        for addr, chain in _addr_rows(conn, src_tbl, src_col):
            if chain != "sol":
                skipped += 1
                continue
            info.setdefault(addr, {"tracked": False, "state": False})[key] = True
    return info, skipped


def selftest():
    """Offline classifier check — không network, không DB."""
    ok = "So11111111111111111111111111111111111111112"
    mint = {
        "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "data": {
            "parsed": {"type": "mint", "info": {"decimals": 6}},
            "program": "spl-token",
        },
    }
    acct = {
        "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "data": {"parsed": {"type": "account", "info": {}}, "program": "spl-token"},
    }
    sysacc = {"owner": "11111111111111111111111111111111", "data": [0, 0]}
    weird = {
        "owner": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "data": "unparseable",
    }
    cases = [
        ("valid mint", classify(ok, mint), ("valid", "")),
        ("nonexistent", classify(ok, None), ("invalid", "not_found")),
        ("token account", classify(ok, acct), ("invalid", "not_mint")),
        ("non-token program", classify(ok, sysacc), ("invalid", "not_token_program")),
        ("malformed", classify("0OIl-not-base58!", None), ("invalid", "malformed")),
        ("uncertain kept", classify(ok, weird), ("uncertain", "unparseable_data")),
    ]
    for name, got, want in cases:
        assert got == want, f"{name}: got {got}, want {want}"
        print(f"  ok  {name:<18} -> {got[0]}/{got[1] or '-'}")
    print(f"selftest: {len(cases)}/{len(cases)} passed")
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="Verify mọi CA trong DB là SPL mint hợp lệ; --apply xoá invalid."
    )
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--rpc", default=DEFAULT_RPC)
    ap.add_argument(
        "--apply",
        action="store_true",
        help="xoá row invalid (backup trước, dry-run nếu thiếu)",
    )
    ap.add_argument("--limit", type=int, default=0, help="chỉ verify N address đầu")
    ap.add_argument("--json-out")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    if args.apply:
        conn = sqlite3.connect(args.db)
    else:  # dry-run: read-only URI, không đụng file db/-wal/-shm
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    tbl, col = discover_state_table(conn)
    state_label = f"{tbl}.{col}" if tbl else "NOT FOUND"
    n_tracked = conn.execute("SELECT COUNT(*) FROM tracked_cas").fetchone()[0]
    n_state = conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0] if tbl else 0
    print(f"db={args.db} (apply={args.apply})  rpc={args.rpc}")
    print(f"state table used: {state_label}")
    print(f"tracked_cas={n_tracked}  {tbl or 'token_state'}={n_state}")

    info, skipped = collect(conn, tbl, col)
    addrs = sorted(info)
    total = len(addrs)
    if args.limit:
        addrs = addrs[: args.limit]
    if skipped:
        print(f"skipped {skipped} non-sol row(s) — kept")
    print(f"distinct addresses: {total}, verifying: {len(addrs)}")

    results = {a: ("invalid", "malformed") for a in addrs if not b58_fits32(a)}
    todo = [a for a in addrs if a not in results]
    nb = (len(todo) + BATCH - 1) // BATCH
    for i in range(0, len(todo), BATCH):
        if i:
            time.sleep(1.0)  # >= 1s giữa các call (public RPC ~1 call/sec)
        batch = todo[i : i + BATCH]
        print(f"rpc batch {i // BATCH + 1}/{nb} ({len(batch)} addrs)...", flush=True)
        for a, v in zip(batch, rpc_accounts(args.rpc, batch)):
            results[a] = classify(a, v)

    invalid = sorted(a for a, (s, _) in results.items() if s == "invalid")
    uncertain = sorted(a for a, (s, _) in results.items() if s == "uncertain")
    n_valid = sum(1 for s, _ in results.values() if s == "valid")
    by_reason = {}
    for s, r in results.values():
        by_reason[r or s] = by_reason.get(r or s, 0) + 1
    print(
        f"\nVALID={n_valid}  INVALID={len(invalid)}  "
        f"UNCERTAIN(kept)={len(uncertain)}  verified={len(results)}/{total}"
    )
    print("counts by reason:", json.dumps(by_reason, sort_keys=True))
    print(f"\ninvalid list ({len(invalid)}):")
    for a in invalid:
        m = info[a]
        where = (
            "+".join(
                t
                for t, f in (("tracked_cas", m["tracked"]), (state_label, m["state"]))
                if f
            )
            or "-"
        )
        print(f"  {a:<46} {results[a][1]:<18} in: {where}")
    for a in uncertain:
        print(f"  UNCERTAIN {a} ({results[a][1]}) — KEPT, không xoá")

    refs = {}  # chỉ báo cáo, KHÔNG xoá (orphan-purge trước đây cũng chừa nansen_series)
    inv = set(invalid)
    for t in ("nansen_series", "wallet_token_state", "wallet_trades"):
        try:
            vals = {r[0] for r in conn.execute(f"SELECT ca FROM {t}")}
        except sqlite3.OperationalError:
            continue
        refs[t] = len(vals & inv)
    print("rows elsewhere referencing invalid CAs (NOT deleted):", json.dumps(refs))

    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(
                {
                    "generated_at": datetime.now().isoformat(timespec="seconds"),
                    "db": args.db,
                    "rpc": args.rpc,
                    "state_table": state_label,
                    "row_counts": {
                        "tracked_cas": n_tracked,
                        tbl or "token_state": n_state,
                    },
                    "verified": len(results),
                    "by_reason": by_reason,
                    "valid": n_valid,
                    "invalid": [
                        {"address": a, "reason": results[a][1], **info[a]}
                        for a in invalid
                    ],
                    "uncertain": [
                        {"address": a, "reason": results[a][1], **info[a]}
                        for a in uncertain
                    ],
                    "refs_elsewhere": refs,
                },
                f,
                indent=2,
                ensure_ascii=False,
            )
        print(f"wrote {args.json_out}")

    if not args.apply:
        print("\ndry-run only — chạy lại với --apply để xoá (backup trước)")
        return 0

    # ---- apply ----
    if not invalid:
        print("invalid set rỗng — từ chối --apply")
        return 1
    assert not (inv & set(uncertain)), "uncertain lọt vào invalid set — abort"
    bak = f"{args.db}.bak.preCaVerify.{datetime.now().strftime('%Y%m%dT%H%M%S')}"
    dst = sqlite3.connect(bak)
    with dst:
        conn.backup(dst)  # sqlite online backup API — WAL-safe, KHÔNG phải file copy
    dst.close()
    print(f"BACKUP {bak}")
    before = (n_tracked, n_state)
    with conn:  # MỘT transaction
        conn.executemany(
            "DELETE FROM tracked_cas WHERE address=?", [(a,) for a in invalid]
        )
        if tbl:
            conn.executemany(
                f"DELETE FROM {tbl} WHERE {col}=?", [(a,) for a in invalid]
            )
    after_t = conn.execute("SELECT COUNT(*) FROM tracked_cas").fetchone()[0]
    after_s = conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0] if tbl else 0
    print(f"tracked_cas: {before[0]} -> {after_t}")
    print(f"{tbl or 'token_state'}: {before[1]} -> {after_s}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
