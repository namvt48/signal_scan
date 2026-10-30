import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../src/api.js';
import { open } from '../src/db.js';
import { createTestAuth } from './auth-testkit.js';

test('public token snapshot invalidates when a separate worker connection commits a write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'signal-scan-cross-connection-'));
  const path = join(directory, 'signal_scan.db');
  open(path);
  const auth = await createTestAuth();
  const app = createApp('cross-connection-cache-test', {
    ...auth.deps,
    publicExportToken: 'cross-connection-export-token',
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const writer = new Database(path);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    writer.close();
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(directory, { recursive: true, force: true });
  });

  const headers = { authorization: 'Bearer cross-connection-export-token', connection: 'close' };
  const first = await fetch(`${base}/api/internal/public-export?resource=tokens`, { headers });
  assert.equal(first.status, 200);
  const initial = await first.json() as { data: Array<{ ca: string }> };
  assert.equal(initial.data.some((token) => token.ca === 'worker-added-ca'), false);

  writer.prepare(`INSERT INTO tracked_cas(id,address,chain,added_at,status,entry_usd)
    VALUES('worker-added-id','worker-added-ca','sol',datetime('now'),'active',100)`).run();

  const second = await fetch(`${base}/api/internal/public-export?resource=tokens`, { headers });
  assert.equal(second.status, 200);
  const updated = await second.json() as { data: Array<{ ca: string }> };
  assert.equal(updated.data.some((token) => token.ca === 'worker-added-ca'), true);
});
