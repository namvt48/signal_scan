#!/usr/bin/env python3
"""Gate T16 (plan request-plane-gateway): watcher egress GMGN/DexScreener đi QUA
gateway; bỏ gate GMGN phía client (gateway là single writer — rate-limit/limiter
là việc của gateway, không nhân đôi phía client).

Gateway GIẢ thật = HTTP server loopback (port ngẫu nhiên, KHÔNG ra internet):
  POST /v1/gmgn/token-info → 200 {status, body, headers}, body = raw GMGN
  POST /v1/dexscreener    → 200 {status, body, headers}, body = raw DexScreener
- `_Gateway.fail = True` ⇒ trả envelope {status:500, body:null} (upstream lỗi).

Assert:
  (a) gmgn_info hit /v1/gmgn/token-info + Authorization bearer đúng + parse ra
      đúng (symbol, price); QUOTE_SOURCE=gmgn ⇒ token_info cũng đi nhánh GMGN.
  (b) token_info (DexScreener) hit /v1/dexscreener + parse đúng (symbol, price).
  (c) KHÔNG còn gap timer GMGN phía client (_GMGN_GAP_S/_GMGN_BAN_S/_gmgn_next_ok).
  (d) gateway 500 ⇒ "price unknown", không raise (fail-open — T18).

Chạy: python3 scripts/test_price_gateway.py
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.pop("QUOTE_SOURCE", None)  # mặc định = DexScreener

from watchers.common import config, price  # noqa: E402

TOKEN = "watcher-test-token"
GMGN_RAW = {
    "code": 0,
    "data": {"token": {"symbol": "BTCX", "price": {"price": "0.00097206308"}}},
}
DEX_MINT = "TokenMint1111111111111111111111111111111111"
DEX_RAW = {
    "pairs": [
        {
            "baseToken": {"address": DEX_MINT, "symbol": "MET"},
            "quoteToken": {"address": config.WSOL, "symbol": "SOL"},
            "priceUsd": "0.3311",
            "priceNative": "5230.5",
        }
    ]
}

_HITS = []


class _Gateway(BaseHTTPRequestHandler):
    """Gateway giả: ghi lại request rồi trả envelope raw pass-through."""

    fail = False

    def log_message(self, format, *args):  # im lặng — test không cần access log
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        _HITS.append(
            {"path": self.path, "auth": self.headers.get("Authorization"), "body": body}
        )
        if _Gateway.fail:
            envelope = {"status": 500, "body": None, "headers": {}}
        elif self.path == "/v1/gmgn/token-info":
            envelope = {"status": 200, "body": json.dumps(GMGN_RAW), "headers": {}}
        elif self.path == "/v1/dexscreener":
            envelope = {"status": 200, "body": json.dumps(DEX_RAW), "headers": {}}
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(envelope).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _hits(path):
    return [h for h in _HITS if h["path"] == path]


def main() -> int:
    srv = HTTPServer(("127.0.0.1", 0), _Gateway)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    config._gateway_url = f"http://127.0.0.1:{srv.server_address[1]}"
    config._gateway_token = TOKEN

    # (a) GMGN qua gateway
    price._info.clear()
    _HITS.clear()
    sym, px = price.gmgn_info("GMGNmint", "sol")
    assert sym == "BTCX" and abs(px - 0.00097206308) < 1e-15, (sym, px)
    h = _hits("/v1/gmgn/token-info")
    assert len(h) == 1, f"gmgn_info phải hit gateway 1 lần, được {_HITS}"
    assert h[0]["auth"] == f"Bearer {TOKEN}", h[0]["auth"]
    assert h[0]["body"] == {"ca": "GMGNmint", "chain": "sol"}, h[0]["body"]
    print(
        "OK (a): gmgn_info → POST /v1/gmgn/token-info, bearer đúng, "
        "parse (BTCX, 0.00097206308)"
    )

    # QUOTE_SOURCE=gmgn ⇒ token_info đi nhánh GMGN gateway trước
    os.environ["QUOTE_SOURCE"] = "gmgn"
    price._info.clear()
    _HITS.clear()
    gsym, gpx = price.token_info("GMGNmint2")
    assert gsym == "BTCX" and abs(gpx - 0.00097206308) < 1e-15, (gsym, gpx)
    assert len(_hits("/v1/gmgn/token-info")) == 1, _HITS
    print("OK (a2): QUOTE_SOURCE=gmgn → token_info đi gateway GMGN")

    # (b) DexScreener qua gateway
    os.environ.pop("QUOTE_SOURCE", None)
    price._info.clear()
    _HITS.clear()
    sym, px = price.token_info(DEX_MINT)
    assert sym == "MET" and abs(px - 0.3311) < 1e-12, (sym, px)
    d = _hits("/v1/dexscreener")
    assert len(d) == 1, f"token_info phải hit gateway 1 lần, được {_HITS}"
    assert d[0]["auth"] == f"Bearer {TOKEN}", d[0]["auth"]
    assert d[0]["body"] == {
        "endpoint": "tokens",
        "params": {"addresses": DEX_MINT},
    }, d[0]["body"]
    assert len(_hits("/v1/gmgn/token-info")) == 0, "DexScreener mặc định KHÔNG gọi GMGN"
    print(
        "OK (b): token_info → POST /v1/dexscreener, parse (MET, 0.3311), "
        "không đụng GMGN"
    )

    # (c) không còn gap timer GMGN phía client
    for name in ("_GMGN_GAP_S", "_GMGN_BAN_S", "_gmgn_next_ok"):
        assert not hasattr(price, name), f"còn gate GMGN phía client: {name}"
    print(
        "OK (c): không còn _GMGN_GAP_S/_GMGN_BAN_S/_gmgn_next_ok "
        "(gateway là single writer)"
    )

    # (d) gateway 500 ⇒ price unknown, không raise (fail-open — T18)
    _Gateway.fail = True
    price._info.clear()
    assert price.token_info("FailingMint")[1] == 0.0
    assert price.get_price_usd("FailingMint2") is None
    print("OK (d): gateway 500 → 'price unknown', không raise")

    srv.shutdown()
    print("PASS: price gateway — GMGN + DexScreener đi qua gateway, bỏ gate client")
    return 0


if __name__ == "__main__":
    sys.exit(main())
