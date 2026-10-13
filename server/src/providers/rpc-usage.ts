import { createHash } from 'node:crypto';

export type RpcProvider = 'evm' | 'solana';
export type RpcSource = 'application' | 'fomo';

export interface RpcUsage {
  provider: RpcProvider;
  source: RpcSource;
  chain: string;
  endpointIndex: number;
  endpointId?: string;
  requests: number;
  successes: number;
  failures: number;
  creditExhausted: number;
  lastAt: number | null;
}


const MAX_ENTRIES = 512;
const counters = new Map<string, RpcUsage>();

function entry(
  provider: RpcProvider,
  source: RpcSource,
  chain: string,
  endpointIndex: number,
  endpointId?: string,
): RpcUsage {
  const key = `${provider}\0${source}\0${chain}\0${endpointIndex}`;
  let value = counters.get(key);
  if (value === undefined) {
    if (counters.size >= MAX_ENTRIES) counters.delete(counters.keys().next().value!);
    value = { provider, source, chain, endpointIndex, requests: 0, successes: 0, failures: 0, creditExhausted: 0, lastAt: null };
    counters.set(key, value);
  }
  if (endpointId !== undefined) value.endpointId = endpointId;
  return value;
}

export function registerRpcEndpoint(
  provider: RpcProvider,
  source: RpcSource,
  chain: string,
  endpointIndex: number,
  endpoint: string,
): void {
  const endpointId = createHash('sha256').update(endpoint).digest('hex');
  entry(provider, source, chain, endpointIndex, endpointId);
}


export function recordRpcAttempt(provider: RpcProvider, source: RpcSource, chain: string, endpointIndex: number): void {
  const value = entry(provider, source, chain, endpointIndex);
  value.requests += 1;
  value.lastAt = Date.now();
}

export function recordRpcOutcome(provider: RpcProvider, source: RpcSource, chain: string, endpointIndex: number, success: boolean, creditExhausted = false): void {
  const value = entry(provider, source, chain, endpointIndex);
  if (success) value.successes += 1;
  else value.failures += 1;
  if (creditExhausted) value.creditExhausted += 1;
  value.lastAt = Date.now();
}

export function snapshotRpcUsage(): RpcUsage[] {
  return [...counters.values()].map((value) => ({ ...value }));
}

export function clearRpcUsage(): void {
  counters.clear();
}
