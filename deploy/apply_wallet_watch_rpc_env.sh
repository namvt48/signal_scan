#!/usr/bin/env bash
set -euo pipefail

root=/opt/wallet-watch
unit_dir=/etc/systemd/system/wallet-watch.service.d
unit_file="$unit_dir/rpc.conf"
env_file="$root/rpc.env"
helper="$root/deploy/set_wallet_watch_rpc_env.py"

"$root/venv/bin/python" "$helper" --container signal_scan-api-1 --env-file "$env_file" --check
"$root/venv/bin/python" "$helper" --container signal_scan-api-1 --env-file "$env_file"
install -d -o root -g root -m 0750 "$unit_dir"
if [[ -e "$unit_file" ]] && [[ "$(cat "$unit_file")" != $'[Service]\nEnvironmentFile=/opt/wallet-watch/rpc.env' ]]; then
  echo "refusing to overwrite an unexpected wallet-watch RPC drop-in" >&2
  exit 1
fi
printf '%s\n' "[Service]" "EnvironmentFile=$env_file" > "$unit_file.tmp"
chown root:root "$unit_file.tmp"
chmod 0600 "$unit_file.tmp"
mv -f "$unit_file.tmp" "$unit_file"
systemctl daemon-reload
systemctl restart wallet-watch.service
systemctl is-active --quiet wallet-watch.service
systemctl show wallet-watch.service -p ActiveState -p MainPID -p EnvironmentFiles
"$root/venv/bin/python" - <<'PY'
import subprocess
import urllib.parse

pid = subprocess.check_output(
    ["systemctl", "show", "wallet-watch.service", "-p", "MainPID", "--value"],
    text=True,
).strip()
if not pid.isdigit() or pid == "0":
    raise SystemExit("wallet-watch has no active process")
raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
environment = dict(item.decode().split("=", 1) for item in raw if b"=" in item)
endpoints = [item for item in environment.get("SOLANA_RPC_URL", "").split(",") if item]
if len(endpoints) != 6 or any(urllib.parse.urlsplit(item).hostname != "mainnet.helius-rpc.com" for item in endpoints):
    raise SystemExit("wallet watcher did not load the expected six Helius endpoints")
print(f"wallet watcher loaded {len(endpoints)} Helius endpoints; values kept private")
PY
curl -fsS http://127.0.0.1:8124/api/health >/dev/null
echo 'wallet-watch restarted; API health OK'
