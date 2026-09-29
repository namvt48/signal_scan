import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { getDb, insertWallet, open } from '../src/db.js';
import { insertTrades } from '../src/ingest.js';
import { createApp } from '../src/api.js';
import type { WalletActivity } from '../src/providers/provider.js';

// AUTH CONTRACT v1: this is the daemon's own route — the service token (via
// createApp deps; static imports snapshot config before env in the body could apply).
const SERVICE_TOKEN = 'wallet-watch-trade-service-token';
const JSON_HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` };
const WALLET = 'watch-wallet-addr-1';
const CA = 'watchCa-source-001';

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
  return { wallet: WALLET, ca: CA, tx: 'sig-watch-1', ts: 1_758_000_000_000, amountUsd: 250, price: 0.002, ...overrides };
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
  assert.equal(row.ts, 1_758_000_000_000);
  assert.equal(row.side, 'buy');
  assert.equal(row.amount_usd, 250);
  assert.equal(row.price, 0.002);
  assert.equal(row.source, 'watch');
});

test('POST /api/wallet-watch/trades: a repost is a no-op (UNIQUE wallet+ca+tx+side)', async () => {
  const res = await post(trade());
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 0);
});

test('POST /api/wallet-watch/trades: unpriced buy still lands (amountUsd/price optional)', async () => {
  const body = trade({ tx: 'sig-watch-nopx' });
  delete body.amountUsd;
  delete body.price;
  const res = await post(body);
  assert.equal(res.status, 200);
  assert.equal(res.json.inserted, 1);
  assert.equal(sourceOf('sig-watch-nopx'), 'watch');
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

test('POST /api/wallet-watch/trades: side=sell lands as a trade row, side=transfer never does', async () => {
  const sell = await post(trade({ tx: 'sig-watch-sell', side: 'sell' }));
  assert.equal(sell.status, 200);
  assert.equal(sell.json.inserted, 1);
  const row = getDb().prepare('SELECT side, source FROM wallet_trades WHERE tx = ?').get('sig-watch-sell') as Record<
    string,
    unknown
  >;
  assert.equal(row.side, 'sell');
  assert.equal(row.source, 'watch');

  // A transfer is not a trade: the row must NOT exist, only the balance refresh ran.
  const xfer = await post(trade({ tx: 'sig-watch-xfer', side: 'transfer' }));
  assert.equal(xfer.status, 200);
  assert.equal(xfer.json.inserted, 0);
  assert.equal(sourceOf('sig-watch-xfer'), undefined);
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
