#!/usr/bin/env python3
"""Tests for the forwarding key's source and destination restrictions."""

from __future__ import annotations

import unittest

from install_forward_key import restricted_key_options


class RestrictedKeyOptionsTests(unittest.TestCase):
    def test_fw_tunnel_key_is_limited_to_gateway_source_and_browserless_port(self) -> None:
        options = restricted_key_options("167.86.101.228", 31135)
        self.assertIn('from="167.86.101.228"', options)
        self.assertIn('permitopen="127.0.0.1:31135"', options)
        self.assertIn('command="/bin/false"', options)
        self.assertIn("restrict,port-forwarding", options)

    def test_rejects_unapproved_forward_ports(self) -> None:
        with self.assertRaisesRegex(ValueError, "31134 or 31135"):
            restricted_key_options("167.86.101.228", 22)

    def test_rejects_invalid_source_addresses(self) -> None:
        with self.assertRaises(ValueError):
            restricted_key_options("0.0.0.0/0", 31135)


if __name__ == "__main__":
    unittest.main()
