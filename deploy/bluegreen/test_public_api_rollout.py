import os
from pathlib import Path
import subprocess
import tempfile
import unittest



SCRIPT = Path(__file__).with_name("public-api.sh")
SHIM = r'''#!/usr/bin/env python3
import json, os, pathlib, re, signal, sys
root = pathlib.Path(os.environ["FAULT_ROOT"])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "curl":
    if any("/readyz" in arg for arg in args):
        print(json.dumps({"status": "ready", "release": os.environ["RELEASE_ID"]}))
    sys.exit(0)
if name == "caddy":
    if args[0] == "validate":
        sys.exit(0)
    reloads = root / "reloads"
    count = int(reloads.read_text()) + 1 if reloads.exists() else 1
    reloads.write_text(str(count))
    if os.environ.get("FAIL_CADDY_ROLLBACK") == "1" and count > 1:
        sys.exit(1)
    text = (root / "Caddyfile").read_text()
    port = re.search(r"reverse_proxy 127\.0\.0\.1:(301[01])", text).group(1)
    (root / "route").write_text(port)
    sys.exit(0)
if name == "docker":
    if args[0] == "inspect":
        print("true")
        sys.exit(0)
    if args[0] == "exec":
        if os.environ.get("INTERRUPT_AFTER_CUTOVER") == "1":
            os.kill(os.getppid(), signal.SIGTERM)
        sys.exit(1 if os.environ.get("FAIL_WEBSOCKET") == "1" else 0)
    if args[0] == "network":
        sys.exit(0)
    if args[0] == "volume":
        sys.exit(0)
    if args[0] == "compose":
        args = args[5:]
        if args[0] == "build" and os.environ.get("FAIL_BUILD") == "1":
            sys.exit(1)
        if args[0] == "ps":
            print(args[-1])
            sys.exit(0)
        if args[0] == "up":
            for service in args[1:]:
                if not service.startswith("-"):
                    (root / (service + ".state")).write_text("running")
        if args[0] == "stop":
            for service in args[3:]:
                (root / (service + ".state")).write_text("stopped")
        sys.exit(0)
'''


def rollout(active: str, *, fail_websocket: bool = False, fail_caddy_rollback: bool = False, fail_build: bool = False, interrupt_after_cutover: bool = False):
    temp = tempfile.TemporaryDirectory(prefix="signal-scan-bluegreen-test-")
    root = Path(temp.name)
    (root / "server").mkdir()
    (root / "server/public-api.env").write_text("fixture=1\n")
    (root / "deploy/bluegreen").mkdir(parents=True)
    (root / "deploy/bluegreen/public-api-active").write_text(active + "\n")
    data_a = root / "data-a"
    data_a.mkdir()
    (data_a / "signal_scan.db").touch()
    port = "3010" if active == "blue" else "3011"
    service = "public-api" if active == "blue" else "public-api-green"
    previous_main_export = "public-api-export-main" if active == "blue" else "public-api-export-main-green"
    previous_fomo_export = "public-api-export-fomo" if active == "blue" else "public-api-export-fomo-green"
    candidate = "public-api-green" if active == "blue" else "public-api"
    candidate_main_export = "public-api-export-main-green" if active == "blue" else "public-api-export-main"
    candidate_fomo_export = "public-api-export-fomo-green" if active == "blue" else "public-api-export-fomo"
    (root / "Caddyfile").write_text(
        "signal-scan.duckdns.org {\n"
        "    # BEGIN signal-scan public API blue-green\n"
        "    handle /api/v1/* {\n"
        f"        reverse_proxy 127.0.0.1:{port}\n"
        "    }\n"
        "    # END signal-scan public API blue-green\n"
        "    reverse_proxy 127.0.0.1:8124\n}\n"
    )
    (root / "route").write_text(port)
    for previous in (service, previous_main_export, previous_fomo_export):
        (root / (previous + ".state")).write_text("running")
    bin_path = root / "bin"
    bin_path.mkdir()
    for name in ("docker", "curl", "caddy"):
        path = bin_path / name
        path.write_text(SHIM)
        path.chmod(0o755)
    source = SCRIPT.read_text()
    source = source.replace("ROOT=/root/signal_scan", f"ROOT={root}")
    source = source.replace("CADDYFILE=/etc/caddy/Caddyfile", f"CADDYFILE={root}/Caddyfile")
    source = source.replace("LOCK=/run/lock/signal-scan-public-api-deploy.lock", f"LOCK={root}/lock")
    script = root / "rollout.sh"
    script.write_text(source)
    env = {
        **os.environ,
        "PATH": str(bin_path) + os.pathsep + os.environ["PATH"],
        "FAULT_ROOT": str(root),
        "FAIL_CADDY_ROLLBACK": "1" if fail_caddy_rollback else "0",
        "FAIL_BUILD": "1" if fail_build else "0",
        "FAIL_WEBSOCKET": "1" if fail_websocket else "0",
        "INTERRUPT_AFTER_CUTOVER": "1" if interrupt_after_cutover else "0",
        "PUBLIC_API_A_DATA_DIR": str(data_a),
    }
    result = subprocess.run(["bash", str(script)], env=env, text=True, capture_output=True, timeout=30)
    state = {
        "active": (root / "deploy/bluegreen/public-api-active").read_text().strip(),
        "route": (root / "route").read_text(),
        "candidate": candidate,
        "candidate_main_export": candidate_main_export,
        "candidate_fomo_export": candidate_fomo_export,
        "previous": service,
        "candidate_state": (root / (candidate + ".state")).read_text(),
        "candidate_main_state": (root / (candidate_main_export + ".state")).read_text(),
        "candidate_fomo_state": (root / (candidate_fomo_export + ".state")).read_text(),
        "previous_state": (root / (service + ".state")).read_text(),
        "previous_main_state": (root / (previous_main_export + ".state")).read_text(),
        "previous_fomo_state": (root / (previous_fomo_export + ".state")).read_text(),
        "result": result,
    }
    return temp, state


class PublicApiRolloutTest(unittest.TestCase):
    def test_candidate_build_failure_keeps_active_route_and_slot(self):
        temp, state = rollout("green", fail_build=True)
        with temp:
            self.assertNotEqual(state["result"].returncode, 0)
            self.assertEqual(state["route"], "3011")
            self.assertEqual(state["active"], "green")
            self.assertEqual(state["previous_state"], "running")
            self.assertEqual(state["candidate_state"], "stopped")
            self.assertEqual(state["previous_main_state"], "running")
            self.assertEqual(state["previous_fomo_state"], "running")
            self.assertEqual(state["candidate_main_state"], "stopped")
            self.assertEqual(state["candidate_fomo_state"], "stopped")

    def test_failed_cutover_rollback_keeps_routed_candidate_running(self):
        temp, state = rollout("blue", fail_websocket=True, fail_caddy_rollback=True)
        with temp:
            self.assertNotEqual(state["result"].returncode, 0)
            self.assertEqual(state["route"], "3011")
            self.assertEqual(state["active"], "green")
            self.assertEqual(state["candidate_state"], "running")
            self.assertEqual(state["candidate_main_state"], "running")
            self.assertEqual(state["candidate_fomo_state"], "running")
            self.assertIn("leaving candidate", state["result"].stderr)

    def test_sigterm_after_cutover_restores_previous_route(self):
        temp, state = rollout("green", interrupt_after_cutover=True)
        with temp:
            self.assertEqual(state["result"].returncode, 143, state["result"].stderr)
            self.assertEqual(state["route"], "3011")
            self.assertEqual(state["active"], "green")
            self.assertEqual(state["previous_state"], "running")
            self.assertEqual(state["candidate_state"], "stopped")
            self.assertEqual(state["previous_main_state"], "running")
            self.assertEqual(state["previous_fomo_state"], "running")
            self.assertEqual(state["candidate_main_state"], "stopped")
            self.assertEqual(state["candidate_fomo_state"], "stopped")

    def test_green_to_blue_success_updates_route_and_retires_old_slot(self):
        temp, state = rollout("green")
        with temp:
            self.assertEqual(state["result"].returncode, 0, state["result"].stderr)
            self.assertEqual(state["route"], "3010")
            self.assertEqual(state["active"], "blue")
            self.assertEqual(state["candidate_state"], "running")
            self.assertEqual(state["previous_state"], "stopped")
            self.assertEqual(state["candidate_main_state"], "running")
            self.assertEqual(state["candidate_fomo_state"], "running")
            self.assertEqual(state["previous_main_state"], "stopped")
            self.assertEqual(state["previous_fomo_state"], "stopped")

    def test_marker_and_caddy_disagreement_fails_closed(self):
        temp, _state = rollout("green")
        with temp:
            root = Path(temp.name)
            marker = root / "deploy/bluegreen/public-api-active"
            marker.write_text("green\n")
            (root / "public-api-green.state").write_text("running")
            (root / "public-api.state").unlink()
            result = subprocess.run(["bash", str(root / "rollout.sh")], env={**os.environ, "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"], "FAULT_ROOT": str(root)}, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("disagrees with Caddy route", result.stderr)
            self.assertEqual((root / "public-api-green.state").read_text(), "running")
            self.assertFalse((root / "public-api.state").exists())


if __name__ == "__main__":
    unittest.main()
