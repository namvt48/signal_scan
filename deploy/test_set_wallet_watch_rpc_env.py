from __future__ import annotations

import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from set_wallet_watch_rpc_env import container_endpoints, normalize_endpoints, update_env_file


class WalletWatchRpcEnvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "rpc.env"
        self.endpoints = ",".join(f"https://mainnet.helius-rpc.com/?api-key=secret-{index}" for index in range(6))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_updates_dedicated_env_atomically_with_restrictive_mode(self) -> None:
        self.assertTrue(update_env_file(self.path, self.endpoints))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(self.path.read_text(), f'SOLANA_RPC_URL="{self.endpoints}"\n')
        self.assertFalse(update_env_file(self.path, self.endpoints))

    def test_rejects_invalid_endpoints_without_modifying_existing_file(self) -> None:
        update_env_file(self.path, self.endpoints)
        before = self.path.read_bytes()
        for invalid in ("", "http://mainnet.helius-rpc.com", "https://u:p@example.com", "https://rpc.example/#fragment", "https://one\nOTHER=secret"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                normalize_endpoints(invalid)
        self.assertEqual(self.path.read_bytes(), before)
        self.path.write_text(before.decode() + "OTHER=secret\n")
        modified = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "unrelated"):
            update_env_file(self.path, self.endpoints)
        self.assertEqual(self.path.read_bytes(), modified)
        self.path.write_bytes(before)
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private regular file"):
            update_env_file(self.path, self.endpoints)
        link = Path(self.temporary.name) / "link.env"
        link.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, "symlink"):
            update_env_file(link, self.endpoints)

    def test_container_source_requires_running_production_api_without_auth_bypass(self) -> None:
        expected = {"State": {"Running": True}, "Config": {"Env": [f"SOLANA_RPC_URL={self.endpoints}"]}}
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps([expected]), stderr="")
        with patch("set_wallet_watch_rpc_env.subprocess.run", return_value=result):
            self.assertEqual(container_endpoints("signal_scan-api-1"), self.endpoints)
        bypassed = {"State": {"Running": True}, "Config": {"Env": ["AUTH_DISABLED=1", f"SOLANA_RPC_URL={self.endpoints}"]}}
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps([bypassed]), stderr="")
        with patch("set_wallet_watch_rpc_env.subprocess.run", return_value=result), self.assertRaisesRegex(ValueError, "authentication bypass"):
            container_endpoints("signal_scan-api-1")


if __name__ == "__main__":
    unittest.main()
