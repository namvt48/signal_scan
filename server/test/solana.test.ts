import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCreditExhausted,
  parseAssetInfo,
  parseAssetSymbol,
  parseRpcEndpoints,
  parseTokenAccounts,
  SPL_TOKEN_PROGRAM_ID,
  SolanaRpcClient,
  TOKEN_2022_PROGRAM_ID,
} from '../src/providers/solana.js';
import { config } from '../src/config.js';

function account(mint: string, tokenAmount: Record<string, unknown>): unknown {
  return { account: { data: { parsed: { info: { mint, tokenAmount } } } } };
}

function value(accounts: unknown[]): unknown {
  return { jsonrpc: '2.0', id: 1, result: { value: accounts } };
}

test('parseRpcEndpoints: comma/whitespace separated list, empties dropped', () => {
  assert.deepEqual(parseRpcEndpoints('https://a , https://b\nhttps://c'), ['https://a', 'https://b', 'https://c']);
  assert.deepEqual(parseRpcEndpoints('  '), []);
});

test('parseTokenAccounts: uiAmountString primary, uiAmount null ignored, decimals fallback, same mint summed', () => {
  const m = parseTokenAccounts(
    value([
      account('mintA', { uiAmountString: '12.5', amount: '12500000', decimals: 6 }),
      // uiAmount is null on these payloads — must never be read
      account('mintA', { uiAmount: null, uiAmountString: '7.5', amount: '7500000', decimals: 6 }),
      account('mintB', { uiAmount: null, amount: '3000000', decimals: 6 }), // no uiAmountString → 3
      account('mintZero', { uiAmountString: '0', amount: '0', decimals: 0 }), // dropped
      { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: '1' } } } } } }, // no mint → dropped
      { account: { data: { parsed: {} } } }, // junk → dropped
    ]),
  );
  assert.equal(m.size, 2);
  assert.equal(m.get('mintA'), 20); // 12.5 + 7.5 (SUM, not [0])
  assert.equal(m.get('mintB'), 3);
  assert.equal(m.has('mintZero'), false);
  assert.equal(m.has(undefined as unknown as string), false);
});

test('parseTokenAccounts: malformed body throws instead of returning an empty (wallet-hiding) result', () => {
  for (const bad of [null, {}, { result: null }, { result: {} }, { result: { value: 'nope' } }, { error: { code: -32602 } }]) {
    assert.throws(() => parseTokenAccounts(bad), /malformed/);
  }
});

test('parseTokenAccounts: a non-empty list with no parsed info throws (never a silent empty result)', () => {
  // Node returns raw base64 `data` (no `parsed`) for accounts its parser cannot
  // handle; an empty Map here would make the caller DELETE the wallet's holdings.
  assert.throws(
    () =>
      parseTokenAccounts({
        jsonrpc: '2.0',
        id: 1,
        result: { value: [{ account: { data: ['BASE64', 'base64'] } }, { account: { data: ['BASE64', 'base64'] } }] },
      }),
    /no parsed token info/,
  );
});

test('parseTokenAccounts: an empty value array is a legitimate empty result (no throw)', () => {
  const m = parseTokenAccounts({ jsonrpc: '2.0', id: 1, result: { value: [] } });
  assert.equal(m.size, 0);
});

test('SolanaRpcClient: sends both programIds, falls back to the next endpoint, counts one request per call', async () => {
  const origFetch = globalThis.fetch;
  const hits: { url: string; body: { params: unknown[] } }[] = [];
  try {
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { params: unknown[] };
      hits.push({ url: String(url), body });
      if (String(url).includes('dead')) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(value([account('mintA', { uiAmountString: '5', amount: '5', decimals: 0 })])) as string, { status: 200 });
    }) as typeof fetch;

    const client = new SolanaRpcClient(['https://dead.example', 'https://live.example']);
    const m = await client.getTokenAccountsByOwner('WALLET', TOKEN_2022_PROGRAM_ID);
    assert.equal(m.get('mintA'), 5);
    // 2 requests for ONE logical call: the dead endpoint then the live one.
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.url, 'https://dead.example');
    assert.equal(hits[1]?.url, 'https://live.example');
    assert.equal(hits[1]?.body.params[0], 'WALLET');
    assert.deepEqual(hits[1]?.body.params[1], { programId: TOKEN_2022_PROGRAM_ID });
    assert.deepEqual(hits[1]?.body.params[2], { encoding: 'jsonParsed' });
    assert.notEqual(SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: JSON-RPC error and every-endpoint failure throw (no silent empty result)', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: -32602, message: 'blocked' } }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      new SolanaRpcClient(['https://rpc.example']).getTokenAccountsByOwner('J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa', SPL_TOKEN_PROGRAM_ID),
      /solana rpc getTokenAccountsByOwner failed \(J6TDXv\)/,
    );
    // the error names the truncated wallet only — never the endpoint (may carry a token)
    await assert.rejects(
      new SolanaRpcClient(['https://rpc.example']).getTokenAccountsByOwner('WALLETABC', SPL_TOKEN_PROGRAM_ID),
      (e: Error) => !e.message.includes('rpc.example'),
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: getTokenAccountsByOwner sends {mint} for ONE pair and {programId} for a whole-program scan', async () => {
  const origFetch = globalThis.fetch;
  const filters: unknown[] = [];
  try {
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { params: [string, unknown] };
      filters.push(body.params[1]);
      return new Response(JSON.stringify(value([account('mintA', { uiAmountString: '5', amount: '5', decimals: 0 })])), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new SolanaRpcClient(['https://rpc.example']);
    await client.getTokenAccountsByOwner('WALLET', { mint: 'MINT1' });
    await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.deepEqual(filters, [{ mint: 'MINT1' }, { programId: SPL_TOKEN_PROGRAM_ID }]);
});

test('SolanaRpcClient: a syntactically invalid endpoint never leaks the URL/token into the rejection', async () => {
  // Node's fetch throws `TypeError: Failed to parse URL from <raw url>` for this
  // input, so the raw error string would echo the token-bearing endpoint.
  await assert.rejects(
    new SolanaRpcClient(['not-a-url-with-SECRETTOKEN123']).getTokenAccountsByOwner('WALLETABC', SPL_TOKEN_PROGRAM_ID),
    (e: Error) => !e.message.includes('SECRETTOKEN123') && !e.message.includes('not-a-url'),
  );
});

test('parseAssetSymbol: reads result.content.metadata.symbol, trimmed; empty/absent/non-string → undefined', () => {
  const body = (symbol: unknown) => ({ jsonrpc: '2.0', id: 1, result: { content: { metadata: { symbol } } } });
  assert.equal(parseAssetSymbol(body('BONK')), 'BONK');
  assert.equal(parseAssetSymbol(body('  BONK ')), 'BONK');
  for (const bad of [undefined, null, '', '   ', 42, {}]) assert.equal(parseAssetSymbol(body(bad)), undefined, String(bad));
  for (const bad of [null, {}, { result: null }, { result: { content: {} } }, { error: { code: -32601 } }]) {
    assert.equal(parseAssetSymbol(bad), undefined);
  }
});

test('parseAssetInfo: DAS raw supply → UI units (÷10^decimals); non-positive/absent omitted, never 0', () => {
  const body = (tokenInfo: unknown) => ({
    jsonrpc: '2.0',
    id: 1,
    result: { content: { metadata: { symbol: 'TIT' } }, token_info: tokenInfo },
  });
  const real = parseAssetInfo(body({ supply: '972680569746476', decimals: 6, price_info: { price_per_token: 0.000016726446 } }));
  assert.equal(real.symbol, 'TIT');
  assert.ok(Math.abs((real.supply ?? 0) - 972680569.746476) < 1e-6, String(real.supply));
  assert.equal(real.price, 0.000016726446);
  assert.equal(parseAssetInfo(body({ supply: 1500000, decimals: 6 })).supply, 1.5);
  assert.equal(parseAssetInfo(body({ supply: 7, decimals: 0 })).supply, 7);
  assert.deepEqual(parseAssetInfo(body(undefined)), { symbol: 'TIT' });
  assert.deepEqual(parseAssetInfo(body({ supply: 0, decimals: 6, price_info: { price_per_token: 0 } })), { symbol: 'TIT' });
  assert.deepEqual(parseAssetInfo(body({ supply: 'nope', decimals: 6 })), { symbol: 'TIT' });
  assert.deepEqual(parseAssetInfo(body({ supply: 100, decimals: 99 })), { symbol: 'TIT' });
  for (const bad of [null, {}, { result: null }, { error: { code: -32601 } }]) assert.deepEqual(parseAssetInfo(bad), {});
});

test('getAssetInfo: sends getAsset{id}, falls through a dead endpoint, returns symbol+supply+price', async () => {
  const origFetch = globalThis.fetch;
  const hits: { url: string; body: { method: string; params: unknown } }[] = [];
  try {
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      hits.push({ url: String(url), body });
      if (String(url).includes('dead')) return new Response('nope', { status: 503 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: { metadata: { symbol: 'PUMP' } },
            token_info: { supply: 1000000, decimals: 6, price_info: { price_per_token: 0.25 } },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    assert.deepEqual(await new SolanaRpcClient(['https://dead.example', 'https://live.example']).getAssetInfo('MintX'), {
      symbol: 'PUMP',
      supply: 1,
      price: 0.25,
    });
    assert.equal(hits.length, 2);
    assert.equal(hits[1]?.body.method, 'getAsset');
    assert.deepEqual(hits[1]?.body.params, { id: 'MintX' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('getAssetInfo: non-DAS endpoint / every-endpoint failure resolves {} instead of throwing', async () => {
  // Bare public mainnet answers -32601; must resolve {}, NOT reject.
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: -32601, message: 'Method not found' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    assert.deepEqual(await new SolanaRpcClient(['https://rpc.example']).getAssetInfo('MintX'), {});

    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    assert.deepEqual(await new SolanaRpcClient(['https://rpc.example']).getAssetInfo('MintX'), {});
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: a 429 is retried on the SAME endpoint (backoff), then succeeds', async () => {
  const origFetch = globalThis.fetch;
  let hits = 0;
  try {
    globalThis.fetch = (async () => {
      hits += 1;
      if (hits < 3) return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify(value([account('mintA', { uiAmountString: '5', amount: '5', decimals: 0 })])) as string, {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const m = await new SolanaRpcClient(['https://rpc.example'], 5_000, 0, [1, 1]).getTokenAccountsByOwner(
      'WALLET',
      SPL_TOKEN_PROGRAM_ID,
    );
    assert.equal(m.get('mintA'), 5);
    assert.equal(hits, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: concurrent calls are spaced (no burst), and a persistent 429 rejects with the status but never the token', async () => {
  const origFetch = globalThis.fetch;
  try {
    const starts: number[] = [];
    globalThis.fetch = (async () => {
      starts.push(Date.now());
      return new Response(JSON.stringify(value([])) as string, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new SolanaRpcClient(['https://rpc.example'], 5_000, 40);
    await Promise.all([
      client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID),
      client.getTokenAccountsByOwner('WALLET', TOKEN_2022_PROGRAM_ID),
    ]);
    assert.equal(starts.length, 2);
    assert.ok((starts[1] as number) - (starts[0] as number) >= 25, `gap ${String(starts[1])} - ${String(starts[0])}`);

    globalThis.fetch = (async () => new Response('Too Many Requests', { status: 429 })) as unknown as typeof fetch;
    await assert.rejects(
      new SolanaRpcClient(['https://rpc.example/?api-key=SECRETTOKEN123'], 5_000, 0, [1, 1]).getTokenAccountsByOwner(
        'WALLETABC',
        SPL_TOKEN_PROGRAM_ID,
      ),
      (e: Error) => /solana rpc 429/.test(e.message) && !e.message.includes('SECRETTOKEN123'),
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: the 429 retry budget is config-driven, so a transient 429 is absorbed instead of dropped', async () => {
  const origFetch = globalThis.fetch;
  let hits = 0;
  try {
    globalThis.fetch = (async () => {
      hits += 1;
      // retry-after: 0 keeps the test fast — the retry BUDGET is what is under test.
      return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } });
    }) as unknown as typeof fetch;

    await assert.rejects(
      new SolanaRpcClient(['https://rpc.example/?api-key=SECRETTOKEN123'], 5_000, 0).getTokenAccountsByOwner(
        'WALLETABC',
        SPL_TOKEN_PROGRAM_ID,
      ),
      (e: Error) => /solana rpc 429/.test(e.message) && !e.message.includes('SECRETTOKEN123'),
    );
    // 1 first try + one backoff retry per configured retry, all on the same endpoint.
    assert.equal(hits, config.solanaRpcMaxRetries + 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

const EXHAUSTED_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32429, message: 'max usage reached' } });
const okBody = (): string => JSON.stringify(value([account('mintA', { uiAmountString: '5', amount: '5', decimals: 0 })])) as string;

test('isCreditExhausted: -32429 code OR /max usage reached/i message — nothing else', () => {
  assert.equal(isCreditExhausted({ jsonrpc: '2.0', error: { code: -32429, message: 'max usage reached' } }), true);
  assert.equal(isCreditExhausted({ error: { code: -32005, message: 'Max Usage Reached' } }), true); // message variant
  assert.equal(isCreditExhausted({ error: { code: -32005, message: 'Too many requests' } }), false);
  assert.equal(isCreditExhausted({ error: { code: -32601 } }), false);
  for (const bad of [null, undefined, {}, { result: { value: [] } }, { error: null }, { error: 'max usage reached' }]) {
    assert.equal(isCreditExhausted(bad), false, String(bad));
  }
});

test('SolanaRpcClient: credit-exhaustion 429 retires endpoint #1 (no retry budget burned) and endpoint #2 serves the SAME call', async () => {
  const origFetch = globalThis.fetch;
  const hits: string[] = [];
  try {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('e1')) return new Response(EXHAUSTED_BODY, { status: 429 });
      return new Response(okBody(), { status: 200 });
    }) as typeof fetch;

    const client = new SolanaRpcClient(['https://e1.example', 'https://e2.example'], 5_000, 0);
    const m = await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
    // (a) real data from endpoint #2 — the request was never dropped or emptied.
    assert.equal(m.get('mintA'), 5);
    // ONE hit on #1: the dead key threw immediately instead of consuming the 429 backoff budget.
    assert.deepEqual(hits, ['https://e1.example', 'https://e2.example']);

    // (b) a SECOND logical call goes straight to endpoint #2 — #1 stays retired.
    hits.length = 0;
    const m2 = await client.getTokenAccountsByOwner('WALLET', TOKEN_2022_PROGRAM_ID);
    assert.equal(m2.get('mintA'), 5);
    assert.deepEqual(hits, ['https://e2.example']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: credit-exhaustion delivered as HTTP 200 also retires the endpoint', async () => {
  const origFetch = globalThis.fetch;
  const hits: string[] = [];
  try {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      hits.push(u);
      if (u.includes('e1')) return new Response(EXHAUSTED_BODY, { status: 200 });
      return new Response(okBody(), { status: 200 });
    }) as typeof fetch;

    const client = new SolanaRpcClient(['https://e1.example', 'https://e2.example'], 5_000, 0);
    const m = await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
    assert.equal(m.get('mintA'), 5);
    hits.length = 0;
    await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
    assert.deepEqual(hits, ['https://e2.example']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: an ordinary 429 (-32005 / plain text) still retries the SAME endpoint and does NOT retire it', async () => {
  const origFetch = globalThis.fetch;
  const hits: string[] = [];
  try {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      hits.push(u);
      // (c) rate-limit 429 twice, then success — all on endpoint #1.
      if (u.includes('e1') && hits.filter((h) => h === u).length < 3) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32005, message: 'Too many requests' } }), {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(okBody(), { status: 200 });
    }) as typeof fetch;

    const client = new SolanaRpcClient(['https://e1.example', 'https://e2.example'], 5_000, 0, [1, 1]);
    const m = await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
    assert.equal(m.get('mintA'), 5);
    assert.deepEqual(hits, ['https://e1.example', 'https://e1.example', 'https://e1.example']);

    // NOT retired: the next call still starts on endpoint #1.
    hits.length = 0;
    await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
    assert.equal(hits[0], 'https://e1.example');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SolanaRpcClient: with EVERY endpoint retired the request still goes out (fallback, never dropped)', async () => {
  const origFetch = globalThis.fetch;
  const hits: string[] = [];
  let exhausted = true;
  try {
    globalThis.fetch = (async (url: unknown) => {
      hits.push(String(url));
      if (exhausted) return new Response(EXHAUSTED_BODY, { status: 429 });
      return new Response(okBody(), { status: 200 });
    }) as typeof fetch;

    const client = new SolanaRpcClient(['https://e1.example', 'https://e2.example'], 5_000, 0);
    // First call retires BOTH endpoints and rejects — exhaustion never collapses to empty.
    await assert.rejects(client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID), /getTokenAccountsByOwner failed/);
    assert.equal(hits.length, 2);

    // (d) all retired → the fallback still issues the request, soonest-expiring first.
    exhausted = false;
    hits.length = 0;
    const m = await client.getTokenAccountsByOwner('WALLET', SPL_TOKEN_PROGRAM_ID);
    assert.equal(m.get('mintA'), 5);
    assert.ok(hits.length >= 1, `expected the fallback to attempt a request, got ${String(hits.length)} hits`);
  } finally {
    globalThis.fetch = origFetch;
  }
});
