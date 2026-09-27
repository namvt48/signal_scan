"""Import watchers.evm.* KHÔNG được đụng state/heartbeat/config của daemon Sol
và shim scripts/wallet_watch.py vẫn trỏ Sol — ràng buộc T8 ("không đổi hành vi
Sol"). Tách file riêng vì test_evm_feed.py có autouse fixture patch state path.
"""

import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_evm_import_leaves_sol_paths_untouched():
    import watchers.common.config as config
    import watchers.common.state as st_mod
    import watchers.evm.classify  # noqa: F401
    import watchers.evm.feed  # noqa: F401
    import watchers.evm.main  # noqa: F401
    import watchers.sol.feed  # noqa: F401  (Sol vẫn import được y nguyên)
    import watchers.sol.main  # noqa: F401

    assert os.path.basename(st_mod.STATE_PATH) == "wallet_watch_state.json"
    assert os.path.basename(st_mod.HEARTBEAT) == "heartbeat"
    assert config.RPCS == list(config.RPC_DEFAULTS)  # endpoint Sol không bị đổi
    shim = open(os.path.join(REPO, "scripts", "wallet_watch.py")).read()
    assert "watchers.sol" in shim  # shim vẫn chạy daemon Sol
