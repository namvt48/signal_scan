// Todo 15 — gateway fail-open vs typed-error surfacing.
//
// Wire shape (todo 3): an upstream non-2xx arrives as HTTP 200 + `envelope.status`;
// the ONLY non-200 replies are GATEWAY-GENERATED denials (401/400/429 budget/503 gated).
// Fail-open applies ONLY to a TRANSPORT failure (gateway unreachable). An upstream
// non-2xx and a budget 429 are real typed errors and MUST surface; the budget 429 is
// NEVER retried. The sweep is driven through the REAL GmgnMarketProvider + GatewayClient
// so the transport typing and the poller's error handling are both exercised end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricSweep } from '../../src/poller.js';
import { log } from '../../src/log.js';
import { GatewayClient, GatewayTransportError } from '../../src/gateway-client.js';
import { GmgnMarketProvider } from '../../src/providers/gmgn.js';
import { HttpError } from '../../src/ratelimit/types.js';
import type { MarketDataProvider } from '../../src/providers/provider.js';

const CA = 'CA-FAILOPEN-111111111111111111111111111111';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A MarketDataProvider whose `metric` is the REAL GmgnMarketProvider → a real
 *  GatewayClient with the injected fetch (the production transport). */
function gmgnVia(fetchImpl: typeof fetch): MarketDataProvider {
  const gateway = new GatewayClient({ baseUrl: 'http://gateway:8130', callerToken: 'tok', fetchImpl });
  const gmgn = new GmgnMarketProvider('', gateway);
  return {
    name: 'gmgn',
    tokenInfo: () => Promise.reject(new Error('unused')),
    metric: (ca, chain, kind) => gmgn.metric(ca, chain, kind),
    walletTokenHoldings: async () => [],
  };
}

const target = [{ address: CA, chain: 'sol' as const }];

test('todo15: a fetch rejection is typed GatewayTransportError (the fail-open input)', async () => {
  const gateway = new GatewayClient({
    baseUrl: 'http://gateway:8130',
    callerToken: 'tok',
    fetchImpl: (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  });
  await assert.rejects(gateway.call('/v1/x', {}), (e: unknown) => e instanceof GatewayTransportError);
});

test('todo15: gateway UNREACHABLE → the sweep completes without throwing and warns', async () => {
  const provider = gmgnVia((async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch);

  const warns: unknown[][] = [];
  const origWarn = log.warn;
  log.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  let threw: unknown;
  try {
    await metricSweep(provider, 'volume', 60_000, target);
  } catch (e) {
    threw = e;
  } finally {
    log.warn = origWarn;
  }

  assert.equal(threw, undefined, `the sweep must fail open, but threw: ${String(threw)}`);
  assert.ok(
    warns.some((a) => String(a[0]).includes('gateway unreachable')),
    `no fail-open warning logged: ${JSON.stringify(warns)}`,
  );
});

test('todo15: upstream non-2xx (HTTP 200 + envelope.status 400) → the typed error IS raised', async () => {
  const provider = gmgnVia((async () =>
    jsonResponse(200, { status: 400, body: null, headers: {} })) as unknown as typeof fetch);

  await assert.rejects(
    metricSweep(provider, 'volume', 60_000, target),
    (e: unknown) => e instanceof HttpError && e.status === 400,
    'an upstream non-2xx must NOT be swallowed',
  );
});

test('todo15: gateway 429 {error:budget_exceeded} → typed error IS raised and NEVER retried', async () => {
  let calls = 0;
  const provider = gmgnVia((async () => {
    calls += 1;
    return jsonResponse(429, { error: 'budget_exceeded' });
  }) as unknown as typeof fetch);

  await assert.rejects(
    // `essential` is the withRetry path — the budget denial must break out with ONE call.
    metricSweep(provider, 'essential', 60_000, target),
    (e: unknown) => e instanceof HttpError && e.status === 429,
    'a gateway budget denial must surface as a typed error',
  );
  assert.equal(calls, 1, 'the gateway budget denial must never be retried');
});
