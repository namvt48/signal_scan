import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/api.js';
import { getDb, open } from '../src/db.js';
import { createTestAuth } from './auth-testkit.js';

test('periodic scan settings are admin-writable and monitor scan feed is monitor-only', async () => {
  open(':memory:');
  const auth = await createTestAuth();
  auth.deps.monitorToken = 'periodic-scan-monitor-token';
  const server = createApp('periodic-scan-api-test', auth.deps).listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('periodic scan test server has no TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const admin = await auth.bearer(auth.adminEmail);
    const viewer = await auth.bearer(auth.viewerEmail);
    const defaults = await fetch(`${baseUrl}/api/periodic-scan-settings`, { headers: { authorization: admin } });
    assert.deepEqual(await defaults.json(), {
      enabled: true,
      intervalHours: 6,
      maxVolume24hUsd: 300_000,
      maxLowFloatTokens: 69_000_000,
    });

    const update = await fetch(`${baseUrl}/api/periodic-scan-settings`, {
      method: 'PUT',
      headers: { authorization: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, intervalHours: 3, maxVolume24hUsd: 250_000, maxLowFloatTokens: 50_000_000 }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual(await update.json(), {
      enabled: false,
      intervalHours: 3,
      maxVolume24hUsd: 250_000,
      maxLowFloatTokens: 50_000_000,
    });

    const invalid = await fetch(`${baseUrl}/api/periodic-scan-settings`, {
      method: 'PUT',
      headers: { authorization: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalHours: 3, maxVolume24hUsd: -1, maxLowFloatTokens: 50_000_000 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${baseUrl}/api/periodic-scan-settings`, { headers: { authorization: viewer } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/periodic-scan-settings`, {
      method: 'PUT',
      headers: { authorization: viewer, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, maxVolume24hUsd: 1, maxLowFloatTokens: 1 }),
    })).status, 403);

    const unauthenticatedMonitorFeed = await fetch(`${baseUrl}/api/monitor/periodic-scan`, { headers: { authorization: admin } });
    assert.equal(unauthenticatedMonitorFeed.status, 403);
    const monitorFeed = await fetch(`${baseUrl}/api/monitor/periodic-scan`, {
      headers: { authorization: 'Bearer periodic-scan-monitor-token' },
    });
    assert.equal(monitorFeed.status, 200);
    assert.equal(monitorFeed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await monitorFeed.json(), {
      settings: { enabled: false, intervalHours: 3, maxVolume24hUsd: 250_000, maxLowFloatTokens: 50_000_000 },
      signals: [],
    });
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    getDb().close();
    open(':memory:');
  }
});
