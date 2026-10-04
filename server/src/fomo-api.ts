// FOMO API client (api.fomoapi.io) — the AUTHORITATIVE per-position source.
//
// WHY this exists: a FOMO alert's `usdValue` on a BUY is the position's
// mark-to-market VALUE after the fill (a STOCK, not a flow). Aggregating it over
// the capture reported a 59.8K spend as 70.7K (user 2026-10-01). This endpoint
// returns the money actually spent per position (`costBasisUsd`), plus the token
// `amount` and `priceUsd`. Read-only, ONE call per handle, never throws: a failed
// fetch is an empty list and the previously stored position survives.

import { canonicalCa, type Chain } from './shared/chain.js';
import { config } from './config.js';
import { log } from './log.js';

export interface FomoPosition {
  ca: string;
  chain: Chain;
  tradeId: string | null;
  status: string | null;
  amount: number | null;
  costBasisUsd: number | null;
  avgEntryPrice: number | null;
  priceUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
}

// API chain names -> the repo's Chain union. A name outside the map (ethereum,
// hyperliquid) is a chain this repo cannot track -> the position is SKIPPED.
const CHAIN_BY_API_NAME: Record<string, Chain> = {
  solana: 'sol',
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
};

const PAGE_CAP = 4;
const ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function toPosition(raw: Record<string, unknown>): FomoPosition | null {
  const chain = CHAIN_BY_API_NAME[String(raw.chain)];
  const token = raw.token as { address?: unknown } | undefined;
  const address = typeof token?.address === 'string' ? token.address : '';
  if (chain === undefined || address === '') return null;
  return {
    ca: canonicalCa(address, chain),
    chain,
    tradeId: strOrNull(raw.tradeId),
    status: strOrNull(raw.status),
    amount: numOrNull(raw.amount),
    costBasisUsd: numOrNull(raw.costBasisUsd),
    avgEntryPrice: numOrNull(raw.avgEntryPrice),
    priceUsd: numOrNull(raw.priceUsd),
    realizedPnlUsd: numOrNull(raw.realizedPnlUsd),
    unrealizedPnlUsd: numOrNull(raw.unrealizedPnlUsd),
  };
}

async function getPage(handle: string, cursor: string | null): Promise<Record<string, unknown> | null> {
  const url = new URL(`${config.fomoApiBase}/v2/users/${encodeURIComponent(handle)}/trades`);
  if (cursor !== null) url.searchParams.set('cursor', cursor);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${config.fomoApiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      if (res.status !== 429 && res.status !== 503) {
        log.warn(`[fomo-api] ${handle} trades -> HTTP ${res.status}`);
        return null;
      }
    } catch (e) {
      log.warn(`[fomo-api] ${handle} trades attempt ${attempt}: ${String(e)}`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  log.error(`[fomo-api] ${handle} trades gave up after ${ATTEMPTS} attempts`);
  return null;
}

/** Every position of one trader, newest page first. Paging follows the response's
 *  own `cursor` (undocumented field name beyond the spec's "?cursor=start") and
 *  stops at PAGE_CAP — the dash only needs positions recent enough to be tracked. */
export async function fetchFomoPositions(handle: string): Promise<FomoPosition[]> {
  if (config.fomoApiKey === '') return [];
  const out: FomoPosition[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_CAP; page++) {
    const body = await getPage(handle, cursor);
    if (body === null) break;
    const trades = body.trades;
    if (!Array.isArray(trades)) break;
    for (const raw of trades) {
      if (raw === null || typeof raw !== 'object') continue;
      const position = toPosition(raw as Record<string, unknown>);
      if (position !== null) out.push(position);
    }
    const next = strOrNull(body.cursor);
    if (next === null || next === cursor) break;
    cursor = next;
  }
  return out;
}
