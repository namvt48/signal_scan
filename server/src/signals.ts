// Signal assembly from DB state. The DTOs below mirror src/types.ts (the
// frontend never imports server modules, so the small shape is duplicated on
// purpose — keep the two in sync when the contract changes).

import { T100_WINDOW_MS } from './config.js';
import { allTokenStates, earliestSnapshotAt, getDb, latestSnapshot, latestWatchTradeTsByCa, listTiers, listTrackedCas, snapshotAtOrBefore, snapshotsSince, type TokenStateRow } from './db.js';
import { getDebugAllFactors, getThresholds, type NansenThresholds } from './settings.js';
import { t100Decrease } from './snapshot.js';
import type { HolderRow } from './providers/provider.js';
import type { Chain } from './shared/chain.js';
import type { Tier } from './shared/tier.js';

/** mirrors NansenSetup in src/types.ts */
export interface NansenSetup {
  score: number;
  /**
   * Per-factor gate result under the thresholds in force for THIS response.
   * false = the factor has a value but misses the current threshold (only
   * visible when the allFactors debug flag is on, and rendered struck-through).
   * A factor with no value at all is false too — `fresh`/`t100`/`lf` stay absent.
   */
  pass: { fresh: boolean; t100: boolean; lf: boolean };
  fresh?: number;
  /** Genesis-to-trough: pct = (A−B)/A×100, multiple = A/B (absent until a genesis write lands). */
  t100?: { pct: number; multiple?: number };
  /**
   * Low float: the top-100 cohort balance AT price=0 (genesis series A), in
   * TOKEN UNITS — not a market cap. FE renders `LF ${compact(value)}`.
   */
  lf?: number;
}

/** Per-wallet tracked activity for one CA (mirrors src/types.ts). */
export interface TrackedWalletStat {
  /** Wallet display name. */
  name: string;
  /** Display-only clan label beside the name (user 2026-09-24). Absent/empty = unlabelled. */
  clan?: string;
  /** Wallet tags so the FE can style the name (e.g. "Unicon" → rainbow). */
  tags?: string[];
  /** Net USD this wallet put into the CA inside the inflow window: Σ buys − Σ sells (source='watch'). May be negative. */
  inflow: number;
  /** watch BUY count inside the window. */
  buys: number;
  /** watch SELL count inside the window. */
  sells: number;
  /** Current token balance USD for this (wallet, CA) — absent when never measured (NULL). */
  balUsd?: number;
  /** Epoch ms of the wallet's newest watch trade for this CA inside the window; 0 = none. */
  lastTs: number;
}

/** One watched FOMO trader's activity on a token (large trades only; buyUsd is BUY size and sellPnlUsd is SELL realised PnL — reported separately, never combined). */
export interface FomoUserStat {
  handle: string;
  name?: string;
  clan?: string;
  buyUsd: number;
  sellPnlUsd: number;
  buys: number;
  sells: number;
  trades: number;
  lastTs: number;
  /** Σ token units the user's wallets hold of this CA; absent until measured. */
  holdingAmount?: number;
  /** holdingAmount / total supply × 100; absent when never measured or supply unknown. */
  holdingPct?: number;
}
export interface TokenSignal {
  id: string;
  ca: string;
  chain: Chain;
  /** Ticker from Nansen essential-data (as-is, e.g. "MINI") — FE uppercases. Absent until first sweep. */
  symbol?: string;
  /** Token logo URL (DexScreener icon sweep; validated https + allowlisted host at write).
   * Absent until the sweep lands one — the FE renders its fallback instead. */
  iconUrl?: string;
  trackedWallets: TrackedWalletStat[];
  /** FOMO watch-list users who EVER bought this (ca, chain), newest-trade-first; 24h stats. */
  fomoUsers: FomoUserStat[];
  nansen: NansenSetup;
  holders: number;
  /** Market cap USD (price × circulating supply); absent until a sweep writes one. */
  marketCap?: number;
  /** Net USD tracked wallets put in over the last 24h (buys − sells); may be negative. */
  trackedInflow: number;
  /**
   * Newest source='watch' trade ts (epoch ms — buy OR sell) from a member wallet inside the
   * inflow window; 0 = no tracked activity yet. Orders the table (newest activity first).
   */
  trackedActivityAt: number;
  trackedHolding: number;
  volume24h: number;
  /** Trailing-1h DEX volume, USD. Absent until the 1h door lands a value (never a fake 0). */
  volume1h?: number;
  tier: Tier | null;
  balanceRange?: { d1?: BalRange; d7?: BalRange; d30?: BalRange };
}

/** Peak/trough holder balance (USD, exchange-classified rows included) inside a window. */
export interface BalRange {
  peak: number;
  trough: number;
}

/** Raw SQLite row behind trackedWalletStats — balUsd is NULL when never measured. */
interface TrackedWalletRow {
  name: string;
  clan: string | null;
  tags: string;
  inflow: number;
  buys: number;
  sells: number;
  lastTs: number;
  balUsd: number | null;
}

/** wallets.tags is a JSON string column; decode defensively (bad/legacy value → []). */
function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Per-wallet tracked stats for one CA — ONE query replacing the former
 * name-list + gross-buy-sum pair (contract change 2026-09-24: the FE
 * renders per-wallet rows, and inflow goes NET = buys − sells).
 *
 * MEMBERSHIP provenance unchanged (user 2026-09-22, verbatim: "giờ chỉ có một nguồn là
 * detect buy bằng wallet watch thì mới thêm wallet và CA đó vào, từ đó bắt đầu
 * tính inflow, không backfill lại lịch sử"): a wallet is listed ONLY on a
 * source='watch' BUY — now EVER-BOUGHT (permanent, no time window; the old 7d
 * TRACKED_BY_WINDOW_MS bound dropped an early buyer from the CA's `Tracked by`).
 * The wallet_watch Solana-RPC
 * detector is the sole writer that lights it up, a merely-HOLDING wallet does
 * not qualify, and source='nansen'/retired-sweep rows never count (NO BACKFILL).
 * A sell-only wallet is absent and its sells uncounted.
 *
 * The stats (inflow/buys/sells/lastTs) cover the 24h inflow window — NARROWER
 * than membership, so a member whose newest buy is older appears with zero
 * stats and lastTs 0 (driving off the stat-window trades instead would drop it,
 * breaking membership parity with the old name list). balUsd reads the current
 * wallet_token_state row; NULL (never measured) omits the key.
 *
 * Rows are ordered newest-trade-first (user 2026-09-24), so the wallet that just
 * bought OR sold leads its CA's list; a member with no trade inside the stats
 * window (lastTs 0) sinks below the active ones.
 *
 * Scoped to ONE (chain, ca) identity (user 2026-09-28): tracked_cas is
 * UNIQUE(address, chain), so the same address tracked on two chains must not pool
 * the other chain's members, trades or balances into this CA's rows.
 */
export function trackedWalletStats(ca: string, chain: string, now: number): TrackedWalletStat[] {
  const rows = getDb()
    .prepare(
      `SELECT w.name AS name,
              w.clan AS clan,
              w.tags AS tags,
              COALESCE(SUM(CASE WHEN t.side = 'buy' THEN t.amount_usd ELSE -t.amount_usd END), 0) AS inflow,
              SUM(CASE WHEN t.side = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.side = 'sell' THEN 1 ELSE 0 END) AS sells,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              MAX(s.balance_usd) AS balUsd
         FROM wallets w
         LEFT JOIN wallet_trades t
           ON t.wallet_id = w.id AND t.ca = @ca AND t.chain = @chain AND t.source = 'watch' AND t.ts >= @statSince
         LEFT JOIN wallet_token_state s ON s.wallet_id = w.id AND s.ca = @ca AND s.chain = @chain
         WHERE EXISTS (SELECT 1 FROM wallet_trades b
                        WHERE b.wallet_id = w.id AND b.ca = @ca AND b.chain = @chain
                          AND b.side = 'buy' AND b.source = 'watch')
         GROUP BY w.id
         ORDER BY lastTs DESC, w.name`,
    )
    .all({ ca, chain, statSince: now - 86_400_000 }) as TrackedWalletRow[];
  return rows.map(({ name, clan, tags, inflow, buys, sells, lastTs, balUsd }) => ({
    name,
    ...(clan != null && clan !== '' ? { clan } : {}),
    tags: parseTags(tags),
    inflow,
    buys,
    sells,
    lastTs,
    ...(balUsd != null ? { balUsd } : {}),
  }));
}

/**
 * Batched trackedWalletStats for the /api/signals pass (N+1 fix): ONE query for
 * every CA, keyed `${chain}:${ca}` — the same identity tracked_cas is unique on,
 * and the same equality the per-CA `@ca`/`@chain` binds use.
 * Membership comes from a `members` CTE — NOT from joining the windowed trades —
 * and is ever-bought (no time window), so a member with no trade inside the 24h
 * stat window keeps its zero-stat row
 * (inflow/buys/sells/lastTs 0, balUsd from wallet_token_state), exactly like the
 * per-CA LEFT JOIN. Per-CA row order (lastTs DESC, w.name) is preserved via
 * ORDER BY m.chain, m.ca first, then the split into per-CA arrays. A CA with no
 * members is ABSENT — callers read `map.get(`${chain}:${ca}`) ?? []`, matching the
 * per-CA empty list.
 */
export function trackedWalletStatsByCa(now: number): Map<string, TrackedWalletStat[]> {
  const rows = getDb()
    .prepare(
      `WITH members AS (
         SELECT DISTINCT b.chain AS chain, b.ca AS ca, b.wallet_id AS wallet_id
           FROM wallet_trades b
          WHERE b.side = 'buy' AND b.source = 'watch')
       SELECT m.chain AS chain,
              m.ca AS ca,
              w.name AS name,
              w.clan AS clan,
              w.tags AS tags,
              COALESCE(SUM(CASE WHEN t.side = 'buy' THEN t.amount_usd ELSE -t.amount_usd END), 0) AS inflow,
              SUM(CASE WHEN t.side = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.side = 'sell' THEN 1 ELSE 0 END) AS sells,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              MAX(s.balance_usd) AS balUsd
         FROM members m
         JOIN wallets w ON w.id = m.wallet_id
         LEFT JOIN wallet_trades t
           ON t.wallet_id = m.wallet_id AND t.ca = m.ca AND t.chain = m.chain AND t.source = 'watch' AND t.ts >= @statSince
         LEFT JOIN wallet_token_state s ON s.wallet_id = m.wallet_id AND s.ca = m.ca AND s.chain = m.chain
        GROUP BY m.chain, m.ca, m.wallet_id
        ORDER BY m.chain, m.ca, lastTs DESC, w.name`,
    )
    .all({ statSince: now - 86_400_000 }) as (TrackedWalletRow & { ca: string; chain: string })[];
  const out = new Map<string, TrackedWalletStat[]>();
  for (const { chain, ca, name, clan, tags, inflow, buys, sells, lastTs, balUsd } of rows) {
    // Same conditional spreads (and key order) as trackedWalletStats — the JSON
    // response must stay byte-identical.
    const stat: TrackedWalletStat = {
      name,
      ...(clan != null && clan !== '' ? { clan } : {}),
      tags: parseTags(tags),
      inflow,
      buys,
      sells,
      lastTs,
      ...(balUsd != null ? { balUsd } : {}),
    };
    const key = `${chain}:${ca}`;
    const list = out.get(key);
    if (list) list.push(stat);
    else out.set(key, [stat]);
  }
  return out;
}

/** Raw SQLite row behind fomoUserStats — name is '' and clan NULL when unset.
 *  holdingAmount/holdingPct are NULL until the wallet's holding is measured. */
interface FomoUserStatRow {
  handle: string;
  name: string;
  clan: string | null;
  buyUsd: number;
  sellPnlUsd: number;
  buys: number;
  sells: number;
  trades: number;
  lastTs: number;
  holdingAmount: number | null;
  holdingPct: number | null;
}

/**
 * Per-user FOMO stats for one CA — the fomo mirror of trackedWalletStats, with
 * the same membership-vs-stats-window split.
 *
 * MEMBERSHIP mirrors `Tracked by` (ever-bought): a user is listed ONLY on a
 * type='buy' fomo_trades row for this (ca, chain) — EVER, with NO time bound —
 * so a user whose newest buy is older than the stats window appears with zero
 * stats and lastTs 0, and a user with ONLY sells never appears (its sells
 * uncounted). Scoped to ONE (chain, ca) identity: the same ca string on two
 * chains must not pool the other chain's users or trades.
 *
 * The stats cover the SAME 24h window trackedWalletStats uses. buyUsd sums BUY
 * rows only (a buy's usd_value is the post-fill position size) and sellPnlUsd
 * sums SELL rows only (a sell's usd_value is signed realised PnL). The two are
 * reported SEPARATELY and are never combined into a net/inflow figure: a buy's
 * usd_value (position size) and a sell's usd_value (PnL) are different
 * quantities that must never be summed (fomo_trades DDL).
 *
 * Rows are ordered newest-trade-first, so a member with no trade inside the
 * stats window (lastTs 0) sinks below the active ones. name '' / clan NULL
 * omit their keys (FE renders the handle alone).
 */
export function fomoUserStats(ca: string, chain: string, now: number): FomoUserStat[] {
  const rows = getDb()
    .prepare(
      `SELECT u.handle AS handle,
              u.name AS name,
              u.clan AS clan,
              COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.usd_value END), 0) AS buyUsd,
              COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.usd_value END), 0) AS sellPnlUsd,
              SUM(CASE WHEN t.type = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.type = 'sell' THEN 1 ELSE 0 END) AS sells,
              COUNT(t.id) AS trades,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              h.amount AS holdingAmount,
              h.pct AS holdingPct
         FROM fomo_users u
         LEFT JOIN fomo_trades t
           ON t.fomo_user_id = u.id AND t.ca = @ca AND t.chain = @chain AND t.ts >= @statSince
         LEFT JOIN fomo_holdings h
           ON h.fomo_user_id = u.id AND h.ca = @ca AND h.chain = @chain
        WHERE EXISTS (SELECT 1 FROM fomo_trades b
                       WHERE b.fomo_user_id = u.id AND b.ca = @ca AND b.chain = @chain
                         AND b.type = 'buy')
        GROUP BY u.id
        ORDER BY lastTs DESC, u.handle`,
    )
    .all({ ca, chain, statSince: now - 86_400_000 }) as FomoUserStatRow[];
  return rows.map(({ handle, name, clan, buyUsd, sellPnlUsd, buys, sells, trades, lastTs, holdingAmount, holdingPct }) => ({
    handle,
    ...(name !== '' ? { name } : {}),
    ...(clan != null && clan !== '' ? { clan } : {}),
    buyUsd,
    sellPnlUsd,
    buys,
    sells,
    trades,
    lastTs,
    ...(holdingAmount != null ? { holdingAmount } : {}),
    ...(holdingPct != null ? { holdingPct } : {}),
  }));
}

/**
 * Batched fomoUserStats for the /api/signals pass (N+1 fix): ONE query for
 * every CA, keyed `${chain}:${ca}` — the same identity tracked_cas is unique
 * on, and the same equality the per-CA `@ca`/`@chain` binds use.
 * Membership comes from a `members` CTE — NOT from joining the windowed trades —
 * and is ever-bought (no time window), so a member with no trade inside the 24h
 * stat window keeps its zero-stat row, exactly like the per-CA LEFT JOIN.
 * Per-CA row order (lastTs DESC, u.handle) is preserved via ORDER BY m.chain,
 * m.ca first, then the split into per-CA arrays. A CA with no members is
 * ABSENT — callers read `map.get(`${chain}:${ca}`) ?? []`, matching the per-CA
 * empty list.
 */
export function fomoUserStatsByCa(now: number): Map<string, FomoUserStat[]> {
  const rows = getDb()
    .prepare(
      `WITH members AS (
         SELECT DISTINCT b.chain AS chain, b.ca AS ca, b.fomo_user_id AS fomo_user_id
           FROM fomo_trades b
          WHERE b.type = 'buy')
       SELECT m.chain AS chain,
              m.ca AS ca,
              u.handle AS handle,
              u.name AS name,
              u.clan AS clan,
              COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.usd_value END), 0) AS buyUsd,
              COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.usd_value END), 0) AS sellPnlUsd,
              SUM(CASE WHEN t.type = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.type = 'sell' THEN 1 ELSE 0 END) AS sells,
              COUNT(t.id) AS trades,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              h.amount AS holdingAmount,
              h.pct AS holdingPct
         FROM members m
         JOIN fomo_users u ON u.id = m.fomo_user_id
         LEFT JOIN fomo_trades t
           ON t.fomo_user_id = m.fomo_user_id AND t.ca = m.ca AND t.chain = m.chain AND t.ts >= @statSince
         LEFT JOIN fomo_holdings h
           ON h.fomo_user_id = m.fomo_user_id AND h.ca = m.ca AND h.chain = m.chain
        GROUP BY m.chain, m.ca, m.fomo_user_id
        ORDER BY m.chain, m.ca, lastTs DESC, u.handle`,
    )
    .all({ statSince: now - 86_400_000 }) as (FomoUserStatRow & { ca: string; chain: string })[];
  const out = new Map<string, FomoUserStat[]>();
  for (const { chain, ca, handle, name, clan, buyUsd, sellPnlUsd, buys, sells, trades, lastTs, holdingAmount, holdingPct } of rows) {
    // Same conditional spreads (and key order) as fomoUserStats — the JSON
    // response must stay byte-identical.
    const stat: FomoUserStat = {
      handle,
      ...(name !== '' ? { name } : {}),
      ...(clan != null && clan !== '' ? { clan } : {}),
      buyUsd,
      sellPnlUsd,
      buys,
      sells,
      trades,
      lastTs,
      ...(holdingAmount != null ? { holdingAmount } : {}),
      ...(holdingPct != null ? { holdingPct } : {}),
    };
    const key = `${chain}:${ca}`;
    const list = out.get(key);
    if (list) list.push(stat);
    else out.set(key, [stat]);
  }
  return out;
}

/**
 * Σ current token amount (token units) for one CA, over the wallets that CA is
 * `Tracked by` only — same source='watch' BUY provenance as the trackedWalletStats
 * membership, so Tracked holding can never count a wallet the rows above do not
 * list (user 2026-09-23). The sweep no longer refreshes unlinked wallets, so their
 * leftover rows must not be summed. Scoped to one (chain, ca) identity
 * (user 2026-09-28) so the same address on another chain cannot inflate it.
 */
export function sumHoldingAmount(ca: string, chain: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(s.token_amount), 0) AS total FROM wallet_token_state s
        WHERE s.ca = ? AND s.chain = ?
          AND EXISTS (SELECT 1 FROM wallet_trades t
                       WHERE t.wallet_id = s.wallet_id AND t.ca = s.ca AND t.chain = s.chain
                         AND t.side = 'buy' AND t.source = 'watch')`,
    )
    .get(ca, chain) as { total: number };
  return row.total;
}

/**
 * Batched sumHoldingAmount for the /api/signals pass (N+1 fix): ONE GROUP BY
 * over wallet_token_state keyed `${chain}:${ca}` (same equality as the per-CA
 * `WHERE s.ca = ? AND s.chain = ?`). Filters are verbatim the per-CA ones — only
 * wallets with ANY source='watch' BUY (NO time bound) are summed. A CA with no
 * qualifying rows is ABSENT — callers read `map.get(`${chain}:${ca}`) ?? 0`,
 * matching the per-CA COALESCE(SUM, 0).
 */
export function sumHoldingAmountByCa(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT s.chain AS chain, s.ca AS ca, COALESCE(SUM(s.token_amount), 0) AS total FROM wallet_token_state s
        WHERE EXISTS (SELECT 1 FROM wallet_trades t
                       WHERE t.wallet_id = s.wallet_id AND t.ca = s.ca AND t.chain = s.chain
                         AND t.side = 'buy' AND t.source = 'watch')
        GROUP BY s.chain, s.ca`,
    )
    .all() as { chain: string; ca: string; total: number }[];
  return new Map(rows.map((r) => [`${r.chain}:${r.ca}`, r.total]));
}

function parseHolders(json: string): HolderRow[] {
  // snapshot rows are written by ingest.insertSnapshot via JSON.stringify — trusted own data.
  return JSON.parse(json) as HolderRow[];
}

/**
 * Newest snapshot vs newest snapshot at least T100_WINDOW_MS old; undefined
 * when either side is missing (no measurement yet) or both sides are the same
 * row (stale-only history — nothing was actually paired).
 */
export function computeT100Pct(ca: string, chain: Chain, now: number): number | undefined {
  const curr = latestSnapshot(ca, chain);
  if (!curr) return undefined;
  const prev = snapshotAtOrBefore(ca, chain, now - T100_WINDOW_MS);
  if (!prev || prev.id === curr.id) return undefined;
  return t100Decrease(parseHolders(prev.holders_json), parseHolders(curr.holders_json));
}

const BAL_WINDOWS: Record<'d1' | 'd7' | 'd30', number> = {
  d1: 86_400_000,
  d7: 7 * 86_400_000,
  d30: 30 * 86_400_000,
};

/**
 * Peak/trough of the holder balance distribution per window, aggregated across
 * every snapshot in the window (the "balance chart" extremes). Includes every
 * top-100 row — exchange-classified addresses too (Nansen cohort toggle
 * semantics: always ON).
 * A window is only reported with FULL coverage — the oldest snapshot must be
 * older than the window — otherwise its numbers would just mirror a shorter
 * window and read as duplicates on the dashboard.
 */
export function computeBalanceRanges(ca: string, chain: Chain, now: number): { d1?: BalRange; d7?: BalRange; d30?: BalRange } {
  const firstSnapshotAt = earliestSnapshotAt(ca, chain);
  const out: { d1?: BalRange; d7?: BalRange; d30?: BalRange } = {};
  for (const [key, windowMs] of Object.entries(BAL_WINDOWS) as ['d1' | 'd7' | 'd30', number][]) {
    if (firstSnapshotAt === undefined || firstSnapshotAt > now - windowMs) continue;
    let peak: number | undefined;
    let trough: number | undefined;
    for (const snap of snapshotsSince(ca, chain, now - windowMs)) {
      for (const row of parseHolders(snap.holders_json)) {
        if (!(row.usdValue > 0)) continue;
        if (peak === undefined || row.usdValue > peak) peak = row.usdValue;
        if (trough === undefined || row.usdValue < trough) trough = row.usdValue;
      }
    }
    if (peak !== undefined && trough !== undefined) out[key] = { peak, trough };
  }
  return out;
}

/**
 * Nansen returns the raw on-chain ticker; scam tokens embed emoji in it
 * ("🌱 FART", "⚠️ SMART", "🚀 MOON"). Strip pictographs / VS16 / ZWJ /
 * skin-tone modifiers / flags and collapse whitespace so the dashboard shows a
 * plain ticker. Returns '' when nothing printable is left (caller omits it).
 */
export function sanitizeSymbol(sym: string): string {
  return sym
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The X/3 Nansen setup score plus the data-completeness flag the rejection gate needs. */
export interface NansenScore {
  /** Fresh-wallet % used for the pass test (nansen_fresh_pct, or the mock-mode fresh_count derivation). */
  fresh?: number;
  /** T100 genesis→trough multiple (A/B — the number the FE cell shows). */
  t100Multiple?: number;
  /** LF: the exchange chart's LEFTMOST point, token units. */
  lf?: number;
  freshPass: boolean;
  t100Pass: boolean;
  lfPass: boolean;
  /** Count of passing factors, 0..3 (factors that PASS, not merely present — Metis). */
  score: number;
  /**
   * true ONLY when EVERY factor input has arrived: st exists, symbol non-empty
   * after trim, supply/price/nansen_fresh_pct/t100_multiple/genesis_bal all
   * non-null. The raw nansen_fresh_pct column is required — the fresh_count
   * fallback is mock-mode only and must NOT qualify a row as complete.
   * false = "wait for the sweeps", never a rejection.
   */
  complete: boolean;
}

/**
 * Single source of truth for the three factor gates and the score. Extracted
 * verbatim from assembleSignals so the zero-score rejection gate (poller) and
 * the dashboard read the SAME thresholds with the SAME semantics.
 *
 * Division guards (Metis blocker): mc = 0 -> holding 0 / lf absent; holders = 0 -> fresh absent.
 * nansen_fresh_pct (supply share, written every token sweep) wins; the
 * fresh_count derivation is the mock-mode fallback.
 * LF (user 2026-09-11): the exchange chart's LEFTMOST point, token units —
 * the display value AND the gate input (absolute band: lfMin <= lf <= lfMax).
 * The T100 gate reads the MULTIPLE (A/B), not the pct.
 */
export function nansenScore(st: TokenStateRow | undefined, th: NansenThresholds): NansenScore {
  const baseHolders = st?.holders ?? 0;
  const fresh =
    st?.nansen_fresh_pct ??
    (st?.fresh_count != null && baseHolders > 0 ? (st.fresh_count / baseHolders) * 100 : undefined);
  const lf = st?.genesis_bal != null ? st.genesis_bal : undefined;
  const t100Multiple = st?.t100_multiple != null ? st.t100_multiple : undefined;

  // score counts factors that PASS, not merely present (Metis; thresholds runtime-adjustable via /api/settings).
  const freshPass = fresh !== undefined && fresh >= th.freshMinPct;
  const t100Pass = t100Multiple !== undefined && t100Multiple >= th.t100MinMultiple;
  const lfPass = lf !== undefined && lf >= th.lfMin && lf <= th.lfMax;
  let score = 0;
  if (freshPass) score += 1;
  if (t100Pass) score += 1;
  if (lfPass) score += 1;

  const complete =
    st !== undefined &&
    st.symbol != null &&
    st.symbol.trim() !== '' &&
    st.supply != null &&
    st.price != null &&
    st.nansen_fresh_pct != null &&
    st.t100_multiple != null &&
    st.genesis_bal != null;

  return { fresh, t100Multiple, lf, freshPass, t100Pass, lfPass, score, complete };
}

/** One TokenSignal per tracked CA. Rows without token_state yet render as zeros/absent factors. */
export function assembleSignals(now: number = Date.now(), allFactors = getDebugAllFactors()): TokenSignal[] {
  // Read per call (not once per module) so a PUT /api/settings lands on the
  // next /api/signals without a restart.
  const th = getThresholds();
  const out: TokenSignal[] = [];
  const lastActivityAt = latestWatchTradeTsByCa(now - 86_400_000);
  // User-set tiers (token_tiers) keyed `${chain}:${ca}` — one read for the whole pass.
  const tierByCa = new Map(listTiers().map((t) => [`${t.chain}:${t.ca}`, t.tier] as const));
  // Batched reads (N+1 fix): the former per-CA getTokenState / sumHoldingAmount /
  // trackedWalletStats calls ran ~460 × 3 prepares+queries per request; each map
  // below is ONE query and the loop is pure lookups. Output is byte-identical.
  const tokenStates = allTokenStates();
  const holdingByCa = sumHoldingAmountByCa();
  const walletStatsByCa = trackedWalletStatsByCa(now);
  const fomoStatsByCa = fomoUserStatsByCa(now);
  for (const c of listTrackedCas()) {
    const st = tokenStates.get(`${c.chain}:${c.address}`);
    const symbol = st?.symbol != null ? sanitizeSymbol(st.symbol) : '';
    // Debug "Show all factors" (user 2026-09-23) = the dash lists EVERY tracked CA:
    // the display gates below are the only thing that hides a row, so skip them
    // while the flag is on. Tracking (deletes, sweeps) is unaffected.
    if (!allFactors) {
      // NULL entry_usd = entry price UNKNOWN (pre-migration row, or scanner had no
      // price at track time) — fail-open so those rows are not silently dropped;
      // exclude only a KNOWN sub-threshold entry.
      if (c.entry_usd != null && c.entry_usd < th.minUsd) continue;
      // Market-cap band (user 2026-09-21): the floor drops a known-too-small cap, the
      // ceiling a known-too-large one (0 = that edge off). Same fail-open rule as minUsd
      // above: an UNKNOWN market_cap is not evidence of anything, so it passes; only a
      // value we actually measured can drop the row.
      if (st?.market_cap != null && (st.market_cap < th.minMc || (th.maxMc > 0 && st.market_cap > th.maxMc))) continue;
    }
    // `holders` is the live GMGN count (holder_count) — authoritative since
    // 2026-09-24; nansen_holders is the Nansen gini figure, kept as fallback.
    // `||` not `??`: a stored 0 means "no GMGN count yet", not "zero holders".
    const baseHolders = st?.holders ?? 0;
    const holders = st?.holders || st?.nansen_holders || baseHolders;

    const supply = st?.supply ?? 0;
    const t100Pct = st?.t100_pct ?? undefined;
    const holdingAmount = holdingByCa.get(`${c.chain}:${c.address}`) ?? 0;
    // balance-based per spec column 6 (inflow/mc is forbidden); ≡ balance/supply
    // with price cancelled out (amount×price / price×supply). supply=0 → 0.
    const trackedHolding = supply > 0 ? (holdingAmount / supply) * 100 : 0;

    // One query feeds both the FE rows and the token total — Σ rows by contract,
    // so the token figure can never drift from what the rows add up to.
    const trackedWallets = walletStatsByCa.get(`${c.chain}:${c.address}`) ?? [];
    const trackedInflow = trackedWallets.reduce((sum, w) => sum + w.inflow, 0);
    // The FOMO watch list rides along but never feeds trackedInflow/ordering —
    // separate list, separate stats, no leakage into the wallet score path.
    const fomoUsers = fomoStatsByCa.get(`${c.chain}:${c.address}`) ?? [];

    // Factor math lives in nansenScore (single source of truth, shared with the
    // poller's zero-score rejection gate) — output unchanged.
    const ns = nansenScore(st, th);

    out.push({
      id: `${c.chain}:${c.address}`,
      ca: c.address,
      chain: c.chain,
      ...(symbol !== '' ? { symbol } : {}),
      ...(st?.icon_url != null && st.icon_url !== '' ? { iconUrl: st.icon_url } : {}),
      trackedWallets,
      fomoUsers,
      nansen: {
        score: ns.score,
        pass: { fresh: ns.freshPass, t100: ns.t100Pass, lf: ns.lfPass },
        // Display gate (NOT the score above): show a factor if it passes, or if allFactors is on and it has a value.
        ...(ns.fresh !== undefined && (allFactors || ns.freshPass) ? { fresh: ns.fresh } : {}),
        ...(t100Pct !== undefined && (allFactors || ns.t100Pass)
          ? {
              t100: {
                pct: t100Pct,
                ...(ns.t100Multiple !== undefined ? { multiple: ns.t100Multiple } : {}),
              },
            }
          : {}),
        ...(ns.lf !== undefined && (allFactors || ns.lfPass) ? { lf: ns.lf } : {}),
      },
      holders,
      ...(st?.market_cap != null ? { marketCap: st.market_cap } : {}),
      trackedInflow,
      trackedActivityAt: lastActivityAt.get(c.address) ?? 0,
      trackedHolding,
      volume24h: st?.volume24h ?? 0,
      ...(st?.vol_1h != null ? { volume1h: st.vol_1h } : {}),
      tier: tierByCa.get(`${c.chain}:${c.address}`) ?? null,
      ...(st?.bal_peak_24h != null && st.bal_trough_24h != null
        ? {
            balanceRange: {
              ...(st.bal_peak_24h != null && st.bal_trough_24h != null ? { d1: { peak: st.bal_peak_24h, trough: st.bal_trough_24h } } : {}),
              ...(st.bal_peak_7d != null && st.bal_trough_7d != null ? { d7: { peak: st.bal_peak_7d, trough: st.bal_trough_7d } } : {}),
              ...(st.bal_peak_30d != null && st.bal_trough_30d != null ? { d30: { peak: st.bal_peak_30d, trough: st.bal_trough_30d } } : {}),
            },
          }
        : {}),
    });
  }
  // Dash order (user 2026-09-23, extended 2026-09-24): newest tracked ACTIVITY first, not the
  // amount — a member wallet's buy OR sell both lift the row. A CA with no member trade (0)
  // sinks and keeps listTrackedCas' added_at DESC among the rest.
  return out.sort((a, b) => b.trackedActivityAt - a.trackedActivityAt);
}
