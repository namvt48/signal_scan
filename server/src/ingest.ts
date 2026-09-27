// Reusable write layer — the REAL paid-upgrade seam. The poller writes through
// these functions today; a future Birdeye WS ingest calls the same ones, so
// push + poll can coexist safely (trades dedupe on UNIQUE(wallet_id, ca, chain,
// tx, side); balances are replaced per (wallet, chain) in one transaction).

import type { Chain } from './shared/chain.js';
import type {
  HolderRow,
  MetricPatch,
  TokenInfo,
  WalletActivity,
  WalletTokenHolding,
} from './providers/provider.js';
import { getDb, getTokenState } from './db.js';

export interface UpsertTokenOptions {
  /** Precomputed top-100 decrease percent (undefined -> stored as NULL). */
  t100Pct?: number | undefined;
  /** Precomputed balance-distribution peak/trough per window (undefined window -> NULLs). */
  bal?: {
    d1?: { peak: number; trough: number };
    d7?: { peak: number; trough: number };
    d30?: { peak: number; trough: number };
  };
}

export function upsertTokenInfo(info: TokenInfo, opts: UpsertTokenOptions = {}): void {
  getDb()
    .prepare(
      `INSERT INTO token_state
         (ca, chain, price, holders, volume24h, buy_vol24h, sell_vol24h, vol_1h,
          market_cap, liquidity, supply, fresh_count, fresh_rate, top10_rate, t100_pct,
          bal_peak_24h, bal_trough_24h, bal_peak_7d, bal_trough_7d, bal_peak_30d, bal_trough_30d,
          deployed_at, fetched_at, genesis_bal, symbol)
       VALUES
         (@ca, @chain, @price, @holders, @volume24h, @buyVol24h, @sellVol24h, @volume1h,
          @marketCap, @liquidity, @supply, @freshCount, @freshRate, @top10Rate, @t100Pct,
          @balPeak24h, @balTrough24h, @balPeak7d, @balTrough7d, @balPeak30d, @balTrough30d,
          @deployedAt, @fetchedAt, @genesisBal, @symbol)
       ON CONFLICT(ca, chain) DO UPDATE SET
         price = excluded.price,
         holders = excluded.holders,
         volume24h = excluded.volume24h,
         buy_vol24h = excluded.buy_vol24h,
         sell_vol24h = excluded.sell_vol24h,
         -- vol_1h: optional in TokenInfo (a failed 1h door omits it) — COALESCE keeps the last value
         vol_1h = COALESCE(excluded.vol_1h, token_state.vol_1h),
         market_cap = excluded.market_cap,
         liquidity = excluded.liquidity,
         supply = excluded.supply,
         top10_rate = COALESCE(excluded.top10_rate, token_state.top10_rate),
         fresh_count = COALESCE(excluded.fresh_count, token_state.fresh_count),
         fresh_rate = COALESCE(excluded.fresh_rate, token_state.fresh_rate),
         -- precomputed columns: only the series sweep (updateTokenAnalytics)
         -- writes them; the per-endpoint metric sweeps never touch them
         t100_pct = COALESCE(excluded.t100_pct, token_state.t100_pct),
         bal_peak_24h = COALESCE(excluded.bal_peak_24h, token_state.bal_peak_24h),
         bal_trough_24h = COALESCE(excluded.bal_trough_24h, token_state.bal_trough_24h),
         bal_peak_7d = COALESCE(excluded.bal_peak_7d, token_state.bal_peak_7d),
         bal_trough_7d = COALESCE(excluded.bal_trough_7d, token_state.bal_trough_7d),
         bal_peak_30d = COALESCE(excluded.bal_peak_30d, token_state.bal_peak_30d),
         bal_trough_30d = COALESCE(excluded.bal_trough_30d, token_state.bal_trough_30d),
         -- deployed_at is write-once (deploy time never changes)
         deployed_at = COALESCE(excluded.deployed_at, token_state.deployed_at),
         -- genesis_bal: mock synthesizes it here; Nansen omits (holders slot writes it)
         genesis_bal = COALESCE(excluded.genesis_bal, token_state.genesis_bal),
         -- symbol: refreshed every sweep pre-launch; omitted paths keep the last value
         symbol = COALESCE(excluded.symbol, token_state.symbol),
         fetched_at = excluded.fetched_at`,
    )
    .run({
      ca: info.ca,
      chain: info.chain,
      price: info.price,
      holders: info.holders,
      volume24h: info.volume24h,
      buyVol24h: info.buyVol24h,
      sellVol24h: info.sellVol24h,
      volume1h: info.volume1h ?? null,
      marketCap: info.marketCap,
      liquidity: info.liquidity,
      supply: info.supply,
      // Nansen omits freshCount/top10Rate/freshRate — COALESCE keeps the last
      // value (fresh_count gap: Nansen publishes supply %, not a wallet count).
      freshCount: info.freshCount ?? null,
      freshRate: null,
      top10Rate: info.top10Rate ?? null,
      t100Pct: opts.t100Pct ?? null,
      balPeak24h: opts.bal?.d1?.peak ?? null,
      balTrough24h: opts.bal?.d1?.trough ?? null,
      balPeak7d: opts.bal?.d7?.peak ?? null,
      balTrough7d: opts.bal?.d7?.trough ?? null,
      balPeak30d: opts.bal?.d30?.peak ?? null,
      balTrough30d: opts.bal?.d30?.trough ?? null,
      deployedAt: info.deployedAt ?? null,
      genesisBal: info.genesisBal ?? null,
      symbol: info.symbol ?? null,
      fetchedAt: Date.now(),
    });
}

/** Static column map — the ONLY source of SQL identifiers here (never the input). */
const METRIC_WRITERS: readonly (readonly [keyof MetricPatch, string, boolean?])[] = [
  ['price', 'price'],
  ['supply', 'supply'],
  ['marketCap', 'market_cap'],
  ['liquidity', 'liquidity'],
  ['volume24h', 'volume24h'],
  ['volume1h', 'vol_1h'],
  ['vol24hPrev', 'vol_24h_prev'],
  ['vol24hPrevAt', 'vol_24h_prev_at'],
  ['buyVol24h', 'buy_vol24h'],
  ['sellVol24h', 'sell_vol24h'],
  ['deployedAt', 'deployed_at'],
  ['symbol', 'symbol'],
  ['iconUrl', 'icon_url'],
  ['holders', 'holders'],
  ['nansenHolders', 'nansen_holders'],
  ['nansenFreshPct', 'nansen_fresh_pct'],
  // optional card fields — a young token omits them, COALESCE keeps the last value
  ['nansenT100Pct', 'nansen_t100_pct', true],
  ['nansenMedianUsd', 'nansen_median_usd', true],
];

/**
 * Partial metric write for ONE endpoint. Only the keys present in the patch are
 * touched, so the per-endpoint sweeps (each on its own cadence) never overwrite
 * each other's columns. Creates the row on first write: a CA whose essential
 * pass failed must still get its gini card instead of silently writing nowhere.
 */
export function updateTokenMetrics(ca: string, chain: Chain, patch: MetricPatch): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const sets: string[] = [];
  for (const [key, col, coalesce] of METRIC_WRITERS) {
    const v = patch[key];
    if (v === undefined) continue;
    cols.push(col);
    vals.push(v);
    sets.push(coalesce ? `${col} = COALESCE(excluded.${col}, token_state.${col})` : `${col} = excluded.${col}`);
  }
  if (cols.length === 0) return;
  sets.push('fetched_at = excluded.fetched_at');
  const placeholders = cols.map(() => '?').join(', ');
  getDb()
    .prepare(
      `INSERT INTO token_state (ca, chain, ${cols.join(', ')}, fetched_at) VALUES (?, ?, ${placeholders}, ?)
       ON CONFLICT(ca, chain) DO UPDATE SET ${sets.join(', ')}`,
    )
    .run(ca, chain, ...vals, Date.now());
}

/**
 * Authoritative analytics write (series sweep): undefined values CLEAR the
 * column — a window that lost coverage must not keep stale numbers.
 * The per-endpoint metric sweeps go through updateTokenMetrics instead so they
 * never touch analytics. t100_pct + t100_multiple are a pair (max-drawdown pct +
 * peak/trough coefficient); genesis_bal rides along (the LF factor: the exchange
 * chart's leftmost point) with anchor_at, the drawdown PEAK's time.
 */
export function updateTokenAnalytics(
  ca: string,
  chain: Chain,
  analytics: { t100Pct?: number; t100Multiple?: number; genesisBal?: number; anchorAt?: number; bal?: { d1?: { peak: number; trough: number }; d7?: { peak: number; trough: number }; d30?: { peak: number; trough: number } } },
): void {
  getDb()
    .prepare(
      `UPDATE token_state SET
         t100_pct = ?,
         t100_multiple = ?,
         genesis_bal = ?,
         anchor_at = ?,
         bal_peak_24h = ?, bal_trough_24h = ?,
         bal_peak_7d = ?, bal_trough_7d = ?,
         bal_peak_30d = ?, bal_trough_30d = ?,
         fetched_at = ?
       WHERE ca = ? AND chain = ?`,
    )
    .run(
      analytics.t100Pct ?? null,
      analytics.t100Multiple ?? null,
      analytics.genesisBal ?? null,
      analytics.anchorAt ?? null,
      analytics.bal?.d1?.peak ?? null,
      analytics.bal?.d1?.trough ?? null,
      analytics.bal?.d7?.peak ?? null,
      analytics.bal?.d7?.trough ?? null,
      analytics.bal?.d30?.peak ?? null,
      analytics.bal?.d30?.trough ?? null,
      Date.now(),
      ca,
      chain,
    );
}

/** Nansen token-sweep write — gini card set; absent t100/median keep last value. */
export function updateNansenHolders(
  ca: string,
  chain: Chain,
  stats: { holders: number; freshSupplyPct: number; t100SupplyPct?: number; medianBalanceUsd?: number },
): void {
  getDb()
    .prepare(
      `UPDATE token_state SET nansen_holders = ?, nansen_fresh_pct = ?,
         nansen_t100_pct = COALESCE(?, nansen_t100_pct),
         nansen_median_usd = COALESCE(?, nansen_median_usd)
       WHERE ca = ? AND chain = ?`,
    )
    .run(stats.holders, stats.freshSupplyPct, stats.t100SupplyPct ?? null, stats.medianBalanceUsd ?? null, ca, chain);
}

/** top10_rate — written by the holders snapshot slot from the top-10 percentOwnership sum. */
export function updateTop10Rate(ca: string, chain: Chain, pct: number): void {
  getDb().prepare('UPDATE token_state SET top10_rate = ? WHERE ca = ? AND chain = ?').run(pct, ca, chain);
}

export function insertSnapshot(ca: string, chain: Chain, rows: HolderRow[], takenAt: number): void {
  getDb()
    .prepare('INSERT INTO holder_snapshots (ca, chain, taken_at, holders_json) VALUES (?, ?, ?, ?)')
    .run(ca, chain, takenAt, JSON.stringify(rows));
}

/**
 * Pair-scoped replace: ONLY the (wallet, ca) rows named in `rows` are touched, so
 * a caller that queried one (CA, wallet) pair writes one row and leaves the rest of
 * the wallet's portfolio alone. A pair the RPC came back empty for arrives as
 * amount 0 and its old row is DELETED — a sold-out wallet has to decay to zero, or
 * Tracked holding freezes at its last nonzero value.
 * balance_usd is computed here as amount × token_state.price (informational —
 * the Tracked by / Holding % readers use token_amount, which survives a missing
 * or stale price). A CA with no price yet stores NULL, NOT 0: MAX(balance_usd)
 * then reads NULL, trackedWalletStats drops the key, and the FE renders "—"
 * instead of a fake $0 (261 such rows were showing as $0 on 2026-09-24).
 */
export function replaceWalletBalances(walletId: string, chain: Chain, rows: WalletTokenHolding[]): void {
  const db = getDb();
  const run = db.transaction((wid: string, current: WalletTokenHolding[]) => {
    // Chain-scoped on BOTH sides: a sol sweep must never delete (or overwrite)
    // the same wallet's base/bsc rows — chain is part of the PK since T3.
    const del = db.prepare('DELETE FROM wallet_token_state WHERE wallet_id = ? AND ca = ? AND chain = ?');
    const ins = db.prepare(
      'INSERT INTO wallet_token_state (wallet_id, ca, balance_usd, token_amount, chain) VALUES (?, ?, ?, ?, ?)',
    );
    const priceCache = new Map<string, number | null>();
    for (const r of current) {
      del.run(wid, r.ca, chain);
      if (r.amount <= 0) continue;
      let price = priceCache.get(r.ca);
      if (price === undefined) {
        const p = getTokenState(r.ca, chain)?.price;
        price = p != null && p > 0 ? p : null; // no usable price -> NULL, never a fake 0
        priceCache.set(r.ca, price);
      }
      ins.run(wid, r.ca, price !== null ? r.amount * price : null, r.amount, chain);
    }
  });
  run(walletId, rows);
}

/**
 * Dedupes on UNIQUE(wallet_id, ca, chain, tx, side) — repolling the
 * same activity window is idempotent. Returns the number of newly inserted rows.
 */
export function insertTrades(
  walletId: string,
  activities: WalletActivity[],
  source: 'nansen' | 'watch' = 'nansen',
): number {
  const db = getDb();
  // UNIQUE(wallet_id, ca, chain, tx, side) holds ONE row per on-chain trade, so a
  // trade both detectors saw must not be written twice: on conflict the 'watch'
  // (Solana-RPC) provenance wins, because that is what drives `Tracked by`.
  // The WHERE keeps a no-op conflict at 0 changes, so `inserted` still means
  // "newly inserted" for callers that assert idempotency.
  const ins = db.prepare(
    `INSERT INTO wallet_trades (wallet_id, ca, ts, side, amount_usd, price, tx, source, chain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet_id, ca, chain, tx, side)
     DO UPDATE SET source = 'watch'
       WHERE wallet_trades.source = 'nansen' AND excluded.source = 'watch'`,
  );
  let inserted = 0;
  const run = db.transaction((rows: WalletActivity[]) => {
    for (const a of rows) {
      inserted += ins.run(walletId, a.ca, a.ts, a.side, a.amountUsd, a.price, a.tx, source, a.chain).changes;
    }
  });
  run(activities);
  return inserted;
}
