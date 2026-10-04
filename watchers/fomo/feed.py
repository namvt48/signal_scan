"""Feed FOMO: MỘT socket firehose `wss://api.fomoapi.io/ws/alerts` — match watch-list
CỤC BỘ (không mở socket per-user), dedupe theo `eventId`, POST TỪNG survivor lên
`/api/fomo-watch/trades`. Không backfill gap sau reconnect (cột display-only).

Alert field → fomo_trades contract (server `parseFomoWatchTradeBody`, đo trên
102/102 alert thật tại `.omo/evidence/fomo-user-watch/task-0-alert-sample.jsonl`):
  alertType buy|sell → `type` (perp/thesis/listing DROP; perp còn null tokenAddress)
  trader (handle, 102/102) → `trader`;  userId (102/102) → `userId`
  eventId (unique 102/102) → `eventId` = khoá idempotency (dedupe + UNIQUE server)
  tokenAddress → `tokenAddress` (server canonical thành `ca`); thiếu → DROP
  chain: solana→sol, base→base, bsc→bsc, robinhood→robinhood; chain khác
    (ethereum/hyperliquid/perp-1337) → DROP (Chain union của repo:
    sol|base|bsc|robinhood)
  ts (epoch ms) → `ts`;  token (ticker) → `token`
  usdValue → `usdValue` — TYPE-DEPENDENT: buy = position size SAU fill
    (= positionValueUsd), sell = realized PnL CÓ DẤU (= realizedPnlUsd). Hai
    hướng KHÔNG cùng đơn vị tiền ⇒ không bao giờ cộng/trừ chéo (plan cấm).
    Là STOCK, không phải flow: cộng nó thành `Buy $` nhân sai số theo số lệnh
    (user 2026-10-01 — iruletrenches bị đọc 285K trong khi GMGN ghi 59.8K).
  tradeUsd → `tradeUsd` (optional, ~17/102 alert) — USD THẬT đã giao dịch, cả buy
    lẫn sell. Đây mới là cơ sở của `Buy $`; vắng mặt ⇒ server fallback.
  price → `price` (optional; không xuất hiện trong capture — pass-through nếu có)
  txHash → `txHash` (optional, chỉ có ở ~17/102 alert) — server dùng để resolve ví
    trader on-chain (opportunistic; thiếu ⇒ bỏ qua, không tạo row).
 Envelope KHÔNG phải trade: type='welcome'/'heartbeat', frame trần 'ping'/'pong'
 (non-JSON) — bỏ qua, không raise. `text` chỉ để log, KHÔNG parse.

State/heartbeat dùng file FOMO-SPECIFIC (`fomo_state.json` / `fomo_heartbeat`) —
KHÔNG dùng path cố định của `watchers/common/state.py`: daemon thứ 2 ghi chung
file sẽ che mất liveness của sol watcher.
"""

import asyncio
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from watchers.common import config
from watchers.common.config import _CFG_REFRESH_S, HERE, api_headers

WS_URL = "wss://api.fomoapi.io/ws/alerts"  # key ride query-string — KHÔNG log full URL
_CHAIN = {
    "solana": "sol",
    "base": "base",
    "bsc": "bsc",
    "robinhood": "robinhood",
}  # ngoài map ⇒ DROP
_SEEN_MAX = 4096  # bound như evm/feed.py _SEEN_MAX

STATE_PATH = os.path.join(HERE, "fomo_state.json")
HEARTBEAT = os.path.join(HERE, "fomo_heartbeat")

# eventId đã emit — replay/reconnect có thể đẩy lại; ponytail: clear-all khi đầy.
_seen: set[str] = set()

# Watch list nạp từ GET /api/fomo-users, refresh mỗi ~_CFG_REFRESH_S (300s) —
# KHÔNG nạp một lần lúc startup (UI đổi list phải có hiệu lực không cần restart).
_wl: dict[str, Any] = {"ids": set(), "handles": set(), "next": 0.0}


# ---------- state FOMO-specific ----------


def _beat() -> None:
    """Touch beacon FOMO (watchdog) — file riêng, không đụng `heartbeat` chung."""
    try:
        open(HEARTBEAT, "w").close()
    except OSError:
        pass


def load_state() -> dict[str, Any]:
    """{last_ts, emitted, seen[]} — file hỏng/chưa có ⇒ state trắng, không raise."""
    global _seen
    try:
        st = json.load(open(STATE_PATH))
        if not isinstance(st, dict):
            st = {}
    except Exception:
        st = {}
    _seen = {e for e in (st.get("seen") or []) if isinstance(e, str)}
    return st


def save_state(st: dict[str, Any]) -> None:
    """Atomic (tmp + replace) như common/state.save_state; seen bị bound _SEEN_MAX."""
    st = {**st, "seen": list(_seen)[-_SEEN_MAX:]}
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATE_PATH)


# ---------- watch list ----------


def refresh_watch_list(force: bool = False) -> None:
    """GET {api}/api/fomo-users → 2 set (userId, handle). Tới hạn ~300s mới fetch
    (force=True bỏ qua đồng hồ — dùng sau 404 'list stale'). Fail-soft: lỗi mạng/
    shape ⇒ GIỮ list cũ (một lần timeout không được xoá watch list). Không raise."""
    if not force and time.time() < _wl["next"]:
        return
    _wl["next"] = time.time() + _CFG_REFRESH_S
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/fomo-users", headers=api_headers()
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
        ids, handles = set(), set()
        for u in data if isinstance(data, list) else []:
            if not isinstance(u, dict):
                continue
            if isinstance(u.get("userId"), str) and u["userId"]:
                ids.add(u["userId"])
            if isinstance(u.get("handle"), str) and u["handle"]:
                handles.add(u["handle"])
        if (ids, handles) != (_wl["ids"], _wl["handles"]):
            print(
                f"# fomo watch list: {len(handles)} handle, {len(ids)} userId",
                flush=True,
            )
        _wl["ids"], _wl["handles"] = ids, handles
    except Exception as ex:
        print(f"  ! fomo-users: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)


def _match(alert_uid: str | None, trader: str | None) -> bool:
    """userId exact TRƯỚC, handle trader SAU (đúng thứ tự server resolve).
    Không bao giờ HỌC user mới từ firehose — chỉ membership test."""
    if alert_uid and alert_uid in _wl["ids"]:
        return True
    return bool(trader and trader in _wl["handles"])


# ---------- frame → body ----------


def _str(m: dict[str, Any], k: str) -> str | None:
    v = m.get(k)
    return v if isinstance(v, str) and v else None


def _num(m: dict[str, Any], k: str) -> float | None:
    v = m.get(k)
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return None


def alert_body(msg) -> dict[str, Any] | None:
    """1 frame đã parse → body POST /api/fomo-watch/trades | None (drop).
    Pure (không mạng, không dedupe) — unit-test offline. Drop: không phải
    type='alert'; alertType ngoài buy/sell (perp/thesis/listing); thiếu
    tokenAddress; chain ngoài sol/base/bsc/robinhood; trader+userId không thuộc watch list;
    thiếu eventId/ts hợp lệ (body server sẽ 400 — không gửi rác)."""
    if not isinstance(msg, dict) or msg.get("type") != "alert":
        return None
    if msg.get("alertType") not in ("buy", "sell"):
        return None
    ca, chain = _str(msg, "tokenAddress"), _CHAIN.get(msg.get("chain") or "")
    if not ca or chain is None:
        return None
    uid, trader = _str(msg, "userId"), _str(msg, "trader")
    if not _match(uid, trader):
        return None
    ev = _str(msg, "eventId")
    ts = _num(msg, "ts")
    if not ev or ts is None or ts <= 0:
        return None
    body: dict[str, Any] = {
        "eventId": ev,
        "type": msg["alertType"],
        "tokenAddress": ca,
        "chain": chain,
        "ts": ts,
    }
    if uid:
        body["userId"] = uid
    if trader:
        body["trader"] = trader
    tok = _str(msg, "token")
    if tok:
        body["token"] = tok
    usd, px = _num(msg, "usdValue"), _num(msg, "price")
    if usd is not None:
        body["usdValue"] = usd
    if px is not None:
        body["price"] = px
    # The USD actually traded. Sent for BOTH directions when the feed resolved the
    # on-chain fill (~17/102 alerts); absent otherwise. This — not usdValue — is
    # what `Buy $` sums (user 2026-10-01).
    trade_usd = _num(msg, "tradeUsd")
    if trade_usd is not None:
        body["tradeUsd"] = trade_usd
    tx_hash = _str(msg, "txHash")
    if tx_hash:
        body["txHash"] = tx_hash
    return body


def _dedupe(ev: str) -> bool:
    """True = lần đầu thấy eventId. Bound như evm _seen_tx: đầy ⇒ clear-all."""
    if ev in _seen:
        return False
    if len(_seen) > _SEEN_MAX:
        _seen.clear()  # ponytail: clear-all; LRU nếu cần chặt
    _seen.add(ev)
    return True


# ---------- emit ----------


def post_fomo_trade(body: dict[str, Any]) -> None:
    """POST 1 survivor (individual, không batch). Fail-soft như emit.post_trade —
    lỗi mạng/HTTP chỉ log stderr, không raise. 404 = 'watch list stale' ⇒ refresh
    NGAY một lần (force), KHÔNG retry body cũ (server vẫn sẽ 404 tới khi có user)."""
    try:
        req = urllib.request.Request(
            f"{config._api_url}/api/fomo-watch/trades",
            data=json.dumps(body).encode(),
            headers=api_headers(),
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except urllib.error.HTTPError as ex:
        if ex.code == 404:
            print(
                f"  ! ingest 404 ({body.get('trader') or body.get('userId')})"
                " — watch list stale, refresh",
                file=sys.stderr,
            )
            refresh_watch_list(force=True)
        else:
            print(f"  ! fomo-trade HTTP {ex.code}", file=sys.stderr)
    except Exception as ex:
        print(f"  ! fomo-trade: {type(ex).__name__}: {str(ex)[:60]}", file=sys.stderr)


def handle_frame(raw, st: dict[str, Any]) -> None:
    """1 frame thô → parse (non-JSON 'ping'/'pong'/rác ⇒ skip, không raise) →
    ignore welcome/heartbeat → alert_body → dedupe → log + POST + save state."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        if not (isinstance(raw, str) and raw.strip() in ("ping", "pong")):
            print(f"  ! frame non-JSON bỏ qua: {raw[:40]!r}", file=sys.stderr)
        return
    if not isinstance(msg, dict) or msg.get("type") in ("welcome", "heartbeat"):
        return
    body = alert_body(msg)
    if body is None or not _dedupe(body["eventId"]):
        return
    st["last_ts"] = max(st.get("last_ts") or 0, body["ts"])
    st["emitted"] = int(st.get("emitted") or 0) + 1
    print(
        f"# fomo {body['type']} {body.get('trader') or body.get('userId')}"
        f" ${body.get('token') or '?'} {body['chain']}"
        f" ≈ ${body.get('usdValue', 0):,.0f}  evt {body['eventId'][:8]}…",
        flush=True,
    )
    post_fomo_trade(body)
    save_state(st)  # lưu MỖI emit ⇒ restart không re-POST (seen-set persist)


# ---------- socket ----------

_BACKOFF_BASE_S = 1.0
_BACKOFF_CAP_S = 60.0
_ONCE_WINDOW_S = 90.0  # --once: đủ dài cho buffered replay (tier delay ~60s)
_RECV_POLL_S = 5.0  # wait_for(recv) — tới hạn để xét điều kiện thoát --once


def _safe(key: str, e: Exception) -> str:
    """Message lỗi KHÔNG được lộ key (key ride query-string ⇒ exception của
    websockets có thể nguyên văn URL)."""
    return f"{type(e).__name__}: {str(e)[:100]}".replace(key, "***")


def run_feed(key: str, ws_url: str = WS_URL, once: bool = False) -> None:
    """Loop chính: connect (lazy import websockets như sol/feed.py), recv →
    handle_frame, đứt ⇒ backoff mũ có trần rồi reconnect (CHẤP NHẬN gap — không
    gọi /v2/alerts backfill). --once: thoát sau emit đầu tiên hoặc hết window."""
    try:
        import websockets
    except ImportError:
        sys.exit("fomo watcher cần:  pip install websockets")

    st = load_state()
    refresh_watch_list(force=True)
    # KHÔNG log full URL — key nằm trong query string.
    print(
        f"# fomo feed: {ws_url}?key=*** | watch {len(_wl['handles'])} handle",
        flush=True,
    )

    async def _beat_loop():
        while True:  # feed im lặng vẫn phải đập nhịp cho watchdog
            _beat()
            await asyncio.sleep(30)

    async def _sock() -> None:
        backoff = _BACKOFF_BASE_S
        deadline = time.monotonic() + _ONCE_WINDOW_S
        while True:
            try:
                async with websockets.connect(
                    f"{ws_url}?key={key}",
                    open_timeout=10,
                    ping_interval=20,
                    max_size=None,
                ) as ws:
                    print("# fomo socket connected", flush=True)
                    backoff, n0 = _BACKOFF_BASE_S, int(st.get("emitted") or 0)
                    _beat()
                    while True:
                        if once and (
                            int(st.get("emitted") or 0) > n0
                            or time.monotonic() >= deadline
                        ):
                            return
                        try:
                            raw = await asyncio.wait_for(
                                ws.recv(), timeout=_RECV_POLL_S
                            )
                        except (TimeoutError, asyncio.TimeoutError):
                            continue  # không frame — lặp lại để xét thoát --once
                        handle_frame(raw, st)
                        refresh_watch_list()  # tới hạn ~300s mới fetch thật
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as e:
                if once:
                    raise SystemExit(f"fomo socket lỗi: {_safe(key, e)}") from None
                print(
                    f"  ! fomo ws đứt ({_safe(key, e)}) -> reconnect sau"
                    f" {backoff:.0f}s (chấp nhận gap, không backfill)",
                    file=sys.stderr,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _BACKOFF_CAP_S)

    async def _run():
        beat = asyncio.create_task(_beat_loop())
        try:
            await _sock()
        finally:
            beat.cancel()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
    finally:
        save_state(st)
        _beat()
    if once:
        print(
            f"# fomo --once xong: emitted={st.get('emitted', 0)}"
            f" last_ts={st.get('last_ts')}"
            + ("" if st.get("emitted") else " — no alerts in window"),
            flush=True,
        )
