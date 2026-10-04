import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, open } from '../src/db.js';
import { fillTokenMetrics, recomputeMarketCap, updateTokenMetrics } from '../src/ingest.js';
import { parseTokenMeta, type DexTokensResponse } from '../src/providers/dexscreener.js';

before(() => open(':memory:'));

test('parseTokenMeta: market fields from the deepest pair, icon from the deepest pair that has one', () => {
  const json: DexTokensResponse = {
    pairs: [
      {
        baseToken: { address: 'M', symbol: 'NEW' },
        priceUsd: '3.1',
        liquidity: { usd: 5_000 },
      },
      {
        baseToken: { address: 'M', symbol: 'OLD' },
        priceUsd: '2.0',
        info: { imageUrl: 'https://cdn.dexscreener.com/deep' },
        liquidity: { usd: 1_000 },
      },
    ],
  };
  const meta = parseTokenMeta(json).get('M');
  assert.equal(meta?.symbol, 'NEW', 'symbol comes from the deepest pair overall');
  assert.equal(meta?.price, 3.1, 'price comes from the deepest pair overall');
  assert.equal(meta?.iconUrl, 'https://cdn.dexscreener.com/deep', 'icon comes from the deepest pair that carries a valid one');
});

test('parseTokenMeta: checksummed EVM folds to lowercase, sol base58 keeps its case', () => {
  const json: DexTokensResponse = {
    pairs: [
      { baseToken: { address: '0xeDBf9122367d6bE0E5f1b4BfD5ce0F8c5a1B2c3D', symbol: 'E' }, priceUsd: '1' },
      { baseToken: { address: 'So1CaseSensitive', symbol: 'S' }, priceUsd: '2' },
    ],
  };
  const meta = parseTokenMeta(json);
  assert.equal(meta.get('0xedbf9122367d6be0e5f1b4bfd5ce0f8c5a1b2c3d')?.price, 1);
  assert.equal(meta.has('0xeDBf9122367d6bE0E5f1b4BfD5ce0F8c5a1B2c3D'), false);
  assert.equal(meta.get('So1CaseSensitive')?.price, 2);
});

test('parseTokenMeta: a zero/junk reading is omitted, a useless row is absent entirely', () => {
  const json = {
    pairs: [
      { baseToken: { address: 'ZERO' }, priceUsd: '0', liquidity: { usd: 9 } },
      { baseToken: { address: 'JUNK' }, priceUsd: 'not-a-number', liquidity: { usd: 9 } },
    ],
  } as unknown as DexTokensResponse;
  const meta = parseTokenMeta(json);
  assert.equal(meta.has('ZERO'), false, 'price 0 must be omitted (never a clobbering zero)');
  assert.equal(meta.has('JUNK'), false, 'a row with no symbol/price/icon is absent');
  assert.equal(parseTokenMeta({ pairs: null }).size, 0);
  assert.equal(parseTokenMeta({}).size, 0);
});

test('fillTokenMetrics: sets a NULL column but never overwrites a present one', () => {
  updateTokenMetrics('FILL-A', 'sol', { price: 5 });
  fillTokenMetrics('FILL-A', 'sol', { price: 9, symbol: 'KEEP' });
  const row = getDb()
    .prepare('SELECT price, symbol FROM token_state WHERE ca = ? AND chain = ?')
    .get('FILL-A', 'sol') as { price: number | null; symbol: string | null };
  assert.equal(row.price, 5, 'the owning value must survive a fallback fill');
  assert.equal(row.symbol, 'KEEP', 'a NULL column is filled');
});

test('recomputeMarketCap: market_cap = price × supply, refreshed on each owner write', () => {
  updateTokenMetrics('MC-A', 'sol', { price: 2, supply: 100 });
  recomputeMarketCap('MC-A', 'sol');
  assert.equal(mcOf('MC-A'), 200);

  updateTokenMetrics('MC-A', 'sol', { price: 3 });
  recomputeMarketCap('MC-A', 'sol');
  assert.equal(mcOf('MC-A'), 300, 'a new price refreshes the derived market cap');

  updateTokenMetrics('MC-B', 'sol', { price: 7 });
  recomputeMarketCap('MC-B', 'sol');
  assert.equal(mcOf('MC-B'), null, 'a NULL supply leaves market_cap untouched, never zeroed');
});

function mcOf(ca: string): number | null {
  const row = getDb()
    .prepare('SELECT market_cap FROM token_state WHERE ca = ? AND chain = ?')
    .get(ca, 'sol') as { market_cap: number | null };
  return row.market_cap;
}
