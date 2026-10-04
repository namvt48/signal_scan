// Todo 15 + bug3 — gateway fail-open, and per-CA errors no longer abort a pass.
//
// Wire shape (todo 3): an upstream non-2xx arrives as HTTP 200 + `envelope.status`;
// the ONLY non-200 replies are GATEWAY-GENERATED denials (401/400/429 budget/503 gated).
// Fail-open applies ONLY to a TRANSPORT failure (gateway unreachable) — that still SKIPS
// the whole sweep. A per-CA typed error (upstream non-2xx, or a gateway denial such as
// 429 budget) is LOGGED and the pass CONTINUES to the next CA (bug3); a budget denial is
// still NEVER retried. Driven through the REAL GmgnMarketProvider + GatewayClient so
// transport typing and poller error handling are exercised end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricSweep } from '../../src/poller.js';
import { open } from '../../src/db.js';
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

test('bug3: an upstream non-2xx (envelope.status 400) is logged per-CA and does NOT abort the pass', async () => {
  open(':memory:');
  const provider = gmgnVia((async () =>
    jsonResponse(200, { status: 400, body: null, headers: {} })) as unknown as typeof fetch);

  const seen: unknown[][] = [];
  const origError = log.error;
  log.error = (...args: unknown[]) => {
    seen.push(args);
  };
  let threw: unknown;
  try {
    await metricSweep(provider, 'volume', 500, target);
  } catch (e) {
    threw = e;
  } finally {
    log.error = origError;
  }

  assert.equal(threw, undefined, `the sweep must not abort on a per-CA error, but threw: ${String(threw)}`);
  const logged = seen.find((a) => a.some((x) => x instanceof HttpError && x.status === 400));
  assert.ok(logged, `the upstream 400 must still be logged as an HttpError: ${JSON.stringify(seen)}`);
});

test('bug3: a gateway 429 budget denial is logged, NEVER retried, and does NOT abort the pass', async () => {
  open(':memory:');
  let calls = 0;
  const provider = gmgnVia((async () => {
    calls += 1;
    return jsonResponse(429, { error: 'budget_exceeded' });
  }) as unknown as typeof fetch);

  const seen: unknown[][] = [];
  const origError = log.error;
  log.error = (...args: unknown[]) => {
    seen.push(args);
  };
  let threw: unknown;
  try {
    await metricSweep(provider, 'essential', 500, target);
  } catch (e) {
    threw = e;
  } finally {
    log.error = origError;
  }

  assert.equal(threw, undefined, 'a budget denial must not abort the whole sweep');
  assert.equal(calls, 1, 'the gateway budget denial must never be retried');
  assert.ok(seen.length > 0, 'the denial must still be logged');
});

test('bug3: one failing CA does not stop the pass — the next CA is still swept', async () => {
  open(':memory:');
  let calls = 0;
  const provider = gmgnVia((async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(200, { status: 400, body: null, headers: {} })
      : jsonResponse(200, { status: 200, body: JSON.stringify({ code: 0, data: {} }), headers: {} });
  }) as unknown as typeof fetch);

  const two = [
    { address: 'CA-BAD-111111111111111111111111111111111', chain: 'sol' as const },
    { address: 'CA-GOOD-22222222222222222222222222222222', chain: 'sol' as const },
  ];
  const warns: unknown[][] = [];
  const origError = log.error;
  const origWarn = log.warn;
  log.error = () => {};
  log.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  let threw: unknown;
  try {
    await metricSweep(provider, 'volume', 500, two);
  } catch (e) {
    threw = e;
  } finally {
    log.error = origError;
    log.warn = origWarn;
  }

  assert.equal(threw, undefined, 'the pass must survive a failing CA');
  assert.equal(calls, 2, 'the CA after the failing one must still be swept');
  assert.ok(
    warns.some((a) => String(a[0]).includes('1 CA error(s)')),
    `expected a one-line pass summary: ${JSON.stringify(warns)}`,
  );
});
