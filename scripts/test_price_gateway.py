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
  (e) gateway UNREACHABLE (connection refused) ⇒ token_info "unknown" + 1 vòng feed
      loop (emit_swap / _warm_prices) chạy hết, không raise (fail-open — T18).
  (f) gateway body MÉO (envelope không phải object / không phải JSON / body rỗng)
      ⇒ "price unknown", không raise (fail-open — T18).
  (g) QUOTE_SOURCE=gmgn + GMGN body 2xx méo (data không phải dict) ⇒ "unknown",
      không raise — regression cho AttributeError từng thoát ra ngoài (T18).

Chạy: python3 scripts/test_price_gateway.py
"""

import json
import os
import socket
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


def _envelope(env) -> bytes:
    return json.dumps(env).encode()


class _Gateway(BaseHTTPRequestHandler):
    """Gateway giả: ghi lại request rồi trả envelope raw pass-through.

    mode (ngoài fail): "ok" | "notdict" (envelope là LIST) | "notjson" (body HTML)
    | "emptybody" ({status:200, body:null}) | "gmgn_baddata" (GMGN data không dict).
    """

    fail = False
    mode = "ok"

    def log_message(self, format, *args):  # im lặng — test không cần access log
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        _HITS.append(
            {"path": self.path, "auth": self.headers.get("Authorization"), "body": body}
        )
        if _Gateway.fail:
            payload = _envelope({"status": 500, "body": None, "headers": {}})
        elif _Gateway.mode == "notdict":
            payload = json.dumps(["not", "an", "object"]).encode()
        elif _Gateway.mode == "notjson":
            payload = b"<html>502 Bad Gateway</html>"
        elif _Gateway.mode == "emptybody":
            payload = _envelope({"status": 200, "body": None, "headers": {}})
        elif _Gateway.mode == "gmgn_baddata":
            payload = _envelope(
                {
                    "status": 200,
                    "body": json.dumps({"code": 0, "data": "oops"}),
                    "headers": {},
                }
            )
        elif self.path == "/v1/gmgn/token-info":
            payload = _envelope(
                {"status": 200, "body": json.dumps(GMGN_RAW), "headers": {}}
            )
        elif self.path == "/v1/dexscreener":
            payload = _envelope(
                {"status": 200, "body": json.dumps(DEX_RAW), "headers": {}}
            )
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


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

    # (e) gateway UNREACHABLE (connection refused) ⇒ unknown + 1 vòng feed loop chạy hết
    _Gateway.fail = False
    good_url = config._gateway_url
    _s = socket.socket()
    _s.bind(("127.0.0.1", 0))
    dead_port = _s.getsockname()[1]
    _s.close()  # port đã đóng ⇒ connect bị từ chối
    config._gateway_url = f"http://127.0.0.1:{dead_port}"

    price._info.clear()
    sym, px = price.token_info("UnreachableMint")
    assert (sym, px) == ("Unreac…", 0.0), (sym, px)  # đúng shape "unknown"
    assert price.get_price_usd("UnreachableMint2") is None

    os.environ["QUOTE_SOURCE"] = "gmgn"  # cả nhánh GMGN cũng phải fail-open
    price._info.clear()
    assert price.token_info("UnreachableGmgn")[1] == 0.0
    os.environ.pop("QUOTE_SOURCE", None)

    # 1 vòng feed loop: emit_swap lấy giá (evm/feed.py:193-194) — px None ⇒ usd None,
    # KHÔNG raise; _warm_prices là helper vòng lặp thật của sol/feed.py:54.
    usds = []
    for i in range(3):
        p = price.get_price_usd(f"UnreachFeed{i}", "sol")
        usds.append(None if p is None else 100.0 * p)
    assert usds == [None, None, None], usds
    price._warm_prices(
        {
            "meta": {
                "preTokenBalances": [{"mint": "UnreachWarm1"}, {"mint": "UnreachWarm2"}]
            }
        }
    )
    config._gateway_url = good_url
    print(
        "OK (e): gateway unreachable → unknown; feed loop + _warm_prices chạy hết, không raise"
    )

    # (f) gateway body MÉO (mặc định DexScreener) ⇒ unknown, không raise
    _Gateway.mode = "ok"
    for mode in ("notdict", "notjson", "emptybody"):
        _Gateway.mode = mode
        price._info.clear()
        m = f"Malformed{mode}"
        sym, px = price.token_info(m)
        assert (sym, px) == (m[:6] + "…", 0.0), (mode, sym, px)
        assert price.get_price_usd(m + "X") is None, mode
    _Gateway.mode = "ok"
    print("OK (f): envelope méo (list/HTML/body rỗng) → 'price unknown', không raise")

    # (g) QUOTE_SOURCE=gmgn + GMGN body 2xx data không phải dict ⇒ unknown (T18
    #     regression: _gmgn_of từng ném AttributeError RA NGOÀI try).
    os.environ["QUOTE_SOURCE"] = "gmgn"
    _Gateway.mode = "gmgn_baddata"
    price._info.clear()
    sym, px = price.token_info("GmgnBadDataMint")
    assert (sym, px) == ("GmgnBa…", 0.0), (sym, px)
    os.environ.pop("QUOTE_SOURCE", None)
    _Gateway.mode = "ok"
    print(
        "OK (g): GMGN data méo → 'price unknown', không raise (không thoát AttributeError)"
    )

    srv.shutdown()
    print(
        "PASS: price gateway — GMGN + DexScreener đi qua gateway, bỏ gate client, fail-open (T18)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
