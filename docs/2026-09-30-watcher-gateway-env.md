# Watcher host units — gateway egress env (request-plane-gateway)

Host `root@194.163.187.250`. The host systemd watchers reach the request-plane gateway on
**loopback** (`http://127.0.0.1:8130`); the gateway is deployed separately (plan todo 21).
This is the deploy/provisioning runbook for the two units. **Never commit the token value
— this file references env file PATHS only.**

## Env names (same as the api client, todo 14)

| Var | Value |
|---|---|
| `GATEWAY_URL` | `http://127.0.0.1:8130` |
| `GATEWAY_CALLER_TOKEN` | the `watcher` token = gateway's `GATEWAY_TOKEN_WATCHER` |

## Where they go (existing EnvironmentFile / drop-in pattern)

| Unit | File | Form |
|---|---|---|
| `wallet-watch` | `/etc/systemd/system/wallet-watch.service.d/track.conf` | `Environment=GATEWAY_URL=…` + `Environment=GATEWAY_CALLER_TOKEN=…` |
| `fomo-watch` | `/opt/fomo-watch/fomo.env` (EnvironmentFile, mode 600) | `GATEWAY_URL=…` + `GATEWAY_CALLER_TOKEN=…` |
| `fomo-watch` | `/etc/systemd/system/fomo-watch.service.d/gateway.conf` (drop-in) | same two `Environment=` lines |

`systemctl show <unit> -p Environment` does **not** expose `EnvironmentFile=` values, so the
fomo drop-in mirrors the two names for visibility/verification. Set the token in **both**
fomo locations.

`GATEWAY_URL`/`GATEWAY_CALLER_TOKEN` are read by `watchers/common/config.py`
(`gateway_json`, todos 16/18). The control plane must have the matching modules deployed to
`/opt/{wallet,fomo}-watch/watchers/common/` (`config.py`, `price.py`).

## Provisioning step (run at gateway deploy, todo 21)

1. In `/opt/signal-scan-gateway/gateway.env` (root-owned, mode 600) set
   `GATEWAY_TOKEN_WATCHER=$(openssl rand -hex 32)` alongside `GATEWAY_TOKEN_A`,
   `GATEWAY_TOKEN_B`, `NANSEN_API_KEY`, `GMGN_API_KEY`, `RL_*`.
2. Put the **same** value into the two units above as `GATEWAY_CALLER_TOKEN`.
3. `systemctl daemon-reload && systemctl restart wallet-watch fomo-watch`; confirm the PID
   changes and both stay `active`.

Until the token is provisioned the watchers send no `Authorization` header; once the
gateway is up they get `401` (fail-closed by design) and degrade to unknown prices.

## Caller identity

Both watchers only call **GMGN and DexScreener** (never the Nansen credit API), so they use
the separate `watcher` token (`server/src/gateway/auth.ts`) and do **not** consume either
half of callers a/b's Nansen credit budget.

## Fail-open window (gateway not yet deployed)

The watchers must not crash-loop while the gateway is absent. `watchers/common/price.py`
(todo 18) never raises into the feed loop: a failed gateway lookup yields the existing
"unknown price" result (`get_price_usd` → `None`) and the heartbeat keeps advancing. A
missing/removed gateway var is a config error, not a crash.
