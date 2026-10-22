#!/usr/bin/env python3
"""Offline regression cho FOMO swaps poller (`watchers/fomo/feed.py`).

Chạy: python3 scripts/test_fomo_watch.py
Không gọi mạng/API thật: fetch swaps và POST ingest đều được stub.
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from watchers.fomo import feed  # noqa: E402

fail = 0
total = 0


def check(cond, msg):
    global fail, total
    total += 1
    print(("PASS" if cond else "FAIL"), msg)
    fail += not cond


def swap(**overrides):
    value = {
        "id": "swap-1",
        "inTokenAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "outTokenAddress": "0x1111111111111111111111111111111111111111",
        "inHumanAmount": "25",
        "outHumanAmount": "1000",
        "humanUsdAmountIn": 25,
        "humanUsdAmountOut": 25,
        "createdAt": 1760000000000,
        "networkId": 8453,
        "inNetworkId": 8453,
        "outNetworkId": 8453,
    }
    value.update(overrides)
    return value


user = {"identity": "fomo-user-1", "userId": "fomo-user-1", "handle": "midcurver"}

# ---------- swap -> body ----------

body, reason = feed._swap_body(swap(), user)
check(reason is None, "buy: mapped")
check(body and body["type"] == "buy", "buy: type")
check(body and body["tokenAddress"] == "0x1111111111111111111111111111111111111111", "buy: out token is the CA")
check(body and body["chain"] == "base", "buy: network id -> base")
check(body and body["tradeUsd"] == 25, "buy: spent quote leg becomes tradeUsd")
check(body and abs(body["price"] - 0.025) < 1e-12, "buy: price derives from token amount")
check(body and body["eventId"] == "fomo-swap:swap-1", "buy: eventId is the swap id")
check(body and body["userId"] == "fomo-user-1" and body["trader"] == "midcurver", "buy: watch-list identity")

body, reason = feed._swap_body(swap(
    inTokenAddress="0x1111111111111111111111111111111111111111",
    outTokenAddress="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
), user)
check(reason is None and body and body["type"] == "sell", "sell: quote leg is the output")
check(body and body["tokenAddress"] == "0x1111111111111111111111111111111111111111", "sell: in token is the CA")

body, reason = feed._swap_body(swap(createdAt=1760000000), user)
check(body and body["ts"] == 1760000000000, "timestamp: seconds are converted to ms")

body, reason = feed._swap_body(swap(inTokenAddress="0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913"), user)
check(reason is None and body and body["type"] == "buy", "quote assets: EVM addresses compare case-insensitively")

body, reason = feed._swap_body(swap(
    inTokenAddress="0x5FC5360D0400a0Fd4f2af552ADD042D716F1d168",
    outTokenAddress="0x2222222222222222222222222222222222222222",
    networkId=4663, inNetworkId=4663, outNetworkId=4663,
), user)
check(reason is None and body and body["chain"] == "robinhood" and body["type"] == "buy", "robinhood: USDG quote maps to buy")

body, reason = feed._swap_body(swap(networkId=1, inNetworkId=1, outNetworkId=1), user)
check(body is None and reason == "unsupported_chain", "unsupported chain: skipped")
body, reason = feed._swap_body(swap(id=None), user)
check(body is None and reason == "missing_swap_id", "missing swap id: skipped")
body, reason = feed._swap_body(swap(
    inTokenAddress="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    outTokenAddress="0x4200000000000000000000000000000000000006",
), user)
check(body is None and reason == "unclassified_pair", "quote -> quote: skipped")

# ---------- cursor / dedupe / retry ----------

tmp = tempfile.TemporaryDirectory()
feed.STATE_PATH = os.path.join(tmp.name, "fomo_state.json")
feed.HEARTBEAT = os.path.join(tmp.name, "fomo_heartbeat")
feed.FOMO_MONITOR_HEARTBEAT = os.path.join(tmp.name, "monitor_fomo_heartbeat")
feed._seen = set()
feed.FOMO_MONITOR_HEARTBEAT = os.path.join(tmp.name, "monitor_fomo_heartbeat")

posted = []
feed.post_fomo_trade = lambda body, cycle_id=None: (posted.append(body), True)[1]

t0 = 1_760_000_000_000
page = [swap(id="old", createdAt=t0), swap(id="new", createdAt=t0 + 1_000)]
feed._fetch_swaps = lambda identity, cycle_id: list(page)
st = {"cursors": {}}
emitted = feed._poll_user(user, st, "cycle-1")
check(emitted == 0 and posted == [], "bootstrap: first page is not replayed")
check(st["cursors"]["fomo-user-1"] == t0 + 1_001, "bootstrap: cursor starts past the newest swap")

page = [swap(id="old", createdAt=t0), swap(id="new", createdAt=t0 + 1_000), swap(id="newer", createdAt=t0 + 2_000)]
emitted = feed._poll_user(user, st, "cycle-2")
check(emitted == 1 and len(posted) == 1, "poll: only swaps after the cursor are emitted")
check(posted[0]["eventId"] == "fomo-swap:newer", "poll: emitted the newest swap")
check(st["cursors"]["fomo-user-1"] == t0 + 2_000, "poll: cursor advanced")
feed._poll_user(user, st, "cycle-3")
check(len(posted) == 1, "poll: re-reading the same page dedupes")

# Failed ingest must not advance the cursor; the retry succeeds next cycle.
feed._seen = set()
st = {"cursors": {"fomo-user-1": 0}}
page = [swap(id="retry-me", createdAt=t0 + 3_000)]
feed.post_fomo_trade = lambda body, cycle_id=None: False
emitted = feed._poll_user(user, st, "cycle-4")
check(emitted == 0 and st["cursors"]["fomo-user-1"] == 0, "retry: failed ingest keeps the cursor")
feed.post_fomo_trade = lambda body, cycle_id=None: (posted.append(body), True)[1]
emitted = feed._poll_user(user, st, "cycle-5")
check(emitted == 1 and st["cursors"]["fomo-user-1"] == t0 + 3_000, "retry: next cycle emits and advances")

check(feed._seen == {"fomo-swap:retry-me"}, "dedupe: acknowledged event is remembered")

# Two fills in the same millisecond must both be emitted; the cursor boundary is
# revisited and dedupe prevents a replay.
feed._seen = set()
posted = []
st = {"cursors": {"fomo-user-1": t0 + 3_000}}
page = [swap(id="same-a", createdAt=t0 + 4_000), swap(id="same-b", createdAt=t0 + 4_000)]
feed.post_fomo_trade = lambda body, cycle_id=None: (posted.append(body), True)[1]
emitted = feed._poll_user(user, st, "cycle-6")
check(emitted == 2 and len(posted) == 2, "same-ms fills: both emitted")
check(st["cursors"]["fomo-user-1"] == t0 + 4_000, "same-ms fills: cursor advances once")
posted = []
feed._poll_user(user, st, "cycle-7")
check(posted == [], "same-ms fills: boundary re-read dedupes")

tmp.cleanup()
print(f"\n{total - fail}/{total} checks passed")
sys.exit(1 if fail else 0)
