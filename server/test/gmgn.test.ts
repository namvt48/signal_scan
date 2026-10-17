import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';
import { updateTokenMetrics } from '../src/ingest.js';
import { applyVolumeDelta } from '../src/poller.js';
import { CompositeProvider } from '../src/providers/composite.js';
import { GatewayClient } from '../src/gateway-client.js';
import { GmgnMarketProvider, parseTokenInfo, type GmgnProvider, type GmgnTokenInfoResponse } from '../src/providers/gmgn.js';
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

test('parseTokenInfo: GMGN logo maps to the shared icon field only for the GMGN host', () => {
  const logo = 'https://gmgn.ai/external-res/abc_v2.webp';
  assert.equal(parseTokenInfo({ code: 0, data: { logo } }).iconUrl, logo);
  assert.equal('iconUrl' in parseTokenInfo({ code: 0, data: { logo: 'https://evil.example/logo.png' } }), false);
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

test('parseTokenInfo: X handle is normalized and charset-validated, junk is omitted', () => {
  const withAt = parseTokenInfo({ code: 0, data: { symbol: 'X', link: { twitter_username: '@bonk_inu' } } });
  assert.equal(withAt.xHandle, 'bonk_inu');
  // MINI's live row has no link block → no handle (the FE falls back to a CA search)
  assert.equal('xHandle' in parseTokenInfo(MINI), false);
  // a value that would build a broken x.com URL is dropped, not stored
  const junk = parseTokenInfo({ code: 0, data: { symbol: 'X', link: { twitter_username: 'a/b c' } } });
  assert.equal('xHandle' in junk, false);
});

test('parseTokenInfo: throws on a non-zero code and on a data-less body', () => {
  assert.throws(() => parseTokenInfo({ code: 404, error: 'TOKEN_NOT_FOUND' }), /TOKEN_NOT_FOUND/);
  assert.throws(() => parseTokenInfo({ code: 0 }), /no data/);
});

test('GMGN essential and volume metrics expose their shared token/info fields', async () => {
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async () => parseTokenInfo(MINI),
    assetInfo: async () => ({}),
  };
  const ess = await gmgn.metric('ca', 'sol', 'essential');
  assert.equal(ess.price, 0.0026489706);
  assert.equal(ess.holders, 2923);
  assert.equal(ess.volume24h, 425137.45927614);
  const vol = await gmgn.metric('ca', 'sol', 'volume');
  assert.equal(vol.volume24h, 425137.45927614);
  assert.equal(vol.price, 0.0026489706);
});

test('GmgnMarketProvider: concurrent essential and volume for one CA share one upstream call', async () => {
  let calls = 0;
  const gateway = {
    call: async () => {
      calls++;
      await Promise.resolve();
      return { status: 200, body: JSON.stringify(MINI), headers: {} };
    },
  } as unknown as GatewayClient;
  const gmgn = new GmgnMarketProvider('', gateway);

  const [essential, volume] = await Promise.all([
    gmgn.metric('ca', 'sol', 'essential'),
    gmgn.metric('ca', 'sol', 'volume'),
  ]);
  assert.equal(calls, 1);
  assert.equal(essential.price, 0.0026489706);
  assert.equal(essential.volume24h, 425137.45927614);
  assert.equal(volume.volume24h, 425137.45927614);
  assert.equal(volume.price, 0.0026489706);

  await gmgn.metric('ca', 'sol', 'essential');
  assert.equal(calls, 2, 'completed requests are not cached; next call gets a fresh gateway request');
});

test('GmgnMarketProvider.tokenIcon: fetches and validates the GMGN token/info logo', async () => {
  const logo = 'https://gmgn.ai/external-res/abc_v2.webp';
  const gateway = {
    call: async () => ({ status: 200, body: JSON.stringify({ code: 0, data: { logo } }), headers: {} }),
  } as unknown as GatewayClient;
  const gmgn = new GmgnMarketProvider('', gateway);
  assert.equal(await gmgn.tokenIcon('ca', 'sol'), logo);
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

test('CompositeProvider.tokenInfo: a failing gini door keeps the GMGN market core (no full abort)', async () => {
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async (_ca, _chain, kind) =>
      kind === 'volume'
        ? { volume24h: 1, buyVol24h: 0, sellVol24h: 0 }
        : { price: 2, symbol: 'BEM', marketCap: 9, supply: 4, holders: 8, liquidity: 1 },
    assetInfo: async () => ({ symbol: 'BEM' }),
  };
  const nansen: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => {
      throw new Error('nansen gini-stats 403');
    },
    walletTokenHoldings: async () => [],
  };
  const info = await new CompositeProvider(gmgn, nansen).tokenInfo('ca', 'bsc');
  assert.equal(info.symbol, 'BEM');
  assert.equal(info.price, 2);
  assert.equal(info.marketCap, 9);
  assert.equal(info.nansenStats, undefined, 'a failed gini door must omit nansenStats, not abort the write');
});

test('CompositeProvider.metric: a gated GMGN essential door falls back to Nansen', async () => {
  const calls: string[] = [];
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async (_ca, _chain, kind) => {
      calls.push(`gmgn:${kind}`);
      if (kind === 'essential') throw new Error('gmgn essential 503 gated');
      return { volume24h: 1 };
    },
    assetInfo: async () => ({}),
  };
  const nansen: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async (_ca, _chain, kind) => {
      calls.push(`nansen:${kind}`);
      return { price: 3, marketCap: 12, supply: 4, symbol: 'NAN', deployedAt: 123 };
    },
    walletTokenHoldings: async () => [],
  };
  const patch = await new CompositeProvider(gmgn, nansen).metric('ca', 'sol', 'essential');
  assert.equal(patch.symbol, 'NAN');
  assert.equal(patch.supply, 4);
  assert.equal(patch.price, undefined, 'Nansen fallback must not replace GMGN-owned price');
  assert.equal(patch.marketCap, undefined, 'MC stays unknown until a fresh GMGN price arrives');
  assert.deepEqual(calls, ['gmgn:essential', 'nansen:essential']);
});

test('CompositeProvider.tokenInfo: a gated GMGN essential door keeps the CA writable via Nansen', async () => {
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async (_ca, _chain, kind) => {
      if (kind === 'essential') throw new Error('gmgn essential 503 gated');
      return { volume24h: 1, buyVol24h: 0, sellVol24h: 0 };
    },
    assetInfo: async () => ({}),
  };
  const nansen: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async (_ca, _chain, kind) =>
      kind === 'essential'
        ? { price: 3, supply: 4, symbol: 'NAN', marketCap: 12, liquidity: 5, deployedAt: 123 }
        : { nansenFreshPct: 5, nansenHolders: 7 },
    walletTokenHoldings: async () => [],
  };
  const info = await new CompositeProvider(gmgn, nansen).tokenInfo('ca', 'sol');
  assert.equal(info.symbol, 'NAN');
  assert.equal(info.supply, 4);
  assert.equal(info.price, undefined);
  assert.equal(info.marketCap, undefined);
  assert.equal(info.nansenStats?.freshSupplyPct, 5);
});

test('CompositeProvider.tokenInfo: BOTH essential doors failing still throws (nothing worth writing)', async () => {
  const gmgn: GmgnProvider = {
    name: 'gmgn',
    metric: async (_ca, _chain, kind) => {
      if (kind === 'essential') throw new Error('gmgn essential 500');
      return { volume24h: 1 };
    },
    assetInfo: async () => ({}),
  };
  const nansen: MarketDataProvider = {
    name: 'nansen',
    tokenInfo: async () => {
      throw new Error('unused');
    },
    metric: async () => {
      throw new Error('nansen essential 403');
    },
    walletTokenHoldings: async () => [],
  };
  await assert.rejects(new CompositeProvider(gmgn, nansen).tokenInfo('ca', 'sol'), /nansen essential 403/);
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
