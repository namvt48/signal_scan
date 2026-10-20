import { getDb, getAlertMetricObservations, listWallets } from './db.js';
import { assembleSignals, type TokenSignal } from './signals.js';
import type { Chain } from './shared/chain.js';
import type { PublicActivity, PublicAlert, PublicSnapshot, PublicToken, PublicTrade, PublicWallet } from './public-api-contract.js';

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

function toPublicToken(signal: TokenSignal): PublicToken {
  const db = getDb();
  const state = db.prepare('SELECT price, market_cap, holders, volume24h, vol_1h, buy_vol24h, sell_vol24h FROM token_state WHERE ca = ? AND chain = ?')
    .get(signal.ca, signal.chain) as { price: number | null; market_cap: number | null; holders: number | null; volume24h: number | null; vol_1h: number | null; buy_vol24h: number | null; sell_vol24h: number | null } | undefined;
  const history = db.prepare('SELECT market_cap_history_json, holders_history_json, fresh_history_json, t100_history_json FROM token_state WHERE ca = ? AND chain = ?')
    .get(signal.ca, signal.chain) as { market_cap_history_json: string | null; holders_history_json: string | null; fresh_history_json: string | null; t100_history_json: string | null } | undefined;
  const freshness = signal.dataUpdatedAt;
  return {
    id: signal.id, ca: signal.ca, chain: signal.chain, symbol: signal.symbol ?? null, tier: signal.tier,
    market: {
      price: state?.price ?? null, marketCap: signal.marketCap ?? null, holders: signal.holders,
      volume24h: signal.volume24h, volume1h: signal.volume1h ?? null,
      buyVol24h: signal.buyVol24h ?? null, sellVol24h: signal.sellVol24h ?? null,
      dataUpdatedAt: { marketCap: freshness?.marketCap ?? null, volume24h: freshness?.volume24h ?? null, holders: freshness?.holders ?? null },
    },
    metrics: {
      score: signal.nansen.score, pass: { ...signal.nansen.pass }, fresh: signal.nansen.rawFresh ?? null,
      freshCurrent: signal.nansen.freshCurrent, freshUpdatedAt: signal.nansen.freshUpdatedAt ?? null,
      t100: signal.nansen.t100 ? { pct: signal.nansen.t100.pct, multiple: signal.nansen.t100.multiple ?? null } : null,
      lf: signal.nansen.lf ?? null,
    },
    history: {
      marketCap: points(history?.market_cap_history_json ?? undefined), holders: points(history?.holders_history_json ?? undefined),
      fresh: points(history?.fresh_history_json ?? undefined), t100: points(history?.t100_history_json ?? undefined),
    },
  };
}

export function exportSnapshot(now = Date.now()): PublicSnapshot {
  return { generatedAt: now, tokens: assembleSignals(now, true).map(toPublicToken) };
}

export function exportToken(chain: Chain, ca: string, now = Date.now()): PublicToken | undefined {
  const found = assembleSignals(now, true).find((item) => item.chain === chain && item.ca === ca);
  return found ? toPublicToken(found) : undefined;
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

export function exportAlerts(afterId: number, limit: number): { data: PublicAlert[]; nextId: number; oldestAvailableId: number | null; gap: boolean } {
  const db = getDb();
  const oldest = db.prepare('SELECT MIN(id) AS id FROM alert_metric_observations').get() as { id: number | null };
  const items = getAlertMetricObservations(afterId, limit + 1);
  const page = items.slice(0, limit).map((item) => ({
    id: item.id, ca: item.ca, chain: item.chain, metric: item.metric, value: item.value, responseAt: item.responseAt,
    snapshot: {
      capturedAt: item.snapshot.capturedAt, symbol: item.snapshot.symbol, marketCap: item.snapshot.marketCap,
      marketCapAt: item.snapshot.marketCapAt, freshPct: item.snapshot.freshPct,
      t100Multiple: item.snapshot.t100Multiple, lf: item.snapshot.lf,
    },
  }));
  return {
    data: page, nextId: page.at(-1)?.id ?? afterId, oldestAvailableId: oldest.id,
    gap: afterId > 0 && oldest.id !== null && afterId < oldest.id - 1,
  };
}


