import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expireMarketSubscriptions, getDb, getTokenState, listTrackedCas, open, replaceMarketSubscriptions } from '../src/db.js';
import { metricSweep } from '../src/poller.js';
import type { MarketDataProvider } from '../src/providers/provider.js';
test('A/B share gateway-owned public token state but subscriptions and holdings stay local', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-scan-market-share-'));
  try {
    const marketPath = join(dir, 'market.db');
    open(marketPath);
    const gatewayDb = getDb();
    const token = { address: '11111111111111111111111111111111', chain: 'sol' as const };

    assert.deepEqual(replaceMarketSubscriptions('a', [token], 1_000_000), [token]);
    assert.deepEqual(replaceMarketSubscriptions('b', [token], 1_000_001), []);
    assert.equal(listTrackedCas().length, 1);
    replaceMarketSubscriptions('a', [], 1_000_002);
    assert.equal(listTrackedCas().length, 1, 'B still needs the token after A unsubscribes');
    replaceMarketSubscriptions('b', [], 1_000_003);
    assert.equal(listTrackedCas().length, 0, 'the union drops the token when neither caller tracks it');
    // Expired caller leases are pruned by the gateway scheduler, not by either API.
    replaceMarketSubscriptions('a', [token], 1_000_000);
    assert.deepEqual(expireMarketSubscriptions(1_100_001), []);
    assert.equal(listTrackedCas().length, 0);

    gatewayDb.prepare('INSERT INTO token_state (ca, chain, price, market_cap, symbol, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token.address, token.chain, 2, 20, 'SHARED', 1_000_000);
    replaceMarketSubscriptions('a', [token], Date.now());
    replaceMarketSubscriptions('b', [token], Date.now());
    let requests = 0;
    const provider = {
      metric: async () => {
        requests++;
        return { price: 3, symbol: 'POLLED' };
      },
    } as unknown as MarketDataProvider;
    await metricSweep(provider, 'essential', 30 * 60_000);
    assert.equal(requests, 1, 'the gateway queries once for the A/B token union');

    const apiDbPath = join(dir, 'api.db');
    open(apiDbPath, marketPath);
    const apiDb = getDb();
    const read = getTokenState(token.address, token.chain);
    assert.equal(read?.symbol, 'POLLED');
    const apiBPath = join(dir, 'api-b.db');
    open(apiBPath, marketPath);
    const apiBDb = getDb();
    assert.equal(getTokenState(token.address, token.chain)?.symbol, 'POLLED');
    assert.equal(read?.symbol, 'POLLED');
    assert.equal(read?.market_cap, 20);
    gatewayDb.prepare('UPDATE token_state SET market_cap = ? WHERE ca = ? AND chain = ?')
      .run(30, token.address, token.chain);
    assert.equal(apiDb.prepare('SELECT market_cap FROM token_state WHERE ca = ? AND chain = ?')
      .get(token.address, token.chain) && (apiDb.prepare('SELECT market_cap FROM token_state WHERE ca = ? AND chain = ?')
        .get(token.address, token.chain) as { market_cap: number }).market_cap, 30, 'A reads the latest gateway commit');
    assert.equal(apiBDb.prepare('SELECT market_cap FROM token_state WHERE ca = ? AND chain = ?')
      .get(token.address, token.chain) && (apiBDb.prepare('SELECT market_cap FROM token_state WHERE ca = ? AND chain = ?')
        .get(token.address, token.chain) as { market_cap: number }).market_cap, 30, 'B reads the same gateway commit');

    apiDb.prepare('INSERT INTO tracked_cas (id, address, chain, added_at) VALUES (?, ?, ?, ?)')
      .run('instance-a-only', token.address, token.chain, new Date(1_000_000).toISOString());
    assert.equal(apiDb.prepare('SELECT COUNT(*) AS n FROM main.tracked_cas').get() &&
      (apiDb.prepare('SELECT COUNT(*) AS n FROM main.tracked_cas').get() as { n: number }).n, 1);
    assert.equal(gatewayDb.prepare('SELECT COUNT(*) AS n FROM tracked_cas').get() &&
      (gatewayDb.prepare('SELECT COUNT(*) AS n FROM tracked_cas').get() as { n: number }).n, 1);
    assert.throws(() => apiDb.prepare('UPDATE token_state SET market_cap = 40 WHERE ca = ? AND chain = ?')
      .run(token.address, token.chain), /view|readonly/i);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('market subscriptions do not reactivate an inactive locally tracked CA', () => {
  open(':memory:');
  const db = getDb();
  const token = { address: 'inactive-market-subscription', chain: 'sol' as const };
  db.prepare("INSERT INTO tracked_cas (id, address, chain, note, added_at, status) VALUES ('inactive-local', ?, ?, 'fomo', ?, 'inactive')")
    .run(token.address, token.chain, new Date(0).toISOString());

  assert.deepEqual(replaceMarketSubscriptions('a', [token], Date.now()), [], 'subscription conflict does not trigger a one-shot poll');

  const row = db.prepare('SELECT status, note FROM tracked_cas WHERE address = ? AND chain = ?')
    .get(token.address, token.chain) as { status: string; note: string };
  assert.deepEqual(row, { status: 'inactive', note: 'fomo' });
});
