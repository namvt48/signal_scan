import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getDb, findTrackedCa, insertFomoUser, listTrackedCas, open } from '../src/db.js';
import { createApp } from '../src/api.js';
import { createTestAuth, TEST_SERVICE_TOKEN, type TestAuth } from './auth-testkit.js';

// AUTH CONTRACT v1: this is the daemon's own route — the service token (via
// createApp deps; static imports snapshot config before env in the body could apply).
const JSON_HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${TEST_SERVICE_TOKEN}` };
const HANDLE = 'fomo-trader-1';
const USER_ID = 'fomo-uid-1';
const CA = 'FomoCaSource001';
const BUY_CA = 'FomoBuyNewCa001';
const SELL_CA = 'FomoSellNewCa001';

let auth: TestAuth;
let server: Server;
let base = '';
let fomoUserId = '';
let handleOnlyId = '';
let uidFirstId = '';

async function post(body: unknown, token: string | null = TEST_SERVICE_TOKEN): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/fomo-watch/trades`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-fomo-1',
    trader: HANDLE,
    userId: USER_ID,
    type: 'buy',
    tokenAddress: CA,
    chain: 'sol',
    ts: 1_758_000_000_000,
    usdValue: 2985,
    price: 0.002,
    token: 'STOCKER',
    ...overrides,
  };
}

function rowCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM fomo_trades').get() as { n: number }).n;
}

function rowOf(eventId: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM fomo_trades WHERE event_id = ?').get(eventId) as
    | Record<string, unknown>
    | undefined;
}

before(async () => {
  open(':memory:');
  fomoUserId = insertFomoUser({ handle: HANDLE, user_id: USER_ID, name: 'Fomo One' }).id;
  handleOnlyId = insertFomoUser({ handle: 'handle-only', name: 'Handle Only' }).id;
  uidFirstId = insertFomoUser({ handle: 'uid-first', user_id: 'fomo-uid-2', name: 'UID First' }).id;
  auth = await createTestAuth();
  server = createApp('test', auth.deps).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('POST /api/fomo-watch/trades: a valid body creates exactly one row with the right fields', async () => {
  const res = await post(trade());
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);
  assert.equal(rowCount(), 1);

  const row = rowOf('evt-fomo-1');
  assert.equal(row?.fomo_user_id, fomoUserId);
  assert.equal(row?.ca, CA);
  assert.equal(row?.chain, 'sol');
  assert.equal(row?.type, 'buy');
  assert.equal(row?.ts, 1_758_000_000_000);
  assert.equal(row?.usd_value, 2985);
  assert.equal(row?.price, 0.002);
  assert.equal(row?.token, 'STOCKER');
  assert.equal(row?.source, 'fomo');
});

test('POST /api/fomo-watch/trades: reposting the SAME eventId is a 200 no-op', async () => {
  const res = await post(trade());
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 0);
  assert.equal(rowCount(), 1);
});

test('POST /api/fomo-watch/trades: unknown handle/userId is 404 and inserts nothing', async () => {
  const res = await post(trade({ eventId: 'evt-fomo-404', trader: 'not-tracked', userId: 'not-tracked-id' }));
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'fomo user not tracked' });
  assert.equal(rowOf('evt-fomo-404'), undefined);
  assert.equal(rowCount(), 1);
});

test('POST /api/fomo-watch/trades: userId wins over trader; handle-only falls back to trader', async () => {
  // Same body carries trader of user A but userId of user B → B's row.
  const byUid = await post(trade({ eventId: 'evt-fomo-uid', trader: HANDLE, userId: 'fomo-uid-2' }));
  assert.equal(byUid.status, 200);
  assert.equal(rowOf('evt-fomo-uid')?.fomo_user_id, uidFirstId);

  const body = trade({ eventId: 'evt-fomo-handle', trader: 'handle-only' });
  delete body.userId;
  const byHandle = await post(body);
  assert.equal(byHandle.status, 200);
  assert.equal(rowOf('evt-fomo-handle')?.fomo_user_id, handleOnlyId);
});

test('POST /api/fomo-watch/trades: 400 on a bad or unmapped chain', async () => {
  for (const chain of ['ethereum', 'doge', 123, '', undefined]) {
    const res = await post(trade({ eventId: `evt-fomo-chain-${String(chain)}`, chain }));
    assert.equal(res.status, 400, `chain ${String(chain)} must be 400`);
  }
  assert.equal(rowCount(), 3); // only the three rows inserted by earlier tests
});

test('POST /api/fomo-watch/trades: 400 on type perp/thesis and nothing is stored', async () => {
  const perp = await post(trade({ eventId: 'evt-fomo-perp', type: 'perp', tokenAddress: null }));
  assert.equal(perp.status, 400);
  assert.equal(typeof perp.json.error, 'string');
  const thesis = await post(trade({ eventId: 'evt-fomo-thesis', type: 'thesis' }));
  assert.equal(thesis.status, 400);
  assert.equal(rowOf('evt-fomo-perp'), undefined);
  assert.equal(rowOf('evt-fomo-thesis'), undefined);
  assert.equal(rowCount(), 3);
});

test('POST /api/fomo-watch/trades: 400 on a missing/empty eventId or identity', async () => {
  const noId = trade({ eventId: undefined });
  assert.equal((await post(noId)).status, 400);
  assert.equal((await post(trade({ eventId: '   ' }))).status, 400);
  const noIdentity = trade({ eventId: 'evt-fomo-noid', trader: '', userId: undefined });
  assert.equal((await post(noIdentity)).status, 400);
  assert.equal(rowCount(), 3);
});

test('POST /api/fomo-watch/trades: usdValue/price optional → NULL; a negative sell PnL is legal', async () => {
  const body = trade({ eventId: 'evt-fomo-null', type: 'sell' });
  delete body.usdValue;
  delete body.price;
  const res = await post(body);
  assert.equal(res.status, 200);
  const row = rowOf('evt-fomo-null');
  assert.equal(row?.usd_value, null);
  assert.equal(row?.price, null);

  const loss = await post(trade({ eventId: 'evt-fomo-loss', type: 'sell', usdValue: -120.5 }));
  assert.equal(loss.status, 200);
  assert.equal(rowOf('evt-fomo-loss')?.usd_value, -120.5);
});

test('POST /api/fomo-watch/trades: ca is canonicalized (EVM folded, sol verbatim)', async () => {
  const res = await post(
    trade({ eventId: 'evt-fomo-evm', chain: 'base', tokenAddress: '0xABCdef1234567890AbCdEf1234567890ABCdEF12' }),
  );
  assert.equal(res.status, 200);
  assert.equal(rowOf('evt-fomo-evm')?.ca, '0xabcdef1234567890abcdef1234567890abcdef12');
  assert.equal(rowOf('evt-fomo-1')?.ca, CA); // sol base58 is case-sensitive — never folded
});

test('POST /api/fomo-watch/trades: 401 without a token, 403 for a viewer', async () => {
  const anon = await post(trade({ eventId: 'evt-fomo-anon' }), null);
  assert.equal(anon.status, 401);
  assert.deepEqual(anon.json, { error: 'unauthorized' });

  const viewer = await post(trade({ eventId: 'evt-fomo-viewer' }), await auth.signToken(auth.viewerEmail));
  assert.equal(viewer.status, 403);
  assert.deepEqual(viewer.json, { error: 'forbidden' });

  assert.equal(rowOf('evt-fomo-anon'), undefined);
  assert.equal(rowOf('evt-fomo-viewer'), undefined);
});

test('POST /api/fomo-watch/trades: a BUY enqueues the CA into tracked_cas exactly once', async () => {
  const res = await post(trade({ eventId: 'evt-fomo-buy-new', tokenAddress: BUY_CA }));
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);

  const tracked = findTrackedCa(BUY_CA, 'sol');
  assert.equal(tracked?.note, 'fomo');
  assert.equal(tracked?.status, 'queued');
  assert.equal(tracked?.entry_usd, 2985);
  assert.equal(listTrackedCas().filter((r) => r.address === BUY_CA && r.chain === 'sol').length, 1);
});

test('POST /api/fomo-watch/trades: a repeat BUY (same eventId) adds no second tracked_cas row', async () => {
  const res = await post(trade({ eventId: 'evt-fomo-buy-new', tokenAddress: BUY_CA }));
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 0);
  assert.equal(listTrackedCas().filter((r) => r.address === BUY_CA && r.chain === 'sol').length, 1);
});

test('POST /api/fomo-watch/trades: a SELL of an untracked CA adds no tracked_cas row', async () => {
  const res = await post(trade({ eventId: 'evt-fomo-sell-new', type: 'sell', tokenAddress: SELL_CA }));
  assert.equal(res.status, 200);
  assert.equal(findTrackedCa(SELL_CA, 'sol'), undefined);
  assert.equal(listTrackedCas().some((r) => r.address === SELL_CA && r.chain === 'sol'), false);
});
