#!/bin/sh
# Tạo server/.env cho MODE=gmgn — chạy TRÊN SERVER từ $REMOTE_DIR (make gmgn-env).
# Private key đọc từ keys/gmgn-private.hex (do make gmgn-keygen sinh).
set -e
KEYS=keys/gmgn-private.hex
[ -f "$KEYS" ] || { echo "CHƯA có keypair — chạy: make gmgn-keygen"; exit 1; }
PRIV=$(tr -d '[:space:]' < "$KEYS")
LEN=${#PRIV}
# Ed25519 PKCS8 DER = 48 bytes = 96 hex chars (16-byte ASN.1 header + 32-byte key)
[ "$LEN" = "96" ] || { echo "private key hex sai độ dài ($LEN != 96) — sinh lại: rm keys/gmgn-* && make gmgn-keygen"; exit 1; }
{
  echo "MODE=gmgn"
  echo "PORT=3001"
  echo "DB_PATH=/data/signal_scan.db"
  echo "GMGN_API_KEY=__DAN_API_KEY_TU_GMGN.AI/AI__"
  echo "GMGN_PRIVATE_KEY=$PRIV"
  echo "# base URL hardcode trong code (openapi.gmgn.ai — bóc từ gmgn-cli 1.6.1), không cần env"
} > server/.env
chmod 600 server/.env
echo "== server/.env OK (private key: $LEN hex chars) — còn thiếu GMGN_API_KEY:"
grep -n '__DAN_API_KEY' server/.env
echo "== điền xong thì: make restart && make gmgn-status"
