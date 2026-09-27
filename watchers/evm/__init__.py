"""EVM wallet-watch daemon (Base + BSC) — T8, plan evm-base-bsc (D7).

`python3 -m watchers.evm` — mirror của `watchers/sol`, dùng chung
`watchers/common/*` (config/state/price/emit). State/heartbeat file RIÊNG
(`evm_watch_state.json` / `heartbeat_evm`) để chạy song song daemon Sol.
"""
