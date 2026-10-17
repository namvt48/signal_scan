import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/api.js';
import {
  acknowledgeMarketAlertDelivery,
  appendAlertMetricObservation,
  getDb,
  open,
  sharedAlertMetricImportCursor,
} from '../src/db.js';
import { createTestAuth } from './auth-testkit.js';

interface FeedPayload {
  observations: Array<{ id: number; metric: string; value: number; snapshot: { trackedHoldingPct: number | null } }>;
  nextId: number;
}

interface ApiFeedRead {
  payload: FeedPayload;
  sharedCursor: number;
}

async function readAndAckFeed(dbPath: string, marketPath: string, tokenAmount: number): Promise<ApiFeedRead> {
  open(dbPath, marketPath);
  const db = getDb();
  const ca = '11111111111111111111111111111111';
  const walletId = `wallet-${tokenAmount}`;
  db.prepare('INSERT INTO wallets (id, address, name, chain, source) VALUES (?, ?, ?, ?, ?)')
    .run(walletId, `wallet-address-${tokenAmount}`, `watch-${tokenAmount}`, 'sol', 'watch');
  db.prepare('INSERT INTO wallet_token_state (wallet_id, ca, chain, token_amount) VALUES (?, ?, ?, ?)')
    .run(walletId, ca, 'sol', tokenAmount);
  db.prepare(`INSERT INTO wallet_trades (wallet_id, ca, chain, tx, ts, side, source)
    VALUES (?, ?, ?, ?, ?, 'buy', 'watch')`)
    .run(walletId, ca, 'sol', `tx-${tokenAmount}`, Date.now());

  const auth = await createTestAuth();
  auth.deps.monitorToken = 'monitor-feed-secret';
  const server = createApp('shared-alert-feed-test', auth.deps).listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API has no TCP address');
  try {
    const headers = { authorization: 'Bearer monitor-feed-secret' };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/monitor/alerts`, { headers });
    assert.equal(response.status, 200);
    const payload = await response.json() as FeedPayload;
    assert.equal(payload.observations.length, 2);
    assert.deepEqual(payload.observations.map(({ metric, value }) => ({ metric, value })), [
      { metric: 'fresh', value: 42 },
      { metric: 't100', value: 1.5 },
    ]);
    assert.deepEqual(payload.observations.map(({ snapshot }) => snapshot.trackedHoldingPct), [
      tokenAmount / 10,
      tokenAmount / 10,
    ]);

    const ack = await fetch(`http://127.0.0.1:${address.port}/api/monitor/alerts/ack`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ throughId: payload.nextId }),
    });
    const replay = await fetch(
      `http://127.0.0.1:${address.port}/api/monitor/alerts?afterId=${payload.nextId}`,
      { headers },
    );
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json() as FeedPayload).observations, [], 're-poll does not re-import an acknowledged source row');
    assert.equal(ack.status, 204);
    return { payload, sharedCursor: sharedAlertMetricImportCursor() };
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    getDb().close();
  }
}

test('shared Fresh observation reaches A and B with local holdings and isolated acknowledgements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-scan-shared-alert-'));
  let market: ReturnType<typeof getDb> | undefined;
  try {
    const marketPath = join(dir, 'market.db');
    open(marketPath);
    market = getDb();
    const ca = '11111111111111111111111111111111';
    market.prepare(`INSERT INTO token_state (ca, chain, supply, symbol, fetched_at)
      VALUES (?, 'sol', 1_000, 'SHARED', ?)`)
      .run(ca, Date.now());
    appendAlertMetricObservation(market, ca, 'sol', 'fresh', 42, Date.now());
    appendAlertMetricObservation(market, ca, 'sol', 't100', 1.5, Date.now());

    const a = await readAndAckFeed(join(dir, 'a.db'), marketPath, 10);
    open(marketPath);
    const gatewayA = getDb();
    assert.equal(acknowledgeMarketAlertDelivery('a', a.sharedCursor), true);
    assert.equal((gatewayA.prepare('SELECT COUNT(*) AS n FROM alert_metric_observations').get() as { n: number }).n, 2,
      'A acknowledgement cannot remove either source event needed by B');
    gatewayA.close();

    const b = await readAndAckFeed(join(dir, 'b.db'), marketPath, 30);
    assert.deepEqual(a.payload.observations.map(({ metric, value }) => ({ metric, value })), [
      { metric: 'fresh', value: 42 },
      { metric: 't100', value: 1.5 },
    ]);
    assert.deepEqual(b.payload.observations.map(({ metric, value }) => ({ metric, value })), [
      { metric: 'fresh', value: 42 },
      { metric: 't100', value: 1.5 },
    ]);
    open(marketPath);
    const gatewayB = getDb();
    assert.equal(acknowledgeMarketAlertDelivery('b', b.sharedCursor), true);
    assert.equal((gatewayB.prepare('SELECT COUNT(*) AS n FROM alert_metric_observations').get() as { n: number }).n, 0,
      'the gateway compacts only after both independent imports');
    gatewayB.close();
  } finally {
    market?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
