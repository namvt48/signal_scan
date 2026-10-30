import { listWallets, type TrackedCaRow, type WalletRow } from './db.js';
import { log } from './log.js';
import { SolanaRpcClient, solanaRpcEndpoints } from './providers/solana.js';
import { enqueueWalletDiscoveriesForWallets, runWalletDiscovery } from './wallet-holdings-discovery.js';

export interface SolWalletRefreshResult {
  refreshed: number;
  failed: number;
  completedWallets?: { id: string; address: string }[];
}
export interface SolWalletRefreshDeps {
  rpc?: Pick<SolanaRpcClient, 'getTokenAccountsByOwner'>;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  wallets?: readonly WalletRow[];
}

/** Refresh full SPL + Token-2022 snapshots through the shared durable discovery worker. */
export async function refreshSolWalletHoldings(
  cas: readonly TrackedCaRow[],
  deps: SolWalletRefreshDeps = {},
): Promise<SolWalletRefreshResult> {
  const solCas = cas.filter((ca) => ca.chain === 'sol' && ca.status !== 'inactive');
  const wallets = (deps.wallets ?? listWallets()).filter((wallet) => wallet.chain === 'sol');
  if (wallets.length === 0 || solCas.length === 0) {
    return { refreshed: 0, failed: 0, completedWallets: [] };
  }
  const rpc = deps.rpc ?? new SolanaRpcClient(solanaRpcEndpoints());

  let refreshed = 0;
  let failed = 0;
  const completedWallets: { id: string; address: string }[] = [];
  enqueueWalletDiscoveriesForWallets(wallets, cas, true);
  for (const wallet of wallets) {
    try {
      const completed = await runWalletDiscovery(wallet.id, {
        rpc,
        sleep: deps.sleep,
        delayMs: deps.delayMs,
        forceFull: true,
      });
      if (!completed) {
        failed++;
        continue;
      }
      refreshed++;
      completedWallets.push({ id: wallet.id, address: wallet.address });
    } catch (error) {
      failed++;
      log.warn(`[sol-wallet-refresh] failed wallet=${wallet.address.slice(0, 8)}`, error);
    }
  }
  return { refreshed, failed, completedWallets };
}
