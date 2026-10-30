"""Persistent account-wide FOMO request guard. State is fail-closed on any I/O error."""
from __future__ import annotations

import fcntl
import json
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


class GuardError(Exception):
    def __init__(self, state: str, retry_after: int | None = None):
        self.state, self.retry_after = state, retry_after
        super().__init__(state)


class RequestGuard:
    WINDOWS = (("minute", 60), ("hour", 3600), ("day", 86400))

    def __init__(self, path: str | None = None, enabled: str | None = None,
                 limits: tuple[int, int, int] | None = None, clock=time.time,
                 quota_mode: str | None = None):
        self.path = Path(path or os.environ.get("FOMO_GUARD_STATE_FILE", "/state/request-guard.json"))
        self.enabled = enabled if enabled is not None else os.environ.get("FOMO_UPSTREAM_ENABLED", "false")
        self.quota_mode = quota_mode if quota_mode is not None else os.environ.get("FOMO_REQUEST_QUOTA_MODE", "limited")
        if limits is None:
            try:
                limits = tuple(int(os.environ.get("FOMO_MAX_REQUESTS_PER_" + n.upper(), "0")) for n in ("minute", "hour", "day"))
            except ValueError:
                limits = (0, 0, 0)
        self.limits = limits
        self.clock = clock
        self._emergency_state: str | None = None
        self._emergency_cooldown_until = 0.0
        self._thread_lock = threading.RLock()
        self._serial = threading.BoundedSemaphore(1)

    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock = open(str(self.path) + ".lock", "a+b")
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return lock

    def _load(self) -> dict[str, Any]:
        try:
            if not self.path.exists():
                return {"version": 1, "suspended": False, "cooldown_until": 0, "windows": {}}
            data = json.loads(self.path.read_text())
            if not isinstance(data, dict) or type(data.get("version")) is not int or data.get("version") != 1 or not isinstance(data.get("windows"), dict) or not isinstance(data.get("suspended"), bool):
                raise ValueError("schema")
            cooldown_until = data.get("cooldown_until", 0)
            if type(cooldown_until) not in (int, float) or not math.isfinite(cooldown_until) or cooldown_until < 0:
                raise ValueError("cooldown")
            for name, item in data["windows"].items():
                if name not in dict(self.WINDOWS) or not isinstance(item, dict):
                    raise ValueError("window")
                if type(item.get("start")) is not int or type(item.get("count")) is not int or item["count"] < 0:
                    raise ValueError("window")
            return data
        except Exception as exc:
            raise GuardError("state_error") from exc

    def _decision(self, data: dict[str, Any], now: float) -> tuple[str, int]:
        if self._emergency_state is not None:
            return self._emergency_state, 0
        if data["suspended"]:
            return "suspended", 0
        cooldown_until = max(float(data.get("cooldown_until", 0)), self._emergency_cooldown_until)
        cooldown = max(0, math.ceil(cooldown_until - now))
        if cooldown:
            return "cooldown", cooldown
        if not self._configured():
            return "paused", 0
        if self.quota_mode.strip().lower() == "unlimited":
            return "ready", 0
        waits: list[int] = []
        for (name, span), limit in zip(self.WINDOWS, self.limits):
            start = int(now // span) * span
            item = data["windows"].get(name, {})
            count = item.get("count", 0) if item.get("start") == start else 0
            if count >= limit:
                waits.append(max(1, math.ceil(start + span - now)))
        if waits:
            return "budget_exhausted", max(waits)
        return "ready", 0

    def check(self) -> None:
        """Fail closed before touching credentials; does not reserve quota."""
        try:
            with self._thread_lock:
                lock = self._locked()
                try:
                    data = self._load()
                    state, retry_after = self._decision(data, self.clock())
                    if state != "ready":
                        raise GuardError(state, retry_after or None)
                finally:
                    lock.close()
        except GuardError:
            raise
        except Exception as exc:
            raise GuardError("state_error") from exc

    def snapshot(self) -> dict[str, Any]:
        try:
            with self._thread_lock:
                lock = self._locked()
                try:
                    data = self._load()
                    state, retry_after = self._decision(data, self.clock())
                    return {
                        "state": state,
                        "cooldownRemainingSeconds": retry_after if state == "cooldown" else 0,
                        "retryAfterSeconds": retry_after,
                    }
                finally:
                    lock.close()
        except Exception:
            return {"state": "state_error", "cooldownRemainingSeconds": None, "retryAfterSeconds": None}

    def _configured(self) -> bool:
        enabled = self.enabled.strip().lower() in ("1", "true", "yes", "on")
        unlimited = self.quota_mode.strip().lower() == "unlimited"
        return enabled and (unlimited or all(x > 0 for x in self.limits))

    def authorize(self) -> None:
        try:
            with self._serial:
                with self._thread_lock:
                    lock = self._locked()
                    try:
                        data = self._load()
                        now = self.clock()
                        state, retry_after = self._decision(data, now)
                        if state != "ready":
                            raise GuardError(state, retry_after or None)
                        if self.quota_mode.strip().lower() != "unlimited":
                            windows = data["windows"]
                            for (name, span), _limit in zip(self.WINDOWS, self.limits):
                                start = int(now // span) * span
                                item = windows.get(name, {})
                                if item.get("start") != start:
                                    item = {"start": start, "count": 0}
                                windows[name] = item
                            for item in windows.values():
                                item["count"] = int(item.get("count", 0)) + 1
                            self._save(data)
                    finally:
                        lock.close()
        except GuardError:
            raise
        except Exception as exc:
            self._emergency_state = "state_error"
            raise GuardError("state_error") from exc

    def _save(self, data: dict[str, Any]) -> None:
        fd, tmp = tempfile.mkstemp(prefix=".fomo-guard-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def suspend(self) -> None:
        self._emergency_state = "suspended"
        try:
            self._mutate(lambda state: state.update(suspended=True))
        except Exception:
            # The in-process latch still blocks every endpoint if persistence fails.
            pass

    def cooldown(self, seconds: float) -> None:
        self._emergency_cooldown_until = max(self._emergency_cooldown_until, self.clock() + seconds)
        try:
            self._mutate(lambda state: state.update(cooldown_until=max(float(state.get("cooldown_until", 0)), self.clock() + seconds)))
        except Exception:
            self._emergency_state = "state_error"

    def reset(self) -> None:
        """Clear suspension/cooldown while preserving every quota window."""
        self._mutate(lambda state: state.update(suspended=False, cooldown_until=0))
        self._emergency_state = None
        self._emergency_cooldown_until = 0.0

    def _mutate(self, fn) -> None:
        with self._thread_lock:
            lock = self._locked()
            try:
                state = self._load()
                fn(state)
                self._save(state)
            finally:
                lock.close()


def reset_from_cli() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Reset FOMO guard suspension after provider approval")
    parser.add_argument("--confirm-provider-approval", action="store_true", required=True,
                        help="confirm provider approval; quota windows are retained")
    args = parser.parse_args()
    if args.confirm_provider_approval:
        RequestGuard().reset()
        print("FOMO guard suspension and cooldown cleared; quota history retained")

if __name__ == "__main__":
    reset_from_cli()
