import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from watchers.common import state as wallet_state
from watchers.fomo import feed


class MonitorHeartbeatTests(unittest.TestCase):
    def test_fomo_beat_updates_watchdog_and_monitor_files(self):
        with tempfile.TemporaryDirectory() as directory:
            watchdog = Path(directory) / "fomo-watchdog"
            monitor = Path(directory) / "monitor-fomo"
            with (
                patch.object(feed, "HEARTBEAT", str(watchdog)),
                patch.object(feed, "FOMO_MONITOR_HEARTBEAT", monitor),
            ):
                feed._beat()
            self.assertTrue(watchdog.is_file())
            self.assertTrue(monitor.is_file())

    def test_wallet_beat_updates_watchdog_and_monitor_files(self):
        with tempfile.TemporaryDirectory() as directory:
            watchdog = Path(directory) / "wallet-watchdog"
            monitor = Path(directory) / "monitor-wallet"
            with (
                patch.object(wallet_state, "HEARTBEAT", str(watchdog)),
                patch.object(wallet_state, "MONITOR_HEARTBEAT", str(monitor)),
            ):
                wallet_state._beat()
            self.assertTrue(watchdog.is_file())
            self.assertTrue(monitor.is_file())


if __name__ == "__main__":
    unittest.main()
