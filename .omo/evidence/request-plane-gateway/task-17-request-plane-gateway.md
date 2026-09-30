# Task 17 — Host systemd env wiring for watchers (+ caller identity)

Plan: `.omo/plans/request-plane-gateway.md` (todo 17, line 223).
Host: `root@194.163.187.250`. Date: 2026-09-30. Branch: current, direct mode.
Scope: host systemd env for `/opt/wallet-watch` (`wallet-watch.service` + drop-in
`track.conf`) and `/opt/fomo-watch` (`fomo.env`), plus a minimal repo deploy doc.
**No secret VALUE is written here — env file PATHS only.**

## Repo files changed

- `docs/2026-09-30-watcher-gateway-env.md` — NEW. Deploy/provisioning runbook for the two
  units (env names, the todo-21 provisioning step, the watcher-token identity note).

No source code changed. (The watcher modules deployed below were already committed by
todos 16/18: `dfd2c82`, `f298378`; this task shipped them to the host — see §3.)

## 1. Host state BEFORE the change

```
$ systemctl is-active wallet-watch fomo-watch
active
active
$ systemctl show wallet-watch -p Environment            # MASKED (RPC keys / GMGN key / service token)
Environment=PYTHONUNBUFFERED=1 "SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=***,..." GMGN_API_KEY=*** QUOTE_SOURCE=dexscreener SIGNAL_SCAN_SERVICE_TOKEN=***
$ systemctl show fomo-watch -p Environment
Environment=PYTHONUNBUFFERED=1
$ systemctl show wallet-watch -p MainPID --value   # 3322282   (fomo 3322240), ActiveEnterTimestamp Wed 2026-09-30 06:30:09 CEST
$ stat -c "%n %Y" /opt/wallet-watch/heartbeat /opt/fomo-watch/fomo_heartbeat
/opt/wallet-watch/heartbeat 1790765251
/opt/fomo-watch/fomo_heartbeat 1790765238
```

- `wallet-watch` unit + drop-in `/etc/systemd/system/wallet-watch.service.d/track.conf`
  (carries `Environment=` lines incl. the Helius RPC pool, `GMGN_API_KEY`, `SIGNAL_SCAN_SERVICE_TOKEN`).
- `fomo-watch` unit uses `EnvironmentFile=/opt/fomo-watch/fomo.env` (mode 600).
- `/opt/signal-scan-gateway/` does **not** exist ⇒ the gateway is not deployed and no
  `watcher` token value is provisioned on the host (see §6 BLOCKER).
- The deployed watcher modules were still the pre-todo-16 build
  (`config.py` md5 `e1ba7315212e42dc133e16ffa3d9dde0`, `price.py` md5
  `bf4f5eff704b9bc877d02c30f741f50f`) ⇒ the gateway env was inert until §3.

## 2. Applied env additions (existing EnvironmentFile / drop-in pattern)

`GATEWAY_URL=http://127.0.0.1:8130` and `GATEWAY_CALLER_TOKEN` — the SAME two names the
api uses (todo 14). Backups taken first (stamp `20260930T104809Z`), values untouched:

| Host path | Added |
|---|---|
| `/etc/systemd/system/wallet-watch.service.d/track.conf` | `Environment=GATEWAY_URL=http://127.0.0.1:8130` + `Environment=GATEWAY_CALLER_TOKEN=` (lines 17-18) |
| `/opt/fomo-watch/fomo.env` | `GATEWAY_URL=http://127.0.0.1:8130` + `GATEWAY_CALLER_TOKEN=` (lines 5-6) |
| `/etc/systemd/system/fomo-watch.service.d/gateway.conf` (NEW) | `Environment=GATEWAY_URL=…` + `Environment=GATEWAY_CALLER_TOKEN=` |

Backups (paths only): `track.conf.bak.20260930T104809Z`, `fomo.env.bak.20260930T104809Z`.

**fomo mechanism note:** `EnvironmentFile=` values do NOT appear in
`systemctl show <unit> -p Environment` (only inline `Environment=` does), so the
acceptance check would miss the names. The fomo drop-in mirrors the same two
`Environment=` lines while `fomo.env` keeps them for the process env. Both are the same
(empty) value; **todo 21 must set `GATEWAY_CALLER_TOKEN` in BOTH fomo locations and in
`track.conf`** (see §5).

```
$ grep -n GATEWAY /etc/systemd/system/wallet-watch.service.d/track.conf
15:# GATEWAY_CALLER_TOKEN provisioned at todo 21 from /opt/signal-scan-gateway/gateway.env (GATEWAY_TOKEN_WATCHER).
17:Environment=GATEWAY_URL=http://127.0.0.1:8130
18:Environment=GATEWAY_CALLER_TOKEN=
$ grep -n GATEWAY /opt/fomo-watch/fomo.env
4:# ... todo 17: gateway egress vars (GATEWAY_CALLER_TOKEN filled at todo 21) ---
5:GATEWAY_URL=http://127.0.0.1:8130
6:GATEWAY_CALLER_TOKEN=
```

## 3. Deployed the committed watcher modules (so the env is consumed)

`GATEWAY_URL`/`GATEWAY_CALLER_TOKEN` are read by the Python gateway client added in
todos 16/18 (`watchers/common/config.py`, `watchers/common/price.py`). Those modules were
committed but not yet on the host, so they were `scp`'d (minimal blast radius; same
pattern as the 2026-09-28 auth-service token deploy) to both trees. Backups kept
(`*.bak.20260930T104809Z`).

```
$ md5sum /opt/wallet-watch/watchers/common/{config,price}.py /opt/fomo-watch/watchers/common/{config,price}.py
247d557adee6848e86eaee40b24d0366  /opt/wallet-watch/watchers/common/config.py
ba0cb0305e1d1dc434f6b30a54700690  /opt/wallet-watch/watchers/common/price.py
247d557adee6848e86eaee40b24d0366  /opt/fomo-watch/watchers/common/config.py
ba0cb0305e1d1dc434f6b30a54700690  /opt/fomo-watch/watchers/common/price.py
# repo md5 == host md5 (config.py 247d55…, price.py ba0cb0…)
$ cd /opt/wallet-watch && ./venv/bin/python -c "from watchers.common import config; print(callable(config.gateway_json), config._gateway_token=='', config._gateway_url)"
True True http://127.0.0.1:8130
$ cd /opt/fomo-watch && ./venv/bin/python -c "from watchers.common import config; print(callable(config.gateway_json))"
True
```

## 4. Acceptance — restart, active, heartbeat advancing, env names present

```
$ systemctl restart wallet-watch fomo-watch
$ systemctl is-active wallet-watch fomo-watch
active
active
$ systemctl show wallet-watch fomo-watch -p MainPID -p ActiveEnterTimestamp
# wallet-watch MainPID 3322282 -> 3422642 ; fomo-watch MainPID 3322240 -> 3422640
# ActiveEnterTimestamp -> Wed 2026-09-30 12:51:16 CEST  (PID changed ⇒ new code really loaded)
$ stat -c "%n %Y (%y)" /opt/wallet-watch/heartbeat /opt/fomo-watch/fomo_heartbeat
before: /opt/wallet-watch/heartbeat 1790765473
        /opt/fomo-watch/fomo_heartbeat 1790765448
after : /opt/wallet-watch/heartbeat 1790765503  (advanced +30s)
        /opt/fomo-watch/fomo_heartbeat 1790765482  (advanced +34s)
```

`systemctl show -p Environment` — MASKED (RPC api-keys, GMGN key, service token redacted;
the gateway vars are non-secret names):

```
$ systemctl show wallet-watch -p Environment | sed -E "s/api-key=[A-Za-z0-9-]+/api-key=***/g; s/GMGN_API_KEY=[^ ]*/GMGN_API_KEY=***/g; s/SIGNAL_SCAN_SERVICE_TOKEN=[^ ]*/SIGNAL_SCAN_SERVICE_TOKEN=***/g"
Environment=PYTHONUNBUFFERED=1 "SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=***,https://mainnet.helius-rpc.com/?api-key=***,https://mainnet.helius-rpc.com/?api-key=***,https://mainnet.helius-rpc.com/?api-key=***,https://mainnet.helius-rpc.com/?api-key=***,https://mainnet.helius-rpc.com/?api-key=***" GMGN_API_KEY=*** QUOTE_SOURCE=dexscreener SIGNAL_SCAN_SERVICE_TOKEN=*** GATEWAY_CALLER_TOKEN= GATEWAY_URL=http://127.0.0.1:8130

$ systemctl show fomo-watch -p Environment
Environment=PYTHONUNBUFFERED=1 GATEWAY_URL=http://127.0.0.1:8130 GATEWAY_CALLER_TOKEN=
```

Running-process env (proves the unit env reached the PID):

```
$ PID=$(systemctl show wallet-watch -p MainPID --value); tr "\0" "\n" < /proc/$PID/environ | grep -E "^GATEWAY_"
GATEWAY_CALLER_TOKEN=
GATEWAY_URL=http://127.0.0.1:8130
```

## 5. Failure case — var removed, watcher does NOT crash-loop

Removed `Environment=GATEWAY_URL=…` from `track.conf`, `daemon-reload`, restart:

```
$ sed -i "/^Environment=GATEWAY_URL=/d" /etc/systemd/system/wallet-watch.service.d/track.conf && systemctl daemon-reload
$ systemctl restart wallet-watch; sleep 3
is-active=active  pid=3423151
$ sleep 20; stat -c %Y /opt/wallet-watch/heartbeat
1790765538 -> 1790765558  (advancing=yes)
```

The watcher stayed `active` and the heartbeat kept advancing (no crash-loop). The
gateway client then falls back to its default loopback URL and fails OPEN with a clear
logged error (no exception escapes into the feed loop):

```
$ cd /opt/wallet-watch && ./venv/bin/python -c "from watchers.common import price; print(price.gmgn_info('So11111111111111111111111111111111111111112','sol')); print(price.token_info('So11111111111111111111111111111111111111112'))"
  ! gmgn: URLError: <urlopen error [Errno 111] Connection refused>
(None, 0.0)            # gmgn fail-open -> unknown
('So1111…', 0.0)       # dexscreener fail-open -> unknown, no raise
```

Restored the `GATEWAY_URL` line and restarted; both units `active` and the names are
back in `systemctl show -p Environment` (see §4).

Note: the DexScreener branch inside `token_info` swallows the transport error without a
print (`except Exception: pass`, unchanged by todo 16); the GMGN branch prints the
`! gmgn: …` line above. Either way the watcher never raises into the poller/feed loop
(todo 18 fail-open). With `QUOTE_SOURCE=dexscreener` the running watcher logs no gateway
line until the gateway exists; it simply keeps unknown prices and advances the heartbeat.

## 6. BLOCKER — the `watcher` token VALUE is not yet provisioned

The gateway is NOT deployed (`/opt/signal-scan-gateway/` does not exist), so
`GATEWAY_TOKEN_WATCHER` has no value on the host, and `/root/signal_scan/server/.env`
(todo 14) does not yet carry `GATEWAY_URL`/`GATEWAY_CALLER_TOKEN` either. The `watcher`
token therefore cannot be derived yet — **the variable NAME is wired with an empty value
on purpose (do NOT guess a secret).**

Exact provisioning step to run at gateway deploy (todo 21) — reference paths only:

1. In `/opt/signal-scan-gateway/gateway.env` (root-owned, mode 600) set
   `GATEWAY_TOKEN_WATCHER=<openssl rand -hex 32>` (alongside `GATEWAY_TOKEN_A`,
   `GATEWAY_TOKEN_B`, `NANSEN_API_KEY`, `GMGN_API_KEY`, `RL_*`). This is the gateway's
   own reader (`server/src/config.ts` `gatewayTokenWatcher`).
2. Copy the SAME value into:
   - `/etc/systemd/system/wallet-watch.service.d/track.conf` →
     `Environment=GATEWAY_CALLER_TOKEN=<value>`
   - `/opt/fomo-watch/fomo.env` **and** `/etc/systemd/system/fomo-watch.service.d/gateway.conf` →
     `GATEWAY_CALLER_TOKEN=<value>`
3. `systemctl daemon-reload && systemctl restart wallet-watch fomo-watch`; confirm the PID
   changes and both stay `active`.

Until then the watchers send no `Authorization` header → once the gateway is up they get
`401` (fail-closed by design) and degrade to unknown prices; this is expected and logged.

## 7. Caller identity — watcher token, NOT a/b credit

Both watcher sets only call GMGN and DexScreener (never the Nansen credit API), so they
use the `watcher` token (`GATEWAY_TOKEN_WATCHER`). The `watcher` caller is separate from
callers `a`/`b` (`server/src/gateway/auth.ts`), so it does **not** consume either half of
the Nansen credit budget. (FOMO currently has no price path at all — its gateway env is
wired forward-looking only.)

## 8. Constraints honoured

- No secret VALUE in this file, the repo, or the plan — env file PATHS only; `systemctl`
  output masked for the RPC keys / GMGN key / service token.
- No unrelated service restarted (only `wallet-watch`, `fomo-watch`).
- Do not `git add`/commit/branch/push.
- Watchers did not crash-loop (heartbeats advanced through both restarts).

EVIDENCE_RECORDED: .omo/evidence/request-plane-gateway/task-17-request-plane-gateway.md
