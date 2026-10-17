import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { createApp } from '../src/api.js';
import { deleteTrackedCasByIds, getDb, insertTrackedCa, isPassTier, listTrackedCas, listTiers, open } from '../src/db.js';
import { createTestAuth } from './auth-testkit.js';

const OTHER_CA = '22222222222222222222222222222222';
const CA = '11111111111111111111111111111111';

test('PUT /api/tier P works with shared market views and does not delete gateway token state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-scan-tier-shared-market-'));
  let apiDb: Database.Database | undefined;
  let marketDb: Database.Database | undefined;
  let server: Server | undefined;
  try {
    const marketPath = join(dir, 'market.db');
    open(marketPath);
    marketDb = getDb();
    marketDb.prepare('INSERT INTO token_state (ca, chain, price, market_cap, symbol, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(CA, 'sol', 1, 1, 'SHARED', Date.now());

    open(join(dir, 'api.db'), marketPath);
    apiDb = getDb();
    insertTrackedCa({ address: CA, chain: 'sol', note: '' });

    const auth = await createTestAuth();
    const authorization = `Bearer ${await auth.signToken(auth.adminEmail)}`;
    server = createApp('test', auth.deps).listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const before = await fetch(`${base}/api/signals`, { headers: { authorization } });
    assert.equal(before.status, 200);
    const initialRows = await before.json() as { ca: string }[];
    assert.ok(initialRows.some((row) => row.ca === CA), 'the CA is initially visible');

    const pass = await fetch(`${base}/api/tier`, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ca: CA, chain: 'sol', tier: 'P' }),
    });
    assert.equal(pass.status, 200, 'Pass must persist instead of failing while sweeping a shared view');
    assert.deepEqual(await pass.json(), { ca: CA, chain: 'sol', tier: 'P' });

    marketDb.prepare('UPDATE token_state SET symbol = ?, market_cap = ?, fetched_at = ? WHERE ca = ? AND chain = ?')
      .run('REFRESHED', 2, Date.now(), CA, 'sol');
    const after = await fetch(`${base}/api/signals`, { headers: { authorization } });
    assert.equal(after.status, 200);
    const refreshedRows = await after.json() as { ca: string }[];
    assert.ok(!refreshedRows.some((row) => row.ca === CA), 'the CA stays absent after a server refresh');
    assert.equal(listTiers().find((row) => row.ca === CA)?.tier, 'P');
    assert.equal(isPassTier(CA, 'sol'), true);
    assert.ok(!listTrackedCas(true).some((row) => row.address === CA));
    assert.equal((marketDb.prepare('SELECT symbol FROM token_state WHERE ca = ? AND chain = ?').get(CA, 'sol') as { symbol: string } | undefined)?.symbol, 'REFRESHED');
    assert.throws(() => insertTrackedCa({ address: CA, chain: 'sol', note: '' }), /tier is Pass/);
    const ordinary = insertTrackedCa({ address: OTHER_CA, chain: 'sol', note: '' });
    assert.equal(deleteTrackedCasByIds([ordinary.id]), 1, 'batch prune also respects shared market view ownership');
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    apiDb?.close();
    marketDb?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
