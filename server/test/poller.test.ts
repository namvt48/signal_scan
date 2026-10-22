import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getMetricPollCache, insertFomoTrade, insertFomoUser, insertTrackedCa, insertWallet, open, upsertFomoPosition } from '../src/db.js';
import { fomoHoldingsIdle, fomoPositionCooldownRefreshIdle, kickFomoPositions, kickWallet, kickWalletHoldingsFor, metricSweep, pacedFor, setPollerDeps, walletSweep } from '../src/poller.js';
import { config } from '../src/config.js';
import { insertTrades, replaceWalletBalances, updateTokenMetrics } from '../src/ingest.js';
import type { MarketDataProvider } from '../src/providers/provider.js';

let walletId = '';

function fomoHealthResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function balanceRow(ca: string, amount: string, tradeId: string): unknown {
  return {
    tokenFilterResult: { priceUSD: '1', token: { address: ca, networkId: 1399811149 } },
    userToken: { humanAmountRemaining: amount, totalCostBasisUsd: 10 },
    activeTrade: { id: tradeId, networkId: 1399811149 },
  };
}

function swapRow(ca: string, at: number, tradeId: string, usd: number): unknown {
  return {
    inTokenAddress: 'USDC',
    outTokenAddress: ca,
    humanUsdAmountIn: usd,
    humanUsdAmountOut: usd,
    createdAt: at,
    outTradeId: tradeId,
    networkId: 1399811149,
    outNetworkId: 1399811149,
  };
}

before(() => {
  open(':memory:');
  walletId = insertWallet({ address: 'wallet-addr-1', name: 'CT01', tags: [], chain: 'sol', source: 'test' }).id;
});

// walletSweep is holdings-only (free Solana RPC) and LINKED-ONLY (user 2026-09-23):
// it refreshes the wallets a tracked CA is `Tracked by` and never spends an RPC call
// on a wallet no tracked CA links to. Trades are not part of any sweep (the wallet-watch
// detector owns them), so this path is fully independent.
test('walletSweep: writes holdings for linked wallets only, never queries the rest', async () => {
  const seen: string[] = [];
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => ({}),
    walletTokenHoldings: async (address: string) => {
      seen.push(address);
      return [{ ca: 'CA1', amount: 123 }];
    },
  };
  setPollerDeps(provider, {} as never);

  insertTrackedCa({ address: 'CA1', chain: 'sol', note: 'test' });
  insertTrades(
    walletId,
    [{ tx: 'tx-sweep-1', ts: Date.now(), side: 'buy', ca: 'CA1', chain: 'sol', amountUsd: 100, price: 1 }],
    'watch',
  );
  const unlinkedId = insertWallet({ address: 'wallet-addr-unlinked', name: 'CT99', tags: [], chain: 'sol', source: 'test' }).id;

  await walletSweep(provider); // must resolve

  const row = getDb()
    .prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
    .get(walletId, 'CA1') as { token_amount: number } | undefined;
  assert.ok(row, 'wallet_token_state row missing — the RPC holdings write did not land');
  assert.equal(row?.token_amount, 123);
  assert.deepEqual(seen, ['wallet-addr-1'], 'walletSweep queried a wallet no tracked CA links to');
  assert.equal(
    getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ?').get(unlinkedId),
    undefined,
    'unlinked wallet got a holdings row',
  );
});

test('walletSweep does not refresh FOMO balances or positions for previously alerted users', async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = config.fomoProdUrl;
  const user = insertFomoUser({ handle: 'event-only-sweep', name: 'Event only' });
  insertTrackedCa({ address: 'FOMO-SWEEP-CA', chain: 'base', note: 'test' });
  insertFomoTrade({
    fomo_user_id: user.id,
    event_id: 'fomo-sweep-existing-alert',
    ca: 'FOMO-SWEEP-CA',
    chain: 'base',
    type: 'buy',
    ts: Date.now(),
  });
  let fomoApiCalls = 0;
  config.fomoProdUrl = 'https://fomo.test';
  globalThis.fetch = (async () => {
    fomoApiCalls += 1;
    throw new Error('walletSweep must not call FOMO API');
  }) as typeof fetch;
  try {
    const provider: MarketDataProvider = {
      name: 'nansen',
      tokenInfo: async () => { throw new Error('unused'); },
      metric: async () => ({}),
      walletTokenHoldings: async () => [],
    };
    await walletSweep(provider);
    assert.equal(fomoApiCalls, 0, 'scheduled native wallet sweep must not requery FOMO users');
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});

// The on-demand sibling caller: a user-triggered wallet kick writes the same
// credit-free RPC holdings immediately.
test('kickWallet: writes the credit-free RPC holdings', async () => {
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => ({}),
    walletTokenHoldings: async () => [{ ca: 'CA2', amount: 456 }],
  };
  setPollerDeps(provider, {} as never);

  const kickWalletId = insertWallet({ address: 'wallet-addr-2', name: 'CT02', tags: [], chain: 'sol', source: 'test' }).id;
  const row = () =>
    getDb()
      .prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
      .get(kickWalletId, 'CA2') as { token_amount: number } | undefined;

  kickWallet(provider, kickWalletId, 'kick-addr-1', 'sol', ['CA2']);
  for (let i = 0; i < 100 && !row(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(row()?.token_amount, 456, 'kickWallet: activity 403 gated the holdings write');
});

// Per-endpoint cadence split: each sweep writes ONLY the columns its endpoint
// owns, and the first write creates the row — a CA whose essential pass failed
// must still get its gini card instead of writing nowhere.
test('updateTokenMetrics: writes only the provided keys, creates the row', () => {
  const read = () =>
    getDb()
      .prepare('SELECT volume24h, nansen_holders, nansen_fresh_pct, nansen_t100_pct FROM token_state WHERE ca = ? AND chain = ?')
      .get('CA-METRICS', 'sol') as
      | { volume24h: number | null; nansen_holders: number | null; nansen_fresh_pct: number | null; nansen_t100_pct: number | null }
      | undefined;

  assert.equal(read(), undefined, 'precondition: the row must not exist yet');
  updateTokenMetrics('CA-METRICS', 'sol', { nansenHolders: 10, nansenFreshPct: 5 });
  assert.equal(read()?.nansen_holders, 10, 'the first write must create the row');

  updateTokenMetrics('CA-METRICS', 'sol', { volume24h: 7 });
  assert.equal(read()?.volume24h, 7);
  assert.equal(read()?.nansen_holders, 10, 'the volume sweep wiped the gini card');

  updateTokenMetrics('CA-METRICS', 'sol', { nansenT100Pct: 42 });
  updateTokenMetrics('CA-METRICS', 'sol', { nansenHolders: 11 });
  assert.equal(read()?.nansen_t100_pct, 42, 'an omitted optional gini field must keep its value');
});

// The writer the pair sweeps feed: a (wallet, CA) row is replaced in isolation, and a
// pair the RPC reports as 0 must be DELETED — a sold-out position that froze at its last
// nonzero value is the bug this scoping introduced.
test('replaceWalletBalances: pair-scoped — 0 deletes that pair and leaves the sibling CAs alone', () => {
  const id = insertWallet({ address: 'wallet-addr-pair', name: 'PAIR', tags: [], chain: 'sol', source: 'test' }).id;
  const read = (ca: string) =>
    getDb()
      .prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?')
      .get(id, ca) as { token_amount: number } | undefined;

  replaceWalletBalances(id, 'sol', [{ ca: 'P-1', amount: 5 }, { ca: 'P-2', amount: 7 }]);
  assert.equal(read('P-1')?.token_amount, 5);

  replaceWalletBalances(id, 'sol', [{ ca: 'P-1', amount: 0 }]);
  assert.equal(read('P-1'), undefined, 'a sold-out pair must decay to zero, not freeze');
  assert.equal(read('P-2')?.token_amount, 7, 'an unrelated CA of the same wallet was wiped');
});

// Pacing invariant: a request slower than its slot must EAT the slot, not have
// the slot added after it. Additive pacing made every pass cost 0.8×interval
// plus n×requestCost, so the 15m tiers overran their own interval (1007s vs 900s).
test('pacedFor: a slow request consumes its slot instead of adding the gap on top', async () => {
  // interval 300ms × pace 0.8 / 3 items = 80ms, which the 250ms floor raises to
  // 250ms — so a 300ms request is slower than its slot and must absorb it.
  const costMs = 300;
  const started = Date.now();
  await pacedFor([0, 1, 2], 300, async () => {
    await new Promise((r) => setTimeout(r, costMs));
  });
  const elapsed = Date.now() - started;

  // Fixed-rate: ~3×300=900ms. Additive: ~3×300 + 2×250=1400ms.
  assert.ok(elapsed < 1200, `the gap was added on top of the request: got ${elapsed}ms, expected ~${3 * costMs}ms`);
});


test('metricSweep: a stuck Gini CA times out without blocking the next CA or persisting its late result', async () => {
  const oldTimeout = config.giniMetricTimeoutMs;
  config.giniMetricTimeoutMs = 50;
  let resolveCa1!: (patch: { nansenFreshPct: number }) => void;
  let notifyCa1Started!: () => void;
  let notifyCa2Finished!: () => void;
  let ca1Signal: AbortSignal | undefined;
  const ca1Started = new Promise<void>((resolve) => { notifyCa1Started = resolve; });
  const ca2Finished = new Promise<void>((resolve) => { notifyCa2Finished = resolve; });
  const ca1Result = new Promise<{ nansenFreshPct: number }>((resolve) => { resolveCa1 = resolve; });
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => { throw new Error('unused'); },
    metric: async (ca, _chain, kind, signal) => {
      assert.equal(kind, 'gini');
      if (ca === 'CA-GINI-1') {
        ca1Signal = signal;
        notifyCa1Started();
        return ca1Result;
      }
      notifyCa2Finished();
      return { nansenFreshPct: 22 };
    },
    walletTokenHoldings: async () => [],
  };
  const targets = [
    { address: 'CA-GINI-1', chain: 'sol' as const },
    { address: 'CA-GINI-2', chain: 'sol' as const },
  ];
  updateTokenMetrics('CA-GINI-1', 'sol', { nansenFreshPct: 11 });
  let sweep: Promise<void> | undefined;
  try {
    sweep = metricSweep(provider, 'gini', 1, targets);
    await ca1Started;
    const ca2Completed = await Promise.race([
      ca2Finished.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(ca2Completed, true, 'a pending Gini provider call blocked the next CA');
    assert.equal(ca1Signal?.aborted, true, 'the timed-out provider call was not aborted');
  } finally {
    resolveCa1({ nansenFreshPct: 99 });
    if (sweep !== undefined) await sweep;
    config.giniMetricTimeoutMs = oldTimeout;
  }
  assert.equal(getMetricPollCache('CA-GINI-2', 'sol', 'gini')?.response_json, '{"nansenFreshPct":22}');
  assert.equal(getMetricPollCache('CA-GINI-1', 'sol', 'gini')?.response_json, null, 'late CA1 response was persisted');
  assert.equal(getDb().prepare('SELECT nansen_fresh_pct FROM token_state WHERE ca = ? AND chain = ?').get('CA-GINI-1', 'sol')?.nansen_fresh_pct, 11, 'late CA1 result overwrote the last known metric');
});
// Fast CA→wallet attach (A): on insert, refresh holdings immediately so the linked
// wallet's balance lands in ~1s instead of waiting out the 15m walletSweep. Only the
// wallets the watch BUY already linked are read; coalesced per chain. Every chain
// kicks (T5): sol via Solana RPC, base/bsc via EVM RPC.
test("kickWalletHoldingsFor: reads only the CAs' linked wallets, coalesces per chain, fires on base too", async () => {
  const calls: string[] = [];
  const provider: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => ({}),
    walletTokenHoldings: async (wallet) => {
      calls.push(wallet);
      if (wallet === 'hold-addr') return [{ ca: 'CA-HOLD', amount: 777 }];
      if (wallet === 'hold-base') return [{ ca: 'CA-BASE', amount: 55 }];
      return [];
    },
  };
  setPollerDeps(provider, {} as never);
  const solId = insertWallet({ address: 'hold-addr', name: 'HOLD1', tags: [], chain: 'sol', source: 'test' }).id;
  insertWallet({ address: 'idle-addr', name: 'IDLE', tags: [], chain: 'sol', source: 'test' });
  const baseId = insertWallet({ address: 'hold-base', name: 'HOLD-BASE', tags: [], chain: 'base', source: 'test' }).id;
  // The watch BUY IS the link (signals.trackedByNames) — the only thing that puts
  // this wallet in scope, which is why the kick never needs the other wallets.
  insertTrades(solId, [{ tx: 'tx-link', ts: Date.now(), side: 'buy', ca: 'CA-HOLD', chain: 'sol', amountUsd: 1, price: 1 }], 'watch');
  insertTrades(baseId, [{ tx: 'tx-link-base', ts: Date.now(), side: 'buy', ca: 'CA-BASE', chain: 'base', amountUsd: 1, price: 1 }], 'watch');

  kickWalletHoldingsFor([{ address: 'CA-HOLD', chain: 'sol' }]);
  kickWalletHoldingsFor([{ address: 'CA-HOLD-2', chain: 'sol' }]); // same chain, still in flight
  kickWalletHoldingsFor([{ address: 'CA-BASE', chain: 'base' }]); // other chain → own in-flight slot

  const state = (id: string, ca: string) =>
    getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id = ? AND ca = ?').get(id, ca) as
      | { token_amount: number }
      | undefined;
  for (let i = 0; i < 100 && !(state(solId, 'CA-HOLD') && state(baseId, 'CA-BASE')); i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(state(solId, 'CA-HOLD')?.token_amount, 777, 'the holding was not attached immediately');
  assert.equal(state(baseId, 'CA-BASE')?.token_amount, 55, 'the base kick never landed — non-sol chains must fire too');
  assert.equal(calls.filter((a) => a === 'hold-addr').length, 1, 'a second kick for the same chain must coalesce');
  assert.equal(calls.filter((a) => a === 'idle-addr').length, 0, 'a wallet with no watch BUY link must not be queried');
  assert.equal(calls.filter((a) => a === 'hold-base').length, 1, 'the base kick fires exactly once');
});

test('FOMO alert batch refreshes every tracked user position from one response', async () => {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  const user = insertFomoUser({ handle: 'positions-batch', user_id: 'stable-fomo-id', name: 'Positions batch' });
  const caA = 'FOMO-BATCH-A';
  const caB = 'FOMO-BATCH-B';
  const caC = 'FOMO-BATCH-C';
  const unrelatedCa = 'FOMO-BATCH-UNRELATED';
  for (const address of [caA, caB, caC, unrelatedCa]) insertTrackedCa({ address, chain: 'sol', note: 'test' });
  const tsA = Date.now() - 1_000;
  const tsB = tsA + 100;
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'batch-buy-a', ca: caA, chain: 'sol', type: 'buy', ts: tsA });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'batch-buy-b', ca: caB, chain: 'sol', type: 'buy', ts: tsB });
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'batch-buy-c', ca: caC, chain: 'sol', type: 'buy', ts: tsB });
  config.fomoProdUrl = 'https://fomo.test';
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith('/health')) return fomoHealthResponse();
    if (path.endsWith('/balances')) {
      return new Response(JSON.stringify({
        success: true,
        responseObject: { balances: [
          balanceRow(caA, '11', 'position-a'),
          balanceRow(caB, '22', 'position-b'),
        ] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      success: true,
      responseObject: { swaps: [
        swapRow(caA, tsA + 50, 'position-a', 25),
        swapRow(caB, tsB + 50, 'position-b', 31),
      ] },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    kickFomoPositions(user.id, user.handle, 'batch-buy-a', user.user_id ?? undefined);
    kickFomoPositions(user.id, user.handle, 'batch-buy-b', user.user_id ?? undefined);
    await fomoHoldingsIdle();
    assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1);
    assert.equal(paths.filter((path) => path.includes('/swaps?')).length, 1);
    assert.equal(paths.some((path) => path.includes('/v2/users/stable-fomo-id/balances')), true);
    assert.equal(getDb().prepare('SELECT trade_usd FROM fomo_trades WHERE event_id = ?').get('batch-buy-a')?.trade_usd, 25);
    assert.equal(getDb().prepare('SELECT trade_usd FROM fomo_trades WHERE event_id = ?').get('batch-buy-b')?.trade_usd, 31);
    assert.equal(getDb().prepare('SELECT amount FROM fomo_positions WHERE fomo_user_id = ? AND ca = ?').get(user.id, caA)?.amount, 11);
    assert.equal(getDb().prepare('SELECT amount FROM fomo_positions WHERE fomo_user_id = ? AND ca = ?').get(user.id, caB)?.amount, 22);
    assert.deepEqual(
      getDb().prepare('SELECT amount, status FROM fomo_positions WHERE fomo_user_id = ? AND ca = ?').get(user.id, caC),
      { amount: 0, status: 'closed' },
      'a previously tracked CA omitted from the complete positions page is recorded as no current holding',
    );
    assert.equal(getDb().prepare('SELECT 1 FROM fomo_positions WHERE fomo_user_id = ? AND ca = ?').get(user.id, unrelatedCa), undefined);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});
test('FOMO unavailable positions preserves last good amount and persists alert-trigger backoff', async () => {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  const user = insertFomoUser({ handle: 'positions-unavailable', name: 'Positions unavailable' });
  const ca = 'FOMO-UNAVAILABLE-CA';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
  const previousFetchedAt = Date.now() - 10_000;
  upsertFomoPosition({
    fomo_user_id: user.id,
    ca,
    chain: 'sol',
    trade_id: 'last-good',
    status: 'open',
    amount: 44,
    cost_basis_usd: 10,
    avg_entry_price: 0.2,
    price_usd: 0.3,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 1,
    fetched_at: previousFetchedAt,
  });
  config.fomoProdUrl = 'https://fomo.test';
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith('/health')) return fomoHealthResponse();
    return new Response(JSON.stringify({
      success: true,
      responseObject: { balances: [], available: false },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    kickFomoPositions(user.id, user.handle);
    await fomoHoldingsIdle();
    const row = getDb().prepare(
      'SELECT amount, fetched_at FROM fomo_positions WHERE fomo_user_id = ? AND ca = ? AND chain = ?',
    ).get(user.id, ca, 'sol') as { amount: number; fetched_at: number };
    assert.deepEqual(row, { amount: 44, fetched_at: previousFetchedAt });
    assert.equal(getDb().prepare('SELECT 1 FROM fomo_position_snapshots WHERE fomo_user_id = ?').get(user.id), undefined);
    const requestState = getDb().prepare(
      'SELECT last_outcome, consecutive_failures, next_eligible_at FROM fomo_api_request_state WHERE fomo_user_id = ? AND endpoint = ?',
    ).get(user.id, 'balances') as { last_outcome: string; consecutive_failures: number; next_eligible_at: number };
    assert.equal(requestState.last_outcome, 'no_data');
    assert.equal(requestState.consecutive_failures, 0);
    assert.ok(requestState.next_eligible_at > Date.now());
    kickFomoPositions(user.id, user.handle);
    await fomoHoldingsIdle();
    assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});
test('FOMO transient failures persist Retry-After backoff between alerts', async () => {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  const user = insertFomoUser({ handle: 'positions-retry-after', name: 'Retry after' });
  config.fomoProdUrl = 'https://fomo-retry-after.test';
  let paidAttempts = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/health')) return fomoHealthResponse();
    paidAttempts++;
    return new Response('temporarily unavailable', {
      status: 503,
      headers: { 'retry-after': '120' },
    });
  }) as typeof fetch;
  try {
    const startedAt = Date.now();
    kickFomoPositions(user.id, user.handle);
    await fomoHoldingsIdle();
    const state = getDb().prepare(
      'SELECT last_outcome, consecutive_failures, next_eligible_at FROM fomo_api_request_state WHERE fomo_user_id = ? AND endpoint = ?',
    ).get(user.id, 'balances') as { last_outcome: string; consecutive_failures: number; next_eligible_at: number };
    assert.equal(state.last_outcome, 'http_error');
    assert.equal(state.consecutive_failures, 1);
    assert.ok(state.next_eligible_at >= startedAt + 120_000);
    kickFomoPositions(user.id, user.handle);
    await fomoHoldingsIdle();
    assert.equal(paidAttempts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});
test('FOMO alert in cooldown resolves BUY immediately and gets one trailing positions refresh', async () => {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  const user = insertFomoUser({ handle: 'positions-cooldown', name: 'Positions cooldown' });
  const ca = 'FOMO-COOLDOWN-CA';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
  config.fomoProdUrl = 'https://fomo.test';
  const paths: string[] = [];
  let positionCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith('/health')) return fomoHealthResponse();
    if (path.endsWith('/balances')) {
      positionCalls++;
      return new Response(JSON.stringify({
        success: true,
        responseObject: { balances: [
          balanceRow(ca, String(positionCalls), positionCalls === 1 ? 'old-position-id' : 'new-position-id'),
        ] },
      }), { status: 200 });
    }
    const ts = getDb().prepare('SELECT ts FROM fomo_trades WHERE event_id = ?').get('cooldown-buy')?.ts as number;
    return new Response(JSON.stringify({
      success: true,
      responseObject: { swaps: [swapRow(ca, ts + 50, 'new-position-id', 42)] },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    kickFomoPositions(user.id, user.handle);
    await fomoHoldingsIdle();
    getDb().prepare('UPDATE fomo_position_snapshots SET checked_at = ? WHERE fomo_user_id = ?')
      .run(Date.now() - 50_000, user.id);
    const previousCheckedAt = getDb().prepare('SELECT checked_at FROM fomo_position_snapshots WHERE fomo_user_id = ?').get(user.id)?.checked_at as number;
    const ts = Date.now();
    insertFomoTrade({ fomo_user_id: user.id, event_id: 'cooldown-buy', ca, chain: 'sol', type: 'buy', ts });
    kickFomoPositions(user.id, user.handle, 'cooldown-buy');
    await fomoHoldingsIdle();
    assert.equal(positionCalls, 1, 'the in-cooldown alert does not spend a positions request immediately');
    assert.equal(paths.filter((path) => path.includes('/swaps?')).length, 1);
    assert.equal(getDb().prepare('SELECT trade_usd FROM fomo_trades WHERE event_id = ?').get('cooldown-buy')?.trade_usd, 42);

    await fomoPositionCooldownRefreshIdle();
    assert.equal(positionCalls, 2, 'one trailing request runs after cooldown even with no later alerts');
    assert.equal(getDb().prepare('SELECT amount FROM fomo_positions WHERE fomo_user_id = ? AND ca = ?').get(user.id, ca)?.amount, 2);
    assert.ok((getDb().prepare('SELECT checked_at FROM fomo_position_snapshots WHERE fomo_user_id = ?').get(user.id)?.checked_at as number) > previousCheckedAt);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});
test('FOMO alert batches for other users proceed while one user is blocked', async () => {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  const blockedUser = insertFomoUser({ handle: 'blocked-user', name: 'Blocked user' });
  const freeUser = insertFomoUser({ handle: 'free-user', name: 'Free user' });
  const ca = 'FOMO-FREE-USER';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'test' });
  insertFomoTrade({ fomo_user_id: freeUser.id, event_id: 'free-user-buy', ca, chain: 'sol', type: 'buy', ts: Date.now() });
  config.fomoProdUrl = 'https://fomo.test';
  let unblockFetch!: (response: Response) => void;
  const blockedResponse = new Promise<Response>((resolve) => { unblockFetch = resolve; });
  let notifyBlockedFetch!: () => void;
  const blockedFetchStarted = new Promise<void>((resolve) => { notifyBlockedFetch = resolve; });
  let notifyFreeSwaps!: () => void;
  const freeSwapsStarted = new Promise<void>((resolve) => { notifyFreeSwaps = resolve; });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith('/health')) return fomoHealthResponse();
    if (path.includes('/blocked-user/balances')) {
      notifyBlockedFetch();
      return blockedResponse;
    }
    if (path.includes('/free-user/balances')) {
      return new Response(JSON.stringify({ success: true, responseObject: { balances: [] } }), { status: 200 });
    }
    if (path.includes('/free-user/swaps')) {
      notifyFreeSwaps();
      return new Response(JSON.stringify({ success: true, responseObject: { swaps: [] } }), { status: 200 });
    }
    throw new Error(`unexpected FOMO endpoint ${path}`);
  }) as typeof fetch;
  let idle: Promise<void> | undefined;
  try {
    kickFomoPositions(blockedUser.id, blockedUser.handle);
    kickFomoPositions(freeUser.id, freeUser.handle, 'free-user-buy');
    idle = fomoHoldingsIdle();
    await blockedFetchStarted;
    // Exercise the real five-second batch timer; this clock timeout only bounds a failed isolation assertion.
    const unrelatedStarted = await Promise.race([
      freeSwapsStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(unrelatedStarted, true, 'one slow user must not serialize another user batch');
  } finally {
    unblockFetch(new Response(JSON.stringify({ success: true, responseObject: { balances: [] } }), { status: 200 }));
    if (idle !== undefined) await idle;
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});
