import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { fetchFomoSwaps, matchFomoBuySwap, type FomoSwap } from '../src/fomo-api.js';

const CA = '6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr';
const TRADE_ID = 'a09f56a5-975b-45e2-b71e-17c7080c8b0f';
const TS = Date.parse('2026-10-08T06:47:35.000Z');

function swap(overrides: Partial<FomoSwap> = {}): FomoSwap {
  return {
    chain: 'sol',
    at: TS,
    tradeIdOut: TRADE_ID,
    tokenIn: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usd: 9950.06 },
    tokenOut: { address: CA, usd: 9950.06 },
    ...overrides,
  };
}

test('matchFomoBuySwap returns the spent stablecoin leg for one exact position fill', () => {
  assert.equal(matchFomoBuySwap({ ca: CA, chain: 'sol', ts: TS, tradeId: TRADE_ID }, [swap()]), 9950.06);
  assert.equal(matchFomoBuySwap({ ca: CA, chain: 'sol', ts: TS, tradeId: null }, [swap()]), 9950.06);
  assert.equal(matchFomoBuySwap({ ca: CA, chain: 'sol', ts: TS, tradeId: null }, [swap({ tradeIdOut: null })]), null);
});

test('matchFomoBuySwap rejects wrong token, chain, position, or a fill outside the alert time bucket', () => {
  const event = { ca: CA, chain: 'sol' as const, ts: TS, tradeId: TRADE_ID };
  assert.equal(matchFomoBuySwap(event, [swap({ tokenOut: { address: 'other', usd: 9950.06 } })]), null);
  assert.equal(matchFomoBuySwap(event, [swap({ chain: 'base' })]), null);
  assert.equal(matchFomoBuySwap(event, [swap({ tradeIdOut: 'different-position' })]), null);
  assert.equal(matchFomoBuySwap(event, [swap({ at: TS - 1 })]), null);
  assert.equal(matchFomoBuySwap(event, [swap({ at: TS + 5000 })]), null);
});

test('matchFomoBuySwap leaves ambiguous or unpriced fills unresolved', () => {
  const event = { ca: CA, chain: 'sol' as const, ts: TS, tradeId: TRADE_ID };
  assert.equal(matchFomoBuySwap(event, [swap(), swap({ at: TS + 1000 })]), null);
  assert.equal(matchFomoBuySwap(event, [swap(), swap({ at: TS + 1000, tokenIn: { address: 'USDC', usd: null } })]), null);
  assert.equal(matchFomoBuySwap(event, [swap({ tokenIn: { address: 'USDC', usd: null } })]), null);
  assert.equal(matchFomoBuySwap(event, [swap({ tokenIn: { address: 'USDC', usd: 0 } })]), null);
});

test('fallback BUY matching counts missing-ID fills as ambiguity in either order', () => {
  const target = { ca: CA, chain: 'sol' as const, ts: TS, tradeId: null };
  const priced = swap();
  const missingId = swap({ at: TS + 1000, tradeIdOut: null });
  assert.equal(matchFomoBuySwap(target, [priced, missingId]), null);
  assert.equal(matchFomoBuySwap(target, [missingId, priced]), null);
});

test('fetchFomoSwaps requests the per-fill endpoint and parses exact USD and identity fields', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://fomo.test';
  let requestUrl = '';
  let authorization = '';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ swaps: [{
      chain: 'solana', at: '2026-10-08T06:47:35.000Z', tradeIdOut: TRADE_ID,
      tokenIn: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usd: 9950.06 }, tokenOut: { address: CA, usd: 9950.06 },
    }, {
      chain: 'ethereum', at: '2026-10-08T06:47:36.000Z', tokenIn: { address: 'usdc', usd: 1 }, tokenOut: { address: 'other', usd: 1 },
    }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const swaps = await fetchFomoSwaps('aki11a');
    assert.match(requestUrl, /\/v2\/users\/aki11a\/swaps\?limit=100$/);
    assert.equal(authorization, 'Bearer test-key');
    assert.equal(swaps?.length, 1);
    assert.deepEqual(swaps?.[0], swap());
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});

test('fetchFomoSwaps leaves partial or unavailable pages unresolved', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://fomo.test';
  const candidate = {
    chain: 'solana',
    at: '2026-10-08T06:47:35.000Z',
    tradeIdOut: TRADE_ID,
    tokenIn: { address: 'USDC', usd: 25 },
    tokenOut: { address: CA, usd: 25 },
  };
  try {
    for (const completeness of [{ partial: true }, { available: false }]) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ swaps: [candidate], ...completeness }), { status: 200 })) as typeof fetch;
      assert.equal(await fetchFomoSwaps('aki11a'), null);
    }
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});
