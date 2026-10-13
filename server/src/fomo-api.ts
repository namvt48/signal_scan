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
export interface FomoBalance {
  ca: string;
  chain: Chain;
  amount: number;
}

export interface FomoBalanceSnapshot {
  balances: FomoBalance[];
  capturedAt: number;
  complete: boolean;
  truncated: boolean;
  available: boolean;
}

export interface FomoSwapLeg {
  address: string;
  usd: number | null;
}

/** One on-chain fill from `/v2/users/{handle}/swaps`; unlike `trades`, this is
 *  an individual swap, not an aggregated position. */
export interface FomoSwap {
  chain: Chain;
  at: number;
  tradeIdOut: string | null;
  tokenIn: FomoSwapLeg;
  tokenOut: FomoSwapLeg;
}

export interface FomoBuySwapTarget {
  ca: string;
  chain: Chain;
  ts: number;
  tradeId: string | null;
}


function toSwapLeg(value: unknown): FomoSwapLeg | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('address' in value) || !('usd' in value)) return null;
  if (typeof value.address !== 'string' || value.address === '') return null;
  const usd = value.usd;
  if (usd !== null && (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0)) return null;
  return { address: value.address, usd };
}

function toSwap(value: unknown): FomoSwap | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('chain' in value) || !('at' in value) || !('tokenIn' in value) || !('tokenOut' in value)) return null;
  if (typeof value.chain !== 'string') return null;
  const chain = CHAIN_BY_API_NAME[value.chain];
  if (chain === undefined) return undefined;
  const at = timestampMs(value.at);
  const tokenIn = toSwapLeg(value.tokenIn);
  const tokenOut = toSwapLeg(value.tokenOut);
  if (at === null || tokenIn === null || tokenOut === null) return null;
  return { chain, at, tradeIdOut: 'tradeIdOut' in value ? strOrNull(value.tradeIdOut) : null, tokenIn, tokenOut };
}

/** Resolve a BUY only when exactly one swap matches the FOMO position, token,
 *  chain, and alert's five-second timestamp bucket. `tokenIn.usd` is the USD
 *  value of what the trader spent; position marks are not used as fill size. */
export function matchFomoBuySwap(target: FomoBuySwapTarget, swaps: readonly FomoSwap[]): number | null {
  const ca = canonicalCa(target.ca, target.chain);
  const matches = swaps.filter((swap) =>
    swap.chain === target.chain &&
    canonicalCa(swap.tokenOut.address, swap.chain) === ca &&
    (target.tradeId === null || swap.tradeIdOut === target.tradeId) &&
    swap.at >= target.ts &&
    swap.at < target.ts + 5_000,
  );
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (match.tradeIdOut === null) return null;
  const amount = match.tokenIn.usd;
  return amount !== null && amount > 0 ? amount : null;
}

/** One recent page of individual fills. A partial upstream response cannot
 *  prove uniqueness, so it is deliberately left unresolved. */
export async function fetchFomoSwaps(handle: string): Promise<FomoSwap[] | null> {
  if (config.fomoApiKey === '') return null;
  const url = new URL(`${config.fomoApiBase}/v2/users/${encodeURIComponent(handle)}/swaps`);
  url.searchParams.set('limit', '100');
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${config.fomoApiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body: unknown = await res.json();
        if (typeof body !== 'object' || body === null || Array.isArray(body) || !('swaps' in body) || !Array.isArray(body.swaps) || ('partial' in body && body.partial === true) || ('available' in body && body.available === false)) return null;
        const swaps: FomoSwap[] = [];
        for (const raw of body.swaps) {
          const swap = toSwap(raw);
          if (swap === null) return null;
          if (swap !== undefined) swaps.push(swap);
        }
        return swaps;
      }
      if (res.status !== 429 && res.status !== 503) {
        log.warn(`[fomo-api] ${handle} swaps -> HTTP ${res.status}`);
        return null;
      }
    } catch (e) {
      log.warn(`[fomo-api] ${handle} swaps attempt ${attempt}: ${String(e)}`);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  log.error(`[fomo-api] ${handle} swaps gave up after ${ATTEMPTS} attempts`);
  return null;
}

const timestampMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** One all-chain snapshot per trader; incomplete metadata is preserved for callers. */
export async function fetchFomoBalances(handle: string): Promise<FomoBalanceSnapshot | null> {
  if (config.fomoApiKey === '') return null;
  const url = `${config.fomoApiBase}/v2/users/${encodeURIComponent(handle)}/balances`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${config.fomoApiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const capturedAt = timestampMs(body.capturedAt);
    if (capturedAt === null || !Array.isArray(body.holdings)) return null;
    const available = body.available !== false;
    let complete = body.complete === true;
    const truncated = body.truncated === true || body.upstreamTruncated === true;
    const balances: FomoBalance[] = [];
    for (const item of body.holdings) {
      if (item === null || typeof item !== 'object') {
        complete = false;
        continue;
      }
      const raw = item as Record<string, unknown>;
      const chain = CHAIN_BY_API_NAME[String(raw.chain)];
      const token = raw.token as Record<string, unknown> | undefined;
      const address = typeof token?.address === 'string' ? token.address : '';
      const amount = raw.amount;
      if (chain === undefined) continue;
      if (address === '' || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        complete = false;
        continue;
      }
      balances.push({ ca: canonicalCa(address, chain), chain, amount });
    }
    return { balances, capturedAt, complete, truncated, available };
  } catch (e) {
    log.warn(`[fomo-api] ${handle} balances: ${String(e)}`);
    return null;
  }
}

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
