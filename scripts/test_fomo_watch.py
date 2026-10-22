#!/usr/bin/env python3
"""Offline regression cho FOMO swaps poller (`watchers/fomo/feed.py`).

Chạy: python3 scripts/test_fomo_watch.py
Không gọi mạng/API thật: fetch swaps và POST ingest đều được stub.
"""

import json
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

body, reason = feed._swap_body(swap(createdAt="2026-10-21T01:58:15.000Z"), user)
check(body and body["ts"] == 1792547895000, "timestamp: ISO strings are converted to ms")

body, reason = feed._swap_body(swap(inTokenAddress="0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913"), user)
check(reason is None and body and body["type"] == "buy", "quote assets: EVM addresses compare case-insensitively")

body, reason = feed._swap_body(swap(
    inTokenAddress="0x5FC5360D0400a0Fd4f2af552ADD042D716F1d168",
    outTokenAddress="0x2222222222222222222222222222222222222222",
    networkId=4663, inNetworkId=4663, outNetworkId=4663,
), user)
check(reason is None and body and body["chain"] == "robinhood" and body["type"] == "buy", "robinhood: USDG quote maps to buy")

body, reason = feed._swap_body(swap(
    inTokenAddress="0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    outTokenAddress="0x3333333333333333333333333333333333333333",
    networkId=56, inNetworkId=56, outNetworkId=56,
), user)
check(reason is None and body and body["chain"] == "bsc" and body["type"] == "buy", "bsc: WBNB quote maps to buy")

body, reason = feed._swap_body(swap(networkId=1, inNetworkId=1, outNetworkId=1), user)
check(body is None and reason == "unsupported_chain", "unsupported chain: skipped")
body, reason = feed._swap_body(swap(id=None), user)
check(body is None and reason == "missing_swap_id", "missing swap id: skipped")
body, reason = feed._swap_body(swap(
    inTokenAddress="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    outTokenAddress="0x4200000000000000000000000000000000000006",
), user)
check(body is None and reason == "unclassified_pair", "quote -> quote: skipped")

# Watch-list refresh keeps only UUID identities: prod rejects handles with 400.
feed._request_bytes_with_retry = lambda req, on_attempt=None, timeout=None: __import__("json").dumps([
    {"userId": "uuid-1", "handle": "one"},
    {"userId": "", "handle": "handle-only"},
    {"userId": "uuid-1", "handle": "duplicate"},
]).encode()
feed._wl = {"users": [], "next": 0.0, "skipped": 0}
feed.refresh_watch_list(force=True)
check([u["identity"] for u in feed._wl["users"]] == ["uuid-1"], "watch list: handle-only rows are skipped")
check(feed._wl["skipped"] == 1, "watch list: skipped count is reported")

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


# ---------- EVM CA refresh ----------

feed._evm = {"cas": [], "next": 0.0}
feed._request_bytes_with_retry = lambda req, timeout=None: json.dumps([
    {"chain": "robinhood", "address": "0xAAA", "status": "active"},
    {"chain": "robinhood", "address": "0xAAA", "status": "active"},
    {"chain": "bsc", "address": "0xBBB", "status": "inactive"},
    {"chain": "base", "address": "", "status": "active"},
    {"chain": "sol", "address": "So111", "status": "active"},
    {"chain": "bsc", "address": "0xCCC", "status": "queued"},
]).encode()
feed.refresh_evm_cas(force=True)
check(feed._evm["cas"] == [
    {"chain": "robinhood", "address": "0xAAA"},
    {"chain": "bsc", "address": "0xCCC"},
], "evm CAs: active EVM rows only, deduped")

# ---------- EVM token feed ----------

def feed_item(**overrides):
    value = {
        "type": "swap_buy",
        "id": "feed-1",
        "createdAt": t0,
        "userId": "fomo-user-1",
        "userHandle": "midcurver",
        "usdAmount": 1000,
        "price": 0.01,
    }
    value.update(overrides)
    return value


evm_ca = "0x30de7ae4c9578d110a97367ede9f7765cdce06ea"
body, reason = feed._feed_body(feed_item(), "robinhood", evm_ca)
check(reason is None and body is not None, "evm feed: buy mapped")
check(body and body["eventId"] == "fomo-feed:feed-1", "evm feed: feed id is the event id")
check(body and body["type"] == "buy" and body["chain"] == "robinhood", "evm feed: buy chain")
check(body and body["tradeUsd"] == 1000 and body["usdValue"] == 1000, "evm feed: buy size")
check(body and body["userId"] == "fomo-user-1" and body["trader"] == "midcurver", "evm feed: identity")
check(body and body["price"] == 0.01, "evm feed: price")

body, reason = feed._feed_body(feed_item(type="swap_sell"), "base", evm_ca)
check(body and body["type"] == "sell" and "usdValue" not in body, "evm feed: sell has no entry size")

body, reason = feed._feed_body(feed_item(type="thesis"), "bsc", evm_ca)
check(body is None and reason == "not_swap", "evm feed: thesis ignored")
body, reason = feed._feed_body(feed_item(userId=None), "bsc", evm_ca)
check(body is None and reason == "missing_user_id", "evm feed: anonymous event ignored")

feed._seen = set()
feed.post_fomo_trade = lambda body, cycle_id=None: (posted.append(body), True)[1]

evm_page = [
    feed_item(id="evm-old", createdAt=t0),
    feed_item(id="evm-new", createdAt=t0 + 1_000),
]
feed._fetch_token_feed = lambda chain, ca, cycle_id: list(evm_page)
feed.FOMO_EVM_BOOTSTRAP_LOOKBACK_S = 0
st = {"evm_cursors": {}}
posted = []
emitted, size, ok = feed._poll_evm_ca({"chain": "robinhood", "address": evm_ca}, {"fomo-user-1"}, st, "evm-1")
check(ok and emitted == 0 and posted == [], "evm feed: bootstrap is not replayed")
check(st["evm_cursors"][f"robinhood:{evm_ca}"] == t0 + 1_001, "evm feed: cursor starts past newest")

# New tracked CA: keep a grace window so the buy that triggered tracking is
# ingested instead of being dropped by the bootstrap skip.
feed.FOMO_EVM_BOOTSTRAP_LOOKBACK_S = 900
feed._seen = set()
st = {"evm_cursors": {}}
posted = []
evm_page = [
    feed_item(id="evm-stale", createdAt=t0 - 2_000_000),
    feed_item(id="evm-recent", createdAt=t0),
]
emitted, size, ok = feed._poll_evm_ca({"chain": "robinhood", "address": evm_ca}, {"fomo-user-1"}, st, "evm-grace")
check(ok and emitted == 1 and len(posted) == 1, "evm feed: bootstrap grace ingests recent watched buy")
check(posted[0]["eventId"] == "fomo-feed:evm-recent", "evm feed: grace skips stale history")
feed.FOMO_EVM_BOOTSTRAP_LOOKBACK_S = 900
feed._seen = set()
posted = []

evm_page = [
    feed_item(id="unwatched", createdAt=t0 + 2_000, userId="other-user"),
    feed_item(id="watched", createdAt=t0 + 3_000),
]
emitted, size, ok = feed._poll_evm_ca({"chain": "robinhood", "address": evm_ca}, {"fomo-user-1"}, st, "evm-2")
check(ok and emitted == 1 and len(posted) == 1, "evm feed: only watched users are posted")
check(posted[0]["eventId"] == "fomo-feed:watched", "evm feed: watched event emitted")
check(st["evm_cursors"][f"robinhood:{evm_ca}"] == t0 + 3_000, "evm feed: cursor advanced")
posted = []
feed._poll_evm_ca({"chain": "robinhood", "address": evm_ca}, {"fomo-user-1"}, st, "evm-3")
check(posted == [], "evm feed: re-reading dedupes")

feed._seen = set()
st = {"evm_cursors": {f"robinhood:{evm_ca}": 0}}
evm_page = [feed_item(id="evm-retry", createdAt=t0 + 4_000)]
feed.post_fomo_trade = lambda body, cycle_id=None: False
emitted, size, ok = feed._poll_evm_ca({"chain": "robinhood", "address": evm_ca}, {"fomo-user-1"}, st, "evm-4")
check(ok and emitted == 0 and st["evm_cursors"][f"robinhood:{evm_ca}"] == 0, "evm feed: failed ingest keeps cursor")
feed.post_fomo_trade = lambda body, cycle_id=None: (posted.append(body), True)[1]
emitted, size, ok = feed._poll_evm_ca({"chain": "robinhood", "address": evm_ca}, {"fomo-user-1"}, st, "evm-5")
check(emitted == 1 and st["evm_cursors"][f"robinhood:{evm_ca}"] == t0 + 4_000, "evm feed: retry succeeds")

tmp.cleanup()
print(f"\n{total - fail}/{total} checks passed")
sys.exit(1 if fail else 0)
