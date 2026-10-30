import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { findTrackedCa, getAlertMetricObservations, getDb, insertTrackedCa, insertWallet, open, setSetting } from '../src/db.js';
import { insertTrades } from '../src/ingest.js';
import { createApp } from '../src/api.js';
import type { WalletActivity } from '../src/providers/provider.js';
import { setPollerDeps } from '../src/poller.js';
import { serializeWalletHoldings } from '../src/wallet-holdings-discovery.js';

// AUTH CONTRACT v1: this is the daemon's own route — the service token (via
// createApp deps; static imports snapshot config before env in the body could apply).
const SERVICE_TOKEN = 'wallet-watch-trade-service-token';
const JSON_HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` };
const WALLET = 'watch-wallet-addr-1';
const CA = 'watchCa-source-001';
const RECENT_TRADE_TS = Date.now();

let server: Server;
let base = '';
let walletId = '';
let baseWalletId = '';

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/wallet-watch/trades`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function trade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { wallet: WALLET, ca: CA, tx: 'sig-watch-1', ts: RECENT_TRADE_TS, amountUsd: 250, price: 0.002, provenance: 'live', ...overrides };
}

function sourceOf(tx: string): string | undefined {
  const row = getDb().prepare('SELECT source FROM wallet_trades WHERE tx = ?').get(tx) as
    | { source: string }
    | undefined;
  return row?.source;
}

function tradeRowOf(tx: string): { wallet_id: string; chain: string } | undefined {
  return getDb().prepare('SELECT wallet_id, chain FROM wallet_trades WHERE tx = ?').get(tx) as
    | { wallet_id: string; chain: string }
    | undefined;
}

before(async () => {
  open(':memory:');
  setSetting('systemDeployAt', '1700000000000');
  walletId = insertWallet({ address: WALLET, name: 'CTW', tags: [], chain: 'sol', source: 'test' }).id;
  // T4: the SAME address on another chain is a distinct wallet — resolution by
  // (address, chain) must never cross them.
  baseWalletId = insertWallet({ address: WALLET, name: 'CTW-base', tags: [], chain: 'base', source: 'test' }).id;
  server = createApp('test', { serviceToken: SERVICE_TOKEN }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('POST /api/wallet-watch/trades: stores the detected buy with source=watch', async () => {
  const res = await post(trade());
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);

  const row = getDb()
    .prepare('SELECT wallet_id, ca, ts, side, amount_usd, price, source FROM wallet_trades WHERE tx = ?')
    .get('sig-watch-1') as Record<string, unknown>;
  assert.equal(row.wallet_id, walletId);
  assert.equal(row.ca, CA);
  assert.equal(row.ts, RECENT_TRADE_TS);
  assert.equal(row.side, 'buy');
  assert.equal(row.amount_usd, 250);
  assert.equal(row.price, 0.002);
  assert.equal(row.source, 'watch');
  const observations = getAlertMetricObservations(0, 10);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.metric, 'trackerBuy');
  assert.equal(observations[0]?.value, 250);
  assert.equal(observations[0]?.responseAt, RECENT_TRADE_TS);
  assert.deepEqual(observations[0]?.snapshot.trackerBuyer, { name: 'CTW', address: WALLET });
});

test('POST /api/wallet-watch/trades: a repost is a no-op (UNIQUE wallet+ca+tx+side)', async () => {
  const res = await post(trade());
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 0);
  assert.equal(getAlertMetricObservations(0, 10).length, 1, 'a replay cannot append a second BUY observation');
});

test('POST /api/wallet-watch/trades: unpriced buy still lands (amountUsd/price optional)', async () => {
  const body = trade({ tx: 'sig-watch-nopx', ts: 1_758_000_005_000 });
  delete body.amountUsd;
  delete body.price;
  const res = await post(body);
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);
  assert.equal(sourceOf('sig-watch-nopx'), 'watch');
  assert.equal(getAlertMetricObservations(0, 10).some((row) => row.responseAt === body.ts), false);
});

test('POST /api/wallet-watch/trades: 404 for an address that is not a tracked wallet', async () => {
  const res = await post(trade({ wallet: 'not-a-tracked-wallet' }));
  assert.equal(res.status, 404);
  assert.equal(sourceOf('sig-watch-1'), 'watch'); // nothing written by the 404
});

test('POST /api/wallet-watch/trades: 400 on a malformed body', async () => {
  assert.equal((await post(trade({ tx: '' }))).status, 400);
  assert.equal((await post(trade({ ts: 0 }))).status, 400);
  assert.equal((await post(trade({ ts: 'yesterday' }))).status, 400);
  assert.equal((await post(trade({ ca: undefined }))).status, 400);
  assert.equal((await post(trade({ price: -1 }))).status, 400);
});

test('POST /api/wallet-watch/trades: provenance is required and future timestamps are rejected', async () => {
  const missing = trade();
  delete missing.provenance;
  assert.equal((await post(missing)).status, 400);
  assert.equal((await post(trade({ provenance: 'bootstrap' }))).status, 400);
  assert.equal((await post(trade({ ts: Date.now() + 60_000 }))).status, 400);
});

test('POST /api/wallet-watch/trades: side=sell lands as a trade row, side=transfer never does', async () => {
  const sell = await post(trade({ tx: 'sig-watch-sell', ts: 1_758_000_003_000, side: 'sell' }));
  assert.equal(sell.status, 200);
  assert.equal(sell.json.inserted, 1);
  const row = getDb().prepare('SELECT side, source FROM wallet_trades WHERE tx = ?').get('sig-watch-sell') as Record<
    string,
    unknown
  >;
  assert.equal(row.side, 'sell');
  assert.equal(row.source, 'watch');

  // A transfer is not a trade: the row must NOT exist, only the balance refresh ran.
  const xfer = await post(trade({ tx: 'sig-watch-xfer', ts: 1_758_000_004_000, side: 'transfer' }));
  assert.equal(xfer.status, 200);
  assert.equal(xfer.json.inserted, 0);
  assert.equal(sourceOf('sig-watch-xfer'), undefined);
  const observations = getAlertMetricObservations(0, 10);
  assert.equal(observations.some((event) => event.responseAt === 1_758_000_003_000), false);
  assert.equal(observations.some((event) => event.responseAt === 1_758_000_004_000), false);
});

test('POST /api/wallet-watch/trades: 400 on an unknown side', async () => {
  assert.equal((await post(trade({ side: 'mint' }))).status, 400);
});

test('insertTrades: the watcher repost upgrades a wp4t row to source=watch (one row, both detectors)', () => {
  const act: WalletActivity = { tx: 'sig-both', ts: 1_758_000_100_000, side: 'buy', ca: CA, chain: 'sol', amountUsd: 10, price: 0.001 };
  assert.equal(insertTrades(walletId, [act], 'nansen'), 1);
  assert.equal(sourceOf('sig-both'), 'nansen');
  // Same on-chain trade seen by the RPC detector: provenance moves to 'watch'
  // (what `Tracked by` reads) instead of the INSERT being ignored.
  assert.equal(insertTrades(walletId, [act], 'watch'), 1);
  assert.equal(sourceOf('sig-both'), 'watch');
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM wallet_trades WHERE tx = ?').get('sig-both') as { n: number };
  assert.equal(count.n, 1);
});

test('POST /api/wallet-watch/trades: chain=base resolves the base wallet and stores chain=base', async () => {
  const res = await post(trade({ tx: 'sig-watch-base', chain: 'base' }));
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);
  const row = tradeRowOf('sig-watch-base');
  assert.equal(row?.chain, 'base');
  assert.equal(row?.wallet_id, baseWalletId);
});

test('POST /api/wallet-watch/trades: absent chain defaults to sol (deployed-daemon compat)', async () => {
  const res = await post(trade({ tx: 'sig-watch-nochain' }));
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);
  const row = tradeRowOf('sig-watch-nochain');
  assert.equal(row?.chain, 'sol');
  assert.equal(row?.wallet_id, walletId);
});

test('POST /api/wallet-watch/trades: 400 on an unknown chain', async () => {
  assert.equal((await post(trade({ chain: 'doge' }))).status, 400);
  assert.equal((await post(trade({ chain: 123 }))).status, 400);
  assert.equal((await post(trade({ chain: '' }))).status, 400);
});

test('POST /api/wallet-watch/trades: 404 when the address is only tracked on ANOTHER chain', async () => {
  const res = await post(trade({ tx: 'sig-watch-bsc', chain: 'bsc' }));
  assert.equal(res.status, 404);
  assert.equal(tradeRowOf('sig-watch-bsc'), undefined);
});
test('wallet-watch skips pre-deployment events before trade, CA, or holding work', async () => {
  const cutoff = Date.now() - 1_000;
  setSetting('systemDeployAt', String(cutoff));
  const res = await post(trade({ ca: 'watchCa-predeploy', tx: 'sig-predeploy', ts: cutoff - 1 }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { inserted: 0, skipped: 'pre-deploy' });
  assert.equal(tradeRowOf('sig-predeploy'), undefined);
  assert.equal(findTrackedCa('watchCa-predeploy', 'sol', true), undefined);
  setSetting('systemDeployAt', '1700000000000');
});
test('wallet-watch preserves stale BUY history without reactivating an inactive CA', async () => {
  const staleCa = 'watchCa-stale-buy-001';
  const tracked = insertTrackedCa({ address: staleCa, chain: 'sol', note: 'wallet-trade' });
  getDb().prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?").run(tracked.id);
  const ts = Date.now() - 48 * 60 * 60 * 1000 - 1;
  const res = await post(trade({ ca: staleCa, tx: 'sig-stale-buy', ts }));

  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);
  assert.equal(tradeRowOf('sig-stale-buy')?.wallet_id, walletId);
  assert.equal(findTrackedCa(staleCa, 'sol', true)?.status, 'inactive');
  assert.equal(findTrackedCa(staleCa, 'sol'), undefined);
});

test('historical wallet BUYs preserve history without adding or reactivating CAs', async () => {
  const inactive = 'watchCa-historical-inactive';
  const existing = insertTrackedCa({ address: inactive, chain: 'sol', note: 'manual' });
  getDb().prepare("UPDATE tracked_cas SET status = 'inactive' WHERE id = ?").run(existing.id);
  for (const ca of ['watchCa-historical-new', inactive]) {
    const response = await post(trade({
      ca, tx: `history:${ca}`, provenance: 'historical', ts: 1_600_000_000_000,
    }));
    assert.equal(response.status, 200);
    assert.equal(response.json.inserted, 1);
    assert.ok(tradeRowOf(`history:${ca}`));
    assert.equal(findTrackedCa(ca, 'sol'), undefined);
    assert.equal(getAlertMetricObservations(0, 1000).some((item) => item.ca === ca), false);
  }
  assert.equal(findTrackedCa(inactive, 'sol', true)?.status, 'inactive');
});

test('duplicate BUY cannot reactivate a CA, but a new cursor BUY can', async () => {
  const ca = 'watchCa-dedupe-reactivation';
  const original = trade({ ca, tx: 'dedupe-original', ts: Date.now() - 1_000 });
  assert.equal((await post(original)).json.inserted, 1);
  getDb().prepare("UPDATE tracked_cas SET status = 'inactive' WHERE address = ? AND chain = ?").run(ca, 'sol');
  assert.equal((await post(original)).json.inserted, 0);
  assert.equal(findTrackedCa(ca, 'sol', true)?.status, 'inactive');
  const newBuy = await post(trade({ ca, tx: 'cursor-new-buy', provenance: 'cursor', ts: Date.now() - 500 }));
  assert.equal(newBuy.json.inserted, 1);
  assert.equal(findTrackedCa(ca, 'sol')?.status, 'queued');
});

test('a transfer refreshes active-CA balance without creating a BUY or admitting a CA', async () => {
  const ca = 'watchCa-transfer-balance';
  insertTrackedCa({ address: ca, chain: 'sol', note: 'manual' });
  let reads = 0;
  setPollerDeps({
    name: 'transfer-balance-test',
    tokenInfo: async () => { throw new Error('transfer must not fetch token info'); },
    metric: async () => { throw new Error('transfer must not fetch market metrics'); },
    walletTokenHoldings: async () => { reads += 1; return [{ ca, amount: 7 }]; },
  }, null);
  const response = await post(trade({ ca, tx: 'transfer-only', side: 'transfer', ts: Date.now() - 1 }));
  assert.equal(response.status, 200);
  assert.equal(response.json.inserted, 0);
  await serializeWalletHoldings(walletId, async () => {});
  const balance = getDb().prepare('SELECT token_amount FROM wallet_token_state WHERE wallet_id=? AND ca=? AND chain=?')
    .get(walletId, ca, 'sol') as { token_amount: number };
  assert.equal(balance.token_amount, 7);
  assert.equal(reads, 1);
  assert.equal(tradeRowOf('transfer-only'), undefined);
});
