// CA detail assembly — the 5 Nansen distribution metrics + top-100 table.
// All values come from data already in SQLite (holder_snapshots + token_state);
// no upstream calls. The only live call (balance chart) lives in crawl.ts.

import { getTokenState, latestSnapshot, type SnapshotRow } from './db.js';
import { getDb } from './db.js';
import type { Chain } from './shared/chain.js';
import type { HolderRow } from './providers/provider.js';

export interface Top100Row {
  address: string;
  /** % of supply, 0-100. */
  percentOwnership: number;
  /** Token units. */
  balance: number;
  balanceUsd: number;
  addrType: number;
  isNew: boolean;
  chg24h?: number;
  /** Nansen label (entity/name) when present. */
  name?: string;
}

export interface TokenDetail {
  ca: string;
  chain: Chain;
  price: number;
  supply: number;
  holders: number;
  /** Supply fraction held by fresh wallets (nansen_fresh_pct / legacy fresh_rate), 0-100. */
  freshSupplyPct?: number;
  /** Nansen gini top-100 SUPPLY share (falls back to Σ snapshot rows' %). */
  top100SupplyPct?: number;
  /** Median token amount across all top-100 holders (incl. exchange-classified). */
  medianHolderAmount?: number;
  /** Nansen gini median holder balance, USD — the app's "Median Holder" card. */
  medianHolderUsd?: number;
  top100: Top100Row[];
  snapshotAt?: number;
}

function parseHolders(json: string): HolderRow[] {
  return JSON.parse(json) as HolderRow[];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function buildTokenDetail(ca: string, chain: Chain): TokenDetail | null {
  const st = getTokenState(ca, chain);
  if (!st) return null;
  const snap: SnapshotRow | undefined = latestSnapshot(ca, chain);
  const rows: HolderRow[] = snap ? parseHolders(snap.holders_json) : [];
  const supply = st.supply ?? 0;

  const top100: Top100Row[] = rows.map((r) => ({
    address: r.address,
    percentOwnership: r.amountPct * 100,
    balance: r.amountPct * supply,
    balanceUsd: r.usdValue ?? 0,
    addrType: r.addrType,
    isNew: r.isNew,
    ...(r.chg24h !== undefined ? { chg24h: r.chg24h } : {}),
    ...(r.name !== undefined ? { name: r.name } : {}),
  }));

  const top100SupplyPct = st.nansen_t100_pct ?? (rows.length ? rows.reduce((a, r) => a + r.amountPct, 0) * 100 : undefined);
  const medianHolderAmount =
    supply > 0 ? median(rows.map((r) => r.amountPct * supply)) : undefined;
  // fresh_supply % read order: nansen_fresh_pct (token sweep, authoritative) →
  // legacy fresh_rate → fresh_count derivation (mock mode only since the cutover).
  const freshSupplyPct =
    st.nansen_fresh_pct != null
      ? st.nansen_fresh_pct
      : st.fresh_rate != null
        ? st.fresh_rate * 100
        : st.fresh_count != null && (st.holders ?? 0) > 0
          ? (st.fresh_count / (st.holders as number)) * 100
          : undefined;

  return {
    ca,
    chain,
    price: st.price ?? 0,
    supply,
    holders: st.nansen_holders ?? st.holders ?? 0,
    freshSupplyPct,
    top100SupplyPct,
    medianHolderAmount,
    medianHolderUsd: st.nansen_median_usd ?? undefined,
    top100,
    snapshotAt: snap?.taken_at,
  };
}

/** Own-snapshot fallback series: Σ top-100 balance per snapshot (tokens + USD). */
export function snapshotSeries(ca: string, chain: Chain, sinceMs: number): { t: number; total: number; totalUsd: number }[] {
  const st = getTokenState(ca, chain);
  const supply = st?.supply ?? 0;
  return (
    getDb()
      .prepare('SELECT taken_at, holders_json FROM holder_snapshots WHERE ca = ? AND chain = ? AND taken_at >= ? ORDER BY taken_at ASC')
      .all(ca, chain, sinceMs) as { taken_at: number; holders_json: string }[]
  ).map((row) => {
    const rows = parseHolders(row.holders_json);
    return {
      t: row.taken_at,
      total: rows.reduce((a, r) => a + r.amountPct, 0) * supply,
      totalUsd: rows.reduce((a, r) => a + (r.usdValue ?? 0), 0),
    };
  });
}
