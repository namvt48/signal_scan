#!/usr/bin/env python3
"""Regression tests for private gateway environment updates."""

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from set_gateway_env import KEY, update_env_file


class SetGatewayEnvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "gateway.env"
        self.path.write_text("NANSEN_API_KEY=private-value\nGATEWAY_TOKEN_A=token\n", encoding="utf-8")
        self.path.chmod(0o600)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_updates_only_the_fw_route_and_preserves_private_settings(self) -> None:
        changed = update_env_file(
            self.path,
            "ws://gateway-chrome:3000, ws://172.20.0.1:31135,ws://gateway-chrome:3000",
        )

        text = self.path.read_text(encoding="utf-8")
        self.assertTrue(changed)
        self.assertIn("NANSEN_API_KEY=private-value", text)
        self.assertIn("GATEWAY_TOKEN_A=token", text)
        self.assertIn(f"{KEY}=ws://gateway-chrome:3000,ws://172.20.0.1:31135", text)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(update_env_file(self.path, "ws://gateway-chrome:3000,ws://172.20.0.1:31135"))

    def test_rejects_duplicate_key_and_invalid_endpoint_without_writing(self) -> None:
        self.path.write_text(f"{KEY}=ws://one\n{KEY}=ws://two\n", encoding="utf-8")
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            update_env_file(self.path, "ws://one")
        self.assertEqual(self.path.read_bytes(), before)

        self.path.write_text("NANSEN_API_KEY=private-value\n", encoding="utf-8")
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "credential-free"):
            update_env_file(self.path, "http://proxy:3128")
        self.assertEqual(self.path.read_bytes(), before)

    def test_rejects_world_readable_env(self) -> None:
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "mode 600"):
            update_env_file(self.path, "ws://gateway-chrome:3000")


if __name__ == "__main__":
    unittest.main()
