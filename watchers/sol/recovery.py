"""Bounded, restartable reconciliation of SOL wallet signature history."""

from __future__ import annotations

import threading
import time
from contextlib import nullcontext
from typing import Any

from watchers.common import config
from watchers.common.state import save_state

PAGE_SIZE = 100
MAX_PAGES_PER_WALLET = 4
MAX_SECONDS_PER_CYCLE = 20.0

_rate_lock = threading.Lock()
_last_rpc_at = 0.0
_RPC_INTERVAL = 1.0


def initialize_tracking_window(
    st: dict[str, Any], wallets, deploy_at_ms: int, state_lock=None
) -> None:
    """Persist the server-authoritative system deployment boundary."""
    if (
        not isinstance(deploy_at_ms, int)
        or isinstance(deploy_at_ms, bool)
        or deploy_at_ms <= 0
    ):
        raise ValueError("invalid SOL tracking deployment timestamp")
    with state_lock if state_lock is not None else nullcontext():
        st["sol_tracking_since_ms"] = deploy_at_ms
        cursors = st.setdefault("sol_recovery", {})
        for wallet in wallets:
            cursor = cursors.setdefault(wallet, {})
            legacy_head = st.get("wallets", {}).get(wallet, {}).get("head")
            if "signature" not in cursor and isinstance(legacy_head, str):
                cursor["signature"] = legacy_head
            if not cursor.get("signature") and "observation_start_ms" not in cursor:
                cursor["observation_start_ms"] = int(time.time() * 1000)
            scan = cursor.get("scan")
            if cursor.get("since_ms") != deploy_at_ms or (
                isinstance(scan, dict) and scan.get("since_ms") != deploy_at_ms
            ):
                cursor["since_ms"] = deploy_at_ms
                cursor.pop("scan", None)
        save_state(st)


def tracking_since_ms(st: dict[str, Any], wallet: str, state_lock=None) -> int:
    """Return the wallet's persisted inclusive recovery time boundary."""
    with state_lock if state_lock is not None else nullcontext():
        cursor = st.get("sol_recovery", {}).get(wallet, {})
        since = cursor.get("since_ms", st.get("sol_tracking_since_ms", 0))
        return (
            since
            if isinstance(since, int) and not isinstance(since, bool) and since > 0
            else 0
        )


def _paced_rpc(wallet: str, params: dict[str, Any], deadline: float):
    global _last_rpc_at
    with _rate_lock:
        delay = max(0.0, _last_rpc_at + _RPC_INTERVAL - time.monotonic())
        if delay:
            time.sleep(delay)
        if time.monotonic() >= deadline:
            raise TimeoutError("SOL recovery cycle budget elapsed")
        try:
            return config.rpc("getSignaturesForAddress", [wallet, params])
        finally:
            _last_rpc_at = time.monotonic()



def _paced_process_sig(process_sig, signature: str, wallet: str, st, err, deadline: float):
    """Rate-limit transaction lookups made by the recovery callback."""
    global _last_rpc_at
    with _rate_lock:
        delay = max(0.0, _last_rpc_at + _RPC_INTERVAL - time.monotonic())
        if delay:
            time.sleep(delay)
        if time.monotonic() >= deadline:
            raise TimeoutError("SOL recovery cycle budget elapsed")
    try:
        return process_sig(signature, [wallet], st, err, "cursor")
    finally:
        with _rate_lock:
            _last_rpc_at = time.monotonic()

def _cursor(st: dict[str, Any], wallet: str, state_lock=None) -> dict[str, Any]:
    with state_lock if state_lock is not None else nullcontext():
        cursors = st.setdefault("sol_recovery", {})
        state = cursors.get(wallet)
        if state is None:
            legacy = st.get("wallets", {}).get(wallet, {}).get("head")
            state = {"signature": legacy}
            cursors[wallet] = state
        return state


def _process_pending(
    wallet: str, st: dict[str, Any], cursor: dict[str, Any], process_sig, state_lock
) -> bool:
    scan = cursor.get("scan")
    if not isinstance(scan, dict):
        return False
    pending = scan.get("pending")
    if not isinstance(pending, list):
        raise RuntimeError("malformed SOL recovery pending queue")
    while pending:
        row = pending[0]
        success = _paced_process_sig(
            process_sig,
            row["signature"],
            wallet,
            st,
            row.get("err"),
            scan["deadline"],
        )
        if success is False:
            return False
        with state_lock if state_lock is not None else nullcontext():
            pending.pop(0)
            save_state(st)
    with state_lock if state_lock is not None else nullcontext():
        if scan["done"]:
            cursor["signature"] = scan["head"] or scan["anchor"]
            cursor.pop("scan", None)
        else:
            scan["before"] = scan["next_before"]
            scan.pop("next_before", None)
            scan.pop("deadline", None)
        save_state(st)
    return True


def reconcile_wallet(
    wallet: str, st: dict[str, Any], process_sig, deadline: float, state_lock=None
) -> bool:
    """Process bounded signature pages without advancing across an unscanned gap."""
    deploy_at_ms = getattr(config, "_tracking_since_ms", st.get("sol_tracking_since_ms"))
    if not isinstance(deploy_at_ms, int) or deploy_at_ms < 0:
        return False
    initialize_tracking_window(st, [wallet], deploy_at_ms, state_lock)
    cursor = _cursor(st, wallet, state_lock)
    since_ms = tracking_since_ms(st, wallet, state_lock)
    with state_lock if state_lock is not None else nullcontext():
        scan = cursor.get("scan")
        if isinstance(scan, dict) and scan.get("since_ms") != since_ms:
            cursor.pop("scan", None)
            scan = None
        scan = cursor.get("scan")
        if scan is None:
            scan = {
                "anchor": cursor.get("signature"),
                "head": None,
                "before": None,
                "pending": [],
                "done": False,
                "since_ms": since_ms,
            }
            cursor["scan"] = scan
            save_state(st)
    if scan.get("pending"):
        scan["deadline"] = deadline
        return _process_pending(wallet, st, cursor, process_sig, state_lock)

    pages: list[list[dict[str, Any]]] = []
    page_cursor = scan.get("before")
    last_signature = page_cursor
    found = False
    for _ in range(MAX_PAGES_PER_WALLET):
        if time.monotonic() >= deadline:
            break
        params: dict[str, Any] = {"limit": PAGE_SIZE}
        if scan.get("anchor"):
            params["until"] = scan["anchor"]
        if page_cursor:
            params["before"] = page_cursor
        try:
            result = _paced_rpc(wallet, params, deadline)
        except TimeoutError:
            break
        if not isinstance(result, list):
            raise RuntimeError("malformed getSignaturesForAddress result")
        if not result:
            found = True
            break
        rows = []
        older_than_window = False
        for row in result:
            if not isinstance(row, dict) or not isinstance(row.get("signature"), str):
                raise RuntimeError("malformed SOL signature row")
            if scan.get("anchor") and row["signature"] == scan["anchor"]:
                found = True
                break
            block_time = row.get("blockTime")
            if isinstance(block_time, (int, float)) and not isinstance(block_time, bool):
                if block_time * 1000 < since_ms:
                    older_than_window = True
                    found = True
                    break
            rows.append(row)
        if rows:
            if scan["head"] is None:
                scan["head"] = rows[0]["signature"]
            pages.append(rows)
            last_signature = rows[-1]["signature"]
        if older_than_window or found or len(result) < PAGE_SIZE:
            found = True
            break
        page_cursor = result[-1]["signature"]

    fetched = [row for page in reversed(pages) for row in reversed(page)]
    if not fetched and not found:
        return False
    scan["pending"] = fetched
    scan["next_before"] = last_signature
    scan["done"] = found
    scan["deadline"] = deadline
    with state_lock if state_lock is not None else nullcontext():
        save_state(st)
    return _process_pending(wallet, st, cursor, process_sig, state_lock)


def reconcile_cycle(wallets, st: dict[str, Any], process_sig, state_lock=None) -> None:
    """Reconcile bounded wallet work in a persisted rotating order."""
    snapshot = tuple(wallets)
    if not snapshot:
        return
    deadline = time.monotonic() + MAX_SECONDS_PER_CYCLE
    with state_lock if state_lock is not None else nullcontext():
        recovery_state = st.setdefault("sol_recovery", {})
        start = int(recovery_state.get("_next_wallet_index", 0)) % len(snapshot)
    for offset in range(len(snapshot)):
        if time.monotonic() >= deadline:
            break
        index = (start + offset) % len(snapshot)
        wallet = snapshot[index]
        try:
            reconcile_wallet(wallet, st, process_sig, deadline, state_lock)
        except Exception as exc:
            print(f"  ! SOL recovery {wallet[:8]}: {type(exc).__name__}: {str(exc)[:100]}")
        with state_lock if state_lock is not None else nullcontext():
            recovery_state["_next_wallet_index"] = (index + 1) % len(snapshot)
            save_state(st)
