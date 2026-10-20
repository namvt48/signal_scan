import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api.js';
import { insertTrackedCa, open } from '../src/db.js';
import { createTestAuth } from './auth-testkit.js';

const exportToken = 'public-export-only-test-secret';
let server: Server;
let base = '';
let adminToken = '';
before(async () => {
  open(':memory:');
  insertTrackedCa({ address: 'public-test-ca', chain: 'sol', note: 'must-not-export', entryUsd: 100 });
  const auth = await createTestAuth();
  adminToken = await auth.signToken(auth.adminEmail);
  const app = createApp('public-export-test', { ...auth.deps, publicExportToken: exportToken });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function get(path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

test('export credential reads only the sanitized internal export route', async () => {
  assert.equal((await get('/api/internal/public-export?resource=tokens', exportToken)).status, 200);
  assert.equal((await get('/api/signals', exportToken)).status, 403);
  assert.equal((await fetch(`${base}/api/tracked-cas`, { method: 'POST', headers: { authorization: `Bearer ${exportToken}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await get('/api/internal/public-export?resource=tokens', adminToken)).status, 403);
  const response = await get('/api/internal/public-export?resource=tokens', exportToken);
  const body = await response.json() as { data: Array<Record<string, unknown>> };
  const token = body.data.find((item) => item.ca === 'public-test-ca');
  assert.ok(token);
  assert.equal('note' in token, false);
  assert.equal('fomoUsers' in token, false);
  assert.equal('trackedWallets' in token, false);
});
