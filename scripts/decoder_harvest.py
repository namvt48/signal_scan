#!/usr/bin/env python3
"""Harvest + census + baseline for the program-decoder wallet-watch rework.

Tầng 0/1/2 của kế hoạch: label corpus (Nansen) → payload on-chain → program census
→ baseline recall của detector hiện tại. Không sửa wallet_watch.py.

Subcommands:
  build-corpus   gom label từ .probe/nansen-24h/run2500 → corpus.jsonl
  fetch          tải getTransaction cho mọi sig chưa có (resumable, xoay key)
  census         quét payload → program_registry.json (ix/event/log per program)
  baseline       chạy detect_swaps hiện tại vs label → baseline_report.json

Ví dụ:
  RPC_URLS=... python3 scripts/decoder_harvest.py build-corpus
  python3 scripts/decoder_harvest.py fetch --workers 6
  python3 scripts/decoder_harvest.py census
  python3 scripts/decoder_harvest.py baseline
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, ".probe", "nansen-24h", "run2500")
ART = os.path.join(ROOT, ".probe", "program-decoder")
PAYLOADS = os.path.join(ART, "payloads")
CORPUS = os.path.join(ART, "corpus.jsonl")
REGISTRY = os.path.join(ART, "program_registry.json")
REPORT = os.path.join(ART, "baseline_report.json")
COVERAGE = os.path.join(ART, "coverage_report.json")

sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location(
    "wallet_watch", os.path.join(HERE, "wallet_watch.py")
)
assert _spec and _spec.loader
ww = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ww)


# ---------------------------------------------------------------- helpers
def _clean_sig(s: str) -> str:
    return (s or "").strip().split("\x00")[0].strip()


def _as_float(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s in ("", "None", "null"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _rows_from_raw() -> list[dict[str, Any]]:
    raw = os.path.join(SRC, "raw")
    out = []
    for name in os.listdir(raw):
        if not name.endswith(".json"):
            continue
        ca, _, wallet = name[:-5].partition("__")
        try:
            d = json.load(open(os.path.join(raw, name)))
        except (OSError, ValueError):
            continue
        for r in d.get("data") or []:
            out.append(
                {
                    "sig": _clean_sig(r.get("transactionHash")),
                    "wallet": wallet,
                    "ca": ca,
                    "side": (r.get("txType") or "").lower(),
                    "ts": r.get("blockTimestamp"),
                    "amount_token": _as_float(r.get("directionalAmountOfTokens")),
                    "usd": _as_float(r.get("usdValueAtTxTime")),
                    "from": r.get("fromAddress"),
                    "to": r.get("toAddress"),
                }
            )
    return out


def _rows_from_jsonl(path: str) -> list[dict[str, Any]]:
    out = []
    if not os.path.exists(path):
        return out
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        out.append(
            {
                "sig": _clean_sig(r.get("transactionHash") or r.get("tx")),
                "wallet": r.get("wallet"),
                "ca": r.get("ca"),
                "side": (r.get("txType") or r.get("side") or "").lower(),
                "ts": r.get("blockTimestamp") or r.get("ts"),
                "amount_token": _as_float(
                    r.get("directionalAmountOfTokens") or r.get("amount_token")
                ),
                "usd": _as_float(r.get("usdValueAtTxTime") or r.get("amount_usd")),
                "from": r.get("fromAddress"),
                "to": r.get("toAddress"),
            }
        )
    return out


# ---------------------------------------------------------------- corpus
def build_corpus(_args) -> None:
    os.makedirs(ART, exist_ok=True)
    rows = _rows_from_raw() + _rows_from_jsonl(os.path.join(SRC, "trades_24h.jsonl"))
    seen: set[tuple[Any, ...]] = set()
    kept = []
    for r in rows:
        if (
            not r["sig"]
            or not r["wallet"]
            or not r["ca"]
            or r["side"] not in ("buy", "sell", "transfer")
        ):
            continue
        key = (r["sig"], r["wallet"], r["ca"], r["side"])
        if key in seen:
            continue
        seen.add(key)
        kept.append(r)
    with open(CORPUS, "w") as f:
        for r in kept:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    by_side = Counter(r["side"] for r in kept)
    print(
        f"corpus rows={len(kept)} unique_sigs={len({r['sig'] for r in kept})} by_side={dict(by_side)}"
    )
    print(f"-> {CORPUS}")


# ---------------------------------------------------------------- fetch
_lock = threading.Lock()
_idx = {"i": 0}


def _next_rpc(urls: list[str]) -> str:
    with _lock:
        u = urls[_idx["i"] % len(urls)]
        _idx["i"] += 1
        return u


def _get_tx(url: str, sig: str, timeout: int = 30):
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                sig,
                {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": 1,
                    "commitment": "finalized",
                },
            ],
        }
    ).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _fetch_one(sig: str, urls: list[str]) -> tuple[str, str]:
    path = os.path.join(PAYLOADS, f"{sig}.json")
    if os.path.exists(path) and os.path.getsize(path) > 2:
        return sig, "cached"
    last = "?"
    for attempt in range(6):
        url = _next_rpc(urls)
        try:
            resp = _get_tx(url, sig)
            if "error" in resp and resp["error"]:
                return sig, f"rpc_error:{str(resp['error'])[:60]}"
            with open(path, "w") as f:
                json.dump({"result": resp.get("result")}, f)
            return sig, "ok" if resp.get("result") else "null"
        except urllib.error.HTTPError as e:
            last = f"http{e.code}"
            if e.code == 429:
                time.sleep(1.5 * (attempt + 1))
                continue
            time.sleep(0.5)
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
            time.sleep(0.5 * (attempt + 1))
    return sig, f"failed:{last}"


def fetch(args) -> None:
    urls = [
        u.strip()
        for u in (args.rpc_url or os.environ.get("RPC_URLS", "")).split(",")
        if u.strip()
    ]
    if not urls:
        sys.exit("no RPC: set RPC_URLS=url1,url2,... or --rpc-url")
    os.makedirs(PAYLOADS, exist_ok=True)
    sigs = [json.loads(l)["sig"] for l in open(CORPUS)]
    sigs = sorted(set(sigs))
    todo = [s for s in sigs if not os.path.exists(os.path.join(PAYLOADS, f"{s}.json"))]
    print(f"sigs={len(sigs)} todo={len(todo)} workers={args.workers} keys={len(urls)}")
    stats = Counter()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(_fetch_one, s, urls) for s in todo]
        for fut in as_completed(futs):
            _sig, status = fut.result()
            stats[status.split(":")[0]] += 1
            done += 1
            if done % 200 == 0:
                print(f"  {done}/{len(todo)} {dict(stats)}", flush=True)
    cached = len(sigs) - len(todo)
    print(f"done. cached={cached} {dict(stats)}")


# ---------------------------------------------------------------- census
KNOWN_ROLE = {}


def _classify(pid: str) -> str:
    if pid in ww._AGGREGATORS:
        return "aggregator"
    if pid in ww._TOKEN_PROGS:
        return "token_program"
    if pid in ww._PLUMBING:
        return "plumbing"
    return "unknown"


def _log_stack_programs(meta) -> dict[str, dict[str, Any]]:
    """Parse 'Program <PID> invoke/success' + 'Program log/data' → per-program counters."""
    per: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"ix_names": Counter(), "event_discs": Counter(), "logs": Counter()}
    )
    stack: list[str] = []
    for line in meta.get("logMessages") or []:
        if line.startswith("Program ") and " invoke [" in line:
            stack.append(line.split()[1])
        elif line.startswith("Program ") and (" success" in line or " failed" in line):
            if stack:
                stack.pop()
        elif line.startswith("Program log: ") and stack:
            txt = line[len("Program log: ") :]
            if txt.startswith("Instruction: "):
                per[stack[-1]]["ix_names"][txt[len("Instruction: ") :]] += 1
            else:
                per[stack[-1]]["logs"][txt[:60]] += 1
        elif line.startswith("Program data: ") and stack:
            try:
                raw = base64.b64decode(line.split("Program data: ", 1)[1].strip())
            except Exception:  # noqa: BLE001
                continue
            per[stack[-1]]["event_discs"][raw[:8].hex()] += 1
    return per


def census(_args) -> None:
    registry: dict[str, dict[str, Any]] = {}
    files = [f for f in os.listdir(PAYLOADS) if f.endswith(".json")]
    side_of = {}
    for r in (json.loads(l) for l in open(CORPUS)):
        side_of.setdefault(r["sig"], r["side"])
    n_tx = 0
    for fn in files:
        sig = fn[:-5]
        try:
            tx = json.load(open(os.path.join(PAYLOADS, fn))).get("result")
        except (OSError, ValueError):
            continue
        if not tx:
            continue
        n_tx += 1
        side = side_of.get(sig, "?")
        meta = tx.get("meta") or {}
        msg = tx["transaction"]["message"]
        pids = {i.get("programId") for i in msg.get("instructions") or []}
        for bi in meta.get("innerInstructions") or []:
            pids |= {i.get("programId") for i in bi.get("instructions") or []}
        pids.discard(None)
        per = _log_stack_programs(meta)
        for pid in pids | set(per):
            e = registry.setdefault(
                pid,
                {
                    "role": _classify(pid),
                    "txs": 0,
                    "swap_txs": 0,
                    "transfer_txs": 0,
                    "ix_names": Counter(),
                    "event_discs": Counter(),
                    "logs": Counter(),
                    "discs": Counter(),
                },
            )
            e["txs"] += 1
            if side in ("buy", "sell"):
                e["swap_txs"] += 1
            elif side == "transfer":
                e["transfer_txs"] += 1
        # Anchor ix discriminators (base64 data)
        for i in msg.get("instructions") or []:
            d = i.get("data")
            if isinstance(d, str) and i.get("parsed") is None:
                try:
                    registry[i["programId"]]["discs"][
                        base64.b64decode(d)[:8].hex()
                    ] += 1
                except Exception:  # noqa: BLE001
                    pass
        for pid, c in per.items():
            e = registry[pid]
            for k in ("ix_names", "event_discs", "logs"):
                e[k].update(c[k])
    serial: dict[str, dict[str, Any]] = {
        pid: {
            "role": e["role"],
            "txs": e["txs"],
            "swap_txs": e["swap_txs"],
            "transfer_txs": e["transfer_txs"],
            "ix_names": dict(e["ix_names"].most_common(20)),
            "event_discs": dict(e["event_discs"].most_common(20)),
            "discs": dict(e["discs"].most_common(20)),
            "logs": dict(e["logs"].most_common(10)),
        }
        for pid, e in registry.items()
    }
    json.dump(
        {"n_payloads": n_tx, "programs": serial},
        open(REGISTRY, "w"),
        indent=1,
        sort_keys=True,
    )
    top = sorted(serial.items(), key=lambda kv: -int(kv[1]["swap_txs"]))[:30]
    print(f"payloads={n_tx} programs={len(serial)}  -> {REGISTRY}\n")
    print(
        f"{'program':44} {'role':11} {'swap':>5} {'xfer':>5} {'top instruction / event'}"
    )
    for pid, e in top:
        hint = ",".join(list(e["ix_names"])[:2]) or ",".join(
            d[:8] for d in list(e["event_discs"])[:2]
        )
        print(
            f"{pid:44} {e['role']:11} {e['swap_txs']:5} {e['transfer_txs']:5} {hint[:60]}"
        )


# ---------------------------------------------------------------- baseline
def baseline(args) -> None:
    rows = [json.loads(l) for l in open(CORPUS)]
    rows = [r for r in rows if r["side"] in ("buy", "sell")]
    if args.limit:
        rows = rows[: args.limit]
    hit = miss = nopayload = 0
    per_side = defaultdict(lambda: {"hit": 0, "miss": 0})
    miss_programs = Counter()
    miss_rows: list[dict[str, Any]] = []
    worst: list[tuple[float, str, str, str, float, float]] = []
    errs: list[float] = []
    chain_hit = chain_miss = chain_scored = side_disagree = nansen_qty_bad = 0
    chain_misses: list[dict[str, Any]] = []
    net_errs: list[float] = []
    net_none = 0
    net_worst: list[dict[str, Any]] = []
    for r in rows:
        path = os.path.join(PAYLOADS, f"{r['sig']}.json")
        tx = None
        if os.path.exists(path):
            try:
                tx = json.load(open(path)).get("result")
            except (OSError, ValueError):
                tx = None
        if not tx:
            nopayload += 1
            continue
        try:
            evs = ww.detect_swaps(tx, r["wallet"])
        except Exception:  # noqa: BLE001
            evs = []
        want = r["side"].upper()
        match = next(
            (e for e in evs if e.get("mint") == r["ca"] and e.get("side") == want), None
        )
        try:
            chain = float(ww._net_owner(tx, r["wallet"]).get(r["ca"], 0.0) or 0.0)
        except Exception:  # noqa: BLE001
            chain = 0.0
        if abs(chain) > 0:
            chain_scored += 1
            cside = "BUY" if chain > 0 else "SELL"
            if cside != want:
                side_disagree += 1
            cmatch = next(
                (e for e in evs if e.get("mint") == r["ca"] and e.get("side") == cside),
                None,
            )
            if cmatch:
                chain_hit += 1
                nets = [
                    float(e["qty_net"])
                    for e in evs
                    if e.get("mint") == r["ca"]
                    and e.get("side") == cside
                    and e.get("qty_net") is not None
                ]
                if nets:
                    rel_net = abs(sum(nets) - chain) / abs(chain)
                    net_errs.append(rel_net)
                    if rel_net > 0.05 and len(net_worst) < 200:
                        net_worst.append(
                            {
                                "rel": rel_net,
                                "sig": r["sig"],
                                "ca": r["ca"],
                                "side": cside,
                                "chain": chain,
                                "sum_qty_net": sum(nets),
                                "evs": [
                                    {
                                        "side": e.get("side"),
                                        "mint": e.get("mint"),
                                        "qty": e.get("qty"),
                                        "qty_net": e.get("qty_net"),
                                        "basis": e.get("amount_basis"),
                                        "step": e.get("step"),
                                    }
                                    for e in evs
                                    if e.get("mint") == r["ca"]
                                ],
                            }
                        )
                else:
                    net_none += 1
            else:
                chain_miss += 1
                if len(chain_misses) < 50:
                    chain_misses.append(
                        {
                            "sig": r["sig"],
                            "wallet": r["wallet"],
                            "ca": r["ca"],
                            "nansen_side": r["side"],
                            "chain_side": cside,
                            "chain_amt": chain,
                            "nansen_amt": r["amount_token"],
                            "got": [
                                {
                                    "mint": e.get("mint"),
                                    "side": e.get("side"),
                                    "qty": e.get("qty"),
                                }
                                for e in evs
                            ],
                        }
                    )
            if r["amount_token"] and abs(chain - r["amount_token"]) / abs(chain) > 0.05:
                nansen_qty_bad += 1
        if match:
            hit += 1
            per_side[r["side"]]["hit"] += 1
            if r["amount_token"]:
                rel = abs(match["qty"] - r["amount_token"]) / r["amount_token"]
                errs.append(rel)
                if rel > 0.05:
                    worst.append(
                        (
                            rel,
                            r["sig"],
                            r["ca"],
                            r["side"],
                            r["amount_token"],
                            match["qty"],
                        )
                    )
        else:
            miss += 1
            per_side[r["side"]]["miss"] += 1
            meta = tx.get("meta") or {}
            msg = tx["transaction"]["message"]
            pids = {i.get("programId") for i in msg.get("instructions") or []}
            for bi in meta.get("innerInstructions") or []:
                pids |= {i.get("programId") for i in bi.get("instructions") or []}
            for pid in pids:
                if pid not in ww._PLUMBING and pid not in ww._TOKEN_PROGS:
                    miss_programs[pid] += 1
            if len(miss_rows) < 50:
                miss_rows.append(
                    {
                        "sig": r["sig"],
                        "ca": r["ca"],
                        "wallet": r["wallet"],
                        "side": r["side"],
                        "amount_token": r["amount_token"],
                        "ts": r["ts"],
                        "got": [
                            {
                                "mint": e.get("mint"),
                                "side": e.get("side"),
                                "qty": e.get("qty"),
                            }
                            for e in evs
                        ],
                        "programs": sorted(
                            p
                            for p in pids
                            if p not in ww._PLUMBING and p not in ww._TOKEN_PROGS
                        ),
                    }
                )
    total = hit + miss
    errs.sort()
    rep = {
        "rows": len(rows),
        "scored": total,
        "no_payload": nopayload,
        "recall": hit / total if total else 0.0,
        "by_side": {k: v for k, v in per_side.items()},
        "qty_rel_err": {
            "p50": errs[len(errs) // 2] if errs else None,
            "p95": errs[int(len(errs) * 0.95)] if errs else None,
        },
        "miss_by_program": miss_programs.most_common(40),
        "misses": miss_rows,
        "chain_arbiter": {
            "scored": chain_scored,
            "hit": chain_hit,
            "miss": chain_miss,
            "recall": chain_hit / chain_scored if chain_scored else 0.0,
            "nansen_side_disagree": side_disagree,
            "nansen_qty_off_gt5pct": nansen_qty_bad,
        },
        "chain_misses": chain_misses,
        "net_worst": sorted(net_worst, key=lambda d: -float(d["rel"]))[:20],
        "qty_net_rel_err": {
            "n": len(net_errs),
            "n_qty_net_none": net_none,
            "p50": sorted(net_errs)[len(net_errs) // 2] if net_errs else None,
            "p95": sorted(net_errs)[int(len(net_errs) * 0.95)] if net_errs else None,
            "max": max(net_errs) if net_errs else None,
            "n_gt5pct": sum(1 for e in net_errs if e > 0.05),
        },
        "worst_qty": [
            {"rel_err": e, "sig": s, "ca": c, "side": sd, "want": w, "got": g}
            for e, s, c, sd, w, g in sorted(worst, reverse=True)[:20]
        ],
    }
    json.dump(rep, open(REPORT, "w"), indent=1)
    print(
        f"scored={total} hit={hit} miss={miss} no_payload={nopayload} recall={rep['recall']:.1%}"
    )
    print("by_side:", json.dumps(rep["by_side"]))
    print("chain_arbiter:", json.dumps(rep["chain_arbiter"]))
    print("qty_net_rel_err:", json.dumps(rep["qty_net_rel_err"]))
    print("qty_rel_err:", json.dumps(rep["qty_rel_err"]))
    print("top programs in MISSED txs:")
    for pid, n in miss_programs.most_common(15):
        print(f"  {n:4}  {pid}")
    print(f"-> {REPORT}")


def coverage(args) -> None:
    """Presence tx-level cho MỌI row (kể cả transfer), arbiter = chain net-delta."""
    rows = [json.loads(line) for line in open(CORPUS)]
    if args.limit:
        rows = rows[: args.limit]
    per_side = defaultdict(lambda: {"rows": 0, "moved": 0, "present": 0})
    ev_types = defaultdict(Counter)
    miss_rows: list[dict[str, Any]] = []
    no_payload = 0
    for r in rows:
        per_side[r["side"]]["rows"] += 1
        path = os.path.join(PAYLOADS, f"{r['sig']}.json")
        tx = None
        if os.path.exists(path):
            try:
                tx = json.load(open(path)).get("result")
            except (OSError, ValueError):
                tx = None
        if not tx:
            no_payload += 1
            continue
        try:
            evs = ww.detect_events(tx, r["wallet"])
        except Exception:  # noqa: BLE001
            evs = []
        try:
            chain = float(ww._net_owner(tx, r["wallet"]).get(r["ca"], 0.0) or 0.0)
        except Exception:  # noqa: BLE001
            chain = 0.0
        if not chain:
            continue
        per_side[r["side"]]["moved"] += 1
        hits = [e for e in evs if e.get("mint") == r["ca"]]
        if hits:
            per_side[r["side"]]["present"] += 1
            for e in hits:
                ev_types[r["side"]][str(e.get("type") or "SWAP")] += 1
        elif len(miss_rows) < 80:
            miss_rows.append(
                {
                    "sig": r["sig"],
                    "wallet": r["wallet"],
                    "ca": r["ca"],
                    "nansen_side": r["side"],
                    "chain": chain,
                    "other_evs": [
                        {
                            "mint": e.get("mint"),
                            "side": e.get("side"),
                            "qty": e.get("qty"),
                        }
                        for e in evs
                    ],
                }
            )
    rep: dict[str, Any] = {
        "rows": len(rows),
        "no_payload": no_payload,
        "by_side": {k: dict(v) for k, v in per_side.items()},
        "ev_types_by_side": {k: dict(v) for k, v in ev_types.items()},
        "presence_miss": miss_rows,
    }
    tot_moved = sum(v["moved"] for v in per_side.values())
    tot_present = sum(v["present"] for v in per_side.values())
    rep["moved"] = tot_moved
    rep["present"] = tot_present
    rep["presence"] = tot_present / tot_moved if tot_moved else 0.0
    json.dump(rep, open(COVERAGE, "w"), indent=1)
    for side, v in sorted(per_side.items()):
        rate = v["present"] / v["moved"] if v["moved"] else 0.0
        print(
            f"  {side:9} rows={v['rows']:5} moved={v['moved']:5} "
            f"present={v['present']:5} presence={rate:.1%}"
        )
    print(
        f"TOTAL moved={tot_moved} present={tot_present} presence={rep['presence']:.1%}"
    )
    print(f"-> {COVERAGE}")


# ---------------------------------------------------------------- cli
def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build-corpus").set_defaults(fn=build_corpus)
    f = sub.add_parser("fetch")
    f.add_argument("--workers", type=int, default=6)
    f.add_argument("--rpc-url")
    f.set_defaults(fn=fetch)
    sub.add_parser("census").set_defaults(fn=census)
    b = sub.add_parser("baseline")
    b.add_argument("--limit", type=int, default=0)
    b.set_defaults(fn=baseline)
    c = sub.add_parser("coverage")
    c.add_argument("--limit", type=int, default=0)
    c.set_defaults(fn=coverage)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
