#!/usr/bin/env python3
"""T10 — backtest parity (plan .omo/plans/gmgn-parity-fixes.md §T10, policy D14).

Offline only; never calls the GMGN API (hard constraint D1):

      Runs wallet_watch.detect_swaps on the 9 tx JSONs in scripts/fixtures/, compares
      against the 29 oracle rows in gmgn_rows_fixture.json under the EXACT D14 policy
      (identity / side / step-count + amounts: 23 exact @ rel <= 1e-6, and 6 rows
      gross-bounded <= 8%), then prints the same PASS line as the T8 gate.  The whole
      comparison pipeline is IMPORTED from scripts/test_gmgn_api_parity.py (T8) so the
      parity policy has ONE source of truth and cannot drift — this file re-implements
      NOTHING.  Fully hermetic: ww.http_json / ww.rpc / socket.socket are set to raise.
      stdout carries no wall-clock, so two runs are byte-for-byte identical.

Stdlib only — no new dependency (§5.2).
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
T8_PATH = os.path.join(HERE, "test_gmgn_api_parity.py")
WATCH = os.path.join(HERE, "wallet_watch.py")


def load_gate_module():
    """Import the T8 gate as a module and REUSE its parity policy.

    The file name starts with `test_` (pytest convention) but importlib loads any
    path; T8's module level is constants + defs only, so import is side-effect free.
    Importing — rather than copying — the REL_TOL / GROSS_CAP / N_EXACT / N_GROSS /
    gate() pipeline is what keeps D14 from drifting (§4 MUST DO).
    """
    spec = importlib.util.spec_from_file_location("gmgn_parity_gate", T8_PATH)
    assert spec and spec.loader, f"cannot load T8 gate module: {T8_PATH}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _pct(n: int, d: int) -> str:
    return f"{100.0 * n / d:.1f}%" if d else "n/a"


# ---------------------------------------------------------------- --from-fixture


def _fixture_header(gate, rows, txs, names, wallet) -> list[str]:
    return [
        "== T10 backtest parity — --from-fixture (offline, hermetic; §T10, policy D14) ==",
        f"  oracle   : {len(rows)} rows · fixture tx files {len(names)} "
        f"-> {len(txs)} distinct sigs · sig in oracle={len({r['tx_hash'] for r in rows})}",
        f"  wallet   : {wallet[:5]}…{wallet[-4:]} len={len(wallet)} "
        "(read from fixture rows[0]['wallet'] — not a literal)",
        f"  module   : {WATCH}",
        f"  policy   : identity / side / step-count + amounts exact "
        f"(rel<={gate.REL_TOL:g}) {gate.N_EXACT}/{gate.N_ROW} + gross-bounded "
        f"(<= {gate.GROSS_CAP:.0%}) {gate.N_GROSS}/{gate.N_ROW} — IMPORTED from "
        "test_gmgn_api_parity.py, not re-implemented (anti-drift)",
        "  hermetic : ww.http_json / ww.rpc / socket.socket = raise · _info seeded from "
        "fixture (no _info_miss) · GMGN API NEVER called (D1)",
    ]


def _fixture_pass(gate, st, fails) -> bool:
    """True gate: PASS only if no FAIL line AND every D14 count hits its target
    (recomputed from the run state, not echoed from a constant)."""
    return bool(
        not fails
        and st["paired"] == gate.N_ROW
        and st["ident"] == gate.N_ROW
        and st["side"] == gate.N_ROW
        and st["exact"] == gate.N_EXACT
        and st["gross"] == gate.N_GROSS
    )


def run_fixture(gate) -> int:
    data, txs, names = gate.load_fixtures()
    rows = data["rows"]
    gate.preflight(
        rows
    )  # fixture intact BEFORE running — a broken fixture can't masquerade as a FAIL
    ww = gate.load_module()  # fresh wallet_watch (detector)
    gate.block_network(ww)  # hermetic: any http/rpc/socket -> AssertionError
    gate.seed_probe(ww, rows)  # seed _info from fixture + assert idempotent
    wallet = rows[0]["wallet"]
    out = _fixture_header(gate, rows, txs, names, wallet) + [""]
    report, fails, _traces, st = gate.gate(ww, txs, rows)
    out.append("---- per-sig expected-vs-got (guard misleading_success_output) ----")
    out += [ln for ln in report if ln.startswith("sig ")]
    out += [
        "",
        f"parity steps {st['paired']}/{gate.N_ROW} ({_pct(st['paired'], gate.N_ROW)}) · "
        f"identity {st['ident']}/{gate.N_ROW} ({_pct(st['ident'], gate.N_ROW)}) · "
        f"side {st['side']}/{gate.N_ROW} ({_pct(st['side'], gate.N_ROW)}) · "
        f"amounts exact {st['exact']}/{gate.N_EXACT} + {st['gross']}/{gate.N_GROSS} "
        f"gross bounded <= {gate.GROSS_CAP:.0%} (policy D14)",
        gate.summary(st, len(fails)),
    ]
    ok = _fixture_pass(gate, st, fails)
    if ok:
        out += ["", gate.PASS_LINE]
        print("\n".join(out))
        return 0
    out += ["", "---- FAIL detail ----"] + [f"FAIL {f}" for f in fails]
    out.append(
        "---- 29-row table: oracle(expected) | event(got) | rel | gross leg | OK/FAIL ----"
    )
    out += [ln for ln in report if not ln.startswith("sig ")]
    out.append("gate FAILED — no PASS line")
    print("\n".join(out))
    return 1


# ---------------------------------------------------------------- main


def main() -> int:
    t0 = time.time()
    rc = run_fixture(
        load_gate_module()
    )  # reuse T8 parity policy (single source of truth)
    sys.stderr.write(f"timing: backtest parity wall {time.time() - t0:.2f}s\n")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
