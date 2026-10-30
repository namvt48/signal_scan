import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getWallet, insertFomoUser, insertTrackedCa, insertWallet, listTrackedCas, listWallets, open } from '../src/db.js';
import { insertTrades, replaceWalletBalances } from '../src/ingest.js';
import { parseDashWallets, reconcileSolWallets, runSolWalletSync, solWalletSyncInProgress } from '../src/sol-wallet-sync.js';
import { msUntilNextUtcMidnight, startSolWalletSync } from '../src/sol-wallet-schedule.js';
import { refreshSolWalletHoldings } from '../src/sol-wallet-refresh.js';
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../src/providers/solana.js';
import { configureWalletDiscovery, walletDiscoveryIdle } from '../src/wallet-holdings-discovery.js';
import { ensureDiscoveryWallet, initializeDiscoveryState, syncDiscoveryTargets } from '../src/wallet-discovery-state.js';

const A = '3aR2xbqmWd8vxkFNraWMCYb6vUEgLvW4bJTo7bjWGdAu';
const B = '3bzaJd5yZG73EVDz8xosQb7gfZm2LN5auFGh6wnP1n1f';
const C = '8k1BPp8pCxq7RJxxBz3BUxvBjsfjhkHKnhr2WSQABGM9';
const CA = 'mDR91ufq4S2uSHa9E2PYL7xg4LwcQXaQFP7YK864a1z';
const snapshot = (wallets: string[]) => ({ updated_at: '2026-10-27T00:00:00Z', count: wallets.length, wallets });
before(() => open(':memory:'));
after(() => getDb().close());

test('invalid or incomplete dash snapshots cannot replace wallets; duplicate positions retain first index', () => {
  for (const bad of [null, [], {}, snapshot([]), { ...snapshot([A]), count: 2 }, snapshot([A, '0xabc']), snapshot([A, 'invalid'])]) {
    assert.throws(() => parseDashWallets(bad), /dash1/);
  }
  assert.deepEqual(parseDashWallets(snapshot([A, A, B])), [
    { address: A, name: 'W1' }, { address: B, name: 'W3' },
  ]);
});

test('replacement preserves retained metadata/ID and every EVM row while cascading removed SOL holdings/trades', () => {
  const kept = insertWallet({ address: A, name: 'custom', tags: ['alpha'], chain: 'sol', source: 'manual', clan: 'old' });
  const removed = insertWallet({ address: C, name: 'removed', tags: [], chain: 'sol', source: 'manual' });
  const evm = insertWallet({ address: '0xabc', name: 'EVM', tags: ['keep'], chain: 'base', source: 'manual' });
  insertTrackedCa({ address: CA, chain: 'sol', note: 'old CA' });
  insertTrades(removed.id, [{ ca: CA, chain: 'sol', ts: 1, side: 'buy', amountUsd: 7, price: 1, tx: 'removed-buy' }], 'watch');
  replaceWalletBalances(removed.id, 'sol', [{ ca: CA, amount: 7 }]);
  replaceWalletBalances(evm.id, 'base', [{ ca: CA, amount: 9 }]);
  const outcome = reconcileSolWallets(parseDashWallets(snapshot([B, A])));
  assert.deepEqual(outcome, { added: 1, removed: 1, total: 2 });
  assert.deepEqual(getWallet(kept.id), kept);
  assert.deepEqual(getWallet(evm.id), evm);
  assert.equal(getWallet(removed.id), undefined);
  assert.equal(listWallets().find((w) => w.address === B)?.name, 'W1');
  assert.equal((getDb().prepare('SELECT count(*) AS n FROM wallet_trades WHERE wallet_id = ?').get(removed.id) as { n: number }).n, 0);
  assert.deepEqual(getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ?').get(evm.id), { token_amount: 9 });
  assert.equal((getDb().prepare('SELECT count(*) AS n FROM tracked_cas WHERE address = ?').get(CA) as { n: number }).n, 1);
});

test('full SOL refresh skips inactive CAs and does not create trades', async () => {
  const inactive = insertTrackedCa({ address: C, chain: 'sol', note: 'inactive CA' });
  getDb().prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?").run(inactive.id);
  const beforeTrades = getDb().prepare('SELECT * FROM wallet_trades').all();
  let active = 0;
  let maxActive = 0;
  const calls: [string, string][] = [];
  const delays: number[] = [];
  const result = await refreshSolWalletHoldings(listTrackedCas(true), {
    rpc: { async getTokenAccountsByOwner(wallet: string, program: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push([wallet, program]);
      await Promise.resolve();
      active--;
      return new Map<string, number>(program === SPL_TOKEN_PROGRAM_ID ? [[CA, 12]] : [[C, 4]]);
    } },
    delayMs: 1000,
    sleep: async (ms: number) => { delays.push(ms); },
  });
  assert.deepEqual(result, {
    refreshed: 2,
    failed: 0,
    completedWallets: listWallets().filter((wallet) => wallet.chain === 'sol').map(({ id, address }) => ({ id, address })),
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(([, program]) => program), [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
  assert.ok(calls.every(([address]) => address === A || address === B));
  assert.equal(delays.length, 4);
  assert.ok(delays.every((ms) => ms >= 1000));
  assert.deepEqual(getDb().prepare('SELECT * FROM wallet_trades').all(), beforeTrades);
  assert.equal((getDb().prepare("SELECT status FROM tracked_cas WHERE id = ?").get(inactive.id) as { status: string }).status, 'inactive');
  assert.deepEqual(getDb().prepare("SELECT DISTINCT ca, token_amount FROM wallet_token_state WHERE chain = 'sol' ORDER BY ca").all(),
    [{ ca: CA, token_amount: 12 }]);
});
test('targeted refresh retries only the selected SOL wallets', async () => {
  const selected = listWallets().find((wallet) => wallet.address === A);
  assert.ok(selected);
  const otherBefore = getDb().prepare('SELECT * FROM wallet_token_state WHERE wallet_id = (SELECT id FROM wallets WHERE address = ?) ORDER BY ca').all(B);
  const calls: [string, string][] = [];
  const result = await refreshSolWalletHoldings(listTrackedCas(true), {
    wallets: [selected],
    rpc: { async getTokenAccountsByOwner(wallet: string, program: string) {
      calls.push([wallet, program]);
      return new Map<string, number>(program === SPL_TOKEN_PROGRAM_ID ? [[CA, 8]] : []);
    } },
    sleep: async () => {},
  });
  assert.deepEqual(result, { refreshed: 1, failed: 0, completedWallets: [{ id: selected.id, address: selected.address }] });
  assert.deepEqual(calls, [[A, SPL_TOKEN_PROGRAM_ID], [A, TOKEN_2022_PROGRAM_ID]]);
  assert.deepEqual(getDb().prepare('SELECT * FROM wallet_token_state WHERE wallet_id = (SELECT id FROM wallets WHERE address = ?) ORDER BY ca').all(B), otherBefore);
});


test('one failed token program preserves all previous holdings for that wallet; later wallets still refresh', async () => {
  const before = getDb().prepare("SELECT * FROM wallet_token_state WHERE wallet_id IN (SELECT id FROM wallets WHERE address = ?)").all(A);
  const outcome = await refreshSolWalletHoldings(listTrackedCas(true), {
    rpc: { async getTokenAccountsByOwner(wallet: string, program: string) {
      if (wallet === A && program === TOKEN_2022_PROGRAM_ID) throw new Error('RPC unavailable');
      return new Map<string, number>();
    } },
    delayMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(outcome, { refreshed: 1, failed: 1, completedWallets: [{ id: listWallets().find((wallet) => wallet.address === B)!.id, address: B }] });
  assert.deepEqual(getDb().prepare("SELECT * FROM wallet_token_state WHERE wallet_id IN (SELECT id FROM wallets WHERE address = ?)").all(A), before);
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM wallet_token_state WHERE wallet_id IN (SELECT id FROM wallets WHERE address = ?) AND chain = 'sol'").get(B) as { n: number }).n, 0);
});

test('invalid source aborts before changing wallets or querying RPC', async () => {
  const before = listWallets();
  let rpcCalls = 0;
  await assert.rejects(runSolWalletSync({ fetchSnapshot: async () => parseDashWallets(snapshot([])), refresh: async () => { rpcCalls++; return { refreshed: 0, failed: 0 }; } }), /dash1/);
  assert.deepEqual(listWallets(), before);
  assert.equal(rpcCalls, 0);
  assert.equal(solWalletSyncInProgress(), false);
});

test('overlapping synchronization is rejected until refresh finishes', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = runSolWalletSync({ fetchSnapshot: async () => parseDashWallets(snapshot([A, B])), refresh: async () => { await blocked; return { refreshed: 2, failed: 0 }; } });
  try {
    assert.equal(solWalletSyncInProgress(), true);
    await assert.rejects(runSolWalletSync(), /already running/);
  } finally { release(); }
  assert.deepEqual(await first, { added: 0, removed: 0, total: 2, refreshed: 2, failed: 0 });
  assert.equal(solWalletSyncInProgress(), false);
});

test('scheduled synchronization composes dash reconciliation and the full SOL wallet snapshot refresh', async () => {
  const result = await runSolWalletSync({
    fetchSnapshot: async () => parseDashWallets(snapshot([B, A])),
    refresh: () => refreshSolWalletHoldings(listTrackedCas(true), {
      rpc: { async getTokenAccountsByOwner(_wallet: string, program: string) {
        return new Map<string, number>(program === SPL_TOKEN_PROGRAM_ID ? [[CA, 2]] : [[C, 4]]);
      } },
      sleep: async () => {},
    }),
  });
  assert.deepEqual(result, {
    added: 0, removed: 0, total: 2, refreshed: 2, failed: 0,
    completedWallets: listWallets().filter((wallet) => wallet.chain === 'sol').map(({ id, address }) => ({ id, address })),
  });
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM sol_wallet_holding_membership WHERE chain = 'sol'").get() as { n: number }).n, 2);
  assert.equal(
    (getDb().prepare("SELECT count(*) AS n FROM sol_wallet_holding_membership WHERE chain = 'sol' AND ca = ?")
      .get(C) as { n: number }).n,
    0,
    'inactive CA membership is not refreshed',
  );
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM wallet_trades WHERE source = 'watch'").get() as { n: number }).n, 0);
  assert.deepEqual(listWallets().filter((wallet) => wallet.chain === 'sol').map((wallet) => [wallet.address, wallet.name]).sort(),
    [[A, 'custom'], [B, 'W1']].sort());
});

test('dash1 RPC failures remain durably queued and retry after worker reconfiguration', async () => {
  const evm = insertWallet({ address: `0x${'a'.repeat(40)}`, name: 'keep-evm', tags: ['stay'], chain: 'base', source: 'manual' });
  const evmCa = `0x${'e'.repeat(40)}`;
  insertTrackedCa({ address: evmCa, chain: 'base', note: '' });
  const fomoUser = insertFomoUser({ handle: 'dash-refresh', user_id: 'stable-dash-refresh' });
  initializeDiscoveryState();
  ensureDiscoveryWallet(evm);
  syncDiscoveryTargets(listTrackedCas(true));
  const revisionRow = getDb().prepare("SELECT value FROM wallet_discovery_meta WHERE key='revision'").get() as {value:number};
  getDb().prepare('UPDATE wallet_discovery_wallets SET frontier=?').run(revisionRow.value);
  const evmState = getDb().prepare('SELECT epoch,frontier,retry_at FROM wallet_discovery_wallets WHERE wallet_id=?').get(evm.id);

  const result = await runSolWalletSync({
    fetchSnapshot: async () => parseDashWallets(snapshot([A, B, C])),
    refresh: () => refreshSolWalletHoldings(listTrackedCas(true), {
      wallets: listWallets().filter((wallet) => wallet.chain === 'sol'),
      rpc: { async getTokenAccountsByOwner() { throw new Error('RPC unavailable'); } },
      sleep: async () => {},
    }),
  });
  assert.equal(result.added, 1);
  assert.equal(result.failed, listWallets().filter((wallet) => wallet.chain === 'sol').length);
  assert.deepEqual(getWallet(evm.id), evm);
  assert.deepEqual(getDb().prepare('SELECT epoch,frontier,retry_at FROM wallet_discovery_wallets WHERE wallet_id=?').get(evm.id), evmState);
  const pendingSol = getDb().prepare("SELECT COUNT(*) AS n FROM wallet_discovery_wallets WHERE chain='sol' AND retry_at>?").get(Date.now()) as {n:number};
  assert.equal(pendingSol.n, 3);
  const fomoState = getDb().prepare("SELECT last_outcome FROM fomo_api_request_state WHERE fomo_user_id=? AND endpoint='balances'").get(fomoUser.id) as {last_outcome:string};
  assert.equal(fomoState.last_outcome, 'discovery_queued');

  getDb().prepare("UPDATE wallet_discovery_wallets SET retry_at=0 WHERE chain='sol'").run();
  configureWalletDiscovery({ walletTokenHoldings: async () => [] } as never, {
    sleep: async () => {},
    solRpc: { async getTokenAccountsByOwner(_wallet: string, filter: string | { mint: string }) {
      const holdings = new Map<string, number>();
      if (typeof filter === 'string' && filter === SPL_TOKEN_PROGRAM_ID) holdings.set(CA, 17);
      if (typeof filter !== 'string' && filter.mint === CA) holdings.set(CA, 17);
      return holdings;
    } },
  });
  await walletDiscoveryIdle();
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM wallet_token_state WHERE chain='sol' AND token_amount=17").get() as {n:number}).n, 3);
  const state = getDb().prepare(`
    SELECT w.frontier, MAX(t.revision) AS latest
      FROM wallet_discovery_wallets w
      JOIN wallet_discovery_targets t ON t.chain=w.chain
     WHERE w.chain='sol'
     GROUP BY w.wallet_id
  `).all() as {frontier:number;latest:number}[];
  assert.equal(state.length, 3);
  assert.ok(state.every((row) => row.frontier === row.latest));
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM wallet_discovery_exceptions WHERE chain='sol'").get() as {n:number}).n, 0);
});

test('schedule computes the next 00:00 UTC, never a local-midnight or immediate startup run', () => {
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-27T23:59:59.500Z')), 500);
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-28T00:00:00Z')), 86_400_000);
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-28T07:00:00+07:00')), 86_400_000);
});

test('scheduler fires the actual job once at midnight, rearms, and stops cleanly', async () => {
  let now = Date.parse('2026-10-27T23:59:59Z');
  let callback: (() => void) | undefined;
  const delays: number[] = [];
  let clears = 0;
  let runs = 0;
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  const stop = startSolWalletSync({
    now: () => now,
    run: async () => { runs++; },
    setTimer: (fn, ms) => { callback = fn; delays.push(ms); if (delays.length === 2) completed(); return { unref() {} } as ReturnType<typeof setTimeout>; },
    clearTimer: () => { clears++; },
  });
  assert.equal(runs, 0);
  assert.deepEqual(delays, [1000]);
  now += 1000;
  assert.ok(callback);
  callback();
  await done;
  assert.equal(runs, 1);
  assert.deepEqual(delays, [1000, 86_400_000]);
  stop();
  assert.equal(clears, 1);
});
