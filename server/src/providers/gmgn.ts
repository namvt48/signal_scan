// GMGN official OpenAPI — the source for price / market-cap / ticker / holders /
// 24h volume / 1h volume (user 2026-09-24; replaces Nansen for those six columns).
//
//   GET https://openapi.gmgn.ai/v1/token/info
//       ?chain=sol&address=<ca>&timestamp=<unix-sec>&client_id=<uuid>
//   header: X-APIKEY: <key>
//
// The provider no longer calls this URL itself: it POSTs `{ca, chain, priority}`
// to the gateway (`/v1/gmgn/token-info`), which builds the request above and
// injects the api key. The `key` ctor arg is kept for arity only.
// ONE call returns every field the six columns need — live-verified 2026-09-24 on
// MINI (Ax5dAamJPeuaLpFUzs9FdcpoUhHDcxyjPzxCJQidjups): price 0.0026489706,
// holder_count 2923, volume_1h 4915.02, volume_24h 425137.45, circulating_supply
// 999949659.05, symbol "MINI". Market cap is NOT a field — derive
// price × circulating_supply (same rule the docs themselves print).
//
// Auth is `exist` for market routes: API key only, no signature. But `timestamp`
// (inside ±5s) and a FRESH `client_id` (no replay within 7s) are MANDATORY —
// without them the door answers 401 AUTH_INVALID (probed). Chain slug is `sol`;
// `solana` 404s TOKEN_NOT_FOUND (probed).
//
// Rate limiting is WEIGHT-based, not request-based: calls/sec = plan weight /
// endpoint weight (gmgn.ai/ai table, 2026-09-24) — Free 5, Plus 20, Pro 50, and
// `/v1/token/info` costs 1, so Free allows 5 calls/sec. The gateway now owns the
// weight bucket and the 429 ban gate; this provider only throws HttpError so the
// caller keeps one typed-error path. No retry/backoff here: a 429 thrown is
// caught by the sweep, and the next hourly pass is the durable retry.

import { timed } from '../log.js';
import { HttpError, type Priority } from '../ratelimit/types.js';
import { gatewayClientFromEnv, GatewayClient, GW_GMGN_TOKEN_INFO_PATH } from '../gateway-client.js';
import type { Chain } from '../shared/chain.js';
import type { AssetInfo } from './solana.js';
import type { MetricKind, MetricPatch } from './provider.js';

export const GMGN_TOKEN_INFO_URL = 'https://openapi.gmgn.ai/v1/token/info';

/** Weight `/v1/token/info` costs against the plan budget (calls/sec = plan / this). */
export const GMGN_TOKEN_INFO_WEIGHT = 1;

/** GMGN sends every numeric field as a STRING ("425137.45927614") — coerce, 0 on junk. */
function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The `price` block — current price plus the per-window volume/buy/sell split. */
interface GmgnPriceBlock {
  price?: string;
  volume_1h?: string;
  volume_24h?: string;
  buy_volume_1h?: string;
  sell_volume_1h?: string;
  buy_volume_24h?: string;
  sell_volume_24h?: string;
}

interface GmgnData {
  symbol?: string;
  holder_count?: number;
  circulating_supply?: string;
  total_supply?: string;
  liquidity?: string;
  creation_timestamp?: number;
  price?: GmgnPriceBlock;
}

export interface GmgnTokenInfoResponse {
  code?: number;
  error?: string;
  message?: string;
  data?: GmgnData;
}

/**
 * Pure: a token/info response → MetricPatch. Only keys with real data are set —
 * a zero/absent reading is OMITTED so updateTokenMetrics' `excluded` write cannot
 * clobber a good last value with a meaningless 0 (unindexed mints answer code 0
 * with empty fields). Volumes are always emitted: on a valid row 0 is a reading,
 * not a gap.
 */
export function parseTokenInfo(json: GmgnTokenInfoResponse): MetricPatch {
  if ((json.code ?? 0) !== 0) {
    throw new Error(`gmgn token/info code ${json.code}: ${json.error ?? ''} ${json.message ?? ''}`.slice(0, 200));
  }
  const d = json.data;
  if (!d) throw new Error('gmgn token/info: no data');
  const p = d.price ?? {};
  const price = num(p.price);
  const supply = num(d.circulating_supply || d.total_supply);
  const holders = num(d.holder_count);
  const liquidity = num(d.liquidity);
  const created = num(d.creation_timestamp);
  const sym = typeof d.symbol === 'string' ? d.symbol.trim() : '';
  return {
    ...(price > 0 ? { price } : {}),
    ...(supply > 0 ? { supply } : {}),
    ...(price > 0 && supply > 0 ? { marketCap: price * supply } : {}),
    ...(liquidity > 0 ? { liquidity } : {}),
    ...(holders > 0 ? { holders } : {}),
    volume24h: num(p.volume_24h),
    buyVol24h: num(p.buy_volume_24h),
    sellVol24h: num(p.sell_volume_24h),
    volume1h: num(p.volume_1h),
    ...(created > 0 ? { deployedAt: created * 1000 } : {}),
    ...(sym !== '' ? { symbol: sym } : {}),
  };
}

/**
 * The narrow seam the composite uses: GMGN owns exactly these two, nothing else.
 * `tokenInfo`/`walletTokenHoldings` stay on Nansen, so this provider deliberately
 * does NOT implement MarketDataProvider — the composite does.
 */
export interface GmgnProvider {
  readonly name: string;
  metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch>;
  assetInfo(ca: string, chain: Chain): Promise<AssetInfo>;
}

export class GmgnMarketProvider implements GmgnProvider {
  readonly name = 'gmgn';

  constructor(
    private readonly apiKey: string,
    private readonly gateway: GatewayClient = gatewayClientFromEnv(),
  ) {
    void this.apiKey;
  }

  /**
   * ONE token/info call per kind, split into the two DISJOINT field sets the
   * sweeps own (essential: state; volume: flows) so the hourly essential and
   * volume passes never overwrite each other's columns. `gini` is Nansen's —
   * the composite never routes it here, and returning {} keeps that explicit.
   */
  async metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch> {
    if (kind === 'gini') return {};
    const priority: Priority = kind === 'volume' ? 2 : 1;
    const p = await this.fetchTokenInfo(ca, chain, priority);
    if (kind === 'volume') {
      return {
        volume24h: p.volume24h ?? 0,
        buyVol24h: p.buyVol24h ?? 0,
        sellVol24h: p.sellVol24h ?? 0,
        volume1h: p.volume1h ?? 0,
      };
    }
    return {
      ...(p.price !== undefined ? { price: p.price } : {}),
      ...(p.supply !== undefined ? { supply: p.supply } : {}),
      ...(p.marketCap !== undefined ? { marketCap: p.marketCap } : {}),
      ...(p.liquidity !== undefined ? { liquidity: p.liquidity } : {}),
      ...(p.holders !== undefined ? { holders: p.holders } : {}),
      ...(p.symbol !== undefined ? { symbol: p.symbol } : {}),
      ...(p.deployedAt !== undefined ? { deployedAt: p.deployedAt } : {}),
    };
  }

  /** Symbol/supply/price floor with no browser door — lets the ticker backfill run while Nansen CF-blocks. */
  async assetInfo(ca: string, chain: Chain): Promise<AssetInfo> {
    const p = await this.fetchTokenInfo(ca, chain, 0); // critical: ticker backfill
    return {
      ...(p.symbol !== undefined ? { symbol: p.symbol } : {}),
      ...(p.supply !== undefined ? { supply: p.supply } : {}),
      ...(p.price !== undefined ? { price: p.price } : {}),
    };
  }

  private async fetchTokenInfo(ca: string, chain: Chain, priority: Priority): Promise<MetricPatch> {
    return timed('gmgn token/info', { ca, chain }, async () => {
      const env = await this.gateway.call(GW_GMGN_TOKEN_INFO_PATH, { ca, chain, priority });
      if (env.status < 200 || env.status >= 300 || env.body === null) {
        throw new HttpError(env.status, env.headers['x-ratelimit-reset'] ?? null, `gmgn token/info ${env.status}`.slice(0, 200));
      }
      return parseTokenInfo(JSON.parse(env.body) as GmgnTokenInfoResponse);
    });
  }
}
