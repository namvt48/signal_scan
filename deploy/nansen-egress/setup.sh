#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /root/signal-scan-egress
command -v tinyproxy >/dev/null
getent passwd tinyproxy >/dev/null

if [ -L proxy.env ]; then
  echo 'proxy.env must not be a symlink' >&2
  exit 1
fi
if [ ! -s proxy.env ]; then
  printf 'PROXY_USERNAME=signal_scan\nPROXY_PASSWORD=%s\n' "$(openssl rand -hex 32)" > proxy.env
fi
chmod 600 proxy.env
set -a
source proxy.env
set +a
[[ "$PROXY_USERNAME" =~ ^[a-z_]+$ ]]
[[ "$PROXY_PASSWORD" =~ ^[a-f0-9]{64}$ ]]

install -d -o root -g tinyproxy -m 0750 /etc/signal-scan-egress
candidate=$(mktemp /etc/signal-scan-egress/tinyproxy.conf.XXXXXX)
cat tinyproxy.conf > "$candidate"
printf 'BasicAuth %s %s\n' "$PROXY_USERNAME" "$PROXY_PASSWORD" >> "$candidate"
chown root:tinyproxy "$candidate"
chmod 640 "$candidate"
mv "$candidate" /etc/signal-scan-egress/tinyproxy.conf
install -m 0644 signal-scan-egress.service /etc/systemd/system/signal-scan-egress.service
systemd-analyze verify /etc/systemd/system/signal-scan-egress.service
systemctl daemon-reload
systemctl enable signal-scan-egress.service
systemctl restart signal-scan-egress.service
sleep 1
systemctl is-active --quiet signal-scan-egress.service
listener=$(ss -lntH 'sport = :31134')
[[ "$listener" == *"127.0.0.1:31134"* ]]
[[ "$listener" != *"0.0.0.0:31134"* && "$listener" != *"[::]:31134"* && "$listener" != *"*:31134"* ]]
ss -lntp 'sport = :31134'
echo 'Private egress proxy active; credentials retained in root-only proxy.env'
