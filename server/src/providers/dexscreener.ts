// DexScreener public API — token logo (icon) metadata, keyless and free.
//
//   GET https://api.dexscreener.com/latest/dex/tokens/<addr1,addr2,...>
//   (comma-separated, max 30 addresses per call)
//
// Live-verified 2026-09-25 on BONK/WIF/POPCAT: 3 mints returned 30 PAIR-level
// rows (BONK alone spans 17 pairs) — the response is per market, not per token,
// so the icons are grouped by baseToken.address and the pair with the highest
// liquidity.usd wins (deterministic across 5/5 fetches). `pairs` may be null
// (a mint with no DEX market) and info.imageUrl may be absent.
//
// Deliberately NOT a MarketDataProvider: icons are third-party metadata, not
// market data — this module must keep working in every MODE, including when
// Nansen credits are exhausted or GMGN is down. The poller's iconSweep calls it
// directly and writes through the generic updateTokenMetrics patch seam.

import { log } from '../log.js';
import { gatewayClientFromEnv, GatewayClient, GW_DEXSCREENER_PATH } from '../gateway-client.js';
import { EVM_ADDRESS } from '../shared/chain.js';

export const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens';

/** Hard API ceiling: addresses per /latest/dex/tokens call (400 above it). */
export const DEXSCREENER_MAX_ADDRESSES = 30;

/**
 * Hosts an icon URL may live on — exact match or subdomain. The URL lands in a
 * browser `<img src>`, so this allowlist is the trust boundary: anything the
 * third-party response carries that is not https on one of these hosts is
 * treated as "no icon" and NEVER stored.
 */
export const ICON_HOST_ALLOWLIST: readonly string[] = ['cdn.dexscreener.com'];

interface DexBaseToken {
  address?: string;
  symbol?: string;
  name?: string;
}

interface DexPair {
  baseToken?: DexBaseToken;
  info?: { imageUrl?: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
}

export interface DexTokensResponse {
  pairs?: DexPair[] | null;
}

/** Same coercion idiom as gmgn.num — tolerate string numerics, 0 on junk. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure URL gate: https + allowlisted host, or undefined. Subdomain match is
 * dot-anchored (`host === allowed || host.endsWith('.' + allowed)`), so a
 * lookalike like `cdn.dexscreener.com.evil.tld` or `notcdn.dexscreener.com`
 * is rejected. Returns the ORIGINAL string on success — validation already
 * parsed it, re-serializing would add nothing.
 */
export function validatedIconUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  const allowed = ICON_HOST_ALLOWLIST.some((h) => host === h || host.endsWith(`.${h}`));
  return allowed ? raw : undefined;
}

/**
 * Per-token market metadata DexScreener is authoritative for: symbol, price and
 * icon. `marketCap` is NOT taken here — it is derived centrally as price × supply.
 */
export interface DexTokenMeta {
  iconUrl?: string;
  symbol?: string;
  price?: number;
}

/**
 * Pure: a /latest/dex/tokens response → Map<mint, DexTokenMeta>. PAIR-level rows are
 * grouped by baseToken.address. Two independent "deepest pair" picks per mint:
 *  - symbol/price come from the pair with the highest liquidity.usd (the same pair
 *    the providers compare against);
 *  - iconUrl comes from the deepest pair whose imageUrl PASSES the allowlist gate,
 *    so a high-liquidity pair carrying no image never hides a lower pair's icon.
 * A junk/absent reading is omitted (never a 0 or a raw unvalidated string); a mint
 * with nothing usable is absent entirely.
 */
export function parseTokenMeta(json: DexTokensResponse): Map<string, DexTokenMeta> {
  const field = new Map<string, { liq: number; symbol?: string; price?: number }>();
  const icon = new Map<string, { liq: number; url: string }>();
  const rawPairs = json?.pairs;
  const pairs = Array.isArray(rawPairs) ? rawPairs : [];
  for (const pair of pairs) {
    const raw = typeof pair?.baseToken?.address === 'string' ? pair.baseToken.address.trim() : '';
    if (raw === '') continue;
    // DexScreener returns CHECKSUMMED EVM addresses (0xAbC…) while the poller looks
    // up by the LOWERCASE canonical CA (canonicalCa) — key by the canonical form or
    // every EVM mint (robinhood/base/bsc) misses. Sol base58 IS case-sensitive: keep it.
    const mint = EVM_ADDRESS.test(raw) ? raw.toLowerCase() : raw;
    const liq = num(pair?.liquidity?.usd);
    const symbol = typeof pair?.baseToken?.symbol === 'string' ? pair.baseToken.symbol.trim() : '';
    const price = num(pair?.priceUsd);
    const prev = field.get(mint);
    if (prev === undefined || liq > prev.liq) {
      field.set(mint, {
        liq,
        ...(symbol !== '' ? { symbol } : {}),
        ...(price > 0 ? { price } : {}),
      });
    }
    const url = validatedIconUrl(pair?.info?.imageUrl);
    if (url !== undefined) {
      const pi = icon.get(mint);
      if (pi === undefined || liq > pi.liq) icon.set(mint, { liq, url });
    }
  }
  const out = new Map<string, DexTokenMeta>();
  for (const [mint, f] of field) {
    const ic = icon.get(mint);
    const meta: DexTokenMeta = {
      ...(f.symbol !== undefined ? { symbol: f.symbol } : {}),
      ...(f.price !== undefined ? { price: f.price } : {}),
      ...(ic !== undefined ? { iconUrl: ic.url } : {}),
    };
    if (Object.keys(meta).length > 0) out.set(mint, meta);
  }
  return out;
}

/**
 * Icon-only projection of parseTokenMeta, kept for the existing icon tests and any
 * caller that wants nothing but the logo. PAIR-level rows are grouped by
 * baseToken.address; among the pairs whose imageUrl PASSES the allowlist gate, the
 * highest liquidity.usd wins.
 */
export function parseIcons(json: DexTokensResponse): Map<string, string> {
  const out = new Map<string, string>();
  for (const [mint, meta] of parseTokenMeta(json)) {
    if (meta.iconUrl !== undefined) out.set(mint, meta.iconUrl);
  }
  return out;
}

/** Pure chunker: the ≤30-address batches one /tokens call may carry. Exported for tests. */
export function chunkAddresses(cas: readonly string[], size: number = DEXSCREENER_MAX_ADDRESSES): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < cas.length; i += size) chunks.push(cas.slice(i, i + size));
  return chunks;
}

/**
 * Batch token-meta fetch (icon + symbol + price). NEVER throws: a non-200, a
 * non-JSON body, or a network failure logs and yields nothing for that chunk — the
 * next sweep is the durable retry (same contract as the metric sweeps). Chunks run
 * sequentially: each is ONE request, so the await chain is the pacing.
 */
export async function fetchTokenMeta(
  cas: readonly string[],
  gateway: GatewayClient = gatewayClientFromEnv(),
): Promise<Map<string, DexTokenMeta>> {
  const out = new Map<string, DexTokenMeta>();
  for (const chunk of chunkAddresses(cas)) {
    try {
      const env = await gateway.call(GW_DEXSCREENER_PATH, {
        endpoint: 'tokens',
        params: { addresses: chunk.join(',') },
        priority: 2,
      });
      if (env.status < 200 || env.status >= 300 || env.body === null) {
        log.warn(`[dexscreener] tokens http ${env.status} — chunk skipped`, { n: chunk.length });
        continue;
      }
      for (const [mint, meta] of parseTokenMeta(JSON.parse(env.body) as DexTokensResponse)) out.set(mint, meta);
    } catch (e) {
      // Timeout / DNS / connection reset — same skip-and-continue as a non-200.
      log.warn('[dexscreener] tokens fetch failed — chunk skipped', { n: chunk.length, err: e });
    }
  }
  log.debug('[dexscreener] token meta', { asked: cas.length, resolved: out.size });
  return out;
}

/** Icon-only projection of fetchTokenMeta, kept for callers that want nothing but the logo. */
export async function fetchIcons(
  cas: readonly string[],
  gateway: GatewayClient = gatewayClientFromEnv(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [mint, meta] of await fetchTokenMeta(cas, gateway)) {
    if (meta.iconUrl !== undefined) out.set(mint, meta.iconUrl);
  }
  return out;
}
