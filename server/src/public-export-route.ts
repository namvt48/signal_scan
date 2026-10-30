import { getDb, getLatestAlertMetricObservationId } from './db.js';
import {
  exportActivity,
  exportAlerts,
  exportBalanceSeries,
  exportFomoPositions,
  exportFomoToken,
  exportFomoTokenStats,
  exportFomoTokens,
  exportFomoTrades,
  exportFomoUsers,
  exportSnapshot,
  exportToken,
  exportTokenDetail,
  exportTrades,
  exportWallets,
} from './public-export.js';
import { assembleSignals, type TokenSignal } from './signals.js';
import type { PublicFomoToken, PublicToken } from './public-api-contract.js';
import { canonicalCa, CHAINS, type Chain } from './shared/chain.js';

export interface PublicExportResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let cachedExportSnapshot: { revision: number; externalRevision: number; computedAt: number; signals: TokenSignal[] } | null = null;
function cachedSignals(): readonly TokenSignal[] {
  const db = getDb();
  const dbRevision = (): { local: number; external: number } => {
    const row = db.prepare('SELECT total_changes() AS revision').get() as { revision: number };
    return { local: row.revision, external: db.pragma('data_version', { simple: true }) as number };
  };
  const before = dbRevision();
  if (cachedExportSnapshot?.revision === before.local && cachedExportSnapshot.externalRevision === before.external &&
      Date.now() - cachedExportSnapshot.computedAt < 500) {
    return cachedExportSnapshot.signals;
  }
  const signals = db.transaction(() => assembleSignals(Date.now(), true))();
  const after = dbRevision();
  if (before.local !== after.local || before.external !== after.external) return signals;
  cachedExportSnapshot = { revision: after.local, externalRevision: after.external, computedAt: Date.now(), signals };
  return signals;
}


export async function publicExportResource(
  query: Record<string, unknown>,
  options: { signals?: () => readonly TokenSignal[]; snapshot?: () => Promise<{ generatedAt: number; tokens: PublicToken[]; fomoTokens: PublicFomoToken[]; findToken?: (chain: string, ca: string) => PublicToken | undefined; findFomoToken?: (chain: string, ca: string) => PublicFomoToken | undefined }>; readOnly?: boolean } = {},
): Promise<PublicExportResult> {
  const resource = query.resource;
  const limitRaw = query.limit;
  const limit = limitRaw === undefined ? 100 : typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
  const afterIdRaw = query.afterId;
  const afterId = afterIdRaw === undefined ? 0 : typeof afterIdRaw === 'string' && /^\d+$/.test(afterIdRaw) ? Number(afterIdRaw) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(afterId) || afterId < 0) {
    return { status: 400, body: { error: 'invalid pagination' } };
  }
  const signals = options.signals ?? cachedSignals;
  if (resource === 'tokens') {
    if (options.snapshot) {
      const snapshot = await options.snapshot();
      return { status: 200, headers: { 'X-Signal-Scan-Snapshot-At': String(snapshot.generatedAt) }, body: { generatedAt: snapshot.generatedAt, data: snapshot.tokens.slice(afterId, afterId + limit), nextOffset: afterId + limit < snapshot.tokens.length ? afterId + limit : null } };
    }
    const all = signals();
    const snapshot = exportSnapshot(Date.now(), all.slice(afterId, afterId + limit));
    return { status: 200, body: { generatedAt: snapshot.generatedAt, data: snapshot.tokens, nextOffset: afterId + limit < all.length ? afterId + limit : null } };
  }
  if (resource === 'wallets') {
    const data = exportWallets();
    return { status: 200, body: { data: data.slice(afterId, afterId + limit), nextOffset: afterId + limit < data.length ? afterId + limit : null } };
  }
  if (resource === 'latestAlertId') return { status: 200, body: { data: [], nextId: getLatestAlertMetricObservationId() } };
  if (resource === 'alerts') {
    const origin = query.origin === 'fomo' ? 'fomo' : 'main';
    return { status: 200, body: exportAlerts(afterId, limit, origin) };
  }
  if (resource === 'token' || resource === 'detail' || resource === 'fomoToken') {
    const chain = query.chain;
    const ca = query.ca;
    if (typeof chain !== 'string' || !CHAINS.includes(chain as Chain) || typeof ca !== 'string' || ca.length < 1 || ca.length > 128) {
      return { status: 400, body: { error: 'invalid token identity' } };
    }
    const normalized = canonicalCa(ca, chain as Chain);
    if (resource === 'detail') {
      const detail = exportTokenDetail(chain as Chain, normalized);
      return detail ? { status: 200, body: detail } : { status: 404, body: { error: 'token not found' } };
    }
    if (resource === 'fomoToken') {
      const snapshot = options.snapshot ? await options.snapshot() : undefined;
      const token = snapshot ? snapshot.findFomoToken?.(chain, normalized) ?? snapshot.fomoTokens.find((item) => item.chain === chain && item.ca === normalized) : exportFomoToken(chain as Chain, normalized, Date.now(), signals());
      return token ? { status: 200, ...(snapshot ? { headers: { 'X-Signal-Scan-Snapshot-At': String(snapshot.generatedAt) } } : {}), body: token } : { status: 404, body: { error: 'token not found' } };
    }
    const snapshot = options.snapshot ? await options.snapshot() : undefined;
    const token = snapshot ? snapshot.findToken?.(chain, normalized) ?? snapshot.tokens.find((item) => item.chain === chain && item.ca === normalized) : exportToken(chain as Chain, normalized, Date.now(), signals());
    return token ? { status: 200, ...(snapshot ? { headers: { 'X-Signal-Scan-Snapshot-At': String(snapshot.generatedAt) } } : {}), body: token } : { status: 404, body: { error: 'token not found' } };
  }
  if (resource === 'balance') {
    const chain = query.chain;
    const ca = query.ca;
    const window = query.window === undefined ? 'day' : query.window;
    if (typeof chain !== 'string' || !CHAINS.includes(chain as Chain) || typeof ca !== 'string' || ca.length < 1 || ca.length > 128 ||
        (window !== 'day' && window !== 'week' && window !== 'month')) {
      return { status: 400, body: { error: 'invalid balance query' } };
    }
    try {
      return { status: 200, body: await exportBalanceSeries(chain as Chain, canonicalCa(ca, chain as Chain), window, { allowRefresh: options.readOnly !== true }) };
    } catch {
      return { status: 503, body: { error: 'balance series unavailable' } };
    }
  }
  if (resource === 'activity') {
    const chain = query.chain;
    const ca = query.ca;
    const from = Number(query.from); const to = Number(query.to);
    if (typeof chain !== 'string' || !CHAINS.includes(chain as Chain) || typeof ca !== 'string' ||
        !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 31 * 86_400_000) {
      return { status: 400, body: { error: 'invalid activity query' } };
    }
    return { status: 200, body: exportActivity(chain as Chain, canonicalCa(ca, chain as Chain), from, to) };
  }
  if (resource === 'trades') {
    const walletId = query.walletId;
    const from = Number(query.from); const to = Number(query.to);
    if (typeof walletId !== 'string' || walletId.length > 128 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
        from < 0 || to <= from || to - from > 31 * 86_400_000) {
      return { status: 400, body: { error: 'invalid trade query' } };
    }
    return { status: 200, body: exportTrades(walletId, afterId, limit, from, to) };
  }
  if (resource === 'fomoUsers') {
    const data = exportFomoUsers();
    return { status: 200, body: { data: data.slice(afterId, afterId + limit), nextOffset: afterId + limit < data.length ? afterId + limit : null } };
  }
  if (resource === 'fomoTokens') {
    if (options.snapshot) {
      const snapshot = await options.snapshot();
      return { status: 200, headers: { 'X-Signal-Scan-Snapshot-At': String(snapshot.generatedAt) }, body: { generatedAt: snapshot.generatedAt, data: snapshot.fomoTokens.slice(afterId, afterId + limit), nextOffset: afterId + limit < snapshot.fomoTokens.length ? afterId + limit : null } };
    }
    const all = signals();
    const snapshot = exportFomoTokens(Date.now(), all.slice(afterId, afterId + limit));
    return { status: 200, body: { generatedAt: snapshot.generatedAt, data: snapshot.tokens, nextOffset: afterId + limit < all.length ? afterId + limit : null } };
  }
  if (resource === 'fomoTokenStats') {
    const chain = query.chain;
    const ca = query.ca;
    if (typeof chain !== 'string' || !CHAINS.includes(chain as Chain) || typeof ca !== 'string' || ca.length < 1 || ca.length > 128) {
      return { status: 400, body: { error: 'invalid token identity' } };
    }
    return { status: 200, body: { data: exportFomoTokenStats(chain as Chain, canonicalCa(ca, chain as Chain)) } };
  }
  if (resource === 'fomoTrades') {
    const userId = query.userId;
    const from = Number(query.from); const to = Number(query.to);
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 128 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
        from < 0 || to <= from || to - from > 31 * 86_400_000) {
      return { status: 400, body: { error: 'invalid fomo trade query' } };
    }
    return { status: 200, body: exportFomoTrades(userId, afterId, limit, from, to) };
  }
  if (resource === 'fomoPositions') {
    const userId = query.userId;
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 128) {
      return { status: 400, body: { error: 'invalid fomo user id' } };
    }
    return { status: 200, body: exportFomoPositions(userId) };
  }
  return { status: 400, body: { error: 'unknown resource' } };
}
