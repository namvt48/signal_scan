import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { applyVolumeDelta } from '../src/poller.js';
import { CompositeProvider } from '../src/providers/composite.js';
import { parseTokenInfo, type GmgnProvider, type GmgnTokenInfoResponse } from '../src/providers/gmgn.js';
import type { MarketDataProvider } from '../src/providers/provider.js';

// Live capture 2026-09-24, GET openapi.gmgn.ai/v1/token/info?chain=sol on MINI.
const MINI: GmgnTokenInfoResponse = {
  code: 0,
  data: {
    symbol: 'MINI',
    holder_count: 2923,
    circulating_supply: '999949659.050811',
    total_supply: '999949659.050811',
    liquidity: '245944.853856',
    creation_timestamp: 1788467300,
    price: {
      price: '0.0026489706',
      volume_1h: '4915.025026',
      volume_24h: '425137.45927614',
      buy_volume_1h: '2762.86206599',
      sell_volume_1h: '2152.16296',
      buy_volume_24h: '218144.28927807',
      sell_volume_24h: '206993.16999806',
    },
  },
};

test('parseTokenInfo: the six columns from one live MINI row (strings coerced)', () => {
  const p = parseTokenInfo(MINI);
  assert.equal(p.price, 0.0026489706);
  assert.equal(p.symbol, 'MINI');
  assert.equal(p.holders, 2923);
  assert.equal(p.supply, 999949659.050811);
  assert.equal(p.volume24h, 425137.45927614);
  assert.equal(p.volume1h, 4915.025026);
  assert.equal(p.buyVol24h, 218144.28927807);
  assert.equal(p.sellVol24h, 206993.16999806);
  assert.equal(p.liquidity, 245944.853856);
  assert.equal(p.deployedAt, 1788467300 * 1000);
  // market cap is derived: price × circulating_supply (the API has no such field)
  assert.ok(Math.abs((p.marketCap ?? 0) - 0.0026489706 * 999949659.050811) < 1e-3, `mc=${p.marketCap}`);
});

test('parseTokenInfo: zero/absent readings are OMITTED so they cannot clobber a good value', () => {
  const p = parseTokenInfo({ code: 0, data: { symbol: 'X', price: { price: '0' } } });
  assert.equal('price' in p, false);
  assert.equal('marketCap' in p, false);
  assert.equal('supply' in p, false);
  assert.equal('holders' in p, false);
  // volumes are a reading on a valid row, so they are kept even at 0
  assert.equal(p.volume24h, 0);
  assert.equal(p.volume1h, 0);
});

test('parseTokenInfo: throws on a non-zero code and on a data-less body', () => {
  assert.throws(() => parseTokenInfo({ code: 404, error: 'TOKEN_NOT_FOUND' }), /TOKEN_NOT_FOUND/);
  assert.throws(() => parseTokenInfo({ code: 0 }), /no data/);
});

test('GmgnMarketProvider.metric: essential and volume are DISJOINT field sets', async () => {
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async (_ca, _chain, kind) => {
      const p = parseTokenInfo(MINI);
      return kind === 'volume'
        ? { volume24h: p.volume24h, buyVol24h: p.buyVol24h, sellVol24h: p.sellVol24h, volume1h: p.volume1h }
        : { price: p.price, holders: p.holders, symbol: p.symbol };
    },
    assetInfo: async () => ({}),
  };
  const ess = await gmgn.metric('ca', 'sol', 'essential');
  assert.equal(ess.price, 0.0026489706);
  assert.equal(ess.holders, 2923);
  assert.equal(ess.volume24h, undefined, 'essential must not carry volume');
  const vol = await gmgn.metric('ca', 'sol', 'volume');
  assert.equal(vol.volume24h, 425137.45927614);
  assert.equal(vol.price, undefined, 'volume must not carry price');
});

test('CompositeProvider: routes essential+volume to GMGN, gini to Nansen', async () => {
  const calls: string[] = [];
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async (_ca, _chain, kind) => {
      calls.push(`gmgn:${kind}`);
      return kind === 'volume' ? { volume24h: 1 } : { price: 2 };
    },
    assetInfo: async () => ({ symbol: 'G' }),
  };
  const nansen: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async (_ca, _chain, kind) => {
      calls.push(`nansen:${kind}`);
      return { nansenFreshPct: 5, nansenHolders: 7 };
    },
    walletTokenHoldings: async () => [],
  };
  const c = new CompositeProvider(gmgn, nansen);

  assert.equal((await c.metric('ca', 'sol', 'essential')).price, 2);
  assert.equal((await c.metric('ca', 'sol', 'volume')).volume24h, 1);
  assert.equal((await c.metric('ca', 'sol', 'gini')).nansenFreshPct, 5);
  assert.deepEqual(calls, ['gmgn:essential', 'gmgn:volume', 'nansen:gini']);
});

test('applyVolumeDelta: keeps a provider-supplied 1h volume, derives only when absent', () => {
  open(':memory:');
  const now = Date.now();
  updateTokenMetrics('CA-V', 'sol', { volume24h: 1000, vol24hPrev: 900, vol24hPrevAt: now - 3_600_000 });

  const fromProvider: { volume24h: number; volume1h?: number } = { volume24h: 1200, volume1h: 42 };
  applyVolumeDelta('CA-V', 'sol', fromProvider);
  assert.equal(fromProvider.volume1h, 42, 'GMGN real 1h volume was clobbered by the derived delta');

  const derived: { volume24h: number; volume1h?: number } = { volume24h: 1200 };
  applyVolumeDelta('CA-V', 'sol', derived);
  assert.equal(derived.volume1h, 300, 'Nansen mode must still derive 1h volume from the 24h delta');
});

test('GmgnMarketProvider: a 429 becomes an HttpError so the layer can gate', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 429, error: 'RATE_LIMIT_BANNED' }), {
      status: 429,
      headers: { 'x-ratelimit-reset': '9999999999' },
    })) as typeof fetch;
  try {
    const { GmgnMarketProvider } = await import('../src/providers/gmgn.js');
    const p = new GmgnMarketProvider('k');
    await assert.rejects(p.metric('ca', 'sol', 'essential'), (e: unknown) => {
      return e instanceof Error && (e as { status?: number }).status === 429;
    });
  } finally {
    globalThis.fetch = original;
  }
});
