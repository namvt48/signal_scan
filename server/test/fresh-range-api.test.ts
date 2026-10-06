import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api.js';
import { insertTrackedCa, open } from '../src/db.js';
import { updateTokenAnalytics, updateTokenMetrics } from '../src/ingest.js';
import { updateThresholds } from '../src/settings.js';
import type { TokenSignal } from '../src/signals.js';
import { freshPercentageInRange } from '../../src/lib/signalMetrics.js';
import { createTestAuth } from './auth-testkit.js';

let server: Server;
let base = '';
let viewer = '';
before(async () => {
  open(':memory:');
  updateThresholds({ freshMinPct: 10, t100MinMultiple: 1.2, minMc: 0, maxMc: -1 });
  for (const [ca, fresh] of [['fresh-below-gate', 5], ['fresh-zero', 0]] as const) {
    insertTrackedCa({ address: ca, chain: 'sol', note: '' });
    updateTokenMetrics(ca, 'sol', { nansenFreshPct: fresh });
    updateTokenAnalytics(ca, 'sol', { t100Pct: 50, t100Multiple: 2 });
  }
  insertTrackedCa({ address: 'fresh-unknown', chain: 'sol', note: '' });
  const auth = await createTestAuth();
  viewer = await auth.bearer(auth.viewerEmail);
  server = createApp('test', auth.deps).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('normal API response preserves known below-gate Fresh for explicit inclusive ranges', async () => {
  const response = await fetch(`${base}/api/signals?allFactors=0`, { headers: { authorization: viewer } });
  assert.equal(response.status, 200);
  const rows = await response.json() as TokenSignal[];
  const row = rows.find((s) => s.ca === 'fresh-below-gate');
  assert.ok(row);
  assert.equal(row.nansen.pass.fresh, false);
  assert.equal(row.nansen.pass.t100, true);
  assert.equal(row.nansen.fresh, undefined, 'normal setup display remains gated');
  assert.equal(freshPercentageInRange(row.nansen, '0', '10'), true);
  assert.equal(freshPercentageInRange(row.nansen, '5', '5'), true);
  assert.equal(freshPercentageInRange(row.nansen, '6', '10'), false);
  const zero = rows.find((s) => s.ca === 'fresh-zero');
  assert.ok(zero);
  assert.equal(freshPercentageInRange(zero.nansen, '0', '0'), true);
  const unknown = rows.find((s) => s.ca === 'fresh-unknown');
  assert.ok(unknown);
  assert.equal(freshPercentageInRange(unknown.nansen, '0', '10'), false);
});
