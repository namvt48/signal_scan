"""Watchers — daemon watch wallet per chain (production home since T7).

`common/` = phần dùng chung mọi chain (price, emit, state, config); `sol/` = daemon
Solana; watcher EVM (T8) sẽ là `evm/` — sibling của `sol/`, dùng lại `common/`.
Chạy: `python3 -m watchers.sol` (repo root) — hoặc shim tương thích
`python3 scripts/wallet_watch.py` / `/opt/wallet-watch/wallet_watch.py`.
"""
