import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getDb, insertFomoUser, insertTrackedCa, open } from '../src/db.js';
import { enqueueFomoDiscovery, enqueueAllFomoDiscoveries, fomoDiscoveryIdle, fomoDiscoverySweep, stopFomoDiscovery } from '../src/fomo-balance-discovery.js';

const CA = '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx';
const oldFetch = globalThis.fetch;
const oldUrl = config.fomoProdUrl;

beforeEach(() => {
  open(':memory:');
  config.fomoProdUrl = 'https://fomo-discovery.test';
  insertTrackedCa({ address: CA, chain: 'sol', note: '' });
});
afterEach(() => {
  stopFomoDiscovery();
  globalThis.fetch = oldFetch;
  config.fomoProdUrl = oldUrl;
  getDb().close();
});

function balance(amount: number) {
  return {
    tokenFilterResult: { token: { address: CA, networkId: 1399811149 }, priceUSD: '0.13' },
    userToken: { humanAmountRemaining: amount, totalCostBasisUsd: 12 },
  };
}
function respond(rows: unknown[], status = 200) {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('{"ok":true}');
    assert.ok(url.endsWith('/balances'));
    return new Response(JSON.stringify({ success: true, responseObject: { balances: rows } }), { status });
  }) as typeof fetch;
}

test('discovers a no-trade user and suppresses completed refreshes until cooldown', async () => {
  const user = insertFomoUser({ handle: 'quiet', user_id: 'stable-quiet' });
  respond([balance(8)]);
  enqueueFomoDiscovery(user);
  await fomoDiscoveryIdle();
  const row = getDb().prepare('SELECT amount FROM fomo_api_holdings WHERE fomo_user_id = ? AND ca = ?').get(user.id, CA) as { amount: number };
  assert.equal(row.amount, 8);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades WHERE fomo_user_id = ?').get(user.id) &&
    (getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades WHERE fomo_user_id = ?').get(user.id) as { n: number }).n, 0);
  await fomoDiscoverySweep();
  assert.equal((getDb().prepare('SELECT amount FROM fomo_api_holdings WHERE fomo_user_id = ? AND ca = ?').get(user.id, CA) as { amount: number }).amount, 8);
});

test('wallet-list refresh queues every FOMO user but retains upstream cooldown', async () => {
  const user = insertFomoUser({ handle: 'cooldown', user_id: 'stable-cooldown' });
  let balanceCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('{"ok":true}');
    balanceCalls++;
    return new Response(JSON.stringify({ success: true, responseObject: { balances: [balance(6)] } }));
  }) as typeof fetch;
  enqueueFomoDiscovery(user);
  await fomoDiscoveryIdle();
  assert.equal(balanceCalls, 1);
  assert.equal(enqueueAllFomoDiscoveries(), 1);
  const queued = getDb().prepare("SELECT last_outcome,next_eligible_at FROM fomo_api_request_state WHERE fomo_user_id=? AND endpoint='balances'")
    .get(user.id) as {last_outcome:string;next_eligible_at:number};
  assert.equal(queued.last_outcome, 'discovery_queued');
  assert.ok(queued.next_eligible_at > Date.now());
  await fomoDiscoverySweep();
  assert.equal(balanceCalls, 1);
});
test('requeue during an inflight cooldown response stays queued without bypassing retry-after', async () => {
  const user = insertFomoUser({ handle: 'inflight', user_id: 'stable-inflight' });
  let release!: (response: Response) => void;
  let balanceCalls = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith('/health')) return new Response('{"ok":true}');
    balanceCalls++;
    const { promise, resolve } = Promise.withResolvers<Response>();
    release = resolve;
    return promise;
  }) as typeof fetch;
  enqueueFomoDiscovery(user);
  const sweep = fomoDiscoverySweep();
  while (balanceCalls === 0) await Promise.resolve();
  enqueueFomoDiscovery(user, true);
  release(new Response('{"success":false}', { status: 429, headers: { 'retry-after': '120' } }));
  await sweep;
  const state = getDb().prepare("SELECT last_outcome,next_eligible_at FROM fomo_api_request_state WHERE fomo_user_id=? AND endpoint='balances'")
    .get(user.id) as { last_outcome: string; next_eligible_at: number };
  assert.equal(state.last_outcome, 'discovery_queued');
  assert.ok(state.next_eligible_at >= Date.now() + 119_000);
  await fomoDiscoverySweep();
  assert.equal(balanceCalls, 1);
});


test('failed or unavailable balances preserve prior measurement and durable retry', async () => {
  const user = insertFomoUser({ handle: 'retry', user_id: 'stable-retry' });
  getDb().prepare(`INSERT INTO fomo_api_holdings (fomo_user_id, ca, chain, amount, captured_at) VALUES (?, ?, 'sol', 17, ?)`)
    .run(user.id, CA, Date.now() - 10_000);
  respond([], 503);
  enqueueFomoDiscovery(user);
  await fomoDiscoverySweep();
  assert.equal((getDb().prepare('SELECT amount FROM fomo_api_holdings WHERE fomo_user_id = ? AND ca = ?').get(user.id, CA) as { amount: number }).amount, 17);
  const state = getDb().prepare("SELECT last_outcome, next_eligible_at FROM fomo_api_request_state WHERE fomo_user_id = ? AND endpoint = 'balances'")
    .get(user.id) as { last_outcome: string; next_eligible_at: number };
  assert.notEqual(state.last_outcome, 'discovery_running');
  assert.ok(state.next_eligible_at > Date.now());
  respond([balance(99)]);
  await fomoDiscoverySweep();
  assert.equal((getDb().prepare('SELECT amount FROM fomo_api_holdings WHERE fomo_user_id = ? AND ca = ?').get(user.id, CA) as { amount: number }).amount, 17);
});

test('rejects an inflight response after the stored user identity changes', async () => {
  const user = insertFomoUser({ handle: 'before', user_id: 'stable-before' });
  respond([balance(33)]);
  enqueueFomoDiscovery(user);
  const sweep = fomoDiscoverySweep();
  getDb().prepare('UPDATE fomo_users SET user_id = ? WHERE id = ?').run('changed-id', user.id);
  await sweep;
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fomo_api_holdings WHERE fomo_user_id = ?').get(user.id) &&
    (getDb().prepare('SELECT COUNT(*) AS n FROM fomo_api_holdings WHERE fomo_user_id = ?').get(user.id) as { n: number }).n, 0);
});
