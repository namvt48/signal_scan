import { getDb, getWallet, listWallets, type WalletRow } from './db.js';
import { listTrackedCasSinceDeploy } from './settings.js';
import { replaceWalletBalances } from './ingest.js';
import { saveSolWalletHoldings } from './sol-wallet-holdings.js';
import { SolanaRpcClient, solanaRpcEndpoints, TOKEN_PROGRAM_IDS } from './providers/solana.js';
import type { MarketDataProvider, WalletTokenHolding } from './providers/provider.js';
import type { Chain } from './shared/chain.js';
import { log } from './log.js';
import {
  initializeDiscoveryState, syncDiscoveryTargets, ensureDiscoveryWallet,
  listDueDiscoveryWallets, readDiscoveryBatch, commitDiscoveryBatch,
  failDiscoveryBatch, pendingDiscoveryPairs, nextDiscoveryRunAt, pruneDiscoveryTargets,
  type DiscoveryBatch,
} from './wallet-discovery-state.js';

const BATCH_SIZE = 100;
const PACE_MS = 600;
const RETRY_MS = 30_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let provider: Pick<MarketDataProvider, 'walletTokenHoldings'> | undefined;
let running: Promise<void> | undefined;
let sleep = defaultSleep;
let solRpc: Pick<SolanaRpcClient, 'getTokenAccountsByOwner'> | undefined;
let timeoutMs = 120_000;
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const walletWriteQueues = new Map<string, Promise<unknown>>();
const initializedScopes = new WeakSet<object>();

let discoveryReadTail: Promise<void> = Promise.resolve();

function serializeDiscoveryRead<T>(work: () => Promise<T>): Promise<T> {
  const result = discoveryReadTail.then(work, work);
  discoveryReadTail = result.then(() => undefined, () => undefined);
  return result;
}

interface DiscoveryDeps {
  sleep?: (ms: number) => Promise<void>;
  solRpc?: Pick<SolanaRpcClient, 'getTokenAccountsByOwner'>;
  timeoutMs?: number;
}
export interface WalletHoldingsLease { isCurrent(): boolean }
export interface DiscoveryReadOptions {
  rpc?: Pick<SolanaRpcClient, 'getTokenAccountsByOwner'>;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  forceFull?: boolean;
}

export function configureWalletDiscovery(next: Pick<MarketDataProvider, 'walletTokenHoldings'>, deps: DiscoveryDeps = {}): void {
  provider = next;
  sleep = deps.sleep ?? defaultSleep;
  solRpc = deps.solRpc;
  timeoutMs = deps.timeoutMs ?? 120_000;
}

export function enqueueWalletDiscovery(wallet: WalletRow): void {
  enqueueWalletDiscoveriesForWallets([wallet]);
}

/** Refresh many wallet frontiers after syncing the shared target list once. */
export function enqueueWalletDiscoveriesForWallets(
  wallets: readonly WalletRow[],
  targets: readonly { address: string; chain: Chain }[] = listTrackedCasSinceDeploy(),
  reset = true,
  refreshTargets = false,
): number {
  initializeDiscoveryState();
  syncDiscoveryTargets(targets, refreshTargets);
  pruneDiscoveryTargets();
  for (const wallet of wallets) ensureDiscoveryWallet(wallet, reset);
  wakeDiscovery();
  return wallets.length;
}

/** A new target revision never invalidates observations of unrelated CAs. */
export function enqueueWalletDiscoveriesForCas(
  cas: readonly { address: string; chain: Chain }[],
  refreshExisting = false,
): number {
  const chains = new Set(cas.map((ca) => ca.chain));
  const wallets = listWallets().filter((wallet) => chains.has(wallet.chain));
  return enqueueWalletDiscoveriesForWallets(wallets, cas, false, refreshExisting);
}

/** Explicit full refresh across every chain. */
export function enqueueAllWalletDiscoveries(): number {
  return enqueueWalletDiscoveriesForChain();
}

/** Reset only the requested chain; midnight SOL refresh must leave EVM state alone. */
export function enqueueWalletDiscoveriesForChain(chain?: Chain): number {
  const wallets = listWallets().filter((wallet) => chain === undefined || wallet.chain === chain);
  return enqueueWalletDiscoveriesForWallets(wallets, listTrackedCasSinceDeploy(), true);
}

/** Serializes reads AND writes; expiry releases the queue and prevents late writes. */
export async function serializeWalletHoldings<T>(walletId: string, work: (lease: WalletHoldingsLease) => Promise<T> | T): Promise<T> {
  const db = getDb();
  const wallet = getWallet(walletId);
  const epoch = wallet ? ensureDiscoveryWallet(wallet).epoch : undefined;
  let active = true;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const lease = { isCurrent: () => {
    if (!active || getDb() !== db || epoch === undefined) return false;
    const current = getWallet(walletId);
    const state = db.prepare('SELECT epoch FROM wallet_discovery_wallets WHERE wallet_id=?').get(walletId) as {epoch:number}|undefined;
    return current?.address === wallet?.address && current?.chain === wallet?.chain && state?.epoch === epoch;
  } };
  const previous = walletWriteQueues.get(walletId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => {
    if (!lease.isCurrent()) throw new Error('wallet holdings identity changed or request expired');
    return work(lease);
  });
  const expiry = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => { active = false; reject(new Error('wallet holdings deadline exceeded')); }, timeoutMs);
  });
  let settled!: Promise<T>;
  settled = Promise.race([operation, expiry]).finally(() => {
    active = false;
    if (deadline) clearTimeout(deadline);
    if (walletWriteQueues.get(walletId) === settled) walletWriteQueues.delete(walletId);
  });
  walletWriteQueues.set(walletId, settled);
  return settled;
}

export function pendingWalletDiscoveryPairs(): Set<string> { return pendingDiscoveryPairs(); }
export function isWalletDiscoveryPendingForCa(ca: string, chain: Chain): boolean {
  return pendingDiscoveryPairs().has(`${chain}:${ca}`);
}

async function readSolHoldings(
  batch: DiscoveryBatch,
  options: DiscoveryReadOptions,
  lease: WalletHoldingsLease,
): Promise<WalletTokenHolding[]> {
  const rpc = options.rpc ?? (solRpc ??= new SolanaRpcClient(solanaRpcEndpoints()));
  const pause = options.sleep ?? sleep;
  const delay = Math.max(PACE_MS, options.delayMs ?? PACE_MS);
  if (!options.forceFull && batch.targets.length <= 2) {
    const rows: WalletTokenHolding[] = [];
    for (const target of batch.targets) {
      if (!lease.isCurrent()) return [];
      const amounts = await rpc.getTokenAccountsByOwner(batch.wallet.address, { mint: target.ca });
      if (!lease.isCurrent()) return [];
      rows.push({ ca: target.ca, amount: amounts.get(target.ca) ?? 0 });
      await pause(delay);
    }
    return rows;
  }
  const amounts = new Map<string, number>();
  for (const program of TOKEN_PROGRAM_IDS) {
    if (!lease.isCurrent()) return [];
    const holdings = await rpc.getTokenAccountsByOwner(batch.wallet.address, program);
    if (!lease.isCurrent()) return [];
    for (const [ca, amount] of holdings) amounts.set(ca, (amounts.get(ca) ?? 0) + amount);
    await pause(delay);
  }
  return batch.targets.map(({ ca }) => ({ ca, amount: amounts.get(ca) ?? 0 }));
}

/** Used by both background discovery and the scheduled full SOL refresh. */
export async function runWalletDiscovery(walletId: string, options: DiscoveryReadOptions = {}): Promise<boolean> {
  let captured: DiscoveryBatch | undefined;
  try {
    return await serializeDiscoveryRead(() => serializeWalletHoldings(walletId, async (lease) => {
      const wallet = getWallet(walletId);
      if (!wallet) return false;
      const batch = readDiscoveryBatch(walletId, Date.now(), wallet.chain === 'sol' ? Infinity : BATCH_SIZE);
      captured = batch;
      if (!batch) return true;
      if (batch.wallet.chain !== 'sol' && !provider) throw new Error('wallet discovery provider is not configured');
      const rows = batch.wallet.chain === 'sol'
        ? await readSolHoldings(batch, options, lease)
        : await provider!.walletTokenHoldings(batch.wallet.address, batch.wallet.chain, batch.targets.map(({ ca }) => ca));
      if (batch.wallet.chain !== 'sol') await (options.sleep ?? sleep)(PACE_MS);
      if (!lease.isCurrent()) return false;
      return commitDiscoveryBatch(batch, rows, (valid) => {
        if (batch.wallet.chain === 'sol') saveSolWalletHoldings(walletId, valid, batch.wallet.address);
        else replaceWalletBalances(walletId, batch.wallet.chain, valid);
      }, Date.now());
    }));
  } catch (error) {
    if (captured) failDiscoveryBatch(captured, Date.now(), RETRY_MS);
    log.warn(`[wallet-discovery] failed wallet=${walletId}`, error);
    return false;
  }
}

function wakeDiscovery(delayMs = PACE_MS): void {
  if (!started || timer || running) return;
  timer = setTimeout(() => {
    timer = undefined;
    void walletDiscoverySweep().catch((error) => log.error('[wallet-discovery]', error));
  }, delayMs);
  timer.unref();
}

export function startWalletDiscovery(): void {
  started = true;
  wakeDiscovery();
}

/** Drain currently eligible work fairly; failures remain durable until their cooldown. */
export function walletDiscoverySweep(): Promise<void> {
  if (!provider) return Promise.resolve();
  if (running) return running;
  const db = getDb();
  running = (async () => {
    initializeDiscoveryState();
    if (!initializedScopes.has(db)) {
      syncDiscoveryTargets(listTrackedCasSinceDeploy());
      initializedScopes.add(db);
    }
    pruneDiscoveryTargets();
    while (getDb() === db) {
      const jobs = listDueDiscoveryWallets(Date.now());
      if (jobs.length === 0) break;
      for (const job of jobs) {
        if (getDb() !== db) return;
        await runWalletDiscovery(job.wallet_id);
      }
    }
  })().finally(() => {
    running = undefined;
    if (getDb() !== db) return;
    const next = nextDiscoveryRunAt();
    if (next !== undefined) wakeDiscovery(Math.max(PACE_MS, next - Date.now()));
  });
  return running;
}

export async function walletDiscoveryIdle(): Promise<void> { await walletDiscoverySweep(); }
export function stopWalletDiscovery(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
