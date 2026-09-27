"""Detector Solana: đọc leg spl-token transfer đã parse của getTransaction rồi
suy ra từng BƯỚC swap (side/amount/base-quote), cộng nhóm event TRANSFER
(rule A). Không network — chỉ đọc cache của common.price.

Tách từ scripts/wallet_watch.py (T7) — dời nguyên văn.
"""

import time
from collections import defaultdict
from datetime import datetime
from typing import Any

from watchers.common.config import ICT, USDC, USDT, WSOL, quotes_map
from watchers.common.price import _info, _info_miss, _sol_px


def dbase(mint, decimals):
    return decimals.get(mint, 9 if mint == WSOL else 6)


def _amt(t):
    """Amount thô + decimals của một balance entry (jsonParsed); chịu cả schema
    chỉ có uiTokenAmount (publicnode) lẫn tokenAmount chuẩn."""
    a = t.get("tokenAmount") or t.get("uiTokenAmount") or {}
    s = str(a.get("amount") or a.get("uiAmountString") or "0")
    dec = a.get("decimals", 0)
    if "." not in s:
        return int(s), dec
    ip, fp = s.split(".")
    return int(ip + (fp + "0" * dec)[:dec]), dec


# ---------- swap/DEX program registry (detect_swaps — plan §3 Bước 2) ----------
#
# detect_swaps lọc enclosing-program theo DENYLIST (_PLUMBING ∪ _TOKEN_PROGS ∪
# _AGGREGATORS) nên DEX lạ tự lọt — registry dưới đây không phải điều kiện chạy,
# giữ làm tài liệu program-id → tên người đọc và là nguồn của _AGGREGATORS.
# Tại sao đọc leg transfer thay vì decode instruction DEX: getTransaction
# jsonParsed trả payload base58 thô cho mọi program DEX (pump.fun, Jupiter v6,
# Raydium, Orca, Meteora, DFlow là anchor/BPF, RPC không ship IDL) ⇒ tín hiệu
# schema-stable duy nhất là các instruction spl-token transfer đã parse mà
# chúng phát ra. Registry/decimals/quyết định đều ở module-level nên stream
# live không phải suy lại per event; detect_swaps không gọi network (chỉ đọc
# cache _info/_sol_px).

# program id -> human name (tài liệu; xem denylist mới là điều kiện lọc).
_SWAP_PROGRAMS = {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "pump.fun AMM",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CPMM",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
    "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH": "DFlow Aggregator v4",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM (v2)",
}
# §4.1 phantom: pump.fun router dùng luôn ATA của user làm trạm trung chuyển nên
# leg base khớp ra pool dù ví KHÔNG nhúc nhích mint đó (EVIDENCE §3). Scope pump là
# fit n=2 trên oracle — rule ngữ nghĩa đầy đủ chỉ là `wflat`, mở scope khi có oracle.
_PUMP_ROUTE = frozenset(
    {
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    }
)
# base/quote rank seeds for the mint-graph BFS (plan §2.4).  rank 0.0 = TIER_A
# (global quote currencies), rank 0.5 = TIER_B (WBTC).  A BTC-peg mint
# (WBTC/cbBTC/XBT) must NEVER appear in TIER_A.  Addresses are derived from
# scripts/fixtures/gmgn_rows_fixture.json (quote_token.token_address) — the two
# mainnet-only entries are marked, everything else comes from the 29 rows.
TIER_A = {
    WSOL,  # So11111111111111111111111111111111111111112 — fixture row 9 quote_token.token_address
    USDC,  # EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v — fixture row 1 quote_token.token_address
    USDT,  # Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB — mainnet constant, NOT in the 29-row fixture
    "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o",  # DAI — mainnet constant, NOT in the 29-row fixture
}
TIER_B = {
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",  # WBTC — fixture row 22 quote_token.token_address
    # add wETH-Wormhole 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs when a route uses it
}
# router aggregators — the named Jupiter/DFlow entries in _SWAP_PROGRAMS above.
# Excluded from the enclosing-program denylist so the real DEX underneath wins.
_AGGREGATORS = {
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  # _SWAP_PROGRAMS: Jupiter v6
    "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",  # _SWAP_PROGRAMS: DFlow Aggregator v4
}
# instruction plumbing — never a swap program
_PLUMBING = {
    "11111111111111111111111111111111",
    "ComputeBudget111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
}
# token program ids — chương trình DUY NHẤT có parsed transfer được nhận làm leg
_TOKEN_PROGS = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}
# parsed spl-token transfer types được nhận làm swap leg
_XFER_TYPES = (
    "transfer",
    "transferChecked",
    "transferCheckedWithFee",
    "transferWithFee",
)


def _keys(msg, meta) -> list[str]:
    ks = [ak["pubkey"] for ak in msg.get("accountKeys") or []]
    la = (meta or {}).get("loadedAddresses") or {}  # v0/ALT
    ks += (la.get("writable") or []) + (la.get("readonly") or [])
    return ks


def _sym(mint) -> str:
    """Cache-only ticker (no network): quotes_map -> _info -> short mint."""
    if not mint:
        return ""
    ti = _info.get(mint)
    return quotes_map.get(mint) or (ti[0] if ti else None) or (mint[:6] + "…")


# ---------- per-step swap detector (GMGN row parity — plan §3 Bước 1-5) ----------
#
# detect_swaps(): 1 event = 1 bước swap qua 1 pool (đúng semantics 1 row GMGN,
# §2.1). Nguồn sự thật DUY NHẤT: parsed SPL transfer legs + pre/postTokenBalances.
# Đã thử và LOẠI (đừng thử lại): Jupiter logMessages/SwapEvent (chỉ 2/9 tx;
# 58pWphuG có 5 SwapEvent vs 4 row oracle) và `Program data:` base64 (không chứa
# net/fee). Amount = GROSS leg: LP fee KHÔNG tồn tại trong payload getTransaction
# (§2.2) ⇒ amount_basis="gross_leg" là HẰNG SỐ trên mọi event, cấm suy per-row từ
# delta balance hay field GMGN (MB1). Không network — chỉ đọc cache _info/_sol_px.


def _frames(msg, meta):
    """Yield (top_ix, seq, height, ix, stack) cho MỌI instruction instance theo
    thứ tự thực thi. stack = [(programId, invocation_seq)] của các frame bao
    ngoài, RESET ở mỗi top-level ix (bug cũ: không reset ⇒ leg của ix này bị gán
    frame của ix trước). seq = ordinal lời gọi toàn tx (tie-break |seq_base −
    seq_quote| Bước 3). Frame cha = stack[-2]; thiếu stackHeight ⇒ giả định con
    kế tiếp (fixture/RPC thật luôn có stackHeight)."""
    groups = {}
    for g in meta.get("innerInstructions") or []:
        groups.setdefault(g.get("index"), []).extend(g.get("instructions") or [])
    seq = 0
    for ti, top in enumerate(msg.get("instructions") or []):
        stack = []
        for cur in [top, *(groups.get(ti) or [])]:
            h = cur.get("stackHeight") or len(stack) + 1
            del stack[h - 1 :]
            stack.append((cur.get("programId"), seq))
            yield ti, seq, h, cur, stack[:]
            seq += 1


def _bal_tables(meta, keys):
    """owner/pre/post per token-account + decimals, mint per token-account,
    decimals per-mint từ pre/postTokenBalances — pair theo accountIndex, KHÔNG
    zip vị trí (hai list lệch nhau khi account mở/đóng giữa tx, F32)."""
    own, pre_a, post_a, dec_of, mint_of = {}, {}, {}, {}, {}
    for store, which in ((pre_a, "preTokenBalances"), (post_a, "postTokenBalances")):
        for t in meta.get(which) or []:
            i = t.get("accountIndex")
            if isinstance(i, int) and 0 <= i < len(keys):
                a = keys[i]
                own[a] = t.get("owner") or own.get(a)
                store[a] = _amt(t)[0]
                mint_of[a] = t.get("mint")
            if t.get("mint") is not None:
                dec_of.setdefault(t["mint"], _amt(t)[1])
    return own, pre_a, post_a, dec_of, mint_of


_FEE_REJECT_REASONS = frozenset({"aggregator_frame", "plumbing", "no_pool_endpoint"})


def _fee_candidate(
    src, dst, mint, raw, dec, frame, seq, reason, rs, rd, stack, parent, ix, own
):
    """Snapshot leg đã bị reject để `detect_swaps` xét fee-leg Option A SAU KHI có
    paired steps. Đây là side-channel, không đổi quyết định reject. `program` lấy
    aggregator gần nhất khi bị aggregator_frame, ngược lại program cha — không dùng
    `encl` vì leg reject có thể không có enclosing DEX hợp lệ."""
    if reason == "aggregator_frame":
        program = next((q for q, _s in reversed(stack) if q in _AGGREGATORS), None)
    else:
        program = parent[0] or ix.get("programId")
    return {
        "mint": mint,
        "src": src,
        "dst": dst,
        "dst_owner": own.get(dst),
        "raw": raw,
        "dec": dec,
        "frame": frame,
        "seq": seq,
        "reason": reason,
        "rs": rs,
        "rd": rd,
        "program": program,
        "prog_stack": [q for q, _s in stack],
    }


def _legs_with_roles(tx, wallet, trace=None, rejected=None, anchored=None):
    """Bước 1+2 + roles Bước 3. Leg = parsed SPL transfer dưới token program,
    frame_id = instance-path (top_i, height, parent_program, invocation_seq) —
    KHÔNG phải program-id trần (3BbWVS3K gọi cùng program 3× cho 3 pool ⇒ gộp
    theo id sẽ merge 3 step thành 1, bug F9). enclosing_program = program gần
    nhất trên stack ∉ _PLUMBING ∪ token ∪ _AGGREGATORS (reject-by-denylist: DEX
    lạ tự lọt; fee leg do aggregator CPI ⇒ encl=aggregator ⇒ loại). Role endpoint
    thuần bằng balance: WALLET > RELAY (vắng hoặc Δ=0) > POOL. Mỗi leg/instruction
    bị loại ⇒ trace `REJECT <frame> <mint> <reason>`."""
    meta = tx.get("meta") or {}
    msg = tx["transaction"]["message"]
    keys = _keys(msg, meta)  # giữ ALT merge cho tx v0 thật; fixture: 0 ALT
    own, pre_a, post_a, dec_of, mint_of = _bal_tables(meta, keys)

    def role(a):
        if a is not None and own.get(a) == wallet:
            return "WALLET"
        if a not in pre_a and a not in post_a:
            return "RELAY"
        return "POOL" if post_a.get(a, 0) - pre_a.get(a, 0) != 0 else "RELAY"

    def wflat(a):
        """Tài khoản ví đang GIỮ mint này suốt tx: có row cả pre lẫn post, giá trị
        bằng nhau và ≠ 0. pre==post==0 hoặc vắng row = trạm trung chuyển rỗng —
        GMGN vẫn list hop đó (5/29 nhãn thật), nên chỉ ≠ 0 mới là phantom §4.1."""
        p = pre_a.get(a)
        return p is not None and p == post_a.get(a) != 0

    def rej(frame, mint, why):
        if trace:
            trace(f"REJECT {frame} {mint or '-'} {why}")

    def cap_fee(src, dst, mint, raw, dec, frame, seq, reason, stack, parent, ix):
        """Điều kiện (a) lọc ngay tại reject site; (b)(c) cần paired steps nên lọc
        ở `detect_swaps`."""
        if rejected is None or reason not in _FEE_REJECT_REASONS:
            return
        rs, rd = role(src), role(dst)
        if rs != "WALLET":
            return
        rejected.append(
            _fee_candidate(
                src,
                dst,
                mint,
                raw,
                dec,
                frame,
                seq,
                reason,
                rs,
                rd,
                stack,
                parent,
                ix,
                own,
            )
        )

    deny = _PLUMBING | _TOKEN_PROGS | _AGGREGATORS
    legs = []
    for ti, seq, h, ix, stack in _frames(msg, meta):
        parent = stack[-2] if len(stack) >= 2 else (None, None)
        frame = (ti, h, parent[0], parent[1])
        p = ix.get("parsed")
        if not (
            isinstance(p, dict)
            and p.get("type") in _XFER_TYPES
            and ix.get("programId") in _TOKEN_PROGS
        ):
            rej(frame, None, "not_spl")
            continue
        info = p.get("info") or {}
        src, dst = info.get("source"), info.get("destination")
        mint = info.get("mint") or mint_of.get(src) or mint_of.get(dst)
        ta = info.get("tokenAmount") or {}
        try:
            raw = int(str(info.get("amount") or ta.get("amount") or ""))
        except (TypeError, ValueError):
            rej(frame, mint, "not_spl")
            continue
        dec = info.get("decimals") or ta.get("decimals") or dbase(mint or "", dec_of)
        # "swap-anchored": leg ví chạm tới nằm trong frame program ∈ _SWAP_PROGRAMS
        # (phủ cả leg reject + cả 2 chiều ví; JUP stake ∉ registry ⇒ withdraw không tính)
        if (
            anchored is not None
            and mint
            and (own.get(src) == wallet or own.get(dst) == wallet)
            and any(q in _SWAP_PROGRAMS for q, _s in stack)
        ):
            anchored.add(mint)
        encl = next((q for q, _s in reversed(stack[:-1]) if q not in deny), None)
        if encl is None:
            why = (
                "aggregator_frame"
                if any(q in _AGGREGATORS for q, _s in stack)
                else "plumbing"
            )
            cap_fee(src, dst, mint, raw, dec, frame, seq, why, stack, parent, ix)
            rej(frame, mint, why)
            continue
        rs, rd = role(src), role(dst)
        if (rs == "POOL") == (rd == "POOL"):
            cap_fee(
                src,
                dst,
                mint,
                raw,
                dec,
                frame,
                seq,
                "no_pool_endpoint",
                stack,
                parent,
                ix,
            )
            rej(frame, mint, "no_pool_endpoint")  # 0 POOL (junk) hoặc 2 POOL (AMBIG)
            continue
        legs.append(
            {
                "mint": mint,
                "src": src,
                "dst": dst,
                "raw": raw,
                "dec": dec,
                "frame": frame,
                "encl": encl,
                "seq": seq,
                "rs": rs,
                "rd": rd,
                "wflat": (rs == "WALLET" and wflat(src))
                or (rd == "WALLET" and wflat(dst)),
                "pool": own.get(src if rs == "POOL" else dst),
            }
        )
    return legs


def _match_pairs(cands):
    """Ghép greedy các cặp distinct-mint chưa used theo min |Δseq| (tie-break
    seq ⇒ deterministic). Trả (pairs, n_candidate) — n_candidate > 1 ⇒ nhãn
    by=seq_gap."""
    free = [lg for lg in cands if not lg.get("used")]
    pairs = sorted(
        (abs(a["seq"] - b["seq"]), a["seq"], b["seq"], a, b)
        for i, a in enumerate(free)
        for b in free[i + 1 :]
        if a["mint"] != b["mint"]
    )
    out = []
    for _gap, _sa, _sb, a, b in pairs:
        if not a.get("used") and not b.get("used"):
            a["used"] = b["used"] = True
            out.append((a, b))
    return out, len(pairs)


def _pair_steps(legs, trace=None):
    """Bước 3 pairing: primary = CÙNG frame_id + 2 mint phân biệt (plan §3:
    'pair 2 leg thành 1 step khi chúng ở cùng frame_id'); fallback khi frame
    không tách được = cùng pool_key + 2 mint phân biệt; nhiều ứng viên ⇒ greedy
    min |Δseq|. KHÔNG đòi cùng pool_key ở primary — đã đo: escrow-DEX
    (ZERo/ALPHA/MNFST) có vault owner KHÁC NHAU giữa 2 leg của cùng 1 swap
    (FyhWbqUr vs 2Xfc8WFf, 5e7YKt vs GJrFmC), pool-shared chỉ đúng với
    AMM vault (pAMM/CPMMoo/CAMM/LBUZ/BiSoNH/QuaNt). Leg thừa ⇒ REJECT
    same_mint / unpaired."""
    steps, by_pool, by_frame = [], defaultdict(list), defaultdict(list)
    for lg in legs:
        by_pool[lg["pool"]].append(lg)
        by_frame[lg["frame"]].append(lg)
    for frame, fg in by_frame.items():
        if len(fg) < 2:
            continue
        got, nc = _match_pairs(fg)
        steps += [
            (a, b, frame, a["pool"], "frame" if nc == 1 else "seq_gap") for a, b in got
        ]
    for pool, group in by_pool.items():
        left = [lg for lg in group if not lg.get("used")]
        if len(left) < 2:
            continue
        got, nc = _match_pairs(left)
        for a, b in got:
            f = a["frame"] if a["seq"] <= b["seq"] else b["frame"]
            steps.append((a, b, f, pool, "pool_key" if nc == 1 else "seq_gap"))
    for group in by_pool.values():
        for lg in group:
            if lg.get("used"):
                continue
            alt = any(o is not lg and o["mint"] != lg["mint"] for o in group)
            if trace:
                why = "unpaired" if alt else "same_mint"
                trace(f"REJECT {lg['frame']} {lg['mint']} {why}")
    return steps


def _rank_mints(pairs):
    """Bước 4: rank mint = BFS trên đồ thị cặp-mint của RIÊNG tx. Seed TIER_A
    = 0.0 (FIFO trước) rồi TIER_B = 0.5; rank[y] = rank[x] + 1; không reach ⇒
    mặc định 99 ở _base_quote. sorted() ở seed lẫn neighbor ⇒ deterministic."""
    adj = defaultdict(set)
    for a, b in pairs:
        if a and b and a != b:
            adj[a].add(b)
            adj[b].add(a)
    rank, queue = {}, []
    for tier, r0 in ((TIER_A, 0.0), (TIER_B, 0.5)):
        for m in sorted(adj):
            if m in tier and m not in rank:
                rank[m] = r0
                queue.append(m)
    while queue:
        x = queue.pop(0)
        for y in sorted(adj[x]):
            if y not in rank:
                rank[y] = rank[x] + 1.0
                queue.append(y)
    return rank


def _base_quote(m1, m2, rank):
    """Bước 4 rule 3-5: rank thấp = quote, cao = base; bằng nhau (kể cả cùng
    không reach = 99) ⇒ lex-nhỏ-hơn = base + quote_inferred. Đã đo: mint OS
    8LstZp… < CARDS CARDScc… ⇒ base = OS đúng oracle cả 3 row OS↔CARDS. Row tie
    fail ⇒ detector sai, KHÔNG đảo rule."""
    r1, r2 = rank.get(m1, 99.0), rank.get(m2, 99.0)
    if r1 != r2:
        return (m1, m2, False) if r1 > r2 else (m2, m1, False)
    return (m1, m2, True) if m1 < m2 else (m2, m1, True)


def _dsym(mint) -> str:
    """Symbol cache-first: _info (fixture/DexScreener) rồi mới quotes_map qua
    _sym — oracle cần quote WSOL hiện 'WSOL', không phải 'SOL'."""
    ti = _info.get(mint)
    return (ti[0] if ti else None) or _sym(mint)


def _quote_px(qm):
    """Giá quote theo đúng cache của `_swap_event`; fee leg kế thừa path này."""
    return (
        _sol_px["v"]
        if qm == WSOL
        else 1.0
        if qm in (USDC, USDT)
        else (_info.get(qm) or (None, 0.0))[1]
    )


def _symbol_pending(m):
    return m not in quotes_map and (m not in _info or m in _info_miss)


# Ngưỡng lệch cho guard quote-token ở `_swap_event`: quote là token thường ⇒ giá
# cache có thể sai; tx có neo USD thật (net USDC/USDT/SOL của ví) thì leg lệch quá
# ngưỡng này so với neo bị coi là rác và trả về usd_pending thay vì ghi số ảo
# (sự cố 2026-09-24: leg $500 ghi thành $2.5M). Rộng rãi để không cắt oan route
# chia phần (Jupiter split), vẫn chặn mọi lệch ≥ 50×.
QUOTE_USD_GUARD = 50.0
QUOTE_USD_GUARD_MIN = 1.0  # neo nhỏ hơn $1 không đủ tin để làm mốc


def _swap_event(tx, wallet, sig, ts, sa, sb, pool, rank, net_map=None, tot_map=None):
    """Bước 5 — `qty` = amount GROSS của leg base (parsed instruction, decimals từ
    balances; nhãn per-step đã soát tay khớp GMGN — xem test_wallet_watch.py).
    `qty_net` = phần NET của ví cho mint đó, chia tỉ lệ theo gross từng hop ⇒
    nhiều hop cùng mint (SOLCAT 3 hop) vẫn cộng ra đúng net ví, không đếm trùng.
    quote_usd = quote_qty × price cache (WSOL ⇒ _sol_px, USDC/USDT ⇒ 1.0);
    CHƯA BIẾT GIÁ ⇒ None + usd_pending (§5.2: không bịa 0) và KHÔNG drop
    (§5.3/§9.2: ngưỡng detect = 0 hằng số; gate $50 nằm ở server
    POST /api/tracked-cas — detector không được tự bỏ trade thật).
    Trả (event, base_leg, base_mint, quote_mint)."""
    bm, qm, inferred = _base_quote(sa["mint"], sb["mint"], rank)
    bl, ql = (sa, sb) if sa["mint"] == bm else (sb, sa)
    qty = bl["raw"] / 10 ** bl["dec"]
    qq = ql["raw"] / 10 ** ql["dec"]
    # USDC/USDT neo $1 — _info không cache stablecoin ⇒ hardcode, không network
    px = _quote_px(qm)
    qusd = qq * px if px else None  # None = chưa biết giá, KHÔNG phải giá 0
    if qusd and qm not in (WSOL, USDC, USDT) and net_map:
        anchor = (
            abs(net_map.get(USDC, 0.0))
            + abs(net_map.get(USDT, 0.0))
            + abs(net_map.get(WSOL, 0.0)) * _sol_px["v"]
        )
        if anchor >= QUOTE_USD_GUARD_MIN and not (
            anchor / QUOTE_USD_GUARD <= qusd <= anchor * QUOTE_USD_GUARD
        ):
            qusd = None
    pend = _symbol_pending

    # net ví cho mint này (chain truth) — None khi ví không đổi số dư mint đó
    n_mint = net_map.get(bm, 0.0) if net_map else 0.0
    g_mint = tot_map.get(bm, 0.0) if tot_map else 0.0
    qty_net = qty * n_mint / g_mint if (n_mint and g_mint > 0) else None
    ev = {
        "ts": ts,
        "slot": tx.get("slot"),
        "sig": sig,
        "wallet": wallet,
        "side": "BUY" if bl["rs"] == "POOL" else "SELL",  # POOL là src ⇒ BUY (§B3)
        "mint": bm,
        "sym": _dsym(bm),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": _dsym(qm),
        "quote_qty": qq,
        "quote_usd": qusd,
        "qty_net": qty_net,
        "unit_price": qq / qty if qty else 0.0,
        "pool": pool,
        "program": bl["encl"],
        "amount_basis": "gross_leg",
        "quote_inferred": inferred,
        "symbol_pending": bool(pend(bm) or pend(qm)),
        "usd_pending": not qusd,
        "type": "SWAP",
    }
    return ev, bl, bm, qm


def _fee_event(tx, wallet, sig, ts, cand, buy_ev):
    """Fee-leg Option A: leg phí bị reject nhưng là SELL thật của ví, gắn với BUY
    step cùng base mint gần nhất. Không suy quote/unit_price riêng — kế thừa BUY
    event để giữ parity Nansen. `qty_net` luôn bằng gross fee vì `net_adj` đã cộng
    phần phí này trở lại net owner trước khi chia cho các step thường."""
    qty = cand["raw"] / 10 ** cand["dec"]
    qm = buy_ev["quote_mint"]
    up = buy_ev["unit_price"]
    qq = qty * up
    px = _quote_px(qm)
    qusd = qq * px if px else None
    return {
        "ts": ts,
        "slot": tx.get("slot"),
        "sig": sig,
        "wallet": wallet,
        "side": "SELL",
        "mint": cand["mint"],
        "sym": _dsym(cand["mint"]),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": buy_ev["quote_sym"],
        "quote_qty": qq,
        "quote_usd": qusd,
        "qty_net": qty,
        "unit_price": up,
        "pool": "",
        "program": cand["program"],
        "amount_basis": "gross_leg",
        "quote_inferred": buy_ev["quote_inferred"],
        "symbol_pending": buy_ev["symbol_pending"],
        "usd_pending": not qusd,
        "type": "SWAP",
        "fee_leg": True,
    }


def _promote_fee_candidates(rejected, steps, rank):
    """B1 + (c): candidate chỉ promote khi dst/dst_owner không phải pool account/pool
    owner của bất kỳ paired step nào trong chính tx, và có BUY step cùng base mint.
    Chọn BUY base leg gần nhất theo |Δseq|, tie-break seq (giống `_match_pairs`)."""
    pool_refs: set[str] = set()
    buy_base_legs: dict[str, list[dict[str, Any]]] = {}
    for sa, sb, _frame, pool, _by in steps:
        if pool is not None:
            pool_refs.add(pool)
        for lg in (sa, sb):
            if lg["rs"] == "POOL" and lg["src"] is not None:
                pool_refs.add(lg["src"])
            if lg["rd"] == "POOL" and lg["dst"] is not None:
                pool_refs.add(lg["dst"])
        bm, _qm, _inf = _base_quote(sa["mint"], sb["mint"], rank)
        bl = sa if sa["mint"] == bm else sb
        if bl["rs"] == "POOL":
            buy_base_legs.setdefault(bm, []).append(bl)

    promoted: list[tuple[dict[str, Any], dict[str, Any]]] = []
    fee_out: dict[str, float] = {}
    for cand in sorted(rejected, key=lambda c: c["seq"]):
        dst_owner = cand.get("dst_owner")
        if cand["dst"] in pool_refs or (
            dst_owner is not None and dst_owner in pool_refs
        ):
            continue
        buys = buy_base_legs.get(cand["mint"])
        if not buys:
            continue
        bl = min(buys, key=lambda b: (abs(cand["seq"] - b["seq"]), b["seq"]))
        promoted.append((cand, bl))
        qty = cand["raw"] / 10 ** cand["dec"]
        fee_out[cand["mint"]] = fee_out.get(cand["mint"], 0.0) + qty
    return promoted, fee_out


def _reprice_route_legs(evs, majors) -> None:
    """Route trung gian (USDC→MEME→TOKEN): priceUsd của MEME ở pool mỏng lệch
    nhiều lần so với giá trị thật của khối MEME đó. Leg nối tiếp của cùng một route
    dùng CHUNG một khối MEME (qty == quote_qty) nên USD phải bằng nhau — lấy theo
    leg có quote tin được (SOL/USDC/USDT) thay vì tin DexScreener của MEME.

    Khối MEME có thể bị CHIA qua nhiều leg (Jupiter split): cộng dồn các leg anh em
    theo `qty` rồi so với `quote_qty` — sự cố 2026-09-25 (id=4289 GOCAT→GO): parcel
    GO 347.075 chia 2 leg SOL ($213,21 + $71,37 = $284,58) nhưng leg quote-GO vẫn
    giữ giá DexScreener $1.778,07 (6,25×). Lặp tối đa 3 chặng để route dài
    (A→MEME1→MEME2→SOL) truyền giá trị dần về leg gốc."""
    done: set[int] = set()  # leg đã lấy giá từ chain (được dùng làm mốc chặng sau)
    for _ in range(3):
        changed = False
        for e in evs:
            qm = e.get("quote_mint")
            if qm in majors or not e.get("quote_usd") or not e.get("quote_qty"):
                continue
            tot_q = tot_usd = 0.0
            for b in evs:
                if b is e or b.get("mint") != qm or not b.get("quote_usd"):
                    continue
                if b.get("quote_mint") in majors or id(b) in done:
                    tot_q += b.get("qty") or 0.0
                    tot_usd += b["quote_usd"]
            if not tot_usd or abs(tot_q - e["quote_qty"]) > (
                1e-6 * max(1.0, abs(e["quote_qty"]))
            ):
                continue
            if tot_usd != e["quote_usd"]:
                e["quote_usd"] = tot_usd
                done.add(id(e))
                changed = True
        if not changed:
            break


def _opp_quote(net_map, m, majors):
    """Leg đối ứng của mint m: major trái dấu |net| lớn nhất, else non-major."""
    v = net_map.get(m, 0.0)
    opp = [
        (abs(w), q) for q, w in net_map.items() if q != m and w and (w > 0) != (v > 0)
    ]
    if not opp:
        return None
    return max([x for x in opp if x[1] in majors] or opp)[1]


def _net_swap_event(tx, wallet, sig, ts, m, v, qm, net_map):
    """Swap suy từ net ví khi leg-pairing bỏ sót: qty = đúng net ví, quote = leg
    đối ứng. amount_basis="net_delta" để phân biệt với gross_leg đã soát tay."""
    qty, qq = abs(v), abs(net_map.get(qm, 0.0))
    px = _quote_px(qm)
    qusd = qq * px if px else None
    return {
        "ts": ts,
        "slot": tx.get("slot"),
        "sig": sig,
        "wallet": wallet,
        "side": "BUY" if v > 0 else "SELL",
        "mint": m,
        "sym": _dsym(m),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": _dsym(qm),
        "quote_qty": qq,
        "quote_usd": qusd,
        "qty_net": v,
        "unit_price": qq / qty if qty else 0.0,
        "pool": "",
        "program": "",
        "amount_basis": "net_delta",
        "quote_inferred": True,
        "symbol_pending": bool(_symbol_pending(m) or _symbol_pending(qm)),
        "usd_pending": not qusd,
        "type": "SWAP",
    }


def detect_swaps(tx, wallet, trace=None, with_transfers=False) -> list[dict[str, Any]]:
    """1 tx của ví → 1 event cho MỖI bước swap qua 1 pool (parity row GMGN —
    spec §3 Bước 1-5). Không network, không state ngoài cache _info/_sol_px.
    trace=callable nhận dòng quyết định REJECT/RANK/PAIR/STEP (bảng evidence T2).
    type luôn là SWAP — không bao giờ là nhãn route-level cũ (transfer-in/out, neutral)."""
    meta = tx.get("meta") or {}
    if meta.get("err") is not None:
        return []
    sig = tx["transaction"]["signatures"][0]
    ts = datetime.fromtimestamp(tx.get("blockTime") or time.time(), ICT).strftime(
        "%m-%d %H:%M:%S"
    )
    rejected: list[dict[str, Any]] = []
    anchored: set[str] = set()
    legs = _legs_with_roles(tx, wallet, trace, rejected, anchored)
    steps, majors = [], TIER_A | TIER_B
    for sa, sb, frame, pool, by in _pair_steps(legs, trace):
        # major↔major = route conversion (USDC↔WSOL…), không phải token trade:
        # GMGN không list — đã đo trên 9 tx fixture, chỉ 1 pair rơi vào
        # (QuaNt USDC↔WSOL ở 58pWphuG); bỏ nó khớp đúng role distribution 29,
        # steps 29/29 và quote_inferred==1 của plan. 0/29 row oracle major-major.
        if sa["mint"] in majors and sb["mint"] in majors:
            if trace:
                trace(f"REJECT {frame} {sa['mint']} major_pair")
                trace(f"REJECT {frame} {sb['mint']} major_pair")
            continue
        steps.append((sa, sb, frame, pool, by))
    steps.sort(key=lambda s: min(s[0]["seq"], s[1]["seq"]))
    rank = _rank_mints([(s[0]["mint"], s[1]["mint"]) for s in steps])
    if trace and rank:
        order = sorted(rank, key=lambda m: (rank[m], m))
        trace("RANK " + " ".join(f"{_dsym(m)}={rank[m]}" for m in order))
    # §4.1: bỏ hop base mà tài khoản ví giữ mint đó không nhúc nhích, trong route
    # pump.fun. Lọc TRƯỚC vòng gross để mẫu số chia qty_net không bị leg phantom
    # làm nhiễu. Chỉ xét leg BASE: leg quote wflat là chuyện bình thường (ví dụ
    # "H74 nhận vào rồi trả ra" ở SELL 9CmbYf — leg đó là quote, không phải base).
    if steps:
        keep = []
        for st in steps:
            bm0, _qm0, _inf0 = _base_quote(st[0]["mint"], st[1]["mint"], rank)
            bl0 = st[0] if st[0]["mint"] == bm0 else st[1]
            if bl0["wflat"] and bl0["encl"] in _PUMP_ROUTE:
                if trace:
                    trace(f"REJECT {st[2]} {bm0} phantom_flat_wallet_acct")
                continue
            keep.append(st)
        steps = keep
    # gross leg base theo từng mint = mẫu số chia qty_net (tỉ lệ) cho mỗi hop
    gross: dict[str, float] = {}
    for sa, sb, *_ in steps:
        bm, _qm, _inf = _base_quote(sa["mint"], sb["mint"], rank)
        bl = sa if sa["mint"] == bm else sb
        gross[bm] = gross.get(bm, 0.0) + bl["raw"] / 10 ** bl["dec"]
    net = _net_owner(tx, wallet)
    promoted, fee_out = _promote_fee_candidates(rejected, steps, rank)
    net_adj = dict(net)
    for m, extra in fee_out.items():
        net_adj[m] = net_adj.get(m, 0.0) + extra

    buy_event_by_base_leg: dict[int, dict[str, Any]] = {}
    built = []
    for sa, sb, frame, pool, by in steps:
        ev, bl, bm, qm = _swap_event(
            tx, wallet, sig, ts, sa, sb, pool, rank, net_adj, gross
        )
        if trace:
            trace(f"PAIR {frame} {_dsym(bm)}←{_dsym(qm)} by={by}")
        if ev is not None:
            built.append((ev, frame, bl, min(sa["seq"], sb["seq"]), None))
            if ev["side"] == "BUY":
                buy_event_by_base_leg[id(bl)] = ev
    for cand, bl in promoted:
        buy_ev = buy_event_by_base_leg.get(id(bl))
        if buy_ev is None:
            continue
        built.append(
            (
                _fee_event(tx, wallet, sig, ts, cand, buy_ev),
                cand["frame"],
                None,
                cand["seq"],
                cand,
            )
        )
    # Fallback: mint ví đổi số dư mà leg-pairing bỏ sót. `anchored` (leg trong
    # frame program ∈ _SWAP_PROGRAMS) giết withdraw/unstake; không anchored ⇒ TRANSFER.
    seen = {ev["mint"] for ev, *_ in built}
    for m, v in net_adj.items():
        if not v or m in majors or m in seen:
            continue
        qm = _opp_quote(net_adj, m, majors) if m in anchored else None
        if qm is not None:
            ev = _net_swap_event(tx, wallet, sig, ts, m, v, qm, net_adj)
        elif with_transfers:
            ev = _recv_event(tx, wallet, m, abs(v))
            ev.update(
                side="transfer",
                type="TRANSFER",
                transfer_dir="in" if v > 0 else "out",
                qty_net=v,
                amount_basis="net_delta",
            )
        else:
            continue
        seen.add(m)
        built.append(
            (ev, None, {"rs": "RELAY", "rd": "RELAY", "seq": 10**9}, 10**9, None)
        )
    built.sort(key=lambda item: item[3])
    evs = []
    n = len(built)
    for i, (ev, frame, bl, _seq_key, cand) in enumerate(built, 1):
        ev["step"], ev["n_steps"] = i, n  # 2 key phụ cho fmt() ` step i/n` (§B5)
        if trace:
            if cand is None:
                trace(
                    f"STEP {sig[:8]} | {frame} | {ev['pool']} | {ev['sym']}"
                    f" | {ev['quote_sym']} | {bl['rs']} | {bl['rd']} | {ev['side']}"
                    f" | {ev['qty']:.12g} | {ev['quote_qty']:.12g}"
                    f" | {ev['amount_basis']}"
                )
            else:
                trace(
                    f"FEE {sig[:8]} | {frame} | {cand['reason']} | {ev['sym']}"
                    f" | {ev['quote_sym']} | {cand['rs']} | {cand['rd']} | {ev['side']}"
                    f" | {ev['qty']:.12g} | {ev['quote_qty']:.12g}"
                    f" | {ev['amount_basis']} | fee_leg"
                )
        evs.append(ev)
    _reprice_route_legs(evs, majors)
    return evs


def detect_events(tx, wallet, trace=None) -> list[dict[str, Any]]:
    """detect_swaps + TRANSFER (mint ví đổi số dư nhưng không qua swap venue).
    Production (_handle_tx) dùng hàm này; oracle per-step vẫn gọi detect_swaps."""
    return detect_swaps(tx, wallet, trace, with_transfers=True)


# ---------- rule A (chốt 2026-09-18): CA = token ĐÍCH của TRADER ----------
# Token coi như TIỀN/route ⇒ không bao giờ là CA: stablecoin + tier quote
# (WSOL/USDC/USDT/DAI/WBTC). LINK không cần hardcode: nó tự bị loại vì trader chỉ
# TRUNG CHUYỂN (nhận rồi trả hết trong cùng tx ⇒ net = 0) — tx 4VPQRwNB.
_ROUTE_MINTS = TIER_A | TIER_B


def _signer_keys(tx) -> list[str]:
    """Pubkey các account ĐÃ KÝ (accountKeys[].signer)."""
    return [
        ak["pubkey"]
        for ak in tx["transaction"]["message"].get("accountKeys") or []
        if ak.get("signer")
    ]


def _net_owner(tx, owner) -> dict[str, float]:
    """net uiAmount theo mint cho ĐÚNG 1 owner (pre/postTokenBalances)."""
    net: dict[str, float] = {}
    for sign, key in ((-1.0, "preTokenBalances"), (1.0, "postTokenBalances")):
        for r in (tx.get("meta") or {}).get(key) or []:
            if r.get("owner") != owner:
                continue
            amt = r.get("uiTokenAmount") or {}
            v = amt.get("uiAmountString") or amt.get("uiAmount") or 0
            net[r["mint"]] = net.get(r["mint"], 0.0) + sign * float(v)
    return net


def _fill_dest(tx, wallet, me):
    """OTC fill (rule A): memecoin ví track BÁN (net < 0, không-route) mà một
    SIGNER khác MUA (net > 0 CÙNG mint). Ví track không ký nhưng vẫn là một bên
    của giao dịch — 4VPQRwNB: GpMZbSM2 bán MARINE cho 5k3ZdP3vqN; 3Vdkaok:
    HLnpSz9h bán ZINC cho 6UvTH39q9i. Trả (buyer, mint) | None."""
    sold = {m: -v for m, v in me.items() if v < 0 and m not in _ROUTE_MINTS}
    if not sold:
        return None
    best = None
    for a in _signer_keys(tx):
        if a == wallet:
            continue
        for m, v in _net_owner(tx, a).items():
            if v > 0 and m in sold and m not in _ROUTE_MINTS:
                if best is None or v > best[0]:
                    best = (v, a, m)
    return (best[1], best[2]) if best else None


def _fill_event(tx, wallet, dest, buyer, evs):
    """Event CA cho OTC fill: qty = net(dest) của buyer; quote = token buyer TRẢ
    (net < 0 lớn nhất). USD ưu tiên giá quote; quote là memecoin chưa có giá ⇒
    lấy giá trị settlement (max quote_usd của event ví) để CA vẫn post được."""
    net = _net_owner(tx, buyer)
    qty = net.get(dest, 0.0)
    paid = {m: -v for m, v in net.items() if v < 0}
    qm = max(paid, key=lambda m: paid[m]) if paid else None
    qq = paid[qm] if qm else 0.0
    px = (
        _sol_px["v"]
        if qm == WSOL
        else 1.0
        if qm in (USDC, USDT)
        else (_info.get(qm or "") or (None, 0.0))[1]
    )
    qusd, basis = qq * px, "quote"
    if not qusd:
        oth = max((e.get("quote_usd") or 0.0 for e in evs), default=0.0)
        qusd, basis = (oth, "counterparty") if oth > 0 else (None, "none")
    return {
        "ts": datetime.fromtimestamp(tx.get("blockTime") or time.time(), ICT).strftime(
            "%m-%d %H:%M:%S"
        ),
        "slot": tx.get("slot"),
        "sig": tx["transaction"]["signatures"][0],
        "wallet": wallet,
        "side": "BUY",
        "mint": dest,
        "sym": _dsym(dest),
        "qty": qty,
        "quote_mint": qm,
        "quote_sym": _dsym(qm) if qm else "",
        "quote_qty": qq,
        "quote_usd": qusd,
        "unit_price": qq / qty if qty else 0.0,
        "pool": "",
        "program": "",
        "amount_basis": "net_delta",
        "quote_inferred": False,
        "usd_basis": basis,
        "via": buyer,
        "symbol_pending": False,
        "usd_pending": not qusd,
        "type": "SWAP",
        "step": 1,
        "n_steps": 1,
    }


def _recv_event(tx, wallet, mint, qty):
    """Ví KHÔNG ký, KHÔNG bán gì mà VẪN nhận memecoin (deposit/airdrop/claim) —
    69LjZU +20.060.836 (4F5JCkWy), airdrop +990 (2oJtynk92s): trước đây các tx
    này không sinh event nào (ví coi như không liên quan). Quote chưa biết ⇒
    quote_usd=0 + usd_pending=True ⇒ track_post_body bỏ qua (chỉ log/events.jsonl)
    — KHÔNG tự đẩy token rác vào queue CA."""
    return {
        "ts": datetime.fromtimestamp(tx.get("blockTime") or time.time(), ICT).strftime(
            "%m-%d %H:%M:%S"
        ),
        "slot": tx.get("slot"),
        "sig": tx["transaction"]["signatures"][0],
        "wallet": wallet,
        "side": "RECEIVE",
        "mint": mint,
        "sym": _dsym(mint),
        "qty": qty,
        "quote_mint": None,
        "quote_sym": "",
        "quote_qty": 0.0,
        "quote_usd": None,
        "unit_price": 0.0,
        "pool": "",
        "program": "",
        "amount_basis": "net_delta",
        "quote_inferred": False,
        "usd_basis": "none",
        "via": None,
        "symbol_pending": False,
        "usd_pending": True,
        "type": "RECEIVE",
        "step": 1,
        "n_steps": 1,
    }


def _target_event(tx, wallet, evs):
    """1 tx → 1 CA: chọn TOKEN ĐÍCH duy nhất (rule A, chốt 2026-09-18).

    Đích = token TRADER thực nhận (net > 0), KHÔNG phải token ví track nhận.
    (1) Ví track là trader (ký) ⇒ như cũ: lấy BUY có net > 0, bước CUỐI; mint
        routing (vừa mua vừa tiêu hết, net ≈ 0) tự bị loại.
    (2) Ví track KHÔNG ký tx (đối ứng bị động) ⇒ CA = memecoin hai bên trao đổi
        (ví bán, signer mua): 4VPQRwNB ⇒ MARINE, 3Vdkaok ⇒ ZINC. Ví có event BUY
        khớp đích thì dùng luôn (leg đã đúng); chưa có (mint lạ) ⇒ _fill_event.
        Ví CÓ ký ⇒ tx là hành vi của chính ví ⇒ không áp (2): giao kèo 2 signer
        (3GkmwgW2vE) không được biến thành tín hiệu mua.
    (3) Ví không nhận memecoin nào (bán thật, không ai mua lại) ⇒ None.
    ponytail: tx mua 2 token độc lập chỉ giữ token ở bước cuối — cần giữ cả thì
    trả về list thay vì max-step."""
    net = _net_owner(tx, wallet)
    if wallet not in _signer_keys(tx):
        fill = _fill_dest(tx, wallet, net)
        if fill:
            buyer, dest = fill
            hit = next(
                (e for e in evs if e.get("mint") == dest and e.get("side") == "BUY"),
                None,
            )
            return hit if hit is not None else _fill_event(tx, wallet, dest, buyer, evs)
        # (2b) ví KHÔNG ký và KHÔNG bán gì: chỉ NHẬN token (deposit/airdrop/claim)
        # và không có BUY event nào ⇒ trước đây return None ⇒ tx vô hình. Bắn
        # event nhận (usd_pending ⇒ log-only, không post CA rác).
        if not any(e.get("side") == "BUY" for e in evs):
            recv = {m: v for m, v in net.items() if v > 0 and m not in _ROUTE_MINTS}
            if recv:
                m = max(recv, key=lambda x: recv[x])
                return _recv_event(tx, wallet, m, recv[m])
    buys = [e for e in evs if e.get("side") == "BUY" and e.get("mint")]
    if not buys:
        return None
    dests = [e for e in buys if net.get(e.get("mint") or "", 0.0) > 0]
    return max(dests or buys, key=lambda e: int(e.get("step") or 0))
