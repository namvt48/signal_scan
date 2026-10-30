import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getDb, insertFomoTrade, insertFomoUser, insertTrackedCa, open, upsertFomoApiBalanceSnapshot, upsertFomoApiHolding } from '../src/db.js';
import { fomoUserStats, fomoUserStatsByCa } from '../src/signals.js';
import { fomoBalanceRefillSweep } from '../src/poller.js';

const CA = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const oldFetch = globalThis.fetch;
const oldUrl = config.fomoProdUrl;

beforeEach(() => {
  open(':memory:');
  config.fomoProdUrl = 'https://fomo-refill.test';
  getDb().prepare('INSERT INTO token_state (ca, chain, price, market_cap, fetched_at) VALUES (?, ?, ?, ?, ?)')
    .run(CA, 'sol', 0.13, 1e8, Date.now());
});
afterEach(() => {
  globalThis.fetch = oldFetch;
  config.fomoProdUrl = oldUrl;
  getDb().close();
});

function staleUser(handle = 'ogle') {
  const user = insertFomoUser({ handle, user_id: `stable-${handle}` });
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
  getDb().prepare(`INSERT INTO fomo_positions
    (fomo_user_id, ca, chain, amount, cost_basis_usd, status, fetched_at)
    VALUES (?, ?, 'sol', 0, 594193.6, 'closed', ?)`)
    .run(user.id, CA, Date.now() - 9 * 86_400_000);
  return user;
}

function balance(ca = CA, amount = 1728331.16) {
  return {
    tokenFilterResult: { token: { address: ca, networkId: 1399811149 }, priceUSD: '0.13' },
    userToken: { humanAmountRemaining: amount, totalCostBasisUsd: 594199.96 },
  };
}

function serve(rows: unknown[], paths: string[], status = 200) {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    paths.push(url);
    if (url.endsWith('/health')) return new Response('{"ok":true}');
    assert.ok(url.endsWith('/balances'), `refill must not fetch swaps or trade detail: ${url}`);
    return new Response(JSON.stringify({ success: true, responseObject: { balances: rows } }), { status });
  }) as typeof fetch;
}

test('refill restores a long-held balance without a new trade and preserves 24h metrics', async () => {
  const user = staleUser();
  insertFomoTrade({ fomo_user_id: user.id, event_id: 'old-buy', ca: CA, chain: 'sol', type: 'buy', trade_usd: 42, ts: Date.now() - 3 * 86_400_000 });
  const before = getDb().prepare('SELECT * FROM fomo_trades').all();
  const metricsBefore = fomoUserStats(CA, 'sol', Date.now())[0];
  const paths: string[] = [];
  serve([balance()], paths);
  await fomoBalanceRefillSweep();
  const measured = fomoUserStats(CA, 'sol', Date.now())[0];
  assert.equal(measured?.holdingAmount, 1728331.16);
  assert.ok(Math.abs((measured?.balUsd ?? 0) - 1728331.16 * 0.13) < 0.001);
  assert.deepEqual(getDb().prepare('SELECT * FROM fomo_trades').all(), before);
  for (const field of ['buyUsd', 'sellUsd', 'buys', 'sells', 'trades', 'lastTs'] as const) {
    assert.equal(measured?.[field], metricsBefore?.[field], `${field} must not be backfilled`);
  }
  assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1);
  assert.ok(paths.some((path) => path.endsWith('/v2/users/stable-ogle/balances')));
  await fomoBalanceRefillSweep();
  assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1, 'successful user is not immediately refetched');
});
test('refill uses the existing handle fallback for users without a stable user ID', async () => {
  const user = staleUser();
  getDb().prepare('UPDATE fomo_users SET user_id = NULL WHERE id = ?').run(user.id);
  const paths: string[] = [];
  serve([balance()], paths);
  await fomoBalanceRefillSweep();
  assert.ok(paths.some((path) => path.endsWith('/v2/users/ogle/balances')));
  assert.equal(fomoUserStats(CA, 'sol', Date.now())[0]?.holdingAmount, 1728331.16);
});


test('omitted positions remain unknown without trade-detail requests or repeated immediate refills', async () => {
  staleUser();
  const paths: string[] = [];
  serve([], paths);
  await fomoBalanceRefillSweep();
  assert.equal(fomoUserStats(CA, 'sol', Date.now())[0]?.holdingAmount, undefined);
  await fomoBalanceRefillSweep();
  assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1);
});

test('refill accepts an explicitly measured zero and does not replace it with an old positive holding', async () => {
  const user = staleUser();
  getDb().prepare('INSERT INTO fomo_holdings (fomo_user_id, ca, chain, wallet, amount, measured_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, CA, 'sol', 'old-wallet', 99, Date.now() - 2 * 86_400_000);
  const paths: string[] = [];
  serve([balance(CA, 0)], paths);
  await fomoBalanceRefillSweep();
  assert.equal(fomoUserStats(CA, 'sol', Date.now())[0]?.balUsd, 0);
});

test('concurrent refill sweeps request one balance page per user', async () => {
  staleUser();
  const paths: string[] = [];
  serve([balance()], paths);
  await Promise.all([fomoBalanceRefillSweep(), fomoBalanceRefillSweep()]);
  assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1);
  assert.equal(fomoUserStats(CA, 'sol', Date.now())[0]?.holdingAmount, 1728331.16);
});

test('rate-limited refill preserves unknown balance and respects persisted retry time', async () => {
  const user = staleUser();
  const paths: string[] = [];
  serve([], paths, 429);
  await fomoBalanceRefillSweep();
  assert.equal(fomoUserStats(CA, 'sol', Date.now())[0]?.holdingAmount, undefined);
  const state = getDb().prepare("SELECT next_eligible_at, last_outcome FROM fomo_api_request_state WHERE fomo_user_id = ? AND endpoint = 'balances'")
    .get(user.id) as { next_eligible_at: number; last_outcome: string };
  assert.equal(state.last_outcome, 'rate_limited');
  assert.ok(state.next_eligible_at > Date.now());
  await fomoBalanceRefillSweep();
  assert.equal(paths.filter((path) => path.endsWith('/balances')).length, 1);
});

test('positive FOMO balance snapshot creates dashboard membership without trade or position', () => {
  const user = insertFomoUser({ handle: 'legacy-holder', user_id: 'legacy-holder-id' });
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
  const capturedAt = Date.now();
  upsertFomoApiHolding({
    fomo_user_id: user.id,
    ca: CA,
    chain: 'sol',
    amount: 77,
    pct: null,
    captured_at: capturedAt,
  });
  upsertFomoApiBalanceSnapshot({
    fomo_user_id: user.id,
    checked_at: capturedAt,
    captured_at: capturedAt,
    complete: 1,
    truncated: 0,
    available: 1,
  });

  const member = fomoUserStats(CA, 'sol', Date.now()).find((row) => row.handle === user.handle);
  assert.equal(member?.holdingAmount, 77);
  assert.equal(member?.buys, 0);
  assert.equal(member?.sells, 0);
  assert.equal(member?.trades, 0);
  const batchMember = fomoUserStatsByCa(Date.now()).get(`sol:${CA}`)?.find((row) => row.handle === user.handle);
  assert.equal(batchMember?.holdingAmount, 77);
  assert.equal(batchMember?.buys, 0);
  assert.equal(batchMember?.trades, 0);
});
