import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import {
  fetchFomoFollowingPage,
  fetchFomoUserProfile,
  fetchFomoBalances,
  fetchFomoSwaps,
  fetchFomoTradeDetail,
  getFomoApiUsageSnapshot,
  matchFomoBuySwap,
  matchFomoBuySwaps,
  type FomoSwap,
} from '../src/fomo-api.js';

const CA = '6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr';
const TRADE_ID = 'a09f56a5-975b-45e2-b71e-17c7080c8b0f';
const TS = Date.parse('2026-10-08T06:47:35.000Z');
const NET_SOL = 1399811149;
const NET_BASE = 8453;
const NET_ETH = 1;
const ETH_CA = '0x2000000000000000000000000000000000000002';
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function swap(overrides: Partial<FomoSwap> = {}): FomoSwap {
  return {
    id: 'swap-1',
    chain: 'sol',
    at: TS,
    tradeIdOut: TRADE_ID,
    tokenIn: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', usd: 9950.06 },
    tokenOut: { address: CA, usd: 9950.06 },
    ...overrides,
  };
}

async function withBridge(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  // A unique base bypasses the 15s health cache shared between tests.
  config.fomoProdUrl = `https://bridge-${Math.random().toString(36).slice(2)}.test`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return handler(url, init);
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
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

test('fetchFomoSwaps parses the prod envelope and flat swap shape', async () => {
  let requestUrl = '';
  let authorization: string | null = 'unset';
  await withBridge((url, init) => {
    requestUrl = url;
    authorization = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({
      success: true,
      responseObject: {
        swaps: [{
          id: 'swap-1',
          inTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          inAmount: '9950060000',
          inHumanAmount: '9950.06',
          outTokenAddress: CA,
          outAmount: '16312000000',
          outHumanAmount: '16312',
          humanUsdAmountIn: 9950.06,
          humanUsdAmountOut: 9950.06,
          createdAt: TS,
          outTradeId: TRADE_ID,
          networkId: NET_SOL,
          outNetworkId: NET_SOL,
        }, {
          id: 'swap-eth',
          inTokenAddress: ETH_USDC,
          outTokenAddress: ETH_CA,
          humanUsdAmountIn: 50,
          humanUsdAmountOut: 50,
          createdAt: TS,
          outTradeId: 'eth-trade',
          networkId: NET_ETH,
          outNetworkId: NET_ETH,
        }, {
          id: 'swap-unsupported',
          inTokenAddress: '0xusdc',
          outTokenAddress: '0xother',
          humanUsdAmountIn: 1,
          humanUsdAmountOut: 1,
          createdAt: TS,
          outNetworkId: 137,
        }],
        hasNextPage: false,
      },
    }), { status: 200 });
  }, async () => {
    const swappedBefore = getFomoApiUsageSnapshot().endpoints.find((item) => item.endpoint === 'swaps')!;
    const result = await fetchFomoSwaps('fomo-user-id-1');
    assert.match(requestUrl, /\/v2\/users\/fomo-user-id-1\/swaps\?limit=100$/);
    assert.equal(authorization, null);
    assert.equal(result.outcome, 'success');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.value, [swap(), swap({
      id: 'swap-eth',
      chain: 'eth',
      tradeIdOut: 'eth-trade',
      tokenIn: { address: ETH_USDC, usd: 50 },
      tokenOut: { address: ETH_CA, usd: 50 },
    })]);
    const swappedAfter = getFomoApiUsageSnapshot().endpoints.find((item) => item.endpoint === 'swaps')!;
    assert.equal(swappedAfter.operations - swappedBefore.operations, 1);
    assert.equal(swappedAfter.successes - swappedBefore.successes, 1);
  });
});

test('fetchFomoTradeDetail reads an open aggregated position', async () => {
  let requestUrl = '';
  await withBridge((url) => {
    requestUrl = url;
    return new Response(JSON.stringify({
      success: true,
      responseObject: {
        trade: {
          id: TRADE_ID,
          tokenAddress: CA,
          networkId: NET_SOL,
          humanTokenAmount: '28624504.17',
          avgEntryPrice: 0.00061,
          realizedPnlUsd: 12,
          closedAt: null,
        },
      },
    }), { status: 200 });
  }, async () => {
    const detail = await fetchFomoTradeDetail(TRADE_ID);
    assert.match(requestUrl, new RegExp(`/trades/${TRADE_ID}$`));
    assert.deepEqual(detail, {
      tradeId: TRADE_ID,
      ca: CA,
      chain: 'sol',
      amount: 28624504.17,
      costBasisUsd: 28624504.17 * 0.00061,
      avgEntryPrice: 0.00061,
      realizedPnlUsd: 12,
      closed: false,
    });
  });
});

test('fetchFomoTradeDetail treats a closed trade or a zero amount as closed', async () => {
  await withBridge(() => new Response(JSON.stringify({
    success: true,
    responseObject: {
      trade: {
        id: TRADE_ID,
        tokenAddress: CA,
        networkId: NET_SOL,
        humanTokenAmount: '10',
        avgEntryPrice: 0.5,
        closedAt: '2026-10-22T15:11:50Z',
      },
    },
  }), { status: 200 }), async () => {
    const detail = await fetchFomoTradeDetail(TRADE_ID);
    assert.equal(detail?.closed, true);
  });
  await withBridge(() => new Response(JSON.stringify({
    success: true,
    responseObject: {
      trade: {
        id: TRADE_ID,
        tokenAddress: CA,
        networkId: NET_SOL,
        humanTokenAmount: '0',
        closedAt: null,
      },
    },
  }), { status: 200 }), async () => {
    const detail = await fetchFomoTradeDetail(TRADE_ID);
    assert.equal(detail?.closed, true);
    assert.equal(detail?.amount, 0);
  });
});

test('fetchFomoSwaps sends no auth header and leaves unavailable pages unresolved', async () => {
  await withBridge(() => new Response(JSON.stringify({
    success: true,
    responseObject: { swaps: [], available: false },
  }), { status: 200 }), async () => {
    const result = await fetchFomoSwaps('fomo-user-id');
    assert.equal(result.outcome, 'no_data');
    assert.equal(result.value, null);
  });
  await withBridge(() => new Response(JSON.stringify({ success: false }), { status: 200 }), async () => {
    const result = await fetchFomoSwaps('fomo-user-id');
    assert.equal(result.outcome, 'invalid_payload');
    assert.equal(result.value, null);
  });
});

test('fetchFomoBalances maps prod balances to active positions', async () => {
  await withBridge(() => new Response(JSON.stringify({
    success: true,
    responseObject: {
      balances: [{
        balance: { tokenAddress: CA, balance: '28624504170000', shiftedBalance: '28624504.17' },
        tokenFilterResult: {
          priceUSD: '0.00061',
          token: { address: CA, decimals: 6, networkId: NET_SOL },
        },
        userToken: {
          humanAmountRemaining: '28624504.17',
          totalCostBasisUsd: 17982.81,
          averageEntryPriceUsd: 0.000628,
          totalRealizedPnlUsd: 12.5,
        },
        activeTrade: { id: TRADE_ID, avgEntryPrice: 0.000628, networkId: NET_SOL },
      }, {
        tokenFilterResult: {
          priceUSD: '1',
          token: { address: '0x1000000000000000000000000000000000000001', networkId: NET_BASE },
        },
        userToken: { humanAmountRemaining: '7', currentCostBasisUsd: 7 },
      }, {
        tokenFilterResult: {
          priceUSD: '1',
          token: { address: ETH_CA, networkId: NET_ETH },
        },
        userToken: { humanAmountRemaining: '2' },
      }, {
        tokenFilterResult: { token: { address: '0xunsupported', networkId: 137 } },
        userToken: { humanAmountRemaining: '1' },
      }],
    },
  }), { status: 200 }), async () => {
    const result = await fetchFomoBalances('fomo-user-id');
    assert.equal(result.outcome, 'success');
    assert.deepEqual(result.value, [{
      ca: CA,
      chain: 'sol',
      tradeId: TRADE_ID,
      status: 'active',
      amount: 28624504.17,
      costBasisUsd: 17982.81,
      avgEntryPrice: 0.000628,
      priceUsd: 0.00061,
      realizedPnlUsd: 12.5,
      unrealizedPnlUsd: null,
    }, {
      ca: '0x1000000000000000000000000000000000000001',
      chain: 'base',
      tradeId: null,
      status: 'active',
      amount: 7,
      costBasisUsd: 7,
      avgEntryPrice: null,
      priceUsd: 1,
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
    }, {
      ca: ETH_CA,
      chain: 'eth',
      tradeId: null,
      status: 'active',
      amount: 2,
      costBasisUsd: null,
      avgEntryPrice: null,
      priceUsd: 1,
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
    }]);
  });
});

test('fetchFomoBalances falls back to a non-negative shifted balance for dust', async () => {
  await withBridge(() => new Response(JSON.stringify({
    success: true,
    responseObject: { balances: [{
      balance: { tokenAddress: CA, shiftedBalance: '8.28' },
      tokenFilterResult: { token: { address: CA, networkId: NET_SOL } },
      userToken: { humanAmountRemaining: '-2.76' },
    }] },
  }), { status: 200 }), async () => {
    const result = await fetchFomoBalances('fomo-user-id');
    assert.equal(result.outcome, 'success');
    assert.equal(result.complete, true);
    assert.equal(result.value?.[0]?.amount, 8.28);
  });
});

test('fetchFomoBalances marks a full 100-row page as possibly truncated', async () => {
  const balances = Array.from({ length: 100 }, (_, index) => ({
    tokenFilterResult: { token: { address: `0x${(index + 1).toString(16).padStart(40, '0')}`, networkId: NET_BASE } },
    userToken: { humanAmountRemaining: '1' },
  }));
  await withBridge(() => new Response(JSON.stringify({
    success: true,
    responseObject: { balances },
  }), { status: 200 }), async () => {
    const result = await fetchFomoBalances('fomo-user-id');
    assert.equal(result.outcome, 'success');
    assert.equal(result.value?.length, 100);
    assert.equal(result.complete, false);
  });
});

test('fetchFomoBalances rejects missing, negative, or duplicate amounts', async () => {
  for (const payload of [
    { balances: [{ tokenFilterResult: { token: { address: CA } }, userToken: { humanAmountRemaining: '1' } }] },
    { balances: [{ tokenFilterResult: { token: { address: CA, networkId: NET_SOL } }, userToken: {} }] },
    { balances: [{ tokenFilterResult: { token: { address: CA, networkId: NET_SOL } }, userToken: { humanAmountRemaining: '-1' } }] },
    { balances: [
      { tokenFilterResult: { token: { address: CA, networkId: NET_SOL } }, userToken: { humanAmountRemaining: '1' } },
      { tokenFilterResult: { token: { address: CA, networkId: NET_SOL } }, userToken: { humanAmountRemaining: '2' } },
    ] },
  ]) {
    await withBridge(() => new Response(JSON.stringify({ success: true, responseObject: payload }), { status: 200 }), async () => {
      const result = await fetchFomoBalances('fomo-user-id');
      assert.equal(result.outcome, 'invalid_payload');
      assert.equal(result.value, null);
    });
  }
});

test('FOMO health-down skips the bridge request', async () => {
  const oldUrl = config.fomoProdUrl;
  const oldFetch = globalThis.fetch;
  config.fomoProdUrl = 'https://health-down-bridge.test';
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ ok: false, tokenExpiresAt: '2026-10-22T00:00:00.000Z' }), { status: 503 });
  }) as typeof fetch;
  try {
    const result = await fetchFomoBalances('stable-fomo-id');
    assert.equal(result.outcome, 'upstream_down');
    assert.equal(result.attempts, 0);
    assert.deepEqual(requests, ['https://health-down-bridge.test/health']);
    assert.equal(getFomoApiUsageSnapshot().upstream.apiStatus, 'down');
  } finally {
    globalThis.fetch = oldFetch;
    config.fomoProdUrl = oldUrl;
  }
});

test('FOMO 429 honors Retry-After without inline retry', async () => {
  let bridgeAttempts = 0;
  await withBridge(() => {
    bridgeAttempts++;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '3' } });
  }, async () => {
    const result = await fetchFomoSwaps('stable-fomo-id');
    assert.equal(result.outcome, 'rate_limited');
    assert.equal(result.attempts, 1);
    assert.equal(result.attemptFailures, 1);
    assert.equal(result.retryAfterMs, 3_000);
    assert.equal(bridgeAttempts, 1);
  });
});

test('FOMO guard denial remains blocked and makes one request despite operational health', async () => {
  let bridgeAttempts = 0;
  await withBridge((url) => {
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    bridgeAttempts++;
    return new Response(JSON.stringify({ error: { code: 'suspended' } }), {
      status: 403,
      headers: { 'x-fomo-guard': 'suspended', 'x-fomo-retry-handled': '1' },
    });
  }, async () => {
    const result = await fetchFomoBalances('stable-fomo-id');
    assert.equal(result.outcome, 'guard_blocked');
    assert.equal(result.value, null);
    assert.equal(result.status, 403);
    assert.equal(result.attempts, 1);
    assert.equal(bridgeAttempts, 1);
  });
});

test('FOMO bridge Retry-After preserves 120 seconds and HTTP-date', async () => {
  await withBridge(() => new Response('rate limited', {
    status: 429, headers: { 'retry-after': '120', 'x-fomo-retry-handled': '1' },
  }), async () => {
    const result = await fetchFomoSwaps('stable-fomo-id');
    assert.equal(result.outcome, 'rate_limited');
    assert.equal(result.retryAfterMs, 120_000);
    assert.equal(result.attempts, 1);
  });
  const target = new Date(Date.now() + 120_000);
  await withBridge(() => new Response('rate limited', {
    status: 429,
    headers: { 'retry-after': target.toUTCString(), 'x-fomo-retry-handled': '1' },
  }), async () => {
    const result = await fetchFomoSwaps('stable-fomo-id');
    assert.ok((result.retryAfterMs ?? 0) > 0);
    assert.ok((result.retryAfterMs ?? 0) <= 120_000);
  });
});

test('FOMO 503 without Retry-After is not retried by the bridge consumer', async () => {
  let bridgeAttempts = 0;
  await withBridge(() => {
    bridgeAttempts++;
    return new Response('unavailable', { status: 503, headers: { 'x-fomo-retry-handled': '1' } });
  }, async () => {
    const result = await fetchFomoSwaps('stable-fomo-id');
    assert.equal(result.outcome, 'http_error');
    assert.equal(result.attempts, 1);
    assert.equal(result.attemptFailures, 1);
    assert.equal(bridgeAttempts, 1);
  });
});

test('following page sends cursor and parses stable user identity', async () => {
  let requested = '';
  await withBridge((url) => {
    requested = url;
    return new Response(JSON.stringify({ success: true, responseObject: { users: [
      { id: 'user-2', userHandle: 'Second', displayName: 'Second User', private: false },
    ] } }), { status: 200 });
  }, async () => {
    const result = await fetchFomoFollowingPage('owner-id', 'cursor-id');
    assert.equal(new URL(requested).pathname, '/v2/users/owner-id/followingPaginate');
    assert.equal(new URL(requested).searchParams.get('lastId'), 'cursor-id');
    assert.equal(result.ok, true);
    assert.deepEqual(result.users, [{ id: 'user-2', handle: 'Second', displayName: 'Second User', private: false }]);
  });
});

test('owner profile requires a valid following count for completeness checks', async () => {
  await withBridge(() => new Response(JSON.stringify({ success: true, responseObject: {
    id: 'owner-id', userHandle: 'ItsAlita', private: false, following: 160,
  } }), { status: 200 }), async () => {
    const result = await fetchFomoUserProfile('owner-id');
    assert.equal(result.ok, true);
    assert.equal(result.profile?.following, 160);
  });
  await withBridge(() => new Response(JSON.stringify({ success: true, responseObject: {
    id: 'owner-id', userHandle: 'ItsAlita', private: false, following: '160',
  } }), { status: 200 }), async () => {
    const result = await fetchFomoUserProfile('owner-id');
    assert.equal(result.ok, true);
    assert.equal(result.profile?.following, null);
  });
});
