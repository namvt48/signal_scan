// Signal assembly from DB state. The DTOs below mirror src/types.ts (the
// frontend never imports server modules, so the small shape is duplicated on
// purpose — keep the two in sync when the contract changes).

import { T100_WINDOW_MS, config } from './config.js';
import {
  allTokenStates,
  earliestSnapshotAt,
  getDb,
  getMetricPollCache,
  isPassTier,
  latestSnapshot,
  listMetricPollCache,
  listTiers,
  listTrackedCas,
  snapshotAtOrBefore,
  snapshotsSince,
  type TokenStateRow,
} from './db.js';
import { getDebugAllFactors, getThresholds, type NansenThresholds } from './settings.js';
import { t100Decrease } from './snapshot.js';
import { cohortLabelIndex } from './cohort-labels.js';
import type { HolderRow } from './providers/provider.js';
import type { Chain } from './shared/chain.js';
import type { Tier } from './shared/tier.js';

/** mirrors NansenSetup in src/types.ts */
export interface NansenSetup {
  score: number;
  /**
   * Per-factor gate result under the thresholds in force for THIS response.
   * Stale or unknown-time FW is historical, not a current passing factor.
   */
  pass: { fresh: boolean; t100: boolean; lf: boolean };
  /** Whether the last successful Fresh reading is inside the configured TTL. */
  freshCurrent: boolean;
  /** Timestamp of the last successful Fresh reading, including legacy poll-cache provenance. */
  freshUpdatedAt?: number;
  /** Historical Fresh-wallet supply percentage. */
  fresh?: number;
  /** Ungated measured Fresh %, retained for explicit historical inspection. */
  rawFresh?: number;
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
  /** PnL cohort rank and all qualifying behavior groups, refreshed hourly. */
  rank?: string;
  groups?: string[];
  /** Net USD this wallet put into the CA inside the inflow window: Σ buys − sells (source='watch'). May be negative. */
  inflow: number;
  /** watch BUY count inside the window. */
  buys: number;
  /** watch SELL count inside the window. */
  sells: number;
  /** Current token balance USD; 0 when zero_holding confirms empty; absent when unmeasured or a positive holding lacks price. */
  balUsd?: number;
  /** Current token balance in units; 0 when zero_holding confirms empty; absent when unmeasured. */
  holdingAmount?: number;
  /** Current token balance as a share of total supply; absent when balance/supply is unknown. */
  holdingPct?: number;
  /** Epoch ms of the wallet's newest watch trade for this CA inside the window; 0 = none. */
  lastTs: number;
}

/**
 * One watched FOMO trader's activity on a token. buyUsd is 24h BUY spend and
 * sellUsd is 24h SELL proceeds, both null when any in-window amount is
 * unresolved. They are reported separately and never netted: spend and
 * proceeds are different quantities. balUsd is the current position value
 * (amount × FOMO position price); holdingPct is that value divided by the CA's
 * market cap, not a share of token supply.
 */
export interface FomoUserStat {
  handle: string;
  name?: string;
  /** Display chips from fomo_users.tags; absent when the user has none. */
  tags?: string[];
  clan?: string;
  buyUsd: number | null;
  /** Σ sell proceeds (`trade_usd`) in the window; null if any SELL lacks it. */
  sellUsd: number | null;
  buys: number;
  sells: number;
  trades: number;
  lastTs: number;
  /** Σ token units the user's wallets hold of this CA; absent until measured. */
  holdingAmount?: number;
  /** balUsd / CA market cap × 100; absent when value or market cap is unknown. */
  holdingPct?: number;
  /** Current position value (amount × price); 0 only for a measured zero. */
  balUsd?: number;
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
  /** X (Twitter) handle (GMGN token/info) — bare handle, no leading '@'. Absent → FE falls back
   * to an X search for the CA. */
  xHandle?: string;
  trackedWallets: TrackedWalletStat[];
  /** FOMO watch-list users who EVER bought this (ca, chain); stats use the existing 24h window. */
  fomoUsers: FomoUserStat[];
  note?: string;
  /** Gross DEX buy/sell volume in the trailing 24h, when measured. */
  buyVol24h?: number;
  sellVol24h?: number;
  nansen: NansenSetup & { freshHistory?: { t: number; value: number }[]; freshUpdatedAt?: number };
  holdersHistory?: { t: number; value: number }[];
  holders: number;
  /** Market cap USD (price × circulating supply); absent until a sweep writes one. */
  marketCap?: number;
  /** Epoch-ms market-cap samples from existing market-data sweeps. */
  marketCapHistory?: { t: number; value: number }[];
  /** Successful provider-response timestamps (epoch ms), per independently cached dataset. */
  dataUpdatedAt?: {
    marketCap?: number;
    volume24h?: number;
    holders?: number;
    fresh?: number;
    symbol?: number;
    icon?: number;
  };
  /** Net USD tracked wallets put in over the last 24h (buys − sells); may be negative. */
  trackedInflow: number;
  /**
   * Newest source='watch' buy OR sell by a displayed native member, in the 24h
   * activity window; chain-scoped, with 0 when no displayed trade exists.
   */
  trackedActivityAt: number;
  /** Latest captured FOMO buy/sell or native watch trade for this (chain, CA), across all history. */
  fomoActivityAt?: number;
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

/** Raw SQLite row behind trackedWalletStats — address joins the cached cohort index. */
interface TrackedWalletRow {
  address: string;
  name: string;
  clan: string | null;
  tags: string;
  inflow: number;
  buys: number;
  sells: number;
  lastTs: number;
  balUsd: number | null;
  holdingAmount: number | null;
  supply: number | null;
}

function cohortFields(address: string): Pick<TrackedWalletStat, 'rank' | 'groups'> {
  const labels = cohortLabelIndex.get(address);
  return labels ? { ...(labels.rank ? { rank: labels.rank } : {}), groups: labels.groups } : {};
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

function supplyShare(holdingAmount: number | null, supply: number | null): number | undefined {
  if (holdingAmount == null || supply == null || !Number.isFinite(holdingAmount)
    || !Number.isFinite(supply) || holdingAmount < 0 || supply <= 0) return undefined;
  const pct = (holdingAmount / supply) * 100;
  return Number.isFinite(pct) ? pct : undefined;
}

/**
 * Per-wallet tracked stats for one CA — ONE query replacing the former
 * name-list + gross-buy-sum pair (contract change 2026-09-24: the FE
 * renders per-wallet rows, and inflow goes NET = buys − sells).
 *
 * MEMBERSHIP comes from an ever-observed watch BUY, a SOL holding snapshot, or
 * a positive measured wallet balance. Discovery can list existing holders with
 * zero buys, sells, and trades; it does not backfill or fabricate trade history.
 *
 * The stats (inflow/buys/sells/lastTs) cover the 24h inflow window — NARROWER
 * than membership, so a member whose newest buy is older appears with zero
 * stats and lastTs 0 (driving off the stat-window trades instead would drop it,
 * breaking membership parity with the old name list). balUsd reads the current
 * wallet_token_state row. holdingPct derives from token_amount / positive token_state.supply;
 * absent amounts or a missing/zero supply omit the field.
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
      `SELECT w.address AS address,
              w.name AS name,
              w.clan AS clan,
              w.tags AS tags,
              COALESCE(SUM(CASE WHEN t.side = 'buy' THEN t.amount_usd ELSE -t.amount_usd END), 0) AS inflow,
              SUM(CASE WHEN t.side = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.side = 'sell' THEN 1 ELSE 0 END) AS sells,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              COALESCE(MAX(s.balance_usd), MAX(CASE WHEN zh.zero_at IS NOT NULL THEN 0 END)) AS balUsd,
              COALESCE(MAX(s.token_amount), MAX(CASE WHEN zh.zero_at IS NOT NULL THEN 0 END)) AS holdingAmount,
              MAX(state.supply) AS supply
         FROM wallets w
         LEFT JOIN wallet_trades t
           ON t.wallet_id = w.id AND t.ca = @ca AND t.chain = @chain AND t.source = 'watch' AND t.ts >= @statSince
         LEFT JOIN wallet_token_state s ON s.wallet_id = w.id AND s.ca = @ca AND s.chain = @chain
         LEFT JOIN zero_holdings zh
           ON zh.member_type = 'wallet' AND zh.member_id = w.id AND zh.ca = @ca AND zh.chain = @chain
         LEFT JOIN token_state state ON state.ca = @ca AND state.chain = @chain
         WHERE (
           EXISTS (SELECT 1 FROM wallet_trades b
                    WHERE b.wallet_id = w.id AND b.ca = @ca AND b.chain = @chain
                      AND b.side = 'buy' AND b.source = 'watch'
                      AND NOT EXISTS (
                        SELECT 1 FROM zero_holdings zh
                         WHERE zh.member_type = 'wallet' AND zh.member_id = b.wallet_id
                           AND zh.ca = b.ca AND zh.chain = b.chain AND zh.zero_at <= @statSince
                      ))
           OR (@chain = 'sol' AND EXISTS (
             SELECT 1 FROM sol_wallet_holding_membership h
              WHERE h.wallet_id = w.id AND h.ca = @ca AND h.chain = 'sol'
           ))
           OR s.token_amount > 0
         )
         GROUP BY w.id
         ORDER BY lastTs DESC, w.name`,
    )
    .all({ ca, chain, statSince: now - 86_400_000 }) as TrackedWalletRow[];
  return rows.map(({ address, name, clan, tags, inflow, buys, sells, lastTs, balUsd, holdingAmount, supply }) => {
    const holdingPct = supplyShare(holdingAmount, supply);
    return {
      name,
      ...(clan != null && clan !== '' ? { clan } : {}),
      tags: parseTags(tags),
      ...cohortFields(address),
      inflow,
      buys,
      sells,
      lastTs,
      ...(balUsd != null ? { balUsd } : {}),
      ...(holdingAmount != null ? { holdingAmount } : {}),
      ...(holdingPct !== undefined ? { holdingPct } : {}),
    };
  });
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
          WHERE b.side = 'buy' AND b.source = 'watch'
            AND NOT EXISTS (
              SELECT 1 FROM zero_holdings zh
               WHERE zh.member_type = 'wallet' AND zh.member_id = b.wallet_id
                 AND zh.ca = b.ca AND zh.chain = b.chain AND zh.zero_at <= @statSince
            )
         UNION
         SELECT h.chain, h.ca, h.wallet_id FROM sol_wallet_holding_membership h
          JOIN wallets hw ON hw.id = h.wallet_id AND hw.chain = 'sol'
         UNION
         SELECT s.chain, s.ca, s.wallet_id FROM wallet_token_state s
          JOIN wallets hw ON hw.id = s.wallet_id AND hw.chain = s.chain
         WHERE s.token_amount > 0
       )
       SELECT m.chain AS chain,
              m.ca AS ca,
              w.address AS address,
              w.name AS name,
              w.clan AS clan,
              w.tags AS tags,
              COALESCE(SUM(CASE WHEN t.side = 'buy' THEN t.amount_usd ELSE -t.amount_usd END), 0) AS inflow,
              SUM(CASE WHEN t.side = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.side = 'sell' THEN 1 ELSE 0 END) AS sells,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              COALESCE(MAX(s.balance_usd), MAX(CASE WHEN zh.zero_at IS NOT NULL THEN 0 END)) AS balUsd,
              COALESCE(MAX(s.token_amount), MAX(CASE WHEN zh.zero_at IS NOT NULL THEN 0 END)) AS holdingAmount,
              MAX(state.supply) AS supply
         FROM members m
         JOIN wallets w ON w.id = m.wallet_id
         LEFT JOIN wallet_trades t
           ON t.wallet_id = m.wallet_id AND t.ca = m.ca AND t.chain = m.chain AND t.source = 'watch' AND t.ts >= @statSince
         LEFT JOIN wallet_token_state s ON s.wallet_id = m.wallet_id AND s.ca = m.ca AND s.chain = m.chain
         LEFT JOIN zero_holdings zh
           ON zh.member_type = 'wallet' AND zh.member_id = m.wallet_id AND zh.ca = m.ca AND zh.chain = m.chain
         LEFT JOIN token_state state ON state.ca = m.ca AND state.chain = m.chain
        GROUP BY m.chain, m.ca, m.wallet_id
        ORDER BY m.chain, m.ca, lastTs DESC, w.name`,
    )
    .all({ statSince: now - 86_400_000 }) as (TrackedWalletRow & { ca: string; chain: string })[];
  const out = new Map<string, TrackedWalletStat[]>();
  for (const { address, chain, ca, name, clan, tags, inflow, buys, sells, lastTs, balUsd, holdingAmount, supply } of rows) {
    const holdingPct = supplyShare(holdingAmount, supply);
    const stat: TrackedWalletStat = {
      name,
      ...(clan != null && clan !== '' ? { clan } : {}),
      tags: parseTags(tags),
      ...cohortFields(address),
      inflow,
      buys,
      sells,
      lastTs,
      ...(balUsd != null ? { balUsd } : {}),
      ...(holdingAmount != null ? { holdingAmount } : {}),
      ...(holdingPct !== undefined ? { holdingPct } : {}),
    };
    const key = `${chain}:${ca}`;
    const list = out.get(key);
    if (list) list.push(stat);
    else out.set(key, [stat]);
  }
  return out;
}

/** Raw SQLite row behind fomoUserStats — name is '' and clan NULL when unset.
 *  holdingAmount is NULL until the wallet's holding is measured; Bal and its
 *  market-cap percentage are derived in JS so both aggregations share one rule. */
interface FomoUserStatRow {
  handle: string;
  name: string;
  tags: string;
  clan: string | null;
  buyUsd: number | null;
  sellUsd: number | null;
  buys: number;
  sells: number;
  trades: number;
  lastTs: number;
  holdingAmount: number | null;
  positionPrice: number | null;
  tokenPrice: number | null;
  marketCap: number | null;
}

/**
 * Buy $ is a rolling-window flow, not a position snapshot. The joined `t` rows
 * are already constrained to `@statSince`. No BUYs means zero; if any in-window
 * BUY lacks `trade_usd`, the total is unknown rather than a partial or invented
 * amount. `usd_value` is a post-fill position stock and `cost_basis_usd` is a
 * position snapshot; neither can recover missing 24h spend.
 */
const BUY_USD_SQL = `CASE
  WHEN SUM(CASE WHEN t.type = 'buy' THEN 1 ELSE 0 END) = 0 THEN 0
  WHEN SUM(CASE WHEN t.type = 'buy' AND t.trade_usd IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
  ELSE SUM(CASE WHEN t.type = 'buy' THEN t.trade_usd END)
END AS buyUsd`;

/**
 * Sell $ is gross proceeds, not realised PnL: `trade_usd` is the USD actually
 * received, while a sell's `usd_value` is signed realised PnL. Same unknown
 * rule as Buy $ — one unresolved SELL makes the whole total unknown.
 */
const SELL_USD_SQL = `CASE
  WHEN SUM(CASE WHEN t.type = 'sell' THEN 1 ELSE 0 END) = 0 THEN 0
  WHEN SUM(CASE WHEN t.type = 'sell' AND t.trade_usd IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
  ELSE SUM(CASE WHEN t.type = 'sell' THEN t.trade_usd END)
END AS sellUsd`;

/** Position value and its market-cap share, shared by both aggregations. */
function fomoPositionMetrics(
  holdingAmount: number | null,
  positionPrice: number | null,
  tokenPrice: number | null,
  marketCap: number | null,
): { balUsd?: number; holdingPct?: number } {
  const price = positionPrice ?? tokenPrice;
  const balUsd = holdingAmount === 0
    ? 0
    : holdingAmount !== null && price !== null && Number.isFinite(price)
      ? holdingAmount * price
      : undefined;
  const holdingPct = balUsd === 0
    ? 0
    : balUsd !== undefined && marketCap !== null && Number.isFinite(marketCap) && marketCap > 0
      ? (balUsd * 100) / marketCap
      : undefined;
  return {
    ...(balUsd !== undefined ? { balUsd } : {}),
    ...(holdingPct !== undefined ? { holdingPct } : {}),
  };
}

/**
 * Per-user FOMO stats for one CA — the fomo mirror of trackedWalletStats, with
 * the same membership-vs-stats-window split.
 *
 * MEMBERSHIP mirrors `Tracked by` (ever-bought): a user is listed on a
 * type='buy' fomo_trades row for this (ca, chain) — EVER, with NO time bound —
 * so a user whose newest buy is older than the stats window appears with zero
 * stats and lastTs 0. A user with ONLY sells is ALSO a member when FOMO recorded
 * a position with positive token amount or cost basis; the firehose does not
 * backfill gaps, so a buy whose alert never arrived can leave only the position.
 * That position preserves membership/holding, but never contributes to Buy $;
 * Buy $ is known trade_usd from BUY rows in the rolling 24h window. Scoped to ONE
 * (chain, ca) identity: the same ca string on two chains must not pool trades.
 *
 * The stats cover the SAME 24h window trackedWalletStats uses. buyUsd sums
 * `trade_usd` on in-window BUY rows; sellUsd sums `trade_usd` on in-window SELL
 * rows (gross proceeds), never the sell's `usd_value` (signed realised PnL).
 * The two are reported SEPARATELY and are never combined into a net/inflow
 * figure: a buy's figure is a SPEND and a sell's is PROCEEDS — different
 * quantities that must never be summed (fomo_trades DDL).
 *
 * balUsd is the current position value: measured token amount × the FOMO
 * position's own price when available, else the chain-scoped token price.
 * holdingPct divides that value by token_state.market_cap — a share of the CA's
 * market cap, NOT amount / supply.
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
              u.tags AS tags,
              u.clan AS clan,
              ${BUY_USD_SQL},
              ${SELL_USD_SQL},
              SUM(CASE WHEN t.type = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.type = 'sell' THEN 1 ELSE 0 END) AS sells,
              COUNT(t.id) AS trades,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              CASE WHEN a.fomo_user_id IS NOT NULL AND a.captured_at >= @apiSince AND s.captured_at = a.captured_at AND s.available != 0
                         AND (p.amount IS NULL OR p.verified_at IS NULL OR p.verified_at < @apiSince OR a.captured_at >= p.verified_at) THEN a.amount
                   WHEN p.amount IS NOT NULL AND p.verified_at >= @apiSince THEN p.amount
                   WHEN h.measured_at >= @apiSince THEN h.amount END AS holdingAmount,
              MAX(CASE WHEN p.fetched_at >= @apiSince THEN p.price_usd END) AS positionPrice,
              MAX(state.price) AS tokenPrice,
              MAX(state.market_cap) AS marketCap
         FROM fomo_users u
         LEFT JOIN fomo_trades t
           ON t.fomo_user_id = u.id AND t.ca = @ca AND t.chain = @chain AND t.ts >= @statSince
         LEFT JOIN fomo_holdings h
           ON h.fomo_user_id = u.id AND h.ca = @ca AND h.chain = @chain
         LEFT JOIN fomo_api_holdings a
           ON a.fomo_user_id = u.id AND a.ca = @ca AND a.chain = @chain
         LEFT JOIN fomo_api_balance_snapshots s
           ON s.fomo_user_id = u.id
         LEFT JOIN token_state state
           ON state.ca = @ca AND state.chain = @chain
         LEFT JOIN (
           SELECT p.fomo_user_id, p.ca, p.chain, p.trade_id, p.status, p.amount, p.cost_basis_usd,
                  p.avg_entry_price, p.price_usd, p.realized_pnl_usd, p.unrealized_pnl_usd,
                  p.fetched_at, COALESCE(p.verified_at, p.fetched_at) AS verified_at
             FROM fomo_positions p
             LEFT JOIN fomo_position_snapshots ps ON ps.fomo_user_id = p.fomo_user_id
         ) p
           ON p.fomo_user_id = u.id AND p.ca = @ca AND p.chain = @chain
         WHERE (EXISTS (SELECT 1 FROM fomo_trades b
                        WHERE b.fomo_user_id = u.id AND b.ca = @ca AND b.chain = @chain
                          AND b.type = 'buy'
                          AND NOT EXISTS (
                            SELECT 1 FROM zero_holdings zh
                             WHERE zh.member_type = 'fomo'
                               AND zh.member_id = b.fomo_user_id
                               AND zh.ca = b.ca
                               AND zh.chain = b.chain
                               AND zh.zero_at <= @statSince
                          ))
            OR EXISTS (SELECT 1 FROM fomo_positions bp
                        WHERE bp.fomo_user_id = u.id AND bp.ca = @ca AND bp.chain = @chain
                          AND (bp.cost_basis_usd > 0 OR bp.amount > 0)
                          AND NOT EXISTS (
                            SELECT 1 FROM zero_holdings zh
                             WHERE zh.member_type = 'fomo'
                               AND zh.member_id = bp.fomo_user_id
                               AND zh.ca = bp.ca
                               AND zh.chain = bp.chain
                               AND zh.zero_at <= @statSince
                          )))
            OR EXISTS (SELECT 1 FROM fomo_api_holdings ah
                         JOIN fomo_api_balance_snapshots aps
                           ON aps.fomo_user_id = ah.fomo_user_id AND aps.captured_at = ah.captured_at
                        WHERE ah.fomo_user_id = u.id AND ah.ca = @ca AND ah.chain = @chain
                          AND ah.amount > 0 AND ah.captured_at >= @apiSince AND aps.available != 0)
        GROUP BY u.id
        ORDER BY lastTs DESC, u.handle`,
    )
    .all({ ca, chain, statSince: now - 86_400_000, apiSince: now - 86_400_000 }) as FomoUserStatRow[];
  return rows.map(({ handle, name, tags, clan, buyUsd, sellUsd, buys, sells, trades, lastTs, holdingAmount, positionPrice, tokenPrice, marketCap }) => {
    const tagList = parseTags(tags);
    const metrics = fomoPositionMetrics(holdingAmount, positionPrice, tokenPrice, marketCap);
    return {
      handle,
      ...(name !== '' ? { name } : {}),
      ...(tagList.length > 0 ? { tags: tagList } : {}),
      ...(clan != null && clan !== '' ? { clan } : {}),
      buyUsd,
      sellUsd,
      buys,
      sells,
      trades,
      lastTs,
      ...(holdingAmount != null ? { holdingAmount } : {}),
      ...metrics,
    };
  });
}

/**
 * Batched fomoUserStats for the /api/signals pass (N+1 fix): ONE query for
 * every CA, keyed `${chain}:${ca}` — the same identity tracked_cas is unique
 * on, and the same equality the per-CA `@ca`/`@chain` binds use.
 * Membership comes from a `members` CTE — NOT from joining the windowed trades —
 * and is ever-bought (no time window): a type='buy' fomo_trades row OR a
 * fomo_positions row with positive amount or cost basis (a buy whose firehose
 * alert never arrived — see fomoUserStats), so a member with no trade inside the 24h
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
          WHERE b.type = 'buy'
            AND NOT EXISTS (
              SELECT 1 FROM zero_holdings zh
               WHERE zh.member_type = 'fomo'
                 AND zh.member_id = b.fomo_user_id
                 AND zh.ca = b.ca
                 AND zh.chain = b.chain
                 AND zh.zero_at <= @statSince
            )
          UNION
         SELECT DISTINCT p.chain, p.ca, p.fomo_user_id
           FROM fomo_positions p
          WHERE (p.cost_basis_usd > 0 OR p.amount > 0)
            AND NOT EXISTS (
              SELECT 1 FROM zero_holdings zh
               WHERE zh.member_type = 'fomo'
                 AND zh.member_id = p.fomo_user_id
                 AND zh.ca = p.ca
                 AND zh.chain = p.chain
                 AND zh.zero_at <= @statSince
            )
          UNION
         SELECT DISTINCT a.chain, a.ca, a.fomo_user_id
           FROM fomo_api_holdings a
           JOIN fomo_api_balance_snapshots s
             ON s.fomo_user_id = a.fomo_user_id AND s.captured_at = a.captured_at
          WHERE a.amount > 0 AND a.captured_at >= @apiSince AND s.available != 0)
       SELECT m.chain AS chain,
              m.ca AS ca,
              u.handle AS handle,
              u.name AS name,
              u.tags AS tags,
              u.clan AS clan,
              ${BUY_USD_SQL},
              ${SELL_USD_SQL},
              SUM(CASE WHEN t.type = 'buy' THEN 1 ELSE 0 END) AS buys,
              SUM(CASE WHEN t.type = 'sell' THEN 1 ELSE 0 END) AS sells,
              COUNT(t.id) AS trades,
              COALESCE(MAX(t.ts), 0) AS lastTs,
              CASE WHEN a.fomo_user_id IS NOT NULL AND a.captured_at >= @apiSince AND s.captured_at = a.captured_at AND s.available != 0
                         AND (p.amount IS NULL OR p.verified_at IS NULL OR p.verified_at < @apiSince OR a.captured_at >= p.verified_at) THEN a.amount
                   WHEN p.amount IS NOT NULL AND p.verified_at >= @apiSince THEN p.amount
                   WHEN h.measured_at >= @apiSince THEN h.amount END AS holdingAmount,
              MAX(CASE WHEN p.fetched_at >= @apiSince THEN p.price_usd END) AS positionPrice,
              MAX(state.price) AS tokenPrice,
              MAX(state.market_cap) AS marketCap
         FROM members m
         JOIN fomo_users u ON u.id = m.fomo_user_id
         LEFT JOIN fomo_trades t
           ON t.fomo_user_id = m.fomo_user_id AND t.ca = m.ca AND t.chain = m.chain AND t.ts >= @statSince
         LEFT JOIN fomo_holdings h
           ON h.fomo_user_id = m.fomo_user_id AND h.ca = m.ca AND h.chain = m.chain
         LEFT JOIN fomo_api_holdings a
           ON a.fomo_user_id = m.fomo_user_id AND a.ca = m.ca AND a.chain = m.chain
         LEFT JOIN (
           SELECT p.fomo_user_id, p.ca, p.chain, p.trade_id, p.status, p.amount, p.cost_basis_usd,
                  p.avg_entry_price, p.price_usd, p.realized_pnl_usd, p.unrealized_pnl_usd,
                  p.fetched_at, COALESCE(p.verified_at, p.fetched_at) AS verified_at
             FROM fomo_positions p
             LEFT JOIN fomo_position_snapshots ps ON ps.fomo_user_id = p.fomo_user_id
         ) p
           ON p.fomo_user_id = m.fomo_user_id AND p.ca = m.ca AND p.chain = m.chain
         LEFT JOIN fomo_api_balance_snapshots s
           ON s.fomo_user_id = m.fomo_user_id
         LEFT JOIN token_state state
           ON state.ca = m.ca AND state.chain = m.chain
        GROUP BY m.chain, m.ca, m.fomo_user_id
        ORDER BY m.chain, m.ca, lastTs DESC, u.handle`,
    )
    .all({ statSince: now - 86_400_000, apiSince: now - 86_400_000 }) as (FomoUserStatRow & { ca: string; chain: string })[];
  const out = new Map<string, FomoUserStat[]>();
  for (const { chain, ca, handle, name, tags, clan, buyUsd, sellUsd, buys, sells, trades, lastTs, holdingAmount, positionPrice, tokenPrice, marketCap } of rows) {
    // Same conditional spreads (and key order) as fomoUserStats — the JSON
    // response must stay byte-identical.
    const tagList = parseTags(tags);
    const stat: FomoUserStat = {
      handle,
      ...(name !== '' ? { name } : {}),
      ...(tagList.length > 0 ? { tags: tagList } : {}),
      ...(clan != null && clan !== '' ? { clan } : {}),
      buyUsd,
      sellUsd,
      buys,
      sells,
      trades,
      lastTs,
      ...(holdingAmount != null ? { holdingAmount } : {}),
      ...fomoPositionMetrics(holdingAmount, positionPrice, tokenPrice, marketCap),
    };
    const key = `${chain}:${ca}`;
    const list = out.get(key);
    if (list) list.push(stat);
    else out.set(key, [stat]);
  }
  return out;
}

/**
 * `Tracked by` only — watch BUY history, SOL snapshot membership, or a positive
 * measured balance. Unlinked stale zero/negative rows are not summed. Scoped to
 * one (chain, ca) identity so the same address on another chain cannot inflate it.
 */
export function sumHoldingAmount(ca: string, chain: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(s.token_amount), 0) AS total FROM wallet_token_state s
        WHERE s.ca = ? AND s.chain = ?
          AND (EXISTS (SELECT 1 FROM wallet_trades t
                        WHERE t.wallet_id = s.wallet_id AND t.ca = s.ca AND t.chain = s.chain
                          AND t.side = 'buy' AND t.source = 'watch')
               OR (s.chain = 'sol' AND EXISTS (
                 SELECT 1 FROM sol_wallet_holding_membership h
                  WHERE h.wallet_id = s.wallet_id AND h.ca = s.ca AND h.chain = 'sol'
               ))
               OR s.token_amount > 0)
      `,
    )
    .get(ca, chain) as { total: number };
  return row.total;
}

/**
 * Batched sumHoldingAmount for the /api/signals pass (N+1 fix): ONE GROUP BY
 * over wallet_token_state keyed `${chain}:${ca}` (same equality as the per-CA
 * `WHERE s.ca = ? AND s.chain = ?`). Membership follows the same rule as the
 * per-CA query. A CA with no qualifying rows is ABSENT — callers read
 * `map.get(`${chain}:${ca}`) ?? 0`, matching the per-CA COALESCE(SUM, 0).
 */
export function sumHoldingAmountByCa(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT s.chain AS chain, s.ca AS ca, COALESCE(SUM(s.token_amount), 0) AS total FROM wallet_token_state s
        WHERE EXISTS (SELECT 1 FROM wallet_trades t
                       WHERE t.wallet_id = s.wallet_id AND t.ca = s.ca AND t.chain = s.chain
                         AND t.side = 'buy' AND t.source = 'watch')
           OR (s.chain = 'sol' AND EXISTS (
             SELECT 1 FROM sol_wallet_holding_membership h
              WHERE h.wallet_id = s.wallet_id AND h.ca = s.ca AND h.chain = 'sol'
           ))
           OR s.token_amount > 0
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
  /** Timestamp of the last successful Fresh read, if known. */
  freshUpdatedAt?: number;
  freshCurrent: boolean;
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
   * non-null. FW must also have a successful observation within its TTL; stale
   * or unknown-time FW waits rather than entering zero-score rejection.
   */
  complete: boolean;
}

function cachedFreshAt(st: TokenStateRow | undefined): number | undefined {
  if (st?.fresh_updated_at != null) return st.fresh_updated_at;
  if (!st) return undefined;
  const cached = getMetricPollCache(st.ca, st.chain, 'gini');
  if (cached?.response_at == null || cached.response_json === null) return undefined;
  try {
    const value: unknown = JSON.parse(cached.response_json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const fresh = Reflect.get(value, 'nansenFreshPct');
    return typeof fresh === 'number' && Number.isFinite(fresh) && fresh >= 0 && fresh <= 100
      ? cached.response_at
      : undefined;
  } catch {
    return undefined;
  }
}

const FRESH_TIMESTAMP_UNKNOWN = Symbol('fresh-timestamp-unknown');

/**
 * FW is retained as a historical value, but scores as a factor only while its
 * last successful observation is inside the configured TTL. Missing/future times
 * are not current; a true 0% reading remains a valid measured value.
 */
export function nansenScore(
  st: TokenStateRow | undefined,
  th: NansenThresholds,
  now = Date.now(),
  sampledFreshAt: number | null | typeof FRESH_TIMESTAMP_UNKNOWN = FRESH_TIMESTAMP_UNKNOWN,
): NansenScore {
  const baseHolders = st?.holders ?? 0;
  const fresh =
    st?.nansen_fresh_pct ??
    (st?.fresh_count != null && baseHolders > 0 ? (st.fresh_count / baseHolders) * 100 : undefined);
  const freshUpdatedAt = sampledFreshAt === FRESH_TIMESTAMP_UNKNOWN
    ? cachedFreshAt(st)
    : sampledFreshAt ?? undefined;
  const freshCurrent =
    fresh !== undefined &&
    freshUpdatedAt !== undefined &&
    Number.isFinite(freshUpdatedAt) &&
    freshUpdatedAt <= now &&
    now - freshUpdatedAt < config.pollSetupMs;
  const lf = st?.genesis_bal != null ? st.genesis_bal : undefined;
  const t100Multiple = st?.t100_multiple != null ? st.t100_multiple : undefined;

  // score counts factors that PASS, not merely present (Metis; thresholds runtime-adjustable via /api/settings).
  const freshPass = freshCurrent && fresh !== undefined && fresh >= th.freshMinPct;
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
    freshCurrent &&
    st.nansen_fresh_pct != null &&
    st.t100_multiple != null &&
    st.genesis_bal != null;

  return { fresh, freshUpdatedAt, freshCurrent, t100Multiple, lf, freshPass, t100Pass, lfPass, score, complete };
}


/**
 * Sparklines in the list view aggregate to 32 points in the browser anyway
 * (src/lib/chartHistory.ts); sending every stored sample made /api/signals
 * ~3.4 MB for 300 rows. Keep the exact first/last point and one representative
 * per time bucket so shape and tooltips survive while the payload shrinks.
 */
function downsampleHistory<T extends { t: number; value: number }>(points: readonly T[], maxPoints: number): T[] {
  const ordered = points.filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value)).sort((a, b) => a.t - b.t);
  if (ordered.length <= maxPoints) return ordered;
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const bucketCount = maxPoints - 2;
  const span = last.t - first.t;
  const buckets: T[][] = Array.from({ length: bucketCount }, () => []);
  for (let i = 1; i < ordered.length - 1; i += 1) {
    const point = ordered[i]!;
    const index = span > 0
      ? Math.min(bucketCount - 1, Math.floor(((point.t - first.t) / span) * bucketCount))
      : 0;
    buckets[index]!.push(point);
  }
  const picked = buckets.flatMap((bucket) => {
    if (bucket.length === 0) return [];
    // Preserve the extra T100 fields carried by a real sample.
    return [bucket[Math.floor(bucket.length / 2)]!];
  });
  return [first, ...picked, last];
}

const LIST_HISTORY_POINTS = 32;

/** One TokenSignal per tracked CA. Rows without token_state yet render as zeros/absent factors. */
export function assembleSignals(now: number = Date.now(), allFactors = getDebugAllFactors()): TokenSignal[] {
  // Read per call (not once per module) so a PUT /api/settings lands on the
  // next /api/signals without a restart.
  const th = getThresholds();
  const out: TokenSignal[] = [];
  // User-set tiers (token_tiers) keyed `${chain}:${ca}` — one read for the whole pass.
  const tierByCa = new Map(listTiers().map((t) => [`${t.chain}:${t.ca}`, t.tier] as const));
  // Batched reads keep database round trips independent of CA count.
  const tokenStates = allTokenStates();
  const holdingByCa = sumHoldingAmountByCa();
  const walletStatsByCa = trackedWalletStatsByCa(now);
  const fomoStatsByCa = fomoUserStatsByCa(now);
  const fomoActivity = getDb().prepare(`SELECT chain, ca, MAX(ts) AS ts FROM (
    SELECT t.chain, t.ca, t.ts
      FROM fomo_trades t JOIN tracked_cas c ON c.chain = t.chain AND c.address = t.ca
     WHERE t.type IN ('buy', 'sell') AND c.status != 'inactive'
    UNION ALL
    SELECT t.chain, t.ca, t.ts
      FROM wallet_trades t JOIN tracked_cas c ON c.chain = t.chain AND c.address = t.ca
     WHERE t.source = 'watch' AND c.status != 'inactive'
       AND EXISTS (SELECT 1 FROM wallet_trades b WHERE b.wallet_id = t.wallet_id AND b.chain = t.chain
                    AND b.ca = t.ca AND b.side = 'buy' AND b.source = 'watch')
  ) GROUP BY chain, ca`).all() as { chain: string; ca: string; ts: number }[];
  const fomoActivityAt = new Map(fomoActivity.map((t) => [`${t.chain}:${t.ca}`, t.ts]));
  const dataUpdatedAtByCa = new Map<string, NonNullable<TokenSignal['dataUpdatedAt']>>();
  const setTimestamp = (key: string, field: keyof NonNullable<TokenSignal['dataUpdatedAt']>, at: number) => {
    const current = dataUpdatedAtByCa.get(key) ?? {};
    if (current[field] === undefined || current[field]! < at) {
      dataUpdatedAtByCa.set(key, { ...current, [field]: at });
    }
  };
  for (const poll of listMetricPollCache()) {
    if (poll.response_at === null || poll.response_json === null) continue;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(poll.response_json);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = `${poll.chain}:${poll.ca}`;
    if (poll.kind === 'essential') {
      if (payload.marketCap !== undefined) setTimestamp(key, 'marketCap', poll.response_at);
      if (payload.holders !== undefined) setTimestamp(key, 'holders', poll.response_at);
      if (payload.symbol !== undefined) setTimestamp(key, 'symbol', poll.response_at);
    } else if (poll.kind === 'volume') {
      if (payload.volume24h !== undefined) setTimestamp(key, 'volume24h', poll.response_at);
    } else if (poll.kind === 'gini') {
      if (payload.nansenHolders !== undefined) setTimestamp(key, 'holders', poll.response_at);
      if (payload.nansenFreshPct !== undefined) setTimestamp(key, 'fresh', poll.response_at);
    } else if (poll.kind === 'dexMeta' || poll.kind === 'gmgnIcon') {
      if (poll.kind === 'dexMeta' && payload.price !== undefined) setTimestamp(key, 'marketCap', poll.response_at);
      if (poll.kind === 'dexMeta' && payload.symbol !== undefined) setTimestamp(key, 'symbol', poll.response_at);
      if (payload.iconUrl !== undefined) setTimestamp(key, 'icon', poll.response_at);
    }
  }
  for (const c of listTrackedCas()) {
    if (isPassTier(c.address, c.chain)) continue;
    const st = tokenStates.get(`${c.chain}:${c.address}`);
    const symbol = st?.symbol != null ? sanitizeSymbol(st.symbol) : '';
    const tier = tierByCa.get(`${c.chain}:${c.address}`) ?? null;
    // User-rated CAs (tier !== null) are explicitly tracked by the user and must never be hidden
    // by minUsd or market-cap display gates. Unrated CAs respect the gates when allFactors is off.
    if (!allFactors && tier === null) {
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
    const trackedActivityAt = trackedWallets.reduce((latest, wallet) => Math.max(latest, wallet.lastTs), 0);
    const trackedInflow = trackedWallets.reduce((sum, w) => sum + w.inflow, 0);
    // The FOMO watch list rides along but never feeds trackedInflow/ordering —
    // separate list, separate stats, no leakage into the wallet score path.
    const fomoUsers = fomoStatsByCa.get(`${c.chain}:${c.address}`) ?? [];

    // Factor math lives in nansenScore (single source of truth, shared with the
    // poller's zero-score rejection gate) — output unchanged.
    const freshTimestamp = dataUpdatedAtByCa.get(`${c.chain}:${c.address}`)?.fresh ?? st?.fresh_updated_at ?? null;
    const ns = nansenScore(st, th, now, freshTimestamp);

    out.push({
      id: `${c.chain}:${c.address}`,
      ca: c.address,
      ...(symbol ? { symbol } : {}),
      chain: c.chain,
      iconUrl: `/api/token-avatar/${c.chain}/${encodeURIComponent(c.address)}`,
      ...(st?.x_handle != null && st.x_handle !== '' ? { xHandle: st.x_handle } : {}),
      trackedWallets,
      fomoUsers,
      nansen: {
        score: ns.score,
        pass: { fresh: ns.freshPass, t100: ns.t100Pass, lf: ns.lfPass },
        freshCurrent: ns.freshCurrent,
        ...(ns.fresh !== undefined && (allFactors || ns.freshPass || !ns.freshCurrent) ? { fresh: ns.fresh } : {}),
        ...(ns.fresh !== undefined ? { rawFresh: ns.fresh } : {}),
        ...(t100Pct !== undefined && (allFactors || ns.t100Pass)
          ? { t100: { pct: t100Pct, ...(ns.t100Multiple !== undefined ? { multiple: ns.t100Multiple } : {}) } }
          : {}),
        ...(ns.lf !== undefined && (allFactors || ns.lfPass) ? { lf: ns.lf } : {}),
        ...(st?.fresh_history_json ? { freshHistory: downsampleHistory(JSON.parse(st.fresh_history_json) as { t: number; value: number }[], LIST_HISTORY_POINTS) } : {}),
        ...(st?.t100_history_json ? { t100History: downsampleHistory(JSON.parse(st.t100_history_json) as { t: number; value: number; peakBalance?: number; troughBalance?: number }[], LIST_HISTORY_POINTS) } : {}),
        ...(ns.freshUpdatedAt !== undefined ? { freshUpdatedAt: ns.freshUpdatedAt } : {}),
      },
      holders,
      ...(st?.holders_history_json ? { holdersHistory: downsampleHistory(JSON.parse(st.holders_history_json) as { t: number; value: number }[], LIST_HISTORY_POINTS) } : {}),
      ...(st?.market_cap != null ? { marketCap: st.market_cap } : {}),
      ...(st?.market_cap_history_json ? { marketCapHistory: downsampleHistory(JSON.parse(st.market_cap_history_json) as { t: number; value: number }[], LIST_HISTORY_POINTS) } : {}),
      trackedInflow,
      trackedActivityAt,
      fomoActivityAt: fomoActivityAt.get(`${c.chain}:${c.address}`) ?? 0,
      trackedHolding,
      volume24h: st?.volume24h ?? 0,
      ...(st?.buy_vol24h != null ? { buyVol24h: st.buy_vol24h } : {}),
      ...(st?.sell_vol24h != null ? { sellVol24h: st.sell_vol24h } : {}),
      ...(dataUpdatedAtByCa.has(`${c.chain}:${c.address}`)
        ? { dataUpdatedAt: dataUpdatedAtByCa.get(`${c.chain}:${c.address}`) }
        : {}),
      ...(c.user_note !== '' ? { note: c.user_note } : {}),
      ...(st?.vol_1h != null ? { volume1h: st.vol_1h } : {}),
      tier,
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
