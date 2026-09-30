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
 * Pure: a /latest/dex/tokens response → Map<mint, iconUrl>. PAIR-level rows are
 * grouped by baseToken.address; among the pairs whose imageUrl PASSES the
 * allowlist gate, the highest liquidity.usd wins. A junk/absent imageUrl
 * disqualifies only its own pair; a mint whose pairs all fail (or that has no
 * pair at all) is simply absent — "no icon", never a raw unvalidated string.
 */
export function parseIcons(json: DexTokensResponse): Map<string, string> {
  const best = new Map<string, { liq: number; url: string }>();
  const rawPairs = json?.pairs;
  const pairs = Array.isArray(rawPairs) ? rawPairs : [];
  for (const pair of pairs) {
    const mint = typeof pair?.baseToken?.address === 'string' ? pair.baseToken.address.trim() : '';
    if (mint === '') continue;
    const url = validatedIconUrl(pair?.info?.imageUrl);
    if (url === undefined) continue;
    const liq = num(pair?.liquidity?.usd);
    const prev = best.get(mint);
    if (prev === undefined || liq > prev.liq) best.set(mint, { liq, url });
  }
  return new Map([...best].map(([mint, v]) => [mint, v.url]));
}

/** Pure chunker: the ≤30-address batches one /tokens call may carry. Exported for tests. */
export function chunkAddresses(cas: readonly string[], size: number = DEXSCREENER_MAX_ADDRESSES): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < cas.length; i += size) chunks.push(cas.slice(i, i + size));
  return chunks;
}

/**
 * Batch icon fetch. NEVER throws: a non-200, a non-JSON body, or a network
 * failure logs and yields "no icons for this chunk" — the next sweep is the
 * durable retry (same contract as the metric sweeps). Chunks run sequentially:
 * each is ONE request, so the await chain is the pacing — pacedFor's per-item
 * slots exist to protect per-CA rate-limited doors, and a keyless batch call
 * covering 30 CAs has no such door to protect.
 */
export async function fetchIcons(
  cas: readonly string[],
  gateway: GatewayClient = gatewayClientFromEnv(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
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
      for (const [mint, url] of parseIcons(JSON.parse(env.body) as DexTokensResponse)) out.set(mint, url);
    } catch (e) {
      // Timeout / DNS / connection reset — same skip-and-continue as a non-200.
      log.warn('[dexscreener] tokens fetch failed — chunk skipped', { n: chunk.length, err: e });
    }
  }
  log.debug('[dexscreener] icons', { asked: cas.length, resolved: out.size });
  return out;
}
