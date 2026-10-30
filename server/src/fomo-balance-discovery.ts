import {
  findFomoUserByHandle,
  getDb,
  getFomoApiRequestState,
  listFomoUsers,
  saveFomoApiRequestState,
  syncFomoApiBalancesSnapshot,
  type FomoPositionInput,
  type FomoUserRow,
} from './db.js';
import { config } from './config.js';
import type { Chain } from './shared/chain.js';
import { fetchFomoBalances } from './fomo-api.js';

const BATCH_SIZE = 4;
const SUCCESS_REFRESH_MS = 60 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const NO_DATA_BACKOFF_MS = 60_000;
const QUEUED = 'discovery_queued';

type RunSerialized = (userId: string, run: () => Promise<void>) => Promise<void>;
let runSerialized: RunSerialized = async (_userId, run) => run();
let running = false;
const requested = new Map<string, FomoUserRow>();

/** Optional shared per-user API serialization, injected by poller integration. */
export function configureFomoDiscovery(options: { runSerialized?: RunSerialized } = {}): void {
  if (options.runSerialized !== undefined) runSerialized = options.runSerialized;
}

/** Queue a user for balance discovery; forced refreshes still honor upstream cooldowns. */
export function enqueueFomoDiscovery(user: FomoUserRow, force = false): void {
  const current = getFomoApiRequestState(user.id, 'balances');
  requested.set(user.id, user);
  if (current !== undefined && current.next_eligible_at > Date.now() && !force) return;
  saveFomoApiRequestState({
    fomo_user_id: user.id,
    endpoint: 'balances',
    last_attempt_at: current?.last_attempt_at ?? 0,
    next_eligible_at: current?.next_eligible_at ?? 0,
    consecutive_failures: current?.consecutive_failures ?? 0,
    last_outcome: QUEUED,
  });
}

export function enqueueAllFomoDiscoveries(): number {
  const users = listFomoUsers();
  for (const user of users) enqueueFomoDiscovery(user, true);
  return users.length;
}

function identityStillMatches(user: FomoUserRow): boolean {
  const current = getDb().prepare('SELECT id, handle, user_id FROM fomo_users WHERE id = ?').get(user.id) as
    { id: string; handle: string; user_id: string | null } | undefined;
  return current !== undefined && current.handle === user.handle && current.user_id === user.user_id;
}

function persistOutcome(userId: string, outcome: string, retryAfterMs: number | null, now: number): void {
  const previous = getFomoApiRequestState(userId, 'balances');
  let failures = previous?.consecutive_failures ?? 0;
  let delay: number;
  if (outcome === 'success') {
    failures = 0;
    delay = SUCCESS_REFRESH_MS;
  } else if (outcome === 'no_data' || outcome === 'incomplete' || outcome === 'upstream_down' || outcome === 'unconfigured') {
    failures = 0;
    delay = NO_DATA_BACKOFF_MS;
  } else {
    failures++;
    delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(20, failures - 1));
  }
  if (retryAfterMs !== null) delay = Math.max(delay, retryAfterMs);
  saveFomoApiRequestState({
    fomo_user_id: userId,
    endpoint: 'balances',
    last_attempt_at: now,
    next_eligible_at: now + delay,
    consecutive_failures: failures,
    last_outcome: outcome,
  });
}

async function discover(user: FomoUserRow): Promise<void> {
  const current = findFomoUserByHandle(user.handle);
  if (current === undefined || current.id !== user.id || current.user_id !== user.user_id) {
    persistOutcome(user.id, 'identity_changed', null, Date.now());
    return;
  }
  const result = await fetchFomoBalances(user.user_id ?? user.handle);
  const fetchedAt = Date.now();
  if (result.outcome === 'success' && result.value !== null) {
    if (!identityStillMatches(user)) {
      persistOutcome(user.id, 'identity_changed', null, fetchedAt);
      return;
    }
    const rows: FomoPositionInput[] = result.value.map((p) => ({
      fomo_user_id: user.id,
      ca: p.ca,
      chain: p.chain,
      trade_id: p.tradeId,
      status: p.status,
      amount: p.amount,
      cost_basis_usd: p.costBasisUsd,
      avg_entry_price: p.avgEntryPrice,
      price_usd: p.priceUsd,
      realized_pnl_usd: p.realizedPnlUsd,
      unrealized_pnl_usd: p.unrealizedPnlUsd,
      fetched_at: fetchedAt,
    }));
    syncFomoApiBalancesSnapshot(user.id, rows, fetchedAt, result.complete);
    persistOutcome(user.id, result.complete ? 'success' : 'incomplete', null, fetchedAt);
    return;
  }
  persistOutcome(user.id, result.outcome, result.retryAfterMs, fetchedAt);
}

/** One bounded fair pass; API failures and partial pages retain durable retry state. */
export async function fomoDiscoverySweep(): Promise<void> {
  if (running || config.fomoProdUrl === '') return;
  running = true;
  try {
    const now = Date.now();
    const candidates = new Map<string, FomoUserRow>();
    for (const user of listFomoUsers()) candidates.set(user.id, user);
    for (const [id, user] of requested) candidates.set(id, user);
    const eligible = [...candidates.values()]
      .filter((user) => {
        const state = getFomoApiRequestState(user.id, 'balances');
        return (requested.has(user.id) || state === undefined || state.last_outcome === QUEUED || state.next_eligible_at <= now)
          && (state === undefined || state.next_eligible_at <= now);
      })
      .sort((a, b) => (getFomoApiRequestState(a.id, 'balances')?.last_attempt_at ?? 0)
        - (getFomoApiRequestState(b.id, 'balances')?.last_attempt_at ?? 0) || a.id.localeCompare(b.id))
      .slice(0, BATCH_SIZE);
    await Promise.all(eligible.map(async (user) => {
      requested.delete(user.id);
      await runSerialized(user.id, async () => {
        try {
          if (!identityStillMatches(user)) {
            persistOutcome(user.id, 'identity_changed', null, Date.now());
            return;
          }
          const before = getFomoApiRequestState(user.id, 'balances');
          saveFomoApiRequestState({
            fomo_user_id: user.id, endpoint: 'balances', last_attempt_at: Date.now(),
            next_eligible_at: Date.now(), consecutive_failures: before?.consecutive_failures ?? 0,
            last_outcome: 'discovery_running',
          });
          await discover(user);
          const queued = requested.get(user.id);
          if (queued !== undefined && identityStillMatches(queued)) {
            const outcome = getFomoApiRequestState(user.id, 'balances');
            saveFomoApiRequestState({
              fomo_user_id: user.id, endpoint: 'balances',
              last_attempt_at: outcome?.last_attempt_at ?? Date.now(),
              next_eligible_at: outcome?.next_eligible_at ?? Date.now(),
              consecutive_failures: outcome?.consecutive_failures ?? 0, last_outcome: QUEUED,
            });
          } else if (queued !== undefined) {
            requested.delete(user.id);
          }
        } catch {
          persistOutcome(user.id, 'network_error', null, Date.now());
        }
      });
    }));
  } finally {
    running = false;
  }
}

/** Drain immediately eligible work; intentionally does not wait for retry timers. */
export async function fomoDiscoveryIdle(): Promise<void> {
  if (config.fomoProdUrl === '') return;
  while (running) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  while (true) {
    const now = Date.now();
    const actionable = listFomoUsers().some((user) => {
      const state = getFomoApiRequestState(user.id, 'balances');
      return state === undefined || state.next_eligible_at <= now;
    });
    if (!actionable) return;
    await fomoDiscoverySweep();
    if (running) return;
  }
}

/** Avoid pruning while any user's first portfolio discovery is queued or running. */
export function isFomoDiscoveryPending(_now = Date.now()): boolean {
  return listFomoUsers().some((user) => {
    const state = getFomoApiRequestState(user.id, 'balances');
    return state === undefined || state.last_outcome === QUEUED || state.last_outcome === 'discovery_running';
  });
}

export function isFomoDiscoveryPendingForCa(_ca: string, _chain: Chain, now = Date.now()): boolean {
  return isFomoDiscoveryPending(now);
}

/** Incomplete portfolio is reported separately from bounded active work. */
export function isFomoDiscoveryIncomplete(): boolean {
  return listFomoUsers().some((user) => getFomoApiRequestState(user.id, 'balances')?.last_outcome === 'incomplete');
}
export function stopFomoDiscovery(): void {
  requested.clear();
}
