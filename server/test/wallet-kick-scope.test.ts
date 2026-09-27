import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertTrackedCa, insertWallet, open, watchedCasForWallet } from '../src/db.js';
import { insertTrades } from '../src/ingest.js';

const CA = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';
const UNTRACKED = '0x1111111111111111111111111111111111111111';

function activity(tx: string, ca: string, side: 'buy' | 'sell') {
  return { tx, ts: Date.now(), side, ca, chain: 'base' as const, amountUsd: 1, price: 1 };
}

function wallet(address: string): string {
  return insertWallet({ address, name: address, tags: [], chain: 'base', source: 'test' }).id;
}

before(() => {
  open(':memory:');
});

test('kick scope: a sell-only wallet is still refreshed, an untracked CA is not', () => {
  insertTrackedCa({ address: CA, chain: 'base', note: '' });
  const buyer = wallet('w-buy');
  const seller = wallet('w-sell');
  const idle = wallet('w-idle');
  insertTrades(buyer, [activity('tx-buy', CA, 'buy')], 'watch');
  insertTrades(seller, [activity('tx-sell', CA, 'sell')], 'watch');
  insertTrades(idle, [activity('tx-idle', UNTRACKED, 'buy')], 'watch');

  assert.deepEqual(watchedCasForWallet(buyer), [CA]);
  assert.deepEqual(watchedCasForWallet(seller), [CA], 'a sell-only wallet must still refresh its holding');
  assert.deepEqual(watchedCasForWallet(idle), [], 'a CA that is not tracked is never in the scope');
});
