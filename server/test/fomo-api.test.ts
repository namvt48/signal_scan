import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { fetchFomoPositions, fetchFomoSwaps, getFomoApiUsageSnapshot, matchFomoBuySwap, matchFomoBuySwaps, type FomoSwap } from '../src/fomo-api.js';

const CA = '6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr';
const TRADE_ID = 'a09f56a5-975b-45e2-b71e-17c7080c8b0f';
const TS = Date.parse('2026-10-08T06:47:35.000Z');

function healthResponse(apiStatus = 'operational', liveDataStatus = 'operational'): Response {
  return new Response(JSON.stringify({
    components: { api: { status: apiStatus }, liveData: { status: liveDataStatus } },
  }), { status: 200 });
}

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
test('batched BUY matching never assigns one swap to multiple alerts', () => {
  const target = { ca: CA, chain: 'sol' as const, ts: TS, tradeId: TRADE_ID };
  assert.deepEqual(matchFomoBuySwaps([target, target], [swap()]), [null, null]);
  assert.deepEqual(matchFomoBuySwaps([target, target], [swap(), swap({ tradeIdOut: 'another-fill' })]), [null, null]);
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
    const url = String(input);
    if (url.endsWith('/status')) return healthResponse();
    requestUrl = url;
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ swaps: [{
      chain: 'solana', at: '2026-10-08T06:47:35.000Z', tradeIdOut: TRADE_ID,
      tokenIn: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usd: 9950.06 }, tokenOut: { address: CA, usd: 9950.06 },
    }, {
      chain: 'ethereum', at: '2026-10-08T06:47:36.000Z', tokenIn: { address: 'usdc', usd: 1 }, tokenOut: { address: 'other', usd: 1 },
    }] }), { status: 200, headers: { 'x-credits-cost': '2' } });
  }) as typeof fetch;
  try {
    const swapsBefore = getFomoApiUsageSnapshot().endpoints.find((item) => item.endpoint === 'swaps')!;
    const swaps = await fetchFomoSwaps('fomo-user-id-1');
    assert.match(requestUrl, /\/v2\/users\/fomo-user-id-1\/swaps\?limit=100$/);
    assert.equal(authorization, 'Bearer test-key');
    assert.equal(swaps.outcome, 'success');
    assert.equal(swaps.attempts, 1);
    assert.equal(swaps.creditsCost, 2);
    assert.equal(swaps.value?.length, 1);
    assert.deepEqual(swaps.value?.[0], swap());
    const swapsAfter = getFomoApiUsageSnapshot().endpoints.find((item) => item.endpoint === 'swaps')!;
    assert.equal(swapsAfter.operations - swapsBefore.operations, 1);
    assert.equal(swapsAfter.successes - swapsBefore.successes, 1);
    assert.equal(swapsAfter.creditsCost - swapsBefore.creditsCost, 2);
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
      globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).endsWith('/status')) return healthResponse();
        return new Response(JSON.stringify({ swaps: [candidate], ...completeness }), { status: 200 });
      }) as typeof fetch;
      const result = await fetchFomoSwaps('aki11a');
      assert.equal(result.value, null);
      assert.equal(result.outcome, 'partial' in completeness ? 'incomplete' : 'no_data');
    }
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});

test('fetchFomoPositions reads only the first positions page', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://fomo.test';
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/status')) return healthResponse();
    return new Response(JSON.stringify({
      trades: [
        {
          chain: 'solana',
          token: { address: CA },
          tradeId: TRADE_ID,
          status: 'open',
          amount: 5,
          costBasisUsd: 25,
          priceUsd: 6,
        },
        {
          chain: 'base',
          token: { address: '0x1000000000000000000000000000000000000001' },
          status: 'closed',
          amount: 7,
        },
      ],
      cursor: 'older-closed-positions',
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await fetchFomoPositions('aki11a');
    const positionRequests = requests.filter((url) => url.endsWith('/positions'));
    assert.equal(positionRequests.length, 1);
    assert.match(positionRequests[0]!, /\/v2\/users\/aki11a\/positions$/);
    assert.equal(result.outcome, 'success');
    assert.deepEqual(result.value, [
      {
        ca: CA,
        chain: 'sol',
        tradeId: TRADE_ID,
        status: 'open',
        amount: 5,
        costBasisUsd: 25,
        avgEntryPrice: null,
        priceUsd: 6,
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
      },
      {
        ca: '0x1000000000000000000000000000000000000001',
        chain: 'base',
        tradeId: null,
        status: 'closed',
        amount: 0,
        costBasisUsd: null,
        avgEntryPrice: null,
        priceUsd: null,
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
      },
    ]);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});
test('fetchFomoPositions classifies no-data, incomplete, and invalid snapshots', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://fomo.test';
  const position = { chain: 'solana', token: { address: CA }, status: 'open', amount: 3 };
  try {
    for (const payload of [
      { trades: [], available: false, expected: 'no_data' },
      { trades: [position], partial: true, expected: 'incomplete' },
      { trades: [position], truncated: true, expected: 'incomplete' },
      { trades: [{ ...position, amount: null }], expected: 'invalid_payload' },
      { trades: [position, position], expected: 'invalid_payload' },
    ]) {
      globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).endsWith('/status')) return healthResponse();
        const { expected: _expected, ...body } = payload;
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch;
      const result = await fetchFomoPositions('aki11a');
      assert.equal(result.value, null);
      assert.equal(result.outcome, payload.expected);
    }
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});

test('FOMO health-down skips the paid request', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://health-down.fomo.test';
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return healthResponse('down', 'operational');
  }) as typeof fetch;
  try {
    const result = await fetchFomoPositions('stable-fomo-id');
    assert.equal(result.outcome, 'upstream_down');
    assert.equal(result.attempts, 0);
    assert.deepEqual(requests, ['https://health-down.fomo.test/status']);
    assert.equal(getFomoApiUsageSnapshot().upstream.apiStatus, 'down');
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});

test('FOMO 429 honors Retry-After without inline retry and captures credits', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://rate-limited.fomo.test';
  let paidAttempts = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/status')) return healthResponse();
    paidAttempts++;
    return new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '3', 'x-credits-cost': '0.5' },
    });
  }) as typeof fetch;
  try {
    const result = await fetchFomoSwaps('stable-fomo-id');
    assert.equal(result.outcome, 'rate_limited');
    assert.equal(result.attempts, 1);
    assert.equal(result.attemptFailures, 1);
    assert.equal(result.retryAfterMs, 3_000);
    assert.equal(result.creditsCost, 0.5);
    assert.equal(paidAttempts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});

test('degraded FOMO health bounds a 503 to one paid attempt and preserves Retry-After', async () => {
  const oldKey = config.fomoApiKey;
  const oldBase = config.fomoApiBase;
  const oldFetch = globalThis.fetch;
  config.fomoApiKey = 'test-key';
  config.fomoApiBase = 'https://degraded.fomo.test';
  let paidAttempts = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/status')) return healthResponse('operational', 'degraded');
    paidAttempts++;
    return new Response('unavailable', { status: 503, headers: { 'retry-after': '5' } });
  }) as typeof fetch;
  try {
    const result = await fetchFomoPositions('stable-fomo-id');
    assert.equal(result.outcome, 'http_error');
    assert.equal(result.attempts, 1);
    assert.equal(result.retryAfterMs, 5_000);
    assert.equal(paidAttempts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoApiKey = oldKey;
    config.fomoApiBase = oldBase;
  }
});
