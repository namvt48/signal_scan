import { getDb, getAlertMetricObservations, getFomoApiBalanceSnapshot, getFomoPositionSnapshot, getTokenState, listFomoHoldingsForUser, listFomoPositionsForUser, listFomoTradesForUser, listFomoUsers, listWallets } from './db.js';
import { buildTokenDetail } from './detail.js';
import { balanceSeries } from './crawl.js';
import { assembleSignals, fomoUserStats, type TokenSignal } from './signals.js';
import type { AlertOrigin } from './alert-feed.js';
import type { Chain } from './shared/chain.js';
import type {
  PublicActivity, PublicAlert, PublicBalancePoint, PublicBalanceSeries, PublicFomoFreshness, PublicFomoHolding, PublicFomoPosition,
  PublicFomoPositionsPage, PublicFomoToken, PublicFomoTrade, PublicFomoUser, PublicFomoUserStat, PublicSnapshot, PublicToken, PublicTokenDetail, PublicTrade,
  PublicWallet, T100HistoryPoint,
} from './public-api-contract.js';

function points(raw: string | undefined): Array<{ t: number; value: number }> {
  if (raw === undefined) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ t: number; value: number }> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const t = Reflect.get(item, 't');
    const value = Reflect.get(item, 'value');
    if (typeof t === 'number' && Number.isSafeInteger(t) && typeof value === 'number' && Number.isFinite(value)) out.push({ t, value });
  }
  return out;
}

function t100Points(raw: string | undefined): T100HistoryPoint[] {
  if (raw === undefined) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const out: T100HistoryPoint[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const t = Reflect.get(item, 't');
    const value = Reflect.get(item, 'value');
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const peakBalance = Reflect.get(item, 'peakBalance');
    const troughBalance = Reflect.get(item, 'troughBalance');
    out.push({
      t, value,
      ...(typeof peakBalance === 'number' && Number.isFinite(peakBalance) ? { peakBalance } : {}),
      ...(typeof troughBalance === 'number' && Number.isFinite(troughBalance) ? { troughBalance } : {}),
    });
  }
  return out;
}

function iconPath(chain: Chain, ca: string): string {
  return `/api/token-avatar/${chain}/${encodeURIComponent(ca)}`;
}

function toPublicToken(signal: TokenSignal): PublicToken {
  const db = getDb();
  const state = db.prepare('SELECT price, market_cap, holders, volume24h, vol_1h, buy_vol24h, sell_vol24h FROM token_state WHERE ca = ? AND chain = ?')
    .get(signal.ca, signal.chain) as { price: number | null; market_cap: number | null; holders: number | null; volume24h: number | null; vol_1h: number | null; buy_vol24h: number | null; sell_vol24h: number | null } | undefined;
  const history = db.prepare('SELECT market_cap_history_json, holders_history_json, fresh_history_json, t100_history_json FROM token_state WHERE ca = ? AND chain = ?')
    .get(signal.ca, signal.chain) as { market_cap_history_json: string | null; holders_history_json: string | null; fresh_history_json: string | null; t100_history_json: string | null } | undefined;
  const freshness = signal.dataUpdatedAt;
  return {
    id: signal.id, ca: signal.ca, chain: signal.chain, symbol: signal.symbol ?? null, tier: signal.tier,
    iconUrl: signal.iconUrl ?? iconPath(signal.chain, signal.ca),
    xHandle: signal.xHandle ?? null,
    market: {
      price: state?.price ?? null, marketCap: signal.marketCap ?? null, holders: signal.holders,
      volume24h: signal.volume24h, volume1h: signal.volume1h ?? null,
      buyVol24h: signal.buyVol24h ?? null, sellVol24h: signal.sellVol24h ?? null,
      dataUpdatedAt: {
        marketCap: freshness?.marketCap ?? null, volume24h: freshness?.volume24h ?? null,
        holders: freshness?.holders ?? null, fresh: freshness?.fresh ?? null,
        symbol: freshness?.symbol ?? null, icon: freshness?.icon ?? null,
      },
    },
    metrics: {
      score: signal.nansen.score, pass: { ...signal.nansen.pass },
      fresh: signal.nansen.fresh ?? null, rawFresh: signal.nansen.rawFresh ?? null,
      freshCurrent: signal.nansen.freshCurrent, freshUpdatedAt: signal.nansen.freshUpdatedAt ?? null,
      t100: signal.nansen.t100 ? { pct: signal.nansen.t100.pct, multiple: signal.nansen.t100.multiple ?? null } : null,
      lf: signal.nansen.lf ?? null,
      trackedHolding: signal.trackedHolding,
      trackedInflow: signal.trackedInflow,
      trackedActivityAt: signal.trackedActivityAt,
    },
    balanceRange: signal.balanceRange
      ? {
        d1: signal.balanceRange.d1 ?? null,
        d7: signal.balanceRange.d7 ?? null,
        d30: signal.balanceRange.d30 ?? null,
      }
      : null,
    history: {
      marketCap: points(history?.market_cap_history_json ?? undefined), holders: points(history?.holders_history_json ?? undefined),
      fresh: points(history?.fresh_history_json ?? undefined), t100: t100Points(history?.t100_history_json ?? undefined),
    },
  };
}

export function exportSnapshot(now = Date.now(), signals?: readonly TokenSignal[]): PublicSnapshot {
  return { generatedAt: now, tokens: (signals ?? assembleSignals(now, true)).map(toPublicToken) };
}

export function exportToken(chain: Chain, ca: string, now = Date.now(), signals?: readonly TokenSignal[]): PublicToken | undefined {
  const found = (signals ?? assembleSignals(now, true)).find((item) => item.chain === chain && item.ca === ca);
  return found ? toPublicToken(found) : undefined;
}

function toPublicFomoToken(signal: TokenSignal): PublicFomoToken {
  return { ...toPublicToken(signal), fomoUsers: signal.fomoUsers };
}

/** FOMO-instance token table: same token payload as `exportSnapshot`, plus
 *  each token's FOMO watch-list rows (the dashboard's main table). */
export function exportFomoTokens(now = Date.now(), signals?: readonly TokenSignal[]): { generatedAt: number; tokens: PublicFomoToken[] } {
  return { generatedAt: now, tokens: (signals ?? assembleSignals(now, true)).map(toPublicFomoToken) };
}

export function exportFomoToken(chain: Chain, ca: string, now = Date.now(), signals?: readonly TokenSignal[]): PublicFomoToken | undefined {
  const found = (signals ?? assembleSignals(now, true)).find((item) => item.chain === chain && item.ca === ca);
  return found ? toPublicFomoToken(found) : undefined;
}

export function exportTokenDetail(chain: Chain, ca: string): PublicTokenDetail | undefined {
  const detail = buildTokenDetail(ca, chain);
  if (!detail) return undefined;
  return {
    ca: detail.ca, chain: detail.chain, price: detail.price, supply: detail.supply, holders: detail.holders,
    freshSupplyPct: detail.freshSupplyPct ?? null,
    top100SupplyPct: detail.top100SupplyPct ?? null,
    medianHolderAmount: detail.medianHolderAmount ?? null,
    medianHolderUsd: detail.medianHolderUsd ?? null,
    top100: detail.top100.map((row) => ({
      address: row.address, percentOwnership: row.percentOwnership, balance: row.balance,
      balanceUsd: row.balanceUsd, addrType: row.addrType, isNew: row.isNew,
      chg24h: row.chg24h ?? null, name: row.name ?? null,
    })),
    snapshotAt: detail.snapshotAt ?? null,
  };
}

export async function exportBalanceSeries(
  chain: Chain,
  ca: string,
  window: 'day' | 'week' | 'month',
  options: { allowRefresh?: boolean } = {},
): Promise<PublicBalanceSeries> {
  const series = await balanceSeries(ca, chain, window, options);
  const points: PublicBalancePoint[] = [];
  for (const point of series.points) {
    const t = typeof point.t === 'number' ? point.t : Date.parse(String(point.t));
    if (!Number.isFinite(t)) continue;
    points.push({
      t,
      total: point.total,
      totalUsd: point.totalUsd ?? null,
      holders: point.holders ?? null,
      inflow: point.inflow ?? null,
    });
  }
  return { source: series.source, points, cachedAt: series.cachedAt ?? null };
}

export function exportWallets(): PublicWallet[] {
  return listWallets().map((wallet) => ({
    id: wallet.id, address: wallet.address, chain: wallet.chain, name: wallet.name,
    tags: parseTags(wallet.tags), clan: wallet.clan,
  }));
}

function parseTags(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

export function exportTrades(walletId: string, afterId: number, limit: number, from: number, to: number): { data: PublicTrade[]; nextId: number | null } {
  const rows = getDb().prepare(`SELECT id, wallet_id, ca, chain, ts, side, amount_usd, price, tx FROM wallet_trades
    WHERE wallet_id = ? AND source = 'watch' AND id > ? AND ts >= ? AND ts < ?
    ORDER BY id LIMIT ?`).all(walletId, afterId, from, to, limit + 1) as Array<{
      id: number; wallet_id: string; ca: string; chain: Chain; ts: number; side: 'buy' | 'sell'; amount_usd: number | null; price: number | null; tx: string | null;
    }>;
  const page = rows.slice(0, limit);
  const data = page.map((r) => ({ id: r.id, walletId: r.wallet_id, ca: r.ca, chain: r.chain, ts: r.ts, side: r.side, amountUsd: r.amount_usd, price: r.price, tx: r.tx }));
  return { data, nextId: rows.length > limit ? data.at(-1)?.id ?? null : null };
}

export function exportActivity(chain: Chain, ca: string, from: number, to: number): PublicActivity {
  const row = getDb().prepare(`SELECT COUNT(*) AS trades,
    SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buys,
    SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells,
    SUM(CASE WHEN side = 'buy' THEN COALESCE(amount_usd, 0) ELSE 0 END) AS buy_usd,
    SUM(CASE WHEN side = 'sell' THEN COALESCE(amount_usd, 0) ELSE 0 END) AS sell_usd
    FROM wallet_trades WHERE ca = ? AND chain = ? AND source = 'watch' AND ts >= ? AND ts < ?`)
    .get(ca, chain, from, to) as { trades: number; buys: number | null; sells: number | null; buy_usd: number | null; sell_usd: number | null };
  const buyUsd = row.buy_usd ?? 0;
  const sellUsd = row.sell_usd ?? 0;
  return { chain, ca, from, to, buys: row.buys ?? 0, sells: row.sells ?? 0, buyUsd, sellUsd, netInflowUsd: buyUsd - sellUsd };
}

export function exportFomoUsers(): PublicFomoUser[] {
  return listFomoUsers().map((user) => ({
    id: user.id, handle: user.handle, name: user.name, tags: parseTags(user.tags),
    clan: user.clan ?? null, userId: user.user_id ?? null,
    walletSolana: user.wallet_solana ?? null, walletEvm: user.wallet_evm ?? null,
    source: user.source,
  }));
}

/** Per-token FOMO watch-list stats — the same aggregation the dashboard's FOMO
 *  table renders (24h buy/sell flow plus the measured holding). */
export function exportFomoTokenStats(chain: Chain, ca: string, now = Date.now()): PublicFomoUserStat[] {
  return fomoUserStats(ca, chain, now);
}

export function exportFomoTrades(userId: string, afterId: number, limit: number, from: number, to: number): { data: PublicFomoTrade[]; nextId: number | null } {
  const rows = listFomoTradesForUser(userId, afterId, limit, from, to);
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => ({
      id: row.id, userId: row.fomo_user_id, handle: row.handle, eventId: row.event_id,
      ca: row.ca, chain: row.chain, side: row.type, usdValue: row.usd_value,
      tradeUsd: row.trade_usd, price: row.price, token: row.token, ts: row.ts, source: row.source,
    })),
    nextId: rows.length > limit ? page.at(-1)?.id ?? null : null,
  };
}

/** Stored positions plus every balance measurement for the user. A user can
 *  have a measured holding without a position row (a buy whose alert never
 *  arrived), so those CAs appear with null position fields and fetchedAt 0.
 *  `freshness` reports when the upstream balance/position refresh last ran. */
export function exportFomoPositions(userId: string): PublicFomoPositionsPage {
  const positions = listFomoPositionsForUser(userId);
  const holdingsByCa = new Map<string, { ca: string; chain: Chain; holdings: PublicFomoHolding[] }>();
  for (const row of listFomoHoldingsForUser(userId)) {
    const key = `${row.chain}:${row.ca}`;
    const entry = holdingsByCa.get(key) ?? { ca: row.ca, chain: row.chain, holdings: [] };
    entry.holdings.push({
      source: row.source, amount: row.amount, pct: row.pct, capturedAt: row.captured_at,
      ...(row.wallet !== null ? { wallet: row.wallet } : {}),
    });
    holdingsByCa.set(key, entry);
  }
  const out: PublicFomoPosition[] = positions.map((row) => ({
    ca: row.ca, chain: row.chain, tradeId: row.trade_id, status: row.status, amount: row.amount,
    costBasisUsd: row.cost_basis_usd, avgEntryPrice: row.avg_entry_price, priceUsd: row.price_usd,
    realizedPnlUsd: row.realized_pnl_usd, unrealizedPnlUsd: row.unrealized_pnl_usd,
    fetchedAt: row.fetched_at, holdings: holdingsByCa.get(`${row.chain}:${row.ca}`)?.holdings ?? [],
  }));
  const positioned = new Set(positions.map((row) => `${row.chain}:${row.ca}`));
  for (const [key, entry] of holdingsByCa) {
    if (positioned.has(key)) continue;
    out.push({
      ca: entry.ca, chain: entry.chain, tradeId: null, status: null, amount: null,
      costBasisUsd: null, avgEntryPrice: null, priceUsd: null, realizedPnlUsd: null,
      unrealizedPnlUsd: null, fetchedAt: 0, holdings: entry.holdings,
    });
  }
  return { data: out.sort((a, b) => a.chain.localeCompare(b.chain) || a.ca.localeCompare(b.ca)), freshness: exportFomoFreshness(userId) };
}

/** Refresh metadata for a FOMO user: when balances/positions were last read and
 *  whether the upstream returned a complete, untruncated balance list. */
export function exportFomoFreshness(userId: string): PublicFomoFreshness {
  const balance = getFomoApiBalanceSnapshot(userId);
  const position = getFomoPositionSnapshot(userId);
  return {
    balances: balance === undefined ? null : {
      checkedAt: balance.checked_at, capturedAt: balance.captured_at,
      complete: balance.complete === 1, truncated: balance.truncated === 1, available: balance.available === 1,
    },
    positions: position === undefined ? null : { checkedAt: position.checked_at },
  };
}

export function exportAlerts(
  afterId: number,
  limit: number,
  originFilter: 'main' | 'fomo' = 'main',
): { data: PublicAlert[]; nextId: number; oldestAvailableId: number | null; gap: boolean } {
  const db = getDb();
  const origins: readonly AlertOrigin[] = originFilter === 'fomo' ? ['fomo'] : ['market', 'wallet'];
  const oldest = db.prepare(
    `SELECT MIN(id) AS id FROM alert_metric_observations WHERE origin IN (${origins.map(() => '?').join(',')})`,
  ).get(...origins) as { id: number | null };
  const items = getAlertMetricObservations(afterId, limit + 1, origins);
  const page = items.slice(0, limit).map((item) => {
    const state = getTokenState(item.ca, item.chain);
    return {
      id: item.id, ca: item.ca, chain: item.chain, metric: item.metric, value: item.value, responseAt: item.responseAt,
      snapshot: {
        capturedAt: item.snapshot.capturedAt, symbol: item.snapshot.symbol, marketCap: item.snapshot.marketCap,
        marketCapAt: item.snapshot.marketCapAt, freshPct: item.snapshot.freshPct,
        t100Multiple: item.snapshot.t100Multiple, lf: item.snapshot.lf,
        trackedHoldingPct: item.snapshot.trackedHoldingPct ?? null,
        iconUrl: iconPath(item.chain, item.ca),
        xHandle: state?.x_handle != null && state.x_handle !== '' ? state.x_handle : null,
      },
    };
  });
  return {
    data: page, nextId: page.at(-1)?.id ?? afterId, oldestAvailableId: oldest.id,
    gap: afterId > 0 && oldest.id !== null && afterId < oldest.id - 1,
  };
}
