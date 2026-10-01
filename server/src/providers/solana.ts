// Solana JSON-RPC wallet-holdings client — replaces the Nansen credit door
// (POST /api/v1/profiler/address/current-balance, 1 credit per wallet×CA) for
// chain 'sol'. The caller (nansen.ts:walletTokenHoldings) passes the `{ mint }`
// filter form, so the node returns ONLY that mint's accounts: ONE RPC call per
// (wallet, CA) — i.e. per `Tracked by` pair. Cost is therefore O(pairs) and DOES
// grow linearly with the tracked-CA count; pruneUntrackedCas is what caps it.
// (The other form, a programId string, is the whole-program scan: 1 call per
// wallet per program returning EVERY token account for local mint filtering.)
//
// Endpoint/retry strategy copied from scripts/wallet_watch.py:rpc() (transport
// errors, HTTP errors, JSON-RPC errors and malformed bodies all try the next
// endpoint; the LAST failure is rethrown, no silent empty result). Pure decode
// logic is separated so it is unit-testable without network.
//
// Rate limiting (measured 2026-09-22 on Helius mainnet, paid key): the credit
// limiter is per METHOD and trips on bursts — 12 rps of getTokenAccountsByOwner
// gave 12/25 x 429 and stayed tripped (1/6 pass at 0.15s spacing), while 5 calls
// at 0.35s gave 5/5 x 200. The poller asks for 198 wallets x 2 programs per sweep
// with no gap, so nearly every call used to fail and the failure was logged as a
// bare `Error` (the status was thrown away to keep the token-bearing URL out of
// logs). Hence: requests on one client are SPACED (minIntervalMs) and a 429 is
// retried on the same endpoint with backoff before the next endpoint is burned.
//
// The residual 429s are Cloudflare edge rejections (`server=cloudflare`, body
// `Too Many Requests`, `retry-after: 1`), not Helius JSON-RPC errors, and that
// edge budget is shared with the DAS `getAsset` path on the same host — so it is
// the SUSTAINED rate from this box that matters: 300ms and 500ms both tripped it,
// 600ms (1.7 rps, ~17 req/10s) does not.

import { config } from '../config.js';
import { timed } from '../log.js';
import { limiters } from '../ratelimit/index.js';
import { HttpError } from '../ratelimit/types.js';

/** Classic SPL Token program. */
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Token-2022 (Token Extensions) program — where most current memecoins live. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Both programs are queried every sweep — omitting Token-2022 silently hides wallets. */
export const TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] as const;

/** Error whose message is built locally (status + capped RPC error) and is therefore
 *  safe to log. Anything else keeps only `e.name`: Node's `fetch` echoes the raw URL
 *  in `Failed to parse URL from <endpoint>`, and that URL carries the API token. */
export class SafeRpcError extends Error {}

/** Helius credit exhaustion: JSON-RPC -32429, message "max usage reached". Arrives
 *  as HTTP 429 (documented) or occasionally HTTP 200 (reported) — discriminate on
 *  the body, never on the status alone. The dead key must be RETIRED (retrying it
 *  only burns the 429 backoff budget), not rate-limit-retried. */
export function isCreditExhausted(json: unknown): boolean {
  const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (err === null || typeof err !== 'object') return false;
  return err.code === -32429 || (typeof err.message === 'string' && /max usage reached/i.test(err.message));
}

/** Comma/whitespace separated endpoint list; first is preferred, rest are fallbacks. */
export function parseRpcEndpoints(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .filter((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    });
}

export function solanaRpcEndpoints(): string[] {
  return parseRpcEndpoints(config.solanaRpcUrl);
}

/**
 * getTokenAccountsByOwner(jsonParsed) → mint → summed ui amount.
 *
 * - `account.data.parsed.info.mint` identifies the mint.
 * - `tokenAmount.uiAmountString` is a string and always present for jsonParsed;
 *   `uiAmount` can be null so it is never used directly.
 * - fallback: `tokenAmount.amount / 10^decimals` when uiAmountString is absent.
 * - several accounts can share one mint (rare) → SUM, never `[0]`.
 * - amount <= 0 or malformed rows are skipped (no empty rows).
 *
 * A malformed BODY (no result / result.value not an array) throws: the caller
 * treats it as a transport failure and tries the next endpoint rather than
 * returning an empty holdings set that would silently drop the wallet.
 */
export function parseTokenAccounts(json: unknown): Map<string, number> {
  const result = (json as { result?: unknown } | null)?.result;
  if (result === null || typeof result !== 'object' || !Array.isArray((result as { value?: unknown }).value)) {
    throw new SafeRpcError('solana rpc: malformed getTokenAccountsByOwner body');
  }
  const out = new Map<string, number>();
  let parsed = 0;
  for (const acct of (result as { value: unknown[] }).value) {
    const info = (acct as { account?: { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { uiAmountString?: unknown; amount?: unknown; decimals?: unknown } } } } } })
      ?.account?.data?.parsed?.info;
    const mint = info?.mint;
    if (typeof mint !== 'string' || mint === '') continue;
    parsed += 1; // a valid mint IS a parsed entry, even when amount <= 0
    const ta = info?.tokenAmount;
    let amount: number;
    if (typeof ta?.uiAmountString === 'string' && ta.uiAmountString !== '') {
      amount = Number(ta.uiAmountString);
    } else {
      // uiAmountString absent → raw integer amount scaled by decimals.
      const decimals = Number(ta?.decimals);
      amount = Number(ta?.amount) / 10 ** (Number.isFinite(decimals) ? decimals : 0);
    }
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.set(mint, (out.get(mint) ?? 0) + amount);
  }
  // A NON-EMPTY account list where not ONE entry yielded a parsed mint means the
  // node did not apply the jsonParsed parser (it falls back to raw base64 `data`
  // for accounts its parser cannot handle). Returning an empty map here would make
  // the caller DELETE this wallet's holdings and silently collapse Tracked by /
  // Holding %, so treat it as a failure and let the caller try the next endpoint.
  // An EMPTY `value` array is the legitimate "holds none of these" case — no throw.
  if (parsed === 0 && (result as { value: unknown[] }).value.length > 0) {
    throw new SafeRpcError('solana rpc: getTokenAccountsByOwner returned accounts with no parsed token info');
  }
  return out;
}

/** DAS `getAsset` payload path: `result.content.metadata.symbol`. Empty/absent → undefined. */
export function parseAssetSymbol(json: unknown): string | undefined {
  const symbol = (json as { result?: { content?: { metadata?: { symbol?: unknown } } } } | null)?.result
    ?.content?.metadata?.symbol;
  if (typeof symbol !== 'string') return undefined;
  const trimmed = symbol.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface AssetInfo {
  symbol?: string;
  /** UI units — `token_state.supply` is UI (it feeds the LF denominator + Holding %). */
  supply?: number;
  price?: number;
}

/**
 * DAS `getAsset` → symbol + supply + price from ONE call. `token_info.supply`
 * arrives RAW (972680569746476) while Nansen's circulatingSupply is UI
 * (972680569.75), and the two share the `supply` column — so this is the single
 * conversion point. Non-positive/absent values are OMITTED, never 0: a metric
 * sweep writing 0 would zero the LF denominator and Holding %.
 */
export function parseAssetInfo(json: unknown): AssetInfo {
  const ti = (json as { result?: { token_info?: Record<string, unknown> } } | null)?.result?.token_info;
  const symbol = parseAssetSymbol(json);
  const decimals = Number(ti?.decimals);
  const supplyRaw = Number(ti?.supply);
  const rawPrice = Number((ti?.price_info as { price_per_token?: unknown } | undefined)?.price_per_token);
  const supply =
    Number.isInteger(decimals) && decimals >= 0 && decimals <= 30 && Number.isFinite(supplyRaw)
      ? supplyRaw / 10 ** decimals
      : undefined;
  return {
    ...(symbol !== undefined ? { symbol } : {}),
    ...(supply !== undefined && supply > 0 ? { supply } : {}),
    ...(Number.isFinite(rawPrice) && rawPrice > 0 ? { price: rawPrice } : {}),
  };
}

/** getTokenSupply(jsonParsed) → UI supply. Non-positive/absent → null (never a fake denominator). */
export function parseTokenSupply(json: unknown): number | null {
  const value = (json as { result?: { value?: { uiAmountString?: unknown; amount?: unknown; decimals?: unknown } } } | null)
    ?.result?.value;
  if (value === null || typeof value !== 'object') return null;
  const decimals = Number(value.decimals);
  const amount =
    typeof value.uiAmountString === 'string' && value.uiAmountString !== ''
      ? Number(value.uiAmountString)
      : Number(value.amount) / 10 ** (Number.isFinite(decimals) ? decimals : 0);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * getTransaction(jsonParsed) → the trader's wallet. Prefers the SPL-transfer
 * instruction's `authority`/`owner` (the account that AUTHORISED the transfer);
 * falls back to accountKeys[0] (the fee payer/signer). null when the tx is
 * unknown, unparseable, or carries no usable account key — the caller then
 * fabricates nothing.
 */
export function parseSolanaTransferOwner(json: unknown): string | null {
  const result = (json as { result?: unknown } | null)?.result;
  if (result === null || typeof result !== 'object') return null;
  const message = (result as { transaction?: { message?: { accountKeys?: unknown; instructions?: unknown } } })
    .transaction?.message;
  if (message === null || message === undefined || typeof message !== 'object') return null;
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  for (const ix of instructions) {
    const programId = (ix as { programId?: unknown }).programId;
    if (typeof programId !== 'string' || !(TOKEN_PROGRAM_IDS as readonly string[]).includes(programId)) continue;
    const parsed = (ix as { parsed?: { type?: unknown; info?: Record<string, unknown> } }).parsed;
    if (typeof parsed?.type !== 'string' || !parsed.type.startsWith('transfer')) continue;
    const owner = parsed.info?.authority ?? parsed.info?.owner;
    if (typeof owner === 'string' && owner !== '') return owner;
  }
  const keys = message.accountKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const first = keys[0];
  if (typeof first === 'string' && first !== '') return first;
  const pubkey = (first as { pubkey?: unknown })?.pubkey;
  return typeof pubkey === 'string' && pubkey !== '' ? pubkey : null;
}

export class SolanaRpcClient {
  readonly name = 'solana-rpc';

  /** Credit-exhausted endpoints: endpoint → epoch ms until which it is skipped.
   *  In-memory per client, keyed by endpoint string (never logged — carries the token). */
  private readonly retiredUntil = new Map<string, number>();

  constructor(
    private readonly endpoints: readonly string[],
    private readonly timeoutMs = 30_000,
  ) {
    if (endpoints.length === 0) throw new Error('solana rpc: no endpoints configured');
  }

  /** Retires an endpoint whose key ran out of credits for config.solanaRpcRetireMs. */
  private retire(endpoint: string): void {
    this.retiredUntil.set(endpoint, Date.now() + config.solanaRpcRetireMs);
  }

  /** Non-retired endpoints in configured order. When EVERY endpoint is retired,
   *  all of them ordered by soonest-expiring first — an "all keys dead" state must
   *  still ATTEMPT the request, never drop it. */
  private activeEndpoints(): string[] {
    const now = Date.now();
    const active = this.endpoints.filter((ep) => (this.retiredUntil.get(ep) ?? 0) <= now);
    if (active.length > 0) return active;
    return [...this.endpoints].sort((a, b) => (this.retiredUntil.get(a) ?? 0) - (this.retiredUntil.get(b) ?? 0));
  }

  /** POST wrapped in the shared rate-control layer (the layer owns pacing + retry).
   *  A credit-EXHAUSTED 429 is different: retire the endpoint and throw a SafeRpcError —
   *  the layer only retries HttpError, so exhaustion must not burn the retry budget. */
  private async post(endpoint: string, payload: unknown): Promise<Response> {
    return limiters.run('solana-rpc', { priority: 1 }, async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429) {
        // Detached clone: reading it leaves the original body readable by the caller.
        const body = (await res.clone().json().catch(() => null)) as unknown;
        if (isCreditExhausted(body)) {
          this.retire(endpoint);
          throw new SafeRpcError('solana rpc 429 credit exhausted (endpoint retired)');
        }
      }
      if (res.status === 429) {
        throw new HttpError(res.status, res.headers.get('retry-after'), `solana rpc ${res.status}`);
      }
      // Only 429 is layer-retryable: a dead (5xx) endpoint must fall through at once, not burn retries.
      return res;
    });
  }

  /**
   * Holdings (mint → summed token amount) for one wallet. `filter` is either a
   * token-program id — the whole account list of that program — or `{ mint }` for
   * ONE (CA, wallet) pair, which is the cheap call the sweeps use: measured 766 B /
   * 1 account / 126 ms against ~40 kB for a program scan, and the mint filter picks
   * SPL vs Token-2022 on its own, so a pair needs no second call.
   */
  async getTokenAccountsByOwner(
    wallet: string,
    filter: string | { mint: string },
  ): Promise<Map<string, number>> {
    const kind = typeof filter === 'string' ? 'program' : 'mint';
    return timed('solana getTokenAccountsByOwner', { wallet: wallet.slice(0, 6), kind }, () =>
      this.fetchOwnerAccounts(wallet, filter),
    );
  }

  private async fetchOwnerAccounts(wallet: string, filter: string | { mint: string }): Promise<Map<string, number>> {
    const rpcFilter = typeof filter === 'string' ? { programId: filter } : filter;
    let last: string | undefined;
    for (const endpoint of this.activeEndpoints()) {
      try {
        const res = await this.post(endpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [wallet, rpcFilter, { encoding: 'jsonParsed' }],
        });
        const json = (await res.json().catch(() => null)) as unknown;
        // Exhaustion can also ride a 2xx body — retire on that variant too.
        if (isCreditExhausted(json)) {
          this.retire(endpoint);
          throw new SafeRpcError(`solana rpc ${res.status} credit exhausted (endpoint retired)`);
        }
        const rpcError = (json as { error?: unknown } | null)?.error;
        if (!res.ok || !json || rpcError) {
          throw new SafeRpcError(`solana rpc ${res.status}${rpcError ? ` ${JSON.stringify(rpcError).slice(0, 80)}` : ''}`);
        }
        return parseTokenAccounts(json);
      } catch (e) {
        // Keep only a safe classification: a syntactically invalid endpoint makes
        // Node throw "Failed to parse URL from <endpoint>", which would echo the
        // configured URL (possibly a paid endpoint carrying an API token) into logs.
        last = e instanceof SafeRpcError || e instanceof HttpError ? e.message : e instanceof Error ? e.name : 'error';
      }
    }
    throw new Error(`solana rpc getTokenAccountsByOwner failed (${wallet.slice(0, 6)}): ${String(last).slice(0, 160)}`);
  }

  /**
   * Contract: never throws — these are the FLOOR for fields Nansen may omit or a
   * mint Nansen has not indexed yet, so a non-DAS endpoint must not take the whole
   * TokenInfo down. Returns {} when no endpoint yields anything.
   */
  async getAssetInfo(mint: string): Promise<AssetInfo> {
    return timed('solana getAsset', { mint: mint.slice(0, 6) }, () => this.fetchAssetInfo(mint));
  }

  private async fetchAssetInfo(mint: string): Promise<AssetInfo> {
    for (const endpoint of this.activeEndpoints()) {
      try {
        const res = await this.post(endpoint, { jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } });
        const json = (await res.json().catch(() => null)) as unknown;
        // Exhaustion can also ride a 2xx body — retire on that variant too.
        if (isCreditExhausted(json)) {
          this.retire(endpoint);
          continue;
        }
        if (!res.ok || !json || (json as { error?: unknown }).error) continue;
        const info = parseAssetInfo(json);
        if (info.symbol !== undefined || info.supply !== undefined || info.price !== undefined) return info;
      } catch {
        // floor only — next endpoint, then give up
      }
    }
    return {};
  }

  /** getTransaction → the trader's wallet via parseSolanaTransferOwner. Opportunistic:
   *  null on every failure (unknown tx, parse gap, dead endpoints) — never throws. */
  async getTransactionOwner(signature: string): Promise<string | null> {
    for (const endpoint of this.activeEndpoints()) {
      try {
        const res = await this.post(endpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        });
        const json = (await res.json().catch(() => null)) as unknown;
        if (isCreditExhausted(json)) {
          this.retire(endpoint);
          continue;
        }
        const rpcError = (json as { error?: unknown } | null)?.error;
        if (!res.ok || !json || rpcError) continue;
        return parseSolanaTransferOwner(json);
      } catch {
        // next endpoint, then give up
      }
    }
    return null;
  }

  /** getTokenSupply(mint) → UI total supply; null when unavailable. */
  async getTokenSupply(mint: string): Promise<number | null> {
    for (const endpoint of this.activeEndpoints()) {
      try {
        const res = await this.post(endpoint, { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] });
        const json = (await res.json().catch(() => null)) as unknown;
        if (isCreditExhausted(json)) {
          this.retire(endpoint);
          continue;
        }
        const rpcError = (json as { error?: unknown } | null)?.error;
        if (!res.ok || !json || rpcError) continue;
        const supply = parseTokenSupply(json);
        if (supply !== null) return supply;
      } catch {
        // next endpoint, then give up
      }
    }
    return null;
  }
}
