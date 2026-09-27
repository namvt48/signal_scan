import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extremesFromStats, fiboDelayMs, holdersGiniBody, hourlyStatsBody, NansenWebCrawler, parseGiniStats, type HourlyStatsRow, type PostJson } from '../src/providers/nansen.js';

test('fiboDelayMs: 1,1,2,3,5,8,13 × base (the credit-door retry spacing)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => fiboDelayMs(n, 1_000)), [1_000, 1_000, 2_000, 3_000, 5_000, 8_000, 13_000]);
  assert.deepEqual([0, 1, 2].map((n) => fiboDelayMs(n, 250)), [250, 250, 500]);
});

test('extremesFromStats: peak/trough of totalBalance over the series', () => {
  const rows: HourlyStatsRow[] = [
    { blockDate: 'h1', totalBalance: 819_228_615 },
    { blockDate: 'h2', totalBalance: 831_127_765 },
    { blockDate: 'h3', totalBalance: 825_000_000 },
    { blockDate: 'h4' }, // malformed row ignored
  ];
  assert.deepEqual(extremesFromStats(rows), { peak: 831_127_765, trough: 819_228_615 });
  assert.equal(extremesFromStats([]), undefined);
});

test('hourlyStatsBody: chain mapping + fixed shape', () => {
  const b = hourlyStatsBody('0xabc', 'sol', 'day') as { parameters: Record<string, unknown> };
  assert.equal(b.parameters.chain, 'solana');
  assert.equal(b.parameters.label, 'top_100_holders');
  // chart fidelity: app toggle "Include exchange-classified addresses" is ON (false)
  assert.equal(b.parameters.excludeExchanges, false);
  assert.throws(() => hourlyStatsBody('0xabc', 'unknownchain', 'day'));
});

test('NansenWebCrawler: parses 200 payload, throws on non-200', async () => {
  const ok: PostJson = async () => ({
    status: 200,
    json: { data: [{ totalBalance: 5 }, { totalBalance: 9 }, { totalBalance: 7 }] },
  });
  const r = await new NansenWebCrawler(ok).balanceExtremes('ca', 'sol');
  assert.deepEqual(r.d1, { peak: 9, trough: 5 });

  const blocked: PostJson = async () => ({ status: 403, json: null });
  await assert.rejects(new NansenWebCrawler(blocked).balanceExtremes('ca', 'sol'), /403/);
});

test('holders-gini body + parsing (live capture 2026-09-09: 19.217%)', () => {
  const gini = holdersGiniBody('caX', 'sol') as { parameters: Record<string, unknown> };
  assert.equal(gini.parameters.tokenAddress, 'caX');

  const g = parseGiniStats({
    data: [{ totalHolders: 3076, top100HoldersBalancePercent: 0.5729918981294265, freshWalletBalancePercent: 0.08960483727313256, medianBalanceUsd: 13.735075895817383 }],
  });
  assert.equal(g.holders, 3076);
  assert.ok(Math.abs(g.freshSupplyPct - 8.960483727313256) < 1e-9, `fresh=${g.freshSupplyPct}`);
  assert.ok(Math.abs((g.t100SupplyPct ?? 0) - 57.29918981294265) < 1e-9);
  assert.equal(g.medianBalanceUsd, 13.735075895817383);
  // old minimal row shape: fresh required, optional fields omitted, holders 0
  const g2 = parseGiniStats({ data: [{ freshWalletBalancePercent: 0.19217039506063083 }] });
  assert.equal(g2.holders, 0);
  assert.equal(g2.t100SupplyPct, undefined);
  assert.equal(g2.medianBalanceUsd, undefined);
  assert.ok(Math.abs(g2.freshSupplyPct - 19.217039506063083) < 1e-9);
  assert.throws(() => parseGiniStats({ data: [] }));
  assert.throws(() => parseGiniStats({ data: [{ freshWalletBalancePercent: 5 }] }));
});

// --- cutover tests 2026-09-09: all live data from Nansen ---------------------

import {
  essentialDataBody,
  mapDexTradesToActivities,
  NansenApiClient,
  NansenMarketProvider,
  parseEssentialData,
  parseVolumeDetails,
  volumeDetailsBody,
  type NansenTradeRow,
} from '../src/providers/nansen.js';
import { hourlyStatsToPoints } from '../src/crawl.js';
import { SolanaRpcClient } from '../src/providers/solana.js';
import type { Chain } from '../src/shared/chain.js';

test('essential-data body + parser: marketCap null derives price×circulatingSupply', () => {
  const b = essentialDataBody('caX', 'sol') as { parameters: Record<string, unknown> };
  assert.equal(b.parameters.chain, 'solana');
  assert.equal(b.parameters.tokenAddress, 'caX');

  const ess = parseEssentialData({
    data: [{ priceUsd5Min: 0.001234, circulatingSupply: 1e9, totalLiquidityUsd: 500_000, marketCap: null }],
  });
  assert.equal(ess.price, 0.001234);
  assert.equal(ess.supply, 1e9);
  assert.ok(Math.abs(ess.marketCap - 0.001234 * 1e9) < 1e-6);
  assert.equal(ess.liquidity, 500_000);

  // explicit marketCap wins
  const withMc = parseEssentialData({ data: [{ priceUsd5Min: 2, circulatingSupply: 10, marketCap: 12_345 }] });
  assert.equal(withMc.marketCap, 12_345);
  assert.throws(() => parseEssentialData({ data: [] }));

  // deployedTimestamp → epoch ms; null-safe (missing/unparseable → undefined)
  const dep = parseEssentialData({ data: [{ priceUsd5Min: 1, circulatingSupply: 1, deployedTimestamp: '2026-09-08T20:28:00Z', symbol: ' MINI ' }] });
  assert.equal(dep.deployedAt, Date.parse('2026-09-08T20:28:00Z'));
  assert.equal(dep.symbol, 'MINI'); // trimmed, stored AS-IS (no case change)
  assert.equal(ess.deployedAt, undefined);
  assert.equal(ess.symbol, undefined); // omitted when absent
  assert.equal(parseEssentialData({ data: [{ priceUsd5Min: 1, deployedTimestamp: 'junk' }] }).deployedAt, undefined);
  // empty/whitespace/non-string symbol → omitted
  assert.equal(parseEssentialData({ data: [{ priceUsd5Min: 1, symbol: '   ' }] }).symbol, undefined);
  assert.equal(parseEssentialData({ data: [{ priceUsd5Min: 1, symbol: null }] }).symbol, undefined);
});

test('volume-details body + parser: buy/sell recent only', () => {
  const b = volumeDetailsBody('caX', 'sol') as { parameters: Record<string, unknown> };
  assert.equal(b.parameters.chain, 'solana');
  assert.equal(b.parameters.intervalSec, 86400);
  const v = parseVolumeDetails({
    data: [{ buyVolumeUsdRecent: 1000, sellVolumeUsdRecent: 400, buyVolumeUsdBefore: 99, sellVolumeUsdBefore: 99 }],
  });
  assert.deepEqual(v, { buy: 1000, sell: 400 });
  assert.throws(() => parseVolumeDetails({ data: [] }));
});

test('volume-details: intervalSec is the window knob (24h default, 3600 for the 1H column)', () => {
  assert.equal((volumeDetailsBody('caX', 'sol', 3_600) as { parameters: Record<string, unknown> }).parameters.intervalSec, 3_600);
  assert.equal((volumeDetailsBody('caX', 'sol') as { parameters: Record<string, unknown> }).parameters.intervalSec, 86_400);
});

test("metric('volume'): one 24h window per sweep — the poller derives 1h growth", async () => {
  const seen: number[] = [];
  const post: PostJson = async (url, body) => {
    if (url.endsWith('tgm-volume-details')) {
      const w = (body as { parameters: { intervalSec: number } }).parameters.intervalSec;
      seen.push(w);
      return { status: 200, json: { data: [{ buyVolumeUsdRecent: 1_000, sellVolumeUsdRecent: 400 }] } };
    }
    return { status: 200, json: { data: [] } };
  };
  const patch = await new NansenMarketProvider(post, null, () => []).metric('caX', 'sol', 'volume');
  assert.deepEqual(seen, [86_400]);
  assert.equal(patch.volume24h, 1_400);
  assert.equal(patch.volume1h, undefined);
});

test('hourlyStatsBody: custom {from,to} range passes through (live-verified 2026-09-10)', () => {
  const b = hourlyStatsBody('caX', 'sol', { from: '2026-09-03T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' }) as { parameters: Record<string, unknown> };
  assert.deepEqual(b.parameters.date, { from: '2026-09-03T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' });
  assert.equal(b.parameters.label, 'top_100_holders');
  assert.equal(b.parameters.excludeExchanges, false);
});

test('parseEssentialData price fallback: priceUsd5Min → priceUsd → FDV/supply → 0 (never throws on price)', () => {
  // priceUsd5Min missing/null → priceUsd wins
  const p2 = parseEssentialData({ data: [{ priceUsd5Min: null, priceUsd: 0.25, circulatingSupply: 100 }] });
  assert.equal(p2.price, 0.25);

  // neither price field → FDV ÷ totalSupply (live MVC probe shape: fdv 26237.19, supply 1e9)
  const fdv = parseEssentialData({
    data: [{ priceUsd5Min: null, fullyDilutedValuationUsd: 26237.19, totalSupply: 1e9, circulatingSupply: 1e9, totalLiquidityUsd: 7918.97, symbol: 'MVC', deployedTimestamp: '2026-09-02T20:59:11Z' }],
  });
  assert.ok(Math.abs(fdv.price - 26237.19 / 1e9) < 1e-15, `fdv price=${fdv.price}`);
  assert.equal(fdv.symbol, 'MVC'); // symbol/deployed_at still land under fallback price
  assert.equal(fdv.deployedAt, Date.parse('2026-09-02T20:59:11Z'));
  assert.equal(fdv.liquidity, 7918.97);

  // totalSupply missing → FDV ÷ circulatingSupply
  const circ = parseEssentialData({ data: [{ fullyDilutedValuationUsd: 100, circulatingSupply: 50 }] });
  assert.equal(circ.price, 2);

  // nothing → price 0, marketCap derives 0 — still no throw
  const zero = parseEssentialData({ data: [{ circulatingSupply: 1e9 }] });
  assert.equal(zero.price, 0);
  assert.equal(zero.marketCap, 0);

  // missing ROW still throws (tokenSweep catch logs + skips the CA)
  assert.throws(() => parseEssentialData({ data: [] }), /no row/);
});

test('hourlyStatsToPoints: keeps t/total/totalUsd + new holders/inflow fields, drops junk', () => {
  const pts = hourlyStatsToPoints([
    { blockDate: '2026-09-03T23:00:00Z', totalBalance: 190_161_974, totalBalanceUsd: 12_345, totalHolders: 2819, totalInflows: 5000.5 },
    { blockDate: '2026-09-04T00:00:00Z', totalBalance: 191_000_000 }, // partial row: only t/total
    { blockDate: '2026-09-04T01:00:00Z', totalBalance: NaN, totalInflows: 3 }, // junk total dropped
    { totalBalance: 7 }, // no blockDate → t '' (kept — total is finite)
  ] as HourlyStatsRow[]);
  assert.deepEqual(pts[0], { t: '2026-09-03T23:00:00Z', total: 190_161_974, totalUsd: 12_345, holders: 2819, inflow: 5000.5 });
  assert.deepEqual(pts[1], { t: '2026-09-04T00:00:00Z', total: 191_000_000 });
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[2], { t: '', total: 7 });
});

test('mapDexTradesToActivities: tracked-CA filter, usd guard, buy/sell sides', () => {
  const rows: NansenTradeRow[] = [
    { transaction_hash: 'h1', block_timestamp: '2026-09-09T00:00:00Z', token_bought_address: 'caT', token_sold_address: 'USDC', trade_value_usd: '1500' },
    { transaction_hash: 'h2', block_timestamp: '2026-09-09T01:00:00Z', token_bought_address: 'USDC', token_sold_address: 'caT', trade_value_usd: 200 },
    { transaction_hash: 'h3', block_timestamp: '2026-09-09T02:00:00Z', token_bought_address: 'other', token_sold_address: 'USDC', trade_value_usd: 999 },
    { transaction_hash: 'h4', block_timestamp: '2026-09-09T03:00:00Z', token_bought_address: 'caT', trade_value_usd: 0 },
  ];
  const acts = mapDexTradesToActivities(rows, new Set(['caT']), 'sol');
  assert.equal(acts.length, 2);
  assert.deepEqual(
    acts.map((a) => ({ tx: a.tx, side: a.side, usd: a.amountUsd, ca: a.ca, chain: a.chain })),
    [
      { tx: 'h1', side: 'buy', usd: 1500, ca: 'caT', chain: 'sol' },
      { tx: 'h2', side: 'sell', usd: 200, ca: 'caT', chain: 'sol' },
    ],
  );
  assert.equal(acts[0]?.ts, Date.parse('2026-09-09T00:00:00Z'));
});

test('NansenMarketProvider.tokenInfo: 3 free questions in one pass → TokenInfo + nansenStats', async () => {
  const asked: string[] = [];
  const post: PostJson = async (url, body) => {
    asked.push(url.split('/').pop() ?? '');
    const p = (body as { parameters: Record<string, unknown> }).parameters;
    assert.equal(p.chain, 'solana');
    if (url.endsWith('tgm-essential-data')) {
      return { status: 200, json: { data: [{ priceUsd5Min: 0.5, circulatingSupply: 1000, marketCap: null, totalLiquidityUsd: 900, deployedTimestamp: '2026-09-08T20:28:00Z', symbol: 'MINI', name: 'Minirouter.sh' }] } };
    }
    if (url.endsWith('tgm-volume-details')) {
      return { status: 200, json: { data: [{ buyVolumeUsdRecent: 10, sellVolumeUsdRecent: 5 }] } };
    }
    if (url.endsWith('tgm-holders-gini-stats')) return { status: 200, json: { data: [{ totalHolders: 3000, top100HoldersBalancePercent: 0.55, freshWalletBalancePercent: 0.194, medianBalanceUsd: 8.82 }] } };
    return { status: 200, json: { data: [] } };
  };
  const info = await new NansenMarketProvider(post, null, () => []).tokenInfo('caX', 'sol');
  assert.deepEqual(asked.sort(), ['tgm-essential-data', 'tgm-holders-gini-stats', 'tgm-volume-details']);
  assert.equal(info.price, 0.5);
  assert.equal(info.marketCap, 500); // derived: price × supply
  assert.equal(info.volume24h, 15);
  assert.equal(info.volume1h, undefined); // one 24h window; no separate 1h fetch
  assert.equal(info.holders, 0); // free path has no holders endpoint
  assert.equal(info.deployedAt, Date.parse('2026-09-08T20:28:00Z'));
  assert.equal(info.symbol, 'MINI'); // ticker threads through tokenInfo
  assert.equal(info.freshCount, undefined); // no writer — stale column by design
  assert.ok(info.nansenStats && Math.abs(info.nansenStats.freshSupplyPct - 19.4) < 1e-9);
  assert.equal(info.nansenStats?.holders, 3000);
  assert.ok(Math.abs((info.nansenStats?.t100SupplyPct ?? 0) - 55) < 1e-9);
  assert.equal(info.nansenStats?.medianBalanceUsd, 8.82);
});

test('metric(essential): a silent Nansen symbol falls back to the RPC DAS (the sweep path that heals old NULL rows)', async () => {
  const origFetch = globalThis.fetch;
  const dasIds: unknown[] = [];
  try {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { params: { id: unknown } };
      dasIds.push(body.params.id);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: { metadata: { symbol: 'tit' } } } }), { status: 200 });
    }) as typeof fetch;

    const post: PostJson = async () => ({
      status: 200,
      json: { data: [{ priceUsd5Min: 0.5, circulatingSupply: 1000, marketCap: null, totalLiquidityUsd: 900 }] },
    });
    const provider = new NansenMarketProvider(post, null, () => [], new SolanaRpcClient(['https://rpc.test']));
    const patch = await provider.metric('caX', 'sol', 'essential');
    assert.equal(patch.symbol, 'tit');
    assert.deepEqual(dasIds, ['caX']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('metric(essential): a Nansen-provided symbol never triggers the RPC fallback', async () => {
  const origFetch = globalThis.fetch;
  let dasCalls = 0;
  try {
    globalThis.fetch = (async () => {
      dasCalls++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const post: PostJson = async () => ({
      status: 200,
      json: { data: [{ priceUsd5Min: 0.5, circulatingSupply: 1000, marketCap: null, totalLiquidityUsd: 900, symbol: 'MINI' }] },
    });
    const provider = new NansenMarketProvider(post, null, () => [], new SolanaRpcClient(['https://rpc.test']));
    const patch = await provider.metric('caX', 'sol', 'essential');
    assert.equal(patch.symbol, 'MINI');
    assert.equal(dasCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('metric(essential): a mint Nansen has no row for still returns the RPC floor instead of throwing', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: { metadata: { symbol: 'tit' } },
            token_info: { supply: 1000000, decimals: 6, price_info: { price_per_token: 0.25 } },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const post: PostJson = async () => ({ status: 200, json: { data: [] } });
    const provider = new NansenMarketProvider(post, null, () => [], new SolanaRpcClient(['https://rpc.test']));
    const patch = await provider.metric('caX', 'sol', 'essential');
    assert.equal(patch.symbol, 'tit');
    assert.equal(patch.supply, 1);
    assert.equal(patch.price, 0.25);
    assert.equal(patch.marketCap, 0.25);
    assert.equal(patch.liquidity, undefined);
    assert.equal(patch.deployedAt, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('metric(essential): Nansen omitting supply/price keeps its liquidity/deployed_at but takes the RPC supply', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { token_info: { supply: 1000000, decimals: 6, price_info: { price_per_token: 0.25 } } } }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const post: PostJson = async () => ({
      status: 200,
      json: { data: [{ totalLiquidityUsd: 7918.97, deployedTimestamp: '2026-09-17T08:00:48Z', symbol: 'TIT' }] },
    });
    const provider = new NansenMarketProvider(post, null, () => [], new SolanaRpcClient(['https://rpc.test']));
    const patch = await provider.metric('caX', 'sol', 'essential');
    assert.equal(patch.supply, 1);
    assert.equal(patch.price, 0.25);
    assert.equal(patch.liquidity, 7918.97);
    assert.equal(patch.deployedAt, Date.parse('2026-09-17T08:00:48Z'));
    assert.equal(patch.symbol, 'TIT');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('metric(essential): a THROWING Nansen question (403/timeout) still lands the RPC floor', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: { metadata: { symbol: 'tit' } },
            token_info: { supply: 1000000, decimals: 6, price_info: { price_per_token: 0.25 } },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    // The browser door is down: every question throws before a body exists.
    const post: PostJson = async () => {
      throw new Error('nansen question tgm-essential-data 403');
    };
    const provider = new NansenMarketProvider(post, null, () => [], new SolanaRpcClient(['https://rpc.test']));
    const patch = await provider.metric('caX', 'sol', 'essential');
    assert.equal(patch.symbol, 'tit', 'the DAS door is independent of the Nansen door');
    assert.equal(patch.supply, 1);
    assert.equal(patch.price, 0.25);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('metric(essential): both doors empty still throws, so the sweep logs the CA', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200 })) as unknown as typeof fetch;
    const post: PostJson = async () => {
      throw new Error('nansen question tgm-essential-data 403');
    };
    const provider = new NansenMarketProvider(post, null, () => [], new SolanaRpcClient(['https://rpc.test']));
    await assert.rejects(provider.metric('caX', 'sol', 'essential'), /403/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('NansenApiClient.currentBalance: request shape + data[0] parse (credits header logged)', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(String(_url), 'https://api.nansen.ai/api/v1/profiler/address/current-balance');
      assert.equal(body.chain, 'solana'); // API door maps sol → solana
      assert.deepEqual(body.filters, { token_address: 'caX' });
      assert.deepEqual(body.pagination, { page: 1, per_page: 5 });
      return new Response(JSON.stringify({ data: [{ token_amount: 123, price_usd: 0.5, value_usd: 61.5, token_symbol: 'TOK' }] }), {
        status: 200,
        headers: { 'x-nansen-credits-remaining': '9877' },
      });
    }) as typeof fetch;
    const b = await new NansenApiClient('key').currentBalance('W', 'sol', 'caX');
    assert.deepEqual(b, { tokenAmount: 123, priceUsd: 0.5, valueUsd: 61.5, tokenSymbol: 'TOK' });

    // empty data → undefined (no position)
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    assert.equal(await new NansenApiClient('key').currentBalance('W', 'sol', 'caX'), undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- wallet holdings: Solana RPC for 'sol', Nansen credits only as non-sol fallback

function solanaAccount(mint: string, uiAmountString: string): unknown {
  return { account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString, amount: uiAmountString, decimals: 0 } } } } } };
}

/** What the stub wallet holds, by mint. Any mint absent here → no account (amount 0). */
const STUB_HELD: Record<string, string> = { ca1: '1500', ca3: '250.5' };

type RpcCall = { wallet: string; mint: string; programId: string };

/** Stub endpoint: per-pair mint filter. Records exactly what filter the client sent. */
function stubSolanaRpc(calls: RpcCall[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { params: [string, { mint?: string; programId?: string }] };
    const f = body.params[1];
    calls.push({ wallet: body.params[0], mint: f.mint ?? '', programId: f.programId ?? '' });
    const amount = f.mint === undefined ? undefined : STUB_HELD[f.mint];
    const value = amount === undefined ? [] : [solanaAccount(f.mint as string, amount)];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const SOL_CAS = ['ca1', 'ca2', 'ca3', 'ca4', 'ca5'].map((address) => ({ address, chain: 'sol' as const }));

test('walletTokenHoldings (sol): ONE mint-filtered call per (CA, wallet) pair — never a whole-program scan', async () => {
  const origFetch = globalThis.fetch;
  const calls: RpcCall[] = [];
  try {
    globalThis.fetch = stubSolanaRpc(calls);
    const p = new NansenMarketProvider(async () => ({ status: 200, json: {} }), null, () => SOL_CAS, new SolanaRpcClient(['https://rpc.test']));
    // ca2 is tracked but not held → must still come back, as 0, so the writer deletes the stale row
    const rows = await p.walletTokenHoldings('WALLET', 'sol', ['ca1', 'ca3', 'ca2']);
    assert.deepEqual(rows, [{ ca: 'ca1', amount: 1500 }, { ca: 'ca3', amount: 250.5 }, { ca: 'ca2', amount: 0 }]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.wallet), ['WALLET', 'WALLET', 'WALLET']);
    assert.deepEqual(calls.map((c) => c.mint), ['ca1', 'ca3', 'ca2']);
    assert.deepEqual(calls.map((c) => c.programId), ['', '', '']); // the mint filter covers both token programs
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('walletTokenHoldings (sol): sweep cost = the pairs asked for — 11 wallets × 2 CAs = 22 calls, flat as the CA set grows', async () => {
  const origFetch = globalThis.fetch;
  const calls: RpcCall[] = [];
  try {
    globalThis.fetch = stubSolanaRpc(calls);
    const many = [...SOL_CAS, ...Array.from({ length: 400 }, (_, i) => ({ address: `extra${i}`, chain: 'sol' as const }))];
    const p = new NansenMarketProvider(async () => ({ status: 200, json: {} }), null, () => many, new SolanaRpcClient(['https://rpc.test']));
    for (let i = 0; i < 11; i++) await p.walletTokenHoldings(`W${i}`, 'sol', ['ca1', 'ca3']);
    assert.equal(calls.length, 22);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('walletTokenHoldings (sol): RPC failure rejects — the sweep keeps the wallet\'s previous rows', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
    const p = new NansenMarketProvider(async () => ({ status: 200, json: {} }), null, () => SOL_CAS, new SolanaRpcClient(['https://rpc.test']));
    await assert.rejects(p.walletTokenHoldings('WALLET', 'sol'), /solana rpc getTokenAccountsByOwner failed/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('walletTokenHoldings (non-sol): credit-door fallback — one currentBalance per tracked CA, no RPC, warned once per chain', async () => {
  const warns: string[] = [];
  const origWrite = process.stderr.write;
  const rpcCalls: string[] = [];
  const origFetch = globalThis.fetch;
  class RecordingApi extends NansenApiClient {
    readonly calls: { wallet: string; chain: string; ca: string }[] = [];
    override async currentBalance(wallet: string, chain: string, ca: string) {
      this.calls.push({ wallet, chain, ca });
      return { tokenAmount: 42, priceUsd: 2, valueUsd: 84 };
    }
  }
  try {
    process.stderr.write = ((chunk: unknown) => {
      const s = String(chunk);
      if (s.includes('no RPC holdings source')) warns.push(s);
      return true;
    }) as typeof process.stderr.write;
    globalThis.fetch = stubSolanaRpc(rpcCalls as unknown as RpcCall[]);
    const api = new RecordingApi('key');
    // The chain union is ['sol'] today (src/shared/chain.ts), so the non-sol
    // credit fallback is unreachable by type — the cast exercises the branch the
    // spec keeps as the escape hatch for a future multi-chain universe.
    const other = 'bsc' as unknown as Chain;
    const cas = [{ address: 'bsc1', chain: other }, { address: 'bsc2', chain: other }];
    const p = new NansenMarketProvider(async () => ({ status: 200, json: {} }), api, () => cas, new SolanaRpcClient(['https://rpc.test']));
    const rows = await p.walletTokenHoldings('WALLET', other);
    assert.deepEqual(rows, [{ ca: 'bsc1', amount: 42 }, { ca: 'bsc2', amount: 42 }]);
    assert.equal(api.calls.length, 2); // 1 credit per (wallet, tracked CA) on the fallback
    assert.deepEqual(api.calls.map((c) => c.ca), ['bsc1', 'bsc2']);
    assert.equal(rpcCalls.length, 0); // non-sol never touches the Solana RPC
    await p.walletTokenHoldings('WALLET', other);
    assert.equal(warns.length, 1); // one warn per chain, so the credit burn stays visible
    assert.match(warns[0] ?? '', /chain bsc has no RPC holdings source/);
  } finally {
    process.stderr.write = origWrite;
    globalThis.fetch = origFetch;
  }
});
