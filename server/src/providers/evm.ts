// EVM JSON-RPC wallet-holdings client (plan evm-base-bsc T5/D5) — the non-sol
// sibling of solana.ts, replacing the Nansen credit door (currentBalance,
// 1 credit per wallet×CA) for chain 'base'/'bsc'/'robinhood'.
//
// ONE Multicall3 `eth_call` per wallet covers every asked (wallet, CA) pair:
// `balanceOf(wallet)` for all CAs plus `decimals()` for the CAs whose scale is
// not cached yet. Multicall3 sits at the SAME address on Base, BSC and
// Robinhood Chain (plan R6; robinhood verified live 2026-09-30):
//   0xcA11bde05977b3631167028862bE2a173976CA11
//   aggregate3((address target, bool allowFailure, bytes callData)[])
//     → (bool success, bytes returnData)[]
// Every sub-call sets allowFailure=true: one dead token must never take the
// whole batch down (a revert then decodes as success=false, balance 0).
//
// The ABI encode/decode below is hand-rolled on purpose (NO new dependency):
// selectors aggregate3 0x82ad56cb (verified against real captured calldata in
// celo-org/celo-monorepo + viem's aggregate3Signature), balanceOf(address)
// 0x70a08231, decimals() 0x313ce567 (uint8).
//
// Endpoint/retry discipline copied from solana.ts: endpoints tried in order
// (env primary → keyless fallback, plan R2), the LAST failure is rethrown, and
// error messages NEVER carry the endpoint URL — it can carry the shared Alchemy
// key (same reason solana.ts wraps thrown fetches in SafeRpcError).

import { config } from '../config.js';
import { log, timed } from '../log.js';
import type { Chain } from '../shared/chain.js';
import { chainSlugs } from '../shared/chain-slugs.js';
import type { WalletTokenHolding } from './provider.js';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const AGGREGATE3_SELECTOR = '82ad56cb';
export const BALANCE_OF_SELECTOR = '70a08231';
export const DECIMALS_SELECTOR = '313ce567';
export const DECIMALS_CALLDATA = `0x${DECIMALS_SELECTOR}`;
/** totalSupply() uint256 — the LF/holding-% denominator from the token contract. */
export const TOTAL_SUPPLY_SELECTOR = '18160ddd';
export const TOTAL_SUPPLY_CALLDATA = `0x${TOTAL_SUPPLY_SELECTOR}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Keyless public endpoints (plan D3) — fail-over after the env primary. */
const KEYLESS_RPC: Partial<Record<Chain, string>> = {
  base: 'https://mainnet.base.org',
  bsc: 'https://bsc-dataseed.binance.org',
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
};

/** Error whose message is built locally (status + capped RPC error) and is
 *  therefore safe to log — a raw fetch error echoes the endpoint URL, which
 *  may carry the shared Alchemy key. */
export class SafeEvmError extends Error {}

/** Ordered, de-duplicated endpoint list: env primary first, keyless fallback once. */
export function evmEndpointList(envUrl: string, keyless: string | undefined): string[] {
  return [...new Set([envUrl, keyless ?? ''].filter((u) => u !== ''))];
}

/** chainId (from the ONE map, shared/chain-slugs.ts — never a second copy) null
 *  ⇒ not an EVM chain ⇒ this client has no source for it. */
export function evmRpcEndpoints(chain: Chain): string[] {
  if (chainSlugs(chain).chainId === null) throw new Error(`evm rpc: chain ${chain} has no EVM RPC source`);
  const envUrl =
    chain === 'base'
      ? config.baseRpcUrl
      : chain === 'bsc'
        ? config.bscRpcUrl
        : chain === 'robinhood'
          ? config.robinhoodRpcUrl
          : '';
  return evmEndpointList(envUrl, KEYLESS_RPC[chain]);
}

function stripHex(hex: string): string {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw new SafeEvmError('evm rpc: invalid hex');
  return body.toLowerCase();
}

/** One 32-byte ABI word holding a non-negative integer. */
function uintWord(n: number | bigint): string {
  return n.toString(16).padStart(64, '0');
}

/** One 32-byte ABI word holding a 20-byte address, left-padded. */
function addressWord(addr: string): string {
  if (!ADDRESS_RE.test(addr)) throw new SafeEvmError(`evm rpc: not an EVM address: ${addr.slice(0, 10)}`);
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

export function balanceOfCalldata(wallet: string): string {
  return `0x${BALANCE_OF_SELECTOR}${addressWord(wallet)}`;
}

export interface Multicall3Call {
  readonly target: string;
  readonly allowFailure: boolean;
  /** Even-length hex, 0x prefix optional. */
  readonly callData: string;
}

/**
 * aggregate3 calldata, canonical ABI head/tail layout:
 * selector · offset(0x20) · length · per-tuple offsets (relative to the offset
 * area) · per tuple: target · allowFailure · bytes-offset(0x60) · bytes-length ·
 * zero-padded bytes. Byte-identical to real captured aggregate3 calldata
 * (celo exec-upgrade.sh golden vector in evm.test.ts).
 */
export function encodeAggregate3(calls: readonly Multicall3Call[]): string {
  if (calls.length === 0) throw new SafeEvmError('evm rpc: aggregate3 with no calls');
  const tuples = calls.map((c) => {
    const data = stripHex(c.callData);
    const padTo = Math.ceil(data.length / 64) * 64;
    return [
      addressWord(c.target),
      uintWord(c.allowFailure ? 1 : 0),
      uintWord(0x60),
      uintWord(data.length / 2),
      data.padEnd(padTo, '0'),
    ].join('');
  });
  const offsets: string[] = [];
  let at = calls.length * 32;
  for (const t of tuples) {
    offsets.push(uintWord(at));
    at += t.length / 2;
  }
  return `0x${AGGREGATE3_SELECTOR}${uintWord(0x20)}${uintWord(calls.length)}${offsets.join('')}${tuples.join('')}`;
}

export interface Multicall3Result {
  readonly success: boolean;
  /** 0x-prefixed returnData ('0x' when the sub-call returned nothing). */
  readonly returnData: string;
}

/** Strict decoder for `(bool success, bytes returnData)[]` — malformed input
 *  throws (SafeEvmError) instead of yielding a short/empty list, so the caller
 *  can never read a truncated batch as "holds nothing". */
export function decodeAggregate3(hex: string): Multicall3Result[] {
  const body = stripHex(hex);
  const wordAt = (byteAt: number): bigint => {
    if (byteAt < 0 || (byteAt + 32) * 2 > body.length) throw new SafeEvmError('evm rpc: malformed aggregate3 result');
    return BigInt(`0x${body.slice(byteAt * 2, (byteAt + 32) * 2)}`);
  };
  const indexAt = (byteAt: number): number => {
    const v = wordAt(byteAt);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new SafeEvmError('evm rpc: malformed aggregate3 result');
    return Number(v);
  };
  const arrayAt = indexAt(0);
  const n = indexAt(arrayAt);
  const out: Multicall3Result[] = [];
  for (let i = 0; i < n; i++) {
    const tupleAt = arrayAt + 32 + indexAt(arrayAt + 32 + i * 32);
    const success = wordAt(tupleAt) !== 0n;
    const bytesAt = tupleAt + indexAt(tupleAt + 32);
    const len = indexAt(bytesAt);
    const start = (bytesAt + 32) * 2;
    if (start + len * 2 > body.length) throw new SafeEvmError('evm rpc: malformed aggregate3 result');
    out.push({ success, returnData: `0x${body.slice(start, start + len * 2)}` });
  }
  return out;
}

/** balanceOf returnData → raw uint256; null when it is not exactly one ABI word
 *  (a non-standard token returning garbage must never become a fake balance). */
export function decodeUint256(returnData: string): bigint | null {
  try {
    const body = stripHex(returnData);
    return body.length === 64 ? BigInt(`0x${body}`) : null;
  } catch {
    return null;
  }
}

/** decimals() returnData → uint8 (0..255); null when absent or out of range. */
export function decodeDecimals(returnData: string): number | null {
  const v = decodeUint256(returnData);
  return v !== null && v <= 255n ? Number(v) : null;
}

/** Raw uint256 → token units — the SAME unit the sol path yields
 *  (uiAmountString). BigInt string walk, so the integer part never floats. */
export function rawToTokenUnits(raw: bigint, decimals: number): number {
  if (decimals === 0) return Number(raw);
  const s = raw.toString().padStart(decimals + 1, '0');
  const cut = s.length - decimals;
  return Number(`${s.slice(0, cut)}.${s.slice(cut)}`);
}

function decimalsKey(chain: Chain, ca: string): string {
  return `${chain}:${ca.toLowerCase()}`;
}

export class EvmRpcClient {
  readonly name = 'evm-rpc';

  /** chain:lower(ca) → decimals(); in-memory per client (plan D5). A miss costs
   *  one extra sub-call INSIDE the same batch, never a second round trip. */
  private readonly decimalsCache = new Map<string, number>();

  constructor(
    private readonly endpointsFor: (chain: Chain) => readonly string[] = evmRpcEndpoints,
    private readonly timeoutMs = 30_000,
  ) {}

  /**
   * Holdings in TOKEN UNITS for the (wallet, CA) pairs asked for — the exact
   * contract of the sol path: a CA the wallet does not hold comes back amount 0,
   * never dropped (the writer needs the 0 to delete the stale row). Only a CA
   * whose scale is unknowable (decimals sub-call failed AND balance > 0, or
   * non-uint256 balanceOf data) is skipped with a log line — a wrong number is
   * worse than a stale row.
   */
  async walletTokenHoldings(wallet: string, chain: Chain, cas: readonly string[]): Promise<WalletTokenHolding[]> {
    if (!ADDRESS_RE.test(wallet)) throw new Error(`evm rpc: wallet is not an EVM address (${wallet.slice(0, 10)})`);
    const valid = cas.filter((ca) => {
      if (ADDRESS_RE.test(ca)) return true;
      log.warn(`[evm] ${chain}: tracked CA is not an EVM address — skipped`, ca.slice(0, 12));
      return false;
    });
    if (valid.length === 0) return [];
    return timed('evm aggregate3', { chain, wallet: wallet.slice(0, 6), pairs: valid.length }, () =>
      this.fetchHoldings(wallet, chain, valid),
    );
  }

  private async fetchHoldings(wallet: string, chain: Chain, cas: readonly string[]): Promise<WalletTokenHolding[]> {
    const needDecimals = cas.filter((ca) => !this.decimalsCache.has(decimalsKey(chain, ca)));
    const calls: Multicall3Call[] = [
      ...cas.map((ca) => ({ target: ca, allowFailure: true, callData: balanceOfCalldata(wallet) })),
      ...needDecimals.map((ca) => ({ target: ca, allowFailure: true, callData: DECIMALS_CALLDATA })),
    ];
    const results = decodeAggregate3(await this.ethCall(chain, encodeAggregate3(calls)));
    if (results.length !== calls.length) {
      throw new SafeEvmError(`evm rpc: aggregate3 returned ${results.length}/${calls.length} results`);
    }
    needDecimals.forEach((ca, i) => {
      const r = results[cas.length + i];
      if (r === undefined || !r.success) return;
      const d = decodeDecimals(r.returnData);
      if (d !== null) this.decimalsCache.set(decimalsKey(chain, ca), d);
    });
    const rows: WalletTokenHolding[] = [];
    cas.forEach((ca, i) => {
      const r = results[i];
      if (r === undefined) return;
      if (!r.success) {
        rows.push({ ca, amount: 0 }); // reverted (no code / non-standard): not held — 0 clears the stale row
        return;
      }
      const raw = decodeUint256(r.returnData);
      if (raw === null) {
        log.warn(`[evm] ${chain} ${ca.slice(0, 10)}: balanceOf returned non-uint256 data — skipped`);
        return;
      }
      if (raw === 0n) {
        rows.push({ ca, amount: 0 });
        return;
      }
      const d = this.decimalsCache.get(decimalsKey(chain, ca));
      if (d === undefined) {
        log.warn(`[evm] ${chain} ${ca.slice(0, 10)}: decimals unavailable — balance skipped (never guess a scale)`);
        return;
      }
      rows.push({ ca, amount: rawToTokenUnits(raw, d) });
    });
    return rows;
  }

  /** eth_call(Multicall3, data) — endpoints in order; the last failure is
   *  rethrown with a URL-free message (may carry the Alchemy key). */
  private async ethCall(chain: Chain, data: string): Promise<string> {
    const result = await this.rpc(chain, 'eth_call', [{ to: MULTICALL3_ADDRESS, data }, 'latest']);
    if (typeof result !== 'string') throw new SafeEvmError('evm rpc: malformed eth_call body');
    return result;
  }

  /** Total supply of `ca` in TOKEN UNITS via ONE Multicall3 eth_call: totalSupply()
   *  plus decimals() only while the scale is uncached. null when the CA is not a
   *  contract, totalSupply reverts, or decimals is unknowable — never a guessed
   *  number (the caller leaves holding pct null on null). */
  async tokenSupply(ca: string, chain: Chain): Promise<number | null> {
    if (!ADDRESS_RE.test(ca)) return null;
    const needDecimals = !this.decimalsCache.has(decimalsKey(chain, ca));
    const calls: Multicall3Call[] = [
      { target: ca, allowFailure: true, callData: TOTAL_SUPPLY_CALLDATA },
      ...(needDecimals ? [{ target: ca, allowFailure: true, callData: DECIMALS_CALLDATA }] : []),
    ];
    const results = decodeAggregate3(await this.ethCall(chain, encodeAggregate3(calls)));
    const sup = results[0];
    if (sup === undefined || !sup.success) return null;
    const raw = decodeUint256(sup.returnData);
    if (raw === null || raw === 0n) return null;
    let decimals = this.decimalsCache.get(decimalsKey(chain, ca));
    if (decimals === undefined) {
      const dec = results[1];
      const decoded = dec !== undefined && dec.success ? decodeDecimals(dec.returnData) : null;
      if (decoded === null) return null;
      decimals = decoded;
      this.decimalsCache.set(decimalsKey(chain, ca), decoded);
    }
    return rawToTokenUnits(raw, decimals);
  }

  /** eth_getTransactionByHash → the sender (tx.from, lowercased) or null when the
   *  hash is unknown or carries no valid `from`. */
  async transactionFrom(txHash: string, chain: Chain): Promise<string | null> {
    const result = await this.rpc(chain, 'eth_getTransactionByHash', [txHash]);
    const from = (result as { from?: unknown } | null)?.from;
    return typeof from === 'string' && ADDRESS_RE.test(from) ? from.toLowerCase() : null;
  }

  /** One JSON-RPC POST — endpoints in order; the LAST failure is rethrown with a
   *  URL-free message (may carry the Alchemy key). A null result (e.g. unknown tx)
   *  is a legitimate answer and is returned as-is. */
  private async rpc(chain: Chain, method: string, params: unknown[]): Promise<unknown> {
    const endpoints = this.endpointsFor(chain);
    if (endpoints.length === 0) {
      throw new Error(`evm rpc: no endpoint for ${chain} (set BASE_RPC_URL/BSC_RPC_URL/ROBINHOOD_RPC_URL)`);
    }
    let last = 'error';
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const json = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
        const rpcError = json?.error;
        if (!res.ok || json === null || (rpcError !== undefined && rpcError !== null)) {
          throw new SafeEvmError(`evm rpc ${res.status}${rpcError ? ` ${JSON.stringify(rpcError).slice(0, 80)}` : ''}`);
        }
        if (json.result === undefined) throw new SafeEvmError(`evm rpc: malformed ${method} body`);
        return json.result;
      } catch (e) {
        last = e instanceof SafeEvmError ? e.message : e instanceof Error ? e.name : 'error';
      }
    }
    throw new Error(`evm rpc ${method} failed (${chain}): ${last.slice(0, 160)}`);
  }
}
