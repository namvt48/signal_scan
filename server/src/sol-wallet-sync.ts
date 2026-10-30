import { deleteWallet, getDb, insertWallet, listWallets } from './db.js';
import { listTrackedCasSinceDeploy } from './settings.js';
import { log } from './log.js';
import { isSolanaAddress } from './shared/chain.js';
import { refreshSolWalletHoldings, type SolWalletRefreshResult } from './sol-wallet-refresh.js';
import { enqueueAllFomoDiscoveries } from './fomo-balance-discovery.js';

export const DASH1_URL = 'https://oliver-cat-public.vercel.app/api/dash1';
export interface DashSolWallet { address: string; name: string }
export interface Dash1Snapshot { updated_at: string; count: number; wallets: string[] }
export interface SolWalletSyncResult extends SolWalletRefreshResult { added: number; removed: number; total: number }

export function parseDashWallets(input: unknown): DashSolWallet[] {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('wallets' in input) || !('count' in input)) {
    throw new Error('dash1 response is not an object with wallets/count');
  }
  const { wallets, count } = input;
  if (!Array.isArray(wallets) || typeof count !== 'number' || !Number.isSafeInteger(count) || count !== wallets.length || count < 1) {
    throw new Error('dash1 wallet list is empty or incomplete');
  }
  const seen = new Set<string>();
  const parsed: DashSolWallet[] = [];
  for (const [index, candidate] of wallets.entries()) {
    if (typeof candidate !== 'string' || !isSolanaAddress(candidate)) throw new Error(`dash1 wallet ${index + 1} is not a valid Solana address`);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    parsed.push({ address: candidate, name: `W${index + 1}` });
  }
  if (parsed.length === 0) throw new Error('dash1 contains no unique wallets');
  return parsed;
}

export async function fetchDashWallets(fetcher: typeof fetch = fetch): Promise<DashSolWallet[]> {
  const response = await fetcher(DASH1_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`dash1 returned HTTP ${response.status}`);
  return parseDashWallets(await response.json() as unknown);
}

export function reconcileSolWallets(target: readonly DashSolWallet[]): { added: number; removed: number; total: number } {
  if (target.length === 0 || target.some((wallet) => !isSolanaAddress(wallet.address))) throw new Error('refusing an empty or invalid dash1 wallet snapshot');
  const db = getDb();
  return db.transaction(() => {
    const existing = listWallets().filter((wallet) => wallet.chain === 'sol');
    const byAddress = new Map(existing.map((wallet) => [wallet.address, wallet]));
    const desired = new Set(target.map((wallet) => wallet.address));
    let added = 0;
    let removed = 0;
    for (const wallet of existing) {
      if (desired.has(wallet.address)) continue;
      deleteWallet(wallet.id);
      removed++;
    }
    for (const item of target) {
      const prior = byAddress.get(item.address);
      if (prior) continue;
      insertWallet({ address: item.address, name: item.name, tags: [], chain: 'sol', source: 'dash1' });
      added++;
    }
    return { added, removed, total: target.length };
  })();
}

let running = false;
export function solWalletSyncInProgress(): boolean { return running; }

export async function runSolWalletSync(options: {
  fetchSnapshot?: () => Promise<DashSolWallet[]>;
  refresh?: () => Promise<SolWalletRefreshResult>;
} = {}): Promise<SolWalletSyncResult> {
  if (running) throw new Error('SOL wallet synchronization already running');
  running = true;
  try {
    const target = await (options.fetchSnapshot ?? fetchDashWallets)();
    if (target.length === 0 || target.some((w) => !isSolanaAddress(w.address))) throw new Error('dash1 wallet snapshot is empty or invalid');
    const delta = reconcileSolWallets(target);
    log.info(`[sol-wallet-sync] reconciled added=${delta.added} removed=${delta.removed} total=${delta.total}`);
    if (delta.added > 0 || delta.removed > 0) enqueueAllFomoDiscoveries();
    const refreshFn = options.refresh ?? (() => refreshSolWalletHoldings(listTrackedCasSinceDeploy()));
    const refresh = await refreshFn();
    return { ...delta, ...refresh };
  } catch (error) {
    log.error('[sol-wallet-sync] failed', error);
    throw error;
  } finally {
    running = false;
  }
}
