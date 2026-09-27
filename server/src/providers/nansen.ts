// Nansen web-crawler — free replication of the app.nansen.ai distribution
// balance chart (the yellow "Balance" time series, top-100 total, token units).
//
//   POST https://app.nansen.ai/api/questions/tgm-holders-hourly-stats
//   body: {parameters:{tokenAddress, chain, date:"day"|"week"|"month",
//          label:"top_100_holders", excludeExchanges:false}, filters:{}, order:{order:"desc"}}
//
// Response: [{blockDate, priceUsd, totalBalance, totalBalanceUsd, totalHolders, ...}]
// — "day" returns 24 hourly points, "week"/"month" coarser/longer series.
// Peak/trough per window = max/min of totalBalance. excludeExchanges:false =
// exchanges stay IN the cohort ("Include exchange-classified addresses in the
// current Top 100 cohort" toggle ON — product decision, always send false).
//
// TRANSPORT CAVEAT: Cloudflare blocks non-browser TLS (curl/node-fetch = 403).
// Callers must supply a browser-context postJson (Playwright bridge / headless
// chromium). Pure logic is transport-agnostic and unit-tested.

import type { Chain } from '../shared/chain.js';
import { solanaRpcEndpoints, SolanaRpcClient, type AssetInfo } from './solana.js';
import type { MarketDataProvider, MetricKind, MetricPatch, TokenInfo, WalletActivity, WalletTokenHolding } from './provider.js';
import { log, timed } from '../log.js';
import { limiters } from '../ratelimit/index.js';
import { HttpError } from '../ratelimit/types.js';

export interface BalanceRange {
  peak: number;
  trough: number;
}

export interface BalanceExtremes {
  d1?: BalanceRange;
  d7?: BalanceRange;
  d30?: BalanceRange;
}

export interface HourlyStatsRow {
  blockDate?: string;
  totalBalance?: number;
  totalBalanceUsd?: number;
  totalHolders?: number;
  totalInflows?: number;
}

export const NANSEN_HOURLY_STATS_URL = 'https://app.nansen.ai/api/questions/tgm-holders-hourly-stats';
export const NANSEN_HOLDERS_GINI_URL = 'https://app.nansen.ai/api/questions/tgm-holders-gini-stats';
export const NANSEN_ESSENTIAL_DATA_URL = 'https://app.nansen.ai/api/questions/tgm-essential-data';
export const NANSEN_VOLUME_DETAILS_URL = 'https://app.nansen.ai/api/questions/tgm-volume-details';
/** Credit door (1 credit): full token info on FIRST add — name/logo/socials/supply/
 * MC/holders in ONE row. Has no `price` field: price is derived MC ÷ circulating supply. */
export const NANSEN_TOKEN_INFORMATION_PATH = '/api/v1/tgm/token-information';
/** Official flows door (1 credit/call): hourly buckets when the requested range
 * is ≤7 days, DAILY for longer (no parameter forces hourly on a wider range) —
 * this is why the poller's T100 fetch chunks into 7-day calls. */
export const NANSEN_FLOWS_PATH = '/api/v1/tgm/flows';

export type StatWindow = 'day' | 'week' | 'month';

/** Custom range — LIVE VERIFIED 2026-09-10: the endpoint honors {from,to} ISO objects
 * (day/week/month are app-side sugar); series auto-starts at genesis, retention ≥70d.
 * Extended rungs LIVE PROBED 2026-09-18: quarter (92 daily rows) and year (365) are
 * accepted, 'all' returns 20713 rows; 3m/90d/6m/half/ytd → 500. The {from,to} form
 * returns a DIFFERENT series than the sugar rung (coarser bucket + the pre-genesis
 * back-fill is absent), so callers must pass the sugar rung to match the app chart. */
export type SeriesDate = StatWindow | 'quarter' | 'year' | { from: string; to: string };

export function hourlyStatsBody(
  ca: string,
  chain: string,
  date: SeriesDate,
  excludeExchanges = false,
  label = 'top_100_holders',
): unknown {
  return {
    parameters: {
      tokenAddress: ca,
      chain: nansenWebChain(chain),
      date,
      label,
      // excludeExchanges default false = INCLUDE — user-reconfirmed 2026-09-10:
      // the app's "Include exchange-classified addresses in the current Top 100
      // cohort" toggle is ON. CONK first live row 208,428,160 = 208.43M matches
      // the app chart exactly under INCLUDE (the earlier :true flip was a
      // regression against a single mis-attributed MINI probe). Override only
      // for debug variants (sidecar chartw).
      excludeExchanges,
    },
    filters: {},
    order: { order: 'desc' },
  };
}

function nansenWebChain(chain: string): string {
  const map: Record<string, string> = { sol: 'solana' };
  const mapped = map[chain];
  if (!mapped) throw new Error(`nansen crawl: unsupported chain ${chain}`);
  return mapped;
}

export function holdersGiniBody(ca: string, chain: string): unknown {
  return {
    parameters: { tokenAddress: ca, chain: nansenWebChain(chain) },
    filters: {},
    pagination: { page: 1, recordsPerPage: 100 },
    order: { order: 'desc' },
  };
}

/** Contract verified live 2026-09-09 (CA Ax5dAamJ / solana). */
export function essentialDataBody(ca: string, chain: string): unknown {
  return {
    parameters: { chain: nansenWebChain(chain), tokenAddress: ca },
    filters: {},
    pagination: { page: 1, recordsPerPage: 100 },
    order: { order: 'desc' },
  };
}

export function volumeDetailsBody(ca: string, chain: string, intervalSec = 86_400): unknown {
  return {
    parameters: { chain: nansenWebChain(chain), tokenAddress: ca, intervalSec },
    filters: {},
    pagination: { page: 1, recordsPerPage: 100 },
    order: { order: 'desc' },
  };
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface EssentialDataRow {
  priceUsd5Min?: number;
  priceUsd?: number | string | null;
  circulatingSupply?: number | string;
  totalSupply?: number | string | null;
  fullyDilutedValuationUsd?: number | string | null;
  totalLiquidityUsd?: number | string;
  marketCap?: number | null;
  deployedTimestamp?: string | null;
  symbol?: string | null;
  name?: string | null;
}

/**
 * price/supply/liquidity/mcap + deployedAt + symbol — marketCap is OFTEN null
 * → derive price×circulatingSupply. Pump.fun-style CAs can have priceUsd5Min
 * null (live probe MVC 2026-09-10) → fallback chain priceUsd5Min → priceUsd →
 * FDV/(totalSupply||circulatingSupply) → 0. NEVER throws on missing price: a
 * zero-price token must still land symbol/deployed_at/holders so the dashboard
 * shows its real LF/T100/fresh; only a missing ROW throws (the metric sweep's
 * existing catch logs it and skips the CA).
 */
export function parseEssentialData(json: unknown): { price: number; supply: number; marketCap: number; liquidity: number; deployedAt?: number; symbol?: string } {
  const row = (json as { data?: EssentialDataRow[] } | null)?.data?.[0];
  if (!row) throw new Error('nansen essential-data: no row');
  const supply = num(row.circulatingSupply);
  const price = firstFinite(row.priceUsd5Min, row.priceUsd) ?? fdvPrice(row) ?? 0;
  const mc = row.marketCap;
  const dep = typeof row.deployedTimestamp === 'string' ? Date.parse(row.deployedTimestamp) : NaN;
  // Symbol stored AS-IS from Nansen (FE uppercases for display); omit on empty/non-string.
  const sym = typeof row.symbol === 'string' ? row.symbol.trim() : '';
  return {
    price,
    supply,
    marketCap: typeof mc === 'number' && Number.isFinite(mc) && mc > 0 ? mc : price * supply,
    liquidity: num(row.totalLiquidityUsd),
    ...(Number.isFinite(dep) ? { deployedAt: dep } : {}),
    ...(sym !== '' ? { symbol: sym } : {}),
  };
}

/** Nansen has no row yet for a mint it has not indexed — that is "not yet", not a
 * failure, and the single throw parseEssentialData makes. */
function optionalEssentialData(json: unknown): ReturnType<typeof parseEssentialData> | null {
  try {
    return parseEssentialData(json);
  } catch {
    return null;
  }
}

function firstFinite(...vals: (number | string | null | undefined)[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : v == null ? NaN : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** FDV ÷ supply — totalSupply preferred (FDV is fully-diluted), fallback circulating. */
function fdvPrice(row: EssentialDataRow): number | undefined {
  const fdv = firstFinite(row.fullyDilutedValuationUsd);
  const total = firstFinite(row.totalSupply, row.circulatingSupply);
  return fdv !== undefined && total !== undefined && total > 0 ? fdv / total : undefined;
}

interface VolumeDetailsRow {
  buyVolumeUsdRecent?: number | string;
  sellVolumeUsdRecent?: number | string;
}

export function parseVolumeDetails(json: unknown): { buy: number; sell: number } {
  const row = (json as { data?: VolumeDetailsRow[] } | null)?.data?.[0];
  if (!row) throw new Error('nansen volume-details: no row');
  return { buy: num(row.buyVolumeUsdRecent), sell: num(row.sellVolumeUsdRecent) };
}

interface HoldersGiniRow {
  totalHolders?: number;
  top100HoldersBalancePercent?: number;
  freshWalletBalancePercent?: number;
  medianBalanceUsd?: number;
}

export interface GiniStats {
  holders: number;
  freshSupplyPct: number;
  t100SupplyPct?: number;
  medianBalanceUsd?: number;
}

/**
 * The whole Nansen distribution card set in ONE gini row (live-verified
 * 2026-09-10, BULLSHIT/sol: 3076 holders / 57.30% T100 / 8.96% fresh /
 * $13.74 median — identical body the app itself sends, see holdersGiniBody).
 * fresh % stays the strict contract (throw when absent/out of 0-1); holders
 * falls back to 0 (callers may keep the holders-change count); t100/median are
 * optional (young tokens can omit them → COALESCE keeps last value).
 */
export function parseGiniStats(json: unknown): GiniStats {
  const row = (json as { data?: HoldersGiniRow[] } | null)?.data?.[0];
  if (!row) throw new Error('nansen gini-stats: no row');
  const fresh = row.freshWalletBalancePercent;
  if (typeof fresh !== 'number' || !Number.isFinite(fresh) || fresh < 0 || fresh > 1) throw new Error('nansen gini-stats: no fresh share');
  const h = row.totalHolders;
  const t100 = row.top100HoldersBalancePercent;
  const med = row.medianBalanceUsd;
  return {
    holders: typeof h === 'number' && Number.isFinite(h) && h >= 0 ? Math.round(h) : 0,
    freshSupplyPct: fresh * 100,
    ...(typeof t100 === 'number' && Number.isFinite(t100) && t100 >= 0 && t100 <= 1 ? { t100SupplyPct: t100 * 100 } : {}),
    ...(typeof med === 'number' && Number.isFinite(med) && med >= 0 ? { medianBalanceUsd: med } : {}),
  };
}

/** Pure: one window's series -> peak/trough of totalBalance. */
export function extremesFromStats(rows: HourlyStatsRow[]): BalanceRange | undefined {
  let peak: number | undefined;
  let trough: number | undefined;
  for (const r of rows) {
    if (typeof r.totalBalance !== 'number' || !Number.isFinite(r.totalBalance)) continue;
    if (peak === undefined || r.totalBalance > peak) peak = r.totalBalance;
    if (trough === undefined || r.totalBalance < trough) trough = r.totalBalance;
  }
  return peak !== undefined && trough !== undefined ? { peak, trough } : undefined;
}

export type PostJson = (url: string, body: unknown) => Promise<{ status: number; json: unknown }>;

export class NansenWebCrawler {
  readonly name = 'nansen-crawl';

  constructor(private readonly postJson: PostJson) {}

  /** One call per window (day/week/month) — free, no auth, no credits. */
  async balanceExtremes(ca: string, chain: string): Promise<BalanceExtremes> {
    const [d1, d7, d30] = await Promise.all([
      this.extremesFor(ca, chain, 'day'),
      this.extremesFor(ca, chain, 'week'),
      this.extremesFor(ca, chain, 'month'),
    ]);
    return { d1, d7, d30 };
  }

  private async extremesFor(ca: string, chain: string, date: StatWindow): Promise<BalanceRange | undefined> {
    const { status, json } = await this.postJson(NANSEN_HOURLY_STATS_URL, hourlyStatsBody(ca, chain, date));
    const rows = (json as { data?: HourlyStatsRow[] } | null)?.data;
    if (status !== 200 || !Array.isArray(rows)) {
      throw new Error(`nansen crawl ${date} ${status}: unexpected response`);
    }
    return extremesFromStats(rows);
  }
}

// ---------------------------------------------------------------------------
// Official Nansen API client (credit-based) — adds what the free crawl cannot:
//   A. per-wallet DEX trade history for tracked Inflow (1 credit/call, 1000 rows/page)
//   B. native top-holder balance deltas for T100↓ (5 credits/call)
// Cost headers: x-nansen-credits-cost / x-nansen-credits-used.

export interface NansenTradeRow {
  transaction_hash: string;
  block_timestamp: string;
  token_bought_address?: string;
  token_sold_address?: string;
  token_bought_amount?: number | string;
  token_sold_amount?: number | string;
  trade_value_usd?: number | string;
}

export type TgmFlowsLabel = 'top_100_holders' | 'exchange';

export interface TgmFlowsRequest {
  /** Raw app chain, e.g. 'sol' — mapped with nansenApiChain(). */
  chain: string;
  token_address: string;
  /** ISO 8601 UTC range (inclusive start / exclusive end buckets). */
  date: { from: string; to: string };
  label: TgmFlowsLabel;
}

export interface TgmFlowsRow {
  date?: string;
  bucket_end?: string;
  is_complete?: boolean;
  price_usd?: number | null;
  token_amount?: number | null;
  value_usd?: number | null;
  holders_count?: number | null;
}

/** Narrow seam for the poller's T100/LF fetches — tests inject a counting stub. */
export interface TokenFlowsClient {
  tokenFlows(req: TgmFlowsRequest): Promise<TgmFlowsRow[]>;
}

/** Fibonacci spacing for the credit-door retry: 1,1,2,3,5,8,13… × baseMs. */
export function fiboDelayMs(n: number, baseMs: number): number {
  let a = 1;
  let b = 1;
  for (let i = 0; i < n; i += 1) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a * baseMs;
}

export class NansenApiClient implements TokenFlowsClient {
  readonly name = 'nansen-api';

  constructor(private readonly apiKey: string) {}

  /** Credit door: routed through the shared `nansen-credit` limiter — fibo retry on
   * 429/5xx; a 403 (out of credits) rejects and arms the gate's cooldown. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    return timed('nansen post', { path }, () =>
      limiters.run('nansen-credit', { priority: 1 }, async () => {
        try {
          return await this.postOnce<T>(path, body);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          // transport/parse failure carried no status — surface as a retryable 503 so the layer retries it
          throw new HttpError(503, null, e instanceof Error ? e.name : 'nansen transport error');
        }
      }),
    );
  }

  private async postOnce<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`https://api.nansen.ai${path}`, {
      method: 'POST',
      headers: { apikey: this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as T | { error?: string; message?: string } | null;
    const credits = res.headers.get('x-nansen-credits-remaining');
    if (credits) log.debug('[nansen-api] credits remaining', { path, credits });
    if (!res.ok || !json || 'error' in (json as object)) {
      const err = json as { error?: string; message?: string } | null;
      throw new HttpError(res.status, null, `nansen ${path} ${res.status}: ${err?.error ?? ''} ${err?.message ?? ''}`.slice(0, 200));
    }
    return json as T;
  }

  /** tgm/flows rows for one label+range. ONE request: this endpoint has NO real
   * pagination — `page: 2` returns 0 rows and the response is the MOST RECENT
   * `per_page` buckets (verified live 2026-09-23: 5y window + per_page 100 →
   * only the last 100 daily buckets). So the caller must keep the range short
   * enough to fit, and per_page is raised to the API-wide max of 1000 — with 100
   * any token older than 100 buckets was silently truncated. No order_by/filters:
   * rows arrive DESC and readers sort defensively. */
  async tokenFlows(req: TgmFlowsRequest): Promise<TgmFlowsRow[]> {
    const json = await this.post<{ data?: TgmFlowsRow[]; warnings?: unknown }>(NANSEN_FLOWS_PATH, {
      chain: nansenApiChain(req.chain),
      token_address: req.token_address,
      date: req.date,
      label: req.label,
      pagination: { page: 1, per_page: 1000 },
    });
    return json.data ?? [];
  }

  /** ONE request: tất cả DEX trades của ví trong [fromISO, toISO] (1000 rows max). */
  async dexTrades(wallet: string, chain: string, fromISO: string, toISO: string): Promise<NansenTradeRow[]> {
    const json = await this.post<{ data?: NansenTradeRow[] }>(
      '/api/v1/profiler/dex-trades',
      {
        address: wallet,
        chain: nansenApiChain(chain),
        date: { from: fromISO, to: toISO },
        pagination: { page: 1, per_page: 1000 },
      },
    );
    return json.data ?? [];
  }

  /** Per-(wallet, CA) current token balance — 1 credit/call. Verified 2026-09-09. */
  async currentBalance(wallet: string, chain: string, ca: string): Promise<NansenCurrentBalance | undefined> {
    const json = await this.post<{ data?: { token_amount?: number | string; price_usd?: number | string; value_usd?: number | string; token_symbol?: string }[] }>(
      '/api/v1/profiler/address/current-balance',
      {
        address: wallet,
        chain: nansenApiChain(chain),
        filters: { token_address: ca },
        pagination: { page: 1, per_page: 5 },
      },
    );
    const r = json.data?.[0];
    if (!r) return undefined;
    return { tokenAmount: num(r.token_amount), priceUsd: num(r.price_usd), valueUsd: num(r.value_usd), ...(r.token_symbol ? { tokenSymbol: r.token_symbol } : {}) };
  }

  /** ONE credit: full token info row for a first-add CA (name/logo/socials/supply/MC/holders). */
  async tokenInformation(chain: string, ca: string): Promise<TokenInformation> {
    const json = await this.post<{ data?: TokenInformation }>(NANSEN_TOKEN_INFORMATION_PATH, {
      chain: nansenApiChain(chain),
      token_address: ca,
      timeframe: '1d',
    });
    if (!json.data) throw new Error('nansen token-information: no data');
    return json.data;
  }
}

export interface NansenCurrentBalance {
  tokenAmount: number;
  priceUsd: number;
  valueUsd: number;
  tokenSymbol?: string;
}

/** One /api/v1/tgm/token-information row. Carries NO `price` field — price is
 * derived MC ÷ circulating supply (user 2026-09-22). */
export interface TokenInformation {
  name?: string;
  symbol?: string;
  contract_address?: string;
  logo?: string;
  token_details?: {
    token_deployment_date?: string;
    website?: string;
    x?: string;
    telegram?: string;
    market_cap_usd?: number;
    fdv_usd?: number;
    circulating_supply?: number;
    total_supply?: number;
  };
  spot_metrics?: {
    volume_total_usd?: number;
    buy_volume_usd?: number;
    sell_volume_usd?: number;
    total_buys?: number;
    total_sells?: number;
    unique_buyers?: number;
    unique_sellers?: number;
    liquidity_usd?: number;
    total_holders?: number;
  };
}

/** A MetricPatch that also carries the holders count token-information provides. */
export type TokenInformationPatch = MetricPatch & { holders?: number };

/** Pure: token-information row → patch. price = market_cap_usd ÷ circulating_supply. */
export function mapTokenInformation(r: TokenInformation): TokenInformationPatch {
  const d = r.token_details ?? {};
  const s = r.spot_metrics ?? {};
  const supply = num(d.circulating_supply ?? d.total_supply);
  const mc = num(d.market_cap_usd);
  const price = supply > 0 && mc > 0 ? mc / supply : 0;
  const dep = typeof d.token_deployment_date === 'string' ? Date.parse(d.token_deployment_date) : NaN;
  const sym = typeof r.symbol === 'string' ? r.symbol.trim() : '';
  return {
    price,
    ...(supply > 0 ? { supply } : {}),
    marketCap: mc,
    liquidity: num(s.liquidity_usd),
    holders: num(s.total_holders),
    volume24h: num(s.volume_total_usd),
    buyVol24h: num(s.buy_volume_usd),
    sellVol24h: num(s.sell_volume_usd),
    ...(Number.isFinite(dep) ? { deployedAt: dep } : {}),
    ...(sym !== '' ? { symbol: sym } : {}),
  };
}

function nansenApiChain(chain: string): string {
  const map: Record<string, string> = { sol: 'solana' };
  const mapped = map[chain];
  if (!mapped) throw new Error(`nansen api: unsupported chain ${chain}`);
  return mapped;
}

/** Pure: dex-trades rows → WalletActivity, filtered to tracked CAs (logic moved from the old nansenApiSweep). */
export function mapDexTradesToActivities(rows: NansenTradeRow[], caSet: ReadonlySet<string>, chain: Chain): WalletActivity[] {
  const acts: WalletActivity[] = [];
  for (const r of rows) {
    const bought = r.token_bought_address ?? '';
    const sold = r.token_sold_address ?? '';
    const isBuy = caSet.has(bought);
    const isSell = caSet.has(sold);
    if (!isBuy && !isSell) continue;
    const usd = Number(r.trade_value_usd ?? 0);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    acts.push({
      tx: r.transaction_hash,
      ts: Date.parse(r.block_timestamp),
      side: isBuy ? 'buy' : 'sell',
      ca: isBuy ? bought : sold,
      chain,
      amountUsd: usd,
      price: 0, // Nansen rows carry no per-trade price; usd amount is authoritative
    });
  }
  return acts;
}

// ---------------------------------------------------------------------------
// NansenMarketProvider — THE live provider since 2026-09-09 (GMGN retired).
// Free app-questions door (browser transport, injected PostJson) for token
// metrics + top-100 holders; official credit API for NON-SOL wallet balances only
// (wallet trades moved to the free wp4t-transactions door 2026-09-17).

export class NansenMarketProvider implements MarketDataProvider {
  readonly name = 'nansen';

  constructor(
    private readonly postJson: PostJson,
    private readonly api: NansenApiClient | null,
    private readonly trackedCas: () => readonly { address: string; chain: Chain }[],
    // Default builds the client from SOLANA_RPC_URL/RPC_HTTP; injectable so
    // tests can point it at a stub endpoint.
    private readonly solanaRpc: SolanaRpcClient = new SolanaRpcClient(solanaRpcEndpoints()),
  ) {}

  /** chains already reported as still riding the credit door — one warn each. */
  private readonly creditChainsWarned = new Set<string>();

  private async ask(url: string, body: unknown): Promise<unknown> {
    const { status, json } = await this.postJson(url, body);
    if (status !== 200) throw new Error(`nansen question ${url.split('/').pop()} ${status}`);
    return json;
  }

  /** ONE free question per kind — the poller runs each kind on its own cadence. */
  async metric(ca: string, chain: Chain, kind: MetricKind): Promise<MetricPatch> {
    switch (kind) {
      case 'essential': {
        // Two independent doors. Nansen 403s/timeouts (CF) or simply has no row for
        // a fresh mint; either way the DAS floor must still run — `ask` throwing used
        // to abort the whole patch, which is what left CAs ticker-less (2026-09-19).
        let ess: ReturnType<typeof parseEssentialData> | null = null;
        let nansenError: unknown;
        try {
          ess = optionalEssentialData(await this.ask(NANSEN_ESSENTIAL_DATA_URL, essentialDataBody(ca, chain)));
        } catch (e) {
          nansenError = e;
        }
        const asset =
          ess && ess.symbol !== undefined && ess.supply > 0 && ess.price > 0 ? {} : await this.solanaRpc.getAssetInfo(ca);
        const price = firstFinite(ess?.price, asset.price);
        const supply = firstFinite(ess?.supply, asset.supply);
        const marketCap = firstFinite(ess?.marketCap, price !== undefined && supply !== undefined ? price * supply : undefined);
        const symbol = ess?.symbol ?? asset.symbol;
        // Both doors empty → surface the Nansen error so the sweep logs the CA.
        if (ess === null && price === undefined && supply === undefined && symbol === undefined) {
          throw nansenError ?? new Error('nansen essential-data: no row and DAS floor empty');
        }
        return {
          ...(price !== undefined ? { price } : {}),
          ...(supply !== undefined ? { supply } : {}),
          ...(marketCap !== undefined ? { marketCap } : {}),
          ...(ess !== null ? { liquidity: ess.liquidity } : {}),
          ...(ess?.deployedAt !== undefined ? { deployedAt: ess.deployedAt } : {}),
          ...(symbol !== undefined ? { symbol } : {}),
        };
      }
      case 'volume': {
        // ONE call per sweep (user 2026-09-22): the 1h figure is the volume24h
        // growth since the previous sweep (the poller computes it), so the second
        // intervalSec=3600 fetch is gone.
        const vol = parseVolumeDetails(await this.ask(NANSEN_VOLUME_DETAILS_URL, volumeDetailsBody(ca, chain)));
        return { volume24h: vol.buy + vol.sell, buyVol24h: vol.buy, sellVol24h: vol.sell };
      }
      case 'gini': {
        const g = parseGiniStats(await this.ask(NANSEN_HOLDERS_GINI_URL, holdersGiniBody(ca, chain)));
        return {
          nansenHolders: g.holders,
          nansenFreshPct: g.freshSupplyPct,
          ...(g.t100SupplyPct !== undefined ? { nansenT100Pct: g.t100SupplyPct } : {}),
          ...(g.medianBalanceUsd !== undefined ? { nansenMedianUsd: g.medianBalanceUsd } : {}),
        };
      }
    }
  }

  /** RPC-only floor (no browser): lets the symbol backfill fill tickers while CF blocks `metric`. */
  async assetInfo(ca: string, chain: Chain): Promise<AssetInfo> {
    return chain === 'sol' ? this.solanaRpc.getAssetInfo(ca) : {};
  }

  /** First-add kick (new/changed CA): credit token-information for the FULL row,
   * falling back to the free essential door when the key is absent, plus the free
   * gini card (fresh% — token-information carries none). */
  async tokenInfo(ca: string, chain: Chain): Promise<TokenInfo> {
    const [vol, gini, full] = await Promise.all([
      this.metric(ca, chain, 'volume'),
      this.metric(ca, chain, 'gini'),
      this.creditTokenInformation(ca, chain),
    ]);
    const fresh = gini.nansenFreshPct;
    if (fresh === undefined) throw new Error('nansen gini-stats: no fresh share');
    const base: TokenInformationPatch = full ?? (await this.metric(ca, chain, 'essential'));
    const nansenHolders = gini.nansenHolders ?? 0;
    const holders = full?.holders ?? 0;
    return {
      ca,
      chain,
      price: base.price ?? 0,
      holders,
      volume24h: vol.volume24h ?? 0,
      buyVol24h: vol.buyVol24h ?? 0,
      sellVol24h: vol.sellVol24h ?? 0,
      ...(vol.volume1h !== undefined ? { volume1h: vol.volume1h } : {}),
      marketCap: base.marketCap ?? 0,
      liquidity: base.liquidity ?? 0,
      supply: base.supply ?? 0,
      ...(base.deployedAt !== undefined ? { deployedAt: base.deployedAt } : {}),
      ...(base.symbol !== undefined ? { symbol: base.symbol } : {}),
      nansenStats: {
        holders: nansenHolders > 0 ? nansenHolders : holders,
        freshSupplyPct: fresh,
        ...(gini.nansenT100Pct !== undefined ? { t100SupplyPct: gini.nansenT100Pct } : {}),
        ...(gini.nansenMedianUsd !== undefined ? { medianBalanceUsd: gini.nansenMedianUsd } : {}),
      },
    };
  }

  /** Credit token-information (1 credit) → MetricPatch; null when the key is
   * missing or the call fails, so the free essential door takes over. */
  private async creditTokenInformation(ca: string, chain: Chain): Promise<TokenInformationPatch | null> {
    if (!this.api) return null;
    try {
      return mapTokenInformation(await this.api.tokenInformation(chain, ca));
    } catch (e) {
      log.warn('[nansen] token-information credit call failed, fall back to essential', ca.slice(0, 8), e);
      return null;
    }
  }

  private requireApi(): NansenApiClient {
    if (!this.api) throw new Error('NANSEN_API_KEY not set — wallet data unavailable');
    return this.api;
  }

  /**
   * Holdings in TOKEN UNITS for the (wallet, CA) pairs asked for — one query per
   * pair, never the wallet's whole token-account list (user 2026-09-23: "query cặp
   * CA-wallet chứ không query linh tinh").
   *
   * chain 'sol' → Solana JSON-RPC: ONE getTokenAccountsByOwner per PAIR, filtered
   * by `mint` — measured 766 B / 1 account / 126 ms, against ~40 kB for a
   * whole-program scan. The mint filter resolves SPL vs Token-2022 itself, so the
   * old Promise.all over TOKEN_PROGRAM_IDS (2 calls, both always paid) is gone. A
   * pair the wallet no longer holds comes back amount 0, never dropped: the writer
   * needs that 0 to delete the stale row.
   *
   * No `cas` → every tracked CA on the wallet's chain (the broad legacy call).
   * Non-sol → Nansen credit path (currentBalance, 1 credit per pair); the chain is
   * logged ONCE so the credit burn stays visible, never silent.
   */
  async walletTokenHoldings(wallet: string, chain: Chain, cas?: readonly string[]): Promise<WalletTokenHolding[]> {
    const wanted = cas ?? this.trackedCas().filter((c) => c.chain === chain).map((c) => c.address);
    if (chain !== 'sol') return this.creditWalletHoldings(wallet, chain, wanted);
    const rows: WalletTokenHolding[] = [];
    for (const ca of wanted) {
      // Sum on the (rare) chance the wallet owns more than one account of this
      // mint: wallet_token_state is PK(wallet_id, ca), so a second row would abort
      // the whole replace transaction and freeze the wallet's holdings.
      const byMint = await this.solanaRpc.getTokenAccountsByOwner(wallet, { mint: ca });
      rows.push({ ca, amount: [...byMint.values()].reduce((sum, v) => sum + v, 0) });
    }
    return rows;
  }

  /** Nansen credit door — the non-sol fallback, 1 credit per (wallet, CA) pair. */
  private async creditWalletHoldings(wallet: string, chain: Chain, cas: readonly string[]): Promise<WalletTokenHolding[]> {
    if (!this.creditChainsWarned.has(chain)) {
      this.creditChainsWarned.add(chain);
      log.warn(`[nansen] chain ${chain} has no RPC holdings source — falling back to the credit door (currentBalance, 1 credit/wallet×CA)`);
    }
    const api = this.requireApi();
    const out: WalletTokenHolding[] = [];
    for (const ca of cas) {
      const b = await api.currentBalance(wallet, chain, ca);
      if (b && b.valueUsd > 0) out.push({ ca, amount: b.tokenAmount });
    }
    return out;
  }
}
